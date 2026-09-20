/**
 * Shared error vocabulary for workspace effects, so the synthetic rung and the
 * real filesystem return the SAME `error` value for the same condition. Without
 * this the two rungs cannot be diffed: raw errno strings on one side and
 * `undefined` on the other are not comparable.
 */
export const WORKSPACE_NOT_FOUND = "WORKSPACE_NOT_FOUND";
export const WORKSPACE_NOT_DIRECTORY = "WORKSPACE_NOT_DIRECTORY";
export const WORKSPACE_IS_DIRECTORY = "WORKSPACE_IS_DIRECTORY";
/** A path whose `..` segments would leave the workspace root. */
export const WORKSPACE_PATH_ESCAPES = "WORKSPACE_PATH_ESCAPES";
/**
 * True when a path's `..` segments pop above the workspace root. `normalizeRelative`
 * silently clamps these (so the workspace is not escapable), but a silent rewrite
 * of the caller's target path is the worst failure class, so both rungs reject it
 * instead of returning success for a path they did not honour.
 */
export function escapesWorkspace(path) {
    // An absolute path is the same silent-rewrite class: the caller asked for
    // /etc/passwd and would get workspace/etc/passwd. Reject, do not clamp.
    if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path))
        return true;
    let depth = 0;
    for (const raw of path.replace(/\\/g, "/").split("/")) {
        if (!raw || raw === ".")
            continue;
        if (raw === "..") {
            if (depth === 0)
                return true;
            depth--;
        }
        else {
            depth++;
        }
    }
    return false;
}
export function workspaceError(code, path) {
    return `${code}:${path}`;
}
/** Ancestor directories of a normalized relative path (excludes the path). */
export function ancestorPaths(path) {
    const parts = path.replace(/\\/g, "/").split("/").filter((part) => part && part !== ".");
    const ancestors = [];
    for (let i = 1; i < parts.length; i++)
        ancestors.push(parts.slice(0, i).join("/"));
    return ancestors;
}
