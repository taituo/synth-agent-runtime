const CONTROL_PLANE_NS = { "synth.openai.dev/control-plane": "true" };
const CONTROL_PLANE_POD = { "app.kubernetes.io/name": "synth-control-plane" };
const KUBE_SYSTEM_NS = { "kubernetes.io/metadata.name": "kube-system" };
const DNS_PODS = { "k8s-app": "kube-dns" };
function restrictedNetwork(mode) {
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
/** Opinionated defaults. Images are placeholders and should be pinned by digest in production. */
export const DEFAULT_KUBERNETES_RESOURCE_CLASSES = [
    {
        id: "sandbox-small",
        fidelity: 20,
        image: "ghcr.io/example/synth-executor:latest",
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
        image: "ghcr.io/example/synth-executor:latest",
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
        image: "ghcr.io/example/synth-executor:latest",
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
        image: "ghcr.io/example/synth-executor:latest",
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
];
export function resourceClassMap(classes) {
    return new Map(classes.map((entry) => [entry.id, entry]));
}
