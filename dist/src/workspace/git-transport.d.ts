export interface GitTransportOptions {
    gitBin?: string;
}
/** Shell command the sandbox runs (cwd `/workspace`) to emit a base64 bundle. */
export declare function bundleExportCommand(ref?: string): string;
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
