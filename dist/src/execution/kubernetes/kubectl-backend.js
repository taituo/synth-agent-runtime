import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, posix } from "node:path";
import { assertValidNamespace, buildRestrictedNamespace, buildSandboxNetworkPolicy, buildSandboxPod } from "./manifests.js";
function safeWorkspacePath(input) {
    const normalized = posix.normalize(`/${input.replace(/\\/g, "/")}`).replace(/^\/+/, "");
    if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
        throw new Error(`Invalid workspace path: ${input}`);
    }
    return `/workspace/${normalized}`;
}
function shQuote(input) {
    return `'${input.replace(/'/g, `'"'"'`)}'`;
}
function envArgs(env) {
    if (!env)
        return [];
    return Object.entries(env).map(([key, value]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
            throw new Error(`Invalid environment key: ${key}`);
        return `${key}=${value}`;
    });
}
/** Env var the git-change loop is passed through, so no shell quoting is needed. */
export const GIT_CHANGES_LOOP_ENV = "SYNTH_GIT_CHANGES_LOOP";
/**
 * The inner loop that turns `git status -z` into one NUL-separated record per
 * change: path, status, kind, target.
 *
 * `read -d` is a bash/busybox-ash builtin. Debian's `/bin/sh` is dash and rejects
 * it ("Illegal option -d"), which made the loop emit nothing and `syncBack`
 * silently import zero changes. That is invisible with an alpine executor and
 * breaks under the repo's own `node:22-bookworm-slim` executor, so the loop is
 * run under a shell that supports `read -d` (bash when present, else `sh`).
 */
export const GIT_CHANGES_LOOP = [
    "while IFS= read -r -d '' entry; do",
    '  status=$(printf %s "$entry" | cut -c1-2)',
    '  path=$(printf %s "$entry" | cut -c4-)',
    '  if [ -L "$path" ]; then kind=L; target=$(readlink "./$path"); else kind=F; target=""; fi',
    `  printf '%s\\0%s\\0%s\\0%s\\0' "$path" "$status" "$kind" "$target"`,
    "done",
].join("\n");
/**
 * The full command run in the pod. `workspace` is parameterized so the exact
 * script can be exercised in a local test against a real repo.
 */
export function gitChangesCommand(workspace = "/workspace") {
    return [
        `cd ${shQuote(workspace)} || exit 1`,
        "if command -v bash >/dev/null 2>&1; then SB=bash; else SB=sh; fi",
        `git -c safe.directory=${shQuote(workspace)} status --porcelain=v1 -z --untracked-files=all --no-renames | $SB -c "$${GIT_CHANGES_LOOP_ENV}"`,
    ].join("\n");
}
/**
 * `kubectl delete pod X networkpolicy Y` does NOT mean "delete pod X and
 * networkpolicy Y" — kubectl reads the first positional argument after the
 * verb as the resource TYPE, and every following non-flag token as another
 * NAME of that same type. It tries to delete pods named X, "networkpolicy",
 * and Y; the real NetworkPolicy object is never targeted. With
 * `--ignore-not-found`, the bogus lookups fail silently and the exit code is
 * 0, so the leak goes unnoticed. The `type/name` form deletes heterogeneous
 * resources correctly in one call.
 */
export function deletePodAndPolicyArgs(podName, namespace) {
    return [
        "delete",
        `pod/${podName}`,
        `networkpolicy/${podName}-network`,
        "-n",
        namespace,
        "--ignore-not-found=true",
        "--wait=false",
    ];
}
/**
 * Concrete Kubernetes backend implemented only with kubectl.
 *
 * The trusted control plane owns kubectl credentials. The untrusted executor Pod
 * receives no ServiceAccount token and therefore cannot control Kubernetes.
 */
