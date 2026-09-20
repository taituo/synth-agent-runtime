// Scorer-isolation probe: run each known capability class through the REAL
// scoring worker and print one row per class. It records reachability, so when
// an OS-level boundary lands the rows flip to `blocked`; a new escape shows up
// as a new row.
//
//   node scripts/scorer-isolation-probe.mjs [--json]
//
// Exit 0 when every probed class is blocked, 2 when any is reachable (a
// documented gap, never a silent pass).
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { scoreGymPatch } from "../dist/src/gym/scoring.js";

const execFileAsync = promisify(execFile);
const CASES = [{ module: "./lib.mjs", call: "probe", args: [], expect: "unreachable", label: "probe" }];
const PARENT = resolve(tmpdir(), "scorer-isolation-probe");

async function git(cwd, ...a) {
  const { stdout } = await execFileAsync("git", a, { cwd });
  return stdout;
}

async function runPayload(body) {
  const parent = await mkdtemp(join(PARENT, "run-"));
  const repo = join(parent, "repo");
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, "lib.mjs"), "export function probe(){return 'baseline';}\n");
  await git(repo, "init", "-q");
  await git(repo, "config", "user.email", "p@e");
  await git(repo, "config", "user.name", "probe");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "base");
  const attack = `let __e = "no-result";\ntry {\n${body}\n} catch (e) { __e = "blocked:" + String(e.code || e.message); }\nexport function probe() { return "DIAG:" + __e; }\n`;
  await writeFile(join(repo, "lib.mjs"), attack);
  const patch = await git(repo, "diff");
  await git(repo, "checkout", "--", ".");
  try {
    const score = await scoreGymPatch({ patchText: patch, baseRepoDir: repo, cases: CASES, timeoutMs: 20000 });
    const message = score.cases?.[0]?.error ?? score.detail ?? score.outcome;
    const diag = (/DIAG:(.*)/.exec(message)?.[1] ?? message).replace(/["']+$/, "");
    return diag;
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

const CLASSES = [
  ["node:sqlite (closed)", /wrote-host-db/, "const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync('" + join(PARENT, "host.sqlite") + "'); db.exec('CREATE TABLE IF NOT EXISTS t(x)'); __e = 'wrote-host-db';"],
  ["tcp to temporal :7243", /CONNECTED/, "const net = await import('node:net'); await new Promise((res) => { const s = net.connect(7243, '127.0.0.1'); s.on('connect', () => { __e = 'CONNECTED'; s.destroy(); res(); }); s.on('error', (e) => { __e = 'blocked:' + e.code; res(); }); });"],
  ["tcp to postgres :5432", /CONNECTED/, "const net = await import('node:net'); await new Promise((res) => { const s = net.connect(5432, '127.0.0.1'); s.on('connect', () => { __e = 'CONNECTED'; s.destroy(); res(); }); s.on('error', (e) => { __e = 'blocked:' + e.code; res(); }); });"],
  ["unix socket bind outside clone", /BOUND:/, "const net = await import('node:net'); const p = '" + join(PARENT, "escape.sock") + "'; await new Promise((res) => { const s = net.createServer(); s.on('error', (e) => { __e = 'blocked:' + e.code; res(); }); s.listen(p, () => { __e = 'BOUND:' + p; s.close(); res(); }); });"],
  ["node:test executes an outside file", /EXECUTED/, "const { run } = await import('node:test'); const target = '" + join(PARENT, "outside.test.mjs") + "'; const r = await run({ files: [target] }); __e = (r.testsFailed > 0 || r.testsPassed > 0) ? 'EXECUTED' : 'not-executed';"],
  ["process.kill the verifier (signal 0)", /CAN-SIGNAL-VERIFIER/, "try { process.kill(process.ppid, 0); __e = 'CAN-SIGNAL-VERIFIER'; } catch (e) { __e = 'blocked:' + e.code; }"],
  ["os.userInfo host metadata", /^[^:]+:\d+$/, "const os = await import('node:os'); const u = os.userInfo(); __e = u.username + ':' + u.uid;"],
];

const rows = [];
for (const [name, positive, body] of CLASSES) {
  const diag = await runPayload(body);
  // Reachable only on POSITIVE evidence of the escape; `blocked:` is denied and
  // anything else is unconfirmed (not counted as safe).
  const status = positive.test(diag) ? "reachable" : /^blocked:/.test(diag) ? "blocked" : "unconfirmed";
  rows.push({ class: name, status, observed: diag });
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  for (const row of rows) console.log(`${row.status.toUpperCase().padEnd(11)} ${row.class}  ->  ${row.observed}`);
}
process.exit(rows.some((row) => row.status === "reachable") ? 2 : 0);
