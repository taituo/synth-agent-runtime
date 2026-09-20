#!/usr/bin/env node
/**
 * One runner for every live proof: passed vs skipped per proof.
 *
 * There are more than twenty live proofs and none run automatically, so they
 * rot silently. This executes each one as a subprocess and maps its exit code:
 *   0 -> passed, 2 -> skipped (missing infra, by the repo's skip contract),
 *   anything else or a timeout -> failed.
 * A skip is never counted as a pass, and any failure makes the runner exit 1 so
 * it can gate CI.
 *
 *   node scripts/live-proofs.mjs --list
 *   node scripts/live-proofs.mjs                       # run all
 *   node scripts/live-proofs.mjs --only=retry-hint,replay
 *   node scripts/live-proofs.mjs --timeout=600000 --json
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(ROOT, "integrations/temporal/node_modules/.bin/tsx");
const TEMPORAL = "integrations/temporal";
const KUBERNETES = "integrations/kubernetes";
const POSTGRES = "integrations/postgres";

/** Every proof that exits (not long-running fixtures like flaky-gateway). */
const PROOFS = [
  { name: "live-proof", cwd: ".", runner: "node", script: "scripts/live-proof.mjs", requires: "gateway" },
  { name: "lane-gateway", cwd: ".", runner: "tsx", script: "scripts/lane-gateway-live.ts", requires: "none" },
  { name: "litellm-failover", cwd: ".", runner: "tsx", script: "scripts/litellm-failover-live.ts", requires: "none" },

  { name: "interceptors", cwd: TEMPORAL, runner: "tsx", script: "interceptors-live.ts", requires: "temporal" },
  { name: "driver", cwd: TEMPORAL, runner: "tsx", script: "event-driver.ts", requires: "temporal" },
  { name: "swarm", cwd: TEMPORAL, runner: "tsx", script: "swarm-driver.ts", requires: "temporal" },
  { name: "swarm-inference", cwd: TEMPORAL, runner: "tsx", script: "swarm-inference-driver.ts", requires: "temporal+gateway+quota" },
  { name: "park", cwd: TEMPORAL, runner: "tsx", script: "park-live.ts", requires: "temporal" },
  { name: "corpus", cwd: TEMPORAL, runner: "tsx", script: "corpus-inference-driver.ts", requires: "temporal+gateway+quota" },
  { name: "corpus-compare", cwd: TEMPORAL, runner: "tsx", script: "corpus-model-compare.ts", requires: "temporal+gateway+quota" },
  { name: "rate-limit-scope", cwd: TEMPORAL, runner: "tsx", script: "rate-limit-scope.ts", requires: "gateway+quota" },
  { name: "mailbox-property", cwd: TEMPORAL, runner: "tsx", script: "mailbox-property-driver.ts", requires: "temporal" },
  { name: "replay", cwd: TEMPORAL, runner: "tsx", script: "replay-determinism.ts", requires: "temporal" },
  { name: "phases", cwd: TEMPORAL, runner: "tsx", script: "phase-signals-driver.ts", requires: "temporal" },
  { name: "restart", cwd: TEMPORAL, runner: "tsx", script: "restart-worker.ts", requires: "temporal" },
  { name: "durable-restart", cwd: TEMPORAL, runner: "tsx", script: "durable-restart-worker.ts", requires: "temporal" },
  { name: "graph-restart", cwd: TEMPORAL, runner: "tsx", script: "graph-restart-worker.ts", requires: "temporal" },
  { name: "waiting-spin", cwd: TEMPORAL, runner: "tsx", script: "waiting-spin-live.ts", requires: "temporal" },
  { name: "handoff", cwd: TEMPORAL, runner: "tsx", script: "artifact-handoff-live.ts", requires: "temporal" },
  { name: "retry-hint", cwd: TEMPORAL, runner: "tsx", script: "retry-hint-live.ts", requires: "temporal" },
  { name: "quota-exhausted", cwd: TEMPORAL, runner: "tsx", script: "quota-exhausted-live.ts", requires: "temporal" },
  { name: "openrouter-429", cwd: TEMPORAL, runner: "tsx", script: "openrouter-429-driver.ts", requires: "OPENROUTER_API_KEY" },
  { name: "session-supervisor", cwd: TEMPORAL, runner: "tsx", script: "supervisor/live.ts", requires: "tmux+separate-temporal:7244" },

  { name: "fault-rungs", cwd: KUBERNETES, runner: "tsx", script: "fault-rungs.ts", requires: "k8s+gvisor" },
  { name: "sandbox-workspace", cwd: KUBERNETES, runner: "tsx", script: "sandbox-workspace-live.ts", requires: "k8s+gvisor" },
  { name: "git-transport", cwd: KUBERNETES, runner: "tsx", script: "git-transport-live.ts", requires: "k8s+gvisor" },
  { name: "kill-chaos", cwd: KUBERNETES, runner: "tsx", script: "kill-chaos.ts", requires: "k8s+gvisor" },
  { name: "mixed-chain", cwd: KUBERNETES, runner: "tsx", script: "mixed-chain.ts", requires: "k8s+gvisor" },

  { name: "postgres-concurrency", cwd: POSTGRES, runner: "tsx", script: "concurrency.ts", requires: "postgres" },
  { name: "postgres-smoke", cwd: POSTGRES, runner: "tsx", script: "smoke.ts", requires: "postgres" },
];

