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
 * or an `assert` monkeypatch would otherwise score green. `passed` therefore
 * requires a real TAP summary with the expected number of passing tests and zero
 * failures, the assert module is frozen before agent code loads, and a run that
 * executes no tests is `skipped`/`errored`, never `passed`.
 */
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
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
/** Run the held-out test and capture its exit code explicitly (never assume 0). */
function runNodeTest(node, args, cwd, timeoutMs, preloadUrl, nonce) {
    return new Promise((resolve) => {
        // If the scorer itself runs under `node --test`, the child would inherit
        // NODE_TEST_CONTEXT and, believing it is a test child rather than the runner,
        // silently skip every file and exit 0. Strip it so the held-out test really runs.
        const env = { ...process.env };
        delete env.NODE_TEST_CONTEXT;
        env.GYM_HIDDEN_NONCE = nonce;
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
    const hitsHidden = touchedPaths.some((path) => path === hiddenDest || path.startsWith(`${hiddenDest}/`));
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
        try {
            await copyFile(options.hiddenTestPath, join(clone, hiddenDest));
        }
        catch (error) {
            return { outcome: "errored", touchedPaths, detail: `hidden test could not be placed at ${hiddenDest}: ${error.message}` };
        }
        const expected = options.expectedHiddenTests ?? 1;
        // `node --test` marks a test file that calls process.exit(0) before running
        // its assertions as a passing subtest (exit 0 is all the parent sees). The
        // hidden test prints a per-run nonce only after its assertions, and a pass
        // requires that marker, so an early exit cannot masquerade as success.
        const nonce = randomUUID();
        const completion = `GYM_HIDDEN_COMPLETE ${nonce}`;
        const node = options.nodeBin ?? process.execPath;
        const run = await runNodeTest(node, ["--test", hiddenDest], clone, options.timeoutMs ?? 60_000, pathToFileURL(preloadPath).href, nonce);
        const output = `${run.stdout}\n${run.stderr}`;
        if (run.timedOut)
            return { outcome: "timed-out", touchedPaths, hiddenOutput: output };
        const tap = parseTap(output);
        const completed = output.includes(completion);
        if (tap.fail > 0 || /not ok /.test(output))
            return { outcome: "failed", touchedPaths, hiddenOutput: output };
        if (run.code !== 0)
            return { outcome: "errored", touchedPaths, detail: `hidden test process exited ${run.code} with no failing assertion`, hiddenOutput: output };
        if (completed && tap.pass >= expected)
            return { outcome: "passed", touchedPaths, hiddenOutput: output };
        if (!tap.present && !completed) {
            return { outcome: "errored", touchedPaths, detail: `hidden test produced no TAP summary and no completion marker (exit ${run.code}); an early exit is not a pass`, hiddenOutput: output };
        }
        if (tap.pass === 0)
            return { outcome: "skipped", touchedPaths, detail: "hidden test executed no assertions", hiddenOutput: output };
        return { outcome: "errored", touchedPaths, detail: `hidden test did not complete its assertions (pass ${tap.pass} of ${expected} expected)`, hiddenOutput: output };
    }
    finally {
        await rm(work, { recursive: true, force: true });
    }
}
