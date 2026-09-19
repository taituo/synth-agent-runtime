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
/**
 * Prevent a resolved effect receipt from being regressed by a stale or
 * uncertain writer.
 *
 * Effects carry no fencing token (unlike commands), so the only ordering
 * guarantee available is terminal-status monotonicity: a committed receipt can
 * only be replaced by another committed receipt, and a failed receipt cannot
 * be regressed to started. Without this, a slow reconciler that returns
 * `pending` can overwrite a concurrent `committed` resolution, silently
 * discarding the effect result and leaving the broker to report
 * `EFFECT_OUTCOME_UNCERTAIN` for an effect that already succeeded.
 */
export function canReplaceEffect(existing, next) {
    if (!existing)
        return true;
    if (existing.status === "committed" && next.status !== "committed")
        return false;
    if (existing.status === "failed" && next.status === "started")
        return false;
    return true;
}
