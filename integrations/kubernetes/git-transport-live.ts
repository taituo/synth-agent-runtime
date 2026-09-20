/**
 * Artifact-egress mechanism 2, live proof: git as the transport through a real
 * sandbox. Round-trips a Track 1 pinned repo (commander, which has a symlink)
 * through a gVisor sandbox that modifies it, exports a bundle, and asserts the
 * ingested tree hash equals what git computed in the sandbox — including a
 * symlink (120000), an executable bit (100755) and an unusual filename.
 *
 * Exit codes: 0 pass, 1 fail, 2 SKIP (no git-capable sandbox configured).
 *
 *   SYNTH_EXECUTOR_IMAGE=docker.io/alpine/git@sha256:0b5f57d2... \
 *   SYNTH_RUNTIME_CLASS=gvisor SYNTH_KUBERNETES_NAMESPACE=synth-audit-gvisor \
 *   npm run git-transport   # from integrations/kubernetes
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_KUBERNETES_RESOURCE_CLASSES,
  KubectlSandboxBackend,
  MemoryWorkspace,
  NativeGitSource,
  WorkspaceSynchronizer,
  bundleExportCommand,
  decodeBundleBase64,
  ingestBundle,
  listTreeEntries,
  treeDigest,
  type KubernetesResourceClass,
} from "../../src/index.js";

const image = process.env.SYNTH_EXECUTOR_IMAGE;
const namespace = process.env.SYNTH_KUBERNETES_NAMESPACE ?? "synth-audit-gvisor";
const context = process.env.SYNTH_KUBECTL_CONTEXT;
if (!image) {
  console.error(JSON.stringify({ skipped: true, reason: "SYNTH_EXECUTOR_IMAGE not set; needs a git-capable image pinned by digest" }));
  process.exit(2);
}

const fixtureRepo = process.env.SYNTH_FIXTURE_REPO ?? "/tmp/opencode/fixture-repos/commander.git";
const fixtureCommit = process.env.SYNTH_FIXTURE_COMMIT ?? "ba6d13ddb4243e5913367734f8c159089ffe7834";

const base = DEFAULT_KUBERNETES_RESOURCE_CLASSES.find((entry) => entry.id === "sandbox-small");
if (!base) throw new Error("sandbox-small resource class missing");
const resourceClass: KubernetesResourceClass = {
  ...base,
  image,
  runtimeClassName: process.env.SYNTH_RUNTIME_CLASS ?? base.runtimeClassName,
  warmPool: undefined,
};
const backend = new KubectlSandboxBackend({ namespace, context });

const sandbox = await backend.create(resourceClass);
const work = await mkdtemp(join(tmpdir(), "synth-git-transport-"));
let ok = false;
let source: NativeGitSource | undefined;
try {
  // Materialize the pinned real repo into the sandbox (this is the path that
  // flattens symlinks on the way back).
  source = await NativeGitSource.open({ gitDir: join(work, "source.git"), remote: fixtureRepo, ref: fixtureCommit });
  const workspace = new MemoryWorkspace({ source });
  const synchronizer = new WorkspaceSynchronizer(backend);
  await synchronizer.materialize(workspace, sandbox);

  // Modify inside the sandbox: symlink, executable, unusual filename.
  const safeDirectoryEnv = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "/workspace" };
  const modify = await backend.exec(sandbox, {
    env: safeDirectoryEnv,
    command: [
      "printf 'new\\n' > regular-new.txt",
      'ln -s regular-new.txt link-new',
      "printf '#!/bin/sh\\necho hi\\n' > script-new.sh && chmod 755 script-new.sh",
      'mkdir -p "dir with space" && printf odd > "dir with space/naïve--name.txt"',
      "git add -A && git commit -q -m sandbox-change",
      "git rev-parse HEAD^{tree}",
    ].join(" && "),
    timeoutMs: 120_000,
  });
  if (modify.exitCode !== 0) throw new Error(`sandbox modify failed: ${modify.stderr || modify.stdout}`);
  const sandboxTree = modify.stdout.trim().split("\n").pop()!.trim();

  // Export a bundle on stdout (base64) and ingest it into a runtime bare repo.
  const exported = await backend.exec(sandbox, { env: safeDirectoryEnv, command: bundleExportCommand("HEAD"), timeoutMs: 120_000 });
  if (exported.exitCode !== 0) throw new Error(`bundle export failed: ${exported.stderr}`);
  const bundlePath = join(work, "export.bundle");
  await writeFile(bundlePath, decodeBundleBase64(exported.stdout));
  const bare = join(work, "bare.git");
  const commit = await ingestBundle(bundlePath, bare);

  const ingestedTree = await treeDigest(bare, commit);
  const entries = await listTreeEntries(bare, commit);
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const symlinkPreserved = byPath.get("link-new")?.mode === "120000";
  const executablePreserved = byPath.get("script-new.sh")?.mode === "100755";
  const unusualName = byPath.has("dir with space/naïve--name.txt");
  const treeMatches = ingestedTree === sandboxTree;

  // Contrast: the workspace-sync return path flattens the symlink. Informational.
  const back = new MemoryWorkspace();
  await synchronizer.syncBack(back, sandbox).catch(() => undefined);
  const syncBackKind = (await back.stat("link-new"))?.kind ?? null;

  ok = treeMatches && symlinkPreserved && executablePreserved && unusualName;
  console.log(
    JSON.stringify(
      {
        image,
        fixture: { repo: fixtureRepo, commit: fixtureCommit },
        sandboxTree,
        ingestedTree,
        treeMatches,
        symlinkPreserved,
        executablePreserved,
        unusualName,
        workspaceSyncKindForSymlink: syncBackKind,
        ok,
      },
      null,
      2,
    ),
  );
} finally {
  await source?.close?.().catch(() => undefined);
  await backend.destroy(sandbox).catch(() => undefined);
  await rm(work, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
