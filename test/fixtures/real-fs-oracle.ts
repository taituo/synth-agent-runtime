/**
 * The independent oracle for rung parity: raw `node:fs`, doing what the OS does.
 *
 * HARD RULE: this file must NOT import any value from `src/execution` or
 * `src/workspace`. The previous harness applied the synthetic rung's own
 * `escapesWorkspace`/`normalizeRelative` helpers in the "real" arm, so path
 * policy compared the synthetic rung against itself. Only a type-only import of
 * the effect shapes is allowed. `test/rung-parity.test.ts` asserts this.
 *
 * Semantics are the OS's, not ours:
 *   - an absolute path is used as-is (writes at that absolute path);
 *   - a `..` that leaves the root leaves the root;
 *   - a missing path is ENOENT.
 * The harness points `root` at a unique temp dir so escaped paths stay inside
 * that temp dir and are cleaned up with it.
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { Effect, EffectContext, EffectResult, Executor } from "../../src/execution/types.js";

export class RealFsOracle implements Executor {
  readonly id = "real-fs-oracle";
  readonly fidelity = 100;

  constructor(private readonly root: string) {}

  canExecute(effect: Effect): boolean {
    return effect.kind.startsWith("workspace.");
  }

  async execute(effect: Effect, _context: EffectContext): Promise<EffectResult> {
    const raw = "path" in effect && typeof effect.path === "string" ? effect.path : "";
    const target = isAbsolute(raw) ? raw : resolve(this.root, raw);
    try {
      switch (effect.kind) {
        case "workspace.read": {
          const info = await stat(target);
          if (info.isDirectory()) return { ok: false, error: `EISDIR:${raw}` };
          return { ok: true, output: new Uint8Array(await readFile(target)) };
        }
        case "workspace.write": {
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, effect.content);
          return { ok: true };
        }
        case "workspace.delete": {
          const info = await stat(target);
          await rm(target, { recursive: info.isDirectory() });
          return { ok: true };
        }
        case "workspace.list": {
          const info = await stat(target);
          if (!info.isDirectory()) return { ok: false, error: `ENOTDIR:${raw}` };
          return { ok: true, output: (await readdir(target)).sort() };
        }
        default:
          return { ok: false, error: "ESCALATION_REQUIRED" };
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "ERROR";
      return { ok: false, error: `${code}:${raw}` };
    }
  }
}
