import type { BlobStore } from "../artifacts/blob-store.js";
export declare const CHECKPOINT_MEDIA_TYPE = "application/vnd.synth.gym-checkpoint+json";
export interface GymCheckpointEntry {
    role: "assistant" | "tool";
    name?: string;
    content: string;
}
export interface GymCheckpoint {
    /** Number of completed turns; the resumed loop starts here. */
    turnIndex: number;
    /** Workspace diff against the pinned base commit. */
    patchText: string;
    transcript: GymCheckpointEntry[];
    requestedModel?: string | null;
    servedModel?: string | null;
    /**
     * Digest of the sandbox workspace checkpoint (a workspace diff in the same
     * blob store): the durable reference a resumed attempt restores from so the
     * pod's committed edits survive a worker SIGKILL. Absent on local/control
     * attempts (no pod) and on checkpoints written before this field existed; the
     * `patchText` is then the fallback replay.
     */
    workspaceDigest?: string;
    /** Digest of the previous checkpoint, for the provenance chain. */
    parentDigest?: string;
}
export interface GymCheckpointStore {
    /** Persist and return this checkpoint's digest. */
    save(key: string, checkpoint: GymCheckpoint): Promise<string>;
    /** Latest checkpoint for `key`, or undefined. */
    load(key: string): Promise<(GymCheckpoint & {
        digest: string;
    }) | undefined>;
}
/** A durable pointer file plus the content-addressed blob store. */
export declare class BlobGymCheckpointStore implements GymCheckpointStore {
    #private;
    private readonly blobs;
    private readonly pointerDir;
    constructor(blobs: BlobStore, pointerDir: string);
    save(key: string, checkpoint: GymCheckpoint): Promise<string>;
    load(key: string): Promise<(GymCheckpoint & {
        digest: string;
    }) | undefined>;
}
