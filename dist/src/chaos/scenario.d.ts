/**
 * A small built-in crash scenario used by CI and examples. It leaves a turn
 * open, mutates the workspace, then constructs a fresh runtime and proves that
 * recovery restores the pre-turn snapshot.
 */
export declare function runCrashRecoveryScenario(): Promise<{
    before: string;
    dirty: string;
    recovered: string;
    rolledBack: number;
}>;
