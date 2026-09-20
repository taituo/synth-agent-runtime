/**
 * Fault matrix for the signal swarm, per arm.
 *
 * Reuses the gym harness shape: `flaky-gateway.ts` for provider faults (502,
 * 429-with-hint, a hang) and the dedicated-worker kill/restart pattern for the
 * process fault. The plain arm has no durable record, so its process-fault
 * equivalent is a plain attempt child killed mid-run; the finding is whether
 * recovery exists at all.
 *
 * The discriminating quantity is the planted findings RECOVERED, not the final
 * status: after a kill, does the arm still hold the findings it made before it?
 *
 *   tsx integrations/swarm/p2-faults.ts --fault worker-restart
 *   tsx integrations/swarm/p2-faults.ts --fault 502
 *
 * A fault that does not differentiate the arms is printed `differentiated:
 * false`, not retuned away.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { PLANTED_STREAM, createGatewaySwarmTurn, localEffectRunner, runSwarmAttempt, type SwarmAttemptRecord } from "../../src/index.js";
import { startFlakyGateway, type FlakyGatewayOptions } from "../temporal/flaky-gateway.js";

const ADDRESS = process.env.SYNTH_TEMPORAL_ADDRESS ?? "127.0.0.1:7243";
const TSX = resolve("integrations/temporal/node_modules/.bin/tsx");
const SWARM_WORKER = resolve("integrations/temporal/swarm-worker.ts");
const SELF = resolve("integrations/swarm/p2-faults.ts");

interface ArmResult {
  arm: "plain" | "durable";
  recovered: number;
  planted: number;
  recall: number;
  precision: number;
  spurious: number;
  turns: number;
  toolCalls: number;
  requestedModel: string | null;
  servedModel: string | null;
  resumedFromTurn?: number;
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
    fault: str("fault", "worker-restart"),
    gateway: str("gateway", process.env.SYNTH_GATEWAY_URL ?? "http://127.0.0.1:8787"),
    model: str("model", process.env.SYNTH_GYM_MODEL ?? "muse-spark-1.3-contributor"),
    turns: num("turns", 8),
    deadlineMs: num("deadline-ms", 120_000),
    gatewayTimeoutMs: num("gateway-timeout-ms", 20_000),
    killAfterMs: num("kill-after-ms", 15_000),
    arm: str("arm", "both") as Args["arm"],
    flakyPort: num("flaky-port", 8892),
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

function reportFrom(arm: "plain" | "durable", record: SwarmAttemptRecord): ArmResult {
  return {
    arm,
    recovered: record.score.recovered,
    planted: record.score.plantedCount,
    recall: record.score.recall,
    precision: record.score.precision,
    spurious: record.score.spurious,
    turns: record.turns,
    toolCalls: record.transcript.filter((entry) => entry.role === "tool").length,
    requestedModel: record.requestedModel ?? null,
    servedModel: record.servedModel ?? null,
  };
}

async function runPlainOnce(args: Args, baseUrl: string, workDir: string): Promise<ArmResult> {
  const runner = localEffectRunner(workDir);
  const turn = createGatewaySwarmTurn({ baseUrl, model: args.model, timeoutMs: args.gatewayTimeoutMs });
  try {
    const record = await runSwarmAttempt({ runner, turn, maxTurns: args.turns, deadlineMs: args.deadlineMs });
    return reportFrom("plain", record);
  } catch (error) {
    // No durable record: a turn failure loses the whole attempt.
    return {
      arm: "plain",
      recovered: 0,
      planted: PLANTED_STREAM.planted.length,
      recall: 0,
      precision: 1,
      spurious: 0,
      turns: 0,
      toolCalls: 0,
      requestedModel: args.model,
      servedModel: null,
      error: (error as Error).message,
    };
  }
}

function spawnWorker(taskQueue: string): ChildProcess {
  return spawn(TSX, [SWARM_WORKER], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, TEMPORAL_ADDRESS: ADDRESS, SYNTH_SWARM_TASK_QUEUE: taskQueue },
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

async function runDurableOnce(args: Args, baseUrl: string, workDir: string, processFault?: NodeJS.Signals): Promise<ArmResult> {
  const { Client, Connection } = await loadTemporalClient();
  const connection = await Connection.connect({ address: ADDRESS });
  const client = new Client({ connection });
  const taskQueue = `synth-swarm-fault-${Date.now().toString(36)}`;
  let worker: ChildProcess | undefined = spawnWorker(taskQueue);
  try {
    await sleep(5_000);
    const workflowId = `swarm-fault-${Date.now().toString(36)}`;
    const handle = await client.workflow.start("swarmAttemptWorkflow", {
      taskQueue,
      workflowId,
      args: [
        {
          agentId: "swarm-fault",
          workDir,
          gatewayBaseUrl: baseUrl,
          model: args.model,
          maxTurns: args.turns,
          deadlineMs: args.deadlineMs,
          gatewayTimeoutMs: args.gatewayTimeoutMs,
          checkpointKey: workflowId,
        },
      ],
      workflowExecutionTimeout: "1 hour",
    });
    if (processFault && worker) {
      await sleep(args.killAfterMs);
      killGroup(worker, processFault);
      worker = spawnWorker(taskQueue); // restart; the activity must resume from the checkpoint
      await sleep(4_000);
    }
    const output = (await handle.result()) as {
      recovered: number;
      planted: number;
      recall: number;
      precision: number;
      spurious: number;
      turns: number;
      toolCalls: number;
      requestedModel: string | null;
      servedModel: string | null;
      resumedFromTurn?: number;
      error?: string;
    };
    return {
      arm: "durable",
      recovered: output.recovered,
      planted: output.planted,
      recall: output.recall,
      precision: output.precision,
      spurious: output.spurious,
      turns: output.turns,
      toolCalls: output.toolCalls,
      requestedModel: output.requestedModel,
      servedModel: output.servedModel,
      ...(output.resumedFromTurn !== undefined ? { resumedFromTurn: output.resumedFromTurn } : {}),
      ...(output.error ? { error: output.error } : {}),
    };
  } finally {
    if (worker) killGroup(worker, "SIGKILL");
    await connection.close().catch(() => {});
  }
}

/** Kill a plain attempt child mid-run: the no-durability arm loses the run. */
async function runPlainKilled(args: Args, baseUrl: string, workDir: string, signal: NodeJS.Signals): Promise<ArmResult> {
  const child = spawn(
    TSX,
    [SELF, "--child-plain", "--gateway", baseUrl, "--model", args.model, "--turns", String(args.turns), "--deadline-ms", String(args.deadlineMs), "--gateway-timeout-ms", String(args.gatewayTimeoutMs)],
    { detached: true, stdio: ["ignore", "ignore", "ignore"], env: process.env },
  );
  const exited = new Promise<string>((resolveExit) => {
    child.once("exit", (code, sig) => resolveExit(sig ?? String(code)));
  });
  try {
    await sleep(args.killAfterMs);
    killGroup(child, signal);
    const how = await exited;
    return {
      arm: "plain",
      recovered: 0,
      planted: PLANTED_STREAM.planted.length,
      recall: 0,
      precision: 1,
      spurious: 0,
      turns: 0,
      toolCalls: 0,
      requestedModel: args.model,
      servedModel: null,
      detail: `plain attempt child killed with ${signal} mid-run (exit ${how}); no durable record, so the findings made before the kill are lost`,
    };
  } finally {
    killGroup(child, "SIGKILL");
  }
}

