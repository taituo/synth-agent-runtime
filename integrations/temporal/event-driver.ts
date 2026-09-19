/**
 * Scripted typed-event driver for the durable agent workflow.
 *
 * A runnable tool (not part of the library) that fires a fixed, ordered
 * schedule of typed signals into one running `durableAgentWorkflow`, with
 * realistic spacing between events. Running it twice asserts deterministic
 * replay: the same input must yield the same processed-signal sequence and the
 * same (volatile-field-free) final state.
 *
 * Requires a Temporal dev server (verified against
 * `temporal server start-dev --port 7243`, namespace `default`):
 *
 *   TEMPORAL_ADDRESS=127.0.0.1:7243 npx tsx event-driver.ts
 */
import { pathToFileURL } from "node:url";
import { EVENT_SCRIPT, isDeterministicReplay } from "./event-script.js";
import { runScript, startEventRunner } from "./event-runner.js";

export async function main(): Promise<void> {
  const runner = await startEventRunner();
  const stamp = Date.now();
  const runA = await runScript(runner, `agt_script_a_${stamp}`, EVENT_SCRIPT);
  const runB = await runScript(runner, `agt_script_b_${stamp}`, EVENT_SCRIPT);

  const deterministic = isDeterministicReplay(runA, runB);
  const expected = EVENT_SCRIPT.map((event) => event.kind);
  const scriptOk = JSON.stringify(runA.processed) === JSON.stringify(expected);

  console.log(
    JSON.stringify(
      { traceFile: runner.traceFile, script: EVENT_SCRIPT, runA, runB, expected, deterministic, scriptOk, ok: deterministic && scriptOk },
      null,
      2,
    ),
  );
  await runner.close();
  process.exit(deterministic && scriptOk ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
