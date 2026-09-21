// Scorer-isolation probe: run each known capability class through the REAL
// scoring worker and print one row per class.
//
// The probe is boundary-aware: it checks for a HOST effect, not just a
// diagnostic, so a worker inside an OS jail is not falsely reported as escaping
// (a pod-local unix socket or a pod-local user id is not a host escape).
//
//   node scripts/scorer-isolation-probe.mjs [--json]
//
// With SYNTH_EXECUTOR_IMAGE set the scorer runs the worker in the gVisor pod;
// without it (or with SYNTH_SCORER_SANDBOX=0) the worker runs on the host under
// Node's permission model. The printed boundary is the ACTUAL selection, never
// just the presence of SYNTH_EXECUTOR_IMAGE.
// Exit 0 when every probed class is blocked, 2 when any is reachable or
// unconfirmed (a skip/unknown is never a pass).
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { scoreGymPatch } from "../dist/src/gym/scoring.js";
import { sandboxScorerConfig } from "../dist/src/gym/sandbox-worker.js";

const execFileAsync = promisify(execFile);
const CASES = [{ module: "./lib.mjs", call: "probe", args: [], expect: "unreachable", label: "probe" }];
const PARENT = resolve(tmpdir(), "scorer-isolation-probe");
await mkdir(PARENT, { recursive: true });

const HOST = userInfo();
const HOST_USER = `${HOST.username}:${HOST.uid}`;
const HOST_PID = process.pid;
const stamp = `${Date.now()}-${process.pid}`;
const sqlitePath = join(PARENT, `host-${stamp}.sqlite`);
const socketPath = join(PARENT, `escape-${stamp}.sock`);

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
    return (/DIAG:(.*)/.exec(message)?.[1] ?? message).replace(/["']+$/, "");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

/**
 * Each class: the payload, and how to decide "reachable" (an observed HOST
 * effect) vs "blocked" (denied, or a host-neutral value) vs "unconfirmed".
 */
const CLASSES = [
  {
    name: "node:sqlite writes a host DB",
    body: `const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync('${sqlitePath}'); db.exec('CREATE TABLE IF NOT EXISTS t(x)'); __e = 'wrote-host-db';`,
    reachable: (diag) => diag === "wrote-host-db" && existsSync(sqlitePath),
    blocked: () => !existsSync(sqlitePath),
  },
  {
    name: "tcp to temporal :7243",
    body: `const net = await import('node:net'); await new Promise((res) => { const s = net.connect(7243, '127.0.0.1'); s.on('connect', () => { __e = 'CONNECTED'; s.destroy(); res(); }); s.on('error', (e) => { __e = 'blocked:' + e.code; res(); }); });`,
    reachable: (diag) => /CONNECTED/.test(diag),
  },
  {
    name: "tcp to postgres :5432",
    body: `const net = await import('node:net'); await new Promise((res) => { const s = net.connect(5432, '127.0.0.1'); s.on('connect', () => { __e = 'CONNECTED'; s.destroy(); res(); }); s.on('error', (e) => { __e = 'blocked:' + e.code; res(); }); });`,
    reachable: (diag) => /CONNECTED/.test(diag),
  },
  {
    name: "unix socket bind at a host path",
    // The server is left open so the socket file persists for the host check;
    // the batch worker exits after writing results.
    body: `const net = await import('node:net'); const p = '${socketPath}'; await new Promise((res) => { const s = net.createServer(); s.on('error', (e) => { __e = 'blocked:' + e.code; res(); }); s.listen(p, () => { __e = 'BOUND:' + p; res(); }); });`,
    // Reachable only if the socket actually appeared on the HOST filesystem.
    reachable: (diag) => /BOUND:/.test(diag) && existsSync(socketPath),
    blocked: () => !existsSync(socketPath),
  },
  {
    name: "process.kill the verifier (signal 0)",
    body: `try { process.kill(${HOST_PID}, 0); __e = 'CAN-SIGNAL-VERIFIER'; } catch (e) { __e = 'blocked:' + e.code; }`,
    reachable: (diag) => diag === "CAN-SIGNAL-VERIFIER",
  },
  {
    name: "os.userInfo host metadata",
    body: `const os = await import('node:os'); const u = os.userInfo(); __e = u.username + ':' + u.uid;`,
    reachable: (diag) => diag === HOST_USER,
    blocked: (diag) => diag !== HOST_USER,
  },
];

const rows = [];
for (const entry of CLASSES) {
  const diag = await runPayload(entry.body);
  const status = entry.reachable(diag) ? "reachable" : entry.blocked?.(diag) || /^blocked:/.test(diag) ? "blocked" : "unconfirmed";
  rows.push({ class: entry.name, status, observed: diag });
}
// Clean up host-side artifacts a reachable payload would have created.
await unlink(sqlitePath).catch(() => {});
await unlink(socketPath).catch(() => {});

// The boundary the scorer will actually use: `sandboxScorerConfig()` returns
// undefined when SYNTH_SCORER_SANDBOX=0 even if SYNTH_EXECUTOR_IMAGE is set.
const boundary = sandboxScorerConfig() ? "pod" : "host";

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ boundary, hostUser: HOST_USER, rows }, null, 2));
} else {
  console.log(`boundary: ${boundary === "pod" ? "pod (gVisor)" : "host (Node permission model)"}  host user ${HOST_USER}`);
  for (const row of rows) console.log(`${row.status.toUpperCase().padEnd(11)} ${row.class}  ->  ${row.observed}`);
}
process.exit(rows.some((row) => row.status === "reachable" || row.status === "unconfirmed") ? 2 : 0);
