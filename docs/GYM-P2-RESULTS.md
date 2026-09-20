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

Recorded incrementally. A row is only added once that fault's run completed.

| # | fault | plain arm | durable arm | differentiated |
|---|---|---|---|---|
| 1 | 502 (first request) | errored, 1 call, 28 ms | passed, 8 calls, 39.5 s, 358 B | **yes** |
| 2 | 429 + `Retry-After` x3 | errored, 1 call, 31 ms | passed, 8 calls, 65.7 s, 358 B | **yes** |
| 3 | timeout (hung request) | errored, 1 call, 20.0 s | errored, 2 calls, 14.3 s | **no — SAME** |

Fault 3 is the first non-differentiating row: both arms **errored**. The durable
arm did retry past the injected hang (its first attempt aborted, the retry
succeeded), but the surviving attempt then failed on a malformed/truncated model
reply (`Expected double-quoted property name in JSON at position 788`), which is
correctly classified non-transient and surfaced as `errored`. The end outcome is
therefore identical to the plain arm's. This is a real result: the timeout fault
alone does not differentiate because a second, unrelated failure masks it.
