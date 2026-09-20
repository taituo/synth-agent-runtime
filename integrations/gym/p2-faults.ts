/**
 * P2 fault matrix for the gym, per arm.
 *
 * Reuses `flaky-gateway.ts` for the provider faults (502, 429-with-hint, and a
 * hang) and the `restart-worker.ts` pattern for process faults (a dedicated
 * worker per run, killed mid-attempt and restarted). The plain arm has no
 * worker, so for process faults its equivalent is a plain attempt child killed
 * mid-turn; the finding is whether recovery exists at all.
 *
 *   tsx integrations/gym/p2-faults.ts --fault 502
 *   tsx integrations/gym/p2-faults.ts --fault worker-restart
 *
 * Honest reporting is the point: a fault that does not differentiate the arms
 * is printed as `differentiated: false`, not retuned away.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createGatewayGymTurn,
  loadGymTask,
  localEffectRunner,
  materializeGymTask,
  runGymAttempt,
} from "../../src/index.js";
import { startFlakyGateway, type FlakyGatewayOptions } from "../temporal/flaky-gateway.js";

const TASK_DIR = resolve("test/fixtures/gym-tasks/he/hex-decode");
const ADDRESS = process.env.SYNTH_TEMPORAL_ADDRESS ?? "127.0.0.1:7233";
const TSX = resolve("integrations/temporal/node_modules/.bin/tsx");
const GYM_WORKER = resolve("integrations/temporal/gym-worker.ts");
const SELF = resolve("integrations/gym/p2-faults.ts");

interface ArmResult {
  arm: "plain" | "durable";
  outcome: string;
  callCount: number;
  turns: number;
  wallTimeMs: number;
  patchBytes: number;
  requestedModel?: string | null;
  servedModel?: string | null;
  recovered?: boolean;
  detail?: string;
  error?: string;
}

interface Args {
  fault: string;
  gateway: string;
  model: string;
  turns: number;
  deadlineMs: number;
  gatewayTimeoutMs: number;
  killAfterMs: number;
  arm: "both" | "plain" | "durable";
  flakyPort: number;
  childPlain: boolean;
}

function parse(argv: string[]): Args {
  const map = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      map.set(key, next);
      i++;
    } else map.set(key, true);
  }
  const str = (name: string, fallback: string): string => (typeof map.get(name) === "string" ? (map.get(name) as string) : fallback);
  const num = (name: string, fallback: number): number => (typeof map.get(name) === "string" ? Number(map.get(name)) : fallback);
  return {
    fault: str("fault", "502"),
    gateway: str("gateway", "http://127.0.0.1:8791"),
    model: str("model", "kimi-k2.7-code"),
    turns: num("turns", 8),
    deadlineMs: num("deadline-ms", 900_000),
    gatewayTimeoutMs: num("gateway-timeout-ms", 20_000),
    killAfterMs: num("kill-after-ms", 12_000),
    arm: str("arm", "both") as Args["arm"],
    flakyPort: num("flaky-port", 8890),
    childPlain: map.has("child-plain"),
  };
}

async function loadTemporalClient(): Promise<{ Client: any; Connection: any }> {
  for (const specifier of ["@temporalio/client", new URL("../temporal/node_modules/@temporalio/client/lib/index.js", import.meta.url).href]) {
    try {
      return (await import(specifier)) as { Client: any; Connection: any };
    } catch {
      // next
    }
  }
  throw new Error("@temporalio/client unavailable");
}

function workflowInput(args: Args, taskDir: string, workDir: string, baseUrl: string, runner: "local" | "sandbox") {
  return {
    agentId: "gym-p2-fault",
    taskDir,
    workDir,
    gatewayBaseUrl: baseUrl,
    model: args.model,
    maxTurns: args.turns,
    deadlineMs: args.deadlineMs,
    runner,
    gatewayTimeoutMs: args.gatewayTimeoutMs,
    image: "",
    ...(process.env.SYNTH_FIXTURE_REPOS ? { fixtureCacheDir: process.env.SYNTH_FIXTURE_REPOS } : {}),
  };
}

async function runPlainOnce(args: Args, baseUrl: string, workDir: string): Promise<ArmResult> {
  const task = await loadGymTask(TASK_DIR);
  const materialized = await materializeGymTask({ task, workDir, repoDirName: `plain-${Date.now().toString(36)}` });
  const runner = localEffectRunner(materialized.repoDir);
  const turn = createGatewayGymTurn({ baseUrl, model: args.model, timeoutMs: args.gatewayTimeoutMs });
  const record = await runGymAttempt({ task: materialized, runner, turn, maxTurns: args.turns, deadlineMs: args.deadlineMs });
  return {
    arm: "plain",
    outcome: record.outcome,
    callCount: record.callCount,
    turns: record.turns,
    wallTimeMs: record.wallTimeMs,
    patchBytes: record.patch.length,
    requestedModel: record.requestedModel,
    servedModel: record.servedModel,
    ...(record.score.detail ? { detail: record.score.detail } : {}),
    ...(record.error ? { error: record.error } : {}),
  };
}

function spawnWorker(taskQueue: string): ChildProcess {
  return spawn(TSX, [GYM_WORKER], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, TEMPORAL_ADDRESS: ADDRESS, SYNTH_GYM_TASK_QUEUE: taskQueue },
  });
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    process.kill(-child.pid!, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

/**
 * Run the durable arm with a dedicated worker. When `fault` is a process fault,
 * kill the worker mid-attempt and restart it; Temporal must recover the attempt.
 */
