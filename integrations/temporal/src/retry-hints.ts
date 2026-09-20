/**
 * Re-export of the runtime's canonical retry-hint parser.
 *
 * This integration used to keep a third copy. The spec asked for reuse rather
 * than a third design, so the single implementation lives in
 * `src/inference/gateway/retry-hint.ts` and is imported here. Its existing
 * tests (`test/retry-hints.test.ts`) pin the behaviour unchanged.
 */
export { parseRetryHintMs } from "../../../src/inference/gateway/retry-hint.js";
