import type { ExecutionBroker } from "../execution/broker.js";
import type { EffectContext } from "../execution/types.js";
export interface GymExecResult {
    code: number;
    stdout: string;
    stderr: string;
    timedOut?: boolean;
}
/** The environment the tools act on: a local checkout or a sandboxed workspace. */
export interface EffectRunner {
    readonly id: string;
    read(path: string): Promise<string>;
    write(path: string, content: string): Promise<void>;
    list(path?: string): Promise<string[]>;
    exec(command: string, options?: {
        cwd?: string;
        timeoutMs?: number;
    }): Promise<GymExecResult>;
}
export declare function localEffectRunner(root: string): EffectRunner;
/** Wrap a broker + workspace context as an EffectRunner (synthetic or sandbox rung). */
export declare function brokerEffectRunner(broker: ExecutionBroker, context: EffectContext, id?: string): EffectRunner;
export type GymToolName = "list_files" | "read_file" | "write_file" | "replace_in_file" | "run_visible_test" | "finish";
export interface GymToolCall {
    name: GymToolName;
    arguments?: Record<string, unknown>;
}
export interface GymToolDefinition {
    name: GymToolName;
    description: string;
    parameters: Record<string, {
        type: string;
        description: string;
        required?: boolean;
    }>;
}
export interface GymToolResult {
    name: GymToolName;
    ok: boolean;
    observation: string;
    /** True when the tool refused an action on policy grounds (e.g. read-only test). */
    blocked?: boolean;
    /** Set by `run_visible_test`: the test process exit code. */
    exitCode?: number;
}
export interface GymToolOptions {
    /** Repo-relative visible test path. Read-only to the agent. */
    visibleTestPath: string;
    protectedPatterns?: readonly RegExp[];
    nodeBin?: string;
    execTimeoutMs?: number;
}
export declare const GYM_TOOL_DEFINITIONS: readonly GymToolDefinition[];
export interface GymTools {
    definitions: readonly GymToolDefinition[];
    execute(call: GymToolCall): Promise<GymToolResult>;
}
export declare function createGymTools(runner: EffectRunner, options: GymToolOptions): GymTools;
/** The task prompt. Both arms must send this byte-for-byte. */
export declare function buildGymSystemPrompt(visibleTestPath: string, tools?: readonly GymToolDefinition[]): string;
export declare function buildGymUserPrompt(options: {
    visibleTestPath: string;
    visibleTestContent: string;
}): string;
