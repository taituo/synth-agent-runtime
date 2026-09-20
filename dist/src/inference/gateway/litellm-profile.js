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
export function litellmProfile(options) {
    const backendName = `litellm:${options.id}`;
    const upstream = { id: options.model, object: "model", provider: "litellm", profile: options.id };
    const backend = new HttpGatewayBackend({
        baseUrl: options.baseUrl,
        models: [upstream],
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
        ...(options.headers ? { headers: options.headers } : {}),
    });
    const profile = {
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
