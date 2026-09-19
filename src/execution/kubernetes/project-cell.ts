import { spawn } from "node:child_process";
import type { KubernetesResourceClass } from "../resource-class.js";
import { buildProjectCellNetworkPolicy, buildProjectService, buildProjectServicePod, buildRestrictedNamespace } from "./manifests.js";
import type { KubernetesObject, ProjectCellHandle, ProjectCellSpec, SandboxBackend, SandboxIdentity } from "./types.js";

export interface KubernetesObjectController {
  apply(object: KubernetesObject): Promise<void>;
  waitPodReady(namespace: string, podName: string, timeoutMs?: number): Promise<void>;
  deleteNamespace(namespace: string): Promise<void>;
}

export interface KubectlObjectControllerOptions {
  kubectlBin?: string;
  context?: string;
}

export class KubectlObjectController implements KubernetesObjectController {
  readonly #kubectl: string;
  readonly #context?: string;

  constructor(options: KubectlObjectControllerOptions = {}) {
    this.#kubectl = options.kubectlBin ?? "kubectl";
    this.#context = options.context;
  }

  async apply(object: KubernetesObject): Promise<void> {
    const result = await this.#run(["apply", "-f", "-"], JSON.stringify(object), 60_000);
    if (result.code !== 0) throw new Error(result.stderr || "kubectl apply failed");
  }

  async waitPodReady(namespace: string, podName: string, timeoutMs = 120_000): Promise<void> {
    const result = await this.#run(
      ["wait", "--for=condition=Ready", `pod/${podName}`, "-n", namespace, `--timeout=${Math.ceil(timeoutMs / 1000)}s`],
      undefined,
      timeoutMs + 5_000,
    );
    if (result.code !== 0) throw new Error(result.stderr || `Pod ${podName} not ready`);
  }

  async deleteNamespace(namespace: string): Promise<void> {
    const result = await this.#run(["delete", "namespace", namespace, "--ignore-not-found=true", "--wait=false"], undefined, 30_000);
    if (result.code !== 0) throw new Error(result.stderr || `Failed to delete namespace ${namespace}`);
  }

  #run(args: string[], input?: string, timeoutMs = 60_000): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const base = this.#context ? ["--context", this.#context] : [];
      const child = spawn(this.#kubectl, [...base, ...args], { stdio: ["pipe", "pipe", "pipe"] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
      }, timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
      });
      child.stdin.end(input);
    });
  }
}

interface CellRecord {
  handle: ProjectCellHandle;
  leases: number;
  lastUsedAt: number;
  idleTtlMs: number;
}

/**
 * A ProjectCell is a longer-lived isolated namespace containing one executor and
 * optional project services (database, Redis, browser, etc.). Agents lease it;
 * they never receive Kubernetes credentials.
 */
export class ProjectCellManager {
  readonly #controller: KubernetesObjectController;
  readonly #sandboxBackend: SandboxBackend;
  readonly #classes: Map<string, KubernetesResourceClass>;
  readonly #cells = new Map<string, CellRecord>();
  /**
   * Per-cell lifecycle lock. `ensure`, `lease`, `reap` and `destroy` for the
   * same cell id are serialized. Without it, two concurrent `ensure()` calls
   * each create an executor sandbox (one leaks, unreachable via `#cells`), and
   * a `destroy` racing a `lease` can delete the namespace that the new cell
   * just created under the same derived name.
   */
  readonly #locks = new Map<string, Promise<unknown>>();

  constructor(
    controller: KubernetesObjectController,
    sandboxBackend: SandboxBackend,
    classes: readonly KubernetesResourceClass[],
  ) {
    this.#controller = controller;
    this.#sandboxBackend = sandboxBackend;
    this.#classes = new Map(classes.map((entry) => [entry.id, entry]));
  }

  async ensure(spec: ProjectCellSpec): Promise<ProjectCellHandle> {
    return this.#withCellLock(spec.id, () => this.#ensureLocked(spec));
  }

