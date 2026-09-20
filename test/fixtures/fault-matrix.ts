/**
 * Track 4: the fault matrix. This table IS the deliverable.
 *
 * Each row records what the SYNTHETIC rung (SyntheticExecutor, fidelity 0,
 * MemoryWorkspace, no filesystem) did vs the REAL rung (gVisor sandbox via
 * KubectlSandboxBackend/KubernetesExecutor), for one injected fault, and
 * whether that difference is the one we claim. Rows that do not differentiate
 * the rungs say so explicitly.
 *
 * A row is a CLAIM. `proven` means a live artifact executed the behaviour and
 * recorded output; its `evidence` must begin `EXECUTED <date>:` and its
 * `artifact` must be a runnable proof, not a unit test. `reasoned` means the
 * behaviour was NOT measured under both rungs and is inferred from shared code
 * instead; those rows carry a `rationale` and must not claim differentiation.
 * `test/fault-matrix.test.ts` enforces both, so a filename cannot stand in for
 * an executed proof.
 *
 * Faults we could NOT execute are not rows; they are listed in
 * `NOT_COVERED_FAULTS` and in the suite's "not covered" report.
 */
export type Rung = "synthetic" | "real";
export type FaultCategory = "provider" | "executor" | "temporal";
export type FaultStatus = "proven" | "reasoned" | "not-covered";

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
  status: FaultStatus;
  /** Repo-relative path to the proof that produced these values. */
  artifact: string;
  evidence: string;
  /** Required for `reasoned` rows: why it was not measured under both rungs. */
  rationale?: string;
}

