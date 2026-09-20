/**
 * Differential harness for rung parity.
 *
 * Runs the SAME generated workspace effect sequence against the synthetic rung
 * (MemoryWorkspace + SyntheticExecutor) and against the INDEPENDENT oracle
 * (`real-fs-oracle.ts`: raw node:fs, no implementation imports), then diffs the
 * observable outcome. The oracle arm must never import path-policy helpers from
 * `src/execution` or `src/workspace` — see `test/rung-parity.test.ts`.
 */
import { mkdtemp } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryWorkspace, SyntheticExecutor, } from "../../src/index.js";
export function mulberry32(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
/**
 * Small shared path alphabet: nested paths, a path reused as file then
 * directory, an odd name, and `..` segments. The `..` rows exercise a
 * DOCUMENTED divergence (the synthetic rung confines; the raw OS escapes).
 */
export const PARITY_PATHS = [
    "a",
    "a/b.txt",
    "a/c",
    "a/c/d.txt",
    "f.txt",
    "f.txt/child",
    "x/y/z",
    "dir with space/naïve--name.txt",
    "../escape.txt",
    "a/../../escape2.txt",
];
export function generateWorkspaceSequence(seed, size) {
    const random = mulberry32(seed);
    const kinds = ["workspace.write", "workspace.read", "workspace.delete", "workspace.list"];
    const effects = [];
    for (let i = 0; i < size; i++) {
        const kind = kinds[Math.floor(random() * kinds.length)];
        const path = PARITY_PATHS[Math.floor(random() * PARITY_PATHS.length)];
        const id = `s${seed}-e${i}`;
        if (kind === "workspace.write")
            effects.push({ id, kind, path, content: `v${Math.floor(random() * 1000)}` });
        else if (kind === "workspace.read")
            effects.push({ id, kind, path });
        else if (kind === "workspace.delete")
            effects.push({ id, kind, path });
        else
            effects.push({ id, kind: "workspace.list", path });
    }
    return effects;
}
/**
 * A unique parent dir plus a workspace root inside it, so a path that escapes
 * the root (which the raw oracle really does) stays inside the temp parent and
 * is removed with it.
 */
export async function makeParityRoot(seed) {
    const parent = await mkdtemp(join(tmpdir(), `synth-parity-${seed}-`));
    return { parent, root: join(parent, "root") };
}
/** Coarse error category, so raw errno and the synthetic vocabulary compare. */
export function categoryOf(error) {
    if (!error)
        return "";
    if (/ENOENT|WORKSPACE_NOT_FOUND/.test(error))
        return "not-found";
    // EEXIST: the oracle's `mkdir -p` for a write under a file hits the file,
    // which is the same condition the synthetic rung reports as NOT_DIRECTORY.
    if (/ENOTDIR|EEXIST|WORKSPACE_NOT_DIRECTORY/.test(error))
        return "not-directory";
    if (/EISDIR|WORKSPACE_IS_DIRECTORY/.test(error))
        return "is-directory";
    if (/EACCES|EPERM|WORKSPACE_PATH_ESCAPES/.test(error))
        return "denied";
    if (/ESCALATION_REQUIRED/.test(error))
        return "escalate";
    return error;
}
export async function runSequence(executor, effects, workspaceId) {
    const context = { agentId: "agt_parity", workspaceId };
    const outcomes = [];
    for (const effect of effects) {
        const result = await executor.execute(effect, context);
        outcomes.push({
            id: effect.id,
            kind: effect.kind,
            path: pathOf(effect),
            ok: result.ok,
            category: categoryOf(result.error),
            ...(result.error ? { error: result.error } : {}),
            ...(result.output !== undefined ? { outputBytes: outputString(result.output) } : {}),
        });
    }
    return outcomes;
}
function pathOf(effect) {
    return "path" in effect && typeof effect.path === "string" ? effect.path : "";
}
function outputString(output) {
    if (output instanceof Uint8Array)
        return Buffer.from(output).toString("base64");
    if (Array.isArray(output))
        return output.map(String).sort().join(",");
    return String(output);
}
/**
 * True when a path escapes the workspace root, computed independently of the
 * implementation (node:path + `..` depth). The escape exemption must not be
 * granted just because the synthetic rung labelled something
 * `WORKSPACE_PATH_ESCAPES` — that would let a wrongly-rejecting rung hide
 * behind its own error string (S4).
 */
export function escapesByPath(path) {
    if (isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path))
        return true;
    let depth = 0;
    for (const raw of path.replace(/\\/g, "/").split("/")) {
        if (!raw || raw === ".")
            continue;
        if (raw === "..") {
            if (depth === 0)
                return true;
            depth--;
        }
        else {
            depth++;
        }
    }
    return false;
}
export function diffOutcomes(oracle, synthetic) {
    const diffs = [];
    for (let i = 0; i < Math.max(oracle.length, synthetic.length); i++) {
        const a = oracle[i];
        const b = synthetic[i];
        if (!a || !b) {
            diffs.push({ index: i, kind: "other", detail: "length mismatch" });
            continue;
        }
        if (a.ok === b.ok && a.category === b.category && a.outputBytes === b.outputBytes)
            continue;
        // Exempt only by the path's own shape, never by the synthetic error string.
        const escape = escapesByPath(a.path);
        diffs.push({
            index: i,
            kind: escape ? "escape" : "other",
            detail: `#${i} ${a.kind} ${a.path}: oracle=${JSON.stringify({ ok: a.ok, error: a.error, out: a.outputBytes })} synthetic=${JSON.stringify({ ok: b.ok, error: b.error, out: b.outputBytes })}`,
        });
    }
    return diffs;
}
export function makeSyntheticExecutor() {
    const workspace = new MemoryWorkspace();
    return { executor: new SyntheticExecutor(new Map([[workspace.id, workspace]])), workspace };
}
