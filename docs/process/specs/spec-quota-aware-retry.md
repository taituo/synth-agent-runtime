# Spec: quota-aware retry (subscription accounts, not per-token billing)

Repo: /home/tiny/projects/pisynth/synth-agent-runtime. Push to origin/main.
Start only after the three follow-ups in bug-report-waiting-spin.md are pushed and green.
ONE item at a time, failing-first evidence for each, live proof not a mock.

## Why this, and why the framing matters

This runtime will be driven by SUBSCRIPTION accounts (a handful of cheap ones), not
per-token API billing. That changes what the retry layer must optimise for:

- The scarce resource is QUOTA IN A TIME WINDOW, not money. You cannot buy your way out of
  a 429 — you wait for the window to reset.
- Therefore a blind exponential backoff is actively wrong. Too early and it burns quota on
  requests that are certain to fail; too late and it sleeps far past the reset, wasting
  the window it was waiting for. The server tells us when to come back; we currently throw
  that away.
- With only 3-6 accounts, an account that is cooling down is a large fraction of total
  capacity. Getting the wait right is the difference between a usable swarm and one that
  spends most of its time asleep.

## The two concrete defects (verified in the code, not assumed)

1. `integrations/temporal/src/gateway-run-turn.ts` ignores `Retry-After`,
   `X-RateLimit-Reset` and friends entirely. On a 429 it throws a plain Error and the
   workflow parks using `nextParkBackoffMs` — a blind doubling that has no relationship to
   when the quota actually resets.
   Note the asymmetry: `src/inference/gateway/profile-router-backend.ts:190` ALREADY parses
   `retry-after`, and `integrations/pi-opencode-stack-router/src/inference/open-code-stack-models.ts`
   parses `retry-after` plus several `*-ratelimit-reset` spellings. The durable layer is the
   one place that discards the hint. Reuse that parsing logic rather than writing a third copy.
2. `PERMANENT_HTTP_STATUSES` (gateway-run-turn.ts:10) is `400/401/403/404/422`. `402` is
   absent, so credit/plan exhaustion is treated as transient and the agent parks forever.
   On a subscription this is rarer than on per-token billing, but it is still a
   never-succeeds condition and must not retry silently forever.

## Item 1: honour the server's retry hint in the durable path

Design constraint: the workflow runs in the Temporal sandbox, so it cannot import SDK
internals or do IO. The hint must travel as a PLAIN property on the thrown error, exactly
the way `nonRetryable` already does, and be read with a sandbox-safe helper in
`correlation.ts` (mirror `isNonRetryableFailure`).

- In the activity: parse the response headers on a 429/503 and attach the computed wait,
  e.g. `retryAfterMs`, to the thrown error. Prefer `Retry-After` (both the seconds form and
  the HTTP-date form), then the `*-ratelimit-reset` spellings. A reset expressed as an
  absolute timestamp must be converted using the response's own `Date` header where present,
  not the local clock, so clock skew does not produce a negative or absurd wait.
- In the workflow: when the park path sees a hint, wait for THAT duration instead of the
  exponential backoff. Clamp it: ignore non-finite, negative or absurd values (say, anything
  over an hour) and fall back to the normal backoff, so a hostile or broken upstream cannot
  park an agent for a week. Log which one was used.
- Consecutive-park counting: a hinted wait should NOT escalate `parkAttempt` the way a blind
  failure does — the server told us when to return, so returning then is not a failed
  attempt. Decide this deliberately and write the reasoning in docs/TEMPORAL.md.

Tests: unit-test the header parsing hard (seconds, HTTP-date, absent, garbage, negative,
huge, skewed `Date`). Then a live proof: an activity that 429s with a known `Retry-After`,
and the workflow must resume within a tight window around that time — assert the TIMING,
not just the final status, or the test will pass on the blind-backoff code too.

## Item 2: classify 402 and quota exhaustion

- `402` → non-retryable, like the other permanent statuses.
- A 429 that carries a reset far in the future (beyond the clamp) is not a normal retry: it
  means this account is out of quota for the window. Surface it distinctly in `lastError`
  and in the park log so it is visible in the trace, rather than looking like ordinary
  throttling. Do not invent an account-switching mechanism here — just make the condition
  legible. Routing is a separate piece.

## Item 3: prove it against REAL 429s, no fault injection

OpenRouter's free models (`:free` ids) are rate limited to 20 requests/minute and 50/day on
an account with under 10 credits. That produces GENUINE 429s with real headers, for free.
Use that instead of `flaky-gateway` for this proof:

- add a driver that points the gateway activity at OpenRouter with a `:free` model and
  drives it deliberately past 20 req/min;
- assert: the agents park, the wait actually tracks the returned header, no agent dies, all
  events are eventually classified, and nothing is lost or reordered;
- record the observed headers verbatim in the output so we learn what the real ones look
  like — we are guessing at their exact spelling today.
- Needs `OPENROUTER_API_KEY` in the environment. If it is absent, SKIP as a distinct
  outcome (exit code 2, never `ok:true`) — the same rule as `fault-rungs.ts`.

Cheapest paid ids measured on 2026-09-20 if a paid run is ever wanted:
`mistralai/mistral-nemo` ($0.019/M in, $0.030/M out),
`deepseek/deepseek-v4-flash` ($0.037/M in, 1M context).

## Explicitly OUT of scope here

Priority lanes / fair-share scheduling across accounts. `src/inference/gateway/tenant-policy.ts`
has no priority, tier, weight or quota concept at all today, so that is a separate design
task and a separate spec. Do not start it. Backpressure has to be correct first.

## Report back
What failed before each fix (with the timing numbers), what passes now, the real headers you
observed from OpenRouter, and the commit SHAs.
