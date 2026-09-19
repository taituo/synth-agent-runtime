export interface SharedRouteHealth {
    routeKey: string;
    cooldownUntil?: number;
    successes: number;
    failures: number;
    lastStatus?: number;
    updatedAt: number;
}
export interface RouterStateStore {
    getRouteHealth(routeKey: string): Promise<SharedRouteHealth | undefined>;
    putRouteHealth(health: SharedRouteHealth): Promise<void>;
    getAffinity(key: string): Promise<string | undefined>;
    putAffinity(key: string, routeId: string, expiresAt?: number): Promise<void>;
    deleteAffinity(key: string): Promise<void>;
}
export declare class InMemoryRouterStateStore implements RouterStateStore {
    #private;
    getRouteHealth(routeKey: string): Promise<SharedRouteHealth | undefined>;
    putRouteHealth(health: SharedRouteHealth): Promise<void>;
    getAffinity(key: string): Promise<string | undefined>;
    putAffinity(key: string, routeId: string, expiresAt?: number): Promise<void>;
    deleteAffinity(key: string): Promise<void>;
}
