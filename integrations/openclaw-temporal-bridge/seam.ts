import {
  OpenClawTemporalToolBridge,
  type BridgeableAgentTool,
  type TemporalToolBridgeOptions,
} from "./tool-bridge.js";

export interface OpenClawHookIdentityLike {
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
}

export function openClawTemporalIdentity(context: OpenClawHookIdentityLike): {
  agentId: string;
  sessionId: string;
} {
  const agentId = context.agentId?.trim();
  const sessionId = context.sessionId?.trim() || context.sessionKey?.trim();
  if (!agentId || !sessionId) {
    throw new Error("OpenClaw Temporal bridge requires agentId and sessionId/sessionKey");
  }
  return { agentId, sessionId };
}

/**
 * Call this after OpenClaw has applied tool policy/approval and abort wrappers.
 * The bridge then sees only already-authorized concrete tool executions.
 */
export function wrapFinalizedOpenClawTools<T extends BridgeableAgentTool>(
  bridge: OpenClawTemporalToolBridge,
  tools: T[],
  context: OpenClawHookIdentityLike,
): T[] {
  return bridge.wrapAll(tools, openClawTemporalIdentity(context));
}

export function createOpenClawTemporalBridgeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): OpenClawTemporalToolBridge | undefined {
  const bridgeUrl = env.SYNTH_TEMPORAL_BRIDGE_URL?.trim();
  if (!bridgeUrl) return undefined;
  const options: TemporalToolBridgeOptions = {
    bridgeUrl,
    bearerToken: env.SYNTH_TEMPORAL_BRIDGE_TOKEN?.trim() || undefined,
    callbackHost: env.SYNTH_OPENCLAW_CALLBACK_HOST?.trim() || "127.0.0.1",
    callbackPort: Number.parseInt(env.SYNTH_OPENCLAW_CALLBACK_PORT ?? "8792", 10),
    callbackUrl: env.SYNTH_OPENCLAW_CALLBACK_URL?.trim() || undefined,
    callbackBearerToken: env.SYNTH_TOOL_CALLBACK_TOKEN?.trim() || undefined,
  };
  return new OpenClawTemporalToolBridge(options);
}
