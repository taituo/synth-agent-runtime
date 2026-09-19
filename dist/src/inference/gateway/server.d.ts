import { type IncomingMessage, type ServerResponse } from "node:http";
import type { GatewayBackend } from "./types.js";
import type { GatewayAuthenticator, GatewayTenantPolicy } from "./tenant-policy.js";
/**
 * Tiny OpenAI-compatible front door. The backend owns actual protocol conversion
 * and routing; this server standardizes discovery, transport, cancellation,
 * body-size bounds, and response backpressure.
 */
export declare function createInferenceGateway(options: {
    backend: GatewayBackend;
    host?: string;
    port?: number;
    maxRequestBytes?: number;
    authenticator?: GatewayAuthenticator;
    tenantPolicy?: GatewayTenantPolicy;
}): {
    server: import("http").Server<typeof IncomingMessage, typeof ServerResponse>;
    listen: () => Promise<void>;
    close: () => Promise<void>;
    readonly url: string;
};
