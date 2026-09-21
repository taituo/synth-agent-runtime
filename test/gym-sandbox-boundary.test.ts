/**
 * Boundary regression tests for the sandbox agent path.
 *
 * These are the probes that were run by hand during review (audit6
 * `agent-reach-local2.mjs`, verify-merge `agent-gvisor-enum.ts`) turned into a
 * permanent test: an agent module executed inside the gVisor pod must NOT see
 * the host repo, the host `/tmp`, the host checkout, or the held-out vectors at
 * their real host path, and must NOT reach host TCP (Temporal) or the cluster
 * API / internet.
 *
 * The verifier's first gap was that the old probe only walked `/workspace`, so
 * `hiddenCases === null` also held on a host run and proved nothing. The probe
 * now reads the vectors at their ACTUAL host path (`test/fixtures/gym-tasks/**`
 * under the host checkout), and `assertBoundary` is exercised against BOTH the
 * local runner (must be rejected) and the pod (must pass). The local half runs
 * with no cluster, so the discrimination is checked in every suite run.
 *
 * Live cluster required for the pod half. Set SYNTH_LIVE_GVISOR=1 and
 * SYNTH_EXECUTOR_IMAGE (a node+git image pinned by digest) to run it; otherwise
 * it SKIPS rather than pretending. Skipped is not a pass.
 */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGymTask, localEffectRunner, materializeGymTask, GymFixtureUnavailableError, EXECUTOR_IMAGE } from "../src/index.js";
import { buildSandboxRunner } from "../integrations/gym/sandbox.js";

const HE_TASK = "test/fixtures/gym-tasks/he/hex-decode";
/** The host checkout the agent process runs in on the local arm. */
const HOST_CHECKOUT = process.cwd();
/** Where the held-out vectors actually live on the host. */
const HOST_VECTORS = join(HOST_CHECKOUT, "test/fixtures/gym-tasks/he/hex-decode/hidden.cases.json");
const HOST_REPO = "/home/tiny/projects/pisynth/synth-agent-runtime";
const HOST_NODE_IP = "10.91.1.1"; // k3s node / host, where Temporal and the gateway listen
const CLUSTER_API = "10.43.0.1";

function liveEnabled(): boolean {
  return process.env.SYNTH_LIVE_GVISOR === "1" && Boolean(process.env.SYNTH_EXECUTOR_IMAGE);
}

/** Runs inside the pod OR the local runner. Writes one JSON line to stdout. */
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
out.hostCheckout = existsSync(${JSON.stringify(HOST_CHECKOUT)});
out.hostTmpSentinel = existsSync(${JSON.stringify(sentinelPath)});

// The discriminating quantity: the vectors at their real host path. This is
// reachable from a host (local) run and must not be from the pod.
try {
  const text = readFileSync(${JSON.stringify(HOST_VECTORS)}, "utf8");
  out.hostVectorsReadable = text.length > 0;
  out.hostVectorsError = null;
} catch (error) {
  out.hostVectorsReadable = false;
  out.hostVectorsError = String(error && error.code ? error.code : error);
}

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
  setTimeout(() => { s.destroy(); res("TIMEOUT"); }, 1500);
});
out.hostTemporal = await tcp(${JSON.stringify(HOST_NODE_IP)}, 7233);
out.hostGateway = await tcp(${JSON.stringify(HOST_NODE_IP)}, 8787);
out.clusterApi = await tcp(${JSON.stringify(CLUSTER_API)}, 443);
out.internet = await tcp("1.1.1.1", 443);

