import { Client, Connection } from "@temporalio/client";
import { cancelAgent, durableAgentWorkflow, getAgentState, sendMessage } from "./workflows.js";
import type { DurableAgentState } from "./contracts.js";

export class TemporalAgentClient {
  constructor(private readonly client: Client, private readonly taskQueue = "synth-agent-runtime") {}

  static async connect(address?: string): Promise<TemporalAgentClient> {
    const connection = await Connection.connect(address ? { address } : undefined);
    return new TemporalAgentClient(new Client({ connection }));
  }

  async start(initial: DurableAgentState) {
    return this.client.workflow.start(durableAgentWorkflow, {
      taskQueue: this.taskQueue,
      workflowId: `agent/${initial.agentId}`,
      args: [initial],
    });
  }

  handle(agentId: string) {
    const handle = this.client.workflow.getHandle< typeof durableAgentWorkflow >(`agent/${agentId}`);
    return {
      send: (message: DurableAgentState["mailbox"][number]) => handle.signal(sendMessage, message),
      cancel: () => handle.signal(cancelAgent),
      state: () => handle.query(getAgentState),
      result: () => handle.result(),
    };
  }
}
