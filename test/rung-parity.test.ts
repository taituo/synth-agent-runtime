/**
 * Rung parity against an INDEPENDENT oracle (raw node:fs). The oracle arm must
 * not import implementation path policy; that circularity is asserted against
 * in the last test. Path-escape rows are a DOCUMENTED divergence: the synthetic
 * rung confines and rejects, the raw OS escapes, and the sandbox rung confines
 * like the synthetic one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryWorkspace,
  NativeGitSource,
  SyntheticExecutor,
  WORKSPACE_NOT_DIRECTORY,
  WORKSPACE_NOT_FOUND,
  WORKSPACE_PATH_ESCAPES,
  type Effect,
} from "../src/index.js";
import { RealFsOracle } from "./fixtures/real-fs-oracle.js";
import { diffOutcomes, generateWorkspaceSequence, makeParityRoot, runSequence } from "./fixtures/rung-parity.js";
import { FixtureUnavailableError, REAL_REPOS, repoCachePath } from "./fixtures/real-repos.js";

function synthetic() {
  const workspace = new MemoryWorkspace();
  return { executor: new SyntheticExecutor(new Map([[workspace.id, workspace]])), workspace };
}

function context(workspaceId: MemoryWorkspace["id"]) {
  return { agentId: "agt" as never, workspaceId };
}

async function compare(effects: readonly Effect[], seed: number) {
  const { parent, root } = await makeParityRoot(seed);
  try {
    const { executor, workspace } = synthetic();
    const oracleOutcomes = await runSequence(new RealFsOracle(root), effects, workspace.id);
    const syntheticOutcomes = await runSequence(executor, effects, workspace.id);
    return diffOutcomes(oracleOutcomes, syntheticOutcomes);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

test("synthetic and the independent oracle agree except documented path-escape rows", async () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const diffs = await compare(generateWorkspaceSequence(seed, 24), seed);
    const unexpected = diffs.filter((diff) => diff.kind !== "escape");
    assert.deepEqual(unexpected, [], `seed ${seed} had unexpected divergences: ${unexpected.map((d) => d.detail).join(" | ")}`);
  }
});

test("the non-path divergences are closed (permanent regression cases)", async () => {
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
    {
      name: "write where a directory exists is EISDIR",
      effects: [
        { id: "1", kind: "workspace.write", path: "d/x", content: "child" },
        { id: "2", kind: "workspace.write", path: "d", content: "file" },
      ],
    },
  ];
  for (const { name, effects } of cases) {
    const diffs = await compare(effects, 999);
    assert.deepEqual(diffs, [], `${name} diverged: ${diffs.map((d) => d.detail).join(" | ")}`);
  }

  const { executor, workspace } = synthetic();
  const ctx = context(workspace.id);
  assert.match((await executor.execute({ id: "1", kind: "workspace.read", path: "nope" }, ctx)).error ?? "", new RegExp(`^${WORKSPACE_NOT_FOUND}:`));
  await executor.execute({ id: "w", kind: "workspace.write", path: "f.txt", content: "file" }, ctx);
  const notDir = await executor.execute({ id: "2", kind: "workspace.write", path: "f.txt/c", content: "x" }, ctx);
  assert.equal(notDir.ok, false);
  assert.match(notDir.error ?? "", new RegExp(`^${WORKSPACE_NOT_DIRECTORY}:`));
});

test("../ traversal: synthetic rejects, the raw OS escapes (documented divergence)", async () => {
  const { parent, root } = await makeParityRoot(88);
  try {
    const effect: Effect = { id: "1", kind: "workspace.write", path: "../escape.txt", content: "x" };
    const { executor, workspace } = synthetic();
    const ctx = context(workspace.id);
    const synth = await executor.execute(effect, ctx);
    assert.equal(synth.ok, false);
    assert.match(synth.error ?? "", new RegExp(`^${WORKSPACE_PATH_ESCAPES}:`));
    const oracle = await new RealFsOracle(root).execute(effect, ctx);
    assert.equal(oracle.ok, true, "raw OS really escapes the root");
    assert.equal((await stat(join(parent, "escape.txt"))).isFile(), true, "and it wrote outside the root");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("absolute paths are rejected, not silently rewritten", async () => {
  const { parent, root } = await makeParityRoot(77);
  try {
    const absolute = join(parent, "absolute-target.txt");
    const effect: Effect = { id: "1", kind: "workspace.write", path: absolute, content: "x" };
    const { executor, workspace } = synthetic();
    const ctx = context(workspace.id);
    const synth = await executor.execute(effect, ctx);
    assert.equal(synth.ok, false);
    assert.match(synth.error ?? "", new RegExp(`^${WORKSPACE_PATH_ESCAPES}:`));
    // The raw OS writes at the absolute path; the synthetic rung must NOT have
    // written a rewritten copy inside the workspace.
    assert.equal((await new RealFsOracle(root).execute(effect, ctx)).ok, true);
    await assert.rejects(stat(join(root, absolute)), "no silently-rewritten in-workspace path");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("a source-backed symlink read is distinguishable from an empty file", async (t) => {
  const repo = REAL_REPOS.find((entry) => entry.name === "commander")!;
  let cache: string;
  try {
    cache = await repoCachePath(repo);
  } catch (error) {
    if (error instanceof FixtureUnavailableError) {
      t.skip(error.message);
      return;
    }
    throw error;
  }
  const parent = await mkdtemp(join(tmpdir(), "synth-symread-"));
  const source = await NativeGitSource.open({ gitDir: join(parent, "cache.git"), remote: cache, ref: repo.commit });
  try {
    const workspace = new MemoryWorkspace({ source });
    const link = "tests/fixtures/pmlink";
    assert.equal((await workspace.stat(link))?.kind, "symlink");
    const bytes = await workspace.read(link);
    assert.ok(bytes && bytes.byteLength > 0, "a symlink read must return the target, not undefined");
    assert.equal(new TextDecoder().decode(bytes), Buffer.from(await source.readFile(link)).toString("utf8"));
  } finally {
    await source.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("the oracle imports nothing from the implementation", async () => {
  const source = await readFile(join(process.cwd(), "test/fixtures/real-fs-oracle.ts"), "utf8");
  const offending = source
    .split("\n")
    .filter((line) => /^\s*import\b/.test(line) && !/^\s*import\s+type\b/.test(line) && line.includes("src/"));
  assert.deepEqual(offending, [], `oracle must not import implementation values: ${offending.join("; ")}`);
});
