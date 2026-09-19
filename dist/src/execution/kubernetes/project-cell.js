import { spawn } from "node:child_process";
import { buildProjectCellNetworkPolicy, buildProjectService, buildProjectServicePod, buildRestrictedNamespace } from "./manifests.js";
export class KubectlObjectController {
    #kubectl;
    #context;
    constructor(options = {}) {
        this.#kubectl = options.kubectlBin ?? "kubectl";
        this.#context = options.context;
    }
    async apply(object) {
        const result = await this.#run(["apply", "-f", "-"], JSON.stringify(object), 60_000);
        if (result.code !== 0)
            throw new Error(result.stderr || "kubectl apply failed");
    }
    async waitPodReady(namespace, podName, timeoutMs = 120_000) {
        const result = await this.#run(["wait", "--for=condition=Ready", `pod/${podName}`, "-n", namespace, `--timeout=${Math.ceil(timeoutMs / 1000)}s`], undefined, timeoutMs + 5_000);
        if (result.code !== 0)
            throw new Error(result.stderr || `Pod ${podName} not ready`);
    }
    async deleteNamespace(namespace) {
        const result = await this.#run(["delete", "namespace", namespace, "--ignore-not-found=true", "--wait=false"], undefined, 30_000);
        if (result.code !== 0)
            throw new Error(result.stderr || `Failed to delete namespace ${namespace}`);
    }
    #run(args, input, timeoutMs = 60_000) {
        return new Promise((resolve, reject) => {
            const base = this.#context ? ["--context", this.#context] : [];
            const child = spawn(this.#kubectl, [...base, ...args], { stdio: ["pipe", "pipe", "pipe"] });
            const stdout = [];
            const stderr = [];
            const timer = setTimeout(() => {
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
                resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
            });
            child.stdin.end(input);
        });
    }
}
/**
 * A ProjectCell is a longer-lived isolated namespace containing one executor and
 * optional project services (database, Redis, browser, etc.). Agents lease it;
 * they never receive Kubernetes credentials.
 */
export class ProjectCellManager {
    #controller;
    #sandboxBackend;
    #classes;
    #cells = new Map();
    constructor(controller, sandboxBackend, classes) {
        this.#controller = controller;
        this.#sandboxBackend = sandboxBackend;
        this.#classes = new Map(classes.map((entry) => [entry.id, entry]));
    }
    async ensure(spec) {
        const existing = this.#cells.get(spec.id);
        if (existing)
            return existing.handle;
        const namespace = spec.namespace ?? `synth-cell-${spec.id}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 63);
        await this.#controller.apply(buildRestrictedNamespace(namespace, { "synth.openai.dev/project-cell": spec.id }));
        await this.#controller.apply(buildProjectCellNetworkPolicy(namespace, spec.id));
        const serviceNames = [];
        for (const service of spec.services ?? []) {
            const pod = buildProjectServicePod(namespace, spec.id, service);
            await this.#controller.apply(pod);
            const podName = String(pod.metadata.name);
            await this.#controller.waitPodReady(namespace, podName);
            const serviceObject = buildProjectService(namespace, spec.id, service);
            if (serviceObject) {
                await this.#controller.apply(serviceObject);
                serviceNames.push(String(serviceObject.metadata.name));
            }
        }
        const classId = spec.resourceClassId ?? "project-cell";
        const resourceClass = this.#classes.get(classId);
        if (!resourceClass)
            throw new Error(`Unknown project cell resource class: ${classId}`);
        const executor = await this.#sandboxBackend.create({ ...resourceClass, network: { ...resourceClass.network, mode: "none" } }, {
            namespace,
            labels: { "synth.openai.dev/project-cell": spec.id },
        });
        const handle = {
            id: spec.id,
            namespace,
            executor,
            serviceNames,
            createdAt: Date.now(),
        };
        this.#cells.set(spec.id, { handle, leases: 0, lastUsedAt: Date.now(), idleTtlMs: spec.idleTtlMs ?? 30 * 60_000 });
        return handle;
    }
    async lease(spec) {
        const handle = await this.ensure(spec);
        const record = this.#cells.get(spec.id);
        record.leases++;
        record.lastUsedAt = Date.now();
        let released = false;
        return {
            handle,
            release: async () => {
                if (released)
                    return;
                released = true;
                record.leases = Math.max(0, record.leases - 1);
                record.lastUsedAt = Date.now();
            },
        };
    }
    async reap(now = Date.now()) {
        for (const [id, record] of this.#cells) {
            if (record.leases > 0 || now - record.lastUsedAt < record.idleTtlMs)
                continue;
            await this.destroy(id);
        }
    }
    async destroy(id) {
        const record = this.#cells.get(id);
        if (!record)
            return;
        this.#cells.delete(id);
        await this.#sandboxBackend.destroy(record.handle.executor).catch(() => { });
        await this.#controller.deleteNamespace(record.handle.namespace).catch(() => { });
    }
}
