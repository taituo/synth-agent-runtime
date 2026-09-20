/**
 * Config-driven OpenAI-compatible providers.
 *
 * A provider is `{ id, baseUrl, apiKey?, model }`. Any OpenAI-compatible
 * endpoint plugs in from configuration, with no code change: `buildProviderRouter`
 * turns a provider list into the existing `ProfileRouterBackend` (one
 * `HttpGatewayBackend` per provider), and `directProviderSettings` gives the
 * settings a synthetic/cheap run needs to call a provider directly, with no
 * dependency on opencode or the Pi adapter.
 *
 * Providers that share a `profile` become failover routes of that one virtual
 * model; otherwise each provider is its own profile, selected by its id.
 * `opencode-go` is just one provider among many — never a hardcoded path.
 *
 * No provider and no key is hardcoded here: configuration supplies both.
 */
import { HttpGatewayBackend } from "./http-upstream.js";
import { ProfileRouterBackend, type GatewayProfile } from "./profile-router-backend.js";
import type { GatewayBackend, GatewayModel } from "./types.js";

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
export function providerProfileId(provider: ProviderConfig): string {
  return provider.profile ?? provider.id;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`provider config: ${field} must be a non-empty string`);
  return value;
}

/** Validate an untrusted config (env/JSON/file) into a `GatewayConfig`. */
export function parseGatewayConfig(input: unknown): GatewayConfig {
  const raw = Array.isArray(input) ? { providers: input } : (input as { providers?: unknown });
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.providers) || raw.providers.length === 0) {
    throw new Error("provider config: expected a non-empty providers array");
  }
  const providers = raw.providers.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new Error(`provider config: providers[${index}] must be an object`);
    const p = entry as Record<string, unknown>;
    const provider: ProviderConfig = {
      id: requireString(p.id, `providers[${index}].id`),
      baseUrl: requireString(p.baseUrl, `providers[${index}].baseUrl`),
      model: requireString(p.model, `providers[${index}].model`),
    };
    if (p.apiKey !== undefined) provider.apiKey = requireString(p.apiKey, `providers[${index}].apiKey`);
    if (p.profile !== undefined) provider.profile = requireString(p.profile, `providers[${index}].profile`);
    if (p.headers !== undefined) {
      if (typeof p.headers !== "object" || p.headers === null) throw new Error(`provider config: providers[${index}].headers must be an object`);
      provider.headers = Object.fromEntries(Object.entries(p.headers as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
    }
    if (p.cooldownMs !== undefined) {
      if (typeof p.cooldownMs !== "number" || !Number.isFinite(p.cooldownMs)) throw new Error(`provider config: providers[${index}].cooldownMs must be a number`);
      provider.cooldownMs = p.cooldownMs;
    }
    return provider;
  });
  const seen = new Set<string>();
  for (const provider of providers) {
    if (seen.has(provider.id)) throw new Error(`provider config: duplicate provider id '${provider.id}'`);
    seen.add(provider.id);
  }
  return { providers };
}

/**
 * Read providers from the environment. Either a JSON list:
 *   SYNTH_GATEWAY_PROVIDERS='[{"id":"alpha","baseUrl":"...","model":"..."}]'
 * or one group per provider:
 *   SYNTH_PROVIDER_ALPHA_BASEURL / _MODEL / _API_KEY / _PROFILE
 */
export function providersFromEnv(env: Record<string, string | undefined> = process.env): ProviderConfig[] {
  if (env.SYNTH_GATEWAY_PROVIDERS) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(env.SYNTH_GATEWAY_PROVIDERS);
    } catch (error) {
      throw new Error(`SYNTH_GATEWAY_PROVIDERS is not JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    return parseGatewayConfig(parsed).providers;
  }
  const groups = new Map<string, Record<string, string>>();
  for (const [key, value] of Object.entries(env)) {
    const match = /^SYNTH_PROVIDER_([A-Z0-9_]+)_(BASEURL|MODEL|API_KEY|PROFILE)$/.exec(key);
    if (!match || value === undefined) continue;
    const id = match[1]!.toLowerCase();
    groups.set(id, { ...(groups.get(id) ?? {}), [match[2]!]: value });
  }
  const providers: ProviderConfig[] = [];
  for (const [id, fields] of groups) {
    if (!fields.BASEURL || !fields.MODEL) continue;
    providers.push({
      id,
      baseUrl: fields.BASEURL,
      model: fields.MODEL,
      ...(fields.API_KEY ? { apiKey: fields.API_KEY } : {}),
      ...(fields.PROFILE ? { profile: fields.PROFILE } : {}),
    });
  }
  return providers;
}

/** Turn a validated config into a router backend (one HttpGatewayBackend per provider). */
export function buildProviderRouter(
  config: GatewayConfig,
  options: { fetch?: typeof fetch; now?: () => number } = {},
): ProfileRouterBackend {
  const backends = new Map<string, GatewayBackend>();
  const profiles = new Map<string, GatewayProfile>();
  for (const provider of config.providers) {
    const profileId = providerProfileId(provider);
    const backendName = `provider:${provider.id}`;
    const upstream: GatewayModel = { id: provider.model, object: "model", provider: provider.id, profile: profileId };
    backends.set(backendName, new HttpGatewayBackend({
      baseUrl: provider.baseUrl,
      models: [upstream],
      ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
      ...(provider.headers ? { headers: provider.headers } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }));
    const existing = profiles.get(profileId);
    const route = {
      id: `${provider.id}-primary`,
      backend: backendName,
      model: provider.model,
      ...(provider.cooldownMs !== undefined ? { cooldownMs: provider.cooldownMs } : {}),
    };
    if (existing) {
      existing.routes.push(route);
    } else {
      profiles.set(profileId, {
        model: { id: profileId, object: "model", owned_by: "synth-router", provider: provider.id, profile: profileId },
        routes: [route],
      });
    }
  }
  return new ProfileRouterBackend({
    backends,
    profiles: [...profiles.values()],
    ...(options.now ? { now: options.now } : {}),
  });
}

/** The provider exposed under `idOrProfile`, or the first one that serves it. */
export function selectProvider(config: GatewayConfig, idOrProfile: string): ProviderConfig | undefined {
  return config.providers.find((provider) => provider.id === idOrProfile || providerProfileId(provider) === idOrProfile);
}

/**
 * The settings a synthetic/cheap run needs to call one provider directly
 * (no gateway server, no opencode/Pi adapter).
 */
export function directProviderSettings(provider: ProviderConfig): { baseUrl: string; model: string; apiKey?: string } {
  return { baseUrl: provider.baseUrl, model: provider.model, ...(provider.apiKey ? { apiKey: provider.apiKey } : {}) };
}
