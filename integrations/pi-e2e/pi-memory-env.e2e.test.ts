import { afterEach, describe, expect, it } from "vitest";
import {
  AgentHarness,
  BACKGROUND_CONTEXT,
  MemorySessionRepo,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-agent-core";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { MemoryExecutionEnv, StaticTreeSource } from "../src/harness/env/memory.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

describe("synth runtime Pi MemoryExecutionEnv contract", () => {
  it("runs normal Pi tools against a RAM-only seeded workspace", async () => {
    const source = new StaticTreeSource({
      name: "seed",
      revision: { kind: "git", commit: "deadbeef", ref: "main" },
      files: [{ path: "hello.txt", content: "base\n" }],
    });
    const env = new MemoryExecutionEnv({ source });
    cleanups.push(() => env.cleanup(BACKGROUND_CONTEXT));

    const repo = new MemorySessionRepo();
    cleanups.push(() => repo.close(BACKGROUND_CONTEXT));
    const session = await repo.create({}, BACKGROUND_CONTEXT);

    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("write", { path: "hello.txt", content: "changed in ram\n" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall("bash", { command: "cat hello.txt" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);

    const { harness } = await AgentHarness.create({
      session,
      models,
      model: faux.getModel(),
      tools: [createReadTool(), createWriteTool(), createEditTool(), createBashTool()],
      toolContext: { env },
      systemPrompt: "Use the standard Pi tools. The workspace is synthetic and RAM-only.",
    }, BACKGROUND_CONTEXT);
    cleanups.push(() => harness.close(BACKGROUND_CONTEXT));

    const lane = await harness.lane("main", BACKGROUND_CONTEXT);
    const result = await lane.prompt("Change hello.txt, inspect it with bash, then finish.", undefined, BACKGROUND_CONTEXT);
    expect(result).toMatchObject({ ok: true, value: { kind: "run", status: "completed" } });

    const current = await env.readTextFile("hello.txt", BACKGROUND_CONTEXT);
    expect(current).toMatchObject({ ok: true, value: "changed in ram\n" });
    const artifact = await env.exportArtifact();
    expect(artifact.revision?.commit).toBe("deadbeef");
    expect(artifact.changes).toHaveLength(1);
    expect(artifact.changes[0]).toMatchObject({ path: "hello.txt", kind: "modify" });
    expect(faux.state.callCount).toBe(3);
  });
});
