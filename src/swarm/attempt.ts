/**
 * One shared loop for both arms of the signal swarm.
 *
 * Both the plain arm and the durable arm call THIS function; the only injected
 * difference is which `EffectRunner` and which `SwarmTurn` they pass. The loop
 * ends by scoring the reported findings against the PLANTED ground truth, so the
 * two-arm comparison and the fault matrix work exactly as they do for the gym:
 * durability either preserves partial findings across a SIGKILL or it does not.
 *
 * The terminal step differs from the gym's loop by necessity: there is no patch
 * and no held-out test, only findings compared to what was planted.
 */
import type { EffectRunner } from "../gym/tools.js";
import type { SwarmCheckpointStore, SwarmTranscriptEntry } from "./checkpoint.js";
import { scoreFindings, type FindingScore, type ReportedFinding } from "./findings.js";
import { PLANTED_STREAM, type SignalStream } from "./stream.js";
import {
  buildSwarmSystemPrompt,
  buildSwarmUserPrompt,
  createSwarmTools,
  FINDINGS_FILE,
  materializeStream,
  type SwarmToolCall,
  type SwarmToolDefinition,
} from "./tools.js";

export interface SwarmTurnInput {
  turnIndex: number;
  streamName: string;
  systemPrompt: string;
  userPrompt: string;
  transcript: readonly SwarmTranscriptEntry[];
  tools: readonly SwarmToolDefinition[];
  findings: readonly ReportedFinding[];
}

export interface SwarmTurnResult {
  toolCalls: SwarmToolCall[];
  content?: string;
  requestedModel?: string;
  servedModel?: string | null;
  modelSubstituted?: boolean;
  latencyMs?: number;
  usage?: unknown;
}

/** Injected model boundary: a direct gateway call, a Temporal activity, or a script. */
export type SwarmTurn = (input: SwarmTurnInput) => Promise<SwarmTurnResult>;

export interface RunSwarmAttemptOptions {
  stream?: SignalStream;
  runner: EffectRunner;
  turn: SwarmTurn;
  checkpoint?: SwarmCheckpointStore;
  checkpointKey?: string;
  /** Hard cap on model turns. Default 8. */
  maxTurns?: number;
  /** Wall-clock budget. Default 5 minutes. */
  deadlineMs?: number;
  now?: () => number;
  onTool?: (result: { turnIndex: number; call: SwarmToolCall; ok: boolean; observation: string }) => void;
}

export interface SwarmAttemptRecord {
  findings: ReportedFinding[];
  score: FindingScore;
  turns: number;
  transcript: SwarmTranscriptEntry[];
  requestedModel?: string | null;
  servedModel?: string | null;
  modelSubstituted: boolean;
  finished: boolean;
}

export async function runSwarmAttempt(options: RunSwarmAttemptOptions): Promise<SwarmAttemptRecord> {
  const stream = options.stream ?? PLANTED_STREAM;
  const now = options.now ?? Date.now;
  const maxTurns = options.maxTurns ?? 8;
  const deadline = now() + (options.deadlineMs ?? 5 * 60_000);

  await materializeStream(options.runner, stream);
  const tools = createSwarmTools(options.runner, { stream });
  const systemPrompt = buildSwarmSystemPrompt(tools.definitions);
  const userPrompt = buildSwarmUserPrompt(stream);

  let turnIndex = 0;
  let transcript: SwarmTranscriptEntry[] = [];
  let requestedModel: string | null | undefined;
  let servedModel: string | null | undefined;
  let modelSubstituted = false;

  // Resume from a checkpoint: restore the findings AND write them back into the
  // workspace, since a retried durable attempt re-materializes an empty one.
  if (options.checkpoint && options.checkpointKey) {
    const restored = await options.checkpoint.load(options.checkpointKey);
    if (restored) {
      turnIndex = restored.turnIndex;
      transcript = restored.transcript;
      requestedModel = restored.requestedModel;
      servedModel = restored.servedModel;
      if (restored.findings.length > 0) {
        await options.runner.write(FINDINGS_FILE, `${restored.findings.map((finding) => JSON.stringify(finding)).join("\n")}\n`);
      }
    }
  }

  while (turnIndex < maxTurns && now() < deadline && !tools.finished()) {
    const result = await options.turn({
      turnIndex,
      streamName: stream.name,
      systemPrompt,
      userPrompt,
      transcript,
      tools: tools.definitions,
      findings: await tools.readFindings(),
    });
    turnIndex += 1;
    if (requestedModel === undefined) requestedModel = result.requestedModel ?? null;
    if (servedModel === undefined) servedModel = result.servedModel ?? null;
    if (result.modelSubstituted) modelSubstituted = true;
    if (result.content) transcript.push({ role: "assistant", content: result.content });

    for (const call of result.toolCalls) {
      const executed = await tools.execute(call);
      transcript.push({ role: "tool", name: call.name, content: executed.observation });
      options.onTool?.({ turnIndex, call, ok: executed.ok, observation: executed.observation });
      if (call.name === "finish") break;
    }

    if (options.checkpoint && options.checkpointKey) {
      await options.checkpoint.save(options.checkpointKey, {
        turnIndex,
        findings: await tools.readFindings(),
        transcript,
        requestedModel: requestedModel ?? null,
        servedModel: servedModel ?? null,
      });
    }
  }

  const findings = await tools.readFindings();
  return {
    findings,
    score: scoreFindings(stream, findings),
    turns: turnIndex,
    transcript,
    requestedModel: requestedModel ?? null,
    servedModel: servedModel ?? null,
    modelSubstituted,
    finished: tools.finished(),
  };
}
