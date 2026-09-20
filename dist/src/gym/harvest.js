export const NODE_MODULES_EXCLUDES = [":(exclude)node_modules", ":(exclude)*/node_modules"];
/** Stage everything except `node_modules`, then emit the staged diff. */
export async function harvestPatch(runner, options) {
    const baseRef = options.baseRef ?? "HEAD";
    // The pathspec magic contains parentheses and a wildcard; quote it because the
    // runner executes through a shell.
    const excludes = NODE_MODULES_EXCLUDES.map((pathspec) => `'${pathspec}'`).join(" ");
    // ONE exec for add+diff. The staging index lives in the process that runs
    // `git add`, and the sandbox runner runs each exec in a fresh one-shot pod
    // with a fresh index; splitting the two made `git diff --cached` always empty
    // in the pod. `git add` prints nothing on success, so stdout is the diff.
    const result = await runner.exec(`git add -A -- . ${excludes} && git diff --cached ${baseRef}`, { cwd: options.repoDir });
    if (result.code !== 0)
        throw new Error(`git harvest failed (exit ${result.code}): ${result.stderr || result.stdout}`);
    return result.stdout;
}
