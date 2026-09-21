# Spec: model visibility — a requirement, not a nicety

Repo: /home/tiny/projects/pisynth/synth-agent-runtime. Push to origin/main.
Priority: HIGH. Do this before the rest of the gym milestone.

## Why this blocks everything else

Without visibility into which model produced a result, every number we record is
unattributable, and an unattributable number is not a measurement. This was demonstrated the
hard way: a single hardcoded `modelIds` filter in a probe host made 27 available models look
like one, and every accuracy and latency figure recorded so far is that one model's figure
without ever saying so.

The gym milestone will compare arms and faults. If we cannot state which model answered each
turn, those comparisons mean nothing.

## What already exists (build on it, do not rebuild)

- `GatewayTurnRecord.model` (`integrations/temporal/src/gateway-run-turn.ts`) records the
  answering model per turn, and the swarm driver prints it.
- `GatewayBackend.listModels()` exists on every backend, including the router.

## The three gaps

### 1. There is no standing way to see what models exist
Listing the available models currently requires hand-starting a second gateway with the
filter removed. Make it a first-class command that lists what the configured backends
actually offer, with no filter applied, and prints provider/profile alongside each model.
Listing costs no quota, so this should be cheap to run often.

### 2. Requested vs served model is not distinguished — and the fallback hides a substitution

```
model: body.model ?? options.model
```

If the upstream response omits the model field, the REQUESTED model is recorded as though it
had answered. With profile routing, failover and cooldown, the router can legitimately serve
a different model than the one asked for, and nothing flags it — a measurement would be
labelled model A while model B actually answered.

Record both: `requestedModel` and `servedModel`, plus an explicit flag when they differ or
when the upstream did not say. Never silently substitute one for the other. A run whose
served model is unknown must say "unknown", not guess.

Test it with a backend that deliberately answers with a different model id, and with one that
omits the field, and assert the record reflects reality in both cases. A test that only
exercises the happy path would pass on the current code.

### 3. No way to compare a measurement across models
Add a way to run an existing measurement (start with the corpus scorer, which is small,
cheap and already has a baseline) across a list of models and emit a comparison table:
model, accuracy, latency p50/max, tokens, failures, and the served-model check from gap 2.

Keep it honest about cost: running 27 models against a corpus is 27x the quota. Default to an
explicit small list passed by the caller, never "all models" by default, and print the
projected call count before starting.

## What this unlocks
- Choosing the model per task on evidence rather than by default — e.g. `kimi-k2.7-code` for
  the gym's code-fixing task rather than a general model.
- The cheap-mass-plus-frontier-judge design on a single subscription.
- Knowing whether rate limits are per-model, per-account or per-provider — the measurement
  that decides whether adaptive concurrency or model spreading is the right lever.

## Report back
The model list as it actually is, the requested-vs-served behaviour before and after, the
comparison table for a small model set on the corpus, and the projected-versus-actual call
count so we learn what a comparison run costs.
