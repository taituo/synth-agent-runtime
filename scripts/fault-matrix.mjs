#!/usr/bin/env node
/**
 * One fault matrix: each dependency removed in turn, the same four questions.
 *
 *   1. is it retried?
 *   2. is data lost?
 *   3. is a human needed?
 *   4. can a side effect happen twice?
 *
 * This runner does not re-implement the probes. It shells out to the existing
 * fault scripts where they exist (`durable-restart-worker.ts`, `fault-rungs.ts`,
 * `retry-hint-live.ts`, `quota-exhausted-live.ts`, `effect-receipt-live.ts`) and
 * to the matrix probes added for the dependencies that had none
 * (`fault-temporal-server.ts`, `fault-postgres.ts`, `fault-gateway.ts`,
 * `fault-k8s-api.ts`, `fault-sandbox-pod.ts`).
 *
 * Every probe prints one JSON object; each is saved under the output directory
 * and its `questions` (when present) becomes the matrix row. A probe that exits
 * 2 is recorded as `skipped` — a skip is never a pass.
 *
 *   node scripts/fault-matrix.mjs
 *   node scripts/fault-matrix.mjs --out=/tmp/opencode/faults-1/run
 *   node scripts/fault-matrix.mjs --json
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(ROOT, "integrations/temporal/node_modules/.bin/tsx");
const TEMPORAL = process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7243";
const IMAGE = process.env.SYNTH_EXECUTOR_IMAGE ?? "ghcr.io/taituo/synth-executor@sha256:fc59cec2b7a3733e9e50db1d5063669c60ec7add0d18a338b2a3f19a422c822f";
const NAMESPACE = process.env.SYNTH_KUBERNETES_NAMESPACE ?? "synth-audit-gvisor";

const arg = (name, fallback) => {
  const hit = process.argv.slice(2).find((value) => value.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const outDir = arg("out", "/tmp/synth-fault-matrix");
const asJson = process.argv.includes("--json");
const only = (arg("only", "") || "").split(",").map((value) => value.trim()).filter(Boolean);
mkdirSync(outDir, { recursive: true });

const baseEnv = {
  ...process.env,
  TEMPORAL_ADDRESS: TEMPORAL,
  SYNTH_EXECUTOR_IMAGE: IMAGE,
  SYNTH_KUBERNETES_NAMESPACE: NAMESPACE,
};

/**
 * `dependency` groups cells; `requires` is only informative here. `env` is
 * merged over the base; `timeoutMs` bounds each probe.
 */
const PROBES = [
  { dependency: "temporal-server", name: "temporal-persistent", script: "integrations/temporal/fault-temporal-server.ts", args: ["--mode", "persistent", "--port", "7245"], timeoutMs: 180_000 },
  { dependency: "temporal-server", name: "temporal-inmemory", script: "integrations/temporal/fault-temporal-server.ts", args: ["--mode", "inmemory", "--port", "7246"], timeoutMs: 180_000 },
  { dependency: "postgres", name: "postgres-deny-port", script: "integrations/postgres/fault-postgres.ts", args: [], timeoutMs: 120_000 },
  { dependency: "gateway", name: "gateway-faults", script: "integrations/temporal/fault-gateway.ts", args: [], timeoutMs: 120_000 },
  { dependency: "gateway", name: "gateway-park-retry-hint", script: "integrations/temporal/retry-hint-live.ts", args: [], timeoutMs: 120_000 },
  { dependency: "gateway", name: "gateway-park-quota", script: "integrations/temporal/quota-exhausted-live.ts", args: [], timeoutMs: 120_000 },
  { dependency: "gateway", name: "gateway-fatal-4xx", script: "integrations/temporal/fault-gateway-fatal.ts", args: [], timeoutMs: 120_000 },
  { dependency: "kubernetes-api", name: "k8s-api-unreachable", script: "integrations/kubernetes/fault-k8s-api.ts", args: [], timeoutMs: 120_000 },
  { dependency: "sandbox-pod", name: "sandbox-killed-mid-exec", script: "integrations/kubernetes/fault-sandbox-pod.ts", args: [], timeoutMs: 300_000 },
  { dependency: "sandbox-pod", name: "sandbox-rung-faults", script: "integrations/kubernetes/fault-rungs.ts", args: [], timeoutMs: 300_000 },
  { dependency: "worker", name: "worker-sigkill", script: "integrations/temporal/durable-restart-worker.ts", args: [], timeoutMs: 300_000 },
  { dependency: "side-effects", name: "effect-receipt-dedup", script: "integrations/temporal/effect-receipt-live.ts", args: [], timeoutMs: 120_000 },
];

function parseJson(output) {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(output.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

const selected = only.length ? PROBES.filter((probe) => only.includes(probe.name) || only.includes(probe.dependency)) : PROBES;

const results = [];
for (const probe of selected) {
  const started = Date.now();
  const run = spawnSync(TSX, [probe.script, ...probe.args], {
    cwd: ROOT,
    env: { ...baseEnv, ...(probe.env ?? {}) },
    encoding: "utf8",
    timeout: probe.timeoutMs,
  });
  const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  const parsed = parseJson(run.stdout ?? "");
  const code = run.status ?? 1;
  const status = code === 0 ? "passed" : code === 2 ? "skipped" : "failed";
  const artifact = join(outDir, `${probe.name}.json`);
  writeFileSync(artifact, `${run.stdout ?? ""}\n`);
  results.push({
    dependency: probe.dependency,
    name: probe.name,
    status,
    code,
    ms: Date.now() - started,
    artifact,
    questions: parsed?.questions,
    skippedReason: code === 2 ? parseJson(output)?.reason : undefined,
    output: run.stdout ?? "",
  });
}

if (asJson) {
  console.log(JSON.stringify({ outDir, results: results.map(({ output, ...rest }) => rest) }, null, 2));
} else {
  console.log(`fault matrix -> ${outDir}\n`);
  for (const result of results) {
    const q = result.questions ?? {};
    const cells = ["retried", "dataLost", "humanNeeded", "sideEffectTwice"]
      .map((key) => `${key}=${q[key] === undefined ? "?" : q[key] === null ? "UNKNOWN" : q[key]}`)
      .join("  ");
    console.log(`${result.status.padEnd(8)} ${result.dependency.padEnd(16)} ${result.name.padEnd(26)} ${cells}${result.skippedReason ? `  (${result.skippedReason})` : ""}`);
  }
}

const failed = results.some((result) => result.status === "failed");
const skipped = results.some((result) => result.status === "skipped");
if (failed) process.exit(1);
if (skipped) process.exit(2);
process.exit(0);