export class KubectlSandboxBackend {
    #namespace;
    #kubectl;
    #context;
    #createTimeoutMs;
    #defaultExecTimeoutMs;
    #namespaceReady;
    constructor(options = {}) {
        this.#namespace = options.namespace === undefined ? "synth-sandboxes" : assertValidNamespace(options.namespace);
        this.#kubectl = options.kubectlBin ?? "kubectl";
        this.#context = options.context;
        this.#createTimeoutMs = options.createTimeoutMs ?? 120_000;
        this.#defaultExecTimeoutMs = options.defaultExecTimeoutMs ?? 10 * 60_000;
    }
    async create(resourceClass, options = {}) {
        const namespace = options.namespace === undefined ? this.#namespace : assertValidNamespace(options.namespace);
        if (namespace === this.#namespace)
            await this.#ensureNamespace();
        else
            await this.#apply(buildRestrictedNamespace(namespace));
        const id = randomUUID();
        const podName = `synth-${resourceClass.id}-${id.slice(0, 8)}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
        const pod = buildSandboxPod(namespace, podName, id, {
            ...resourceClass,
            labels: { ...(resourceClass.labels ?? {}), ...(options.labels ?? {}) },
        });
        await this.#apply(pod);
        try {
            // Construct the policy only after the Pod exists, owned by it: Kubernetes
            // then reaps the policy whenever the pod is deleted by any path, so a pod
            // removed out of band cannot orphan its policy.
            const owner = await this.#podOwner(podName, namespace);
            await this.#apply(buildSandboxNetworkPolicy(namespace, `${podName}-network`, id, resourceClass.network, owner));
            const wait = await this.#run([
                "wait",
                "--for=condition=Ready",
                `pod/${podName}`,
                "-n",
                namespace,
                `--timeout=${Math.ceil(this.#createTimeoutMs / 1000)}s`,
            ], undefined, this.#createTimeoutMs + 5_000);
            if (wait.code !== 0)
                throw new Error(wait.stderr.toString("utf8") || `Pod ${podName} did not become Ready`);
        }
        catch (error) {
            await this.#deletePodAndPolicy(podName, namespace).catch(() => { });
            throw error;
        }
        return { id, namespace, podName, resourceClassId: resourceClass.id, createdAt: Date.now() };
    }
    async destroy(sandbox) {
        await this.#deletePodAndPolicy(sandbox.podName, sandbox.namespace);
    }
    async reset(sandbox) {
        const result = await this.exec(sandbox, {
            command: "find /workspace -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; find /tmp -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +",
            timeoutMs: 60_000,
        });
        if (result.exitCode !== 0)
            throw new Error(`Sandbox reset failed: ${result.stderr || result.stdout}`);
    }
    async verifyReset(sandbox) {
        const result = await this.exec(sandbox, {
            command: "test -z \"$(find /workspace /tmp -mindepth 1 -print -quit 2>/dev/null)\"",
            timeoutMs: 15_000,
        });
        return result.exitCode === 0;
    }
    async exec(sandbox, request) {
        const cwd = request.cwd ? safeWorkspacePath(request.cwd) : "/workspace";
        // /workspace is an emptyDir owned by root and group-owned by the pod's
        // fsGroup; the pod runs as a non-root uid, so git refuses to operate in it
        // ("detected dubious ownership"). The workspace is materialized by the
        // trusted control plane, so mark it safe via env (no config file is written,
        // which matters because the pod's root filesystem is read-only). This covers
        // every exec, including an agent's own `git` commands, not just the
        // baseline init that already set it.
        const env = {
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "safe.directory",
            GIT_CONFIG_VALUE_0: "/workspace",
            ...(request.env ?? {}),
        };
        const args = [
            "exec",
            "-n",
            sandbox.namespace,
            sandbox.podName,
            "--",
            "env",
            ...envArgs(env),
            "sh",
            "-lc",
            `cd ${shQuote(cwd)} && ${request.command}`,
        ];
        const result = await this.#run(args, undefined, request.timeoutMs ?? this.#defaultExecTimeoutMs);
        return {
            exitCode: result.timedOut ? 124 : result.code,
            stdout: result.stdout.toString("utf8"),
            stderr: result.stderr.toString("utf8"),
            ...(result.timedOut ? { timedOut: true } : {}),
        };
    }
    async writeFile(sandbox, path, content) {
        const full = safeWorkspacePath(path);
        const parent = dirname(full).replace(/\\/g, "/");
        const script = `mkdir -p ${shQuote(parent)} && base64 -d > ${shQuote(full)}`;
        const input = Buffer.from(content).toString("base64");
        const result = await this.#run(["exec", "-i", "-n", sandbox.namespace, sandbox.podName, "--", "sh", "-lc", script], input, this.#defaultExecTimeoutMs);
        if (result.code !== 0)
            throw new Error(`writeFile(${path}) failed: ${result.stderr.toString("utf8")}`);
    }
    async readFile(sandbox, path) {
        const full = safeWorkspacePath(path);
        const script = `base64 ${shQuote(full)} | tr -d '\\n'`;
        const result = await this.#run(["exec", "-n", sandbox.namespace, sandbox.podName, "--", "sh", "-lc", script], undefined, this.#defaultExecTimeoutMs);
        if (result.code !== 0)
            throw new Error(`readFile(${path}) failed: ${result.stderr.toString("utf8")}`);
        return new Uint8Array(Buffer.from(result.stdout.toString("utf8").trim(), "base64"));
    }
    async removePath(sandbox, path) {
        const full = safeWorkspacePath(path);
        const result = await this.#run(["exec", "-n", sandbox.namespace, sandbox.podName, "--", "rm", "-rf", "--", full], undefined, this.#defaultExecTimeoutMs);
        if (result.code !== 0)
            throw new Error(`removePath(${path}) failed: ${result.stderr.toString("utf8")}`);
    }
    async writeSymlink(sandbox, path, target) {
        const full = safeWorkspacePath(path);
        const parent = dirname(full).replace(/\\/g, "/");
        const script = `mkdir -p ${shQuote(parent)} && ln -sfn ${shQuote(target)} ${shQuote(full)}`;
        const result = await this.#run(["exec", "-n", sandbox.namespace, sandbox.podName, "--", "sh", "-lc", script], undefined, this.#defaultExecTimeoutMs);
        if (result.code !== 0)
            throw new Error(`writeSymlink(${path}) failed: ${result.stderr.toString("utf8")}`);
    }
    async readSymlink(sandbox, path) {
        const full = safeWorkspacePath(path);
        const result = await this.#run(["exec", "-n", sandbox.namespace, sandbox.podName, "--", "readlink", full], undefined, this.#defaultExecTimeoutMs);
        if (result.code !== 0)
            throw new Error(`readSymlink(${path}) failed: ${result.stderr.toString("utf8")}`);
        return result.stdout.toString("utf8").trim();
    }
    async listGitChanges(sandbox) {
        // One exec: emit each change as four NUL-separated fields (path, status,
        // kind, target). `git status -z` uses NUL terminators already; the shell
        // loop adds whether the working-tree entry is a symlink and its target, so a
        // mode-120000 change is not silently flattened into regular bytes. The loop
        // is passed via env and run under bash/ash because `read -d` is not POSIX
        // (see GIT_CHANGES_LOOP).
        const result = await this.#run([
            "exec",
            "-n",
            sandbox.namespace,
            sandbox.podName,
            "--",
            "env",
            `${GIT_CHANGES_LOOP_ENV}=${GIT_CHANGES_LOOP}`,
            "sh",
            "-lc",
            gitChangesCommand(),
        ], undefined, this.#defaultExecTimeoutMs);
        if (result.code !== 0) {
            throw new Error(`git status failed in sandbox ${sandbox.id}: ${result.stderr.toString("utf8") || result.stdout.toString("utf8")}`);
        }
        const tokens = result.stdout.toString("utf8").split("\0");
        const out = [];
        for (let i = 0; i + 3 < tokens.length; i += 4) {
            const path = tokens[i];
            const status = tokens[i + 1];
            const kind = tokens[i + 2];
            if (!path || path.startsWith(".git/"))
                continue;
            out.push({ path, deleted: status.includes("D"), symlink: kind === "L" });
        }
        return out;
    }
    async #ensureNamespace() {
        this.#namespaceReady ??= this.#apply(buildRestrictedNamespace(this.#namespace));
        await this.#namespaceReady;
    }
    async #apply(object) {
        const result = await this.#run(["apply", "-f", "-"], JSON.stringify(object), 60_000);
        if (result.code !== 0)
            throw new Error(`kubectl apply failed: ${result.stderr.toString("utf8")}`);
    }
    async #deletePodAndPolicy(podName, namespace = this.#namespace) {
        const result = await this.#run(deletePodAndPolicyArgs(podName, namespace), undefined, 30_000);
        if (result.code !== 0)
            throw new Error(`kubectl delete failed: ${result.stderr.toString("utf8")}`);
    }
    /**
     * The Pod's ownerReference for its NetworkPolicy. Reading the uid back is one
     * extra `kubectl get` per sandbox create; it is what lets Kubernetes reap the
     * policy with the pod (see buildSandboxNetworkPolicy). Refuse to create an
     * unowned policy rather than fall back to the leak.
     */
    async #podOwner(podName, namespace) {
        const result = await this.#run(["get", "pod", podName, "-n", namespace, "-o", "jsonpath={.metadata.uid}"], undefined, 30_000);
        const uid = result.stdout.toString("utf8").trim();
        if (result.code !== 0 || !uid) {
            throw new Error(`kubectl get pod/${podName} uid failed: ${result.stderr.toString("utf8") || "no uid"}`);
        }
        return { apiVersion: "v1", kind: "Pod", name: podName, uid };
    }
    #baseArgs() {
        return this.#context ? ["--context", this.#context] : [];
    }
    #run(args, input, timeoutMs = 60_000) {
        return new Promise((resolve, reject) => {
            const child = spawn(this.#kubectl, [...this.#baseArgs(), ...args], { stdio: ["pipe", "pipe", "pipe"] });
            const stdout = [];
            const stderr = [];
            let timedOut = false;
            const timer = setTimeout(() => {
                timedOut = true;
                child.kill("SIGTERM");
                setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
            }, timeoutMs);
            child.stdout.on("data", (chunk) => stdout.push(chunk));
            child.stderr.on("data", (chunk) => stderr.push(chunk));
            child.once("error", (error) => {
                clearTimeout(timer);
                reject(error);
            });
            child.once("close", (code) => {
                clearTimeout(timer);
                resolve({ code: code ?? 1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), timedOut });
            });
            if (input !== undefined)
                child.stdin.end(input);
            else
                child.stdin.end();
        });
    }
}
