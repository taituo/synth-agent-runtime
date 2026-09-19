# Upgrade v0.5 → v0.6

v0.6 is source-compatible with the v0.5 core contracts. The main changes are additive.

## New exports

- `JsonFileDurabilityProvider`
- `ResponsesStreamEncoder`
- `toResponsesObject()`
- Responses protocol normalized block/result types

## Gateway behavior

`createInferenceGateway()` now propagates client disconnects into the backend `Request.signal`. When listening on port `0`, the returned `url` getter reports the actual bound port after `listen()`.

The bundled `OpenCodeStackGatewayBackend` now accepts `/v1/responses` in addition to Chat Completions. If you depended on the old `501` response for `/v1/responses`, update the caller.

## Local persistence

For single-process crash/restart development, pair:

```ts
new JsonFileDurabilityProvider("./state/durability.json")
new JsonFileRuntimeStateStore("./state/runtime.json")
```

Do not use these as a multi-writer substitute for PostgreSQL.

## Pi contract

The new `integrations/pi-e2e/install-memory-test.sh` adds a synthetic-memory E2E test without replacing Pi's mini worker.
