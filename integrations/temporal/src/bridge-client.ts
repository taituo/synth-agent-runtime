import { createHash } from "node:crypto";
import { Client, Connection } from "@temporalio/client";
import type {
  HarnessInferenceRequest,
  HarnessInferenceResult,
  HarnessToolRequest,
  HarnessToolResult,
} from "./bridge-contracts.js";
import { harnessInferenceWorkflow, harnessToolWorkflow } from "./bridge-workflows.js";

export function bridgeWorkflowId(
  kind: "infer" | "tool",
  input: { agentId: string; sessionId: string; callId: string },
): string {
  const digest = createHash("sha256")
    .update(input.agentId)
    .update("\0")
    .update(input.sessionId)
    .update("\0")
    .update(input.callId)
    .digest("hex");
  return `harness/${kind}/${digest}`;
}

export class TemporalHarnessBridgeClient {
  constructor(
    private readonly client: Client,
    private readonly taskQueue = "synth-agent-runtime",
  ) {}

  static async connect(address?: string): Promise<TemporalHarnessBridgeClient> {
    const connection = await Connection.connect(address ? { address } : undefined);
    return new TemporalHarnessBridgeClient(new Client({ connection }));
  }

  async infer(input: HarnessInferenceRequest): Promise<HarnessInferenceResult> {
    const workflowId = bridgeWorkflowId("infer", {
      agentId: input.agentId,
      sessionId: input.sessionId,
      callId: input.callId,
    });
    try {
      const handle = await this.client.workflow.start(harnessInferenceWorkflow, {
        taskQueue: this.taskQueue,
        workflowId,
        args: [input],
      });
      return await handle.result();
    } catch (startError) {
      try {
        return await this.client.workflow
          .getHandle<typeof harnessInferenceWorkflow>(workflowId)
          .result();
      } catch {
        throw startError;
      }
    }
  }

  async executeTool(input: HarnessToolRequest): Promise<HarnessToolResult> {
    const workflowId = bridgeWorkflowId("tool", {
      agentId: input.agentId,
      sessionId: input.sessionId,
      callId: input.toolCallId,
    });
    try {
      const handle = await this.client.workflow.start(harnessToolWorkflow, {
        taskQueue: this.taskQueue,
        workflowId,
        args: [input],
      });
      return await handle.result();
    } catch (startError) {
      try {
        return await this.client.workflow
          .getHandle<typeof harnessToolWorkflow>(workflowId)
          .result();
      } catch {
        throw startError;
      }
    }
  }
}
