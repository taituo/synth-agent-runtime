/**
 * Harvest the agent's patch from git, not from the workspace.
 *
 * `git add -A` + `git diff --cached <baseRef>` captures new, modified and
 * deleted files that git knows about. Harvesting the workspace mirror instead
 * would drag sandbox-only side effects such as `node_modules` into the scored
 * patch, so those paths are excluded explicitly — even when the repo does not
 * gitignore them. The patch is scored against a fresh clone of `baseRepoDir`
 * (the bugged commit), so nothing outside the patch can influence the score.
 */
import type { EffectRunner } from "./tools.js";

export const NODE_MODULES_EXCLUDES: readonly string[] = [":(exclude)node_modules", ":(exclude)*/node_modules"];

export interface HarvestOptions {
  /** Repo root the git commands run in (local path or sandbox workspace path). */
  repoDir: string;
  /** Ref the harvested diff is taken against. Defaults to HEAD (the bugged commit). */
  baseRef?: string;
}

/** Stage everything except `node_modules`, then emit the staged diff. */
export async function harvestPatch(runner: EffectRunner, options: HarvestOptions): Promise<string> {
  const baseRef = options.baseRef ?? "HEAD";
  // The pathspec magic contains parentheses and a wildcard; quote it because the
  // runner executes through a shell.
  const excludes = NODE_MODULES_EXCLUDES.map((pathspec) => `'${pathspec}'`).join(" ");
  const add = await runner.exec(`git add -A -- . ${excludes}`, { cwd: options.repoDir });
  if (add.code !== 0) throw new Error(`git add failed (exit ${add.code}): ${add.stderr || add.stdout}`);
  const diff = await runner.exec(`git diff --cached ${baseRef}`, { cwd: options.repoDir });
  if (diff.code !== 0) throw new Error(`git diff failed (exit ${diff.code}): ${diff.stderr || diff.stdout}`);
  return diff.stdout;
}