console.log("GVPROBE:" + JSON.stringify(out));
`;
}

function parseProbe(stdout: string): Record<string, unknown> {
  const line = stdout.split("\n").find((entry) => entry.startsWith("GVPROBE:"));
  assert.ok(line, `probe produced no GVPROBE line; stdout=${stdout}`);
  return JSON.parse(line!.slice("GVPROBE:".length)) as Record<string, unknown>;
}

/** The boundary contract. Throws on a run that can see the host. */
function assertBoundary(probe: Record<string, unknown>): void {
  assert.equal(probe.gvisor, true, "the pod must be running under gVisor");
  assert.equal(probe.hostRepo, false, "the pod must not see the host repo");
  assert.equal(probe.hostCheckout, false, "the pod must not see the host checkout");
  assert.equal(probe.hostTmpSentinel, false, "the pod must not see the host /tmp sentinel");
  assert.equal(probe.hostVectorsReadable, false, "the pod must not read the held-out vectors at their host path");
  assert.equal(probe.hiddenCases, null, "the pod must not find hidden.cases.json in its workspace");
  assert.notEqual(probe.hostTemporal, "CONNECTED", "the pod must not reach the host Temporal port");
  assert.notEqual(probe.hostGateway, "CONNECTED", "the pod must not reach the host gateway port");
  assert.notEqual(probe.clusterApi, "CONNECTED", "the pod must not reach the cluster API");
  assert.notEqual(probe.internet, "CONNECTED", "the pod must not have open internet egress");
}

test("the boundary contract rejects a local run (it can read the host vectors)", async () => {
  // No cluster: run the SAME probe through the local runner. It must show the
  // host is reachable, and assertBoundary must throw on it. If this passes, the
  // pod assertions below are meaningful rather than vacuous.
  const dir = await mkdtemp(join(tmpdir(), "gym-boundary-local-"));
  const sentinel = join(dir, "host-sentinel.txt");
  await writeFile(sentinel, "host-only-secret");
  try {
    const runner = localEffectRunner(dir);
    await runner.write("probe.mjs", probeSource(sentinel));
    const local = parseProbe((await runner.exec("node probe.mjs", { timeoutMs: 60_000 })).stdout);

    assert.equal(local.hostVectorsReadable, true, "the local runner can read the held-out vectors at their host path");
    assert.equal(local.hostCheckout, true, "the local runner sees the host checkout");
    assert.equal(local.hostRepo, true, "the local runner sees the host repo");
    assert.throws(() => assertBoundary(local), /gVisor|must not/, "the boundary contract must reject a local run");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** A fully compliant pod probe: gVisor, host invisible, no host TCP. */
function compliantPodProbe(): Record<string, unknown> {
  return {
    gvisor: true,
    hostRepo: false,
    hostCheckout: false,
    hostTmpSentinel: false,
    hostVectorsReadable: false,
    hiddenCases: null,
    hostTemporal: "DENIED:ECONNREFUSED",
    hostGateway: "DENIED:ECONNREFUSED",
    clusterApi: "DENIED:ECONNREFUSED",
    internet: "DENIED:ECONNREFUSED",
  };
}

test("the boundary contract refuses two unsafe runs and allows the compliant pod (A/B/C)", () => {
  // A: an unisolated host run (gVisor absent, host visible).
  assert.throws(
    () => assertBoundary({ ...compliantPodProbe(), gvisor: false, hostRepo: true, hostCheckout: true }),
    /gVisor|must not/,
  );

  // B: a run that hides the host but is NOT under gVisor. Isolation is the
  // runtime class, not "looks like a pod", so the contract must still refuse it.
  assert.throws(() => assertBoundary({ ...compliantPodProbe(), gvisor: false }), /gVisor/);

  // C: the legitimate compliant pod is ALLOWED. Without this case the contract
  // could refuse everything and the two refusals above would prove nothing.
  assert.doesNotThrow(() => assertBoundary(compliantPodProbe()));
});

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
    const probe = parseProbe((await sandbox.runner.exec("node probe.mjs", { timeoutMs: 90_000 })).stdout);
    assert.equal(probe.hostVectorsReadable, false, "the pod must not read the held-out vectors at their host path");
    assertBoundary(probe);
  } finally {
    await sandbox?.close();
    await rm(work, { recursive: true, force: true });
    await rm(sentinel, { force: true });
  }
});
