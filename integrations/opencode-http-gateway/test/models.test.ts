import test from "node:test";
import assert from "node:assert/strict";
import { OpenCodeStackGatewayBackend } from "../adapter.js";

function fakeModels(ids: string[]) {
  return {
    getModels: () => ids.map((id) => ({ id })),
    getModel: (_provider: string, id: string) => (ids.includes(id) ? { id } : undefined),
  };
}

test("discovery lists every model the provider offers, never filtered", async () => {
  const backend = new OpenCodeStackGatewayBackend(fakeModels(["a", "b", "c"]) as never, {
    provider: "opencode-go",
    // A hardcoded discovery filter here once made 27 available models look like
    // one. Authorization belongs in the gateway's tenant policy, not here.
    modelIds: ["a"],
  });
  const models = await backend.listModels();
  assert.deepEqual(models.map((model) => model.id), ["a", "b", "c"]);
  assert.ok(models.every((model) => model.provider === "opencode-go"), "each model must carry its provider");
});

test("a configured profile is reported alongside each model", async () => {
  const backend = new OpenCodeStackGatewayBackend(fakeModels(["x"]) as never, {
    provider: "opencode-go",
    profile: "coding",
  });
  const [model] = await backend.listModels();
  assert.equal(model!.provider, "opencode-go");
  assert.equal(model!.profile, "coding");
});
