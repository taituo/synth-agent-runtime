/**
 * Gym scoring: turn an agent's PATCH into one of six explicit outcomes.
 *
 * Cheating is the primary adversary, so the score comes from applying the
 * patch to a FRESH checkout of the pinned commit and running a HELD-OUT test
 * the agent never sees. Anything the agent did to its own sandbox (installed
 * packages, edited configs, touched the runner) does not travel with the patch.
 * A patch that touches test files or runner config is `tampered`, not `failed`.
 *
 * `passed` is NOT "node exited 0". The hidden test imports the agent-controlled
 * module, so agent code runs before the assertions; a top-level `process.exit(0)`
 * or an `assert` monkeypatch would otherwise score green. The pass decision is
 * an HMAC over the transcript of assertion outcomes, signed by the hidden
 * harness with a per-run key and verified by the scorer. The key is delivered
 * in a file the harness reads and DELETES before the agent's module is imported,
 * so the agent cannot observe it — not in env (which survives in
 * /proc/self/environ), not in argv, and not on disk when it runs. A forged or
 * absent result therefore cannot authenticate. The assert module is also frozen
 * before agent code loads, and a run that executes no assertions is
 * `skipped`/`errored`, never `passed`.
 */
import { execFile, spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
/** Paths an agent must not change: the visible test and the runner config. */
export const PROTECTED_PATTERNS = [
    // Any test directory, not just a top-level `test/` (e.g. `tests/`).
    /(^|\/)tests?\//,
    /(^|\/)package\.json$/,
    /(^|\/)package-lock\.json$/,
    /\.mocharc/,
    /jest\.config/,
    /vitest\.config/,
    /(^|\/)tsconfig[^/]*\.json$/,
    /(^|\/)\.github\//,
    /(^|\/)\.git\//,
];
function stripQuotes(value) {
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"'))
        return value.slice(1, -1);
    return value;
}
/**
 * Every path-like token a unified diff mentions, taking BOTH sides of a rename
 * or copy and the `---`/`+++` headers as well as the `diff --git` line. Taking
 * only the `b/` side of `diff --git` misses a rename that moves a protected file
 * away under a new name, and a hand-crafted patch can omit the `diff --git`
 * header entirely while still applying. Over-reporting is safe here: an extra
 * path can only make the tampering check stricter.
 */
export function parsePatchPaths(patchText) {
    const paths = new Set();
    const add = (raw) => {
        let path = stripQuotes(raw.trim());
        if (!path || path === "/dev/null")
            return;
        if (path.startsWith("a/") || path.startsWith("b/"))
            path = path.slice(2);
        if (path)
            paths.add(path);
    };
    for (const line of patchText.split("\n")) {
        if (line.startsWith("diff --git ")) {
            for (const token of line.slice("diff --git ".length).match(/"[^"]*"|\S+/g) ?? [])
                add(token);
        }
        else if (line.startsWith("--- ") || line.startsWith("+++ ")) {
            add(line.slice(4));
        }
        else if (/^(rename|copy) (from|to) /.test(line)) {
            add(line.replace(/^(rename|copy) (from|to) /, ""));
        }
    }
    return [...paths];
}
/**
 * Repo-relative paths a patch targets, according to git's own patch parser.
 * `git apply --numstat` lists what a patch will touch even when it would not
 * apply (wrong context) and even without a `diff --git` header, and it decodes
 * git's quoted/octal-escaped paths. The raw parse is unioned in to catch the
 * original name of a rename, which `--numstat` reports only under the new name.
 */
export async function patchTargetPaths(patchText) {
    const raw = parsePatchPaths(patchText);
    const dir = await mkdtemp(join(tmpdir(), "gym-paths-"));
    try {
        const file = join(dir, "change.patch");
        await writeFile(file, patchText);
        const { stdout } = await execFileAsync("git", ["apply", "--numstat", "-z", file]);
        const paths = new Set(raw);
        for (const record of stdout.split("\0")) {
            if (!record)
                continue;
            const fields = record.split("\t");
            if (fields.length >= 3)
                for (const field of fields.slice(2))
                    if (field)
                        paths.add(field);
                    else if (fields.length === 1)
                        paths.add(fields[0]);
        }
        return [...paths];
    }
    catch {
        // git could not parse the patch at all; the raw parse is the best we have and
        // the apply step will surface the real problem as `errored`.
        return raw;
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
}
export function isTampering(paths) {
    return paths.some((path) => PROTECTED_PATTERNS.some((pattern) => pattern.test(path)));
}
/** Parse the TAP summary `node --test` prints. `present` is the "did it finish?" signal. */
function parseTap(output) {
    const num = (pattern) => {
        const match = pattern.exec(output);
        return match ? Number(match[1]) : 0;
    };
    const tests = num(/^# tests (\d+)$/m);
    const pass = num(/^# pass (\d+)$/m);
    const fail = num(/^# fail (\d+)$/m);
    const skipped = num(/^# skipped (\d+)$/m);
    return { present: /^# (tests|pass) \d+$/m.test(output), tests, pass, fail, skipped };
}
/**
 * Freeze `node:assert` before the agent's module loads. The hidden test imports
 * the agent's code, so the agent could otherwise replace `assert.equal` with a
 * no-op and pass every assertion. This runs as a preload in the test process
 * (and is inherited by `node --test`'s children via NODE_OPTIONS).
 */
const FREEZE_ASSERT_PRELOAD = [
    'import assert from "node:assert";',
    'import strict from "node:assert/strict";',
    "function freeze(mod) {",
    "  try {",
    "    for (const key of Object.keys(mod)) {",
    "      const d = Object.getOwnPropertyDescriptor(mod, key);",
    "      if (d && d.writable) Object.defineProperty(mod, key, { ...d, writable: false, configurable: false });",
    "    }",
    "    Object.freeze(mod);",
    "  } catch { /* already frozen or non-configurable */ }",
    "}",
    "freeze(assert);",
    "freeze(strict);",
    "",
].join("\n");
/** Where the harness is written inside the clone. */
export const HIDDEN_HARNESS_DEST = "gym-hidden-harness.mjs";
/**
 * The held-out test imports this harness. It reads the per-run key from a file
 * and DELETES the file and the env pointer BEFORE the agent's module is
 * imported, so the key is not observable to the agent (not in env — which
 * survives in /proc/self/environ — not in argv, and not on disk by the time the
 * agent runs). `complete()` prints an HMAC over the transcript of assertion
 * outcomes; the scorer, which holds the key, verifies it. A forged transcript
 * needs the key, which the agent cannot obtain, so the marker is no longer
 * forgeable by reading the process it runs in.
 */
export const HIDDEN_HARNESS_SOURCE = [
    'import { createHmac } from "node:crypto";',
    'import { readFileSync, unlinkSync, writeFileSync } from "node:fs";',
    "",
    "const keyPath = process.env.GYM_HIDDEN_KEY_FILE;",
    'let key = "";',
    "if (keyPath) {",
    '  try { key = readFileSync(keyPath, "utf8").trim(); } catch { /* absent */ }',
    "  try { unlinkSync(keyPath); } catch { /* already gone */ }",
    "  delete process.env.GYM_HIDDEN_KEY_FILE;",
    "}",
    "const resultPath = process.env.GYM_HIDDEN_RESULT_FILE;",
    "const results = [];",
    "export function check(name, fn) {",
    "  try { fn(); results.push({ name, ok: true }); }",
    '  catch (error) { results.push({ name, ok: false, error: String((error && error.message) || error).slice(0, 200) }); }',
    "}",
    "export function complete() {",
    "  const transcript = JSON.stringify(results);",
    '  const mac = createHmac("sha256", key).update(transcript).digest("hex");',
    "  // Written to a file, not stdout: node --test escapes console output as TAP.",
    '  if (resultPath) writeFileSync(resultPath, JSON.stringify({ transcript, mac }));',
    "  // Also fail the test process so a direct run's exit code reflects the checks.",
    "  const failed = results.filter((entry) => !entry.ok).map((entry) => entry.name);",
    '  if (failed.length > 0) throw new Error("GYM_HIDDEN_CHECKS_FAILED:" + failed.join(","));',
    "}",
    "",
].join("\n");
/** Run the held-out test and capture its exit code explicitly (never assume 0). */
function runNodeTest(node, args, cwd, timeoutMs, preloadUrl, keyFile, resultFile) {
    return new Promise((resolve) => {
        // If the scorer itself runs under `node --test`, the child would inherit
        // NODE_TEST_CONTEXT and, believing it is a test child rather than the runner,
        // silently skip every file and exit 0. Strip it so the held-out test really runs.
        const env = { ...process.env };
        delete env.NODE_TEST_CONTEXT;
        env.GYM_HIDDEN_KEY_FILE = keyFile;
        env.GYM_HIDDEN_RESULT_FILE = resultFile;
        if (preloadUrl)
            env.NODE_OPTIONS = [env.NODE_OPTIONS, `--import ${preloadUrl}`].filter(Boolean).join(" ");
        const child = spawn(node, args, { cwd, env });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
        }, timeoutMs);
        child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
        child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
        child.once("error", (error) => {
            clearTimeout(timer);
            resolve({ code: null, signal: null, stdout, stderr: `${stderr}${String(error)}`, timedOut });
        });
        child.once("close", (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal, stdout, stderr, timedOut });
        });
    });
}
export async function scoreGymPatch(options) {
    const hiddenDest = options.hiddenTestDest ?? "hidden.test.mjs";
    const touchedPaths = await patchTargetPaths(options.patchText);
    const hitsHidden = touchedPaths.some((path) => path === hiddenDest || path.startsWith(`${hiddenDest}/`) ||
        path === HIDDEN_HARNESS_DEST || path.startsWith(`${HIDDEN_HARNESS_DEST}/`));
    if (isTampering(touchedPaths) || hitsHidden) {
        return { outcome: "tampered", touchedPaths, detail: `patch touches protected paths: ${touchedPaths.join(", ")}` };
    }
    const work = await mkdtemp(join(tmpdir(), "gym-score-"));
    try {
        const clone = join(work, "clone");
        await execFileAsync("git", ["clone", "-q", options.baseRepoDir, clone]);
        const patchFile = join(work, "change.patch");
        await writeFile(patchFile, options.patchText);
        try {
            await execFileAsync("git", ["-C", clone, "apply", "--check", patchFile]);
        }
        catch (error) {
            return { outcome: "errored", touchedPaths, detail: `patch does not apply: ${error.message}` };
        }
        await execFileAsync("git", ["-C", clone, "apply", patchFile]);
        const preloadPath = join(work, "freeze-assert.mjs");
        await writeFile(preloadPath, FREEZE_ASSERT_PRELOAD);
        // The key lives in `work/`, outside the clone. The harness reads it and
        // deletes the file before importing the agent's module, so the agent cannot
        // observe it (not env, not argv, not on disk when it runs).
        const key = randomBytes(32).toString("hex");
        const keyFile = join(work, "hidden-key");
        await writeFile(keyFile, key, { mode: 0o600 });
        const resultFile = join(work, "hidden-result.json");
        await writeFile(join(clone, HIDDEN_HARNESS_DEST), HIDDEN_HARNESS_SOURCE);
        try {
            await copyFile(options.hiddenTestPath, join(clone, hiddenDest));
        }
        catch (error) {
            return { outcome: "errored", touchedPaths, detail: `hidden test could not be placed at ${hiddenDest}: ${error.message}` };
        }
        const expected = options.expectedHiddenTests ?? 1;
        const node = options.nodeBin ?? process.execPath;
        const run = await runNodeTest(node, ["--test", hiddenDest], clone, options.timeoutMs ?? 60_000, pathToFileURL(preloadPath).href, keyFile, resultFile);
        const output = `${run.stdout}\n${run.stderr}`;
        if (run.timedOut)
            return { outcome: "timed-out", touchedPaths, hiddenOutput: output };
        const tap = parseTap(output);
        if (tap.fail > 0 || /not ok /.test(output))
            return { outcome: "failed", touchedPaths, hiddenOutput: output };
        if (run.code !== 0)
            return { outcome: "errored", touchedPaths, detail: `hidden test process exited ${run.code} with no failing assertion`, hiddenOutput: output };
        // The pass decision comes from the HMAC-signed transcript in the result
        // file, verified with the key the agent cannot read. A forged or absent
        // result is not a pass.
        let signed;
        try {
            signed = JSON.parse(await readFile(resultFile, "utf8"));
        }
        catch {
            signed = undefined;
        }
        if (!signed || typeof signed.transcript !== "string" || typeof signed.mac !== "string") {
            return { outcome: "errored", touchedPaths, detail: "no signed result: the completion marker was absent or forged", hiddenOutput: output };
        }
        if (createHmac("sha256", key).update(signed.transcript).digest("hex") !== signed.mac) {
            return { outcome: "errored", touchedPaths, detail: "signed result did not authenticate: forged", hiddenOutput: output };
        }
        let cases;
        try {
            cases = JSON.parse(signed.transcript);
        }
        catch {
            return { outcome: "errored", touchedPaths, detail: "signed transcript was not parseable", hiddenOutput: output };
        }
        if (cases.length === 0)
            return { outcome: "skipped", touchedPaths, detail: "the hidden test recorded no assertions", hiddenOutput: output };
        if (cases.some((entry) => entry.ok !== true))
            return { outcome: "failed", touchedPaths, hiddenOutput: output };
        if (cases.length < expected)
            return { outcome: "errored", touchedPaths, detail: `hidden test recorded ${cases.length} of ${expected} expected assertions`, hiddenOutput: output };
        return { outcome: "passed", touchedPaths, hiddenOutput: output };
    }
    finally {
        await rm(work, { recursive: true, force: true });
    }
}
