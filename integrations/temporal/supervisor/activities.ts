/**
 * Supervisor activities: the side effects the workflow cannot do itself.
 *
 * Every poke is verified before it is reported as delivered — the manual loop's
 * worst failure was `send-keys` silently not landing. `pokeSession` retries and
 * confirms; `escalate` is a verified poke with an escalation message.
 */
import type {
  EscalateInput,
  EscalateResult,
  ProbeKind,
  ProbeResult,
  ProbeSessionInput,
  PokeResult,
  PokeSessionInput,
  SessionMarkers,
  SupervisorActivities,
} from "./contracts.js";
import { defaultCommandRunner, HerdrSessionProbe, TmuxSessionProbe, type SessionProbe } from "./probe.js";

export interface SupervisorActivityDeps {
  /** Override probe construction (tests, dry runs). */
  probeFor?: (kind: ProbeKind, markers?: SessionMarkers) => SessionProbe;
}

export function createSupervisorActivities(deps: SupervisorActivityDeps = {}): SupervisorActivities {
  const probeFor =
    deps.probeFor ??
    ((kind: ProbeKind, markers?: SessionMarkers): SessionProbe =>
      kind === "herdr" ? new HerdrSessionProbe(defaultCommandRunner) : new TmuxSessionProbe(defaultCommandRunner, markers));

  return {
    async probeSession(input: ProbeSessionInput): Promise<ProbeResult> {
      return probeFor(input.probeKind ?? "tmux", input.markers).probe(input.target);
    },

    async pokeSession(input: PokeSessionInput): Promise<PokeResult> {
      return probeFor(input.probeKind ?? "tmux").poke(input.target, input.text);
    },

    async escalate(input: EscalateInput): Promise<EscalateResult> {
      const seconds = Math.round(input.blockedMs / 1000);
      const text = `[supervisor] ${input.sessionId} has been ${input.status} for ${seconds}s (escalation ${input.escalations}). Check in.`;
      const result = await probeFor(input.probeKind ?? "tmux", input.markers).poke(input.target, text);
      return { delivered: result.delivered, evidence: result.evidence };
    },
  };
}
