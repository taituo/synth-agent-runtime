/**
 * Boundary regression tests for the sandbox agent path.
 *
 * An agent module executed inside the gVisor pod must NOT see the host repo, the
 * host checkout, the host `/tmp`, or the held-out vectors at their real host
 * path, and must NOT reach the host services (Temporal, the gateway), the
 * cluster API, or the internet.
 *
 * Two rules this file exists to honour (ORCH-BRIEF §5):
 *   - A negative assertion needs a positive control first. Before claiming "the
 *     pod cannot reach Y", the test proves Y IS reachable from the host, so the
 *     denial measures a lock rather than a closed door.
 *   - Every refusal needs two must-refuse cases and one must-succeed case. The
 *     rule functions are exercised directly with fabricated probes in every
 *     suite run, and against the real host/pod when available.
 *
 * Configuration (all machine-specific literals come from here; none are baked
 * in). Defaults are the values on a standard `tiny` bring-up.
 *   SYNTH_BOUNDARY_HOST_REPO        host repo path                 (default: cwd)
 *   SYNTH_BOUNDARY_HOST_TEMPORAL    host Temporal host:port        (default 127.0.0.1:7243)
 *   SYNTH_BOUNDARY_HOST_GATEWAY     host gateway host:port         (default 127.0.0.1:8787)
 *   SYNTH_BOUNDARY_CLUSTER_API      cluster API host:port          (default: derived from
 *                                   `kubectl get svc kubernetes`; set empty to drop)
 *   SYNTH_BOUNDARY_INTERNET         internet probe host:port       (default 1.1.1.1:443;
 *                                   set empty to drop on a no-egress host)
 *   SYNTH_BOUNDARY_NODE_IP          optional node-IP endpoints     (default: none; the
 *                                   host services bind loopback here, so a node-IP
 *                                   claim is only made when explicitly configured)
 *   SYNTH_KUBERNETES_NAMESPACE / SYNTH_RUNTIME_CLASS / SYNTH_EXECUTOR_IMAGE
 *
 * The live pod half needs a cluster: set SYNTH_LIVE_GVISOR=1 and
 * SYNTH_EXECUTOR_IMAGE (node+git image pinned by digest); otherwise it SKIPS.
 * Skipped is not a pass.
 */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, connect, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGymTask, localEffectRunner, materializeGymTask, GymFixtureUnavailableError, EXECUTOR_IMAGE } from "../src/index.js";
import { buildSandboxRunner } from "../integrations/gym/sandbox.js";

const HE_TASK = "test/fixtures/gym-tasks/he/hex-decode";

/** The checkout the agent process runs in on the local arm. Deliberately cwd. */
const HOST_CHECKOUT = process.cwd();
/** Where the held-out vectors actually live on the host. */
const HOST_VECTORS = join(HOST_CHECKOUT, "test/fixtures/gym-tasks/he/hex-decode/hidden.cases.json");
/** The host repo path the pod must not see. Configurable; defaults to cwd. */
const HOST_REPO = process.env.SYNTH_BOUNDARY_HOST_REPO ?? HOST_CHECKOUT;

const IMAGE = process.env.SYNTH_EXECUTOR_IMAGE ?? EXECUTOR_IMAGE;

function liveEnabled(): boolean {
  return process.env.SYNTH_LIVE_GVISOR === "1" && Boolean(process.env.SYNTH_EXECUTOR_IMAGE);
}

interface Target {
  key: string;
  host: string;
  port: number;
  /** What the claim means, for the failure message. */
  label: string;
}

