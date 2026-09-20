#!/usr/bin/env node
/**
 * The local verification set, in one command.
 *
 * Runs the static suites (root + Temporal), the integration syntax check, the
 * secret scan, and the Temporal live proofs. Exit codes follow the repo's skip
 * contract:
 *   0 -> every selected check passed
 *   1 -> a check failed
 *   2 -> a check was skipped (missing infra/credentials); a skip is never a pass
 *
 *   npm run verify                 # static set + the Temporal live proofs
 *   node scripts/verify.mjs --all-live   # also run every live proof (many skip)
 */
import { spawnSync } from "node:child_process";

/**
 * The Temporal-only proofs the CI job also runs. Every one needs only a
 * Temporal server, so a skip here means Temporal was unavailable and the run is
 * incomplete.
 */
const TEMPORAL_PROOFS = [
  "graph-restart",
  "durable-restart",
  "graph-child",
  "graph-continue-as-new",
  "graph-cancel",
  "effect-receipt",
].join(",");

const results = [];

function run(name, command, args, options = {}) {
  const started = Date.now();
  const result = spawnSync(command, args, { stdio: "inherit", env: process.env, ...options });
  const code = result.status ?? 1;
  const status = code === 0 ? "passed" : code === 2 ? "skipped" : "failed";
  results.push({ name, status, code, ms: Date.now() - started });
  return code;
}

const allLive = process.argv.includes("--all-live");

run("root suite", "npm", ["test"]);
run("temporal suite", "npm", ["test", "--prefix", "integrations/temporal"]);
run("integration syntax", "npm", ["run", "integrations:syntax"]);
run("secret scan", "npm", ["run", "secret-scan"]);
run("live proofs", "node", allLive
  ? ["scripts/live-proofs.mjs"]
  : ["scripts/live-proofs.mjs", `--only=${TEMPORAL_PROOFS}`, "--timeout=600000"]);

console.log("\n=== VERIFICATION SUMMARY ===");
for (const item of results) {
  console.log(`${item.status.padEnd(8)} ${item.name}${item.ms ? ` (${item.ms}ms)` : ""}`);
}
const failed = results.some((item) => item.status === "failed");
const skipped = results.some((item) => item.status === "skipped");
if (failed) process.exit(1);
if (skipped) process.exit(2);
process.exit(0);
