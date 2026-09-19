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
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

describe("synth runtime Pi harness contract", () => {
  it("runs a real Pi tool turn through the ExecutionEnv seam", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "synth-pi-e2e-"));
    cleanups.push(() => rm(cwd, { recursive: true, force: true }));

    const sessionRepo = new MemorySessionRepo();
    cleanups.push(() => sessionRepo.close(BACKGROUND_CONTEXT));
    const session = await sessionRepo.create({}, BACKGROUND_CONTEXT);
    const env = new NodeExecutionEnv({ cwd });
    cleanups.push(() => env.cleanup(BACKGROUND_CONTEXT));

    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("write", { path: "hello.txt", content: "hello from pi" }),
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
      systemPrompt: "Use the normal Pi tools. Write hello.txt and finish.",
    }, BACKGROUND_CONTEXT);
    cleanups.push(() => harness.close(BACKGROUND_CONTEXT));

    const lane = await harness.lane("main", BACKGROUND_CONTEXT);
    const result = await lane.prompt("Do the task", undefined, BACKGROUND_CONTEXT);
    expect(result).toMatchObject({ ok: true, value: { kind: "run", status: "completed" } });
    expect(await readFile(join(cwd, "hello.txt"), "utf8")).toBe("hello from pi");
    expect(faux.state.callCount).toBe(2);
  });
});
