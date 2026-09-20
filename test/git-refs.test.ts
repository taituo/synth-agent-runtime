/**
 * Part two: review-shaped handoff via git refs. A producer's commit is exposed
 * at a fully-qualified ref a reviewer can fetch and diff.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createReviewRef, ingestBundle, listReviewRefs } from "../src/index.js";

const execFileAsync = promisify(execFile);
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

test("a review ref exposes the producer's commit and is discoverable", async () => {
  const parent = await mkdtemp(join(tmpdir(), "git-refs-"));
  try {
    const src = join(parent, "src");
    await execFileAsync("git", ["init", "-q", src]);
    await git(src, "config", "user.email", "t@example.com");
    await git(src, "config", "user.name", "tester");
    await writeFile(join(src, "change.txt"), "proposed\n");
    await git(src, "add", "-A");
    await git(src, "commit", "-q", "-m", "proposal");
    const commit = await git(src, "rev-parse", "HEAD");
    const bundle = join(parent, "export.bundle");
    await git(src, "bundle", "create", bundle, "HEAD");

    const bare = join(parent, "bare.git");
    const ingested = await ingestBundle(bundle, bare);
    assert.equal(ingested, commit);

    const ref = await createReviewRef(bare, ingested, "refs/synth/agent-A/run-1");
    assert.equal(ref, "refs/synth/agent-A/run-1");
    const refs = await listReviewRefs(bare);
    assert.deepEqual(refs, [{ ref: "refs/synth/agent-A/run-1", commit }]);
    assert.equal(await git(bare, "rev-parse", "refs/synth/agent-A/run-1"), commit);

    // A non-fully-qualified ref is rejected rather than escaping the namespace.
    await assert.rejects(createReviewRef(bare, commit, "heads/main"), /fully qualified/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
