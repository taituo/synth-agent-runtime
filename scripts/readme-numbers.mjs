#!/usr/bin/env node
/**
 * Guard: the README "Tests executed for this artifact" block must match a
 * measured run.
 *
 * A first-page number with no current artifact is exactly the defect the bar
 * forbids, and the block silently rotted (271/104/101 while HEAD measured
 * 287/105/102). This checks the README against the suites' own output, so the
 * numbers can only be stale until the next run fails.
 *
 *   node scripts/readme-numbers.mjs
 *     measure the root + Temporal suites and the integration syntax check, then
 *     compare to README (this is what `npm run verify` uses).
 *
 *   node scripts/readme-numbers.mjs --root-tap=F --temporal-tap=F --syntax-json=F
 *     compare against already-captured outputs (CI tees the suite output rather
 *     than running the suites twice).
 *
 * Exit codes: 0 every measured number matches; 1 a number drifted; 2 nothing was
 * measured (a skip is never a pass).
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Parse a `node --test` TAP summary. */
export function parseTap(text) {
  const num = (label) => {
    const match = new RegExp(`^# ${label} (\\d+)`, "m").exec(text);
    return match ? Number(match[1]) : undefined;
  };
  return { tests: num("tests"), pass: num("pass"), fail: num("fail"), skipped: num("skipped") };
}

/** Parse the one JSON line `scripts/check-integrations.mjs` prints. */
export function parseSyntax(text) {
  for (const line of text.split("\n")) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed.typescriptFiles === "number") return parsed;
    } catch {
      // not the JSON line
    }
  }
  return undefined;
}

/** The numbers the README claims, as written. */
export function readReadmeNumbers(readme = readFileSync(new URL("../README.md", import.meta.url), "utf8")) {
  const root = /(\d+) tests: (\d+) passed \/ (\d+) failed \/ (\d+) skipped/.exec(readme);
  const temporal = /npm test --prefix integrations\/temporal[\s\S]*?(\d+) passed \/ (\d+) failed/.exec(readme);
  const syntax = /(\d+) TypeScript integration files \/ (\d+) syntax diagnostics/.exec(readme);
  const shell = /(\d+) shell files \/ syntax OK/.exec(readme);
  return {
    root: root ? { tests: +root[1], pass: +root[2], fail: +root[3], skipped: +root[4] } : undefined,
    temporal: temporal ? { pass: +temporal[1], fail: +temporal[2] } : undefined,
    syntax: syntax ? { typescriptFiles: +syntax[1], syntaxDiagnostics: +syntax[2], ...(shell ? { shellFiles: +shell[1] } : {}) } : undefined,
  };
}

/**
 * Compare the README's claims to measured values. Only measurements that were
 * actually taken are compared; `measured` keys that are undefined are ignored.
 * Returns human-readable findings (empty = match).
 */
export function compareNumbers(readme, measured) {
  const findings = [];
  const check = (name, claimed, actual) => {
    if (!claimed || !actual) return;
    for (const key of Object.keys(actual)) {
      if (actual[key] === undefined || claimed[key] === undefined) continue;
      if (claimed[key] !== actual[key]) findings.push(`${name}.${key}: README says ${claimed[key]}, measured ${actual[key]}`);
    }
  };
  check("root", readme.root, measured.root);
  check("temporal", readme.temporal, measured.temporal);
  check("syntax", readme.syntax, measured.syntax);
  return findings;
}

function measure(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  return { status: result.status ?? 1, stdout: result.stdout ?? "" };
}

function arg(name) {
  const hit = process.argv.slice(2).find((value) => value.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

function main() {
  const readRoot = arg("root-tap");
  const readTemporal = arg("temporal-tap");
  const readSyntax = arg("syntax-json");
  const asJson = process.argv.includes("--json");

  const measured = {};
  let measuredAnything = false;
  const captures = readRoot || readTemporal || readSyntax ? null : mkdtempSync(join(tmpdir(), "readme-numbers-"));

  if (readRoot) {
    measured.root = parseTap(readFileSync(readRoot, "utf8"));
  } else if (captures) {
    const rootTap = join(captures, "root.tap");
    const result = measure("npm", ["test"]);
    writeFileSync(rootTap, result.stdout);
    process.stdout.write(result.stdout.slice(-600));
    if (result.status !== 0) console.error(`root suite exited ${result.status}`);
    measured.root = parseTap(result.stdout);
  }
  if (readTemporal) {
    measured.temporal = parseTap(readFileSync(readTemporal, "utf8"));
  } else if (captures) {
    const result = measure("npm", ["test", "--prefix", "integrations/temporal"]);
    process.stdout.write(result.stdout.slice(-600));
    measured.temporal = parseTap(result.stdout);
  }
  if (readSyntax) {
    measured.syntax = parseSyntax(readFileSync(readSyntax, "utf8"));
  } else if (captures) {
    const result = measure("npm", ["run", "integrations:syntax"]);
    process.stdout.write(result.stdout.slice(-300));
    measured.syntax = parseSyntax(result.stdout);
  }
  if (measured.root) measuredAnything = true;
  if (measured.temporal) measuredAnything = true;
  if (measured.syntax) measuredAnything = true;

  if (!measuredAnything) {
    console.error("readme-numbers: nothing measured (pass --root-tap/--temporal-tap/--syntax-json or run with no flags)");
    process.exit(2);
  }
  const findings = compareNumbers(readReadmeNumbers(), measured);
  if (asJson) console.log(JSON.stringify({ measured, findings }, null, 2));
  if (findings.length > 0) {
    console.error("readme-numbers: README is stale relative to the measured run:");
    for (const finding of findings) console.error(`  - ${finding}`);
    process.exit(1);
  }
  console.log("readme-numbers: README matches the measured run");
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
