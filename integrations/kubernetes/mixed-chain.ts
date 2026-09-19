/**
 * Track 5 real proof: MIXED chains through the ExecutionBroker.
 *
 * The broker picks a rung PER EFFECT, so one chain can be partly synthetic
 * (MemoryWorkspace, fidelity 0) and partly real (gVisor, higher fidelity). The
 * sharp question is whether the two rungs share workspace state. The code
 * answers YES: KubernetesExecutor materializes the MemoryWorkspace into the
 * sandbox before exec and syncs git changes back after. This script pins that
 * answer down in both directions, including deletes and unusual filenames, and
 * checks per-effect receipts, ordering and policy mid-chain.
 *
 * Exit codes: 0 = every mixed-chain expectation held; 1 = an expectation
 * failed; 2 = SKIPPED (sandbox not configured). A skip is a distinct outcome,
 * never reported as `ok:true`. The image must be git-capable and pinned by
 * digest (e.g. `alpine/git`), because the synchronizer commits a git baseline.
 *
 *   SYNTH_EXECUTOR_IMAGE=docker.io/alpine/git@sha256:0b5f57d2... \
 *   SYNTH_RUNTIME_CLASS=gvisor SYNTH_KUBERNETES_NAMESPACE=synth-audit-gvisor \
 *   npm run mixed-chain   # from integrations/kubernetes
 */
import {
  DEFAULT_KUBERNETES_RESOURCE_CLASSES,
  ExecutionBroker,
  KubectlSandboxBackend,
  KubernetesExecutor,
  LocalRuntimeStateStore,
  MemoryWorkspace,
  SyntheticExecutor,
  type Effect,
  type EffectContext,
  type KubernetesResourceClass,
} from "../../src/index.js";

const image = process.env.SYNTH_EXECUTOR_IMAGE;
const namespace = process.env.SYNTH_KUBERNETES_NAMESPACE ?? "synth-audit-gvisor";
const context = process.env.SYNTH_KUBECTL_CONTEXT;
if (!image) {
  console.error(
    JSON.stringify({
      skipped: true,
      reason: "SYNTH_EXECUTOR_IMAGE not set; must be a git-capable image pinned by digest (e.g. alpine/git@sha256:...)",
    }),
  );
  process.exit(2);
}

const base = DEFAULT_KUBERNETES_RESOURCE_CLASSES.find((entry) => entry.id === "sandbox-small");
if (!base) throw new Error("sandbox-small resource class missing");
const resourceClass: KubernetesResourceClass = {
  ...base,
  image,
  runtimeClassName: process.env.SYNTH_RUNTIME_CLASS ?? base.runtimeClassName,
  warmPool: undefined,
};

const backend = new KubectlSandboxBackend({ namespace, context });
const workspace = new MemoryWorkspace();
const synthetic = new SyntheticExecutor(new Map([[workspace.id, workspace]]));
const real = new KubernetesExecutor({ resourceClass, backend, workspaces: new Map([[workspace.id, workspace]]) });
const state = new LocalRuntimeStateStore();
const broker = new ExecutionBroker([synthetic, real], state);
const ctx = (agentId: string, policy?: EffectContext["executionPolicy"]): EffectContext => ({
  agentId: agentId as never,
  workspaceId: workspace.id,
  ...(policy ? { executionPolicy: policy } : {}),
});

const text = (value: unknown) => {
  const output = value as { stdout?: string } | undefined;
  return output?.stdout ?? "";
};

const results: Record<string, unknown> = {};
let ok = true;

// --- Shared state, both directions, deletes and unusual filenames ---
const note = await broker.execute({ id: "m1-write", kind: "workspace.write", path: "mem/note.txt", content: "from-memory" }, ctx("agt_mixed"));
const readByReal = await broker.execute({ id: "m2-exec-cat", kind: "process.exec", command: "cat /workspace/mem/note.txt" }, ctx("agt_mixed"));
const writeByReal = await broker.execute(
  { id: "m3-exec-write", kind: "process.exec", command: "mkdir -p /workspace/real && echo from-sandbox > /workspace/real/reply.txt" },
  ctx("agt_mixed"),
);
const readBySynthetic = await broker.execute({ id: "m4-read", kind: "workspace.read", path: "real/reply.txt" }, ctx("agt_mixed"));

