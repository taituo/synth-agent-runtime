import type { AgentId, TaskId, WorkspaceId } from "../core/ids.js";
import type { ExecutionPolicy } from "./resource-class.js";
export type Effect = {
    id: string;
    kind: "workspace.read";
    path: string;
} | {
    id: string;
    kind: "workspace.write";
    path: string;
    content: Uint8Array | string;
} | {
    id: string;
    kind: "workspace.delete";
    path: string;
} | {
    id: string;
    kind: "workspace.symlink";
    path: string;
    target: string;
} | {
    id: string;
    kind: "workspace.list";
    path?: string;
} | {
    id: string;
    kind: "process.exec";
    command: string;
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    resourceClass?: string;
} | {
    id: string;
    kind: "workflow.run";
    name: string;
    input: unknown;
} | {
    id: string;
    kind: "human.approval";
    prompt: string;
    data?: unknown;
};
export interface EffectContext {
    agentId: AgentId;
    taskId?: TaskId;
    workspaceId: WorkspaceId;
    executionPolicy?: ExecutionPolicy;
}
/** A reference to an out-of-band artifact; the content lives in the blob store. */
export interface ArtifactRef {
    digest: string;
    size: number;
    mediaType: string;
    mechanism: string;
    /** Producer (agent/workflow id) for provenance. */
    producedBy?: string;
    /** Input digests, so a chain of agents can be walked backwards. */
    producedFrom?: string[];
}
export interface EffectResult {
    ok: boolean;
    output?: unknown;
    error?: string;
    executor?: string;
    fidelity?: number;
    /** Artifact produced by this effect, addressed by digest (never inline bytes). */
    artifact?: ArtifactRef;
}
export interface Executor {
    readonly id: string;
    readonly fidelity: number;
    readonly resourceClassId?: string;
    canExecute(effect: Effect, context: EffectContext): boolean | Promise<boolean>;
    execute(effect: Effect, context: EffectContext): Promise<EffectResult>;
}
