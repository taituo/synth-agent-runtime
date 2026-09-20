/**
 * Work-product checkpoints for the swarm: the findings reported so far and the
 * transcript, so a SIGKILLed attempt resumes from its findings instead of the
 * empty stream. Same content-addressed blob + pointer pattern as the gym's
 * checkpoint store, but the work product is findings, not a patch.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
export const SWARM_CHECKPOINT_MEDIA_TYPE = "application/vnd.synth.swarm-checkpoint+json";
export class BlobSwarmCheckpointStore {
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
            mediaType: SWARM_CHECKPOINT_MEDIA_TYPE,
            producedBy: `swarm:${key}`,
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