const unusual = "dir with space/naïve--name.txt";
const unusualWrite = await broker.execute({ id: "m5-write-unusual", kind: "workspace.write", path: unusual, content: "unicode-ok" }, ctx("agt_mixed"));
const unusualSeenByReal = await broker.execute({ id: "m6-exec-unusual", kind: "process.exec", command: `cat "${"/workspace/"}${unusual}"` }, ctx("agt_mixed"));
const unusualWrittenByReal = await broker.execute(
  { id: "m7-exec-unusual-write", kind: "process.exec", command: `echo from-sandbox-2 > "${"/workspace/"}${unusual}"` },
  ctx("agt_mixed"),
);
const unusualSeenBySynthetic = await broker.execute({ id: "m8-read-unusual", kind: "workspace.read", path: unusual }, ctx("agt_mixed"));

const del = await broker.execute({ id: "m9-delete", kind: "workspace.delete", path: "mem/note.txt" }, ctx("agt_mixed"));
const deletedSeenByReal = await broker.execute({ id: "m10-exec-deleted", kind: "process.exec", command: "test ! -e /workspace/mem/note.txt" }, ctx("agt_mixed"));

results.sharedState = {
  memoryWriteOk: note.ok && note.executor === "synthetic",
  realSeesMemoryWrite: readByReal.ok && text(readByReal.output).includes("from-memory"),
  realWriteOk: writeByReal.ok,
  syntheticSeesRealWrite: (await workspace.readText("real/reply.txt")) === "from-sandbox\n" || (await workspace.readText("real/reply.txt")) === "from-sandbox",
  unusualMemoryWriteOk: unusualWrite.ok && unusualSeenByReal.ok && text(unusualSeenByReal.output).includes("unicode-ok"),
  unusualRealWriteSeenBySynthetic: unusualWrittenByReal.ok && (await workspace.readText(unusual))?.trim() === "from-sandbox-2",
  deleteOk: del.ok && deletedSeenByReal.ok,
};
for (const value of Object.values(results.sharedState as Record<string, unknown>)) if (value !== true) ok = false;
// syntheticSeesRealWrite checked above via readBySynthetic too
if (!(readBySynthetic.ok && (await workspace.readText("real/reply.txt"))?.includes("from-sandbox"))) ok = false;
if (!unusualSeenBySynthetic.ok) ok = false;

// --- Receipts: executor + fidelity recorded per effect; overall = lowest ---
const receiptIds = ["m1-write", "m2-exec-cat", "m3-exec-write", "m4-read"];
const receipts = await Promise.all(receiptIds.map(async (id) => {
  const record = await state.getEffect(id);
  return { id, status: record?.status, executor: (record?.result as { executor?: string } | undefined)?.executor, fidelity: (record?.result as { fidelity?: number } | undefined)?.fidelity };
}));
const overallFidelity = Math.min(...receipts.map((entry) => entry.fidelity ?? Number.POSITIVE_INFINITY));
results.receipts = { receipts, overallFidelity, ok: receipts.every((entry) => entry.status === "committed" && typeof entry.executor === "string") && overallFidelity === 0 };
if (!(results.receipts as { ok: boolean }).ok) ok = false;

// --- Policy mid-chain: allowEscalation:false must fail loudly, and the
//     earlier synthetic effect must not be rolled back ---
const policyWorkspace = new MemoryWorkspace();
const policySynthetic = new SyntheticExecutor(new Map([[policyWorkspace.id, policyWorkspace]]));
const policyReal = new KubernetesExecutor({ resourceClass, backend, workspaces: new Map([[policyWorkspace.id, policyWorkspace]]) });
const policyBroker = new ExecutionBroker([policySynthetic, policyReal]);
const policyCtx: EffectContext = { agentId: "agt_policy" as never, workspaceId: policyWorkspace.id, executionPolicy: { allowEscalation: false } };
const before = await policyBroker.execute({ id: "p1-write", kind: "workspace.write", path: "keep.txt", content: "kept" }, policyCtx);
const blocked = await policyBroker.execute({ id: "p2-exec", kind: "process.exec", command: "echo should-not-run" }, policyCtx);
results.policyMidChain = {
  earlierSyntheticCommitted: before.ok && before.executor === "synthetic",
  execBlockedLoudly: !blocked.ok && blocked.error === "ESCALATION_REQUIRED" && blocked.executor === "synthetic",
  earlierEffectNotRolledBack: (await policyWorkspace.readText("keep.txt")) === "kept",
};
for (const value of Object.values(results.policyMidChain as Record<string, unknown>)) if (value !== true) ok = false;

console.log(JSON.stringify({ ok, namespace, runtimeClass: resourceClass.runtimeClassName, results }, null, 2));
process.exit(ok ? 0 : 1);