function parseHostPort(value: string, fallbackHost: string, fallbackPort: number): { host: string; port: number } {
  const [host, port] = value.replace(/^\w+:\/\//, "").split(":");
  return { host: host || fallbackHost, port: Number(port || fallbackPort) };
}

function kubectlJsonpath(args: string[]): string | undefined {
  const result = spawnSync("kubectl", args, { encoding: "utf8", timeout: 5_000 });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
}

/** The cluster API, from env or derived from the live cluster. Empty env drops it. */
function clusterApiTarget(): Target | undefined {
  const configured = process.env.SYNTH_BOUNDARY_CLUSTER_API;
  if (configured === "") return undefined;
  const value = configured ?? kubectlJsonpath(["get", "svc", "kubernetes", "-o", "jsonpath={.spec.clusterIP}"]);
  if (!value) return undefined;
  const [host, port] = value.replace(/^\w+:\/\//, "").split(":");
  if (!host) return undefined;
  return { key: "clusterApi", host, port: Number(port || 443), label: "the cluster API" };
}

/** The internet endpoint; empty env drops the claim on a no-egress host. */
function internetTarget(): Target | undefined {
  const configured = process.env.SYNTH_BOUNDARY_INTERNET;
  if (configured === "") return undefined;
  const { host, port } = parseHostPort(configured ?? "1.1.1.1:443", "1.1.1.1", 443);
  return { key: "internet", host, port, label: "the internet" };
}

/**
 * The endpoints the pod must not reach, each with the host address a positive
 * control can reach. The host services bind loopback on this machine, so the
 * defaults are `127.0.0.1`, not the node IP (which had no listener and made the
 * old assertions vacuous — BRINGUP-PLAN §3.2). A node-IP claim is added only
 * when `SYNTH_BOUNDARY_NODE_IP` is set, so it cannot be asserted vacuously.
 */
function networkTargets(): Target[] {
  const temporal = parseHostPort(process.env.SYNTH_BOUNDARY_HOST_TEMPORAL ?? "127.0.0.1:7243", "127.0.0.1", 7243);
  const gateway = parseHostPort(process.env.SYNTH_BOUNDARY_HOST_GATEWAY ?? "127.0.0.1:8787", "127.0.0.1", 8787);
  const targets: Target[] = [
    { key: "hostTemporal", ...temporal, label: "the host Temporal" },
    { key: "hostGateway", ...gateway, label: "the host gateway" },
  ];
  const cluster = clusterApiTarget();
  if (cluster) targets.push(cluster);
  const internet = internetTarget();
  if (internet) targets.push(internet);
  const nodeIp = process.env.SYNTH_BOUNDARY_NODE_IP;
  if (nodeIp) {
    targets.push({ key: "nodeTemporal", host: nodeIp, port: temporal.port, label: "Temporal on the node IP" });
    targets.push({ key: "nodeGateway", host: nodeIp, port: gateway.port, label: "the gateway on the node IP" });
  }
  return targets;
}

const TARGETS = networkTargets();

/** Runs inside the pod OR the local runner. Writes one JSON line to stdout. */
function probeSource(sentinelPath: string, targets: readonly Target[]): string {
  return `
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";

const out = {};
try {
  const v = readFileSync("/proc/version", "utf8");
  out.gvisor = /gvisor/i.test(v);
} catch { out.gvisor = false; }

out.hostRepo = existsSync(${JSON.stringify(HOST_REPO)});
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
out.hiddenCases = walk("/workspace");

const tcp = (host, port) => new Promise((res) => {
  const s = connect(port, host);
  s.on("connect", () => { s.destroy(); res("CONNECTED"); });
  s.on("error", (e) => res("DENIED:" + e.code));
  setTimeout(() => { s.destroy(); res("TIMEOUT"); }, 1500);
});
out.net = {};
for (const target of ${JSON.stringify(targets.map((t) => ({ key: t.key, host: t.host, port: t.port })))}) {
  out.net[target.key] = await tcp(target.host, target.port);
}

console.log("GVPROBE:" + JSON.stringify(out));
`;
}

function parseProbe(stdout: string): Record<string, unknown> {
  const line = stdout.split("\n").find((entry) => entry.startsWith("GVPROBE:"));
  assert.ok(line, `probe produced no GVPROBE line; stdout=${stdout}`);
  return JSON.parse(line!.slice("GVPROBE:".length)) as Record<string, unknown>;
}

/** Probe one endpoint from wherever this runs; the shared reachability check. */
function probeTcp(host: string, port: number, timeoutMs = 1_500): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(port, host);
    let done = false;
    const finish = (value: string): void => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(value);
    };
    socket.on("connect", () => finish("CONNECTED"));
    socket.on("error", (error) => finish(`DENIED:${(error as NodeJS.ErrnoException).code ?? "ERROR"}`));
    socket.setTimeout(timeoutMs, () => finish("TIMEOUT"));
  });
}

