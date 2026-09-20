/**
 * Rung parity against an INDEPENDENT oracle (raw node:fs). The oracle arm must
 * not import implementation path policy; that circularity is asserted against
 * in the last test. Path-escape rows are a DOCUMENTED divergence: the synthetic
 * rung confines and rejects, the raw OS escapes, and the sandbox rung confines
 * like the synthetic one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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

test("a source-backed symlink read follows the link, matching the independent oracle", async (t) => {
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
  const oracleRoot = join(parent, "oracle");
  try {
    const workspace = new MemoryWorkspace({ source });
    // The fixture chain: another-dir/pm -> ../other-dir/pm -> ../pm, and
    // tests/fixtures/pm is a real executable file. workspace.read follows the
    // whole chain (readFile semantics), like the real filesystem.
    const link = "tests/fixtures/another-dir/pm";
    const finalTarget = "tests/fixtures/pm";
    assert.equal((await workspace.stat(link))?.kind, "symlink");
    const finalContent = new Uint8Array(await source.readFile(finalTarget));

    const synthetic = await workspace.read(link);
    assert.ok(synthetic && synthetic.byteLength > 0, "a symlink read must stay distinguishable from an empty file");
    assert.ok(Buffer.from(synthetic).equals(Buffer.from(finalContent)), "synthetic read follows the chain to the file content");
    assert.notEqual(new TextDecoder().decode(synthetic), "../other-dir/pm", "not the link's target path");

    // Independent oracle: the same chain on a real filesystem.
    await mkdir(join(oracleRoot, "tests/fixtures/other-dir"), { recursive: true });
    await mkdir(join(oracleRoot, "tests/fixtures/another-dir"), { recursive: true });
    await writeFile(join(oracleRoot, finalTarget), finalContent);
    await symlink("../pm", join(oracleRoot, "tests/fixtures/other-dir/pm"));
    await symlink("../other-dir/pm", join(oracleRoot, link));
    const oracle = await new RealFsOracle(oracleRoot).execute(
      { id: "r", kind: "workspace.read", path: link },
      { agentId: "a" as never, workspaceId: workspace.id },
    );
    assert.equal(oracle.ok, true);
    assert.ok(Buffer.from(oracle.output as Uint8Array).equals(Buffer.from(synthetic)), "synthetic and oracle reads agree");
  } finally {
    await source.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("the oracle imports nothing from the implementation (multi-line and dynamic too)", async () => {
  const source = await readFile(join(process.cwd(), "test/fixtures/real-fs-oracle.ts"), "utf8");
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const valueImports = [...withoutComments.matchAll(/import\s+(?!type\b)([\s\S]*?)from\s+["']([^"']+)["']/g)].filter((match) => match[2]!.includes("src/"));
  const dynamicImports = [...withoutComments.matchAll(/import\s*\(\s*["']([^"']+)["']/g)].filter((match) => match[1]!.includes("src/"));
  assert.deepEqual([...valueImports, ...dynamicImports], [], "oracle must not import implementation values");
});

test("diffOutcomes exempts a divergence by path shape, not by the synthetic error string", () => {
  const inWorkspace = diffOutcomes(
    [{ id: "1", kind: "workspace.read", path: "a.txt", ok: true, category: "", outputBytes: "x" }],
    [{ id: "1", kind: "workspace.read", path: "a.txt", ok: false, category: "denied", error: "WORKSPACE_PATH_ESCAPES:a.txt" }],
  );
  assert.equal(inWorkspace[0]!.kind, "other", "an in-workspace path is never exempt");
  const escaping = diffOutcomes(
    [{ id: "2", kind: "workspace.write", path: "../x", ok: true, category: "", outputBytes: "" }],
    [{ id: "2", kind: "workspace.write", path: "../x", ok: false, category: "denied", error: "WORKSPACE_PATH_ESCAPES:../x" }],
  );
  assert.equal(escaping[0]!.kind, "escape", "a path that escapes is the documented exemption");
});
