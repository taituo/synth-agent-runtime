export interface GitTransportOptions {
    gitBin?: string;
}
/** Shell command the sandbox runs (cwd `/workspace`) to emit a base64 bundle. */
export declare function bundleExportCommand(ref?: string): string;
/**
 * Artifact-egress mechanism 3: a patch as a change proposal. `git diff` out as
 * text — small, reviewable, and mergeable by a human. Records file modes, so a
 * symlink or an executable bit survives the round trip.
 */
export declare function patchExportCommand(baseRef?: string): string;
/** True when `patchText` applies cleanly to the repo's current state. */
export declare function applyPatchCheck(patchText: string, repoDir: string, options?: GitTransportOptions): Promise<boolean>;
/** Apply `patchText` to the repo's working tree. */
export declare function applyPatch(patchText: string, repoDir: string, options?: GitTransportOptions): Promise<void>;
/** Decode the base64 stdout of {@link bundleExportCommand} into bundle bytes. */
export declare function decodeBundleBase64(stdout: string): Buffer;
/** Ingest a bundle file into a runtime-controlled bare repo; returns the commit. */
export declare function ingestBundle(bundlePath: string, bareDir: string, options?: GitTransportOptions): Promise<string>;
/** The tree hash of a commit, as git computes it (independent of our code). */
export declare function treeDigest(bareDir: string, commit: string, options?: GitTransportOptions): Promise<string>;
export interface TreeEntry {
    mode: string;
    type: string;
    objectId: string;
    path: string;
}
/** `git ls-tree -r -z` parsed into entries (mode preserved, including 120000). */
export declare function listTreeEntries(bareDir: string, commit: string, options?: GitTransportOptions): Promise<TreeEntry[]>;
