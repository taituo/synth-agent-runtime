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
export type SymlinkTargetResolution = {
    ok: true;
    resolved: string;
} | {
    ok: false;
    reason: "escapes";
    linkPath: string;
    target: string;
} | {
    ok: false;
    reason: "cycle";
    linkPath: string;
} | {
    ok: false;
    reason: "too-deep";
    linkPath: string;
};
export interface ResolveSymlinkOptions {
    /** Maximum links to follow before declaring the chain too deep. */
    maxDepth?: number;
}
/**
 * Resolve one link's target relative to the link's parent, lexically. Returns
 * `escapes: true` when an absolute target or a `..` climbs above the root.
 */
export declare function resolveLinkTarget(linkPath: string, target: string): {
    resolved?: string;
    escapes: boolean;
};
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
export declare function resolveSymlinkTarget(linkPath: string, target: string, readLink?: (path: string) => string | undefined, options?: ResolveSymlinkOptions): SymlinkTargetResolution;
