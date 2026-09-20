/**
 * Signal-swarm stage one driver: one stream, one agent, both arms eventually.
 *
 * This runs the PLAIN arm live against the gateway and scores the reported
 * findings against the planted ground truth, with no judge. The durable arm
 * (Temporal) reuses the same `runSwarmAttempt` and is the next increment; the
 * `--dry-run` scripted arm lets the wiring be checked at zero model cost.
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

async function main(): Promise<void> {
  if (!dryRun) await preflightGateway();
  const work = await mkdtemp(join(tmpdir(), "swarm-run-"));
  try {
    const runner = localEffectRunner(work);
    const turn = dryRun
      ? scriptedTurn
      : createGatewaySwarmTurn({
          baseUrl: gateway,
          model,
          ...(process.env.SYNTH_GATEWAY_API_KEY ? { apiKey: process.env.SYNTH_GATEWAY_API_KEY } : {}),
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
    const planted = PLANTED_STREAM.planted.length;
    const report = {
      ok: record.score.recovered === planted && record.score.spurious === 0,
      stream: PLANTED_STREAM.name,
      arm: "plain",
      mode: dryRun ? "dry-run" : "live",
      planted,
      recovered: record.score.recovered,
      recall: record.score.recall,
      precision: record.score.precision,
      spurious: record.score.spurious,
      ambiguous: record.score.ambiguousReports ?? 0,
      decoyReports: record.score.decoyReports,
      turns: record.turns,
      finished: record.finished,
      requestedModel: record.requestedModel,
      servedModel: record.servedModel,
      modelSubstituted: record.modelSubstituted,
      toolCalls: toolsSeen.length,
    };
    console.log(JSON.stringify(report));
    process.exit(report.ok ? 0 : 1);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  if (error instanceof SkippedError) {
    console.log(JSON.stringify({ ok: false, skipped: true, reason: error.message }));
    process.exit(2);
  }
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
