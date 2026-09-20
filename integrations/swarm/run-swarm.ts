/**
 * Signal-swarm stage one driver: one stream, one agent, both arms.
 *
 * The PLAIN arm runs `runSwarmAttempt` directly; the DURABLE arm submits the
 * same loop through `swarmAttemptWorkflow` so durability (checkpoint + park) is
 * the only difference. Both score the reported findings against the planted
 * ground truth with no judge. `--dry-run` uses a scripted turn at zero cost.
 *
 * Exit codes match the gym driver: 0 all planted recovered with no spurious
 * finding, 1 otherwise, 2 when live infra is absent (a skip, never a pass).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PLANTED_STREAM,
  createGatewaySwarmTurn,
  localEffectRunner,
  runSwarmAttempt,
  type SwarmToolCall,
  type SwarmTurn,
} from "../../src/index.js";

class SkippedError extends Error {}

const args = process.argv.slice(2);
const arg = (name: string, fallback: string): string => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1]! : fallback;
};
const hasFlag = (name: string): boolean => args.includes(name);

const dryRun = hasFlag("--dry-run");
const model = arg("--model", process.env.SYNTH_GYM_MODEL ?? "muse-spark-1.3-contributor");
const gateway = arg("--gateway", process.env.SYNTH_GATEWAY_URL ?? "http://127.0.0.1:8787");
const maxTurns = Number(arg("--turns", "8"));
const deadlineMs = Number(arg("--deadline-ms", "300000"));
const gatewayTimeoutMs = arg("--gateway-timeout-ms", "") ? Number(arg("--gateway-timeout-ms", "")) : undefined;
const arm = arg("--arm", "both");
if (!["plain", "durable", "both"].includes(arm)) throw new Error(`--arm must be plain|durable|both, got ${arm}`);

interface ArmReport {
  ok: boolean;
  arm: string;
  mode: string;
  stream: string;
  planted: number;
  recovered: number;
  recall: number;
  precision: number;
  spurious: number;
  decoyReports: number;
  ambiguousReports: number;
  turns: number;
  finished: boolean;
  toolCalls: number;
  requestedModel: string | null;
  servedModel: string | null;
  modelSubstituted: boolean;
  [key: string]: unknown;
}

/** The scripted analyst: reports the three planted signals, then finishes. */
const scriptedTurn: SwarmTurn = async (input) => {
  if (input.turnIndex > 0) return { toolCalls: [{ name: "finish", arguments: {} }] };
  return {
    toolCalls: [
      { name: "list_events", arguments: {} },
      { name: "report_finding", arguments: { kind: "incident", summary: "checkout 5xx escalation", evidence: ["inc-2"] } },
      { name: "report_finding", arguments: { kind: "slow-burn", summary: "search latency creeping", evidence: ["burn-1", "burn-5"] } },
      { name: "report_finding", arguments: { kind: "correlation", summary: "recommendations errors after v2.3", evidence: ["rel-1", "corr-1"] } },
      { name: "finish", arguments: {} },
    ],
    requestedModel: "scripted",
    servedModel: "scripted",
  };
};

