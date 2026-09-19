import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NativeGitSource } from "../src/index.js";

const exec = promisify(execFile);

test("native git source uses checkout-less backing and can reuse batch blob reader", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "synth-git-"));
  try {
    const work = join(root, "work");
    const remote = join(root, "remote.git");
    const cache = join(root, "cache.git");
    await mkdir(work);
    await exec("git", ["init", "-b", "main"], { cwd: work });
    await exec("git", ["config", "user.email", "test@example.invalid"], { cwd: work });
    await exec("git", ["config", "user.name", "Test"], { cwd: work });
    await writeFile(join(work, "a.txt"), "hello\n");
    await exec("git", ["add", "a.txt"], { cwd: work });
    await exec("git", ["commit", "-m", "init"], { cwd: work });
    await exec("git", ["clone", "--bare", work, remote]);

    const source = await NativeGitSource.open({ gitDir: cache, remote, ref: "main", depth: 1, sparse: ["a.txt"] });
    t.after(() => source.close());
    assert.equal(new TextDecoder().decode(await source.readFile("a.txt")), "hello\n");
    assert.equal(new TextDecoder().decode(await source.readFile("a.txt")), "hello\n");
    assert.equal((await source.revision()).commit?.length, 40);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
