# Spec: priority lanes and fair-share across scarce quota

Repo: /home/tiny/projects/pisynth/synth-agent-runtime. Push to origin/main.
This is the written spec roadmap item 2 requires BEFORE any code. Implement in
small pieces, failing-first, live proof, assert the discriminating quantity.

## Why

The runtime runs on a few cheap SUBSCRIPTION accounts, not per-token billing, so the
scarce resource is **quota in a time window**. When one window is exhausted, waiting is
the only option — but *who* waits, and *how long*, is a scheduling decision. Today there
is no such decision:

- `src/inference/gateway/tenant-policy.ts` has `GatewayPrincipal { tenantId, subject,
  allowedModels?, requestsPerMinute? }` and fixed-window per-tenant counters
  (`InMemoryTenantRateLimitPolicy`, `SharedTenantRateLimitPolicy`). There is **no
  priority, tier, weight, queue or quota concept at all**.
- `CompositeTenantPolicy` runs policies in order; a limit breach throws
  `RATE_LIMITED:<tenant>` and the request fails immediately. There is no "queue it and
  pass `Retry-After` downstream", and no notion that an interactive request should beat a
  batch one.

Backpressure itself is now correct: the durable path honours server retry hints
(`retryAfterMs`, commit 5389dee). This spec is about deciding who gets the scarce quota
while that backpressure is applied.

## Goals / non-goals

Goals:
- **Priority bands** so an interactive turn is never starved behind batch work.
- **Fair share by weight within a band**, so one heavy tenant cannot monopolise a band.
- **Queue-or-reject** admission: a request either runs now, is queued with a bounded
  wait, or is rejected with a `Retry-After` the caller can honour.
- **Propagate `Retry-After` downstream** on rejection, and feed a real account 429 back
  into the lane as a cooldown so we stop hammering a window we know is closed.

Non-goals (separate tasks, do not build here):
- Multi-account routing / account selection / failover (roadmap item 3).
- Account switching when one is cooling down.
- Changing the durable park path (already correct).

## 2026 practice to follow

- Priority bands first, fair-share by weight inside a band.
- Queue-or-reject, never unbounded queueing: a queued request must carry a deadline and a
  `Retry-After`; a request that cannot be served within its deadline is rejected, not
  parked forever.
- Backpressure is expressed in HTTP terms (`Retry-After`), so any caller — including our
  own durable agent — can honour it.

## Model (pure, testable, no I/O)

Add to the gateway (new file `src/inference/gateway/lane-scheduler.ts`):

```ts
export type LaneId = string;                 // e.g. "interactive", "batch"
export interface LaneSpec {
  id: LaneId;
  /** Higher runs first. Bands are strictly ordered; weights only apply within a band. */
  priority: number;
  /** Relative share within the band. */
  weight: number;
  /** Max time a request may wait in this lane before rejection. 0 = never queue. */
  maxWaitMs: number;
}

export interface AdmissionRequest {
  lane: LaneId;
  tenantId: string;
  /** Stable key so one tenant's requests queue fairly among themselves. */
  key: string;
  at: number;                                // injected clock
}

export type AdmissionDecision =
  | { outcome: "admit" }
  | { outcome: "queue"; retryAfterMs: number; ticket: string }
  | { outcome: "reject"; reason: "lane-full" | "deadline" | "rate-limited"; retryAfterMs: number };
```

The scheduler is **pure and clock-injected** (`now: () => number`) so it is unit-testable
with a fake clock and no timers. It owns:
- per-lane, per-tenant in-flight/queued accounting;
- weighted fair-share selection within a band (deficit round-robin or weighted fair
  queueing — pick one and justify it);
- a cooldown per account/window: when a real 429 arrives with `retryAfterMs`, the lane
  records `cooldownUntil = now + hint` and rejects/queues accordingly, passing the hint
  downstream.

### Fair-share algorithm (decide and document)

Recommendation: **deficit weighted round-robin** across tenants within a band, because it
is O(1) per decision, has no starvation for a continuously-backlogged tenant, and is easy
to reason about under a fake clock. Weighted fair queueing gives smoother burst behaviour
but needs virtual-time bookkeeping; note the tradeoff in the doc and pick one.

## Open design questions (decide before/while coding; record the answers)

1. **Capacity model.** Is the scarce resource a per-window request quota (fixed window, as
   the existing rate limiters use) or a concurrent-slot limit? The scheduler needs exactly
   one to have a notion of "full". Recommendation: model the window quota and derive a
   concurrency cap from it, because subscription quota is per-window; state the derivation.
