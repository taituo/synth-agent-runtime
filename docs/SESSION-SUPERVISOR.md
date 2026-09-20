# Durable session supervisor

A Temporal workflow that watches interactive agent sessions (tmux panes, or
herdr panes when available) and pokes them. It replaces a hand-run loop that
was demonstrably fragile:

- a 30-minute background monitor that had to be **re-armed by hand**;
- `tmux capture-pane` scraped for the string `esc interrupt` to **guess**
  whether an agent was busy;
- `tmux send-keys` followed by a separate Enter and a capture to confirm the
  message went in, which **silently failed more than once**.

Every one of those is a durability problem Temporal already solves: retries,
history, signals, schedules, and survival across restarts.

**Be honest about what this is**: a supervisor that watches workers and nudges
them. Useful, and slightly Orwellian. It does not judge the work; it pokes.

## Why it is a separate deployment

The supervisor runs on its **own** Temporal (default `127.0.0.1:7244`), never
the runtime-under-test's `7243`. If it shared a deployment, restarting or
testing the system under test would take its own supervisor down with it. It
also uses no workflow interceptors from the runtime integration, for the same
reason.

## Shape

- **One workflow per session** (`superviseSessionWorkflow`), addressed by
  `workflowId = supervisor/<sessionId>`.
- **Periodic check-ins** are durable timers inside the workflow (`checkInMs`).
  A **Temporal Schedule** per session (`ensureSupervisorSchedule`, cron default
  every 30 minutes, overlap SKIP) guarantees a supervisor exists at all, and
  re-creates it if it dies.
- **Signals for human redirection**: `redirect(text)`, `pause`, `resume`,
  `stop`. A redirect wakes the workflow immediately and is delivered as a
  verified poke.
- **Escalation**: when a session has been `blocked` for `blockedThresholdMs`,
  the workflow sends a verified escalation poke, up to `maxEscalations`.
- **Query**: `getSupervisorState` returns status, check-ins, blocked-since,
  escalations, pokes, and the last redirect.

## Probes: a real signal where one exists

`SessionProbe` is the seam. Preference order is deliberate:

- **herdr** exposes a real per-pane state (`idle|working|blocked|done`). Use it
  when present; `HerdrSessionProbe` parses the documented state document. herdr
  is not installed in this environment, so the exact CLI invocation is
  configurable (`bin`, `stateArgs`, `sendArgs`) and its parsing is unit-tested;
  the live proof runs on tmux.
- **tmux** has no state API, so `TmuxSessionProbe` scrapes the pane for a marker
  and reports `probe: "tmux"` — a guess is never mistaken for a real signal.
- `unknown` is a real answer. A probe that cannot tell says so.

Every poke is **verified**: the text is sent, then a separate Enter, then the
pane is captured and must contain the text, with retries. A poke that did not
land is reported as `delivered: false` and logged, never assumed.

## Run

```bash
# a separate Temporal for the supervisor (not the runtime's 7243)
temporal server start-dev --headless --port 7244

# the worker
SUPERVISOR_TEMPORAL_ADDRESS=127.0.0.1:7244 npm run supervisor:worker

# the live proof: real tmux pane, check-in, escalation, verified redirect,
# and a worker SIGKILL + restart that the workflow survives
SUPERVISOR_TEMPORAL_ADDRESS=127.0.0.1:7244 npm run live:supervisor
```

`live:supervisor` skips (exit 2) if tmux or the separate Temporal is absent; a
skip is never `ok:true`.
