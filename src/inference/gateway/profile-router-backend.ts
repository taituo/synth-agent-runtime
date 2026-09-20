import type { GatewayBackend, GatewayModel } from "./types.js";
import { parseRetryHintMs } from "./retry-hint.js";
import { InMemoryRouterStateStore, type RouterStateStore, type SharedRouteHealth } from "./router-state.js";

export interface GatewayRoute {
  id: string;
  backend: string;
  /** "$requested" keeps the virtual model id; otherwise rewrite to this upstream model. */
  model?: string;
  cooldownMs?: number;
}

export interface GatewayProfile {
  model: GatewayModel;
  routes: GatewayRoute[];
}

type RouteHealth = Omit<SharedRouteHealth, "routeKey" | "updatedAt">;

/**
 * Network-level router for OpenAI-compatible backends.
 *
 * v0.8 moves health/affinity behind RouterStateStore so multiple gateway
 * replicas can share cooldown and sticky-session decisions.
 */
export class ProfileRouterBackend implements GatewayBackend {
  readonly #backends: ReadonlyMap<string, GatewayBackend>;
  readonly #profiles: ReadonlyMap<string, GatewayProfile>;
  readonly #healthCache = new Map<string, RouteHealth>();
  readonly #affinityCache = new Map<string, string>();
  readonly #state: RouterStateStore;

  constructor(options: {
    backends: ReadonlyMap<string, GatewayBackend> | Record<string, GatewayBackend>;
    profiles: readonly GatewayProfile[];
    now?: () => number;
    state?: RouterStateStore;
    affinityTtlMs?: number;
  }) {
    this.#backends = options.backends instanceof Map ? options.backends : new Map(Object.entries(options.backends));
    this.#profiles = new Map(options.profiles.map((profile) => [profile.model.id, profile]));
    this.now = options.now ?? Date.now;
    this.#state = options.state ?? new InMemoryRouterStateStore();
    this.affinityTtlMs = options.affinityTtlMs ?? 24 * 60 * 60 * 1000;
  }

  private readonly now: () => number;
  private readonly affinityTtlMs: number;

