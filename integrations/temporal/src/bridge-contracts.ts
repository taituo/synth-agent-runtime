export type HarnessInferenceApi = "chat.completions" | "responses";

export interface HarnessInferenceRequest {
  agentId: string;
  sessionId: string;
  callId: string;
  api: HarnessInferenceApi;
  body: unknown;
}

export interface HarnessInferenceResult {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
}

export interface HarnessToolRequest {
  agentId: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  arguments: unknown;
  /** Routable callback owned by the harness process that admitted this call. */
  callbackUrl: string;
  /** Harness-specific context echoed to the callback; never interpreted by Temporal. */
  metadata?: Record<string, unknown>;
}

export interface HarnessToolResult {
  result: unknown;
}

export interface HarnessBridgeActivities {
  forwardInference(input: HarnessInferenceRequest): Promise<HarnessInferenceResult>;
  forwardToolExecution(input: HarnessToolRequest): Promise<HarnessToolResult>;
}
