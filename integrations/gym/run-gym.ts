/**
 * Gym driver: preflight, then run one task through BOTH arms.
 *
 *   # zero model calls, no cluster, no gateway:
 *   integrations/temporal/node_modules/.bin/tsx integrations/gym/run-gym.ts --dry-run
 *
 *   # live: required deps are checked first; a missing one exits 2 (skipped),
 *   # never 0, so a skip is never reported as a pass.
 *   SYNTH_GATEWAY_URL=... SYNTH_EXECUTOR_IMAGE=... npm run gym:run
 *
 * The four assertions this milestone is judged by live in the tests:
 * `test/gym-task.test.ts` (hidden test fails on a fresh materialized task;
 * golden reverse patch passes), `test/gym-harvest.test.ts` (node_modules
 * excluded), and this driver's `--dry-run` (whole pipeline at zero model cost).
 */
import { execFileSync } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertScoredRunnerAllowed,
  createGatewayGymTurn,
  createScriptedGymTurn,
  DEFAULT_GATEWAY_RETRY,
  DEFAULT_GYM_FIXTURE_CACHE_DIR,
  describeGymRunner,
  goldenReversePatch,
  loadGymTask,
  localEffectRunner,
  materializeGymTask,
  parseGymRunner,
  runGymAttempt,
  UnisolatedScoredRunError,
  type EffectRunner,
  type GymRunnerKind,
  type GymTurn,
  type MaterializedGymTask,
} from "../../src/index.js";
import { buildSandboxRunner } from "./sandbox.js";

interface ArmResult {
  arm: "plain" | "durable";
  /**
   * Which arm this is, named. `control` is the same task with no runtime (a
   * plain loop); `temporal` is the durable arm, driven by the `gymAttemptWorkflow`
   * Temporal workflow and its activity, never a local direct call. The dry-run
   * arm is `control` too: it simulates durability with a local retry, so it is
   * never labelled `temporal`.
   */
  role?: "control" | "temporal";
  /** The boundary this arm actually ran in, carried from the workflow output. */
  isolation?: "unisolated" | "gvisor";
  outcome: string;
  requestedModel: string | null;
  servedModel: string | null;
  modelSubstituted: boolean;
  wallTimeMs: number;
  callCount: number;
  protectedPathsTouched: string[];
  patchBytes: number;
  turns?: number;
  detail?: string;
  error?: string;
  trace?: string[];
}