  async listModels(): Promise<GatewayModel[]> {
    return [...this.#profiles.values()].map((p) => ({
      object: "model",
      owned_by: "synth-router",
      provider: "router",
      profile: p.model.id,
      ...p.model,
    }));
  }

  async handle(request: Request, model: string): Promise<Response> {
    const profile = this.#profiles.get(model);
    if (!profile) return jsonError(404, `Unknown routed model '${model}'`);

    let originalBody: Uint8Array;
    try { originalBody = new Uint8Array(await request.arrayBuffer()); }
    catch (error) { if (request.signal.aborted) throw request.signal.reason ?? error; throw error; }

    const originalHeaders = new Headers(request.headers);
    const affinityKey = sessionAffinityKey(request, model, originalBody);
    const stickyRoute = affinityKey ? await this.#getAffinity(affinityKey) : undefined;
    const ordered = stickyRoute
      ? [...profile.routes].sort((a, b) => Number(b.id === stickyRoute) - Number(a.id === stickyRoute))
      : [...profile.routes];

    const candidates: GatewayRoute[] = [];
    for (const route of ordered) {
      const health = await this.#health(model, route.id);
      if ((health.cooldownUntil ?? 0) <= this.now() && this.#backends.has(route.backend)) candidates.push(route);
    }
    if (candidates.length === 0) return jsonError(503, `No healthy route for '${model}'`);

    let lastError: Response | undefined;
    for (let index = 0; index < candidates.length; index++) {
      if (request.signal.aborted) throw request.signal.reason ?? new Error("request aborted");
      const route = candidates[index]!;
      const health = await this.#health(model, route.id);
      const backend = this.#backends.get(route.backend)!;
      const upstreamModel = !route.model || route.model === "$requested" ? model : route.model;
      const body = rewriteModel(originalBody, upstreamModel);
      const forwarded = new Request(request.url, { method: request.method, headers: originalHeaders, body, signal: request.signal });

      try {
        const response = await backend.handle(forwarded, upstreamModel);
        health.lastStatus = response.status;
        if (!retryableStatus(response.status)) {
          health.successes++;
          health.cooldownUntil = undefined;
          await this.#putHealth(model, route.id, health);
          if (affinityKey && response.ok) await this.#putAffinity(affinityKey, route.id);
          return response;
        }

        health.failures++;
        health.cooldownUntil = this.now() + cooldownFor(response, route.cooldownMs, this.now());
        await this.#putHealth(model, route.id, health);
        if (affinityKey && stickyRoute === route.id) await this.#deleteAffinity(affinityKey);

        const hasNext = index + 1 < candidates.length;
        if (!hasNext) return response;
        await response.body?.cancel("router failover").catch(() => {});
        lastError = jsonError(response.status, `Route '${route.id}' returned retryable status ${response.status}`);
      } catch (error) {
        if (request.signal.aborted) throw request.signal.reason ?? error;
        health.failures++;
        health.cooldownUntil = this.now() + (route.cooldownMs ?? 30_000);
        await this.#putHealth(model, route.id, health);
        if (affinityKey && stickyRoute === route.id) await this.#deleteAffinity(affinityKey);
        lastError = jsonError(502, error instanceof Error ? error.message : String(error));
      }
    }
    return lastError ?? jsonError(503, `No healthy route for '${model}'`);
  }

  inspect(): { health: Record<string, RouteHealth>; affinity: Record<string, string> } {
    return {
      health: Object.fromEntries([...this.#healthCache.entries()].map(([id, health]) => [id, { ...health }])),
      affinity: Object.fromEntries(this.#affinityCache),
    };
  }

  async clearAffinity(session?: string): Promise<void> {
    if (!session) {
      const keys = [...this.#affinityCache.keys()];
      this.#affinityCache.clear();
      await Promise.all(keys.map((key) => this.#state.deleteAffinity(key)));
      return;
    }
    const keys = [...this.#affinityCache.keys()].filter((key) => key.endsWith(`:${session}`));
    await Promise.all(keys.map((key) => this.#deleteAffinity(key)));
  }

  async #health(model: string, id: string): Promise<RouteHealth> {
    const key = `${model}:${id}`;
    const shared = await this.#state.getRouteHealth(key);
    const value: RouteHealth = shared
      ? { cooldownUntil: shared.cooldownUntil, successes: shared.successes, failures: shared.failures, lastStatus: shared.lastStatus }
      : this.#healthCache.get(key) ?? { successes: 0, failures: 0 };
    this.#healthCache.set(key, { ...value });
    return { ...value };
  }

  async #putHealth(model: string, id: string, health: RouteHealth): Promise<void> {
    const key = `${model}:${id}`;
    this.#healthCache.set(key, { ...health });
    await this.#state.putRouteHealth({ routeKey: key, ...health, updatedAt: this.now() });
  }

  async #getAffinity(key: string): Promise<string | undefined> {
    const shared = await this.#state.getAffinity(key);
    if (shared) this.#affinityCache.set(key, shared);
    else this.#affinityCache.delete(key);
    return shared;
  }

  async #putAffinity(key: string, routeId: string): Promise<void> {
    this.#affinityCache.set(key, routeId);
    await this.#state.putAffinity(key, routeId, this.now() + this.affinityTtlMs);
  }

  async #deleteAffinity(key: string): Promise<void> {
    this.#affinityCache.delete(key);
    await this.#state.deleteAffinity(key);
  }
}

function rewriteModel(body: Uint8Array, model: string): Uint8Array<ArrayBuffer> {
  const parsed = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
  parsed.model = model;
  return new TextEncoder().encode(JSON.stringify(parsed));
}
function sessionAffinityKey(request: Request, model: string, body: Uint8Array): string | undefined {
  const tenant = request.headers.get("x-synth-tenant") ?? "public";
  const headerSession = request.headers.get("x-synth-session") ?? request.headers.get("x-opencode-session") ?? request.headers.get("x-session-id");
  if (headerSession) return `${tenant}:${model}:${headerSession}`;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
    const metadata = parsed.metadata;
    if (metadata && typeof metadata === "object") {
      const session = (metadata as Record<string, unknown>).session_id;
      if (typeof session === "string" && session.length > 0) return `${tenant}:${model}:${session}`;
    }
  } catch { /* model rewrite reports malformed JSON later */ }
  return undefined;
}
function retryableStatus(status: number): boolean { return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500; }
function cooldownFor(response: Response, configured: number | undefined, now: number): number {
  const retryAfter = parseRetryHintMs(response.headers, now);
  if (retryAfter !== undefined) return Math.max(configured ?? 0, retryAfter);
  if (configured !== undefined) return configured;
  if (response.status === 429) return 60_000;
  if (response.status >= 500) return 30_000;
  return 5_000;
}
function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), { status, headers: { "content-type": "application/json" } });
}
