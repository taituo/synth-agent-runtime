/**
 * Session probes: how the supervisor learns whether a session is idle, working,
 * blocked or done.
 *
 * Preference order is deliberate: herdr exposes a real per-pane state, so use
 * it when present. tmux does not, so the tmux probe is a documented heuristic
 * (it scrapes the pane for a marker) and reports `probe: "tmux"` so a guess is
 * never mistaken for a real signal. `unknown` is a real answer.
 */
import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import type { ProbeKind, ProbeResult, PokeResult, SessionMarkers, SessionStatus } from "./contracts.js";

const execFileAsync = promisify(execFile);

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

export const defaultCommandRunner: CommandRunner = async (command, args) => {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { maxBuffer: 16 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message ?? "" };
  }
};

export function lastNonEmptyLine(text: string): string {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

/**
 * Classify a tmux pane by scraping it. `working` defaults to the string the
 * manual monitor grepped for. This is a heuristic, not a state API.
 */
export function classifyTmuxPane(text: string, markers: SessionMarkers = {}): SessionStatus {
  const working = markers.working ?? "esc interrupt";
  if (text.includes(working)) return "working";
  if (markers.blocked && text.includes(markers.blocked)) return "blocked";
  return "idle";
}

/** Map a herdr state document to our status. Unparseable or unknown -> unknown. */
export function classifyHerdrState(raw: string): SessionStatus {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "unknown";
  }
  const status = typeof parsed === "object" && parsed !== null ? (parsed as { status?: unknown }).status : undefined;
  return status === "idle" || status === "working" || status === "blocked" || status === "done" ? status : "unknown";
}

export interface SessionProbe {
  readonly kind: ProbeKind;
  probe(target: string): Promise<ProbeResult>;
  poke(target: string, text: string): Promise<PokeResult>;
}

export class TmuxSessionProbe implements SessionProbe {
  readonly kind: ProbeKind = "tmux";
  constructor(private readonly run: CommandRunner, private readonly markers: SessionMarkers = {}) {}

  async probe(target: string): Promise<ProbeResult> {
    const dead = await this.run("tmux", ["display-message", "-p", "-t", target, "#{pane_dead}"]);
    if (dead.code !== 0) return { status: "unknown", evidence: dead.stderr.trim() || `tmux exit ${dead.code}`, probe: this.kind };
    if (dead.stdout.trim() === "1") return { status: "done", evidence: "pane_dead=1", probe: this.kind };
    const capture = await this.run("tmux", ["capture-pane", "-p", "-t", target]);
    if (capture.code !== 0) return { status: "unknown", evidence: capture.stderr.trim(), probe: this.kind };
    return { status: classifyTmuxPane(capture.stdout, this.markers), evidence: lastNonEmptyLine(capture.stdout), probe: this.kind };
  }

  /** Send the text, then a separate Enter, then CONFIRM it landed (never assume). */
  async poke(target: string, text: string): Promise<PokeResult> {
    let attempts = 0;
    for (attempts = 1; attempts <= 3; attempts++) {
      await this.run("tmux", ["send-keys", "-t", target, "-l", text]);
      await this.run("tmux", ["send-keys", "-t", target, "Enter"]);
      await sleep(200);
      const capture = await this.run("tmux", ["capture-pane", "-p", "-t", target]);
      if (capture.code === 0 && capture.stdout.includes(text)) return { delivered: true, attempts, evidence: text };
    }
    return { delivered: false, attempts: 3, evidence: "text was not seen in the pane after 3 attempts" };
  }
}

/**
 * herdr exposes a real per-pane state. The exact CLI invocation is configurable
 * because herdr is not installed in this environment; `classifyHerdrState` is
 * unit-tested against the documented shape, and the live proof uses tmux.
 */
export class HerdrSessionProbe implements SessionProbe {
  readonly kind: ProbeKind = "herdr";
  constructor(
    private readonly run: CommandRunner,
    private readonly options: { bin?: string; stateArgs?: string[]; sendArgs?: string[] } = {},
  ) {}

  async probe(target: string): Promise<ProbeResult> {
    const bin = this.options.bin ?? "herdr";
    const result = await this.run(bin, [...(this.options.stateArgs ?? ["state", "--json"]), target]);
    if (result.code !== 0) return { status: "unknown", evidence: result.stderr.trim() || `herdr exit ${result.code}`, probe: this.kind };
    return { status: classifyHerdrState(result.stdout), evidence: result.stdout.trim().slice(0, 120), probe: this.kind };
  }

  async poke(target: string, text: string): Promise<PokeResult> {
    const bin = this.options.bin ?? "herdr";
    const result = await this.run(bin, [...(this.options.sendArgs ?? ["send"]), target, text]);
    return result.code === 0
      ? { delivered: true, attempts: 1, evidence: "herdr send exit 0" }
      : { delivered: false, attempts: 1, evidence: result.stderr.trim() || `herdr exit ${result.code}` };
  }
}

/** A scripted probe for tests and the workflow's zero-cost dry run. */
export class ScriptedSessionProbe implements SessionProbe {
  readonly kind: ProbeKind = "tmux";
  readonly pokes: string[] = [];
  #index = 0;
  constructor(private readonly statuses: SessionStatus[] | (() => SessionStatus)) {}

  async probe(): Promise<ProbeResult> {
    const status = typeof this.statuses === "function" ? this.statuses() : this.statuses[Math.min(this.#index++, this.statuses.length - 1)] ?? "idle";
    return { status, evidence: `scripted:${status}`, probe: this.kind };
  }

  async poke(_target: string, text: string): Promise<PokeResult> {
    this.pokes.push(text);
    return { delivered: true, attempts: 1, evidence: text };
  }
}
