import type { KubernetesResourceClass, NetworkPolicyProfile } from "../resource-class.js";
import type { KubernetesObject, ProjectCellService } from "./types.js";
export declare function sandboxLabels(id: string, resourceClass: KubernetesResourceClass): Record<string, string>;
export declare function buildSandboxPod(namespace: string, podName: string, sandboxId: string, resourceClass: KubernetesResourceClass): KubernetesObject;
export declare function buildSandboxNetworkPolicy(namespace: string, name: string, sandboxId: string, profile: NetworkPolicyProfile): KubernetesObject;
export declare function buildRestrictedNamespace(namespace: string, labels?: Record<string, string>): KubernetesObject;
export declare function buildProjectServicePod(namespace: string, cellId: string, service: ProjectCellService): KubernetesObject;
export declare function buildProjectService(namespace: string, cellId: string, service: ProjectCellService): KubernetesObject | undefined;
export declare function buildProjectCellNetworkPolicy(namespace: string, cellId: string): KubernetesObject;
