/**
 * Work-product checkpoints for the gym.
 *
 * CONTROL-PLANE DURABILITY IS NOT WORK-PRODUCT DURABILITY. When a worker is
 * SIGKILLed mid-attempt, Temporal retries the activity, but the activity
 * re-materializes the pinned bugged checkout, so every edit the killed attempt
 * made is gone. This store checkpoints the agent's work product so a resumed
 * attempt continues from its edits instead of the bugged base.
 *
 * The checkpoint unit is a per-turn `git diff` patch stored as a
 * content-addressed blob, with the previous checkpoint's digest as
 * `producedFrom`, plus a durable pointer for discovery. A patch is O(delta)
 * per turn; a full-repo bundle per turn would be O(repo), and the git
 * transport's mode/symlink fidelity is only needed for final egress — a unified
 * diff already carries mode changes and `git apply` restores them.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BlobStore } from "../artifacts/blob-store.js";

export const CHECKPOINT_MEDIA_TYPE = "application/vnd.synth.gym-checkpoint+json";

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
  load(key: string): Promise<(GymCheckpoint & { digest: string }) | undefined>;
}

/** A durable pointer file plus the content-addressed blob store. */
export class BlobGymCheckpointStore implements GymCheckpointStore {
  constructor(private readonly blobs: BlobStore, private readonly pointerDir: string) {}

  #pointer(key: string): string {
    return join(this.pointerDir, `${key.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
  }

  async save(key: string, checkpoint: GymCheckpoint): Promise<string> {
    const bytes = new TextEncoder().encode(JSON.stringify(checkpoint));
    const ref = await this.blobs.put(bytes, {
      mediaType: CHECKPOINT_MEDIA_TYPE,
      producedBy: `gym:${key}`,
      ...(checkpoint.parentDigest ? { producedFrom: [checkpoint.parentDigest] } : {}),
    });
    await mkdir(this.pointerDir, { recursive: true });
    const pointer = this.#pointer(key);
    const temp = `${pointer}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify({ digest: ref.digest, at: Date.now() }));
    await rename(temp, pointer);
    return ref.digest;
  }

  async load(key: string): Promise<(GymCheckpoint & { digest: string }) | undefined> {
    try {
      const pointer = JSON.parse(await readFile(this.#pointer(key), "utf8")) as { digest?: string };
      if (!pointer.digest) return undefined;
      const checkpoint = JSON.parse(new TextDecoder().decode(await this.blobs.get(pointer.digest))) as GymCheckpoint;
      return { ...checkpoint, digest: pointer.digest };
    } catch {
      return undefined;
    }
  }
}