export const FAULT_MATRIX: readonly FaultRow[] = [
  {
    id: "provider-502",
    category: "provider",
    fault: "inference returns HTTP 502 (transient)",
    synthetic: "retry 3x, then park (waiting); recovers when upstream returns",
    real: "retry 3x, then park (waiting); recovers when upstream returns",
    differentiates: false,
    status: "reasoned",
    artifact: "integrations/temporal/park-live.ts",
    evidence: "park-live.ts + fault-scenarios always502/fail12 (park, then recover)",
    rationale: "Reasoned from the shared HTTP classification and durable park path; a provider fault does not vary with the executor rung, so running both rungs would not change it.",
  },
  {
    id: "provider-429",
    category: "provider",
    fault: "inference returns HTTP 429 (rate limited)",
    synthetic: "retry (transient), then park; recovers",
    real: "retry (transient), then park; recovers",
    differentiates: false,
    status: "reasoned",
    artifact: "integrations/temporal/test/gateway-run-turn.test.ts",
    evidence: "gateway-run-turn.test.ts permanent-vs-transient HTTP classification (429 is transient)",
    rationale: "Reasoned from the shared HTTP classification and durable park path; a provider fault does not vary with the executor rung, so running both rungs would not change it.",
  },
  {
    id: "provider-timeout",
    category: "provider",
    fault: "per-call timeout below model latency",
    synthetic: "abort -> retry -> park; recovers when timeout raised",
    real: "abort -> retry -> park; recovers when timeout raised",
    differentiates: false,
    status: "reasoned",
    artifact: "integrations/temporal/park-live.ts",
    evidence: "fault-scenarios GATEWAY_TIMEOUT_MS=3000 (park) + hang1",
    rationale: "Reasoned from the shared HTTP classification and durable park path; a provider fault does not vary with the executor rung, so running both rungs would not change it.",
  },
  {
    id: "provider-hang",
    category: "provider",
    fault: "request accepted but never answered",
    synthetic: "client timeout -> retry -> recover",
    real: "client timeout -> retry -> recover",
    differentiates: false,
    status: "reasoned",
    artifact: "integrations/temporal/test/gateway-run-turn.test.ts",
    evidence: "gateway-run-turn.test.ts aborts a call that outlives its timeout; fault-scenarios hang1",
    rationale: "Reasoned from the shared HTTP classification and durable park path; a provider fault does not vary with the executor rung, so running both rungs would not change it.",
  },
  {
    id: "provider-garbage",
    category: "provider",
    fault: "HTTP 200 with a non-JSON reply",
    synthetic: "parse error -> retry -> recover",
    real: "parse error -> retry -> recover",
    differentiates: false,
    status: "reasoned",
    artifact: "integrations/temporal/test/gateway-run-turn.test.ts",
    evidence: "fault-scenarios garbage2; gateway-run-turn.test.ts rejects structurally invalid answers",
    rationale: "Reasoned from the shared HTTP classification and durable park path; a provider fault does not vary with the executor rung, so running both rungs would not change it.",
  },
  {
    id: "provider-slow-ok",
    category: "provider",
    fault: "slow but eventually valid reply",
    synthetic: "heartbeat while waiting -> success",
    real: "heartbeat while waiting -> success",
    differentiates: false,
    status: "reasoned",
    artifact: "integrations/temporal/swarm-inference-driver.ts",
    evidence: "live:swarm-inference (8-14s reasoning calls, heartbeat keeps it alive)",
    rationale: "Reasoned from the shared HTTP classification and durable park path; a provider fault does not vary with the executor rung, so running both rungs would not change it.",
  },
  {
    id: "exec-success",
    category: "executor",
    fault: "process.exec of a command that succeeds",
    synthetic: "ESCALATION_REQUIRED (cannot run processes)",
    real: "exit 0, stdout captured",
    differentiates: true,
    status: "proven",
    artifact: "integrations/kubernetes/fault-rungs.ts",
    evidence:
      "EXECUTED 2026-09-19: fault-rungs.ts against live k3s/gVisor with alpine/git pinned by digest (execSuccess true)",
  },
  {
    id: "exec-timeout",
    category: "executor",
    fault: "process.exec outlives its timeout",
    synthetic: "ESCALATION_REQUIRED",
    real: "ok:false, EXECUTION_TIMEOUT",
    differentiates: true,
    status: "proven",
    artifact: "integrations/kubernetes/fault-rungs.ts",
    evidence: "EXECUTED 2026-09-19: fault-rungs.ts (execTimeout expected true)",
  },
  {
    id: "exec-sigkill",
    category: "executor",
    fault: "sandbox force-deleted (SIGKILL) mid-exec",
    synthetic: "ESCALATION_REQUIRED",
    real: "ok:false (exit 137), never a false success",
    differentiates: true,
    status: "proven",
    artifact: "integrations/kubernetes/fault-rungs.ts",
    evidence: "EXECUTED 2026-09-19: fault-rungs.ts (execSigkill) + kill-chaos.ts (exitCode 137)",
  },
  {
    id: "worker-sigkill-mid-turn",
    category: "temporal",
    fault: "worker process SIGKILLed while a turn is in flight",
    synthetic: "activity retried after heartbeat timeout; abandoned attempt never reported success",
    real: "activity retried after heartbeat timeout; abandoned attempt never reported success",
    differentiates: false,
    status: "proven",
    artifact: "integrations/temporal/restart-worker.ts",
    evidence: "EXECUTED 2026-09-19: restart-worker.ts (attempts [1,2], result recovered)",
  },
  {
    id: "two-workers-race",
    category: "temporal",
    fault: "two (many) workers race to own one agent; the fenced one must lose",
    synthetic: "one lease winner; a stale generation's fenced agent write is rejected",
    real: "one lease winner; a stale generation's fenced agent write is rejected",
    differentiates: false,
    status: "proven",
    artifact: "integrations/postgres/concurrency.ts",
    evidence:
      "EXECUTED 2026-09-19: integrations/postgres/concurrency.ts against live PostgreSQL (16 workers): leaseWinners=1, dbClockSkewBlocked=true, hardAgentFencing=true, stale generation A rejected, unfenced write rejected with AGENT_FENCE_REQUIRED",
  },
];

/** Faults from the spec that we could NOT execute; kept out of the matrix. */
export const NOT_COVERED_FAULTS = ["clock-jump"] as const;

/** Faults the suite claims to have EXECUTED; each must be a `proven` row. */
export const REQUIRED_PROVEN_FAULT_IDS = [
  "exec-sigkill",
  "worker-sigkill-mid-turn",
  "two-workers-race",
] as const;

/**
 * Provider faults reasoned from shared code, not measured under both rungs. A
 * provider fault does not vary with the executor rung, so the honest status is
 * `reasoned`; running the rungs would not change the row.
 */
export const REQUIRED_REASONED_FAULT_IDS = [
  "provider-502",
  "provider-429",
  "provider-timeout",
  "provider-hang",
  "provider-garbage",
  "provider-slow-ok",
] as const;
