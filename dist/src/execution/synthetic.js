import { normalizeRelative } from "../workspace/source.js";
import { WORKSPACE_IS_DIRECTORY, WORKSPACE_NOT_DIRECTORY, WORKSPACE_NOT_FOUND, WORKSPACE_PATH_ESCAPES, ancestorPaths, escapesWorkspace, workspaceError, } from "./workspace-errors.js";
/** Lowest-fidelity executor: deterministic workspace operations only. */
export class SyntheticExecutor {
    blobStore;
    id = "synthetic";
    fidelity = 0;
    #workspaces;
    constructor(workspaces, blobStore) {
        this.blobStore = blobStore;
        this.#workspaces = workspaces;
    }
    canExecute(effect) {
        return effect.kind.startsWith("workspace.") || effect.kind === "process.exec";
    }
    async execute(effect, context) {
        const workspace = this.#workspaces.get(context.workspaceId);
        if (!workspace)
            return { ok: false, error: `Unknown workspace ${context.workspaceId}` };
        if (!effect.kind.startsWith("workspace."))
            return { ok: false, error: "ESCALATION_REQUIRED" };
        const rawPath = "path" in effect && typeof effect.path === "string" ? effect.path : "";
        // A path whose `..` leaves the workspace is rejected rather than silently
        // clamped to a different in-workspace path.
        if (escapesWorkspace(rawPath))
            return { ok: false, error: workspaceError(WORKSPACE_PATH_ESCAPES, rawPath) };
        const p = normalizeRelative(rawPath);
        // Any operation under a path that is a file is ENOTDIR on a real filesystem.
        if (p) {
            for (const ancestor of ancestorPaths(p)) {
                const info = await workspace.stat(ancestor);
                if (info?.kind === "file")
                    return { ok: false, error: workspaceError(WORKSPACE_NOT_DIRECTORY, p) };
            }
        }
        switch (effect.kind) {
            case "workspace.export": {
                // The receipt carries a reference; the bytes go to the blob store.
                if (!this.blobStore)
                    return { ok: false, error: "ARTIFACT_STORE_REQUIRED" };
                const artifact = await workspace.exportArtifact(this.blobStore);
                return { ok: true, artifact: artifact.ref, output: { digest: artifact.ref.digest, size: artifact.ref.size } };
            }
            case "workspace.read": {
                if (!p)
                    return { ok: false, error: workspaceError(WORKSPACE_IS_DIRECTORY, p) };
                const info = await workspace.stat(p);
                if (!info)
                    return { ok: false, error: workspaceError(WORKSPACE_NOT_FOUND, p) };
                if (info.kind === "directory")
                    return { ok: false, error: workspaceError(WORKSPACE_IS_DIRECTORY, p) };
                return { ok: true, output: await workspace.read(p) };
            }
            case "workspace.write": {
                if (!p)
                    return { ok: false, error: workspaceError(WORKSPACE_IS_DIRECTORY, p) };
                // Writing a file where a directory exists is EISDIR on a real filesystem.
                const existing = await workspace.stat(p);
                if (existing?.kind === "directory")
                    return { ok: false, error: workspaceError(WORKSPACE_IS_DIRECTORY, p) };
                workspace.write(p, effect.content);
                return { ok: true };
            }
            case "workspace.delete": {
                if (!p)
                    return { ok: false, error: workspaceError(WORKSPACE_IS_DIRECTORY, p) };
                const info = await workspace.stat(p);
                if (!info)
                    return { ok: false, error: workspaceError(WORKSPACE_NOT_FOUND, p) };
                workspace.delete(p);
                return { ok: true };
            }
            case "workspace.symlink": {
                if (!p)
                    return { ok: false, error: workspaceError(WORKSPACE_IS_DIRECTORY, p) };
                try {
                    workspace.symlink(p, effect.target);
                    return { ok: true };
                }
                catch {
                    // The workspace validates the target; an escaping target is rejected
                    // with the shared error rather than a silently-rewritten link.
                    return { ok: false, error: workspaceError(WORKSPACE_PATH_ESCAPES, p) };
                }
            }
            case "workspace.list": {
                if (!p)
                    return { ok: true, output: await workspace.listDir("") };
                const info = await workspace.stat(p);
                if (!info)
                    return { ok: false, error: workspaceError(WORKSPACE_NOT_FOUND, p) };
                if (info.kind !== "directory")
                    return { ok: false, error: workspaceError(WORKSPACE_NOT_DIRECTORY, p) };
                return { ok: true, output: await workspace.listDir(p) };
            }
            case "process.exec":
                return { ok: false, error: "ESCALATION_REQUIRED" };
            default:
                return { ok: false, error: "ESCALATION_REQUIRED" };
        }
    }
}
