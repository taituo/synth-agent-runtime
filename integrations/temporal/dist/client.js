import { Client, Connection } from "@temporalio/client";
import { cancelAgent, durableAgentWorkflow, getAgentState, sendMessage } from "./workflows.js";
export class TemporalAgentClient {
    client;
    taskQueue;
    constructor(client, taskQueue = "synth-agent-runtime") {
        this.client = client;
        this.taskQueue = taskQueue;
    }
    static async connect(address) {
        const connection = await Connection.connect(address ? { address } : undefined);
        return new TemporalAgentClient(new Client({ connection }));
    }
    async start(initial) {
        return this.client.workflow.start(durableAgentWorkflow, {
            taskQueue: this.taskQueue,
            workflowId: `agent/${initial.agentId}`,
            args: [initial],
        });
    }
    handle(agentId) {
        const handle = this.client.workflow.getHandle(`agent/${agentId}`);
        return {
            send: (message) => handle.signal(sendMessage, message),
            cancel: () => handle.signal(cancelAgent),
            state: () => handle.query(getAgentState),
            result: () => handle.result(),
        };
    }
}
