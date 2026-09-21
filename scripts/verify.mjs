#!/usr/bin/env node
/**
 * The local verification set, in one command.
 *
 * Runs the static suites (root + Temporal), the integration syntax check, the
 * secret scan, the README-number guard, the claim audit, and the Temporal live
 * proofs. Exit codes follow the repo's skip contract:
 *   0 -> every selected check passed
 *   1 -> a check failed
 *   2 -> a check was skipped (missing infra/credentials); a skip is never a pass
 *
 *   npm run verify                 # static set + the Temporal live proofs
 *   node scripts/verify.mjs --all-live   # also run every live proof (many skip)
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CAPTURE = mkdtempSync(join(tmpdir(), "synth-verify-"));
const rootTap = join(CAPTURE, "root.tap");
const temporalTap = join(CAPTURE, "temporal.tap");
const syntaxJson = join(CAPTURE, "syntax.json");

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

/**
 * Run a command, teeing stdout to the terminal and (when `capture` is set) to a
 * file so the README-number guard can reconcile against the same run.
 */
function run(name, command, args, options = {}) {
  const { capture, ...spawnOptions } = options;
  const started = Date.now();
  let stdout = "";
  const result = spawnSync(command, args, {
    stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit",
    env: process.env,
    ...spawnOptions,
  });
  if (capture) {
    stdout = result.stdout ?? "";
    process.stdout.write(stdout);
    writeFileSync(capture, stdout);
  }
  const code = result.status ?? 1;
  const status = code === 0 ? "passed" : code === 2 ? "skipped" : "failed";
  results.push({ name, status, code, ms: Date.now() - started });
  return code;
}

const allLive = process.argv.includes("--all-live");

run("root suite", "npm", ["test"], { cwd: ROOT, capture: rootTap });
run("temporal suite", "npm", ["test", "--prefix", "integrations/temporal"], { cwd: ROOT, capture: temporalTap });
run("integration syntax", "npm", ["run", "integrations:syntax"], { cwd: ROOT, capture: syntaxJson });
run("secret scan", "npm", ["run", "secret-scan"], { cwd: ROOT });
run("readme numbers", "node", [
  "scripts/readme-numbers.mjs",
  `--root-tap=${rootTap}`,
  `--temporal-tap=${temporalTap}`,
  `--syntax-json=${syntaxJson}`,
], { cwd: ROOT });
run("claim audit", "node", [
  "scripts/claim-audit.mjs",
  `--root-tap=${rootTap}`,
  `--temporal-tap=${temporalTap}`,
  `--syntax-json=${syntaxJson}`,
], { cwd: ROOT });
run("live proofs", "node", allLive
  ? ["scripts/live-proofs.mjs"]
  : ["scripts/live-proofs.mjs", `--only=${TEMPORAL_PROOFS}`, "--timeout=600000"], { cwd: ROOT });

console.log("\n=== VERIFICATION SUMMARY ===");
for (const item of results) {
  console.log(`${item.status.padEnd(8)} ${item.name}${item.ms ? ` (${item.ms}ms)` : ""}`);
}
const failed = results.some((item) => item.status === "failed");
const skipped = results.some((item) => item.status === "skipped");
if (failed) process.exit(1);
if (skipped) process.exit(2);
process.exit(0);
