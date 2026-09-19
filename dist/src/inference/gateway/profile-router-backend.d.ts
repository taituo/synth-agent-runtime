import type { GatewayBackend, GatewayModel } from "./types.js";
import { type RouterStateStore, type SharedRouteHealth } from "./router-state.js";
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
export declare class ProfileRouterBackend implements GatewayBackend {
    #private;
    constructor(options: {
        backends: ReadonlyMap<string, GatewayBackend> | Record<string, GatewayBackend>;
        profiles: readonly GatewayProfile[];
        now?: () => number;
        state?: RouterStateStore;
        affinityTtlMs?: number;
    });
    private readonly now;
    private readonly affinityTtlMs;
    listModels(): Promise<GatewayModel[]>;
    handle(request: Request, model: string): Promise<Response>;
    inspect(): {
        health: Record<string, RouteHealth>;
        affinity: Record<string, string>;
    };
    clearAffinity(session?: string): Promise<void>;
}
export {};