async function preflightGateway(): Promise<void> {
  try {
    const response = await fetch(`${gateway.replace(/\/$/, "")}/v1/models`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    throw new SkippedError(`gateway not reachable at ${gateway}: ${(error as Error).message}`);
  }
}

async function runPlain(): Promise<ArmReport> {
  const work = await mkdtemp(join(tmpdir(), "swarm-plain-"));
  try {
    const runner = localEffectRunner(work);
    const turn = dryRun
      ? scriptedTurn
      : createGatewaySwarmTurn({
          baseUrl: gateway,
          model,
          ...(process.env.SYNTH_GATEWAY_API_KEY ? { apiKey: process.env.SYNTH_GATEWAY_API_KEY } : {}),
          ...(gatewayTimeoutMs ? { timeoutMs: gatewayTimeoutMs } : {}),
        });
    const toolsSeen: string[] = [];
    const record = await runSwarmAttempt({
      runner,
      turn,
      maxTurns,
      deadlineMs,
      onTool: ({ call }: { call: SwarmToolCall }) => {
        toolsSeen.push(call.name);
      },
    });
    const planted = record.score.plantedCount;
    return {
      ok: record.score.recovered === planted && record.score.spurious === 0,
      arm: "plain",
      mode: dryRun ? "dry-run" : "live",
      stream: PLANTED_STREAM.name,
      planted,
      recovered: record.score.recovered,
      recall: record.score.recall,
      precision: record.score.precision,
      spurious: record.score.spurious,
      decoyReports: record.score.decoyReports,
      ambiguousReports: record.score.ambiguousReports,
      turns: record.turns,
      finished: record.finished,
      toolCalls: toolsSeen.length,
      requestedModel: record.requestedModel ?? null,
      servedModel: record.servedModel ?? null,
      modelSubstituted: record.modelSubstituted,
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Resolve the Temporal client from the sibling integration package. */
async function loadTemporalClient(): Promise<{ Client: any; Connection: any }> {
  const candidates = [
    "@temporalio/client",
    new URL("../temporal/node_modules/@temporalio/client/lib/index.js", import.meta.url).href,
  ];
  for (const specifier of candidates) {
    try {
      return (await import(specifier)) as { Client: any; Connection: any };
    } catch {
      // try the next resolution
    }
  }
  throw new SkippedError("durable arm: @temporalio/client is not installed (run npm install in integrations/temporal)");
}

async function runDurable(): Promise<ArmReport> {
  const temporal = await loadTemporalClient();
  let connection: any;
  try {
    connection = await temporal.Connection.connect(
      process.env.SYNTH_TEMPORAL_ADDRESS ? { address: process.env.SYNTH_TEMPORAL_ADDRESS } : undefined,
    );
  } catch (error) {
    throw new SkippedError(`durable arm: Temporal not reachable: ${(error as Error).message}`);
  }
  const client = new temporal.Client({ connection });
  const workDir = await mkdtemp(join(tmpdir(), "swarm-durable-"));
  try {
    const workflowId = `swarm-${Date.now().toString(36)}`;
    const input = {
      agentId: "swarm-durable",
      workDir,
      gatewayBaseUrl: gateway,
      model,
      maxTurns,
      deadlineMs,
      ...(gatewayTimeoutMs ? { gatewayTimeoutMs } : {}),
      ...(process.env.SYNTH_GATEWAY_API_KEY ? { apiKey: process.env.SYNTH_GATEWAY_API_KEY } : {}),
    };
    const handle = await client.workflow.start("swarmAttemptWorkflow", {
      taskQueue: process.env.SYNTH_SWARM_TASK_QUEUE ?? "synth-swarm",
      workflowId,
      args: [{ ...input, checkpointKey: workflowId }],
      workflowExecutionTimeout: "1 hour",
    });
    const output = (await handle.result()) as Record<string, unknown>;
    return {
      ok: output.recovered === output.planted && output.spurious === 0,
      arm: "durable",
      mode: "live",
      stream: PLANTED_STREAM.name,
      planted: Number(output.planted ?? 0),
      recovered: Number(output.recovered ?? 0),
      recall: Number(output.recall ?? 0),
      precision: Number(output.precision ?? 1),
      spurious: Number(output.spurious ?? 0),
      decoyReports: Number(output.decoyReports ?? 0),
      ambiguousReports: Number(output.ambiguousReports ?? 0),
      turns: Number(output.turns ?? 0),
      finished: Boolean(output.finished),
      toolCalls: Number(output.toolCalls ?? 0),
      requestedModel: (output.requestedModel as string | null) ?? null,
      servedModel: (output.servedModel as string | null) ?? null,
      modelSubstituted: Boolean(output.modelSubstituted),
      workflowId,
      wallTimeMs: output.wallTimeMs,
      ...(output.resumedFromTurn !== undefined ? { resumedFromTurn: output.resumedFromTurn } : {}),
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  if (!dryRun) await preflightGateway();
  const reports: ArmReport[] = [];
  if (arm === "plain" || arm === "both") reports.push(await runPlain());
  if (arm === "durable" || arm === "both") {
    if (dryRun) throw new SkippedError("--dry-run supports only the plain arm");
    reports.push(await runDurable());
  }
  for (const report of reports) console.log(JSON.stringify(report));
  process.exit(reports.every((report) => report.ok) ? 0 : 1);
}

main().catch((error: unknown) => {
  if (error instanceof SkippedError) {
    console.log(JSON.stringify({ ok: false, skipped: true, reason: error.message }));
    process.exit(2);
  }
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
