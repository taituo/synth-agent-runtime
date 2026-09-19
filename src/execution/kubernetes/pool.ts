import type { KubernetesResourceClass } from "../resource-class.js";
import type { SandboxBackend, SandboxIdentity, WarmSandboxLease } from "./types.js";

interface Slot {
  sandbox: SandboxIdentity;
  resourceClass: KubernetesResourceClass;
  state: "ready" | "leased" | "destroying";
  lastUsedAt: number;
}

interface Waiter {
  resolve: (lease: WarmSandboxLease) => void;
  reject: (error: Error) => void;
}

export class WarmSandboxPool {
  readonly #backend: SandboxBackend;
  readonly #classes: Map<string, KubernetesResourceClass>;
  readonly #slots = new Map<string, Slot>();
  readonly #waiters = new Map<string, Waiter[]>();
  readonly #creating = new Map<string, number>();
  #closed = false;

  constructor(backend: SandboxBackend, classes: readonly KubernetesResourceClass[]) {
    this.#backend = backend;
    this.#classes = new Map(classes.map((entry) => [entry.id, entry]));
  }

  async maintain(): Promise<void> {
    if (this.#closed) return;
    const now = Date.now();
    const destroy: Promise<void>[] = [];
    for (const slot of this.#slots.values()) {
      const policy = slot.resourceClass.warmPool;
      if (!policy || slot.state !== "ready") continue;
      const ready = this.#readyCount(slot.resourceClass.id);
      if (ready > policy.maxReady || (ready > policy.minReady && now - slot.lastUsedAt > policy.idleTtlMs)) {
        slot.state = "destroying";
        destroy.push(this.#destroy(slot));
      }
    }
    await Promise.all(destroy);

    for (const resourceClass of this.#classes.values()) {
      const policy = resourceClass.warmPool;
      if (!policy || this.#closed) continue;
      const need = Math.max(0, policy.minReady - this.#readyCount(resourceClass.id) - (this.#creating.get(resourceClass.id) ?? 0));
      await Promise.all(Array.from({ length: need }, () => this.#createReady(resourceClass, true)));
    }
  }

  async acquire(resourceClassId: string): Promise<WarmSandboxLease> {
    if (this.#closed) throw new Error("Warm sandbox pool is closed");
    const resourceClass = this.#classes.get(resourceClassId);
    if (!resourceClass) throw new Error(`Unknown resource class: ${resourceClassId}`);

    const ready = [...this.#slots.values()].find(
      (slot) => slot.resourceClass.id === resourceClassId && slot.state === "ready",
    );
    if (ready) return this.#leaseSlot(ready);

    const policy = resourceClass.warmPool;
    const total = this.#totalCount(resourceClassId) + (this.#creating.get(resourceClassId) ?? 0);
    if (!policy || total < policy.maxTotal) {
      // A direct acquire owns the slot it is creating. Do not hand that same
      // slot to an older waiter before this caller can lease it.
      const slot = await this.#createReady(resourceClass, false);
      return this.#leaseSlot(slot);
    }

    return new Promise<WarmSandboxLease>((resolve, reject) => {
      if (this.#closed) { reject(new Error("Warm sandbox pool is closed")); return; }
      const waiters = this.#waiters.get(resourceClassId) ?? [];
      waiters.push({ resolve, reject });
      this.#waiters.set(resourceClassId, waiters);
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const error = new Error("Warm sandbox pool is closed");
    for (const waiters of this.#waiters.values()) for (const waiter of waiters) waiter.reject(error);
    this.#waiters.clear();
    await Promise.all([...this.#slots.values()].map((slot) => this.#destroy(slot)));
    this.#slots.clear();
  }

  stats(): Record<string, { ready: number; leased: number; creating: number; total: number; waiting: number }> {
    const result: Record<string, { ready: number; leased: number; creating: number; total: number; waiting: number }> = {};
    for (const id of this.#classes.keys()) {
      const ready = this.#readyCount(id);
      const leased = [...this.#slots.values()].filter((slot) => slot.resourceClass.id === id && slot.state === "leased").length;
      const creating = this.#creating.get(id) ?? 0;
      result[id] = { ready, leased, creating, total: ready + leased + creating, waiting: this.#waiters.get(id)?.length ?? 0 };
    }
    return result;
  }

  async #createReady(resourceClass: KubernetesResourceClass, serveWaiter: boolean): Promise<Slot> {
    if (this.#closed) throw new Error("Warm sandbox pool is closed");
    this.#creating.set(resourceClass.id, (this.#creating.get(resourceClass.id) ?? 0) + 1);
    try {
      const sandbox = await this.#backend.create(resourceClass, { labels: { "synth.openai.dev/pool": "warm" } });
      if (this.#closed) {
        await this.#backend.destroy(sandbox).catch(() => {});
        throw new Error("Warm sandbox pool closed while sandbox was being created");
      }
      const slot: Slot = { sandbox, resourceClass, state: "ready", lastUsedAt: Date.now() };
      this.#slots.set(sandbox.id, slot);
      if (serveWaiter) this.#serveWaiter(slot);
      return slot;
    } catch (error) {
      this.#rejectWaiters(resourceClass.id, error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      const next = Math.max(0, (this.#creating.get(resourceClass.id) ?? 1) - 1);
      if (next === 0) this.#creating.delete(resourceClass.id);
      else this.#creating.set(resourceClass.id, next);
    }
  }

  #leaseSlot(slot: Slot): WarmSandboxLease {
    if (this.#closed) throw new Error("Warm sandbox pool is closed");
    if (slot.state !== "ready") throw new Error(`Sandbox ${slot.sandbox.id} is not ready`);
    slot.state = "leased";
    slot.lastUsedAt = Date.now();
    let released = false;
    return {
      sandbox: slot.sandbox,
      resourceClass: slot.resourceClass,
      release: async (options = {}) => {
        if (released) return;
        released = true;
        if (options.destroy || this.#closed) {
          await this.#destroy(slot);
          return;
        }
        try {
          await this.#backend.reset(slot.sandbox);
          if (this.#backend.verifyReset && !(await this.#backend.verifyReset(slot.sandbox))) {
            await this.#destroy(slot);
            return;
          }
          if (this.#closed) {
            await this.#destroy(slot);
            return;
          }
          slot.state = "ready";
          slot.lastUsedAt = Date.now();
          if (!this.#serveWaiter(slot)) {
            const policy = slot.resourceClass.warmPool;
            if (policy && this.#readyCount(slot.resourceClass.id) > policy.maxReady) await this.#destroy(slot);
          }
        } catch {
          await this.#destroy(slot);
        }
      },
    };
  }

  #serveWaiter(slot: Slot): boolean {
    if (this.#closed || slot.state !== "ready") return false;
    const waiters = this.#waiters.get(slot.resourceClass.id);
    const waiter = waiters?.shift();
    if (!waiter) return false;
    if (waiters?.length === 0) this.#waiters.delete(slot.resourceClass.id);
    try {
      waiter.resolve(this.#leaseSlot(slot));
    } catch (error) {
      waiter.reject(error instanceof Error ? error : new Error(String(error)));
      return false;
    }
    return true;
  }

  #rejectWaiters(resourceClassId: string, error: Error): void {
    const waiters = this.#waiters.get(resourceClassId);
    if (!waiters) return;
    this.#waiters.delete(resourceClassId);
    for (const waiter of waiters) waiter.reject(error);
  }

  async #destroy(slot: Slot): Promise<void> {
    if (slot.state === "destroying" && !this.#slots.has(slot.sandbox.id)) return;
    slot.state = "destroying";
    this.#slots.delete(slot.sandbox.id);
    await this.#backend.destroy(slot.sandbox).catch(() => {});
  }

  #readyCount(resourceClassId: string): number {
    return [...this.#slots.values()].filter(
      (slot) => slot.resourceClass.id === resourceClassId && slot.state === "ready",
    ).length;
  }

  #totalCount(resourceClassId: string): number {
    return [...this.#slots.values()].filter((slot) => slot.resourceClass.id === resourceClassId).length;
  }
}
