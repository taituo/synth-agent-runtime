/**
 * A LiteLLM-backed gateway profile.
 *
 * LiteLLM is an OpenAI-compatible gateway fronting many providers. We do not
 * write per-provider adapters; a LiteLLM profile is just a `GatewayProfile`
 * whose route is served by the existing generic `HttpGatewayBackend`, so it
 * composes with `ProfileRouterBackend`'s failover, cooldown and affinity for
 * free. One profile, one cheap model.
 */
import { HttpGatewayBackend } from "./http-upstream.js";
import type { GatewayProfile } from "./profile-router-backend.js";
import type { GatewayBackend, GatewayModel } from "./types.js";

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

export function litellmProfile(options: LitellmProfileOptions): LitellmProfile {
  const backendName = `litellm:${options.id}`;
  const upstream: GatewayModel = { id: options.model, object: "model", provider: "litellm", profile: options.id };
  const backend = new HttpGatewayBackend({
    baseUrl: options.baseUrl,
    models: [upstream],
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    ...(options.headers ? { headers: options.headers } : {}),
  });
  const profile: GatewayProfile = {
    model: { id: options.id, object: "model", owned_by: "synth-router", provider: "litellm", profile: options.id },
    routes: [
      {
        id: `${options.id}-primary`,
        backend: backendName,
        model: options.model,
        ...(options.cooldownMs !== undefined ? { cooldownMs: options.cooldownMs } : {}),
      },
    ],
  };
  return { backendName, backend, profile };
}
