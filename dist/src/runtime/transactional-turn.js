import { WorkspaceTransaction } from "../workspace/transaction.js";
/**
 * Provider/agent-turn replay primitive. Each retry starts from the same synthetic
 * workspace state. Callers are responsible for declaring an attempt retryable
 * only before user-visible text/tool semantics have escaped.
 */
export async function runTransactionalTurn(options) {
    if (options.attempts.length === 0)
        throw new Error("At least one transactional attempt is required");
    let lastError;
    for (const attempt of options.attempts) {
        options.onEvent?.({ type: "attempt.start", attemptId: attempt.id });
        const transaction = await WorkspaceTransaction.begin(options.workspace);
        try {
            const result = await attempt.run();
            transaction.commit();
            options.onEvent?.({ type: "attempt.commit", attemptId: attempt.id });
            return result;
        }
        catch (error) {
            lastError = error;
            if (!attempt.retryable(error)) {
                transaction.rollback();
                options.onEvent?.({ type: "attempt.failed", attemptId: attempt.id, error: message(error) });
                throw error;
            }
            transaction.rollback();
            options.onEvent?.({ type: "attempt.rollback", attemptId: attempt.id, error: message(error) });
        }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "All transactional attempts failed"));
}
function message(error) {
    return error instanceof Error ? error.message : String(error);
}
