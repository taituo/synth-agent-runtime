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
export const CHECKPOINT_MEDIA_TYPE = "application/vnd.synth.gym-checkpoint+json";
/** A durable pointer file plus the content-addressed blob store. */
export class BlobGymCheckpointStore {
    blobs;
    pointerDir;
    constructor(blobs, pointerDir) {
        this.blobs = blobs;
        this.pointerDir = pointerDir;
    }
    #pointer(key) {
        return join(this.pointerDir, `${key.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
    }
    async save(key, checkpoint) {
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
    async load(key) {
        try {
            const pointer = JSON.parse(await readFile(this.#pointer(key), "utf8"));
            if (!pointer.digest)
                return undefined;
            const checkpoint = JSON.parse(new TextDecoder().decode(await this.blobs.get(pointer.digest)));
            return { ...checkpoint, digest: pointer.digest };
        }
        catch {
            return undefined;
        }
    }
}
