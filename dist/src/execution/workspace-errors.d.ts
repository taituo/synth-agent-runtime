/**
 * Shared error vocabulary for workspace effects, so the synthetic rung and the
 * real filesystem return the SAME `error` value for the same condition. Without
 * this the two rungs cannot be diffed: raw errno strings on one side and
 * `undefined` on the other are not comparable.
 */
export declare const WORKSPACE_NOT_FOUND = "WORKSPACE_NOT_FOUND";
export declare const WORKSPACE_NOT_DIRECTORY = "WORKSPACE_NOT_DIRECTORY";
export declare const WORKSPACE_IS_DIRECTORY = "WORKSPACE_IS_DIRECTORY";
/** A path whose `..` segments would leave the workspace root. */
export declare const WORKSPACE_PATH_ESCAPES = "WORKSPACE_PATH_ESCAPES";
/**
 * True when a path's `..` segments pop above the workspace root. `normalizeRelative`
 * silently clamps these (so the workspace is not escapable), but a silent rewrite
 * of the caller's target path is the worst failure class, so both rungs reject it
 * instead of returning success for a path they did not honour.
 */
export declare function escapesWorkspace(path: string): boolean;
export declare function workspaceError(code: string, path: string): string;
/** Ancestor directories of a normalized relative path (excludes the path). */
export declare function ancestorPaths(path: string): string[];
