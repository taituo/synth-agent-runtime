export function agentFenceError(snapshot, fence) {
    return new Error(`AGENT_FENCE_REJECTED:${snapshot.id}:${fence.resourceId}:${fence.fencingToken}`);
}
export function isAgentFenceRejected(error) {
    return error instanceof Error && error.message.startsWith("AGENT_FENCE_REJECTED:");
}
/** Persist one snapshot while preserving the hard-fencing contract. */
export async function persistAgentSnapshot(durability, snapshot, fence) {
    if (!fence) {
        await durability.putAgent(snapshot);
        return;
    }
    if (!durability.putAgentFenced) {
        throw new Error(`FENCED_AGENT_WRITE_UNSUPPORTED:${snapshot.id}`);
    }
    if (!(await durability.putAgentFenced(snapshot, fence))) {
        throw agentFenceError(snapshot, fence);
    }
}
