/**
 * Live measurement: the same gym task, same model and same gym harness on the
 * SYNTHETIC rung instead of the gVisor sandbox.
 *
 * The question this project exists for is how far an agent gets in the CHEAP
 * world before it must escalate to the isolated one. The synthetic rung
 * (`MemoryWorkspace` + `SyntheticExecutor` through the `ExecutionBroker`)
 * executes `workspace.list/read/write/replace` in worker RAM and returns
 * `ESCALATION_REQUIRED` for `process.exec`. So `run_visible_test` — and the git
 * harvest — cannot run: the agent hits a wall there, and *that wall is the
 * measurement* (how many tool calls complete in the cheap world, and which).
 *
 * This is a CONTROL / DEV driver: the rung is unisolated (worker RAM), it uses
 * no Temporal, and it cannot score (the harvest escalates, so no patch leaves
 * the synthetic world). It drives the plain loop (`runGymAttempt` +
 * `createGatewayGymTurn`) — the same harness the sandbox plain arm uses; only
 * the `EffectRunner` differs. It therefore measures the model+tool trajectory
 * in the cheap world, not durability.
 *
 * Run (needs a live gateway and a warm fixture cache):
 *
 *   SYNTH_FIXTURE_REPOS=/tmp/opencode/fixture-repos \
 *   SYNTH_GATEWAY_URL=http://127.0.0.1:8787 \
 *   integrations/temporal/node_modules/.bin/tsx integrations/gym/synthetic-rung-compare.ts \
 *     --task test/fixtures/gym-tasks/he/hex-decode --model kimi-k2.7-code --turns 6
 *
 * A missing gateway is a SKIP (exit 2), never a pass, per the repo's contract.
 *
 * Recorded result (2026-09-21; task `he/hex-decode`, model `kimi-k2.7-code`,
 * gateway via loopback): `callCount 5`, `turns 5`, **tool calls completed 4 / 6**,
 * `outcome errored` (`ESCALATION_REQUIRED` raised at harvest). Trajectory:
 * `list_files`, `read_file(he.js)`, `read_file(test/visible.test.mjs)` →
 * `run_visible_test` (**ESCALATION_REQUIRED** — the wall) → `replace_in_file`
 * (the correct fix, made without any green test) → `run_visible_test`
 * (**ESCALATION_REQUIRED** again) → `finish`. Sandbox durable reference for the
 * same task/model: 5 calls (`list_files`, `read_file`, `replace_in_file`,
 * `run_visible_test`, `finish`). Full write-up: `docs/GYM-SYNTHETIC-RUNG.md`.
 *
 * The result is expected to move with a different model, a harder task, or once
 * harvest can leave the synthetic world — which is exactly why it is committed
 * and re-runnable rather than a one-off.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  brokerEffectRunner,
  createGatewayGymTurn,
  ExecutionBroker,
  loadGymTask,
  LocalRuntimeStateStore,
  materializeGymTask,
  MemoryWorkspace,
  runGymAttempt,
  SyntheticExecutor,
  type GymTurn,
  type MaterializedGymTask,
} from "../../src/index.js";
import { LocalDirSource } from "./sandbox.js";

/** Distinct non-pass outcome for missing infrastructure: exit 2. */
class SkippedError extends Error {
  readonly exitCode = 2;
}

function parseArgs(argv: readonly string[]): Map<string, string | true> {
  const out = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out.set(key, next);
      i++;
    } else {
      out.set(key, true);
    }
  }
  return out;
}

function arg(args: Map<string, string | true>, name: string): string | undefined {
  const value = args.get(name);
  return typeof value === "string" ? value : undefined;
}

async function preflightGateway(baseUrl: string): Promise<void> {
  const url = `${baseUrl.replace(/\/$/, "")}/v1/models`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    throw new SkippedError(`gateway not reachable at ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const taskDir = resolve(arg(args, "task") ?? "test/fixtures/gym-tasks/he/hex-decode");
  const gatewayBaseUrl = arg(args, "gateway") ?? process.env.SYNTH_GATEWAY_URL ?? "http://127.0.0.1:8787";
  const model = arg(args, "model") ?? process.env.SYNTH_GYM_MODEL ?? "kimi-k2.7-code";
  const maxTurns = Number(arg(args, "turns") ?? process.env.SYNTH_MAX_TURNS ?? "6");
  const deadlineMs = Number(arg(args, "deadline-ms") ?? process.env.SYNTH_DEADLINE_MS ?? "300000");
  const fixtureCacheDir = process.env.SYNTH_FIXTURE_REPOS;

  await preflightGateway(gatewayBaseUrl);

  const task = await loadGymTask(taskDir);
  const work = await mkdtemp(join(tmpdir(), "gym-synthetic-"));
  try {
    const materialized: MaterializedGymTask = await materializeGymTask({
      task,
      workDir: work,
      repoDirName: `synthetic-${Date.now().toString(36)}`,
      ...(fixtureCacheDir ? { fixtureCacheDir } : {}),
    });

    // The synthetic rung: workspace effects run in worker RAM over a memory
    // workspace seeded from the materialized checkout; `process.exec` escalates.
    const workspaceId = `gym:${materialized.task.slug}` as never;
    const workspace = new MemoryWorkspace({ id: workspaceId, source: new LocalDirSource(materialized.repoDir) });
    const workspaces = new Map([[workspace.id, workspace]]);
    const broker = new ExecutionBroker([new SyntheticExecutor(workspaces)], new LocalRuntimeStateStore());
    const runner = brokerEffectRunner(broker, { agentId: `gym-${materialized.task.slug}` as never, workspaceId }, "synthetic");

    const trajectory: Array<Record<string, unknown>> = [];
    const baseTurn = createGatewayGymTurn({ baseUrl: gatewayBaseUrl, model });
    const turn: GymTurn = async (input) => {
      const result = await baseTurn(input);
      trajectory.push({ kind: "assistant", turn: input.turnIndex, content: (result.content ?? JSON.stringify(result.toolCalls)).slice(0, 400) });
      return result;
    };

    const record = await runGymAttempt({
      task: materialized,
      runner,
      turn,
      maxTurns,
      deadlineMs,
      onTool: ({ turnIndex, call, ok, observation }) =>
        trajectory.push({ kind: "tool", turn: turnIndex, name: call.name, args: call.arguments, ok, observation: observation.slice(0, 400) }),
    });

    const toolCalls = trajectory.filter((entry) => entry.kind === "tool");
    console.log(JSON.stringify({
      role: "control",
      rung: "synthetic",
      isolation: "unisolated",
      unisolated: true,
      scored: false,
      note: "plain loop, no Temporal; the synthetic rung cannot exec and cannot harvest a patch",
      task: `${task.repo}/${task.slug}`,
      model,
      gateway: gatewayBaseUrl,
      maxTurns,
      outcome: record.outcome,
      error: record.error,
      callCount: record.callCount,
      turns: record.turns,
      toolCallsCompleted: toolCalls.filter((entry) => entry.ok === true).length,
      toolCallsTotal: toolCalls.length,
      wallTimeMs: record.wallTimeMs,
      requestedModel: record.requestedModel,
      servedModel: record.servedModel,
      modelSubstituted: record.modelSubstituted,
      trajectory,
    }, null, 2));
    return 0;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    if (error instanceof SkippedError) {
      console.log(JSON.stringify({ ok: false, skipped: true, reason: error.message }, null, 2));
      process.exit(2);
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
