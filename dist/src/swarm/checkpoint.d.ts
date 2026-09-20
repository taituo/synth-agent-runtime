import type { BlobStore } from "../artifacts/blob-store.js";
import type { ReportedFinding } from "./findings.js";
export declare const SWARM_CHECKPOINT_MEDIA_TYPE = "application/vnd.synth.swarm-checkpoint+json";
export interface SwarmTranscriptEntry {
    role: "assistant" | "tool";
    name?: string;
    content: string;
}
export interface SwarmCheckpoint {
    /** Number of completed turns; a resumed loop starts here. */
    turnIndex: number;
    findings: ReportedFinding[];
    transcript: SwarmTranscriptEntry[];
    requestedModel?: string | null;
    servedModel?: string | null;
    /** Digest of the previous checkpoint, for the provenance chain. */
    parentDigest?: string;
}
export interface SwarmCheckpointStore {
    save(key: string, checkpoint: SwarmCheckpoint): Promise<string>;
    load(key: string): Promise<(SwarmCheckpoint & {
        digest: string;
    }) | undefined>;
}
export declare class BlobSwarmCheckpointStore implements SwarmCheckpointStore {
    #private;
    private readonly blobs;
    private readonly pointerDir;
    constructor(blobs: BlobStore, pointerDir: string);
    save(key: string, checkpoint: SwarmCheckpoint): Promise<string>;
    load(key: string): Promise<(SwarmCheckpoint & {
        digest: string;
    }) | undefined>;
}
