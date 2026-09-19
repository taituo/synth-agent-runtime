/** Header used to carry correlation from a workflow into its activities. */
export const SYNTH_CORRELATION_HEADER = "x-synth-correlation";
/**
 * Temporal's workflow sandbox does not expose the global `structuredClone`
 * (it runs in a restricted V8 isolate, not a full Node/browser global scope).
 * A JSON round-trip is sandbox-safe and sufficient for plain JSON-serializable
 * state (strings/numbers/arrays/plain objects, never Date/Map/Set/functions).
 */
export function clone(value) {
    return JSON.parse(JSON.stringify(value));
}
const AGENT_WORKFLOW_PREFIX = "agent/";
/** `agent/agt_123` -> `agt_123`; a bare id is returned unchanged. */
export function agentIdFromWorkflowId(workflowId) {
    if (!workflowId)
        return undefined;
    return workflowId.startsWith(AGENT_WORKFLOW_PREFIX) ? workflowId.slice(AGENT_WORKFLOW_PREFIX.length) : workflowId;
}
/** Pull `agentId` off a `{ agentId, ... }` activity/workflow input, if present. */
export function agentIdFromArgs(args) {
    const first = args?.[0];
    if (first && typeof first === "object" && "agentId" in first) {
        const value = first.agentId;
        if (typeof value === "string" && value.length > 0)
            return value;
    }
    return undefined;
}
/** Drop undefined fields so log attributes stay clean. */
export function compactCorrelation(correlation) {
    const out = {};
    for (const [key, value] of Object.entries(correlation)) {
        if (value !== undefined)
            out[key] = value;
    }
    return out;
}
/** Walk an error's `cause` chain and return the innermost message. */
export function rootCauseMessage(error) {
    let current = error;
    let message = error instanceof Error ? error.message : String(error);
    const seen = new Set();
    while (current && typeof current === "object" && "cause" in current && !seen.has(current)) {
        seen.add(current);
        const cause = current.cause;
        if (!cause)
            break;
        current = cause;
        if (current instanceof Error)
            message = current.message;
    }
    return message;
}
