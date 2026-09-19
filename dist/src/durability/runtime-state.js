/** Prevent stale lease generations or non-terminal writes from regressing committed commands. */
export function canReplaceCommand(existing, next) {
    if (!existing)
        return true;
    const oldFence = existing.fencingToken ?? 0;
    const newFence = next.fencingToken ?? 0;
    if (newFence < oldFence)
        return false;
    if (existing.status === "committed" && next.status !== "committed")
        return false;
    return true;
}
