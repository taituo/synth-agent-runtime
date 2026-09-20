/**
 * Git as the artifact transport (artifact-egress mechanism 2).
 *
 * The agent commits inside the sandbox and the runtime reads the result from a
 * bare repo it controls. Git is the only mechanism that preserves file modes
 * and symlinks for free (mode 120000 for a link, 100755 for an executable),
 * which the sandbox workspace-sync path flattens into regular files.
 *
 * A sandbox has no network to the runtime, so the "push" is a single-file
 * bundle: the sandbox runs `git bundle create`, base64-encodes it onto stdout
 * (kubectl exec stdout is text), and the runtime ingests it into a bare repo.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitTransportOptions {
  gitBin?: string;
}

/** Shell command the sandbox runs (cwd `/workspace`) to emit a base64 bundle. */
export function bundleExportCommand(ref = "HEAD"): string {
  return `git bundle create /tmp/synth-export.bundle ${ref} && base64 -w0 /tmp/synth-export.bundle`;
}

/**
 * Artifact-egress mechanism 3: a patch as a change proposal. `git diff` out as
 * text — small, reviewable, and mergeable by a human. Records file modes, so a
 * symlink or an executable bit survives the round trip.
 */
export function patchExportCommand(baseRef = "HEAD"): string {
  return `git diff ${baseRef}`;
}

async function withPatchFile<T>(patchText: string, run: (patchPath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "synth-patch-"));
  const patchPath = join(dir, "change.patch");
  await writeFile(patchPath, patchText);
  return run(patchPath);
}

/** True when `patchText` applies cleanly to the repo's current state. */
export async function applyPatchCheck(patchText: string, repoDir: string, options: GitTransportOptions = {}): Promise<boolean> {
  return withPatchFile(patchText, async (patchPath) => {
    try {
      await git(["-C", repoDir, "apply", "--check", patchPath], options);
      return true;
    } catch {
      return false;
    }
  });
}

/** Apply `patchText` to the repo's working tree. */
export async function applyPatch(patchText: string, repoDir: string, options: GitTransportOptions = {}): Promise<void> {
  await withPatchFile(patchText, async (patchPath) => {
    await git(["-C", repoDir, "apply", patchPath], options);
  });
}

/** Decode the base64 stdout of {@link bundleExportCommand} into bundle bytes. */
export function decodeBundleBase64(stdout: string): Buffer {
  return Buffer.from(stdout.replace(/\s+/g, ""), "base64");
}

async function git(args: string[], options: GitTransportOptions): Promise<string> {
  const { stdout } = await execFileAsync(options.gitBin ?? "git", args, { maxBuffer: 256 * 1024 * 1024 });
  return stdout;
}

/** Ingest a bundle file into a runtime-controlled bare repo; returns the commit. */
export async function ingestBundle(bundlePath: string, bareDir: string, options: GitTransportOptions = {}): Promise<string> {
  await mkdir(dirname(bareDir), { recursive: true });
  try {
    await git(["--git-dir", bareDir, "rev-parse", "--git-dir"], options);
  } catch {
    await git(["init", "--bare", "-q", bareDir], options);
  }
  await git(["--git-dir", bareDir, "fetch", "-q", bundlePath, "HEAD:refs/transport/head"], options);
  return (await git(["--git-dir", bareDir, "rev-parse", "refs/transport/head"], options)).trim();
}

/** The tree hash of a commit, as git computes it (independent of our code). */
export async function treeDigest(bareDir: string, commit: string, options: GitTransportOptions = {}): Promise<string> {
  return (await git(["--git-dir", bareDir, "rev-parse", `${commit}^{tree}`], options)).trim();
}

export interface TreeEntry {
  mode: string;
  type: string;
  objectId: string;
  path: string;
}

/** `git ls-tree -r -z` parsed into entries (mode preserved, including 120000). */
export async function listTreeEntries(bareDir: string, commit: string, options: GitTransportOptions = {}): Promise<TreeEntry[]> {
  const raw = await git(["--git-dir", bareDir, "ls-tree", "-r", "-z", commit], options);
  const entries: TreeEntry[] = [];
  for (const record of raw.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, objectId] = record.slice(0, tab).split(" ");
    if (mode && type && objectId) entries.push({ mode, type, objectId, path: record.slice(tab + 1) });
  }
  return entries;
}
