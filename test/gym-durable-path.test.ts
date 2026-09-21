/**
 * The durable arm must be the Temporal workflow, and the control arm must be
 * named as the control.
 *
 * This is a call-path pin, not a live workflow run: it fails if a driver stops
 * starting `gymAttemptWorkflow` (the durable Temporal workflow registered by
 * `gym-worker.ts`) and starts calling `runGymAttempt` in-process instead, which
 * would make the "durable" arm a plain loop with no durability and void the
 * comparison. The control arm (`role: "control"`) is the same loop with no
 * runtime and is allowed to call `runGymAttempt` directly.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoFile = (relative: string): string => fileURLToPath(new URL(`../../${relative}`, import.meta.url));

const RUN_GYM = readFileSync(repoFile("integrations/gym/run-gym.ts"), "utf8");
const P2_FAULTS = readFileSync(repoFile("integrations/gym/p2-faults.ts"), "utf8");
const GYM_WORKFLOWS = readFileSync(repoFile("integrations/temporal/src/gym-workflows.ts"), "utf8");
const GYM_WORKER = readFileSync(repoFile("integrations/temporal/gym-worker.ts"), "utf8");

/** The body of a top-level function, from its signature to the next top-level declaration. */
function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `expected to find ${signature}`);
  const nextTopLevel = /\n(?:export )?(?:async )?function |\n(?:export )?const |\nmain\(\)/.exec(source.slice(start + signature.length));
  const end = nextTopLevel ? start + signature.length + nextTopLevel.index : source.length;
  return source.slice(start, end);
}

test("both drivers start the durable gymAttemptWorkflow through the Temporal client", () => {
  for (const [name, source] of [["run-gym.ts", RUN_GYM], ["p2-faults.ts", P2_FAULTS]] as const) {
    assert.match(source, /client\.workflow\.start\(\s*"gymAttemptWorkflow"/, `${name} must start the Temporal workflow`);
  }
});

test("the durable functions do not call runGymAttempt directly (that is the control arm)", () => {
  const runGymDurable = functionBody(RUN_GYM, "async function runDurableWorkflow(");
  assert.ok(!runGymDurable.includes("runGymAttempt("), "runDurableWorkflow must not run the attempt in-process");

  const p2Durable = functionBody(P2_FAULTS, "async function runDurableOnce(");
  assert.ok(!p2Durable.includes("runGymAttempt("), "runDurableOnce must not run the attempt in-process");
});

test("the control arm is labelled control, the durable arm is labelled temporal", () => {
  assert.match(RUN_GYM, /arm: "plain",\s*\n\s*role: "control"/);
  assert.match(RUN_GYM, /arm: "durable",\s*\n\s*role: "temporal"/);
  assert.match(P2_FAULTS, /arm: "plain",\s*\n\s*role: "control"/);
  assert.match(P2_FAULTS, /arm: "durable",\s*\n\s*role: "temporal"/);
});

test("gym-worker.ts registers the gym workflow and its activity", () => {
  assert.match(GYM_WORKER, /workflowsPath:/, "the worker must point at the gym workflow module");
  assert.match(GYM_WORKER, /gym-workflows/, "the worker must register gym-workflows.ts");
  assert.match(GYM_WORKER, /createGymActivities\(\)/, "the worker must register the gym activities");
  assert.match(GYM_WORKFLOWS, /export async function gymAttemptWorkflow/, "the durable workflow must exist");
  // The workflow OWNS the loop: it drives one runTurn activity per turn and
  // carries the transcript, rather than the activity running the whole loop.
  assert.match(GYM_WORKFLOWS, /for \(let turn = 0; turn < input\.maxTurns; turn\+\+\)/, "the workflow must own the turn loop");
  assert.match(GYM_WORKFLOWS, /await runTurn\(/, "the loop must drive a runTurn activity per turn");
  assert.match(GYM_WORKFLOWS, /gymPrepareActivity/, "the workflow must prepare the attempt");
  assert.match(GYM_WORKFLOWS, /gymScoreActivity/, "the workflow must score the final patch");
  const GYM_ACTIVITIES = readFileSync(repoFile("integrations/temporal/src/gym-activities.ts"), "utf8");
  assert.match(GYM_ACTIVITIES, /const runTurn = async/, "the gym must provide the one-turn runTurn activity");
  assert.match(GYM_ACTIVITIES, /executeEffect:/, "the turn must execute tools through the rung");
  // The scored-local refusal is enforced at the activity boundary, not only in
  // the drivers, so a direct workflow start cannot run a scored attempt on the
  // unisolated host runner. Behaviour is exercised by the temporal suite
  // (integrations/temporal/test/gym-activities.test.ts); this pins the wiring
  // in the root suite so a silent removal is caught here too.
  assert.match(GYM_ACTIVITIES, /GymUnisolatedScoredRun/, "the activity must refuse a scored local run");
  assert.match(GYM_ACTIVITIES, /turnScopedEffectId/, "the turn must scope effect ids per turn (no broker replay)");
});

test("there is exactly one gateway turn body, and the gym turn is a thin adapter over it", () => {
  const gymTurn = readFileSync(repoFile("src/gym/turn.ts"), "utf8");
  assert.match(gymTurn, /createGatewayAgentEngine/, "the gym turn must construct the shared engine");
  assert.ok(!/fetch\(|doFetch|AbortSignal\.timeout/.test(gymTurn), "the gym turn must not make its own HTTP call");
  const engine = readFileSync(repoFile("src/runtime/gateway-engine.ts"), "utf8");
  assert.match(engine, /\/v1\/chat\/completions/, "the shared engine owns the one chat-completions URL");
});
