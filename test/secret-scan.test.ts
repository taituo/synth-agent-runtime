/**
 * The secret scan is enforcement, so it gets a test that feeds it a planted
 * fake credential and requires it to catch it — in a scratch git repo, never
 * the real one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SCANNER = fileURLToPath(new URL("../../scripts/secret-scan.mjs", import.meta.url));

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function scan(cwd: string): Promise<{ code: number; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [SCANNER], { cwd });
    return { code: 0, output: `${stdout}${stderr}` };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

test("the scanner catches a staged fake credential and passes once removed", async () => {
  const repo = await mkdtemp(join(tmpdir(), "secret-scan-"));
  try {
    await git(repo, "init", "-q");
    const file = join(repo, "config.txt");
    await writeFile(file, 'aws_key = "AKIAFAKEFAKEFAKEFAKE"\n');
    await git(repo, "add", "config.txt");
    const caught = await scan(repo);
    assert.equal(caught.code, 1, "a planted AWS key must fail the scan");
    assert.match(caught.output, /aws-access-key/);

    // Hiding it in the working tree while the index still holds it must fail too.
    await writeFile(file, "clean now\n");
    assert.equal((await scan(repo)).code, 1, "the index, not the working tree, is scanned");

    // A deliberate placeholder can be exempted, explicitly.
    await writeFile(file, 'aws_key = "AKIAFAKEFAKEFAKEFAKE" # secret-scan:allow\n');
    await git(repo, "add", "config.txt");
    assert.equal((await scan(repo)).code, 0, "an allow-marked line is exempt");

    await rm(file);
    await git(repo, "add", "-A");
    assert.equal((await scan(repo)).code, 0, "removing it makes the scan clean");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
