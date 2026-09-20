import test from "node:test";
import assert from "node:assert/strict";
import { litellmProfile } from "../src/index.js";
test("a LiteLLM profile routes its virtual id to the upstream model via http-upstream", async () => {
    const { backendName, backend, profile } = litellmProfile({
        id: "litellm/cheap",
        baseUrl: "http://127.0.0.1:4000",
        model: "gpt-4o-mini",
    });
    assert.equal(profile.model.id, "litellm/cheap");
    assert.equal(profile.model.provider, "litellm");
    assert.equal(profile.model.profile, "litellm/cheap");
    assert.equal(profile.routes.length, 1);
    assert.equal(profile.routes[0].backend, backendName);
    assert.equal(profile.routes[0].model, "gpt-4o-mini", "the route rewrites to the LiteLLM model id");
    const models = await backend.listModels();
    assert.equal(models[0].id, "gpt-4o-mini");
    assert.equal(models[0].provider, "litellm");
});
test("two LiteLLM profiles with different ids get distinct backend names", () => {
    const primary = litellmProfile({ id: "litellm/cheap-primary", baseUrl: "http://a", model: "m" });
    const fallback = litellmProfile({ id: "litellm/cheap-fallback", baseUrl: "http://b", model: "m" });
    assert.notEqual(primary.backendName, fallback.backendName);
});
