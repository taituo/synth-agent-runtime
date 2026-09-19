import type { KubernetesResourceClass } from "../resource-class.js";

export type KubernetesObject = Record<string, unknown>;

export interface SandboxIdentity {
  id: string;
  namespace: string;
  podName: string;
  resourceClassId: string;
  createdAt: number;
}

export interface SandboxExecRequest {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface SandboxExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export interface SandboxBackend {
  create(resourceClass: KubernetesResourceClass, options?: { labels?: Record<string, string>; namespace?: string }): Promise<SandboxIdentity>;
  destroy(sandbox: SandboxIdentity): Promise<void>;
  reset(sandbox: SandboxIdentity): Promise<void>;
  /** Optional post-reset proof. Returning false forces warm-pool destruction. */
  verifyReset?(sandbox: SandboxIdentity): Promise<boolean>;
  exec(sandbox: SandboxIdentity, request: SandboxExecRequest): Promise<SandboxExecResult>;
  writeFile(sandbox: SandboxIdentity, path: string, content: Uint8Array): Promise<void>;
  readFile(sandbox: SandboxIdentity, path: string): Promise<Uint8Array>;
  removePath(sandbox: SandboxIdentity, path: string): Promise<void>;
  listGitChanges(sandbox: SandboxIdentity): Promise<Array<{ path: string; deleted: boolean }>>;
}

export interface WarmSandboxLease {
  sandbox: SandboxIdentity;
  resourceClass: KubernetesResourceClass;
  release(options?: { destroy?: boolean }): Promise<void>;
}

export interface ProjectCellService {
  name: string;
  image: string;
  ports?: number[];
  env?: Record<string, string>;
  resources?: {
    cpuRequest?: string;
    cpuLimit?: string;
    memoryRequest?: string;
    memoryLimit?: string;
  };
}

export interface ProjectCellSpec {
  id: string;
  namespace?: string;
  resourceClassId?: string;
  services?: ProjectCellService[];
  labels?: Record<string, string>;
  idleTtlMs?: number;
}

export interface ProjectCellHandle {
  id: string;
  namespace: string;
  executor: SandboxIdentity;
  serviceNames: string[];
  createdAt: number;
}
