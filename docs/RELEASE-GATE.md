# Release Gate

The release question is no longer "can a stale replica overwrite the current
agent?" (closed — see `docs/HARDENING.md`) but "have we proven the whole stack
under real infrastructure and operational load?". This is the authoritative
current checklist; `docs/KNOWN-OPEN.md` itemises the open work.

## Closed correctness gates

- Durable execution is Temporal's: `durableAgentWorkflow` → `runTurn` →
  `GatewayAgentEngine` is the only turn path.
- PostgreSQL atomically validates owner, token and DB-time lease expiry on fenced
  agent writes (`putAgentFenced()`); a lower fencing generation cannot overwrite
  a higher stored generation, and unfenced updates cannot overwrite an agent
  after fenced ownership has begun.
- PostgreSQL lease acquire/renew/validate uses the database clock.
- Effect receipts are claim/replay-safe: a committed receipt replays, a `started`
  one is `EFFECT_OUTCOME_UNCERTAIN`.
- Agent identity creation and mailbox append are atomic at the insertion
  boundary (no duplicate spawn, no cross-replica double-steer).
- Project/task/artifact CAS, mailbox ACK clamping, continuation isolation, route
  affinity/health, and the named-consumer event retention watermark hold.
- Worker death is recovered by Temporal (retry in-flight, replay committed);
  proven live with call counts by the durable and graph restart proofs.
- The execution rung is boundary-aware: the sandbox rung runs the workspace and
  `process.exec` in a persistent gVisor Pod; the synthetic rung is explicitly
  unisolated and refused for scored runs.

## Required before 1.0 GA

```text
[x] live PostgreSQL concurrency: no SKIP (32 workers, CI every push)
[x] DB-clock skew scenario on real PostgreSQL
[x] hard agent takeover scenario on real PostgreSQL
[x] durable/graph worker-restart recovery with call counts
[x] disposable Kubernetes + gVisor Pod-kill test (self-hosted/manual)
[x] sandbox workspace runs read/write/list + exec in the Pod (live gVisor proof)
[~] external gateway/provider probe (historical live run; not re-runnable here
    without credentials — see docs/history)
[~] sustained race/load: proven for the distributed stores directly (32-256
    concurrent workers against real PostgreSQL). Still open against >= 2 actual
    service replicas under sustained traffic.
[ ] rolling schema/application upgrade test
[ ] soak test with forced worker/provider/pod restarts
[~] production IAM + distributed rate limiting + durable audit — shared rate
    limiting is closed (SharedTenantRateLimitPolicy + PostgresRateLimitStore,
    verified live). A real identity provider and a durable audit sink are open.
[x] durable named event-consumer ACK + safe retention watermark
[x] task/artifact per-record revision/CAS (compareAndSwapTask/Artifact)
[ ] continuation size, encryption, retention and cleanup policy
[ ] one enforced boundary for all agent-controlled execution (the scoring
    worker is still not isolated; see docs/KNOWN-OPEN.md)
```

## Interpretation

A green local/unit suite is necessary but not sufficient for `1.0`. A release
candidate should require the live matrix to run against actual PostgreSQL and
Kubernetes infrastructure. The unchecked items above, plus the itemised
`docs/KNOWN-OPEN.md`, are the actual gap between `1.0.0-rc.1` and a `1.0.0` GA
tag; none are known-exploitable correctness bugs — they are missing
coverage/hardening for the fully-loaded production deployment shape.
