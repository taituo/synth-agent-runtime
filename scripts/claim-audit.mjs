#!/usr/bin/env node
/**
 * The durable claim audit.
 *
 * The adversarial audit used to live only in `/tmp`, so a reboot lost it. This
 * commits the durable part: a curated registry mapping a capability claim (from
 * the README/docs) to the executed artifact that backs it, plus the
 * reconciliation checks (doc path references, measured README numbers, the
 * untracked-dist hygiene rule). A claim whose artifact is missing, or no longer
 * contains the pinned behaviour, is a finding.
 *
 *   node scripts/claim-audit.mjs                 # static audit
 *   node scripts/claim-audit.mjs --live          # also run the live proofs (skip=2)
 *   node scripts/claim-audit.mjs --json
 *   node scripts/claim-audit.mjs --root-tap=F --temporal-tap=F --syntax-json=F
 *
 * Exit codes (the repo's skip contract):
 *   0 -> every claim has its artifact and every reconciliation holds
 *   1 -> a claim has no artifact / drifted (a finding)
 *   2 -> something could not be checked (missing infra for --live, or no suite
 *        output to reconcile the README against); a skip is never a pass
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareNumbers, parseSyntax, parseTap, readReadmeNumbers } from "./readme-numbers.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(resolve(ROOT, rel), "utf8");

function sourceFiles(dirs) {
  const out = [];
  const walk = (abs, rel) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
      const childRel = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(resolve(abs, entry.name), childRel);
      else if (entry.name.endsWith(".ts")) out.push(childRel);
    }
  };
  for (const dir of dirs) walk(resolve(ROOT, dir), dir);
  return out;
}

/** A claim: a capability the docs assert, and the artifact that proves it. */
const CLAIMS = [
  {
    id: "one-turn-body",
    claim: "one turn body: the shared engine is the only URL builder for the chat request",
    artifact: "src/runtime/gateway-engine.ts",
    contains: /v1\/chat\/completions/,
    check: () =>
      sourceFiles(["src", "integrations"])
        .filter((rel) => rel !== "src/runtime/gateway-engine.ts")
        .filter((rel) => !rel.includes("/dist/") && !/\/test\/|\.test\.ts$|\/fixtures\//.test(rel))
        .filter((rel) => /this\.#url\s*=|new URL\([^)]*v1\/chat\/completions/.test(read(rel)) && /v1\/chat\/completions/.test(read(rel)))
        .map((rel) => `another chat-URL builder: ${rel}`),
  },
  {
    id: "durable-agent-workflow",
    claim: "durableAgentWorkflow owns the agent loop and mailbox lifecycle",
    artifact: "integrations/temporal/src/workflows.ts",
    contains: /export async function durableAgentWorkflow/,
  },
  {
    id: "turn-per-activity",
    claim: "the gym workflow owns the loop, one gymRunTurn activity per turn",
    artifact: "integrations/temporal/src/gym-workflows.ts",
    contains: /gymRunTurn/,
    check: () =>
      read("test/gym-durable-path.test.ts").includes("the gym workflow owns its loop")
        ? []
        : ["test/gym-durable-path.test.ts no longer pins the gym-owned loop"],
  },
  {
    id: "one-worker-entry",
    claim: "one production worker entry registers the runtime and the gym on one queue",
    artifact: "integrations/temporal/src/worker-entry.ts",
    check: () => {
      const text = read("integrations/temporal/src/worker-entry.ts");
      const missing = [];
      if (!text.includes("createGymActivities()")) missing.push("does not register the gym activities");
      if (!/workflowsPath[\s\S]*workflows-all/.test(text)) missing.push("does not bundle workflows-all");
      if (!/maxConcurrentActivityTaskExecutions/.test(text)) missing.push("does not expose the concurrency options");
      return missing;
    },
  },
  {
    id: "one-scored-rung-rule",
    claim: "one scored-rung rule: both guards delegate to scoredRungAllowed",
    artifact: "src/execution/scored-rung.ts",
    contains: /export function scoredRungAllowed/,
    check: () => {
      const findings = [];
      if (!/scoredRungAllowed\(/.test(read("src/gym/runner.ts"))) findings.push("src/gym/runner.ts does not call the shared predicate");
      if (!/scoredRungAllowed\(/.test(read("integrations/temporal/src/gateway-run-turn.ts"))) findings.push("gateway-run-turn.ts does not call the shared predicate");
      for (const rel of sourceFiles(["src", "integrations"])) {
        if (!rel.includes("/dist/") && /scoredAllowed:\s*boolean/.test(read(rel))) findings.push(`a second isolation flag exists in ${rel}`);
      }
      return findings;
    },
  },
  {
    id: "gym-sandbox-one-rung",
    claim: "the gym's sandbox arm runs every effect in the pod (one rung)",
    artifact: "integrations/gym/sandbox.ts",
    contains: /SandboxWorkspaceExecutor/,
    check: () => (/new SyntheticExecutor/.test(read("integrations/gym/sandbox.ts")) ? ["still builds a SyntheticExecutor"] : []),
  },
  {
    id: "scorer-env-allowlist",
    claim: "the scoring worker inherits a minimal env, not the verifier's",
    artifact: "src/gym/scoring.ts",
    contains: /WORKER_ENV_ALLOWLIST/,
    check: () => (existsSync(resolve(ROOT, "test/gym-forge-channels.test.ts")) ? [] : ["test/gym-forge-channels.test.ts is missing"]),
  },
  {
    id: "shared-replace-in-text",
    claim: "replace_in_file / workspace.replace share one matching contract",
    artifact: "src/execution/text-replace.ts",
    contains: /export function replaceInText/,
    check: () =>
      ["src/gym/tools.ts", "src/execution/synthetic.ts", "src/execution/kubernetes/sandbox-workspace.ts"]
        .filter((rel) => !read(rel).includes("replaceInText"))
        .map((rel) => `${rel} does not use replaceInText`),
  },
  {
    id: "scored-flag-production-callers",
    claim: "production callers set scored:true for the gym",
    artifact: "integrations/gym/run-gym.ts",
    contains: /scored:\s*true/,
    check: () => (read("integrations/gym/p2-faults.ts").includes("scored: true") ? [] : ["p2-faults.ts does not set scored:true"]),
  },
  {
    id: "executor-image-pinned",
    claim: "the executor image is pinned by digest",
    artifact: "src/execution/executor-image.ts",
    contains: /ghcr\.io\/taituo\/synth-executor@sha256:[0-9a-f]{64}/,
  },
  {
    id: "effect-receipts-temporal-state",
    claim: "effect receipts live in Temporal activity state",
    artifact: "integrations/temporal/src/receipt-store.ts",
    contains: /TemporalActivityStateStore/,
  },
  {
    id: "supervisor-schedule",
    claim: "the session supervisor is started by a Temporal Schedule",
    artifact: "integrations/temporal/supervisor/schedule.ts",
    contains: /ensureSupervisorSchedule/,
  },
  {
    id: "postgres-concurrency-proof",
    claim: "the live Postgres concurrency/fencing proof exists",
    artifact: "integrations/postgres/concurrency.ts",
    contains: /SYNTH_POSTGRES_WORKERS/,
  },
  {
    id: "provider-agnostic",
    claim: "providers are configuration (any OpenAI-compatible backend)",
    artifact: "src/inference/gateway/provider-config.ts",
    contains: /providersFromEnv/,
  },
  {
    id: "isolation-probe",
    claim: "the scorer-isolation probe reports the actual boundary selection",
    artifact: "scripts/scorer-isolation-probe.mjs",
    contains: /sandboxScorerConfig/,
  },
  {
    id: "sandbox-boundary-tests",
    claim: "the gVisor pod boundary and the sandbox attempt are pinned by tests",
    artifact: "test/gym-sandbox-boundary.test.ts",
    check: () => (existsSync(resolve(ROOT, "test/gym-sandbox-attempt.test.ts")) ? [] : ["test/gym-sandbox-attempt.test.ts is missing"]),
  },
];

/** Live proofs `--live` may execute; a missing requirement is a skip. */
const LIVE = [
  { id: "gym-forge", command: ["node", ["--test", "dist/test/gym-forge.test.js", "dist/test/gym-forge-channels.test.js", "dist/test/text-replace.test.js"]] },
  { id: "graph-restart", command: ["node_modules/.bin/tsx", ["graph-restart-worker.ts"]], cwd: "integrations/temporal", requires: "temporal:7243" },
  { id: "effect-receipt", command: ["node_modules/.bin/tsx", ["effect-receipt-live.ts"]], cwd: "integrations/temporal", requires: "temporal:7243" },
  { id: "session-supervisor", command: ["node_modules/.bin/tsx", ["supervisor/live.ts"]], cwd: "integrations/temporal", requires: "temporal:7244+tmux" },
  { id: "gym-sandbox-attempt", command: ["node", ["--test", "dist/test/gym-sandbox-attempt.test.js"]], requires: "live-gvisor" },
];

/**
 * Reconciliation: every backtick repo path cited by a current README/docs file
 * must exist. Historical docs (from `docs/README.md`'s classification) and
 * explicit dead/removed mentions are out of scope.
 */
function pathReconciliation() {
  const index = read("docs/README.md");
  const historical = new Set(
    [...index.matchAll(/\[`?([A-Za-z0-9._/-]+\.md)`?\]\([^)]+\) — \*historical\*/g)].map((m) => `docs/${m[1]}`),
  );
  const files = ["README.md", ...readdirSync(resolve(ROOT, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`)]
    .filter((f) => !historical.has(f) && !f.startsWith("docs/history/"));
  // Deliberate mentions of removed paths, each flagged as gone in the same section.
  const allow = new Set([
    "docs/EXECUTION-PATHS.md->scripts/chaos-matrix.mjs",
    "docs/EXECUTION-PATHS.md->src/observability/trace.ts",
    "docs/KNOWN-OPEN.md->integrations/pi-runtime-bridge",
  ]);
  const roots = ["", "integrations/temporal/", "integrations/opencode-http-gateway/", "integrations/gym/", "integrations/kubernetes/", "integrations/postgres/"];
  const re = /`((?:src|integrations|test|scripts|docs|deploy|examples)\/[A-Za-z0-9._/-]+)`/g;
  const findings = [];
  for (const file of files) {
    const text = read(file);
    let match;
    while ((match = re.exec(text))) {
      const token = match[1].replace(/:.*$/, "");
      const path = token.replace(/\/$/, "");
      if (allow.has(`${file}->${token}`) || allow.has(`${file}->${path}`)) continue;
      if (roots.some((root) => existsSync(resolve(ROOT, root + path)))) continue;
      findings.push(`${file} cites a missing path: ${token}`);
    }
  }
  return findings;
}

/** Reconciliation: the root dist/ and every integration package's dist/ are untracked. */
function distReconciliation() {
  const all = spawnSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).stdout.split("\n").filter(Boolean);
  const findings = [];
  const rootDist = all.filter((path) => path.startsWith("dist/"));
  if (rootDist.length > 0) findings.push(`root dist/ is tracked (${rootDist.length} files)`);
  const integrationDist = all.filter((path) => path.startsWith("integrations/") && path.includes("/dist/"));
  if (integrationDist.length > 0) findings.push(`an integrations/*/dist path is tracked (${integrationDist.length} files)`);
  return findings;
}

function portOpen(host, port) {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host, port });
    socket.setTimeout(700);
    socket.once("connect", () => { socket.destroy(); resolvePromise(true); });
    socket.once("error", () => resolvePromise(false));
    socket.once("timeout", () => { socket.destroy(); resolvePromise(false); });
  });
}

async function infraAvailable(requires) {
  for (const token of requires.split("+")) {
    if (token.startsWith("temporal:")) {
      const port = Number(token.slice("temporal:".length));
      if (!(await portOpen("127.0.0.1", port))) return false;
    } else if (token === "tmux") {
      if (spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0) return false;
    } else if (token === "live-gvisor") {
      if (process.env.SYNTH_LIVE_GVISOR !== "1" || !process.env.SYNTH_EXECUTOR_IMAGE) return false;
    }
  }
  return true;
}

function arg(name) {
  const hit = process.argv.slice(2).find((value) => value.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function main() {
  const asJson = process.argv.includes("--json");
  const live = process.argv.includes("--live");
  const findings = [];
  const checked = [];
  const skipped = [];

  for (const claim of CLAIMS) {
    if (!existsSync(resolve(ROOT, claim.artifact))) {
      findings.push(`${claim.id}: missing artifact ${claim.artifact}`);
      continue;
    }
    if (claim.contains && !claim.contains.test(read(claim.artifact))) {
      findings.push(`${claim.id}: ${claim.artifact} no longer contains ${claim.contains}`);
      continue;
    }
    if (claim.check) findings.push(...claim.check().map((finding) => `${claim.id}: ${finding}`));
    checked.push(claim.id);
  }

  findings.push(...pathReconciliation().map((f) => `path: ${f}`));
  findings.push(...distReconciliation().map((f) => `dist: ${f}`));

  const rootTap = arg("root-tap");
  const temporalTap = arg("temporal-tap");
  const syntaxJson = arg("syntax-json");
  if (rootTap || temporalTap || syntaxJson) {
    const measured = {
      ...(rootTap ? { root: parseTap(readFileSync(rootTap, "utf8")) } : {}),
      ...(temporalTap ? { temporal: parseTap(readFileSync(temporalTap, "utf8")) } : {}),
      ...(syntaxJson ? { syntax: parseSyntax(readFileSync(syntaxJson, "utf8")) } : {}),
    };
    findings.push(...compareNumbers(readReadmeNumbers(), measured).map((f) => `readme: ${f}`));
    checked.push("readme-numbers");
  } else {
    const result = spawnSync("node", ["scripts/readme-numbers.mjs"], { cwd: ROOT, stdio: "inherit" });
    if (result.status === 0) checked.push("readme-numbers");
    else if (result.status === 2) skipped.push("readme-numbers (no measurement)");
    else findings.push("readme-numbers: README does not match the measured run");
  }

  if (live) {
    for (const proof of LIVE) {
      if (proof.requires && !(await infraAvailable(proof.requires))) {
        skipped.push(`live:${proof.id} (${proof.requires})`);
        continue;
      }
      const result = spawnSync(proof.command[0], proof.command[1], {
        cwd: proof.cwd ? resolve(ROOT, proof.cwd) : ROOT,
        stdio: "inherit",
        env: process.env,
      });
      if (result.status === 0) checked.push(`live:${proof.id}`);
      else if (result.status === 2) skipped.push(`live:${proof.id}`);
      else findings.push(`live:${proof.id} failed (exit ${result.status})`);
    }
  }

  const summary = { checked, skipped, findings };
  if (asJson) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`claim-audit: ${checked.length} checked, ${skipped.length} skipped, ${findings.length} finding(s)`);
    for (const finding of findings) console.log(`  FINDING ${finding}`);
    for (const skip of skipped) console.log(`  SKIP    ${skip}`);
  }
  if (findings.length > 0) process.exit(1);
  if (skipped.length > 0) process.exit(2);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
