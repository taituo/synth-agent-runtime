/**
 * Prototype replacement for:
 * packages/coding-agent/src/experimental/mini/worker/run.ts
 *
 * When PI_SYNTH_GITHUB_REPO=owner/repo is set, the agent's workspace is a
 * demand-paged GitHub commit snapshot with an in-memory overlay. Session JSONL
 * remains on the trusted Node filesystem. Without that env var, behavior is
 * identical to the existing NodeExecutionEnv worker.
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
	if (!owner || !repo || extra.length > 0) {
		throw new Error("PI_SYNTH_GITHUB_REPO must be owner/repo");
	}
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

/** Run one session worker until its stdio closes. `sessionId` undefined creates a new session. */
export async function runSessionWorker(options: {
	sessionsRoot: string;
	sessionId?: string;
	cwd: string;
}): Promise<void> {
	const context = BACKGROUND_CONTEXT;
	const modelRuntime = await ModelRuntime.create();
	const { model, thinkingLevel } = await findInitialModel({ scopedModels: [], isContinuing: false, modelRuntime });
	if (!model) throw new Error("No model available. Configure credentials with `pi` first.");

	// Durable trusted control-plane/session storage stays on Node/disk.
	const sessionEnv = new NodeExecutionEnv({ cwd: options.cwd });
	// Agent-visible project workspace may be fully synthetic and in-memory.
	const synthetic = syntheticWorkspaceFromEnv();
	const workspaceEnv: ExecutionEnv = synthetic ?? new NodeExecutionEnv({ cwd: options.cwd });
	const agentCwd = synthetic?.cwd ?? options.cwd;

	const repo = new JsonlSessionRepo({ fileSystem: sessionEnv, sessionsRoot: options.sessionsRoot });
	const session = await openSession(repo, options.sessionId, agentCwd, context);
	const { harness, open } = await AgentHarness.create(
		{
			session,
			models: modelRuntime,
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

	const models = new ModelsService(modelRuntime, (event) => peer.emit(Models, event));
	const laneService = new LaneService({
		lane,
		models: modelRuntime,
		context,
		session: { id: session.metadata.id, cwd: agentCwd, path: session.metadata.path },
		modelsState: () => models.state,
		publish: (subscriptionId, to, event) => peer.emitTo(Lane, { subscriptionId, event }, to),
	});
	peer.provide(Lane, laneService);
	peer.provide(Models, models);
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
