/**
 * Overlay for current Pi experimental mini worker.
 * Adds the transparent OpenCode Go subscription pool while preserving the normal
 * Pi model service and any synthetic MemoryExecutionEnv workspace.
 */

import {
  AgentHarness,
  BACKGROUND_CONTEXT,
  type Context,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type ExecutionEnv,
  type JsonlSessionMetadata,
  JsonlSessionRepo,
  type Session,
} from "@earendil-works/pi-agent-core";
import { GitHubSnapshotSource, MemoryExecutionEnv } from "@earendil-works/pi-agent-core/harness/env/memory";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { findInitialModel } from "../../../core/model-resolver.ts";
import { ModelRuntime } from "../../../core/model-runtime.ts";
import {
  createTransparentModels,
  manualFallbacksFromEnv,
  openCodeGoAccountsFromEnv,
  type OpenCodeGoAccountConfig,
} from "../../stack-router/index.ts";
import { Lane, Models, Worker } from "../shared/protocol.ts";
import { createPeer } from "../shared/rpc.ts";
import { parentConnection } from "../shared/transport.ts";
import { LaneService } from "./lane-service.ts";
import { ModelsService } from "./models-service.ts";

function systemPrompt(cwd: string): string {
  return [
    "You are a coding agent working in a terminal.",
    `Working directory: ${cwd}`,
    "Use the read, write, edit, and bash tools to inspect and change files.",
    "The terminal may be a synthetic in-memory machine. Unsupported native commands fail explicitly.",
    "Keep answers short and technical.",
  ].join("\n");
}

async function openSession(
  repo: JsonlSessionRepo,
  sessionId: string | undefined,
  cwd: string,
  context: Context,
): Promise<Session<JsonlSessionMetadata>> {
  if (sessionId === undefined) return repo.create({ cwd }, context);
  const metadata = (await repo.list(undefined, context)).find((candidate) => candidate.id === sessionId);
  if (!metadata) throw new Error(`Unknown session: ${sessionId}`);
  return repo.open(metadata, context);
}

function syntheticWorkspaceFromEnv(): MemoryExecutionEnv | undefined {
  const repoSpec = process.env.PI_SYNTH_GITHUB_REPO?.trim();
  if (!repoSpec) return undefined;
  const [owner, repo, ...extra] = repoSpec.split("/").filter(Boolean);
  if (!owner || !repo || extra.length > 0) throw new Error("PI_SYNTH_GITHUB_REPO must be owner/repo");
  const sparse = process.env.PI_SYNTH_GITHUB_SPARSE
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const source = new GitHubSnapshotSource({
    owner,
    repo,
    ref: process.env.PI_SYNTH_GITHUB_REF || "HEAD",
    token: process.env.GITHUB_TOKEN,
    sparse,
  });
  return new MemoryExecutionEnv({ cwd: "/workspace", source });
}

function resolveKey(account: OpenCodeGoAccountConfig | undefined): string | undefined {
  if (!account) return undefined;
  if (account.apiKey) return account.apiKey;
  return account.apiKeyEnv ? process.env[account.apiKeyEnv] : undefined;
}

export async function runSessionWorker(options: {
  sessionsRoot: string;
  sessionId?: string;
  cwd: string;
}): Promise<void> {
  const context = BACKGROUND_CONTEXT;
  const manualRuntime = await ModelRuntime.create();
  const stackAccounts = openCodeGoAccountsFromEnv();

  // Mirror the first stack account only for existing Pi discovery/account UI.
  // Inference itself is intercepted by OpenCodeStackModels below.
  const primaryKey = resolveKey(stackAccounts[0]);
  if (primaryKey) await manualRuntime.setRuntimeApiKey("opencode-go", primaryKey);

  const { model, thinkingLevel } = await findInitialModel({
    scopedModels: [],
    isContinuing: false,
    modelRuntime: manualRuntime,
  });
  if (!model) throw new Error("No model available. Configure credentials with `pi` first.");

  const sessionEnv = new NodeExecutionEnv({ cwd: options.cwd });
  const synthetic = syntheticWorkspaceFromEnv();
  const workspaceEnv: ExecutionEnv = synthetic ?? new NodeExecutionEnv({ cwd: options.cwd });
  const agentCwd = synthetic?.cwd ?? options.cwd;

  const repo = new JsonlSessionRepo({ fileSystem: sessionEnv, sessionsRoot: options.sessionsRoot });
  const session = await openSession(repo, options.sessionId, agentCwd, context);

  const routed =
    stackAccounts.length > 0
      ? await createTransparentModels({
          manualRuntime,
          mirrorPrimaryToManual: false,
          sessionId: session.metadata.id,
          config: {
            openCodeGo: {
              strategy:
                process.env.PI_OPENCODE_GO_STRATEGY === "ordered" || process.env.PI_OPENCODE_GO_STRATEGY === "round-robin"
                  ? process.env.PI_OPENCODE_GO_STRATEGY
                  : "sticky-least-loaded",
              accounts: stackAccounts,
            },
            fallbacks: manualFallbacksFromEnv(),
          },
          onEvent: process.env.PI_INFERENCE_ROUTER_LOG === "1" ? (event) => console.error("[inference-router]", event) : undefined,
        })
      : { manual: manualRuntime, models: manualRuntime };

  const { harness, open } = await AgentHarness.create(
    {
      session,
      models: routed.models,
      model,
      thinkingLevel,
      tools: [createReadTool(), createWriteTool(), createEditTool(), createBashTool()],
      toolContext: { env: workspaceEnv },
      systemPrompt: systemPrompt(agentCwd),
    },
    context,
  );
  const lane = await harness.lane("main", context);
  const connection = parentConnection();
  const peer = createPeer(connection);

  // Existing UI/catalog/login service remains the ordinary Pi runtime.
  const modelsService = new ModelsService(manualRuntime, (event) => peer.emit(Models, event));
  const laneService = new LaneService({
    lane,
    models: routed.models,
    context,
    session: { id: session.metadata.id, cwd: agentCwd, path: session.metadata.path },
    modelsState: () => modelsService.state,
    publish: (subscriptionId, to, event) => peer.emitTo(Lane, { subscriptionId, event }, to),
  });
  peer.provide(Lane, laneService);
  peer.provide(Models, modelsService);
  peer.provide(Worker, { describe: async () => ({ sessionId: session.metadata.id }) });

  const recoveries = open.map(async (operation) => {
    try {
      const restoredLane = operation.lane === lane.name ? lane : await harness.lane(operation.lane, context);
      const result = await restoredLane.resume(context);
      if (!result.ok) throw result.error;
    } catch (error) {
      console.error(`Failed to resume ${operation.lane}/${operation.operationId}:`, error);
    }
  });

  await new Promise<void>((resolve) => connection.onClose(resolve));
  laneService.close();
  await harness.close(context).catch(() => {});
  await Promise.all(recoveries);
  await repo.close(context).catch(() => {});
  await workspaceEnv.cleanup(context).catch(() => {});
  if (workspaceEnv !== sessionEnv) await sessionEnv.cleanup(context).catch(() => {});
}
