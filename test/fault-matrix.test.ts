/**
 * Track 4 unit tests: the fault matrix is complete, and the SYNTHETIC rung's
 * behaviour (the always-available control) is pinned at the broker level.
 * The REAL rung's fault outcomes are produced live by
 * `integrations/kubernetes/fault-rungs.ts` and `kill-chaos.ts`; a fake
 * high-fidelity executor here only exercises the broker's escalation logic.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  ExecutionBroker,
  MemoryWorkspace,
  SyntheticExecutor,
  type Effect,
  type EffectContext,
  type Executor,
  type WorkspaceId,
} from "../src/index.js";
import { FAULT_MATRIX, REQUIRED_FAULT_IDS } from "./fixtures/fault-matrix.js";

function context(workspaceId: WorkspaceId): EffectContext {
  return { agentId: "agt_matrix" as EffectContext["agentId"], workspaceId };
}

function fakeRealExecutor(): Executor {
  return {
    id: "fake-real",
    fidelity: 1,
    resourceClassId: "sandbox-small",
    canExecute: (effect) => effect.kind === "process.exec",
    execute: async () => ({ ok: true, output: { exitCode: 0, stdout: "ran for real" } }),
  };
}

test("the fault matrix covers every fault the spec lists", () => {
  const ids = new Set(FAULT_MATRIX.map((row) => row.id));
  for (const required of REQUIRED_FAULT_IDS) assert.ok(ids.has(required), `missing fault row: ${required}`);
  // Executor faults differentiate the rungs; provider/temporal faults do not.
  for (const row of FAULT_MATRIX) {
    assert.equal(row.differentiates, row.category === "executor", `${row.id}: differentiates flag`);
    assert.ok(row.synthetic && row.real && row.evidence, `${row.id}: fields populated`);
  }
});

test("synthetic rung: workspace effects succeed, process.exec escalates", async () => {
  const workspace = new MemoryWorkspace();
  const executor = new SyntheticExecutor(new Map([[workspace.id, workspace]]));
  const broker = new ExecutionBroker([executor]);
  const ctx = context(workspace.id);

  const write = await broker.execute({ id: "e-write", kind: "workspace.write", path: "a/b.txt", content: "hi" }, ctx);
  assert.equal(write.ok, true);
  assert.equal(write.executor, "synthetic");
  assert.equal(write.fidelity, 0);
  const read = await broker.execute({ id: "e-read", kind: "workspace.read", path: "a/b.txt" }, ctx);
  assert.equal(new TextDecoder().decode(read.output as Uint8Array), "hi");
  const list = await broker.execute({ id: "e-list", kind: "workspace.list", path: "a" }, ctx);
  assert.deepEqual(list.output, ["b.txt"]);

  const exec = await broker.execute({ id: "e-exec", kind: "process.exec", command: "echo hi" }, ctx);
  assert.equal(exec.ok, false);
  assert.equal(exec.error, "ESCALATION_REQUIRED");
});

test("synthetic rung: escalation happens exactly once when allowed", async () => {
  const workspace = new MemoryWorkspace();
  const executor = new SyntheticExecutor(new Map([[workspace.id, workspace]]));
  const broker = new ExecutionBroker([executor, fakeRealExecutor()]);
  const ctx = context(workspace.id);
  const result = await broker.execute({ id: "e-1", kind: "process.exec", command: "echo hi" }, ctx);
  assert.equal(result.ok, true);
  assert.equal(result.executor, "fake-real");
  assert.equal(result.fidelity, 1);
});

test("synthetic rung: forbidden escalation fails loudly, never silently succeeds", async () => {
  const workspace = new MemoryWorkspace();
  const executor = new SyntheticExecutor(new Map([[workspace.id, workspace]]));
  const broker = new ExecutionBroker([executor, fakeRealExecutor()]);
  const ctx: EffectContext = {
    ...context(workspace.id),
    executionPolicy: { allowEscalation: false },
  };
  const result = await broker.execute({ id: "e-2", kind: "process.exec", command: "echo hi" }, ctx);
  assert.equal(result.ok, false);
  assert.equal(result.error, "ESCALATION_REQUIRED");
  assert.equal(result.executor, "synthetic", "must not have run on the real rung");
});

test("minFidelity floor excludes the synthetic rung entirely", async () => {
  const workspace = new MemoryWorkspace();
  const executor = new SyntheticExecutor(new Map([[workspace.id, workspace]]));
  const ctx = context(workspace.id);

  // Floor 1 with only the synthetic executor: nothing can satisfy the effect.
  const onlySynthetic = new ExecutionBroker([executor]);
  const blocked = await onlySynthetic.execute({ id: "e-3", kind: "workspace.read", path: "a" }, ctx, 1);
  assert.equal(blocked.ok, false);
  assert.match(blocked.error ?? "", /No executor can satisfy effect/);

  // Floor 1 with a real executor: it runs there directly.
  const withReal = new ExecutionBroker([executor, fakeRealExecutor()]);
  const escalated = await withReal.execute({ id: "e-4", kind: "process.exec", command: "echo hi" }, ctx, 1);
  assert.equal(escalated.executor, "fake-real");
});
