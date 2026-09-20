/**
 * The swarm agent's tool surface, over the SAME `EffectRunner` the gym uses, so
 * the identical tools run over a local temp dir or a sandboxed workspace and
 * both arms send the same prompt and tools.
 *
 * The stream and the findings are files in the workspace: `events.jsonl` (read
 * only) and `findings.jsonl` (append-only). A finding is data; nothing is
 * executed.
 */
import type { EffectRunner } from "../gym/tools.js";
import { normalizeReportedFinding, type ReportedFinding } from "./findings.js";
import { streamToJsonl, type SignalStream } from "./stream.js";

export type SwarmToolName = "list_events" | "read_event" | "report_finding" | "finish";

export interface SwarmToolCall {
  name: SwarmToolName;
  arguments: Record<string, unknown>;
}

export interface SwarmToolDefinition {
  name: SwarmToolName;
  description: string;
  parameters: Record<string, unknown>;
}

export interface SwarmToolResult {
  ok: boolean;
  observation: string;
}

export interface SwarmToolOptions {
  stream: SignalStream;
  eventsPath?: string;
  findingsPath?: string;
}

export interface SwarmTools {
  readonly definitions: readonly SwarmToolDefinition[];
  execute(call: SwarmToolCall): Promise<SwarmToolResult>;
  readFindings(): Promise<ReportedFinding[]>;
  finished(): boolean;
}

export const EVENTS_FILE = "events.jsonl";
export const FINDINGS_FILE = "findings.jsonl";

export const SWARM_TOOL_DEFINITIONS: readonly SwarmToolDefinition[] = [
  { name: "list_events", description: "List every event id, time, source and a short preview, in order.", parameters: { type: "object", properties: {} } },
  { name: "read_event", description: "Read the full text of one event by id.", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  {
    name: "report_finding",
    description: "Report one finding: a kind, a one-line summary, and the event ids that evidence it.",
    parameters: {
      type: "object",
      properties: { kind: { type: "string", enum: ["incident", "slow-burn", "correlation"] }, summary: { type: "string" }, evidence: { type: "array", items: { type: "string" } } },
      required: ["kind", "summary", "evidence"],
    },
  },
  { name: "finish", description: "Stop reading the stream and submit the findings reported so far.", parameters: { type: "object", properties: {} } },
];

/** Write the stream into the workspace once, so the tools read it like any file. */
export async function materializeStream(runner: EffectRunner, stream: SignalStream, eventsPath = EVENTS_FILE): Promise<void> {
  try {
    await runner.read(eventsPath);
    return;
  } catch {
    await runner.write(eventsPath, streamToJsonl(stream));
  }
}

export function createSwarmTools(runner: EffectRunner, options: SwarmToolOptions): SwarmTools {
  const eventsPath = options.eventsPath ?? EVENTS_FILE;
  const findingsPath = options.findingsPath ?? FINDINGS_FILE;
  let done = false;

  async function events(): Promise<Array<{ id: string; at: number; source: string; text: string }>> {
    const text = await runner.read(eventsPath);
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { id: string; at: number; source: string; text: string });
  }

  return {
    definitions: SWARM_TOOL_DEFINITIONS,
    finished: () => done,

    async execute(call: SwarmToolCall): Promise<SwarmToolResult> {
      if (call.name === "finish") {
        done = true;
        return { ok: true, observation: "finished" };
      }
      if (call.name === "list_events") {
        const all = await events();
        return { ok: true, observation: all.map((event) => `${event.id} t+${event.at}m [${event.source}] ${event.text.slice(0, 90)}`).join("\n") };
      }
      if (call.name === "read_event") {
        const id = String(call.arguments.id ?? "");
        const event = (await events()).find((entry) => entry.id === id);
        return event ? { ok: true, observation: `${event.id} t+${event.at}m [${event.source}] ${event.text}` } : { ok: false, observation: `no event ${id}` };
      }
      if (call.name === "report_finding") {
        const finding = normalizeReportedFinding({
          kind: call.arguments.kind,
          summary: call.arguments.summary,
          evidence: call.arguments.evidence,
        });
        if (!finding) return { ok: false, observation: "invalid finding: kind must be incident|slow-burn|correlation" };
        const line = `${JSON.stringify(finding)}\n`;
        const existing = await runner.read(findingsPath).catch(() => "");
        await runner.write(findingsPath, `${existing}${line}`);
        return { ok: true, observation: `recorded ${finding.kind}: ${finding.summary}` };
      }
      return { ok: false, observation: `unknown tool ${call.name}` };
    },

    async readFindings(): Promise<ReportedFinding[]> {
      const text = await runner.read(findingsPath).catch(() => "");
      return text
        .split("\n")
        .filter(Boolean)
        .map((line) => normalizeReportedFinding(JSON.parse(line)))
        .filter((finding): finding is ReportedFinding => finding !== undefined);
    },
  };
}

export function buildSwarmSystemPrompt(tools: readonly SwarmToolDefinition[] = SWARM_TOOL_DEFINITIONS): string {
  const catalog = tools.map((tool) => {
    const properties = (tool.parameters.properties ?? {}) as Record<string, { type?: string }>;
    const required = new Set(((tool.parameters.required as string[] | undefined) ?? []));
    const params = Object.entries(properties)
      .map(([name, spec]) => `${name}${required.has(name) ? "" : "?"}: ${spec.type ?? "any"}`)
      .join(", ");
    return `- ${tool.name}(${params}) — ${tool.description}`;
  });
  return [
    "You are an operations analyst reading a stream of events from several sources.",
    "Find the signals that matter and report each as a finding with the event ids that evidence it.",
    "Kinds:",
    '- "incident": a service is failing or degraded and needs action now.',
    '- "slow-burn": a metric or behaviour worsening steadily across many events, with no single alert.',
    '- "correlation": two or more sources that together point at one cause (cite BOTH sides).',
    "Report only real signals. Some events look significant but are expected or benign; reporting those is a false positive.",
    "Some events are genuinely ambiguous and can be read either way; you may report them, and they are judged separately.",
    "The ONLY tools are:",
    ...catalog,
    "When you have reported every signal you can evidence, call `finish`.",
    "Reply with ONLY a JSON object of the form:",
    '{"tool_calls":[{"name":"<tool>","arguments":{...}}]}',
    "You may request one or more tool calls per reply, in order. No prose, no markdown, no code fences.",
  ].join("\n");
}

export function buildSwarmUserPrompt(stream: SignalStream): string {
  return `Read the event stream "${stream.name}" (${stream.events.length} events, in order). Report the findings you can evidence, then finish.`;
}
