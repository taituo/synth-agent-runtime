import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeGitSource } from "../src/index.js";
// Regression for: a `ref` (or `remote`) starting with '-' is parsed by git's
// own option parser (e.g. as `--upload-pack=<cmd>`) rather than as a value.
// For a local-path remote, `--upload-pack` names a program git runs on THIS
// host to fake being the remote side, before the fetch itself fails. That is
// full command execution on the control-plane host from attacker-controlled
// workspace-source config, not mere argument confusion.
test("a ref starting with '-' is rejected and never reaches git", async () => {
    const root = await mkdtemp(join(tmpdir(), "synth-git-sec-"));
    const marker = join(root, "PWNED");
    try {
        await assert.rejects(() => NativeGitSource.open({
            gitDir: join(root, "cache.git"),
            remote: join(root, "fake-remote"),
            ref: `--upload-pack=touch ${marker};true`,
        }), /Invalid git ref/);
        assert.equal(existsSync(marker), false, "injected command must never execute");
    }
    finally {
        rmSync(marker, { force: true });
        await rm(root, { recursive: true, force: true });
    }
});
test("a remote starting with '-' is rejected", async () => {
    const root = await mkdtemp(join(tmpdir(), "synth-git-sec-"));
    try {
        await assert.rejects(() => NativeGitSource.open({
            gitDir: join(root, "cache.git"),
            remote: "--upload-pack=touch /tmp/should-not-run",
        }), /Invalid git remote/);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
