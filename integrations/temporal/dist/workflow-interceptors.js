import { log, workflowInfo, } from "@temporalio/workflow";
import { agentIdFromArgs, agentIdFromWorkflowId } from "./correlation.js";
/**
 * Workflow-isolate interceptors. This module is bundled into the workflow
 * bundle via `WorkerOptions.interceptors.workflowModules`, so it may only use
 * sandbox-safe APIs (`@temporalio/workflow` + `./correlation.js`).
 *
 * It attaches Synth correlation identifiers to every `workflow.log` line via
 * the outbound `getLogAttributes` hook, and emits lifecycle lines
 * (`synth.workflow.execute.start|end|error`, `synth.workflow.signal`) that
 * carry the same fields. The actual span/trace export happens on the worker
 * side (activity interceptors) because the workflow isolate has no I/O.
 */
function correlation() {
    const info = workflowInfo();
    const out = {
        workflowId: info.workflowId,
        workflowType: info.workflowType,
        runId: info.runId,
        taskQueue: info.taskQueue,
    };
    const agentId = agentIdFromWorkflowId(info.workflowId);
    if (agentId)
        out.agentId = agentId;
    return out;
}
function message(error) {
    return error instanceof Error ? error.message : String(error);
}
export function interceptors() {
    const inbound = {
        async execute(input, next) {
            const agentId = agentIdFromArgs(input.args) ?? agentIdFromWorkflowId(workflowInfo().workflowId);
            log.info("synth.workflow.execute.start", agentId ? { agentId } : undefined);
            try {
                const result = await next(input);
                log.info("synth.workflow.execute.end", agentId ? { agentId } : undefined);
                return result;
            }
            catch (error) {
                log.error("synth.workflow.execute.error", { ...(agentId ? { agentId } : {}), error: message(error) });
                throw error;
            }
        },
        async handleSignal(input, next) {
            log.info("synth.workflow.signal", { signalName: input.signalName });
            return next(input);
        },
    };
    const outbound = {
        getLogAttributes(input, next) {
            return { ...next(input), ...correlation() };
        },
        async scheduleActivity(input, next) {
            log.debug("synth.workflow.activity.scheduled", { activityType: input.activityType, seq: input.seq });
            return next(input);
        },
    };
    return { inbound: [inbound], outbound: [outbound] };
}
