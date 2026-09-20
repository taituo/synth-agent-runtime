/**
 * 2c part two: a reference-carrying handoff between two workflows.
 *
 * The producer workflow returns a small artifact reference (digest, size,
 * provenance). The consumer is a DIFFERENT workflow; it receives the reference
 * by signal — never the bytes — reads the content out of band by digest, and
 * produces a derived artifact whose `producedFrom` points back at the producer.
 */
import { condition, defineQuery, defineSignal, proxyActivities, setHandler } from "@temporalio/workflow";

export interface ArtifactRef {
  digest: string;
  size: number;
  mediaType: string;
  mechanism: string;
  producedBy?: string;
  producedFrom?: string[];
}

export const deliverArtifact = defineSignal<[ArtifactRef]>("deliverArtifact");
export const getConsumed = defineQuery<ArtifactRef | null>("getConsumed");

interface HandoffActivities {
  produce(size: number): Promise<ArtifactRef>;
  consume(ref: ArtifactRef): Promise<{ digest: string; size: number; matches: boolean; bytes: number }>;
  derive(ref: ArtifactRef): Promise<ArtifactRef>;
}
const { produce, consume, derive } = proxyActivities<HandoffActivities>({ startToCloseTimeout: "1 minute" });

export async function producerWorkflow(size: number): Promise<ArtifactRef> {
  return produce(size);
}

export async function consumerWorkflow(): Promise<ArtifactRef> {
  let ref: ArtifactRef | null = null;
  setHandler(deliverArtifact, (value) => {
    ref = value;
  });
  setHandler(getConsumed, () => ref);
  await condition(() => ref !== null);
  const received = ref as ArtifactRef;
  const check = await consume(received);
  if (!check.matches) throw new Error(`artifact digest mismatch: ${check.digest}`);
  return derive(received);
}