/** Distinct non-pass outcome for a missing dependency: exit 2. */
class SkippedError extends Error {
  readonly exitCode = 2;
  constructor(message: string) {
    super(message);
    this.name = "SkippedError";
  }
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

function hasFlag(args: Map<string, string | true>, name: string): boolean {
  return args.has(name);
}

function arg(args: Map<string, string | true>, name: string): string | undefined {
  const value = args.get(name);
  return typeof value === "string" ? value : undefined;
}

async function preflightFixtureCache(cacheDir: string, repo: string): Promise<void> {
  const cache = join(cacheDir, `${repo}.git`, "HEAD");
  try {
    await access(cache);
  } catch {
    throw new SkippedError(`fixture cache cold: ${cache} missing (set SYNTH_FIXTURE_REPOS or warm the cache)`);
  }
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

function preflightCluster(): string {
  const image = process.env.SYNTH_EXECUTOR_IMAGE;
  if (!image) throw new SkippedError("SYNTH_EXECUTOR_IMAGE not set (must be a node+git image pinned by digest; the Pod runs run_visible_test, so git-only images exit 127)");
  try {
    execFileSync("kubectl", ["version", "--client"], { stdio: "ignore" });
  } catch {
    throw new SkippedError("kubectl is not installed");
  }
  return image;
}

/** The dry-run turn: apply the golden fix, prove the visible test passes, finish. */
function goldenFixTurn(runner: EffectRunner, materialized: MaterializedGymTask, golden: string): GymTurn {
  return async () => {
    const patchPath = ".gym-fix.patch";
    await runner.write(patchPath, golden);
    const applied = await runner.exec(`git apply ${patchPath}`, { cwd: materialized.repoDir });
    if (applied.code !== 0) throw new Error(`dry-run could not apply golden patch: ${applied.stderr || applied.stdout}`);
    await runner.exec(`rm -f ${patchPath}`, { cwd: materialized.repoDir });
    return { toolCalls: [{ name: "run_visible_test" }, { name: "finish" }], requestedModel: "dry-run", servedModel: "dry-run" };
  };
}

async function runDryArm(
  arm: "plain" | "durable",
  materialized: MaterializedGymTask,
  maxTurns: number,
  deadlineMs: number,
  attempts: number,
): Promise<ArmResult> {
  const runner = localEffectRunner(materialized.repoDir);
  const golden = await goldenReversePatch(materialized.baseRepoDir, materialized.task.mutationPatch);
  const base = goldenFixTurn(runner, materialized, golden);
  // The durable arm's model boundary fails once with a transient 429, and the
  // durable supervisor around the shared loop re-runs the attempt. The loop
  // itself is byte-identical for both arms, which is the point of the
  // experiment; durability is the injected difference.
  let transientInjected = false;
  const turn: GymTurn = arm === "durable"
    ? async (input) => {
        if (!transientInjected) {
          transientInjected = true;
          throw Object.assign(new Error("injected transient 429"), { retryAfterMs: 1 });
        }
        return base(input);
      }
    : base;

  let record = await runGymAttempt({ task: materialized, runner, turn, maxTurns, deadlineMs });
  let totalWall = record.wallTimeMs;
  let totalCalls = record.callCount;
  if (arm === "durable") {
    for (let attempt = 1; attempt < attempts && record.outcome === "errored"; attempt++) {
      record = await runGymAttempt({ task: materialized, runner, turn, maxTurns, deadlineMs });
      totalWall += record.wallTimeMs;
      totalCalls += record.callCount;
    }
  }
  return {
    arm,
    // The dry run simulates durability with a local retry and drives the
    // in-process `localEffectRunner`: a labelled control, never a Temporal arm.
    role: "control",
    isolation: "unisolated",
    outcome: record.outcome,
    requestedModel: record.requestedModel,
    servedModel: record.servedModel,
    modelSubstituted: record.modelSubstituted,
    wallTimeMs: totalWall,
    callCount: totalCalls,
    protectedPathsTouched: record.protectedPathsTouched,
    patchBytes: record.patch.length,
    ...(record.score.detail ? { detail: record.score.detail } : {}),
    ...(record.error ? { error: record.error } : {}),
  };
}

async function runLivePlain(
  materialized: MaterializedGymTask,
  gatewayBaseUrl: string,
  model: string,
  image: string,
  maxTurns: number,
  deadlineMs: number,
  runnerKind: GymRunnerKind,
  gatewayTimeoutMs?: number,
  retry?: number,
): Promise<ArmResult> {
  const sandbox = runnerKind === "sandbox"
    ? await buildSandboxRunner({
        repoDir: materialized.repoDir,
        image,
        ...(process.env.SYNTH_KUBERNETES_NAMESPACE ? { namespace: process.env.SYNTH_KUBERNETES_NAMESPACE } : {}),
        ...(process.env.SYNTH_KUBECTL_CONTEXT ? { kubectlContext: process.env.SYNTH_KUBECTL_CONTEXT } : {}),
        ...(process.env.SYNTH_RUNTIME_CLASS ? { runtimeClassName: process.env.SYNTH_RUNTIME_CLASS } : {}),
      })
    : undefined;
  try {
    const runner = sandbox ? sandbox.runner : localEffectRunner(materialized.repoDir);
    const turn = createGatewayGymTurn({
      baseUrl: gatewayBaseUrl,
      model,
      ...(process.env.SYNTH_GATEWAY_API_KEY ? { apiKey: process.env.SYNTH_GATEWAY_API_KEY } : {}),
      ...(gatewayTimeoutMs ? { timeoutMs: gatewayTimeoutMs } : {}),
      ...(retry && retry > 1 ? { retry: { ...DEFAULT_GATEWAY_RETRY, maxAttempts: retry } } : {}),
    });
    const trace: string[] = [];
    const tracedTurn: GymTurn = async (input) => {
      const result = await turn(input);
      trace.push(`assistant: ${(result.content ?? JSON.stringify(result.toolCalls)).slice(0, 500)}`);
      return result;
    };
    const record = await runGymAttempt({
      task: materialized,
      runner,
      turn: tracedTurn,
      maxTurns,
      deadlineMs,
      // On the sandbox runner, run_visible_test must invoke the Pod's node.
      ...(runnerKind === "sandbox" ? { visibleTestNodeBin: "node" } : {}),
      onTool: ({ call, observation }) => trace.push(`tool ${call.name}: ${observation.slice(0, 300)}`),
    });
    return {
      arm: "plain",
      role: "control",
      isolation: describeGymRunner(runnerKind).isolation,
      outcome: record.outcome,
      requestedModel: record.requestedModel,
      servedModel: record.servedModel,
      modelSubstituted: record.modelSubstituted,
      wallTimeMs: record.wallTimeMs,
      callCount: record.callCount,
      turns: record.turns,
      protectedPathsTouched: record.protectedPathsTouched,
      patchBytes: record.patch.length,
      trace,
      ...(record.score.detail ? { detail: record.score.detail } : {}),
      ...(record.error ? { error: record.error } : {}),
    };
  } finally {
    await sandbox?.close();
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

async function runDurableWorkflow(
  materialized: MaterializedGymTask,
  gatewayBaseUrl: string,
  model: string,
  image: string,
  maxTurns: number,
  deadlineMs: number,
  runnerKind: GymRunnerKind,
  gatewayTimeoutMs?: number,
  retry?: number,
): Promise<ArmResult> {
  const temporal = await loadTemporalClient();
  const connection = await temporal.Connection.connect(process.env.SYNTH_TEMPORAL_ADDRESS ? { address: process.env.SYNTH_TEMPORAL_ADDRESS } : undefined);
  const client = new temporal.Client({ connection });
  const input = {
    agentId: `gym-${materialized.task.slug}`,
    taskDir: materialized.task.taskDir,
    workDir: join(materialized.baseRepoDir, ".."),
    gatewayBaseUrl,
    model,
    // Both arms must send the same request; without this the durable arm
    // omitted the Authorization header the plain arm sent, so an authenticated
    // gateway would make them differ by more than durability.
    ...(process.env.SYNTH_GATEWAY_API_KEY ? { apiKey: process.env.SYNTH_GATEWAY_API_KEY } : {}),
    maxTurns,
    deadlineMs,
    runner: runnerKind,
    ...(gatewayTimeoutMs ? { gatewayTimeoutMs } : {}),
    ...(retry && retry > 1 ? { retryMaxAttempts: retry } : {}),
    image,
    ...(process.env.SYNTH_KUBERNETES_NAMESPACE ? { namespace: process.env.SYNTH_KUBERNETES_NAMESPACE } : {}),
    ...(process.env.SYNTH_KUBECTL_CONTEXT ? { kubectlContext: process.env.SYNTH_KUBECTL_CONTEXT } : {}),
    ...(process.env.SYNTH_RUNTIME_CLASS ? { runtimeClassName: process.env.SYNTH_RUNTIME_CLASS } : {}),
    ...(process.env.SYNTH_FIXTURE_REPOS ? { fixtureCacheDir: process.env.SYNTH_FIXTURE_REPOS } : {}),
  };
  const workflowId = `gym-${materialized.task.slug}-${Date.now().toString(36)}`;
  const handle = await client.workflow.start("gymAttemptWorkflow", {
    taskQueue: process.env.SYNTH_GYM_TASK_QUEUE ?? "synth-agent-runtime",
    workflowId,
    args: [{ ...input, checkpointKey: workflowId }],
    workflowExecutionTimeout: "2 hours",
  });
  const output = (await handle.result()) as Omit<ArmResult, "arm" | "patchBytes"> & { detail?: string; error?: string };
  return {
    arm: "durable",
    role: "temporal",
    isolation: output.isolation ?? describeGymRunner(runnerKind).isolation,
    outcome: output.outcome,
    requestedModel: output.requestedModel,
    servedModel: output.servedModel,
    modelSubstituted: output.modelSubstituted,
    wallTimeMs: output.wallTimeMs,
    callCount: output.callCount,
    protectedPathsTouched: output.protectedPathsTouched,
    patchBytes: output.patchBytes ?? 0,
    ...(output.detail ? { detail: output.detail } : {}),
    ...(output.error ? { error: output.error } : {}),
  };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = hasFlag(args, "dry-run");
  const taskDir = resolve(arg(args, "task") ?? "test/fixtures/gym-tasks/he/hex-decode");
  const maxTurns = Number(arg(args, "turns") ?? 8);
  const attempts = Number(arg(args, "attempts") ?? 3);
  const deadlineMs = Number(arg(args, "deadline-ms") ?? 10 * 60_000);
  const arms = (arg(args, "arm") ?? "both") as "plain" | "durable" | "both";
  const model = arg(args, "model") ?? process.env.SYNTH_GYM_MODEL ?? "deepseek-v4.1-flash";
  const gatewayBaseUrl = arg(args, "gateway") ?? process.env.SYNTH_GATEWAY_URL ?? "http://127.0.0.1:8787";
  const fixtureCacheDir = process.env.SYNTH_FIXTURE_REPOS ?? DEFAULT_GYM_FIXTURE_CACHE_DIR;
  const runnerKind = parseGymRunner(arg(args, "runner"));
  const gatewayTimeoutMs = arg(args, "gateway-timeout-ms") ? Number(arg(args, "gateway-timeout-ms")) : undefined;
  const retry = arg(args, "retry") ? Number(arg(args, "retry")) : 0;

  const task = await loadGymTask(taskDir);
  const work = await mkdtemp(join(tmpdir(), "gym-run-"));
  const results: ArmResult[] = [];
  try {
    if (!dryRun) {
      // The cross-arm artifact must say which boundary the run had. A scored run
      // may not proceed on the unisolated local runner (ground-truth leak).
      assertScoredRunnerAllowed(runnerKind);
      await preflightFixtureCache(fixtureCacheDir, task.repo);
      await preflightGateway(gatewayBaseUrl);
    }
    const image = dryRun || runnerKind === "local" ? "" : preflightCluster();

    for (const arm of arms === "both" ? (["plain", "durable"] as const) : ([arms] as const)) {
      const materialized = await materializeGymTask({ task, workDir: work, repoDirName: `${arm}-${Date.now().toString(36)}`, fixtureCacheDir });
      if (dryRun) results.push(await runDryArm(arm, materialized, maxTurns, deadlineMs, attempts));
      else if (arm === "plain") results.push(await runLivePlain(materialized, gatewayBaseUrl, model, image, maxTurns, deadlineMs, runnerKind, gatewayTimeoutMs, retry));
      else results.push(await runDurableWorkflow(materialized, gatewayBaseUrl, model, image, maxTurns, deadlineMs, runnerKind, gatewayTimeoutMs, retry));
    }

    const ok = results.every((result) => result.outcome === "passed");
    // The dry-run arm always drives `localEffectRunner`, so it is labelled
    // unisolated regardless of what `--runner` was passed. A live run carries
    // the runner that actually ran.
    const binding = describeGymRunner(dryRun ? "local" : runnerKind);
    console.log(JSON.stringify({
      ok,
      dryRun,
      task: `${task.repo}/${task.slug}`,
      runner: binding.kind,
      isolation: binding.isolation,
      ...(binding.isolated ? {} : { unisolated: true }),
      modelCalls: dryRun ? 0 : undefined,
      results,
    }, null, 2));
    return ok ? 0 : 1;
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
    if (error instanceof UnisolatedScoredRunError) {
      // A refusal, not a pass: distinct exit 2 so a run that never happened is
      // never reported as green.
      console.log(JSON.stringify({ ok: false, skipped: true, unisolated: true, reason: error.message }, null, 2));
      process.exit(2);
    }
    console.error(error);
    process.exit(1);
  });
