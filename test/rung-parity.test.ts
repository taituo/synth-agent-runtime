/**
 * Rung parity: the synthetic rung must match the real filesystem (the oracle)
 * for every workspace effect it claims to support. The differential harness
 * generates seeded effect sequences, runs them against both, and diffs the
 * per-effect outcome.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryWorkspace,
  SyntheticExecutor,
  WORKSPACE_NOT_DIRECTORY,
  WORKSPACE_NOT_FOUND,
  WORKSPACE_PATH_ESCAPES,
  type Effect,
} from "../src/index.js";
import { RealFsExecutor, diffOutcomes, generateWorkspaceSequence, runSequence } from "./fixtures/rung-parity.js";

function synthetic() {
  const workspace = new MemoryWorkspace();
  return { executor: new SyntheticExecutor(new Map([[workspace.id, workspace]])), workspace };
}

async function compare(effects: readonly Effect[], seed: number) {
  const root = await mkdtemp(join(tmpdir(), `synth-parity-${seed}-`));
  try {
    const { executor, workspace } = synthetic();
    const realOutcomes = await runSequence(new RealFsExecutor(root), effects, workspace.id);
    const syntheticOutcomes = await runSequence(executor, effects, workspace.id);
    return diffOutcomes(realOutcomes, syntheticOutcomes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("synthetic and real rungs agree on generated workspace sequences", async () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const diffs = await compare(generateWorkspaceSequence(seed, 24), seed);
    assert.deepEqual(diffs, [], `seed ${seed} diverged`);
  }
});

test("the six measured divergences are closed (permanent regression cases)", async () => {
  const cases: Array<{ name: string; effects: Effect[] }> = [
    { name: "read missing path", effects: [{ id: "1", kind: "workspace.read", path: "missing.txt" }] },
    { name: "delete missing path", effects: [{ id: "1", kind: "workspace.delete", path: "missing.txt" }] },
    { name: "list missing directory", effects: [{ id: "1", kind: "workspace.list", path: "missing-dir" }] },
    {
      name: "delete a directory removes its children",
      effects: [
        { id: "1", kind: "workspace.write", path: "a/b.txt", content: "child" },
        { id: "2", kind: "workspace.delete", path: "a" },
        { id: "3", kind: "workspace.read", path: "a/b.txt" },
      ],
    },
    {
      name: "write under a file path is ENOTDIR",
      effects: [
        { id: "1", kind: "workspace.write", path: "f.txt", content: "file" },
        { id: "2", kind: "workspace.write", path: "f.txt/child", content: "x" },
      ],
    },
    { name: "../ traversal is confined", effects: [{ id: "1", kind: "workspace.write", path: "../escape.txt", content: "x" }] },
  ];
  for (const { name, effects } of cases) {
    const diffs = await compare(effects, 999);
    assert.deepEqual(diffs, [], `${name} diverged`);
  }
  // The missing-path errors use the shared vocabulary, not errno strings.
  const { executor, workspace } = synthetic();
  const context = { agentId: "agt" as never, workspaceId: workspace.id };
  assert.match(
    (await executor.execute({ id: "1", kind: "workspace.read", path: "nope" }, context)).error ?? "",
    new RegExp(`^${WORKSPACE_NOT_FOUND}:`),
  );
  await executor.execute({ id: "w", kind: "workspace.write", path: "f.txt", content: "file" }, context);
  const notDir = await executor.execute({ id: "2", kind: "workspace.write", path: "f.txt/c", content: "x" }, context);
  assert.equal(notDir.ok, false);
  assert.match(notDir.error ?? "", new RegExp(`^${WORKSPACE_NOT_DIRECTORY}:`));
});

test("../ traversal is rejected on both rungs (no silent rewrite)", async () => {
  const root = await mkdtemp(join(tmpdir(), "synth-parity-escape-"));
  try {
    const { executor, workspace } = synthetic();
    const context = { agentId: "agt" as never, workspaceId: workspace.id };
    const effect: Effect = { id: "1", kind: "workspace.write", path: "../../etc/passwd", content: "x" };
    const real = await new RealFsExecutor(root).execute(effect, context);
    const synth = await executor.execute(effect, context);
    assert.equal(real.ok, false);
    assert.equal(synth.ok, false);
    assert.match(real.error ?? "", new RegExp(`^${WORKSPACE_PATH_ESCAPES}:`));
    assert.equal(real.error, synth.error, "both rungs reject with the same shared error");
    await assert.rejects(stat(join(root, "etc/passwd")), "nothing may be written for a rejected path");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a path normalising to the root returns an EffectResult, never a throw", async () => {
  const root = await mkdtemp(join(tmpdir(), "synth-parity-root-"));
  try {
    const { executor, workspace } = synthetic();
    const context = { agentId: "agt" as never, workspaceId: workspace.id };
    for (const path of ["..", ".", "/"]) {
      for (const kind of ["workspace.read", "workspace.write", "workspace.delete", "workspace.list"] as const) {
        const effect: Effect = kind === "workspace.write" ? { id: "x", kind, path, content: "x" } : { id: "x", kind, path };
        const synth = await executor.execute(effect, context);
        const real = await new RealFsExecutor(root).execute(effect, context);
        assert.equal(typeof synth.ok, "boolean", `${kind} ${path} must return a result, not throw`);
        assert.equal(synth.ok, real.ok, `${kind} ${path}: ok`);
        assert.equal(synth.error, real.error, `${kind} ${path}: error`);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
