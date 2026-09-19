# Canonical project/spec world

`ProjectSpec` is the durable source of truth for work that should survive model/context/session changes.

It contains project objective, active constraints, decisions, task IDs, artifact IDs and metadata. `InMemoryWorldStore.projection()` produces compact context text plus selected structured records for an agent turn.

This prevents the architecture from treating an ever-growing chat transcript as project memory. A future database-backed implementation can preserve the same `WorldStore` contract.


`JsonFileWorldStore` is the durable reference implementation for single-process prototypes. It atomically rewrites one JSON document and preserves binary artifact payloads using base64 encoding. Production deployments can replace it with a database-backed `WorldStore`.
