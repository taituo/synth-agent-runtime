/**
 * The shared swarm loop, its tools, and checkpoint resume. A scripted turn
 * stands in for the model, so the loop is verified at zero model cost.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localEffectRunner } from "../src/gym/tools.js";
import { runSwarmAttempt, type SwarmTurn } from "../src/swarm/attempt.js";
import type { SwarmCheckpoint, SwarmCheckpointStore } from "../src/swarm/checkpoint.js";
import { PLANTED_STREAM } from "../src/swarm/stream.js";

class MemoryCheckpointStore implements SwarmCheckpointStore {
  #saved = new Map<string, SwarmCheckpoint & { digest: string }>();
  async save(key: string, checkpoint: SwarmCheckpoint): Promise<string> {
    const digest = `d${this.#saved.size}`;
    this.#saved.set(key, { ...checkpoint, digest });
    return digest;
  }
  async load(key: string): Promise<(SwarmCheckpoint & { digest: string }) | undefined> {
    return this.#saved.get(key);
  }
}

/** A scripted analyst: reads one event, reports the three planted signals, finishes. */
const scriptedTurn: SwarmTurn = async (input) => {
  if (input.turnIndex === 0) {
    return {
      toolCalls: [
        { name: "list_events", arguments: {} },
        { name: "read_event", arguments: { id: "inc-2" } },
        { name: "report_finding", arguments: { kind: "incident", summary: "checkout 5xx escalation", evidence: ["inc-2"] } },
      ],
      content: "Reading the stream.",
      requestedModel: "scripted/cheap",
      servedModel: "scripted/cheap",
    };
  }
  return {
    toolCalls: [
      { name: "report_finding", arguments: { kind: "slow-burn", summary: "search latency creeping", evidence: ["burn-1", "burn-5"] } },
      { name: "report_finding", arguments: { kind: "correlation", summary: "recommendations after v2.3", evidence: ["rel-1", "corr-1"] } },
      { name: "finish", arguments: {} },
    ],
  };
};

test("the shared loop reports and scores the planted signals at zero model cost", async () => {
  const dir = await mkdtemp(join(tmpdir(), "swarm-attempt-"));
  try {
    const record = await runSwarmAttempt({ runner: localEffectRunner(dir), turn: scriptedTurn });
    assert.equal(record.score.recovered, 3);
    assert.equal(record.score.recall, 1);
    assert.equal(record.score.spurious, 0);
    assert.equal(record.finished, true);
    assert.equal(record.requestedModel, "scripted/cheap");
    assert.equal(record.servedModel, "scripted/cheap");
    assert.ok(record.turns >= 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a SIGKILL after turn 0 resumes from the checkpoint's findings, not the empty stream", async () => {
  const store = new MemoryCheckpointStore();
  const key = "session-1";
  const dir = await mkdtemp(join(tmpdir(), "swarm-resume-"));
  try {
    // First attempt: reports the incident, then dies before turn 1.
    const dies: SwarmTurn = async (input) => {
      if (input.turnIndex === 0) return (await scriptedTurn(input));
      throw new Error("SIGKILL");
    };
    await assert.rejects(runSwarmAttempt({ runner: localEffectRunner(dir), turn: dies, checkpoint: store, checkpointKey: key }), /SIGKILL/);

    // A fresh workspace (as a retried durable attempt gets), resumed from the key.
    const dir2 = await mkdtemp(join(tmpdir(), "swarm-resume2-"));
    try {
      const rest: SwarmTurn = async (input) => {
        assert.equal(input.turnIndex, 1, "must resume from the checkpointed turn");
        assert.ok(input.findings.some((finding) => finding.kind === "incident"), "the incident finding survived the kill");
        return scriptedTurn(input);
      };
      const record = await runSwarmAttempt({ runner: localEffectRunner(dir2), turn: rest, checkpoint: store, checkpointKey: key });
      assert.equal(record.score.recovered, 3, "the resumed attempt keeps the earlier finding");
    } finally {
      await rm(dir2, { recursive: true, force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a decoy reported as a finding is a false positive in the final score", async () => {
  const dir = await mkdtemp(join(tmpdir(), "swarm-decoy-"));
  try {
    const decoy: SwarmTurn = async () => ({
      toolCalls: [
        { name: "report_finding", arguments: { kind: "incident", summary: "marketing traffic spike", evidence: ["dec-1"] } },
        { name: "finish", arguments: {} },
      ],
    });
    const record = await runSwarmAttempt({ runner: localEffectRunner(dir), turn: decoy });
    assert.equal(record.score.recovered, 0);
    assert.equal(record.score.decoyReports, 1);
    assert.equal(record.score.spurious, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the stream is materialized as events.jsonl the tools read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "swarm-stream-"));
  try {
    const runner = localEffectRunner(dir);
    await runSwarmAttempt({ runner, turn: async () => ({ toolCalls: [{ name: "finish", arguments: {} }] }) });
    const text = await runner.read("events.jsonl");
    const lines = text.split("\n").filter(Boolean);
    assert.equal(lines.length, PLANTED_STREAM.events.length);
    assert.equal(JSON.parse(lines[0]!).id, "inc-1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
