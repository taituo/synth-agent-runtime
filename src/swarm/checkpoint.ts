/**
 * Work-product checkpoints for the swarm: the findings reported so far and the
 * transcript, so a SIGKILLed attempt resumes from its findings instead of the
 * empty stream. Same content-addressed blob + pointer pattern as the gym's
 * checkpoint store, but the work product is findings, not a patch.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BlobStore } from "../artifacts/blob-store.js";
import type { ReportedFinding } from "./findings.js";

export const SWARM_CHECKPOINT_MEDIA_TYPE = "application/vnd.synth.swarm-checkpoint+json";

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
  load(key: string): Promise<(SwarmCheckpoint & { digest: string }) | undefined>;
}

export class BlobSwarmCheckpointStore implements SwarmCheckpointStore {
  constructor(private readonly blobs: BlobStore, private readonly pointerDir: string) {}

  #pointer(key: string): string {
    return join(this.pointerDir, `${key.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
  }

  async save(key: string, checkpoint: SwarmCheckpoint): Promise<string> {
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

  async load(key: string): Promise<(SwarmCheckpoint & { digest: string }) | undefined> {
    try {
      const pointer = JSON.parse(await readFile(this.#pointer(key), "utf8")) as { digest?: string };
      if (!pointer.digest) return undefined;
      const checkpoint = JSON.parse(new TextDecoder().decode(await this.blobs.get(pointer.digest))) as SwarmCheckpoint;
      return { ...checkpoint, digest: pointer.digest };
    } catch {
      return undefined;
    }
  }
}
