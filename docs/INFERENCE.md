# Inference and routing

The gateway presents logical models while preserving the client agent loop and tool schema.

```text
Pi / OpenCode / other client
        │
  /v1/responses or /v1/chat/completions
        │
  virtual model/profile
        │
  ProfileRouterBackend
   ├ route/account A
   ├ route/account B
   └ fallback provider
```

v0.8 moves two pieces of router state behind shared interfaces:

- `RouterStateStore` for cooldown/health + sticky affinity
- `ContinuationStore` for `previous_response_id` context

The PostgreSQL distributed store implements both. Session affinity is tenant-scoped; route health is namespaced by virtual model + route so unrelated profiles do not poison each other's cooldowns.

The router still obeys the semantic failover rule from earlier releases: do not replay an attempt after semantic output/tool calls are exposed unless the surrounding transaction can prove rollback safety.

The gateway can authenticate a tenant, apply model ACL/rate policy, and inject tenant/subject identity into the internal request. The built-in bearer authenticator and rate limiter are development/reference implementations.

## Providers are configuration

Any OpenAI-compatible endpoint plugs in with no code change. `provider-config.ts`
declares providers as `{ id, baseUrl, apiKey?, model, profile? }` and turns them
into the router: `buildProviderRouter(config)` creates one `HttpGatewayBackend`
per provider and groups providers that share a `profile` into one virtual model's
failover routes. `opencode-go` is one provider among many, never a hardcoded path;
no provider and no key is hardcoded.

Configuration comes from the environment — `SYNTH_GATEWAY_PROVIDERS` (JSON) or
`SYNTH_PROVIDER_<ID>_BASEURL/_MODEL/_API_KEY/_PROFILE` — via `providersFromEnv()`,
then `parseGatewayConfig()` validates it. The Temporal worker
(`integrations/temporal/src/worker-entry.ts`) selects a provider from this config
at startup (`GATEWAY_MODEL` picks the id/profile, default first).

For a synthetic/cheap run that should not go through the gateway server,
`directProviderSettings(provider)` returns the `{ baseUrl, model, apiKey? }` that
`GatewayAgentEngine` needs to call the provider directly, with no dependency on
opencode or the Pi adapter. `selectProvider(config, idOrProfile)` chooses a
provider/profile for a run.
