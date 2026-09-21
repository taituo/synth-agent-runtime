# When to fix, when to ask, when to leave it

The discriminator is one question: **does the fix change what the run proves?**

## 1. Obstacle — fix it and continue, report it in the log

Something blocks the measurement without being the subject of it. A wrong path, a missing
env var, a config typo, a hardcoded value, a stale image reference. The diagnosis and the
remedy are the same fact, and there is only one plausible fix.

Fix it, note it in the phase log with what it was, keep going. Do not stop for these; stopping
for each one turns a five-step run into a five-day conversation.

## 2. Decision — stop and ask

Any of these:
- the fix needs a design choice, or there is more than one plausible remedy;
- it touches the harness, the turn body or the execution seam — DIRECTION territory;
- it changes a published interface or a manifest others depend on;
- the fix would make the run pass in a way that hides why it was failing.

That last one is the important half. If you find yourself making the run green rather than
making the system work, that is the signal to stop.

## 3. The failure IS the finding — do not fix it, record it

Some failures are the result. We already know several things are broken; the run confirming
them is the measurement, not an obstacle to it.

Specifically: **workspace does not survive a crash** on the generic path. If the run
demonstrates that, write it down precisely — what was lost, at which turn, what the resumed
attempt read — and move on. Fixing it is Phase 3/4 work with a design decision behind it
(PersistentVolume vs object-store checkpoint vs git-per-turn vs the `synth_workspace_checkpoints`
table that already exists). Repairing it mid-Phase-1 would be exactly the scope creep the
phase forbids, and it would also destroy the cleanest evidence we will ever get for it.

Same for `continueAsNew`, the vacuous network assertions, and anything else already listed in
BRINGUP-PLAN §3. They are known. The run's job is to confirm or refute them, not to repair them.

## The default when unsure

Ask. A question costs a message; a fix that quietly changes what the run proves costs the run.
