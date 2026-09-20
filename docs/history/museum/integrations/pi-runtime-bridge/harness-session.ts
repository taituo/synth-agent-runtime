/**
 * Optional adapter for the current Pi AgentHarness API. This file is intended
 * to live in/next to the Pi monorepo, so it is not part of the root package's
 * TypeScript build.
 */
import {
  AgentHarness,
  BACKGROUND_CONTEXT,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type Context,
  type ExecutionEnv,
  type Session,
} from "@earendil-works/pi-agent-core";
import type { Model, Models, ThinkingLevel } from "@earendil-works/pi-ai";

export interface HarnessSessionOptions {
  session: Session<any>;
  models: Models;
  model: Model<any>;
  thinkingLevel?: ThinkingLevel;
  env: ExecutionEnv;
  cwd: string;
  systemPrompt: string;
  context?: Context;
}

/**
 * Creates the tiny shape expected by runtime-core's PiAgentEngine while keeping
 * session persistence and agent-visible execution environments separate.
 */
export async function createHarnessSession(options: HarnessSessionOptions) {
  const context = options.context ?? BACKGROUND_CONTEXT;
  const { harness } = await AgentHarness.create({
    session: options.session,
    models: options.models,
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    tools: [createReadTool(), createWriteTool(), createEditTool(), createBashTool()],
    toolContext: { env: options.env },
    systemPrompt: options.systemPrompt,
  }, context);
  const lane = await harness.lane("main", context);

  return {
    async prompt(text: string, promptOptions?: { streamingBehavior?: "steer" | "followUp" }) {
      const result = promptOptions?.streamingBehavior === "steer"
        ? await lane.steer(text, undefined, context)
        : promptOptions?.streamingBehavior === "followUp"
          ? await lane.followUp(text, undefined, context)
          : await lane.prompt(text, undefined, context);
      if (!result.ok) throw result.error;
    },

    subscribe(listener: (event: unknown) => void) {
      let closed = false;
      let unsubscribe = () => {};
      void lane.watch(context).then((watch) => {
        if (closed) {
          watch.unsubscribe();
          return;
        }
        unsubscribe = watch.unsubscribe;
        watch.start(listener as any);
      });
      return () => {
        closed = true;
        unsubscribe();
      };
    },

    async close() {
      await harness.close(context);
    },
  };
}