async function runDurableOnce(args: Args, baseUrl: string, workDir: string, faultInjected: boolean, processFault?: NodeJS.Signals): Promise<ArmResult> {
  const task = await loadGymTask(TASK_DIR);
  const materialized = await materializeGymTask({ task, workDir, repoDirName: `durable-${Date.now().toString(36)}` });
  const { Client, Connection } = await loadTemporalClient();
  const connection = await Connection.connect({ address: ADDRESS });
  const client = new Client({ connection });
  const taskQueue = `synth-gym-fault-${Date.now().toString(36)}`;
  // Always a dedicated worker so the unique task queue has a listener; for a
  // process fault the same worker is the one killed mid-attempt. The finally
  // guarantees no orphaned worker if this run throws.
  let worker: ChildProcess | undefined = spawnWorker(taskQueue);
  try {
    await sleep(5_000);

    const handle = await client.workflow.start("gymAttemptWorkflow", {
      taskQueue,
      workflowId: `gym-fault-${Date.now().toString(36)}`,
      args: [workflowInput(args, task.taskDir, workDir, baseUrl, "local")],
      workflowExecutionTimeout: "1 hour",
    });

    if (processFault && worker) {
      await sleep(args.killAfterMs);
      killGroup(worker, processFault);
      worker = spawnWorker(taskQueue); // restart
      await sleep(4_000);
    }

    const output = (await handle.result()) as {
      outcome: string;
      callCount: number;
      turns: number;
      wallTimeMs: number;
      patchBytes?: number;
      requestedModel: string | null;
      servedModel: string | null;
      trace?: string[];
      detail?: string;
      error?: string;
    };
    return {
      arm: "durable",
      outcome: output.outcome,
      callCount: output.callCount,
      turns: output.turns,
      wallTimeMs: output.wallTimeMs,
      patchBytes: output.patchBytes ?? 0,
      requestedModel: output.requestedModel,
      servedModel: output.servedModel,
      recovered: faultInjected && output.outcome === "passed",
      ...(output.trace ? { trace: output.trace } : {}),
      ...(output.detail ? { detail: output.detail } : {}),
      ...(output.error ? { error: output.error } : {}),
    };
  } finally {
    if (worker) killGroup(worker, "SIGKILL");
    await connection.close().catch(() => {});
  }
}

