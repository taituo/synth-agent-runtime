export interface GatewayPrincipal {
    tenantId: string;
    subject: string;
    allowedModels?: readonly string[];
    requestsPerMinute?: number;
}
export interface GatewayAuthenticator {
    authenticate(request: Request): Promise<GatewayPrincipal | undefined> | GatewayPrincipal | undefined;
}
export interface GatewayTenantPolicy {
    authorize(principal: GatewayPrincipal, model: string): Promise<void> | void;
}
export declare class StaticBearerAuthenticator implements GatewayAuthenticator {
    #private;
    constructor(tokens: ReadonlyMap<string, GatewayPrincipal> | Record<string, GatewayPrincipal>);
    authenticate(request: Request): GatewayPrincipal | undefined;
}
export declare class ModelAclPolicy implements GatewayTenantPolicy {
    authorize(principal: GatewayPrincipal, model: string): void;
}
export declare class InMemoryTenantRateLimitPolicy implements GatewayTenantPolicy {
    #private;
    private readonly now;
    constructor(now?: () => number);
    authorize(principal: GatewayPrincipal, _model: string): void;
}
export declare class CompositeTenantPolicy implements GatewayTenantPolicy {
    private readonly policies;
    constructor(policies: readonly GatewayTenantPolicy[]);
    authorize(principal: GatewayPrincipal, model: string): Promise<void>;
}
