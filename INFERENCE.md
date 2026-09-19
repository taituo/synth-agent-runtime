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
