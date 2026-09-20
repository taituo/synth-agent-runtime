#!/usr/bin/env node
/**
 * List the models the configured gateway actually offers, with provenance.
 *
 * Discovery only: this makes no inference call, so it costs no quota and is safe
 * to run often. It deliberately does not filter — if the gateway reports a
 * model, it is shown, with the provider/profile it came from. A run that lists
 * nothing exits 2 rather than reporting success over an empty set.
 *
 *   SYNTH_GATEWAY_URL=http://127.0.0.1:8787 node scripts/models.mjs
 *   node scripts/models.mjs http://127.0.0.1:8787 --json
 */
const args = process.argv.slice(2);
const asJson = args.includes("--json");
const urlArg = args.find((arg) => !arg.startsWith("--"));
const base = urlArg ?? process.env.SYNTH_GATEWAY_URL ?? process.env.GATEWAY_URL;
if (!base) {
  console.error("Set SYNTH_GATEWAY_URL (or pass a URL) to list models.");
  process.exit(2);
}

const headers = {};
if (process.env.SYNTH_GATEWAY_BEARER) headers.authorization = `Bearer ${process.env.SYNTH_GATEWAY_BEARER}`;

let response;
try {
  response = await fetch(new URL("/v1/models", base), { headers, signal: AbortSignal.timeout(8000) });
} catch (error) {
  console.error(`gateway ${base} is not reachable: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
if (!response.ok) {
  console.error(`gateway ${base} /v1/models returned HTTP ${response.status}`);
  process.exit(2);
}

const body = await response.json();
const models = Array.isArray(body?.data) ? body.data : [];
if (asJson) {
  console.log(JSON.stringify({ gateway: base, count: models.length, models }, null, 2));
  process.exit(0);
}
if (models.length === 0) {
  console.error(`gateway ${base} lists no models`);
  process.exit(2);
}

const cols = ["id", "provider", "profile", "owned_by"];
const rows = models.map((model) => ({
  id: String(model.id ?? ""),
  provider: String(model.provider ?? model.owned_by ?? ""),
  profile: String(model.profile ?? ""),
  owned_by: String(model.owned_by ?? ""),
}));
const widths = Object.fromEntries(cols.map((col) => [col, Math.max(col.length, ...rows.map((row) => row[col].length))]));
console.log(cols.map((col) => col.padEnd(widths[col])).join("  "));
for (const row of rows) console.log(cols.map((col) => row[col].padEnd(widths[col])).join("  "));
console.log(`\n${rows.length} model(s) from ${base}`);
