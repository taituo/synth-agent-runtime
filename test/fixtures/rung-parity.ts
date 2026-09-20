/**
 * Differential harness for rung parity: runs the SAME generated workspace
 * effect sequence against the synthetic rung (MemoryWorkspace + SyntheticExecutor)
 * and against a real filesystem (RealFsExecutor over a temp dir), then diffs the
 * observable outcome per effect plus the final top-level listing.
 *
 * The real filesystem is the oracle. A divergence is either a synthetic bug or
 * a documented, deliberately-accepted difference.
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  MemoryWorkspace,
  SyntheticExecutor,
  WORKSPACE_IS_DIRECTORY,
  WORKSPACE_NOT_DIRECTORY,
  WORKSPACE_NOT_FOUND,
  WORKSPACE_PATH_ESCAPES,
  escapesWorkspace,
  normalizeRelative,
  workspaceError,
  type Effect,
  type EffectContext,
  type EffectResult,
  type Executor,
  type WorkspaceId,
} from "../../src/index.js";

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

/** Small shared path alphabet, including nested, file/dir reuse, odd names and `..`. */
export const PARITY_PATHS = [
  "a",
  "a/b.txt",
  "a/c",
  "a/c/d.txt",
  "f.txt",
  "f.txt/child",
  "x/y/z",
  "dir with space/naïve--name.txt",
  "../escape.txt",
  "a/../../escape2.txt",
] as const;

export function generateWorkspaceSequence(seed: number, size: number): Effect[] {
  const random = mulberry32(seed);
  const kinds: Effect["kind"][] = ["workspace.write", "workspace.read", "workspace.delete", "workspace.list"];
  const effects: Effect[] = [];
  for (let i = 0; i < size; i++) {
    const kind = kinds[Math.floor(random() * kinds.length)]!;
    const path = PARITY_PATHS[Math.floor(random() * PARITY_PATHS.length)]!;
    const id = `s${seed}-e${i}`;
    if (kind === "workspace.write") effects.push({ id, kind, path, content: `v${Math.floor(random() * 1000)}` });
    else if (kind === "workspace.read") effects.push({ id, kind, path });
    else if (kind === "workspace.delete") effects.push({ id, kind, path });
    else effects.push({ id, kind: "workspace.list", path });
  }
  return effects;
}

/** Real-filesystem executor: the oracle for workspace semantics. */
export class RealFsExecutor implements Executor {
  readonly id = "real-fs";
  readonly fidelity = 100;
  constructor(private readonly root: string) {}

  canExecute(effect: Effect): boolean {
    return effect.kind.startsWith("workspace.");
  }

  async execute(effect: Effect, _context: EffectContext): Promise<EffectResult> {
    const raw = pathOf(effect);
    if (escapesWorkspace(raw)) return { ok: false, error: workspaceError(WORKSPACE_PATH_ESCAPES, raw) };
    const rel = normalizeRelative(raw);
    const abs = join(this.root, rel);
    // The workspace root is a directory: list succeeds, everything else is an
    // EISDIR-equivalent result (never a throw, never a delete of the root).
    if (!rel) {
      if (effect.kind === "workspace.list") return { ok: true, output: (await readdir(this.root)).sort() };
      return { ok: false, error: workspaceError(WORKSPACE_IS_DIRECTORY, rel) };
    }
    try {
      switch (effect.kind) {
        case "workspace.read": {
          const info = await stat(abs);
          if (info.isDirectory()) return { ok: false, error: workspaceError(WORKSPACE_IS_DIRECTORY, rel) };
          return { ok: true, output: new Uint8Array(await readFile(abs)) };
        }
        case "workspace.write": {
          await mkdir(dirname(abs), { recursive: true });
          await writeFile(abs, effect.content);
          return { ok: true };
        }
        case "workspace.delete": {
          const info = await stat(abs);
          await rm(abs, { recursive: info.isDirectory() });
          return { ok: true };
        }
        case "workspace.list": {
          const info = await stat(abs);
          if (!info.isDirectory()) return { ok: false, error: workspaceError(WORKSPACE_NOT_DIRECTORY, rel) };
          return { ok: true, output: (await readdir(abs)).sort() };
        }
        default:
          return { ok: false, error: "ESCALATION_REQUIRED" };
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { ok: false, error: workspaceError(WORKSPACE_NOT_FOUND, rel) };
      if (code === "ENOTDIR" || code === "EEXIST") return { ok: false, error: workspaceError(WORKSPACE_NOT_DIRECTORY, rel) };
      if (code === "EISDIR") return { ok: false, error: workspaceError(WORKSPACE_IS_DIRECTORY, rel) };
      return { ok: false, error: `${code ?? "ERROR"}:${rel}` };
    }
  }
}

function pathOf(effect: Effect): string {
  return "path" in effect && typeof effect.path === "string" ? effect.path : "";
}

export interface ParityOutcome {
  id: string;
  kind: Effect["kind"];
  path: string;
  ok: boolean;
  error?: string;
  outputBytes?: string;
}

export async function runSequence(executor: Executor, effects: readonly Effect[], workspaceId: WorkspaceId): Promise<ParityOutcome[]> {
  const context = { agentId: "agt_parity" as EffectContext["agentId"], workspaceId };
  const outcomes: ParityOutcome[] = [];
  for (const effect of effects) {
    const result = await executor.execute(effect, context);
    outcomes.push({
      id: effect.id,
      kind: effect.kind,
      path: pathOf(effect),
      ok: result.ok,
      ...(result.error ? { error: result.error } : {}),
      ...(result.output !== undefined ? { outputBytes: outputString(result.output) } : {}),
    });
  }
  return outcomes;
}

function outputString(output: unknown): string {
  if (output instanceof Uint8Array) return Buffer.from(output).toString("base64");
  if (Array.isArray(output)) return output.map(String).sort().join(",");
  return String(output);
}

/** Minimal, human-readable differences between two outcome streams. */
export function diffOutcomes(expected: readonly ParityOutcome[], actual: readonly ParityOutcome[]): string[] {
  const diffs: string[] = [];
  for (let i = 0; i < Math.max(expected.length, actual.length); i++) {
    const a = expected[i];
    const b = actual[i];
    if (!a || !b) { diffs.push(`#${i}: length mismatch`); continue; }
    if (a.ok !== b.ok || a.error !== b.error || a.outputBytes !== b.outputBytes) {
      diffs.push(`#${i} ${a.kind} ${a.path}: real=${JSON.stringify({ ok: a.ok, error: a.error, out: a.outputBytes })} synthetic=${JSON.stringify({ ok: b.ok, error: b.error, out: b.outputBytes })}`);
    }
  }
  return diffs;
}

export function makeSyntheticExecutor(): { executor: SyntheticExecutor; workspace: MemoryWorkspace } {
  const workspace = new MemoryWorkspace();
  return { executor: new SyntheticExecutor(new Map([[workspace.id, workspace]])), workspace };
}
