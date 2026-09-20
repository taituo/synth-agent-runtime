/**
 * Build the sandbox-backed `EffectRunner` for the gym's `runner=sandbox` mode.
 *
 * The plain arm and the durable arm must differ in exactly one variable —
 * durability — so when the sandbox mode is selected, both drive the same tools
 * over a gVisor/Kubernetes sandbox. NOTE: the recorded fault matrix did NOT use
 * this runner; every committed row ran `runner=local` (host, no isolation) for
 * both arms. This path is the isolated option, proven live by
 * `sandbox-live.ts`; it is not what produced the matrix numbers.
 *
 * This mirrors `integrations/kubernetes/mixed-chain.ts`: a `MemoryWorkspace`
 * backed by a local checkout, a `SyntheticExecutor` for workspace effects and a
 * `KubernetesExecutor` for `process.exec`, fronted by an `ExecutionBroker` with
 * per-effect receipts.
 *
 * The `LocalDirSource` is a read-only `TreeSource` over the materialized bugged
 * checkout; it is what the synchronizer materializes into the Pod and commits as
 * the git baseline harvest diffs against.
 */
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { DEFAULT_KUBERNETES_RESOURCE_CLASSES, ExecutionBroker, KubernetesExecutor, KubectlSandboxBackend, LocalRuntimeStateStore, MemoryWorkspace, SyntheticExecutor, brokerEffectRunner, } from "../../src/index.js";
const SKIP_DIRS = new Set([".git", "node_modules"]);
class LocalDirSource {
    name;
    #root;
    constructor(root) {
        this.#root = root;
        this.name = `local-dir:${root}`;
    }
    async revision() {
        return { kind: "unknown", ref: this.#root };
    }
    async stat(path) {
        const full = join(this.#root, path);
        try {
            const info = await lstat(full);
            const kind = info.isSymbolicLink() ? "symlink" : info.isDirectory() ? "directory" : "file";
            return { path, kind, size: info.size, mtimeMs: info.mtimeMs };
        }
        catch {
            return undefined;
        }
    }
    async listDir(path) {
        const full = join(this.#root, path);
        const entries = await readdir(full, { withFileTypes: true });
        const out = [];
        for (const entry of entries) {
            if (SKIP_DIRS.has(entry.name))
                continue;
            const info = await this.stat(path ? `${path}/${entry.name}` : entry.name);
            if (info)
                out.push(info);
        }
        return out;
    }
    async readFile(path) {
        return readFile(join(this.#root, path));
    }
    async *listFiles() {
        const root = this.#root;
        const walk = async function* (dir) {
            const full = join(root, dir);
            for (const entry of await readdir(full, { withFileTypes: true })) {
                if (SKIP_DIRS.has(entry.name))
                    continue;
                const rel = dir ? `${dir}/${entry.name}` : entry.name;
                if (entry.isDirectory())
                    yield* walk(rel);
                else
                    yield rel;
            }
        };
        yield* walk("");
    }
}
/** Construct the broker-backed runner. Throws if the image is missing. */
export async function buildSandboxRunner(options) {
    if (!options.image)
        throw new Error("buildSandboxRunner requires a node+git image pinned by digest (the Pod runs run_visible_test)");
    const base = DEFAULT_KUBERNETES_RESOURCE_CLASSES.find((entry) => entry.id === "sandbox-small");
    if (!base)
        throw new Error("sandbox-small resource class missing");
    const resourceClass = {
        ...base,
        image: options.image,
        ...(options.runtimeClassName ? { runtimeClassName: options.runtimeClassName } : {}),
        warmPool: undefined,
    };
    const backend = new KubectlSandboxBackend({
        ...(options.namespace ? { namespace: options.namespace } : {}),
        ...(options.kubectlContext ? { context: options.kubectlContext } : {}),
    });
    const workspace = new MemoryWorkspace({ source: new LocalDirSource(options.repoDir) });
    const workspaces = new Map([[workspace.id, workspace]]);
    const synthetic = new SyntheticExecutor(workspaces);
    const real = new KubernetesExecutor({ resourceClass, backend, workspaces });
    const broker = new ExecutionBroker([synthetic, real], new LocalRuntimeStateStore());
    const context = {
        agentId: (options.agentId ?? "gym-agent"),
        workspaceId: workspace.id,
    };
    const raw = brokerEffectRunner(broker, context, "sandbox");
    const repoRoot = options.repoDir;
    // `runGymAttempt` passes host absolute paths (`task.repoDir`) as `cwd` for its
    // git commands (harvest, checkpoint restore). Inside the pod the workspace
    // root IS the repo, so translate that path to the workspace root; any path
    // under it becomes workspace-relative. Without this the pod runs
    // `cd /workspace/tmp/<host path>` and every git command fails.
    const translatedCwd = (cwd) => {
        if (cwd === undefined)
            return undefined;
        if (cwd === repoRoot)
            return undefined;
        const rel = relative(repoRoot, cwd);
        if (rel !== "" && !rel.startsWith("..") && !rel.split(sep).includes(".."))
            return rel;
        return cwd;
    };
    const runner = {
        ...raw,
        async exec(command, options_ = {}) {
            const cwd = translatedCwd(options_.cwd);
            return raw.exec(command, cwd === undefined ? { ...options_, cwd: undefined } : { ...options_, cwd });
        },
    };
    return {
        runner,
        async close() {
            // Each broker exec is one-shot: the KubernetesExecutor destroys its Pod.
        },
    };
}
