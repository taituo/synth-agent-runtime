/**
 * Track 4: the fault matrix. This table IS the deliverable.
 *
 * Each row records what the SYNTHETIC rung (SyntheticExecutor, fidelity 0,
 * MemoryWorkspace, no filesystem) did vs the REAL rung (gVisor sandbox via
 * KubectlSandboxBackend/KubernetesExecutor), for one injected fault, and
 * whether that difference is the one we claim. Rows that do not differentiate
 * the rungs say so explicitly rather than being dropped.
 *
 * Evidence column points at the live proof/test that produced the values.
 */
export type Rung = "synthetic" | "real";
export type FaultCategory = "provider" | "executor" | "temporal";

export interface FaultRow {
  id: string;
  category: FaultCategory;
  fault: string;
  /** What the synthetic rung did. */
  synthetic: string;
  /** What the real (gVisor) rung did. */
  real: string;
  /** True when the two rungs behave differently for this fault. */
  differentiates: boolean;
  evidence: string;
}

export const FAULT_MATRIX: readonly FaultRow[] = [
  {
    id: "provider-502",
    category: "provider",
    fault: "inference returns HTTP 502 (transient)",
    synthetic: "retry 3x, then park (waiting); recovers when upstream returns",
    real: "retry 3x, then park (waiting); recovers when upstream returns",
    differentiates: false,
    evidence: "integrations/temporal park-live.ts + fault-scenarios always502/fail12",
  },
  {
    id: "provider-429",
    category: "provider",
    fault: "inference returns HTTP 429 (rate limited)",
    synthetic: "retry (transient), then park; recovers",
    real: "retry (transient), then park; recovers",
    differentiates: false,
    evidence: "gateway-run-turn.test.ts permanent-vs-transient HTTP classification",
  },
  {
    id: "provider-timeout",
    category: "provider",
    fault: "per-call timeout below model latency",
    synthetic: "abort -> retry -> park; recovers when timeout raised",
    real: "abort -> retry -> park; recovers when timeout raised",
    differentiates: false,
    evidence: "fault-scenarios GATEWAY_TIMEOUT_MS=3000 (park) + hang1",
  },
  {
    id: "provider-hang",
    category: "provider",
    fault: "request accepted but never answered",
    synthetic: "client timeout -> retry -> recover",
    real: "client timeout -> retry -> recover",
    differentiates: false,
    evidence: "fault-scenarios hang1 (GATEWAY_TIMEOUT_MS=25000)",
  },
  {
    id: "provider-garbage",
    category: "provider",
    fault: "HTTP 200 with a non-JSON reply",
    synthetic: "parse error -> retry -> recover",
    real: "parse error -> retry -> recover",
    differentiates: false,
    evidence: "fault-scenarios garbage2",
  },
  {
    id: "provider-slow-ok",
    category: "provider",
    fault: "slow but eventually valid reply",
    synthetic: "heartbeat while waiting -> success",
    real: "heartbeat while waiting -> success",
    differentiates: false,
    evidence: "live:swarm-inference (8-14s reasoning calls, heartbeat)",
  },
  {
    id: "exec-success",
    category: "executor",
    fault: "process.exec of a command that succeeds",
    synthetic: "ESCALATION_REQUIRED (cannot run processes)",
    real: "exit 0, stdout captured",
    differentiates: true,
    evidence:
      "EXECUTED 2026-09-19: integrations/kubernetes/fault-rungs.ts against live k3s/gVisor with docker.io/alpine/git pinned by digest (execSuccess true); synthetic side: test/fault-matrix.test.ts",
  },
  {
    id: "exec-timeout",
    category: "executor",
    fault: "process.exec outlives its timeout",
    synthetic: "ESCALATION_REQUIRED",
    real: "ok:false, EXECUTION_TIMEOUT",
    differentiates: true,
    evidence:
      "EXECUTED 2026-09-19: integrations/kubernetes/fault-rungs.ts against live k3s/gVisor with alpine/git pinned by digest (execTimeout expected true)",
  },
  {
    id: "exec-sigkill",
    category: "executor",
    fault: "sandbox force-deleted (SIGKILL) mid-exec",
    synthetic: "ESCALATION_REQUIRED",
    real: "ok:false (exit 137), never a false success",
    differentiates: true,
    evidence:
      "EXECUTED 2026-09-19: integrations/kubernetes/fault-rungs.ts (execSigkill expected true) + kill-chaos.ts (exitCode 137) against live k3s/gVisor with alpine/git pinned by digest",
  },
  {
    id: "worker-sigkill-mid-turn",
    category: "temporal",
    fault: "worker process SIGKILLed while a turn is in flight",
    synthetic: "UNPROVEN (planned Track 6)",
    real: "UNPROVEN (planned Track 6)",
    differentiates: false,
    evidence: "NOT COVERED: planned Track 6 (root process-crash.test.ts covers the runtime, not a Temporal worker restart)",
  },
  {
    id: "two-workers-race",
    category: "temporal",
    fault: "two workers on the same task queue race one agent",
    synthetic: "UNPROVEN (planned Track 6)",
    real: "UNPROVEN (planned Track 6)",
    differentiates: false,
    evidence: "NOT COVERED: planned Track 6",
  },
  {
    id: "clock-jump",
    category: "temporal",
    fault: "host clock jumps during a turn",
    synthetic: "not covered: no injectable clock in this repo",
    real: "not covered: no injectable clock in this repo",
    differentiates: false,
    evidence: "NOT COVERED",
  },
];

export const REQUIRED_FAULT_IDS = [
  "provider-502",
  "provider-429",
  "provider-timeout",
  "provider-hang",
  "provider-garbage",
  "provider-slow-ok",
  "exec-sigkill",
  "worker-sigkill-mid-turn",
  "clock-jump",
  "two-workers-race",
] as const;
