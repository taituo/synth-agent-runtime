import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, posix } from "node:path";
import type { KubernetesResourceClass } from "../resource-class.js";
import { assertValidNamespace, buildRestrictedNamespace, buildSandboxNetworkPolicy, buildSandboxPod } from "./manifests.js";
import type { KubernetesObject, SandboxBackend, SandboxExecRequest, SandboxExecResult, SandboxIdentity } from "./types.js";

export interface KubectlSandboxBackendOptions {
  namespace?: string;
  kubectlBin?: string;
  context?: string;
  createTimeoutMs?: number;
  defaultExecTimeoutMs?: number;
}

interface CommandResult {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
}

function safeWorkspacePath(input: string): string {
  const normalized = posix.normalize(`/${input.replace(/\\/g, "/")}`).replace(/^\/+/, "");
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`Invalid workspace path: ${input}`);
  }
  return `/workspace/${normalized}`;
}

function shQuote(input: string): string {
  return `'${input.replace(/'/g, `'"'"'`)}'`;
}

function envArgs(env: Record<string, string> | undefined): string[] {
  if (!env) return [];
  return Object.entries(env).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment key: ${key}`);
    return `${key}=${value}`;
  });
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
export function deletePodAndPolicyArgs(podName: string, namespace: string): string[] {
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
export class KubectlSandboxBackend implements SandboxBackend {
  readonly #namespace: string;
  readonly #kubectl: string;
  readonly #context?: string;
  readonly #createTimeoutMs: number;
  readonly #defaultExecTimeoutMs: number;
  #namespaceReady?: Promise<void>;

  constructor(options: KubectlSandboxBackendOptions = {}) {
    this.#namespace = options.namespace === undefined ? "synth-sandboxes" : assertValidNamespace(options.namespace);
    this.#kubectl = options.kubectlBin ?? "kubectl";
    this.#context = options.context;
    this.#createTimeoutMs = options.createTimeoutMs ?? 120_000;
    this.#defaultExecTimeoutMs = options.defaultExecTimeoutMs ?? 10 * 60_000;
  }

  async create(resourceClass: KubernetesResourceClass, options: { labels?: Record<string, string>; namespace?: string } = {}): Promise<SandboxIdentity> {
    const namespace = options.namespace === undefined ? this.#namespace : assertValidNamespace(options.namespace);
    if (namespace === this.#namespace) await this.#ensureNamespace();
    else await this.#apply(buildRestrictedNamespace(namespace));
    const id = randomUUID();
    const podName = `synth-${resourceClass.id}-${id.slice(0, 8)}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const pod = buildSandboxPod(namespace, podName, id, {
      ...resourceClass,
      labels: { ...(resourceClass.labels ?? {}), ...(options.labels ?? {}) },
    });
    const network = buildSandboxNetworkPolicy(namespace, `${podName}-network`, id, resourceClass.network);
    await this.#apply(pod);
    try {
      await this.#apply(network);
      const wait = await this.#run([
        "wait",
        "--for=condition=Ready",
        `pod/${podName}`,
        "-n",
        namespace,
        `--timeout=${Math.ceil(this.#createTimeoutMs / 1000)}s`,
      ], undefined, this.#createTimeoutMs + 5_000);
      if (wait.code !== 0) throw new Error(wait.stderr.toString("utf8") || `Pod ${podName} did not become Ready`);
    } catch (error) {
      await this.#deletePodAndPolicy(podName, namespace).catch(() => {});
      throw error;
    }
    return { id, namespace, podName, resourceClassId: resourceClass.id, createdAt: Date.now() };
  }

  async destroy(sandbox: SandboxIdentity): Promise<void> {
    await this.#deletePodAndPolicy(sandbox.podName, sandbox.namespace);
  }

  async reset(sandbox: SandboxIdentity): Promise<void> {
    const result = await this.exec(sandbox, {
      command: "find /workspace -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; find /tmp -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +",
      timeoutMs: 60_000,
    });
    if (result.exitCode !== 0) throw new Error(`Sandbox reset failed: ${result.stderr || result.stdout}`);
  }

  async verifyReset(sandbox: SandboxIdentity): Promise<boolean> {
    const result = await this.exec(sandbox, {
      command: "test -z \"$(find /workspace /tmp -mindepth 1 -print -quit 2>/dev/null)\"",
      timeoutMs: 15_000,
    });
    return result.exitCode === 0;
  }

  async exec(sandbox: SandboxIdentity, request: SandboxExecRequest): Promise<SandboxExecResult> {
    const cwd = request.cwd ? safeWorkspacePath(request.cwd) : "/workspace";
    // /workspace is an emptyDir owned by root and group-owned by the pod's
    // fsGroup; the pod runs as a non-root uid, so git refuses to operate in it
    // ("detected dubious ownership"). The workspace is materialized by the
    // trusted control plane, so mark it safe via env (no config file is written,
    // which matters because the pod's root filesystem is read-only). This covers
    // every exec, including an agent's own `git` commands, not just the
    // baseline init that already set it.
    const env: Record<string, string> = {
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

  async writeFile(sandbox: SandboxIdentity, path: string, content: Uint8Array): Promise<void> {
    const full = safeWorkspacePath(path);
    const parent = dirname(full).replace(/\\/g, "/");
    const script = `mkdir -p ${shQuote(parent)} && base64 -d > ${shQuote(full)}`;
    const input = Buffer.from(content).toString("base64");
    const result = await this.#run(
      ["exec", "-i", "-n", sandbox.namespace, sandbox.podName, "--", "sh", "-lc", script],
      input,
      this.#defaultExecTimeoutMs,
    );
    if (result.code !== 0) throw new Error(`writeFile(${path}) failed: ${result.stderr.toString("utf8")}`);
  }

  async readFile(sandbox: SandboxIdentity, path: string): Promise<Uint8Array> {
    const full = safeWorkspacePath(path);
    const script = `base64 ${shQuote(full)} | tr -d '\\n'`;
    const result = await this.#run(
      ["exec", "-n", sandbox.namespace, sandbox.podName, "--", "sh", "-lc", script],
      undefined,
      this.#defaultExecTimeoutMs,
    );
    if (result.code !== 0) throw new Error(`readFile(${path}) failed: ${result.stderr.toString("utf8")}`);
    return new Uint8Array(Buffer.from(result.stdout.toString("utf8").trim(), "base64"));
  }

  async removePath(sandbox: SandboxIdentity, path: string): Promise<void> {
    const full = safeWorkspacePath(path);
    const result = await this.#run(
      ["exec", "-n", sandbox.namespace, sandbox.podName, "--", "rm", "-rf", "--", full],
      undefined,
      this.#defaultExecTimeoutMs,
    );
    if (result.code !== 0) throw new Error(`removePath(${path}) failed: ${result.stderr.toString("utf8")}`);
  }

  async writeSymlink(sandbox: SandboxIdentity, path: string, target: string): Promise<void> {
    const full = safeWorkspacePath(path);
    const parent = dirname(full).replace(/\\/g, "/");
    const script = `mkdir -p ${shQuote(parent)} && ln -sfn ${shQuote(target)} ${shQuote(full)}`;
    const result = await this.#run(
      ["exec", "-n", sandbox.namespace, sandbox.podName, "--", "sh", "-lc", script],
      undefined,
      this.#defaultExecTimeoutMs,
    );
    if (result.code !== 0) throw new Error(`writeSymlink(${path}) failed: ${result.stderr.toString("utf8")}`);
  }

  async readSymlink(sandbox: SandboxIdentity, path: string): Promise<string> {
    const full = safeWorkspacePath(path);
    const result = await this.#run(
      ["exec", "-n", sandbox.namespace, sandbox.podName, "--", "readlink", full],
      undefined,
      this.#defaultExecTimeoutMs,
    );
    if (result.code !== 0) throw new Error(`readSymlink(${path}) failed: ${result.stderr.toString("utf8")}`);
    return result.stdout.toString("utf8").trim();
  }

  async listGitChanges(sandbox: SandboxIdentity): Promise<Array<{ path: string; deleted: boolean; symlink?: boolean }>> {
    // One exec: emit each change as four NUL-separated fields (path, status,
    // kind, target). `git status -z` uses NUL terminators already; the shell
    // loop adds whether the working-tree entry is a symlink and its target, so a
    // mode-120000 change is not silently flattened into regular bytes.
    const script = [
      "cd /workspace || exit 1",
      "git -c safe.directory=/workspace status --porcelain=v1 -z --untracked-files=all --no-renames |",
      "while IFS= read -r -d '' entry; do",
      '  status=$(printf %s "$entry" | cut -c1-2)',
      '  path=$(printf %s "$entry" | cut -c4-)',
      '  if [ -L "$path" ]; then kind=L; target=$(readlink "./$path"); else kind=F; target=""; fi',
      `  printf '%s\\0%s\\0%s\\0%s\\0' "$path" "$status" "$kind" "$target"`,
      "done",
    ].join("\n");
    const result = await this.#run(
      ["exec", "-n", sandbox.namespace, sandbox.podName, "--", "sh", "-lc", script],
      undefined,
      this.#defaultExecTimeoutMs,
    );
    if (result.code !== 0) {
      throw new Error(`git status failed in sandbox ${sandbox.id}: ${result.stderr.toString("utf8") || result.stdout.toString("utf8")}`);
    }
    const tokens = result.stdout.toString("utf8").split("\0");
    const out: Array<{ path: string; deleted: boolean; symlink?: boolean }> = [];
    for (let i = 0; i + 3 < tokens.length; i += 4) {
      const path = tokens[i]!;
      const status = tokens[i + 1]!;
      const kind = tokens[i + 2]!;
      if (!path || path.startsWith(".git/")) continue;
      out.push({ path, deleted: status.includes("D"), symlink: kind === "L" });
    }
    return out;
  }

  async #ensureNamespace(): Promise<void> {
    this.#namespaceReady ??= this.#apply(buildRestrictedNamespace(this.#namespace));
    await this.#namespaceReady;
  }

  async #apply(object: KubernetesObject): Promise<void> {
    const result = await this.#run(["apply", "-f", "-"], JSON.stringify(object), 60_000);
    if (result.code !== 0) throw new Error(`kubectl apply failed: ${result.stderr.toString("utf8")}`);
  }

  async #deletePodAndPolicy(podName: string, namespace = this.#namespace): Promise<void> {
    const result = await this.#run(deletePodAndPolicyArgs(podName, namespace), undefined, 30_000);
    if (result.code !== 0) throw new Error(`kubectl delete failed: ${result.stderr.toString("utf8")}`);
  }

  #baseArgs(): string[] {
    return this.#context ? ["--context", this.#context] : [];
  }

  #run(args: string[], input?: string | Uint8Array, timeoutMs = 60_000): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.#kubectl, [...this.#baseArgs(), ...args], { stdio: ["pipe", "pipe", "pipe"] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
      }, timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), timedOut });
      });
      if (input !== undefined) child.stdin.end(input);
      else child.stdin.end();
    });
  }
}
