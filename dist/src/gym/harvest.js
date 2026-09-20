export const NODE_MODULES_EXCLUDES = [":(exclude)node_modules", ":(exclude)*/node_modules"];
/** Stage everything except `node_modules`, then emit the staged diff. */
export async function harvestPatch(runner, options) {
    const baseRef = options.baseRef ?? "HEAD";
    // The pathspec magic contains parentheses and a wildcard; quote it because the
    // runner executes through a shell.
    const excludes = NODE_MODULES_EXCLUDES.map((pathspec) => `'${pathspec}'`).join(" ");
    const add = await runner.exec(`git add -A -- . ${excludes}`, { cwd: options.repoDir });
    if (add.code !== 0)
        throw new Error(`git add failed (exit ${add.code}): ${add.stderr || add.stdout}`);
    const diff = await runner.exec(`git diff --cached ${baseRef}`, { cwd: options.repoDir });
    if (diff.code !== 0)
        throw new Error(`git diff failed (exit ${diff.code}): ${diff.stderr || diff.stdout}`);
    return diff.stdout;
}
