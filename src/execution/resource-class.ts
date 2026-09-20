import { EXECUTOR_IMAGE } from "./executor-image.js";

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

const CONTROL_PLANE_NS = { "synth.openai.dev/control-plane": "true" };
const CONTROL_PLANE_POD = { "app.kubernetes.io/name": "synth-control-plane" };
const KUBE_SYSTEM_NS = { "kubernetes.io/metadata.name": "kube-system" };
const DNS_PODS = { "k8s-app": "kube-dns" };

function restrictedNetwork(mode: NetworkMode): NetworkPolicyProfile {
  return {
    mode,
    controlPlaneNamespaceSelector: CONTROL_PLANE_NS,
    controlPlanePodSelector: CONTROL_PLANE_POD,
    dnsNamespaceSelector: KUBE_SYSTEM_NS,
    dnsPodSelector: DNS_PODS,
    ...(mode === "egress-proxy"
      ? {
          egressProxyNamespaceSelector: { "synth.openai.dev/egress": "true" },
          egressProxyPodSelector: { "app.kubernetes.io/name": "synth-egress-proxy" },
          egressProxyPort: 3128,
        }
      : {}),
  };
}

/** Opinionated defaults. The image is pinned by digest in `executor-image.ts`. */
export const DEFAULT_KUBERNETES_RESOURCE_CLASSES: readonly KubernetesResourceClass[] = [
  {
    id: "sandbox-small",
    fidelity: 20,
    image: EXECUTOR_IMAGE,
    runtimeClassName: "gvisor",
    resources: {
      cpuRequest: "250m",
      cpuLimit: "2",
      memoryRequest: "512Mi",
      memoryLimit: "4Gi",
      ephemeralStorageRequest: "1Gi",
      ephemeralStorageLimit: "8Gi",
    },
    workspaceMedium: "Node",
    workspaceSizeLimit: "8Gi",
    tmpMedium: "Memory",
    tmpSizeLimit: "512Mi",
    activeDeadlineSeconds: 30 * 60,
    terminationGracePeriodSeconds: 5,
    network: restrictedNetwork("egress-proxy"),
    command: ["/bin/sh", "-lc"],
    args: ["trap : TERM INT; sleep infinity & wait"],
    warmPool: { minReady: 2, maxReady: 4, maxTotal: 12, idleTtlMs: 10 * 60_000 },
  },
  {
    id: "sandbox-medium",
    fidelity: 30,
    image: EXECUTOR_IMAGE,
    runtimeClassName: "gvisor",
    resources: {
      cpuRequest: "1",
      cpuLimit: "4",
      memoryRequest: "2Gi",
      memoryLimit: "8Gi",
      ephemeralStorageRequest: "2Gi",
      ephemeralStorageLimit: "20Gi",
    },
    workspaceMedium: "Node",
    workspaceSizeLimit: "20Gi",
    tmpMedium: "Memory",
    tmpSizeLimit: "1Gi",
    activeDeadlineSeconds: 45 * 60,
    terminationGracePeriodSeconds: 5,
    network: restrictedNetwork("egress-proxy"),
    command: ["/bin/sh", "-lc"],
    args: ["trap : TERM INT; sleep infinity & wait"],
    warmPool: { minReady: 1, maxReady: 3, maxTotal: 8, idleTtlMs: 10 * 60_000 },
  },
  {
    id: "sandbox-heavy",
    fidelity: 40,
    image: EXECUTOR_IMAGE,
    runtimeClassName: "gvisor",
    resources: {
      cpuRequest: "2",
      cpuLimit: "8",
      memoryRequest: "4Gi",
      memoryLimit: "16Gi",
      ephemeralStorageRequest: "4Gi",
      ephemeralStorageLimit: "40Gi",
    },
    workspaceMedium: "Node",
    workspaceSizeLimit: "40Gi",
    tmpMedium: "Node",
    tmpSizeLimit: "8Gi",
    activeDeadlineSeconds: 60 * 60,
    terminationGracePeriodSeconds: 10,
    network: restrictedNetwork("egress-proxy"),
    command: ["/bin/sh", "-lc"],
    args: ["trap : TERM INT; sleep infinity & wait"],
    warmPool: { minReady: 0, maxReady: 2, maxTotal: 4, idleTtlMs: 5 * 60_000 },
  },
  {
    id: "project-cell",
    fidelity: 50,
    image: EXECUTOR_IMAGE,
    runtimeClassName: "gvisor",
    resources: {
      cpuRequest: "1",
      cpuLimit: "6",
      memoryRequest: "2Gi",
      memoryLimit: "12Gi",
      ephemeralStorageRequest: "5Gi",
      ephemeralStorageLimit: "50Gi",
    },
    workspaceMedium: "Node",
    workspaceSizeLimit: "50Gi",
    tmpMedium: "Node",
    tmpSizeLimit: "10Gi",
    activeDeadlineSeconds: 6 * 60 * 60,
    terminationGracePeriodSeconds: 15,
    network: restrictedNetwork("cluster"),
    command: ["/bin/sh", "-lc"],
    args: ["trap : TERM INT; sleep infinity & wait"],
  },
] as const;

export function resourceClassMap(classes: readonly KubernetesResourceClass[]): Map<string, KubernetesResourceClass> {
  return new Map(classes.map((entry) => [entry.id, entry]));
}
