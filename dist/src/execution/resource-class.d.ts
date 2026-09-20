export type WorkspaceMedium = "Memory" | "Node";
export type NetworkMode = "none" | "egress-proxy" | "cluster";
export interface ResourceQuantitySet {
    cpuRequest: string;
    cpuLimit?: string;
    memoryRequest: string;
    memoryLimit: string;
    ephemeralStorageRequest?: string;
    ephemeralStorageLimit?: string;
}
export interface WarmPoolPolicy {
    minReady: number;
    maxReady: number;
    maxTotal: number;
    idleTtlMs: number;
}
export interface NetworkPolicyProfile {
    mode: NetworkMode;
    /** Namespace label selector for the trusted control plane that may exec/sync. */
    controlPlaneNamespaceSelector?: Record<string, string>;
    /** Pod label selector for the trusted control plane. */
    controlPlanePodSelector?: Record<string, string>;
    /** DNS namespace/pod selectors. */
    dnsNamespaceSelector?: Record<string, string>;
    dnsPodSelector?: Record<string, string>;
    /** Optional egress proxy destination. Only used when mode=egress-proxy. */
    egressProxyNamespaceSelector?: Record<string, string>;
    egressProxyPodSelector?: Record<string, string>;
    egressProxyPort?: number;
}
export interface KubernetesResourceClass {
    id: string;
    fidelity: number;
    image: string;
    runtimeClassName?: string;
    resources: ResourceQuantitySet;
    workspaceMedium: WorkspaceMedium;
    workspaceSizeLimit?: string;
    tmpMedium?: WorkspaceMedium;
    tmpSizeLimit?: string;
    activeDeadlineSeconds: number;
    terminationGracePeriodSeconds: number;
    network: NetworkPolicyProfile;
    warmPool?: WarmPoolPolicy;
    nodeSelector?: Record<string, string>;
    tolerations?: Array<Record<string, unknown>>;
    annotations?: Record<string, string>;
    labels?: Record<string, string>;
    /** Optional command. Image entrypoint is used when omitted. */
    command?: string[];
    args?: string[];
    /** Extra environment values that are safe for the untrusted workload to read. */
    env?: Record<string, string>;
    /** If true, use Kubernetes user namespaces when supported by the cluster. */
    hostUsers?: boolean;
}
export interface ExecutionPolicy {
    preferredClass?: string;
    allowedClasses?: string[];
    minFidelity?: number;
    allowEscalation?: boolean;
    projectCellId?: string;
}
/** Opinionated defaults. The image is pinned by digest in `executor-image.ts`. */
export declare const DEFAULT_KUBERNETES_RESOURCE_CLASSES: readonly KubernetesResourceClass[];
export declare function resourceClassMap(classes: readonly KubernetesResourceClass[]): Map<string, KubernetesResourceClass>;
