/**
 * Scoped, one-shot push grants for git-as-transport.
 *
 * Mechanism 2 needs the agent to push from inside the untrusted sandbox, which
 * means a credential there. The grant narrows what that credential can do to a
 * single destination ref, once: a `pre-receive` hook on the runtime-controlled
 * bare repo rejects any push that is not exactly one new ref matching an
 * unexpired grant, forbids deletes and force updates, and consumes the grant so
 * it cannot be replayed. See docs/GIT-PUSH-CREDENTIALS.md for the residual risk.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
export const PRE_RECEIVE_HOOK = [
    "#!/usr/bin/env node",
    '"use strict";',
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const { execFileSync } = require("node:child_process");',
    "",
    "function reject(message) {",
    '  process.stderr.write("SYNTH_PUSH_REJECTED:" + message + "\\n");',
    "  process.exit(1);",
    "}",
    "",
    'let input = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (chunk) => { input += chunk; });',
    'process.stdin.on("end", () => {',
    "  let gitDir;",
    '  try { gitDir = execFileSync("git", ["rev-parse", "--git-dir"], { encoding: "utf8" }).trim(); }',
    "  catch (error) { reject(\"cannot locate git dir: \" + error.message); }",
    '  const grantsDir = path.join(gitDir, "synth-grants");',
    "  const now = Date.now();",
    '  const updates = input.split("\\n").filter(Boolean).map((line) => {',
    '    const [oldSha, newSha, ref] = line.trim().split(/\\s+/);',
    "    return { oldSha, newSha, ref };",
    "  });",
    '  if (updates.length !== 1) reject("exactly one ref update is allowed, got " + updates.length);',
    "  const update = updates[0];",
    '  if (/^0+$/.test(update.newSha)) reject("deleting a ref is not allowed");',
    "  let files = [];",
    '  try { files = fs.readdirSync(grantsDir).filter((name) => name.endsWith(".json")); } catch { files = []; }',
    '  const grant = files',
    '    .map((name) => ({ file: path.join(grantsDir, name), ...JSON.parse(fs.readFileSync(path.join(grantsDir, name), "utf8")) }))',
    '    .find((entry) => entry.ref === update.ref && typeof entry.expiresAt === "number" && entry.expiresAt > now);',
    '  if (!grant) reject("no valid grant for " + update.ref);',
    "  let exists = true;",
    '  try { execFileSync("git", ["rev-parse", "--verify", "--quiet", update.ref], { stdio: "ignore" }); } catch { exists = false; }',
    '  if (exists) reject("ref " + update.ref + " already exists; overwrite and force are not allowed");',
    "  // One-shot: consume the grant before allowing the push.",
    "  try { fs.unlinkSync(grant.file); } catch { /* already consumed */ }",
    "  process.exit(0);",
    "});",
    "",
].join("\n");
/**
 * Install the hook and write a grant. The credential handed to the sandbox
 * carries only the transport secret; the AUTHORIZATION is this grant plus the
 * hook, so even a stolen credential can only create the one granted ref once.
 */
export async function createScopedPushGrant(options) {
    const grantsDir = join(options.repoDir, "synth-grants");
    await mkdir(grantsDir, { recursive: true });
    await mkdir(join(options.repoDir, "hooks"), { recursive: true });
    const hookPath = join(options.repoDir, "hooks", "pre-receive");
    await writeFile(hookPath, PRE_RECEIVE_HOOK, { mode: 0o755 });
    const grantId = randomUUID();
    const expiresAt = (options.now ?? Date.now)() + (options.ttlMs ?? 5 * 60_000);
    await writeFile(join(grantsDir, `${grantId}.json`), JSON.stringify({ ref: options.ref, expiresAt }));
    return { grantId, ref: options.ref, expiresAt };
}
/** Push `localRef` from `workDir` to `remote` at the granted ref, with the hook enforcing scope. */
export async function scopedPush(options) {
    try {
        const { stdout, stderr } = await execFileAsync("git", ["-C", options.workDir, "push", options.remote, `${options.localRef}:${options.ref}`]);
        return { ok: true, stdout, stderr };
    }
    catch (error) {
        const e = error;
        return { ok: false, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message ?? "" };
    }
}
