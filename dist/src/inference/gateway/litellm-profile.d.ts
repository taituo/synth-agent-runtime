import type { GatewayProfile } from "./profile-router-backend.js";
import type { GatewayBackend } from "./types.js";
export interface LitellmProfileOptions {
    /** Virtual model id clients request (e.g. "litellm/cheap"). */
    id: string;
    /** LiteLLM base URL (e.g. http://127.0.0.1:4000). */
    baseUrl: string;
    /** Upstream model id LiteLLM should route to (e.g. "gpt-4o-mini"). */
    model: string;
    apiKey?: string;
    headers?: Record<string, string>;
    cooldownMs?: number;
}
export interface LitellmProfile {
    backendName: string;
    backend: GatewayBackend;
    profile: GatewayProfile;
}
export declare function litellmProfile(options: LitellmProfileOptions): LitellmProfile;