/** Filesystem claims only, so each rule is independently assertable. */
function assertFilesystemBoundary(probe: Record<string, unknown>): void {
  assert.equal(probe.gvisor, true, "the pod must be running under gVisor");
  assert.equal(probe.hostRepo, false, "the pod must not see the host repo");
  assert.equal(probe.hostCheckout, false, "the pod must not see the host checkout");
  assert.equal(probe.hostTmpSentinel, false, "the pod must not see the host /tmp sentinel");
  assert.equal(probe.hostVectorsReadable, false, "the pod must not read the held-out vectors at their host path");
  assert.equal(probe.hiddenCases, null, "the pod must not find hidden.cases.json in its workspace");
}

/**
 * Network claims, each with its own positive control. `hostControls[key]` is
 * the host-side reachability measured first; if it is not CONNECTED the denial
 * would be vacuous, so the positive control fails the test rather than letting
 * an assertion pass for the wrong reason.
 */
function assertNetworkDenied(probe: Record<string, unknown>, hostControls: Record<string, string>, targets: readonly Target[] = TARGETS): void {
  const net = (probe.net ?? {}) as Record<string, string>;
  for (const target of targets) {
    assert.equal(
      hostControls[target.key],
      "CONNECTED",
      `positive control failed: ${target.label} (${target.host}:${target.port}) is not reachable from the host, so "the pod cannot reach it" cannot be asserted`,
    );
    assert.notEqual(
      net[target.key],
      "CONNECTED",
      `the pod must not reach ${target.label} (${target.host}:${target.port}); the host control confirmed it is live`,
    );
  }
}

/** Host-side reachability for every target, measured from this process. */
async function hostControls(): Promise<Record<string, string>> {
  const controls: Record<string, string> = {};
  for (const target of TARGETS) controls[target.key] = await probeTcp(target.host, target.port);
  return controls;
}

test("the network probe detects both an open and a closed endpoint (its control can fail)", async () => {
  // A probe that only ever reports DENIED would make every "must not reach"
  // assertion vacuous. Prove it reports CONNECTED for a listener we start, and
  // not for the same port once the listener is gone.
  const server: Server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    assert.equal(await probeTcp("127.0.0.1", port), "CONNECTED", "the probe must see a live listener");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  assert.notEqual(await probeTcp("127.0.0.1", port), "CONNECTED", "the probe must not call a closed port CONNECTED");
});

test("the network rule refuses a reachable run and accepts a denied one (two cases + control)", () => {
  const fakeTargets: Target[] = [
    { key: "a", host: "127.0.0.1", port: 1, label: "A" },
    { key: "b", host: "127.0.0.1", port: 2, label: "B" },
  ];
  const controls = { a: "CONNECTED", b: "CONNECTED" };
  // Must-refuse: the probe reached an endpoint the host can reach.
  assert.throws(() => assertNetworkDenied({ net: { a: "CONNECTED", b: "DENIED:ECONNREFUSED" } }, controls, fakeTargets), /must not reach A/);
  assert.throws(() => assertNetworkDenied({ net: { a: "DENIED:ECONNREFUSED", b: "CONNECTED" } }, controls, fakeTargets), /must not reach B/);
  // Must-refuse: a vacuous claim (host control itself failed) is not a pass.
  assert.throws(
    () => assertNetworkDenied({ net: { a: "DENIED:ECONNREFUSED", b: "DENIED:ECONNREFUSED" } }, { a: "CONNECTED", b: "TIMEOUT" }, fakeTargets),
    /positive control failed.*B/,
  );
  // Must-succeed: both endpoints denied with live host controls.
  assert.doesNotThrow(() => assertNetworkDenied({ net: { a: "DENIED:ECONNREFUSED", b: "DENIED:ECONNREFUSED" } }, controls, fakeTargets));
});

