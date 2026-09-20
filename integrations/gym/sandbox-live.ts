/**
 * Live proof that the gVisor sandbox runner actually executes agent code.
 *
 * Before this fix the sandbox path was dead: `run_visible_test` invoked the host
 * node path (exit 127, "not found") and the Pod's git refused the
 * control-plane-materialized workspace ("detected dubious ownership"). This
 * script drives the real `buildSandboxRunner` + `createGymTools` path against a
 * live gVisor Pod and asserts:
 *
 *   1. the Pod is running under gVisor (`uname -r`),
 *   2. the Pod has its own `node` (a node+git image, pinned by digest),
 *   3. the Pod's git accepts `/workspace` (no dubious-ownership refusal),
 *   4. `run_visible_test` executes in the Pod and reports the real (failing)
 *      result on the bugged checkout — not a 127 "not found",
 *   5. after the fix is written through the runner, the Pod's node runs the
 *      fixed code and the test passes.
 *
 * Zero model calls. The image MUST contain both node and git — the Pod runs the
 * agent's `run_visible_test` itself, so a git-only image (e.g. alpine/git) has no
 * `node` and the tool dies at exit 127. Pinned node+git image used here:
 *
 *   docker.io/library/node:22-bookworm@sha256:dd5847a04b0deee391fa145f1f4c6d214196668b6bcc7988ebed67249f226844
 *
 * Run:
 *   SYNTH_EXECUTOR_IMAGE=docker.io/library/node:22-bookworm@sha256:<digest> \
 *   SYNTH_FIXTURE_REPOS=/tmp/opencode/fixture-repos \
 *   SYNTH_KUBERNETES_NAMESPACE=synth-audit-gvisor SYNTH_RUNTIME_CLASS=gvisor \
 *   integrations/temporal/node_modules/.bin/tsx integrations/gym/sandbox-live.ts
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGymTools, loadGymTask, materializeGymTask } from "../../src/index.js";
import { buildSandboxRunner } from "./sandbox.js";

const TASK_DIR = "test/fixtures/gym-tasks/he/hex-decode";
const BUGGED = "parseInt(hexDigits, 10)";
const FIXED = "parseInt(hexDigits, 16)";

function require_(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`ok - ${message}`);
}

async function main(): Promise<void> {
  const image = process.env.SYNTH_EXECUTOR_IMAGE;
  if (!image) {
    throw new Error(
      "SYNTH_EXECUTOR_IMAGE is required: a node+git image pinned by digest, e.g. " +
        "docker.io/library/node:22-bookworm@sha256:dd5847a04b0deee391fa145f1f4c6d214196668b6bcc7988ebed67249f226844 " +
        "(alpine/git has git but no node, so run_visible_test exits 127).",
    );
  }
  console.log(`image: ${image}`);

  const task = await loadGymTask(TASK_DIR);
  const work = await mkdtemp(join(tmpdir(), "gym-sandbox-live-"));
  const materialized = await materializeGymTask({
    task,
    workDir: work,
    ...(process.env.SYNTH_FIXTURE_REPOS ? { fixtureCacheDir: process.env.SYNTH_FIXTURE_REPOS } : {}),
  });
  const sandbox = await buildSandboxRunner({
    repoDir: materialized.repoDir,
    image,
    namespace: process.env.SYNTH_KUBERNETES_NAMESPACE ?? "synth-audit-gvisor",
    runtimeClassName: process.env.SYNTH_RUNTIME_CLASS ?? "gvisor",
    agentId: "gym-sandbox-live",
  });
  try {
    const runner = sandbox.runner;

    const uname = await runner.exec("uname -r", { timeoutMs: 60_000 });
    require_(uname.code === 0 && uname.stdout.includes("gvisor"), `the Pod is isolated by gVisor (uname: ${uname.stdout.trim()})`);

    const node = await runner.exec("node --version", { timeoutMs: 60_000 });
    if (!(node.code === 0 && /^v\d+/.test(node.stdout.trim()))) {
      throw new Error(
        `FAIL: the Pod has no node (exit ${node.code}, stdout ${JSON.stringify(node.stdout.trim())}). ` +
          "The executor image must contain BOTH node and git; run_visible_test invokes the Pod's node. " +
          "Use docker.io/library/node:22-bookworm@sha256:dd5847a04b0deee391fa145f1f4c6d214196668b6bcc7988ebed67249f226844 " +
          "(alpine/git has git but no node — this is the original exit 127).",
      );
    }
    console.log(`ok - the Pod has its own node (${node.stdout.trim()})`);

    const git = await runner.exec("git -C /workspace rev-parse HEAD", { timeoutMs: 60_000 });
    require_(git.code === 0 && /^[0-9a-f]{40}$/.test(git.stdout.trim()), "the Pod's git accepts the control-plane workspace");

    const tools = createGymTools(runner, {
      visibleTestPath: task.visibleTestPath,
      visibleTestNodeBin: "node",
    });

    const before = await tools.execute({ name: "run_visible_test" });
    require_(
      before.exitCode === 1 && !before.observation.includes("not found"),
      "run_visible_test executes in the Pod and fails on the bugged checkout (exit 1, not 127)",
    );

    const edit = await tools.execute({
      name: "replace_in_file",
      arguments: { path: "he.js", old_text: BUGGED, new_text: FIXED },
    });
    require_(edit.ok, "the agent's edit is applied through the runner");

    const after = await tools.execute({ name: "run_visible_test" });
    require_(
      after.exitCode === 0,
      "the Pod's node runs the fixed code and the visible test passes (agent code really executed)",
    );

    console.log("\nsandbox runner: PASS (gVisor, pod node, pod git, agent code executes)");
  } finally {
    await sandbox.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
