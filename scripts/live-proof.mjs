import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";

const results = [];
function run(name, command, args, options = {}) {
  const started = Date.now();
  const result = spawnSync(command, args, { stdio: "inherit", env: process.env, ...options });
  const ok = result.status === 0;
  results.push({ name, status: ok ? "PASS" : "FAIL", ms: Date.now() - started });
  if (!ok) throw new Error(`${name} failed with exit ${result.status}`);
}
function commandExists(name) {
  const result = spawnSync("sh", ["-lc", `command -v ${name}`], { stdio: "ignore" });
  return result.status === 0;
}
async function exists(path) {
  try { await access(path, constants.F_OK); return true; } catch { return false; }
}
function skip(name, reason) { results.push({ name, status: "SKIP", reason }); }
function portOpen(host, port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    socket.setTimeout(800);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
  });
}

run("core build + unit/contracts", "npm", ["test"]);
run("integration syntax", "node", ["scripts/check-integrations.mjs"]);
run("Temporal integration suite", "npm", ["test", "--prefix", "integrations/temporal"]);
run("Responses contracts", "npm", ["run", "responses:contract"]);

// The durable SIGKILL/restart proof (attempts [1, >=2]) is the durability
// evidence; it needs a Temporal server and skips honestly without one.
const [temporalHost, temporalPort] = (process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7243")
  .replace(/^\w+:\/\//, "")
  .split(":");
if (await portOpen(temporalHost, Number(temporalPort))) {
  run("Temporal worker-restart proof", "npm", ["run", "live:restart", "--prefix", "integrations/temporal"]);
} else {
  skip("Temporal worker-restart proof", `temporal ${temporalHost}:${temporalPort} not reachable`);
}

if (process.env.SYNTH_POSTGRES_URL) {
  if (await exists("integrations/postgres/node_modules")) {
    run("live Postgres smoke", "npm", ["run", "smoke"], { cwd: "integrations/postgres" });
    run("live Postgres concurrency", "npm", ["run", "concurrency"], { cwd: "integrations/postgres" });
  } else skip("live Postgres", "SYNTH_POSTGRES_URL is set but integrations/postgres/node_modules is absent; run npm install there first");
} else skip("live Postgres", "SYNTH_POSTGRES_URL not set");

if (process.env.PI_REPO) {
  if (await exists(`${process.env.PI_REPO}/packages/agent/package.json`)) {
    run("install Pi RAM E2E", "bash", ["integrations/pi-e2e/install-memory-test.sh", process.env.PI_REPO]);
    run("Pi RAM E2E", "pnpm", ["vitest", "packages/agent/test/synth-runtime-memory.e2e.test.ts"], { cwd: process.env.PI_REPO });
  } else skip("Pi E2E", `PI_REPO does not look like a Pi checkout: ${process.env.PI_REPO}`);
} else skip("Pi E2E", "PI_REPO not set");

if (process.env.SYNTH_K8S_LIVE === "1") {
  if (!commandExists("kubectl")) skip("live Kubernetes Pod kill", "kubectl is not installed");
  else if (!process.env.SYNTH_EXECUTOR_IMAGE) skip("live Kubernetes Pod kill", "SYNTH_EXECUTOR_IMAGE not set");
  else if (await exists("integrations/kubernetes/node_modules/.bin/tsx")) {
    run("live Kubernetes Pod kill", "integrations/kubernetes/node_modules/.bin/tsx", ["integrations/kubernetes/kill-chaos.ts"]);
  } else skip("live Kubernetes Pod kill", "tsx is not installed; run npm install in integrations/kubernetes first");
} else skip("live Kubernetes Pod kill", "SYNTH_K8S_LIVE != 1");

if (process.env.SYNTH_GATEWAY_URL) run("live gateway probe", "node", ["integrations/opencode-live/probe.mjs"]);
else skip("live gateway probe", "SYNTH_GATEWAY_URL not set");

console.log("\n=== LIVE PROOF SUMMARY ===");
for (const item of results) console.log(`${item.status.padEnd(4)} ${item.name}${item.reason ? ` — ${item.reason}` : ""}${item.ms ? ` (${item.ms}ms)` : ""}`);
if (results.some((item) => item.status === "FAIL")) process.exit(1);