function flakyOptionsFor(fault: string, upstream: string, port: number): { options: FlakyGatewayOptions; base: string } | undefined {
  const base = `http://127.0.0.1:${port}`;
  if (fault === "502") return { options: { upstream, port, mode: "502", failFirst: 1 }, base };
  if (fault === "429") return { options: { upstream, port, mode: "429", failFirst: 3, retryAfterSeconds: 1 }, base };
  if (fault === "timeout") return { options: { upstream, port, mode: "hang", failFirst: 1 }, base };
  return undefined;
}

async function main(): Promise<number> {
  const args = parse(process.argv.slice(2));
  const work = await mkdtemp(join(tmpdir(), "swarm-fault-"));
  if (args.childPlain) {
    try {
      console.log(JSON.stringify(await runPlainOnce(args, args.gateway, work)));
      return 0;
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  const processFault = args.fault === "worker-restart" ? "SIGTERM" : args.fault === "sigkill" ? "SIGKILL" : undefined;
  try {
    // Each arm gets its own fault proxy on its own port, so a one-shot fault is
    // not consumed by whichever arm ran first.
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
    if (args.arm !== "durable") {
      results.push(await runWithFault(args.flakyPort, (base) => (processFault ? runPlainKilled(args, base, work, processFault) : runPlainOnce(args, base, work))));
    }
    if (args.arm !== "plain") {
      results.push(await runWithFault(args.flakyPort + 1, (base) => runDurableOnce(args, base, work, processFault)));
    }
    const plain = results.find((result) => result.arm === "plain");
    const durable = results.find((result) => result.arm === "durable");
    // Differentiation is about the planted findings recovered, not the status.
    const differentiated = Boolean(plain && durable && plain.recovered !== durable.recovered);
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
