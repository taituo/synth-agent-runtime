/**
 * One durable supervisor workflow per interactive session.
 *
 * It check-ins on a durable timer, delivers human redirection via signals, and
 * escalates when a session stays blocked past a threshold. Because it lives in
 * Temporal, a worker restart does not lose the schedule, the history, or a
 * queued redirection — the three things the manual 30-minute monitor kept
 * losing.
 */
import { condition, defineQuery, defineSignal, log, proxyActivities, setHandler } from "@temporalio/workflow";
import {
  DEFAULT_MAX_ESCALATIONS,
  type SessionStatus,
  type SupervisorActivities,
  type SupervisorInput,
  type SupervisorState,
} from "./contracts.js";

const activities = proxyActivities<SupervisorActivities>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 3 },
});

export const redirectSignal = defineSignal<[string]>("redirect");
export const pauseSignal = defineSignal("pause");
export const resumeSignal = defineSignal("resume");
export const stopSignal = defineSignal("stop");
export const getSupervisorStateQuery = defineQuery<SupervisorState>("getSupervisorState");

export async function superviseSessionWorkflow(input: SupervisorInput): Promise<SupervisorState> {
  const maxEscalations = input.maxEscalations ?? DEFAULT_MAX_ESCALATIONS;
  const redirects: string[] = [];
  let wake = false;
  const state: SupervisorState = {
    sessionId: input.sessionId,
    target: input.target,
    status: "unknown",
    checkIns: 0,
    escalations: 0,
    pokes: 0,
    paused: false,
    stopped: false,
    updatedAt: Date.now(),
  };

  setHandler(redirectSignal, (text: string) => {
    redirects.push(text);
    state.lastRedirect = text;
    state.updatedAt = Date.now();
    wake = true;
  });
  setHandler(pauseSignal, () => { state.paused = true; state.updatedAt = Date.now(); wake = true; });
  setHandler(resumeSignal, () => { state.paused = false; state.updatedAt = Date.now(); wake = true; });
  setHandler(stopSignal, () => { state.stopped = true; state.updatedAt = Date.now(); wake = true; });
  setHandler(getSupervisorStateQuery, () => state);

  const probeInput = {
    target: input.target,
    ...(input.probeKind ? { probeKind: input.probeKind } : {}),
    ...(input.markers ? { markers: input.markers } : {}),
  };

  while (!state.stopped) {
    // Wait for the next check-in, waking early on any signal. `condition` with a
    // timeout is the durable timer; a worker restart resumes the same wait.
    await condition(() => state.stopped || wake, input.checkInMs);
    wake = false;
    if (state.stopped) break;

    // Deliver queued redirection, verified. A failed delivery is logged, not
    // silently dropped, and the text is not requeued (the human can resend).
    while (redirects.length > 0) {
      const text = redirects.shift()!;
      const poke = await activities.pokeSession({ target: input.target, text, ...(input.probeKind ? { probeKind: input.probeKind } : {}) });
      state.pokes += 1;
      state.lastPokeAt = Date.now();
      state.updatedAt = Date.now();
      if (!poke.delivered) log.warn("supervisor.poke_undelivered", { text, evidence: poke.evidence });
    }
    if (state.paused) continue;

    const probe = await activities.probeSession(probeInput);
    state.checkIns += 1;
    state.status = probe.status;
    state.lastEvidence = probe.evidence;
    state.lastProbeAt = Date.now();
    state.updatedAt = Date.now();

    if (probe.status === "blocked") {
      if (state.blockedSince === undefined) state.blockedSince = Date.now();
      const blockedMs = Date.now() - state.blockedSince;
      if (blockedMs >= input.blockedThresholdMs && state.escalations < maxEscalations) {
        state.escalations += 1;
        const result = await activities.escalate({
          sessionId: input.sessionId,
          target: input.target,
          status: probe.status,
          blockedMs,
          escalations: state.escalations,
          ...(input.probeKind ? { probeKind: input.probeKind } : {}),
          ...(input.markers ? { markers: input.markers } : {}),
        });
        state.lastPokeAt = Date.now();
        state.updatedAt = Date.now();
        if (!result.delivered) log.warn("supervisor.escalation_undelivered", { evidence: result.evidence });
      }
    } else {
      state.blockedSince = undefined;
      if (probe.status === "done") {
        state.stopped = true;
      }
    }
  }

  state.updatedAt = Date.now();
  return state;
}

/** Re-exported for callers that want the status type without importing contracts. */
export type { SessionStatus };
