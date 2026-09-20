import { ProfileRouterBackend } from "./profile-router-backend.js";
export interface ProviderConfig {
    id: string;
    baseUrl: string;
    apiKey?: string;
    /** Upstream model id this provider serves. */
    model: string;
    /**
     * Virtual model id clients request. Defaults to `id`. Providers that share a
     * profile become failover routes of that one model, in config order.
     */
    profile?: string;
    headers?: Record<string, string>;
    cooldownMs?: number;
}
export interface GatewayConfig {
    providers: ProviderConfig[];
}
/** The virtual model id a provider is exposed under. */
export declare function providerProfileId(provider: ProviderConfig): string;
/** Validate an untrusted config (env/JSON/file) into a `GatewayConfig`. */
export declare function parseGatewayConfig(input: unknown): GatewayConfig;
/**
 * Read providers from the environment. Either a JSON list:
 *   SYNTH_GATEWAY_PROVIDERS='[{"id":"alpha","baseUrl":"...","model":"..."}]'
 * or one group per provider:
 *   SYNTH_PROVIDER_ALPHA_BASEURL / _MODEL / _API_KEY / _PROFILE
 */
export declare function providersFromEnv(env?: Record<string, string | undefined>): ProviderConfig[];
/** Turn a validated config into a router backend (one HttpGatewayBackend per provider). */
export declare function buildProviderRouter(config: GatewayConfig, options?: {
    fetch?: typeof fetch;
    now?: () => number;
}): ProfileRouterBackend;
/** The provider exposed under `idOrProfile`, or the first one that serves it. */
export declare function selectProvider(config: GatewayConfig, idOrProfile: string): ProviderConfig | undefined;
/**
 * The settings a synthetic/cheap run needs to call one provider directly
 * (no gateway server, no opencode/Pi adapter).
 */
export declare function directProviderSettings(provider: ProviderConfig): {
    baseUrl: string;
    model: string;
    apiKey?: string;
};
