import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyHerdrState,
  classifyTmuxPane,
  HerdrSessionProbe,
  TmuxSessionProbe,
  type CommandResult,
  type CommandRunner,
} from "../supervisor/probe.js";

test("classifyTmuxPane reads the working marker, a blocked marker, and defaults to idle", () => {
  assert.equal(classifyTmuxPane("… esc interrupt …"), "working");
  assert.equal(classifyTmuxPane("waiting for input", { blocked: "waiting for input" }), "blocked");
  assert.equal(classifyTmuxPane("all quiet"), "idle");
  // A blocked marker is only honoured when configured; otherwise the pane is idle.
  assert.equal(classifyTmuxPane("waiting for input"), "idle");
  // Custom working marker replaces the default.
  assert.equal(classifyTmuxPane("BUSY", { working: "BUSY" }), "working");
  assert.equal(classifyTmuxPane("esc interrupt", { working: "BUSY" }), "idle");
});

test("classifyHerdrState maps the real state and refuses to guess", () => {
  for (const status of ["idle", "working", "blocked", "done"] as const) {
    assert.equal(classifyHerdrState(JSON.stringify({ status })), status);
  }
  assert.equal(classifyHerdrState(JSON.stringify({ status: "thinking" })), "unknown");
  assert.equal(classifyHerdrState("not json"), "unknown");
  assert.equal(classifyHerdrState("{}"), "unknown");
});

function fakeRunner(responses: CommandResult[] | ((command: string, args: string[]) => CommandResult)): { run: CommandRunner; calls: Array<{ command: string; args: string[] }> } {
  const calls: Array<{ command: string; args: string[] }> = [];
  const run: CommandRunner = async (command, args) => {
    calls.push({ command, args });
    if (typeof responses === "function") return responses(command, args);
    return responses.shift() ?? { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

test("TmuxSessionProbe: dead pane is done, a working marker is working, an error is unknown", async () => {
  const dead = fakeRunner([{ code: 0, stdout: "1", stderr: "" }]);
  assert.equal((await new TmuxSessionProbe(dead.run).probe("s:0.0")).status, "done");

  const working = fakeRunner([
    { code: 0, stdout: "0", stderr: "" },
    { code: 0, stdout: "doing things\nesc interrupt to stop", stderr: "" },
  ]);
  const result = await new TmuxSessionProbe(working.run).probe("s:0.0");
  assert.equal(result.status, "working");
  assert.equal(result.probe, "tmux", "a tmux guess must be labelled as such");
  assert.match(result.evidence, /esc interrupt/);

  const missing = fakeRunner([{ code: 1, stdout: "", stderr: "no such pane" }]);
  assert.equal((await new TmuxSessionProbe(missing.run).probe("s:0.0")).status, "unknown");
});

test("TmuxSessionProbe.poke only reports delivered when the text is seen in the pane", async () => {
  // The pane echoes whatever was sent: delivered on the first attempt.
  const echoing = fakeRunner((command, args) => {
    if (args[0] === "capture-pane") return { code: 0, stdout: "prompt\nplease continue", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  const delivered = await new TmuxSessionProbe(echoing.run).poke("s:0.0", "please continue");
  assert.equal(delivered.delivered, true);
  assert.equal(delivered.attempts, 1);
  // send-keys -l then a separate Enter, in that order.
  const sends = echoing.calls.filter((call) => call.args[0] === "send-keys");
  assert.equal(sends.length, 2);
  assert.deepEqual(sends[0]!.args, ["send-keys", "-t", "s:0.0", "-l", "please continue"]);
  assert.deepEqual(sends[1]!.args, ["send-keys", "-t", "s:0.0", "Enter"]);

  // A pane that never shows the text: not delivered, after retries.
  const silent = fakeRunner(() => ({ code: 0, stdout: "prompt", stderr: "" }));
  const notDelivered = await new TmuxSessionProbe(silent.run).poke("s:0.0", "please continue");
  assert.equal(notDelivered.delivered, false);
  assert.equal(notDelivered.attempts, 3, "it must retry, not assume");
});

test("HerdrSessionProbe uses the real state document and reports herdr", async () => {
  const runner = fakeRunner([{ code: 0, stdout: JSON.stringify({ status: "blocked" }), stderr: "" }]);
  const probe = new HerdrSessionProbe(runner.run, { bin: "herdr", stateArgs: ["state", "--json"] });
  const result = await probe.probe("pane-1");
  assert.equal(result.status, "blocked");
  assert.equal(result.probe, "herdr");
  assert.deepEqual(runner.calls[0], { command: "herdr", args: ["state", "--json", "pane-1"] });

  const send = fakeRunner([{ code: 0, stdout: "", stderr: "" }]);
  assert.equal((await new HerdrSessionProbe(send.run).poke("pane-1", "hi")).delivered, true);
});
