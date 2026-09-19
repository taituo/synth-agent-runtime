/**
 * Track 3: seeded synthetic event-stream generators and the mailbox/turn
 * property they must satisfy.
 *
 * The property under test is the one the earlier mailbox fix had to get right:
 * for ANY generated stream, the concatenation of all turns' batches must equal
 * the input stream exactly — nothing lost, duplicated or reordered — even when
 * events arrive while a turn is in flight.
 *
 * Deterministic from a seed (the seed is printed on every run) so a failure is
 * reproducible; `shrinkPrefix` reduces a failing stream to a minimal repro.
 */
import { EVENT_CLASSES } from "./src/gateway-run-turn.js";

export type ArrivalPattern = "steady" | "bursty" | "herd";

export interface GeneratedEvent {
  id: string;
  kind: string;
  text: string;
  /** Delay before this event is sent, relative to the previous event. */
  delayMs: number;
}

export interface GenerateOptions {
  size: number;
  pattern: ArrivalPattern;
  maxTextLength?: number;
}

/** mulberry32: tiny, fast, deterministic PRNG. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  "checkout",
  "latency",
  "spike",
  "deploy",
  "rollback",
  "database",
  "replica",
  "alert",
  "on-call",
  "certificate",
  "news",
  "rumour",
  "post",
  "update",
  "maintenance",
  "storm",
  "outage",
  "recovered",
];

function makeText(random: () => number, maxTextLength: number): string {
  const words = Math.floor(random() * (maxTextLength / 8));
  if (words === 0) return random() < 0.5 ? "" : "   ";
  const parts: string[] = [];
  for (let i = 0; i < words; i++) parts.push(WORDS[Math.floor(random() * WORDS.length)]!);
  return parts.join(" ");
}

function makeDelay(random: () => number, pattern: ArrivalPattern): number {
  switch (pattern) {
    case "steady":
      return 120;
    case "bursty":
      return random() < 0.5 ? 20 : 300;
    case "herd":
      return 0;
  }
}

export function generateStream(seed: number, options: GenerateOptions): GeneratedEvent[] {
  const random = mulberry32(seed);
  const maxTextLength = options.maxTextLength ?? 120;
  const events: GeneratedEvent[] = [];
  for (let i = 0; i < options.size; i++) {
    events.push({
      id: `seed${seed}-e${i}`,
      kind: EVENT_CLASSES[Math.floor(random() * EVENT_CLASSES.length)]!,
      text: makeText(random, maxTextLength),
      delayMs: i === 0 ? 0 : makeDelay(random, options.pattern),
    });
  }
  return events;
}

export interface BatchPropertyResult {
  ok: boolean;
  reason?: string;
}

/** concat(batches) must equal the input ids exactly, in order. */
export function batchProperty(inputIds: readonly string[], batches: readonly (readonly string[])[]): BatchPropertyResult {
  const flat = batches.flat();
  if (flat.length !== inputIds.length) {
    return { ok: false, reason: `batched ${flat.length} of ${inputIds.length} events` };
  }
  for (let i = 0; i < inputIds.length; i++) {
    if (flat[i] !== inputIds[i]) return { ok: false, reason: `order mismatch at ${i}: got ${flat[i]}, expected ${inputIds[i]}` };
  }
  return { ok: true };
}

/**
 * Minimal failing prefix: smallest leading slice of `stream` for which
 * `stillFails` returns true. If even the whole stream passes, returns it.
 */
export async function shrinkPrefix<T>(
  stream: readonly T[],
  stillFails: (candidate: readonly T[]) => Promise<boolean>,
): Promise<T[]> {
  for (let size = 1; size < stream.length; size++) {
    const candidate = stream.slice(0, size);
    if (await stillFails(candidate)) return [...candidate];
  }
  return [...stream];
}
