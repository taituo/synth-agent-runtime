/**
 * The one workflow bundle for the production worker.
 *
 * It re-exports the runtime's durable agent workflow and the gym's durable
 * attempt, so a single worker — one task queue, N replicas — serves both. The
 * gym's turn activity is named `gymRunTurn` (not `runTurn`) so the two workflow
 * sets can share one worker without an activity-type collision; both would
 * otherwise proxy an activity literally named `runTurn` with different inputs.
 *
 * `src/workflows.ts` and `src/gym-workflows.ts` export no colliding workflow,
 * signal or query names.
 */
export * from "./workflows.js";
export * from "./gym-workflows.js";
