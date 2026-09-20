/**
 * Symlink target resolution policy (review follow-up 3).
 *
 * A symlink's target is resolved relative to the LINK'S OWN PARENT directory,
 * then the resolved workspace-relative path is checked for containment. This is
 * deliberately not `escapesWorkspace(target)`: that inspects the raw target, so
 * it accepts `/etc/passwd` (absolute) and rejects `../other-dir/pm` — which is a
 * real symlink in the pinned commander fixture whose target resolves *inside*
 * the workspace. Resolution must happen first; the check is on the result.
 *
 * Pure and dependency-free so it can run in the workflow/executor sandbox.
 */
const DEFAULT_MAX_DEPTH = 16;
function segments(path) {
    return path.replace(/\\/g, "/").split("/").filter((part) => part && part !== ".");
}
function isAbsoluteTarget(target) {
    return target.startsWith("/") || /^[A-Za-z]:[\\/]/.test(target);
}
/**
 * Resolve one link's target relative to the link's parent, lexically. Returns
 * `escapes: true` when an absolute target or a `..` climbs above the root.
 */
export function resolveLinkTarget(linkPath, target) {
    if (isAbsoluteTarget(target))
        return { escapes: true };
    const parts = segments(linkPath);
    parts.pop(); // the link's own name; base is its parent directory
    let depth = parts.length;
    for (const raw of target.replace(/\\/g, "/").split("/")) {
        if (!raw || raw === ".")
            continue;
        if (raw === "..") {
            if (depth === 0)
                return { escapes: true };
            depth--;
            parts.pop();
        }
        else {
            depth++;
            parts.push(raw);
        }
    }
    return { resolved: parts.join("/"), escapes: false };
}
/**
 * Resolve a symlink target, optionally following a chain via `readLink` (which
 * returns the target of `path` if `path` is itself a symlink, else undefined).
 *
 * - A target that resolves outside the workspace is rejected (`escapes`).
 * - A chain longer than `maxDepth` is `too-deep`; a chain that revisits a
 *   resolved path is `cycle`.
 * - A dangling link (its target does not exist, or is not itself a link) is a
 *   VALID link: it is kept with its resolved path, never resolved-and-failed.
 */
export function resolveSymlinkTarget(linkPath, target, readLink, options = {}) {
    const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    const visited = new Set();
    let currentLink = segments(linkPath).join("/");
    let currentTarget = target;
    for (let followed = 0; followed < maxDepth; followed++) {
        const step = resolveLinkTarget(currentLink, currentTarget);
        if (step.escapes || step.resolved === undefined) {
            return { ok: false, reason: "escapes", linkPath: currentLink, target: currentTarget };
        }
        const resolved = step.resolved;
        if (visited.has(resolved))
            return { ok: false, reason: "cycle", linkPath: resolved };
        visited.add(resolved);
        const nextTarget = readLink?.(resolved);
        if (nextTarget === undefined)
            return { ok: true, resolved }; // dangling or terminal: keep it
        currentLink = resolved;
        currentTarget = nextTarget;
    }
    return { ok: false, reason: "too-deep", linkPath: currentLink };
}
