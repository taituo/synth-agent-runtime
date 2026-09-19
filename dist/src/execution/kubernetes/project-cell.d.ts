import type { KubernetesResourceClass } from "../resource-class.js";
import type { KubernetesObject, ProjectCellHandle, ProjectCellSpec, SandboxBackend } from "./types.js";
export interface KubernetesObjectController {
    apply(object: KubernetesObject): Promise<void>;
    waitPodReady(namespace: string, podName: string, timeoutMs?: number): Promise<void>;
    deleteNamespace(namespace: string): Promise<void>;
}
export interface KubectlObjectControllerOptions {
    kubectlBin?: string;
    context?: string;
}
export declare class KubectlObjectController implements KubernetesObjectController {
    #private;
    constructor(options?: KubectlObjectControllerOptions);
    apply(object: KubernetesObject): Promise<void>;
    waitPodReady(namespace: string, podName: string, timeoutMs?: number): Promise<void>;
    deleteNamespace(namespace: string): Promise<void>;
}
/**
 * A ProjectCell is a longer-lived isolated namespace containing one executor and
 * optional project services (database, Redis, browser, etc.). Agents lease it;
 * they never receive Kubernetes credentials.
 */
export declare class ProjectCellManager {
    #private;
    constructor(controller: KubernetesObjectController, sandboxBackend: SandboxBackend, classes: readonly KubernetesResourceClass[]);
    ensure(spec: ProjectCellSpec): Promise<ProjectCellHandle>;
    lease(spec: ProjectCellSpec): Promise<{
        handle: ProjectCellHandle;
        release(): Promise<void>;
    }>;
    reap(now?: number): Promise<void>;
    destroy(id: string): Promise<void>;
}