2. **Where the band is assigned.** Caller-declared (`principal.lane`) or derived (an
   interactive turn vs a batch job)? Misclassification is a real risk. Recommendation:
   caller-declared with a conservative default lane; deriving it is a later concern.
3. **Preemption.** May a high-band request preempt an in-flight low-band one (cancel it), or
   only jump the queue? Recommendation: **no preemption** — jumping the queue only — so no
   work is lost; accept the latency consequence for high-band requests behind a long
   low-band call.
4. **Starvation bound (a number).** A low band under sustained high-band load must get a
   guaranteed slice. Recommendation: each lower band is reserved a fixed fraction of every
   window (e.g. ≥ 20%) even when higher bands are backlogged. Pick the number here.
5. **Cooldown scope.** A 429 is a property of the *account*, not the lane, so a cooldown
   should be observed by every lane using that account. The scheduler has no account
   dimension today (accounts are roadmap item 3). Interim: key cooldowns by tenant, and
   make the key a parameter so item 3 can pass an account id without reshaping the API.
6. **`Retry-After` semantics.** What value for a *queued* request (estimated wait) vs a
   *rejected* one (remaining cooldown/window)? Recommendation: queued → estimated wait,
   rejected → remaining window/cooldown, both expressed in ms and surfaced as `Retry-After`.
7. **Who stamps `at`.** The request carries `at`; the scheduler also has `now()`. Decide
   which is authoritative for deadlines so a delayed caller cannot extend its own wait.
   Recommendation: `now()` is authoritative; `at` is informational only.
8. **Single-lane backward compatibility.** With one configured lane the policy must be a
   no-op versus today. Assert this explicitly in a test.
9. **Per-process vs shared.** Like the rate limiters, an in-process scheduler multiplies its
   capacity by the replica count. Decide whether piece 1 is explicitly single-replica and
   the shared variant is deferred (recommend: yes, and say so in the doc).

## Integration

- `PriorityLanePolicy implements GatewayTenantPolicy` composes with the existing
  `ModelAclPolicy` and rate-limit policies via `CompositeTenantPolicy`, ordered after ACL
  and before (or alongside) the rate-limit policy.
- `GatewayPrincipal` gains optional `lane?: LaneId` and `weight?: number` (backward
  compatible; absent => a default lane with weight 1).
- On `reject`, the policy throws an error carrying `retryAfterMs` in a plain property, the
  same shape the durable path already reads (`retryAfterMsFromError`), so the gateway can
  emit a `Retry-After` header and the durable agent honours it without new plumbing.
- A real upstream 429 (already parsed for the durable path) is reported to the scheduler
  as `noteCooldown(lane, tenantId, retryAfterMs)`.

## Failure modes to design against (state them in the doc)

- **Starvation**: a low band under sustained high-band load. Bound it: high band may only
  consume X% of a window before low band gets a guaranteed slice.
- **Thundering herd on reset**: every queued request fires the instant a window resets.
  Jitter the release, and cap the release rate to the account's window.
- **Head-of-line blocking**: a queued low-priority request must not block a later
  high-priority one; the scheduler is per-band, not a single FIFO.
- **Clock skew**: all decisions use the injected clock; never the wall clock directly.

## Testing

- Unit (pure, fake clock): band ordering; weighted share across tenants over many
  decisions (assert the RATIO, not just admit/reject); `maxWaitMs` deadline rejection;
  cooldown from a 429 hint; `Retry-After` propagation; no starvation over a long run.
- Failing-first for each: break the ordering / the weight / the deadline and confirm the
  expected failure message.
- Live proof: drive the gateway with two lanes (interactive + batch) against a real
  rate-limited upstream and assert that interactive requests keep succeeding while batch
  requests are queued/rejected with a `Retry-After` that tracks the real hint. A skip
  (no upstream/key) is exit 2, never `ok:true`.
- Property test: for any generated arrival stream, no admitted request violates its lane's
  deadline, and the long-run admit ratio between two same-band tenants tracks their weights.

## Small pieces (one at a time, each green before the next)

1. Lane/priority model + `AdmissionDecision` + band ordering, pure, with unit tests.
2. Weighted fair-share within a band (ratio asserted over many decisions).
3. Queue-or-reject with `maxWaitMs` and `Retry-After` propagation (plain `retryAfterMs`).
4. Cooldown from a real 429 hint (`noteCooldown`) + thundering-herd jitter.
5. `PriorityLanePolicy` wired into `CompositeTenantPolicy` + `GatewayPrincipal` fields.
6. Live proof with two lanes against a real rate-limited upstream.

## Report back

The algorithm chosen and why; the unit/property results with the asserted ratios; the live
proof (interactive vs batch under a real 429, with the observed `Retry-After`); what is
still not covered; commit SHAs.
