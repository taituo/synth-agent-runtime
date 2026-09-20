/**
 * Boundary regression tests for the sandbox agent path.
 *
 * These are the probes that were run by hand during review (audit6
 * `agent-reach-local2.mjs`, verify-merge `agent-gvisor-enum.ts`) turned into a
 * permanent test: an agent module executed inside the gVisor pod must NOT see
 * the host repo, the host `/tmp`, or the held-out vectors, and must NOT reach
 * host TCP (Temporal) or the cluster API.
 *
 * The local runner CAN see all of these — that is why a scored run is refused on
 * it (see `gym-runner-isolation.test.ts`). This is the sandbox half.
 *
 * Live cluster required. Set SYNTH_LIVE_GVISOR=1 and SYNTH_EXECUTOR_IMAGE (a
 * node+git image pinned by digest) to run; otherwise it SKIPS rather than
 * pretending. Skipped is not a pass.
 */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGymTask, materializeGymTask, GymFixtureUnavailableError, EXECUTOR_IMAGE } from "../src/index.js";
import { buildSandboxRunner } from "../integrations/gym/sandbox.js";

const HE_TASK = "test/fixtures/gym-tasks/he/hex-decode";
const HOST_REPO = "/home/tiny/projects/pisynth/synth-agent-runtime";
const HOST_NODE_IP = "10.91.1.1"; // k3s node / host, where Temporal and the gateway listen
const CLUSTER_API = "10.43.0.1";

function liveEnabled(): boolean {
  return process.env.SYNTH_LIVE_GVISOR === "1" && Boolean(process.env.SYNTH_EXECUTOR_IMAGE);
}

/** Runs inside the pod. Writes one JSON line to stdout. */
function probeSource(sentinelPath: string): string {
  return `
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";

const out = {};
try {
  const v = readFileSync("/proc/version", "utf8");
  out.gvisor = /gvisor/i.test(v);
} catch { out.gvisor = false; }

out.hostRepo = existsSync(${JSON.stringify(HOST_REPO)}) || existsSync("/home/tiny/projects/pisynth/gym-wt");
out.hostTmpSentinel = existsSync(${JSON.stringify(sentinelPath)});

let hidden = null;
const walk = (dir) => {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    const path = dir + "/" + entry.name;
    if (entry.isDirectory()) { const found = walk(path); if (found) return found; }
    else if (entry.name === "hidden.cases.json") return path;
  }
  return null;
};
hidden = walk("/workspace");
out.hiddenCases = hidden;

const tcp = (host, port) => new Promise((res) => {
  const s = connect(port, host);
  s.on("connect", () => { s.destroy(); res("CONNECTED"); });
  s.on("error", (e) => res("DENIED:" + e.code));
  setTimeout(() => { s.destroy(); res("TIMEOUT"); }, 2500);
});
out.hostTemporal = await tcp(${JSON.stringify(HOST_NODE_IP)}, 7233);
out.hostGateway = await tcp(${JSON.stringify(HOST_NODE_IP)}, 8787);
out.clusterApi = await tcp(${JSON.stringify(CLUSTER_API)}, 443);
out.internet = await tcp("1.1.1.1", 443);

console.log("GVPROBE:" + JSON.stringify(out));
`;
}

test("the gVisor pod cannot see the host, the vectors, or reach host TCP", async (t: TestContext) => {
  if (!liveEnabled()) {
    t.skip("set SYNTH_LIVE_GVISOR=1 and SYNTH_EXECUTOR_IMAGE to run the live sandbox boundary proof");
    return;
  }
  const sentinel = join(tmpdir(), `gym-sandbox-sentinel-${Date.now().toString(36)}.txt`);
  await writeFile(sentinel, "host-only-secret");
  const work = await mkdtemp(join(tmpdir(), "gym-sbx-boundary-"));
  let sandbox: Awaited<ReturnType<typeof buildSandboxRunner>> | undefined;
  try {
    let materialized;
    try {
      const task = await loadGymTask(HE_TASK);
      materialized = await materializeGymTask({
        task,
        workDir: work,
        ...(process.env.SYNTH_FIXTURE_REPOS ? { fixtureCacheDir: process.env.SYNTH_FIXTURE_REPOS } : {}),
      });
    } catch (error) {
      if (error instanceof GymFixtureUnavailableError) {
        t.skip(error.message);
        return;
      }
      throw error;
    }

    sandbox = await buildSandboxRunner({
      repoDir: materialized.repoDir,
      image: process.env.SYNTH_EXECUTOR_IMAGE ?? EXECUTOR_IMAGE,
      ...(process.env.SYNTH_KUBERNETES_NAMESPACE ? { namespace: process.env.SYNTH_KUBERNETES_NAMESPACE } : {}),
      ...(process.env.SYNTH_RUNTIME_CLASS ? { runtimeClassName: process.env.SYNTH_RUNTIME_CLASS } : {}),
      agentId: "gym-boundary-test",
    });

    await sandbox.runner.write("probe.mjs", probeSource(sentinel));
    const result = await sandbox.runner.exec("node probe.mjs", { timeoutMs: 90_000 });
    const line = result.stdout.split("\n").find((entry) => entry.startsWith("GVPROBE:"));
    assert.ok(line, `probe produced no GVPROBE line; exit ${result.code}, stdout ${result.stdout}, stderr ${result.stderr}`);
    const probe = JSON.parse(line!.slice("GVPROBE:".length)) as Record<string, unknown>;

    assert.equal(probe.gvisor, true, "the pod must be running under gVisor");
    assert.equal(probe.hostRepo, false, "the pod must not see the host repo");
    assert.equal(probe.hostTmpSentinel, false, "the pod must not see the host /tmp sentinel");
    assert.equal(probe.hiddenCases, null, "the pod must not find hidden.cases.json");
    assert.notEqual(probe.hostTemporal, "CONNECTED", "the pod must not reach the host Temporal port");
    assert.notEqual(probe.hostGateway, "CONNECTED", "the pod must not reach the host gateway port");
    assert.notEqual(probe.clusterApi, "CONNECTED", "the pod must not reach the cluster API");
    assert.notEqual(probe.internet, "CONNECTED", "the pod must not have open internet egress");
  } finally {
    await sandbox?.close();
    await rm(work, { recursive: true, force: true });
    await rm(sentinel, { force: true });
  }
});
