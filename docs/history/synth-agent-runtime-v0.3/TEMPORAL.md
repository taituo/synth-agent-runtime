# Temporal deployment

The root runtime intentionally does not depend on the Temporal SDK. The optional package in `integrations/temporal/` contains a real workflow, signals/query, client and worker bootstrap.

The workflow owns durable logical state such as status and mailbox. Network/filesystem/model operations remain activities because Temporal workflows must stay deterministic.

The prototype exposes `sendMessage`, `cancelAgent` and `getAgentState`. `runTurn` is an activity contract that a deployment binds to its Pi/runtime worker.

For production, replace the simple mailbox-clearing example with a durable message cursor/idempotency key so retries and long histories are explicit. Long-lived agents should also use Continue-As-New when workflow history reaches an operational threshold.
