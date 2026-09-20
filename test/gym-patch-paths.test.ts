/**
 * Solidify the tampering check: fuzz patch shapes and assert `patchTargetPaths`
 * never misses a path git itself will touch, and never misses a protected one.
 *
 * This is the drift guard for the round-3 fix. It compares against git's own
 * parser (`git apply --numstat -z`) rather than re-asserting our own logic.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { isTampering, patchTargetPaths, parsePatchPaths } from "../src/index.js";

const execFileAsync = promisify(execFile);

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PATHS = [
  "he.js",
  "lib/a.js",
  "src/café.js",
  "a b/c.js",
  "test/visible.test.mjs",
  "tests/helper.js",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  ".github/workflows/ci.yml",
  ".git/config",
  "docs/readme.md",
];

function hunk(): string[] {
  return ["@@ -1 +1 @@", "-old line", "+new line"];
}

/** Build one random patch shape; returns the text and the protected path it names (if any). */
function buildPatch(rand: () => number): { text: string; protectedPath?: string; rename?: { old: string; next: string } } {
  const pick = (): string => PATHS[Math.floor(rand() * PATHS.length)]!;
  const a = pick();
  const shape = Math.floor(rand() * 5);
  const quote = (p: string): string => (p.includes(" ") ? `"${p}"` : p);

  if (shape === 0) {
    // Standard modify.
    return { text: [`diff --git a/${quote(a)} b/${quote(a)}`, `--- a/${quote(a)}`, `+++ b/${quote(a)}`, ...hunk()].join("\n"), ...(isTampering([a]) ? { protectedPath: a } : {}) };
  }
  if (shape === 1) {
    // No diff --git header (a hand-crafted patch still applies).
    return { text: [`--- a/${quote(a)}`, `+++ b/${quote(a)}`, ...hunk()].join("\n"), ...(isTampering([a]) ? { protectedPath: a } : {}) };
  }
  if (shape === 2) {
    // --no-prefix style.
    return { text: [`--- ${quote(a)}`, `+++ ${quote(a)}`, ...hunk()].join("\n"), ...(isTampering([a]) ? { protectedPath: a } : {}) };
  }
  if (shape === 3) {
    // Rename: the old name is protected, the new one is not.
    let b = pick();
    for (let guard = 0; b === a && guard < 5; guard++) b = pick();
    const text = [`diff --git a/${quote(a)} b/${quote(b)}`, "similarity index 100%", `rename from ${quote(a)}`, `rename to ${quote(b)}`].join("\n");
    return { text, ...(isTampering([a, b]) ? { protectedPath: a } : {}), ...(a !== b ? { rename: { old: a, next: b } } : {}) };
  }
  // New file via /dev/null.
  return { text: [`diff --git a/${quote(a)} b/${quote(a)}`, "new file mode 100644", "--- /dev/null", `+++ b/${quote(a)}`, "@@ -0,0 +1 @@", "+content"].join("\n"), ...(isTampering([a]) ? { protectedPath: a } : {}) };
}

/** Paths git itself reports for a patch (authoritative). */
async function gitTouchedPaths(patchText: string): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "gym-fuzz-"));
  try {
    const file = join(dir, "p.patch");
    await writeFile(file, patchText);
    const { stdout } = await execFileAsync("git", ["apply", "--numstat", "-z", file]);
    const paths: string[] = [];
    for (const record of stdout.split("\0")) {
      if (!record) continue;
      const fields = record.split("\t");
      if (fields.length >= 3) for (const field of fields.slice(2)) if (field) paths.push(field);
      else if (fields.length === 1) paths.push(fields[0]!);
    }
    return paths;
  } catch {
    return [];
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("fuzz: patchTargetPaths never misses a path git will touch, nor a protected one", async () => {
  const rand = mulberry32(0x5eed);
  for (let i = 0; i < 200; i++) {
    const { text, protectedPath, rename } = buildPatch(rand);
    const ours = await patchTargetPaths(text);
    const gitPaths = await gitTouchedPaths(text);
    for (const path of gitPaths) {
      assert.ok(ours.includes(path), `iteration ${i}: git touches ${path}, patchTargetPaths has ${JSON.stringify(ours)}\n${text}`);
    }
    // The raw parser must expose BOTH sides of a rename; git's --numstat only
    // reports the new name, so the old (protected) name is ours to catch.
    if (rename) {
      const raw = parsePatchPaths(text);
      assert.ok(raw.includes(rename.old), `iteration ${i}: rename old name ${rename.old} missing from raw parse ${JSON.stringify(raw)}\n${text}`);
      assert.ok(raw.includes(rename.next), `iteration ${i}: rename new name ${rename.next} missing from raw parse ${JSON.stringify(raw)}\n${text}`);
    }
    if (protectedPath) {
      assert.equal(isTampering(ours), true, `iteration ${i}: protected path ${protectedPath} not flagged\n${text}`);
    }
  }
});
