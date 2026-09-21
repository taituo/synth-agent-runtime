# Spec: adapt to scarce quota instead of waiting for more of it

Repo: /home/tiny/projects/pisynth/synth-agent-runtime. Push to origin/main.
Position: after the gym milestone. Replaces the blocked multi-account item as the way we
handle scarcity.

## Why this instead of more accounts

There is ONE subscription account and there will not be more for a while. That is not a
blocker to route around — it is the operating condition, and a useful stress test in its own
right. A system that only performs well with headroom is not finished; the interesting
question is how it behaves when the binding constraint bites continuously.

So the goal is not "survive 429s" — that already works, the park/retry-hint path is built and
measured. The goal is to **adapt**: discover the sustainable rate, hold there, and spend the
scarce quota on the most valuable work rather than on retries.

## What already exists and should be built on, not rebuilt

- Server retry hints are honoured in the durable park path (5389dee), measured.
- Quota exhaustion is surfaced distinctly from ordinary throttling (230dedf).
- Priority lanes with bands, weighted fair-share and deadlines are wired into the gateway
  request path (592399f, b0813db).
- The mailbox already batches: events arriving while a turn is in flight are consumed as one
  batch on the next turn, so a SLOWER provider naturally produces FEWER, LARGER calls. Batch
  sizes like [1,3] were observed in the swarm runs. This is already an adaptation; measure it
  before adding anything.

## The work

### 1. Measure the baseline before changing anything
Run the existing swarm against the single real account with concurrency high enough to hit
the limit continuously. Record: achieved throughput (events classified per minute), model
calls, events per call, park time, retry count, and wall time. That table is the thing every
later change has to beat. Without it, "adaptive" is an adjective, not a result.

### 2. Adaptive concurrency instead of a fixed capacity
`LaneScheduler` takes a fixed `capacity`. With one account that number is a guess, and a
wrong guess is expensive in both directions: too high burns quota on requests that will 429,
too low leaves the account idle. Implement a controller that discovers it: additive increase
on sustained success, multiplicative decrease on a 429 or a retry hint — the same shape as
congestion control, for the same reason. Clamp it, make the bounds explicit, and log every
adjustment with its trigger.

Prove it with the discriminating measurement, not a plausible-looking graph: against a
provider with a known fixed limit, the controller must converge near that limit and stay
there. Compare against the fixed-capacity arm at a capacity that is too high and one that is
too low. If the adaptive arm does not beat both, say so.

### 3. Spend scarce quota on the most valuable work
When the account is saturated, a lane decision is a spending decision. Make the policy
explicit and test it: which work is dropped, which is deferred, and which is admitted. A
request that will certainly miss its deadline should not consume a call at all — that is the
cheapest possible win and the scheduler already knows the deadline.

### 4. Make the batching adaptation explicit and measured
The mailbox batching is currently an emergent side effect. Measure events-per-call as a
function of provider latency, and decide whether to make it deliberate — e.g. a short
deliberate wait to accumulate a larger batch when calls are the scarce resource, which trades
latency for throughput. Only do this if the measurement says it helps; if the emergent
behaviour is already good enough, record that and leave it alone.

## Honesty requirement
Every claim here is a performance claim, which is the easiest kind to fool yourself about.
Every number must come from a run against the real account under real limits, with the
before/after and the seed or configuration recorded. If an adaptation does not measurably
improve the baseline table from step 1, report it as not helping and leave the simpler code
in place.
