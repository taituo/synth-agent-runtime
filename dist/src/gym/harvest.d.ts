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
export declare const NODE_MODULES_EXCLUDES: readonly string[];
export interface HarvestOptions {
    /** Repo root the git commands run in (local path or sandbox workspace path). */
    repoDir: string;
    /** Ref the harvested diff is taken against. Defaults to HEAD (the bugged commit). */
    baseRef?: string;
}
/** Stage everything except `node_modules`, then emit the staged diff. */
export declare function harvestPatch(runner: EffectRunner, options: HarvestOptions): Promise<string>;
