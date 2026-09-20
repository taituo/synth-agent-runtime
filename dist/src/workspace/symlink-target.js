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
    if (isAbsoluteTarget(target))
        return { ok: false, reason: "escapes", linkPath, target };
    const visited = new Set();
    // Resolve target from the link's parent, following EVERY component that is
    // itself a symlink — not only the leaf. A path like `d/secret.txt` where `d`
    // is a symlink to outside the workspace escapes on a real filesystem, and
    // checking only the leaf would miss it.
    let dir = segments(linkPath).slice(0, -1);
    let pending = target.replace(/\\/g, "/").split("/");
    let followed = 0;
    while (pending.length > 0) {
        const raw = pending.shift();
        if (!raw || raw === ".")
            continue;
        if (raw === "..") {
            if (dir.length === 0)
                return { ok: false, reason: "escapes", linkPath, target };
            dir = dir.slice(0, -1);
            continue;
        }
        const candidate = [...dir, raw].join("/");
        const linkTarget = readLink?.(candidate);
        if (linkTarget === undefined) {
            dir = [...dir, raw]; // a regular component (or a dangling leaf): keep it
            continue;
        }
        if (visited.has(candidate))
            return { ok: false, reason: "cycle", linkPath: candidate };
        visited.add(candidate);
        followed++;
        if (followed > maxDepth)
            return { ok: false, reason: "too-deep", linkPath: candidate };
        const step = resolveLinkTarget(candidate, linkTarget);
        if (step.escapes || step.resolved === undefined) {
            return { ok: false, reason: "escapes", linkPath: candidate, target: linkTarget };
        }
        // The link's target is workspace-relative; resolve it from the root and
        // continue with whatever components remained after this one.
        dir = [];
        pending = [...segments(step.resolved), ...pending];
    }
    return { ok: true, resolved: dir.join("/") };
}
