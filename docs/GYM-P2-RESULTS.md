# Gym P2 — live results (one task, both arms, fault matrix)

Task `he/hex-decode`, model `kimi-k2.7-code`, gateway `http://127.0.0.1:8791`.
maxTurns 8, one attempt per arm, runner `local` for both arms so the only
variable is durability. Faults were run **one at a time** (memory-constrained
box); this file is committed after each fault so a mid-matrix death costs one
fault, not the run.

## Part ONE — one real attempt per arm

| arm | outcome | model calls | turns | wall | patch |
|---|---|---|---|---|---|
| plain | passed | 4 | 4 | 35.5 s | 358 B |
| durable | passed | 4 | 4 | 41.1 s | 358 B |

Identical 358-byte patches; the arms differ only in durability.

## Part TWO — fault matrix

Run one fault at a time; each row is committed as it completes.

### Rows 1–2 (final)

| # | fault | plain arm | durable arm | differentiated |
|---|---|---|---|---|
| 1 | 502 (first request) | errored, 1 call, 28 ms | passed, 8 calls, 39.5 s, 358 B | **yes** |
| 2 | 429 + `Retry-After` x3 | errored, 1 call, 31 ms | passed, 8 calls, 65.7 s, 358 B | **yes** |

### Rows 3–4 as first run (confounded — superseded by the re-run below)

| # | fault | plain arm | durable arm | verdict |
|---|---|---|---|---|
| 3 | timeout (hung request) | errored, 1 call, 20.0 s | errored, 2 calls, 14.3 s | **SAME** — both errored |
| 4 | worker restart (SIGTERM) | **lost** — child killed, run vanished, no result | **resumed** — task continued on the restarted worker (3 calls), then errored | difference in kind (lost vs resumed); neither passed |

Fault 3: the durable arm did retry past the hang, but the surviving attempt then
failed on a malformed/truncated reply and errored — identical end outcome to
plain. Fault 4: the durable workflow genuinely survived the SIGTERM and ran
three calls on the restarted worker, while the plain arm produced no result at
all; lost versus resumed is a difference in kind, but the resumed attempt then
hit the same malformed reply, so neither arm passed.

### Design decision: is a malformed reply transient?

The first runs classified a malformed/truncated reply as non-retryable, so one
bad reply ended the attempt. The question is genuinely open: the failure is
stochastic (resampling often yields valid JSON), which argues for retrying, but
a model that reliably emits bad JSON would then burn the durable retry budget
every turn and the attempt could never succeed.

Decision: a malformed reply is **re-asked exactly once in-loop** (`maxReasks`,
default 1), on a budget **separate** from the transient path. It is classified
`malformed`, not `transient`, so the durable activity does not hand it to
Temporal's retry/park machinery. This buys recovery from a stochastic slip
without letting a broken model consume the durability allowance. Failures this
makes unrecoverable: a second malformed reply in the same attempt, and any
non-provider, non-JSON error. Pinned by tests:
`a malformed reply is re-asked once, then fatal...` and
`a single stochastic malformed reply recovers after the re-ask`
(`test/gym-attempt.test.ts`).

### Confound finding (independent of the matrix)

`kimi-k2.7-code` emitted malformed/truncated JSON often enough to mask two
consecutive matrix rows. The truncation is consistent with the `max_tokens:
4096` cap cutting a long tool-call payload (the model sometimes chooses
`write_file` with the whole ~30 KB file rather than `replace_in_file`). A cheap
code model can thus produce protocol-level failures at a rate that dominates a
small experiment; the harness must budget for that rather than assume every
failure is the injected fault.

### Rows 3–5 re-run on the fixed classification

| # | fault | plain arm | durable arm | differentiated |
|---|---|---|---|---|