/** Kill a plain attempt child mid-turn: the no-durability arm loses the run. */
async function runPlainKilled(args: Args, baseUrl: string, workDir: string, signal: NodeJS.Signals): Promise<ArmResult> {
  const child = spawn(TSX, [SELF, "--child-plain", "--gateway", baseUrl, "--model", args.model, "--turns", String(args.turns), "--deadline-ms", String(args.deadlineMs), "--gateway-timeout-ms", String(args.gatewayTimeoutMs)], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: process.env,
  });
  const exitedPromise = new Promise<string>((resolveExit) => {
    child.once("exit", (code, sig) => resolveExit(sig ?? String(code)));
  });
  try {
    await sleep(args.killAfterMs);
    killGroup(child, signal);
    const exited = await exitedPromise;
    return {
      arm: "plain",
      outcome: "lost",
      callCount: 0,
      turns: 0,
      wallTimeMs: args.killAfterMs,
      patchBytes: 0,
      recovered: false,
      detail: `plain attempt child killed with ${signal} mid-turn (exit ${exited}); no durable record, no harvest, no result`,
    };
  } finally {
    killGroup(child, "SIGKILL");
  }
}

function flakyOptionsFor(fault: string, upstream: string, port: number): { options: FlakyGatewayOptions; base: string } | undefined {
  const base = `http://127.0.0.1:${port}`;
  if (fault === "502") return { options: { upstream, port, mode: "502", failFirst: 1 }, base };
  // Three faults exhaust the activity's retry policy, so the WORKFLOW's
  // retry-hint park path is the thing that recovers, not Temporal's activity retry.
  if (fault === "429") return { options: { upstream, port, mode: "429", failFirst: 3, retryAfterSeconds: 1 }, base };
  if (fault === "timeout") return { options: { upstream, port, mode: "hang", failFirst: 1 }, base };
  return undefined;
}

async function main(): Promise<number> {
  const args = parse(process.argv.slice(2));
  const work = await mkdtemp(join(tmpdir(), "gym-fault-"));

  // Child mode: run one plain attempt and print it. The parent kills us.
  if (args.childPlain) {
    try {
      const result = await runPlainOnce(args, args.gateway, work);
      console.log(JSON.stringify(result));
      return 0;
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  const processFault = args.fault === "worker-restart" ? "SIGTERM" : args.fault === "sigkill" ? "SIGKILL" : undefined;
  try {
    // Each arm gets its OWN fault proxy on its own port, so a one-shot fault is
    // not consumed by whichever arm ran first. Running both arms through one
    // proxy made the durable arm look like it recovered when it simply never
    // saw the fault.
    const runWithFault = async (port: number, run: (base: string) => Promise<ArmResult>): Promise<ArmResult> => {
      const flaky = flakyOptionsFor(args.fault, args.gateway, port);
      if (!flaky) return run(args.gateway);
      const proxy = startFlakyGateway(flaky.options);
      await proxy.listen();
      try {
        return await run(flaky.base);
      } finally {
        await proxy.close();
      }
    };

    const results: ArmResult[] = [];
    const wantPlain = args.arm !== "durable";
    const wantDurable = args.arm !== "plain";
    if (wantPlain) {
      results.push(await runWithFault(args.flakyPort, (base) => (processFault ? runPlainKilled(args, base, work, processFault) : runPlainOnce(args, base, work))));
    }
    if (wantDurable) {
      results.push(await runWithFault(args.flakyPort + 1, (base) => runDurableOnce(args, base, work, true, processFault)));
    }

    const plain = results.find((result) => result.arm === "plain");
    const durable = results.find((result) => result.arm === "durable");
    const differentiated = Boolean(plain && durable && plain.outcome !== durable.outcome);
    console.log(JSON.stringify({ fault: args.fault, model: args.model, differentiated, results }, null, 2));
    return 0;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
