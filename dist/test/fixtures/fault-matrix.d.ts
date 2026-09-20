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
export declare const FAULT_MATRIX: readonly FaultRow[];
/** Faults from the spec that we could NOT execute; kept out of the matrix. */
export declare const NOT_COVERED_FAULTS: readonly ["clock-jump"];
/** Faults the suite claims to have EXECUTED; each must be a `proven` row. */
export declare const REQUIRED_PROVEN_FAULT_IDS: readonly ["exec-sigkill", "worker-sigkill-mid-turn", "two-workers-race"];
/**
 * Provider faults reasoned from shared code, not measured under both rungs. A
 * provider fault does not vary with the executor rung, so the honest status is
 * `reasoned`; running the rungs would not change the row.
 */
export declare const REQUIRED_REASONED_FAULT_IDS: readonly ["provider-502", "provider-429", "provider-timeout", "provider-hang", "provider-garbage", "provider-slow-ok"];
