# v0.9 external-fix second review

> **Status: historical snapshot.** This is a point-in-time review of the
> v0.9 → v0.9.1 audit cycle. Its closing "Remaining release evidence"
> section describes what was still required before `1.0.0-rc.1` at the time
> it was written; that work has since been completed. For current release
> status, see `docs/RELEASE-GATE.md`.

The external adversarial audit was valuable and its nine-file fix bundle was reviewed independently against pristine v0.9. The supplied fixes build cleanly and all 69 supplied tests pass, but two claimed correctness fixes were incomplete under concurrency.

## Accepted fixes

- Type-only `Uint8Array`/`Buffer` narrowing for fresh TypeScript/@types-node builds.
- Integration syntax walker skips `node_modules`.
- Empty Kubernetes `runtimeClassName` is omitted.
- Sequential duplicate agent spawn is rejected.
- Same-runtime same-message-id send race is covered.

## Second-review findings

### SR-P1: duplicate spawn remained racy

The audit fix used `listAgents()` as a preflight existence check. Two concurrent `spawn()` calls can both observe absence before either persists. The bug reproduced both within one runtime and across two runtimes sharing one durability provider: both calls fulfilled and the later write replaced the earlier agent.

Fix: `DurabilityProvider.createAgent(snapshot)` is now an atomic identity-creation primitive. PostgreSQL uses `INSERT ... ON CONFLICT DO NOTHING RETURNING id`; local and JSON providers perform the check and insert inside their serialization boundary. `AgentRuntime.spawn()` succeeds only for the creation winner.

### SR-P1/P2: mailbox dedup did not prevent cross-replica double steer

The audit fix re-checked one runtime's local mailbox after `appendMailbox()`. Two runtime replicas have separate local snapshots, so both can append the same id to the shared durable store (which dedups correctly) and then both call `engine.steer()`. Reproduction showed one durable mailbox row but two steer calls.

Fix: `MailboxStore.appendMailbox()` now returns whether this caller inserted the message. The durable insertion winner alone updates/steers the live runtime. PostgreSQL uses `ON CONFLICT DO NOTHING`; on conflict it reads the committed existing envelope in a second statement.

## Build reproducibility

The external audit correctly found that fresh install reproducibility was weak. This review pins the direct build dependencies to the exact externally tested versions and removes `package-lock.json` from `.gitignore`. The final RC should still ship a generated `package-lock.json` and use `npm ci`; this environment could not fetch npm registry packages, so no synthetic lockfile was fabricated.

## Verification in this environment

- Node: v22.16.0
- TypeScript used locally for this second review: 5.8.3
- @types/node used locally: 22.19.7
- Full suite after second-review fixes: 71/71 PASS
- distributed contract: 13/13 PASS
- release-hardening contract: 4/4 PASS
- SIGKILL contract: 1/1 PASS
- Responses contract: 6/6 PASS
- integration syntax: 25 TypeScript files, 0 diagnostics; 4 shell files

The external audit separately demonstrated the original type-narrowing fixes under TypeScript 5.9.3 + @types/node 22.20.4. The two second-review concurrency fixes are runtime/API changes and were not reinstalled against those exact packages here because npm registry access was unavailable.

## Remaining release evidence

Still required before `1.0.0-rc.1`: live PostgreSQL contention/fencing, real gVisor isolation with the intended executor image, external provider streaming/abort/failure behavior, and a committed npm lockfile used by CI.