  #withCellLock<T>(id: string, run: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(id) ?? Promise.resolve();
    const next = previous.then(run, run);
    this.#locks.set(id, next.catch(() => {}));
    return next;
  }

  async #ensureLocked(spec: ProjectCellSpec): Promise<ProjectCellHandle> {
    const existing = this.#cells.get(spec.id);
    if (existing) return existing.handle;
    return this.#createCell(spec);
  }

  async #createCell(spec: ProjectCellSpec): Promise<ProjectCellHandle> {
    // When the caller supplies a namespace we do not own it (it may be shared
    // with other resources), so a failed ensure must not delete it.
    const ownsNamespace = spec.namespace === undefined;
    const namespace = spec.namespace ?? `synth-cell-${spec.id}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 63);
    let executor: SandboxIdentity | undefined;
    try {
      await this.#controller.apply(buildRestrictedNamespace(namespace, { "synth.openai.dev/project-cell": spec.id }));
      await this.#controller.apply(buildProjectCellNetworkPolicy(namespace, spec.id));

      const serviceNames: string[] = [];
      for (const service of spec.services ?? []) {
        const pod = buildProjectServicePod(namespace, spec.id, service);
        await this.#controller.apply(pod);
        const podName = String((pod.metadata as { name: string }).name);
        await this.#controller.waitPodReady(namespace, podName);
        const serviceObject = buildProjectService(namespace, spec.id, service);
        if (serviceObject) {
          await this.#controller.apply(serviceObject);
          serviceNames.push(String((serviceObject.metadata as { name: string }).name));
        }
      }

      const classId = spec.resourceClassId ?? "project-cell";
      const resourceClass = this.#classes.get(classId);
      if (!resourceClass) throw new Error(`Unknown project cell resource class: ${classId}`);
      executor = await this.#sandboxBackend.create(
        { ...resourceClass, network: { ...resourceClass.network, mode: "none" } },
        {
          namespace,
          labels: { "synth.openai.dev/project-cell": spec.id },
        },
      );
      const handle: ProjectCellHandle = {
        id: spec.id,
        namespace,
        executor,
        serviceNames,
        createdAt: Date.now(),
      };
      this.#cells.set(spec.id, { handle, leases: 0, lastUsedAt: Date.now(), idleTtlMs: spec.idleTtlMs ?? 30 * 60_000 });
      return handle;
    } catch (error) {
      // A failed ensure must not leave a half-built cell (namespace, policy,
      // service pods, or executor sandbox) behind for a cell that was never
      // registered and therefore can never be reaped or destroyed.
      if (executor) await this.#sandboxBackend.destroy(executor).catch(() => {});
      if (ownsNamespace) await this.#controller.deleteNamespace(namespace).catch(() => {});
      throw error;
    }
  }

  async lease(spec: ProjectCellSpec): Promise<{ handle: ProjectCellHandle; release(): Promise<void> }> {
    return this.#withCellLock(spec.id, async () => {
      const handle = await this.#ensureLocked(spec);
      const record = this.#cells.get(spec.id)!;
      record.leases++;
      record.lastUsedAt = Date.now();
      let released = false;
      return {
        handle,
        release: async () => {
          if (released) return;
          released = true;
          record.leases = Math.max(0, record.leases - 1);
          record.lastUsedAt = Date.now();
        },
      };
    });
  }

  async reap(now = Date.now()): Promise<void> {
    for (const id of [...this.#cells.keys()]) {
      // Re-check idleness under the same lock a concurrent lease would hold,
      // so a cell that just became leased is never reaped.
      await this.#withCellLock(id, async () => {
        const record = this.#cells.get(id);
        if (!record) return;
        if (record.leases > 0 || now - record.lastUsedAt < record.idleTtlMs) return;
        await this.#destroyLocked(id);
      });
    }
  }

  async destroy(id: string): Promise<void> {
    return this.#withCellLock(id, () => this.#destroyLocked(id));
  }

  async #destroyLocked(id: string): Promise<void> {
    const record = this.#cells.get(id);
    if (!record) return;
    this.#cells.delete(id);
    await this.#sandboxBackend.destroy(record.handle.executor).catch(() => {});
    await this.#controller.deleteNamespace(record.handle.namespace).catch(() => {});
  }
}
