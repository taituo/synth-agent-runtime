const LABEL_MANAGED = "synth.openai.dev/managed";
const LABEL_CLASS = "synth.openai.dev/resource-class";
const LABEL_SANDBOX = "synth.openai.dev/sandbox";
function q(value) {
    return value?.trim() || undefined;
}
const DNS1123_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
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
export function assertValidNamespace(namespace) {
    if (namespace.length === 0 || namespace.length > 63 || !DNS1123_LABEL.test(namespace)) {
        throw new Error(`Invalid Kubernetes namespace name: ${JSON.stringify(namespace)} (expected a DNS-1123 label of at most 63 characters)`);
    }
    return namespace;
}
export function sandboxLabels(id, resourceClass) {
    return {
        [LABEL_MANAGED]: "true",
        [LABEL_CLASS]: resourceClass.id,
        [LABEL_SANDBOX]: id,
        "app.kubernetes.io/name": "synth-executor",
        ...(resourceClass.labels ?? {}),
    };
}
export function buildSandboxPod(namespace, podName, sandboxId, resourceClass) {
    const labels = sandboxLabels(sandboxId, resourceClass);
    const tmpMedium = resourceClass.tmpMedium === "Memory" ? "Memory" : undefined;
    const workspaceMedium = resourceClass.workspaceMedium === "Memory" ? "Memory" : undefined;
    const resources = resourceClass.resources;
    const limits = {
        memory: resources.memoryLimit,
        ...(q(resources.cpuLimit) ? { cpu: resources.cpuLimit } : {}),
        ...(q(resources.ephemeralStorageLimit) ? { "ephemeral-storage": resources.ephemeralStorageLimit } : {}),
    };
    const requests = {
        cpu: resources.cpuRequest,
        memory: resources.memoryRequest,
        ...(q(resources.ephemeralStorageRequest) ? { "ephemeral-storage": resources.ephemeralStorageRequest } : {}),
    };
    return {
        apiVersion: "v1",
        kind: "Pod",
        metadata: {
            namespace,
            name: podName,
            labels,
            annotations: resourceClass.annotations ?? {},
        },
        spec: {
            restartPolicy: "Never",
            // An empty string is rejected by the API server ("resource name may not
            // be empty"); omit the key instead of emitting an invalid pod.
            ...(resourceClass.runtimeClassName ? { runtimeClassName: resourceClass.runtimeClassName } : {}),
            activeDeadlineSeconds: resourceClass.activeDeadlineSeconds,
            terminationGracePeriodSeconds: resourceClass.terminationGracePeriodSeconds,
            automountServiceAccountToken: false,
            ...(resourceClass.hostUsers === false ? { hostUsers: false } : {}),
            nodeSelector: resourceClass.nodeSelector,
            tolerations: resourceClass.tolerations,
            securityContext: {
                runAsNonRoot: true,
                runAsUser: 65532,
                runAsGroup: 65532,
                fsGroup: 65532,
                seccompProfile: { type: "RuntimeDefault" },
            },
            volumes: [
                {
                    name: "workspace",
                    emptyDir: {
                        ...(workspaceMedium ? { medium: workspaceMedium } : {}),
                        ...(resourceClass.workspaceSizeLimit ? { sizeLimit: resourceClass.workspaceSizeLimit } : {}),
                    },
                },
                {
                    name: "tmp",
                    emptyDir: {
                        ...(tmpMedium ? { medium: tmpMedium } : {}),
                        ...(resourceClass.tmpSizeLimit ? { sizeLimit: resourceClass.tmpSizeLimit } : {}),
                    },
                },
            ],
            containers: [
                {
                    name: "executor",
                    image: resourceClass.image,
                    imagePullPolicy: "IfNotPresent",
                    command: resourceClass.command,
                    args: resourceClass.args,
                    workingDir: "/workspace",
                    env: Object.entries(resourceClass.env ?? {}).map(([name, value]) => ({ name, value })),
                    resources: { requests, limits },
                    securityContext: {
                        privileged: false,
                        allowPrivilegeEscalation: false,
                        readOnlyRootFilesystem: true,
                        runAsNonRoot: true,
                        runAsUser: 65532,
                        runAsGroup: 65532,
                        capabilities: { drop: ["ALL"] },
                        seccompProfile: { type: "RuntimeDefault" },
                    },
                    volumeMounts: [
                        { name: "workspace", mountPath: "/workspace" },
                        { name: "tmp", mountPath: "/tmp" },
                    ],
                },
            ],
        },
    };
}
function selectorExpression(labels) {
    return { matchLabels: labels ?? {} };
}
export function buildSandboxNetworkPolicy(namespace, name, sandboxId, profile) {
    const ingress = [];
    const egress = [];
    if (profile.controlPlaneNamespaceSelector || profile.controlPlanePodSelector) {
        ingress.push({
            from: [
                {
                    namespaceSelector: selectorExpression(profile.controlPlaneNamespaceSelector),
                    podSelector: selectorExpression(profile.controlPlanePodSelector),
                },
            ],
        });
    }
    if (profile.mode !== "none") {
        egress.push({
            to: [
                {
                    namespaceSelector: selectorExpression(profile.dnsNamespaceSelector),
                    podSelector: selectorExpression(profile.dnsPodSelector),
                },
            ],
            ports: [
                { protocol: "UDP", port: 53 },
                { protocol: "TCP", port: 53 },
            ],
        });
    }
    if (profile.mode === "egress-proxy") {
        egress.push({
            to: [
                {
                    namespaceSelector: selectorExpression(profile.egressProxyNamespaceSelector),
                    podSelector: selectorExpression(profile.egressProxyPodSelector),
                },
            ],
            ports: [{ protocol: "TCP", port: profile.egressProxyPort ?? 3128 }],
        });
    }
    else if (profile.mode === "cluster") {
        // Deliberately cluster-only by default; no 0.0.0.0/0 rule is generated.
        egress.push({ to: [{ namespaceSelector: {} }] });
    }
    return {
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        metadata: { namespace, name },
        spec: {
            podSelector: { matchLabels: { [LABEL_SANDBOX]: sandboxId } },
            policyTypes: ["Ingress", "Egress"],
            ingress,
            egress,
        },
    };
}
export function buildRestrictedNamespace(namespace, labels = {}) {
    return {
        apiVersion: "v1",
        kind: "Namespace",
        metadata: {
            name: namespace,
            labels: {
                "pod-security.kubernetes.io/enforce": "restricted",
                "pod-security.kubernetes.io/audit": "restricted",
                "pod-security.kubernetes.io/warn": "restricted",
                "synth.openai.dev/managed": "true",
                ...labels,
            },
        },
    };
}
export function buildProjectServicePod(namespace, cellId, service) {
    const name = `cell-${cellId}-${service.name}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 63);
    const labels = {
        "synth.openai.dev/managed": "true",
        "synth.openai.dev/project-cell": cellId,
        "synth.openai.dev/project-service": service.name,
        "app.kubernetes.io/name": name,
    };
    return {
        apiVersion: "v1",
        kind: "Pod",
        metadata: { namespace, name, labels },
        spec: {
            restartPolicy: "Always",
            // An empty string is rejected by the API server ("resource name may not
            // be empty"); omit the key instead of emitting an invalid pod. Mirrors
            // buildSandboxPod's runtimeClassName handling.
            ...(service.runtimeClassName ? { runtimeClassName: service.runtimeClassName } : {}),
            automountServiceAccountToken: false,
            securityContext: {
                runAsNonRoot: true,
                ...(service.fsGroup !== undefined ? { fsGroup: service.fsGroup } : {}),
                seccompProfile: { type: "RuntimeDefault" },
            },
            containers: [
                {
                    name: service.name,
                    image: service.image,
                    env: Object.entries(service.env ?? {}).map(([name, value]) => ({ name, value })),
                    ports: (service.ports ?? []).map((containerPort) => ({ containerPort })),
                    resources: {
                        requests: {
                            ...(service.resources?.cpuRequest ? { cpu: service.resources.cpuRequest } : {}),
                            ...(service.resources?.memoryRequest ? { memory: service.resources.memoryRequest } : {}),
                        },
                        limits: {
                            ...(service.resources?.cpuLimit ? { cpu: service.resources.cpuLimit } : {}),
                            ...(service.resources?.memoryLimit ? { memory: service.resources.memoryLimit } : {}),
                        },
                    },
                    securityContext: {
                        privileged: false,
                        allowPrivilegeEscalation: false,
                        runAsNonRoot: true,
                        ...(service.runAsUser !== undefined ? { runAsUser: service.runAsUser } : {}),
                        ...(service.runAsGroup !== undefined ? { runAsGroup: service.runAsGroup } : {}),
                        capabilities: { drop: ["ALL"] },
                        seccompProfile: { type: "RuntimeDefault" },
                    },
                },
            ],
        },
    };
}
export function buildProjectService(namespace, cellId, service) {
    if (!service.ports?.length)
        return undefined;
    const name = `cell-${cellId}-${service.name}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 63);
    return {
        apiVersion: "v1",
        kind: "Service",
        metadata: {
            namespace,
            name,
            labels: { "synth.openai.dev/project-cell": cellId },
        },
        spec: {
            selector: { "synth.openai.dev/project-cell": cellId, "synth.openai.dev/project-service": service.name },
            ports: service.ports.map((port) => ({ name: `p${port}`, port, targetPort: port })),
        },
    };
}
export function buildProjectCellNetworkPolicy(namespace, cellId) {
    return {
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        metadata: { namespace, name: `cell-${cellId}-network`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 63) },
        spec: {
            podSelector: { matchLabels: { "synth.openai.dev/project-cell": cellId } },
            policyTypes: ["Ingress", "Egress"],
            ingress: [
                { from: [{ podSelector: { matchLabels: { "synth.openai.dev/project-cell": cellId } } }] },
            ],
            egress: [
                { to: [{ podSelector: { matchLabels: { "synth.openai.dev/project-cell": cellId } } }] },
                {
                    to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } }, podSelector: { matchLabels: { "k8s-app": "kube-dns" } } }],
                    ports: [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }],
                },
            ],
        },
    };
}
