/**
 * Safely moves the visible sparse workspace into a physical sandbox without
 * giving repository credentials to the sandbox. The trusted control plane reads
 * the TreeSource; only file bytes enter the untrusted Pod.
 */
export class WorkspaceSynchronizer {
    #backend;
    #maxFiles;
    #maxBytes;
    #initializeGitBaseline;
    constructor(backend, options = {}) {
        this.#backend = backend;
        this.#maxFiles = options.maxFiles ?? 20_000;
        this.#maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
        this.#initializeGitBaseline = options.initializeGitBaseline ?? true;
    }
    async materialize(workspace, sandbox) {
        let files = 0;
        let bytes = 0;
        if (workspace.source?.listFiles) {
            for await (const path of workspace.source.listFiles()) {
                const content = await workspace.source.readFile(path);
                files++;
                bytes += content.byteLength;
                this.#checkLimits(files, bytes, "base workspace");
                await this.#backend.writeFile(sandbox, path, content);
            }
        }
        // Materialize any overlay changes (writes on top of the base tree that
        // MemoryWorkspace hasn't committed anywhere else) BEFORE the Git baseline
        // is committed, so they are part of what "baseline" means. If the
        // baseline were committed first, an overlay-only file would be untracked
        // in the sandbox: `git status` would never report deleting it, and
        // syncBack() would have no way to see that deletion.
        for (const change of await workspace.diff()) {
            if (change.kind === "delete") {
                await this.#backend.removePath(sandbox, change.path);
            }
            else {
                const content = change.content ?? new Uint8Array();
                files++;
                bytes += content.byteLength;
                this.#checkLimits(files, bytes, "workspace overlay");
                await this.#backend.writeFile(sandbox, change.path, content);
            }
        }
        if (this.#initializeGitBaseline) {
            const init = await this.#backend.exec(sandbox, {
                command: "git init -q && git config user.name synth-runtime && git config user.email synth@invalid && git add -A && git commit -q --allow-empty -m synthetic-base",
                timeoutMs: 120_000,
                // The sandbox's /workspace emptyDir is root-owned while the pod runs
                // as a non-root uid by design; git refuses to operate in a directory
                // it doesn't consider safely owned ("detected dubious ownership")
                // unless told otherwise. Setting this via env avoids writing any
                // config file, which matters because the rest of the pod's root
                // filesystem is read-only.
                env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "/workspace" },
            });
            if (init.exitCode !== 0) {
                throw new Error(`Failed to initialize sandbox Git baseline: ${init.stderr || init.stdout}`);
            }
        }
    }
    async syncBack(workspace, sandbox) {
        const before = await workspace.snapshot();
        let files = 0;
        let bytes = 0;
        try {
            for (const change of await this.#backend.listGitChanges(sandbox)) {
                files++;
                this.#checkLimits(files, bytes, "sandbox changes");
                if (change.deleted) {
                    workspace.delete(change.path);
                    continue;
                }
                const content = await this.#backend.readFile(sandbox, change.path);
                bytes += content.byteLength;
                this.#checkLimits(files, bytes, "sandbox changes");
                workspace.write(change.path, content);
            }
        }
        catch (error) {
            // A failed or over-limit import must not leave half of a physical
            // executor's filesystem changes visible in the logical RAM workspace.
            workspace.restore(before);
            throw error;
        }
    }
    #checkLimits(files, bytes, phase) {
        if (files > this.#maxFiles)
            throw new Error(`${phase} exceeds sync file limit (${this.#maxFiles})`);
        if (bytes > this.#maxBytes)
            throw new Error(`${phase} exceeds sync byte limit (${this.#maxBytes})`);
    }
}