test("the filesystem rule refuses a host-visible run and accepts an isolated one (two cases + control)", () => {
  const podProbe = { gvisor: true, hostRepo: false, hostCheckout: false, hostTmpSentinel: false, hostVectorsReadable: false, hiddenCases: null };
  assert.doesNotThrow(() => assertFilesystemBoundary(podProbe), "an isolated probe must pass");
  assert.throws(() => assertFilesystemBoundary({ ...podProbe, gvisor: false }), /gVisor/, "a non-gVisor run must be refused");
  assert.throws(() => assertFilesystemBoundary({ ...podProbe, hostVectorsReadable: true }), /vectors/, "a run that reads the vectors must be refused");
});

test("the boundary contract rejects a local run (it can read the host vectors)", async () => {
  // No cluster: run the SAME probe through the local runner. It must show the
  // host is reachable, and the rules must reject it. When a network endpoint is
  // up, the local probe must see it too, so the probe's network read is real.
  const dir = await mkdtemp(join(tmpdir(), "gym-boundary-local-"));
  const sentinel = join(dir, "host-sentinel.txt");
  await writeFile(sentinel, "host-only-secret");
  try {
    const runner = localEffectRunner(dir);
    await runner.write("probe.mjs", probeSource(sentinel, TARGETS));
    const local = parseProbe((await runner.exec("node probe.mjs", { timeoutMs: 60_000 })).stdout);

    assert.equal(local.hostVectorsReadable, true, "the local runner can read the held-out vectors at their host path");
    assert.equal(local.hostCheckout, true, "the local runner sees the host checkout");
    assert.equal(local.hostRepo, true, "the local runner sees the host repo");
    assert.throws(() => assertFilesystemBoundary(local), /gVisor|must not/, "the boundary contract must reject a local run");

    for (const target of TARGETS) {
      const status = await probeTcp(target.host, target.port);
      if (status === "CONNECTED") {
        assert.equal(
          (local.net as Record<string, string>)[target.key],
          "CONNECTED",
          `the local runner must see ${target.label} when the host reaches it`,
        );
      }
    }
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
    () => assertFilesystemBoundary({ ...compliantPodProbe(), gvisor: false, hostRepo: true, hostCheckout: true }),
    /gVisor|must not/,
  );

  // B: a run that hides the host but is NOT under gVisor. Isolation is the
  // runtime class, not "looks like a pod", so the contract must still refuse it.
  assert.throws(() => assertFilesystemBoundary({ ...compliantPodProbe(), gvisor: false }), /gVisor/);

  // C: the legitimate compliant pod is ALLOWED. Without this case the contract
  // could refuse everything and the two refusals above would prove nothing.
  assert.doesNotThrow(() => assertFilesystemBoundary(compliantPodProbe()));
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
    // Positive controls FIRST: every endpoint must be reachable from the host,
    // otherwise the pod denial below proves nothing.
    const controls = await hostControls();

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
      image: IMAGE,
      ...(process.env.SYNTH_KUBERNETES_NAMESPACE ? { namespace: process.env.SYNTH_KUBERNETES_NAMESPACE } : {}),
      ...(process.env.SYNTH_RUNTIME_CLASS ? { runtimeClassName: process.env.SYNTH_RUNTIME_CLASS } : {}),
      agentId: "gym-boundary-test",
    });

    await sandbox.runner.write("probe.mjs", probeSource(sentinel, TARGETS));
    const probe = parseProbe((await sandbox.runner.exec("node probe.mjs", { timeoutMs: 90_000 })).stdout);
    // The probe ran inside the pod and returned its report: the must-succeed
    // control (the pod is not simply broken).
    assert.equal(probe.gvisor, true, "the pod must be running under gVisor");
    assertFilesystemBoundary(probe);
    assertNetworkDenied(probe, controls);
  } finally {
    await sandbox?.close();
    await rm(work, { recursive: true, force: true });
    await rm(sentinel, { force: true });
  }
});
