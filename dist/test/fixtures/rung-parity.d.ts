import { MemoryWorkspace, SyntheticExecutor, type Effect, type Executor, type WorkspaceId } from "../../src/index.js";
export declare function mulberry32(seed: number): () => number;
/**
 * Small shared path alphabet: nested paths, a path reused as file then
 * directory, an odd name, and `..` segments. The `..` rows exercise a
 * DOCUMENTED divergence (the synthetic rung confines; the raw OS escapes).
 */
export declare const PARITY_PATHS: readonly ["a", "a/b.txt", "a/c", "a/c/d.txt", "f.txt", "f.txt/child", "x/y/z", "dir with space/naïve--name.txt", "../escape.txt", "a/../../escape2.txt"];
export declare function generateWorkspaceSequence(seed: number, size: number): Effect[];
/**
 * A unique parent dir plus a workspace root inside it, so a path that escapes
 * the root (which the raw oracle really does) stays inside the temp parent and
 * is removed with it.
 */
export declare function makeParityRoot(seed: number): Promise<{
    parent: string;
    root: string;
}>;
export interface ParityOutcome {
    id: string;
    kind: Effect["kind"];
    path: string;
    ok: boolean;
    category: string;
    error?: string;
    outputBytes?: string;
}
/** Coarse error category, so raw errno and the synthetic vocabulary compare. */
export declare function categoryOf(error: string | undefined): string;
export declare function runSequence(executor: Executor, effects: readonly Effect[], workspaceId: WorkspaceId): Promise<ParityOutcome[]>;
/**
 * True when a path escapes the workspace root, computed independently of the
 * implementation (node:path + `..` depth). The escape exemption must not be
 * granted just because the synthetic rung labelled something
 * `WORKSPACE_PATH_ESCAPES` — that would let a wrongly-rejecting rung hide
 * behind its own error string (S4).
 */
export declare function escapesByPath(path: string): boolean;
export interface OutcomeDiff {
    index: number;
    /** "escape" is a documented divergence (synthetic confines, raw OS escapes). */
    kind: "escape" | "other";
    detail: string;
}
export declare function diffOutcomes(oracle: readonly ParityOutcome[], synthetic: readonly ParityOutcome[]): OutcomeDiff[];
export declare function makeSyntheticExecutor(): {
    executor: SyntheticExecutor;
    workspace: MemoryWorkspace;
};
