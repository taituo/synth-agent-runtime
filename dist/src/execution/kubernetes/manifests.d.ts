import type { KubernetesResourceClass, NetworkPolicyProfile } from "../resource-class.js";
import type { KubernetesObject, ProjectCellService } from "./types.js";
/**
 * Validate a caller-supplied Kubernetes namespace name.
 *
 * Derived names (pods, services, network policies) are sanitized by
 * construction, so an invalid character there is rewritten. A namespace the
 * caller names is different: it is referenced elsewhere, so silently
 * rewriting it could target a namespace other than the one intended. Reject
 * invalid names up front with a clear error instead of passing them to
 * `kubectl`, where the failure is an opaque API rejection.
 */
export declare function assertValidNamespace(namespace: string): string;
export declare function sandboxLabels(id: string, resourceClass: KubernetesResourceClass): Record<string, string>;
export declare function buildSandboxPod(namespace: string, podName: string, sandboxId: string, resourceClass: KubernetesResourceClass): KubernetesObject;
/** A Kubernetes ownerReference: the pod a per-pod object belongs to. */
export interface SandboxOwnerReference {
    apiVersion: string;
    kind: string;
    name: string;
    uid: string;
}
export declare function buildSandboxNetworkPolicy(namespace: string, name: string, sandboxId: string, profile: NetworkPolicyProfile, owner?: SandboxOwnerReference): KubernetesObject;
export declare function buildRestrictedNamespace(namespace: string, labels?: Record<string, string>): KubernetesObject;
export declare function buildProjectServicePod(namespace: string, cellId: string, service: ProjectCellService): KubernetesObject;
export declare function buildProjectService(namespace: string, cellId: string, service: ProjectCellService): KubernetesObject | undefined;
export declare function buildProjectCellNetworkPolicy(namespace: string, cellId: string): KubernetesObject;