function arg(name, fallback) {
  const hit = process.argv.slice(2).find((value) => value.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const asJson = process.argv.includes("--json");
const listOnly = process.argv.includes("--list");
const only = (arg("only", "") || "").split(",").map((value) => value.trim()).filter(Boolean);
const timeoutMs = Number(arg("timeout", "300000"));

const selected = only.length ? PROOFS.filter((proof) => only.includes(proof.name)) : PROOFS;

if (listOnly) {
  for (const proof of selected) console.log(`${proof.name.padEnd(22)} ${proof.runner.padEnd(4)} ${join(proof.cwd, proof.script).padEnd(50)} requires: ${proof.requires}`);
  console.log(`\n${selected.length} proof(s)`);
  process.exit(0);
}

function portOpen(host, port) {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host, port });
    socket.setTimeout(800);
    socket.once("connect", () => { socket.destroy(); resolvePromise(true); });
    socket.once("error", () => resolvePromise(false));
    socket.once("timeout", () => { socket.destroy(); resolvePromise(false); });
  });
}

function hostPort(value, fallback) {
  const url = value?.includes("://") ? new URL(value) : undefined;
  if (url) return { host: url.hostname, port: Number(url.port || (url.protocol === "https:" ? 443 : 80)) };
  const [host, port] = (value ?? fallback).replace(/^\w+:\/\//, "").split(":");
  return { host: host || "127.0.0.1", port: Number(port || fallback.split(":")[1]) };
}

/**
 * Preflight a proof's `requires` so missing infrastructure is an honest SKIP,
 * not a failure and not a silent pass. This is what makes CI meaningful with no
 * Temporal, gateway, cluster or Postgres present.
 */
async function missingInfra(requires) {
  for (const token of requires.split("+")) {
    if (token === "none" || token === "quota") continue;
    if (token === "temporal") {
      const { host, port } = hostPort(process.env.TEMPORAL_ADDRESS, "127.0.0.1:7243");
      if (!(await portOpen(host, port))) return `temporal ${host}:${port} not reachable`;
    } else if (token === "separate-temporal:7244") {
      if (!(await portOpen("127.0.0.1", 7244))) return "supervisor Temporal 127.0.0.1:7244 not reachable";
    } else if (token === "gateway") {
      const { host, port } = hostPort(process.env.GATEWAY_URL, "127.0.0.1:8787");
      if (!(await portOpen(host, port))) return `gateway ${host}:${port} not reachable`;
    } else if (token === "tmux") {
      try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); } catch { return "tmux not installed"; }
    } else if (token === "k8s" || token === "gvisor") {
      if (!process.env.SYNTH_EXECUTOR_IMAGE) return "SYNTH_EXECUTOR_IMAGE not set (no gVisor cluster)";
    } else if (token === "postgres") {
      if (!process.env.SYNTH_POSTGRES_URL) return "SYNTH_POSTGRES_URL not set";
    } else if (token === "OPENROUTER_API_KEY") {
      if (!process.env.OPENROUTER_API_KEY) return "OPENROUTER_API_KEY not set";
    }
  }
  return undefined;
}

function runProof(proof) {
  return new Promise((resolvePromise) => {
    const cwd = join(ROOT, proof.cwd);
    const bin = proof.runner === "node" ? process.execPath : TSX;
    const started = Date.now();
    let output = "";
    let timedOut = false;
    const child = spawn(bin, [proof.script], { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ proof, code: null, timedOut, durationMs: Date.now() - started, output: String(error) });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ proof, code, timedOut, durationMs: Date.now() - started, output });
    });
  });
}

if (!existsSync(TSX)) {
  console.error(`tsx not found at ${TSX}; install integration dependencies first`);
  process.exit(2);
}

const results = [];
for (const proof of selected) {
  const missing = await missingInfra(proof.requires);
  if (missing) {
    results.push({ proof, code: 2, timedOut: false, durationMs: 0, output: missing, status: "skipped" });
    if (!asJson) console.log(`${"skipped".padEnd(9)} ${proof.name.padEnd(22)} ${String(0).padStart(7)}ms  requires ${proof.requires}: ${missing}`);
    continue;
  }
  const result = await runProof(proof);
  const status = result.timedOut ? "timedout" : result.code === 0 ? "passed" : result.code === 2 ? "skipped" : "failed";
  results.push({ ...result, status });
  if (!asJson) {
    const tail = result.output.trim().split("\n").slice(-1)[0]?.slice(0, 90) ?? "";
    console.log(`${status.padEnd(9)} ${proof.name.padEnd(22)} ${String(result.durationMs).padStart(7)}ms  ${tail}`);
    if (status === "failed" || status === "timedout") {
      for (const line of result.output.trim().split("\n").slice(-30)) console.log(`    | ${line.slice(0, 200)}`);
    }
  }
}

const summary = results.reduce((acc, result) => { acc[result.status] = (acc[result.status] ?? 0) + 1; return acc; }, {});
const failures = (summary.failed ?? 0) + (summary.timedout ?? 0);
if (asJson) {
  console.log(JSON.stringify({ summary, results: results.map((r) => ({ name: r.proof.name, status: r.status, code: r.code, durationMs: r.durationMs, requires: r.proof.requires })) }, null, 2));
} else {
  console.log(`\npassed ${summary.passed ?? 0}  skipped ${summary.skipped ?? 0}  failed ${summary.failed ?? 0}  timedout ${summary.timedout ?? 0}  (of ${results.length})`);
  if ((summary.skipped ?? 0) > 0) console.log("a skip means its `requires` was unavailable; it is not a pass");
}
process.exit(failures > 0 ? 1 : 0);
