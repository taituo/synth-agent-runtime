import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createGatewayAgentEngine } from "../src/runtime/gateway-engine.js";
import { buildProviderRouter, directProviderSettings, parseGatewayConfig, providersFromEnv, selectProvider, } from "../src/index.js";
import { createInferenceGateway } from "../src/inference/gateway/server.js";
/** A local OpenAI-compatible endpoint that names the provider that served it. */
async function fakeProvider(id, options = {}) {
    let calls = 0;
    const server = createServer((req, res) => {
        if (req.method === "POST" && (req.url ?? "").startsWith("/v1/chat/completions")) {
            calls++;
            let body = "";
            req.on("data", (chunk) => { body += String(chunk); });
            req.on("end", () => {
                if (options.status && options.status !== 200) {
                    res.statusCode = options.status;
                    res.end(JSON.stringify({ error: { message: "unavailable" } }));
                    return;
                }
                const parsed = JSON.parse(body);
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ model: id, echoedModel: parsed.model, choices: [{ message: { role: "assistant", content: "ok" } }] }));
            });
            return;
        }
        res.statusCode = 404;
        res.end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    return {
        url: `http://127.0.0.1:${port}`,
        calls: () => calls,
        close: () => new Promise((resolve) => server.close(() => resolve())),
    };
}
function postCompletion(baseUrl, model) {
    return fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
    });
}
test("config drives provider construction and routing selects the configured provider", async () => {
    const alpha = await fakeProvider("alpha");
    const beta = await fakeProvider("beta");
    try {
        const config = parseGatewayConfig({ providers: [
                { id: "alpha", baseUrl: alpha.url, model: "alpha-upstream" },
                { id: "beta", baseUrl: beta.url, model: "beta-upstream" },
            ] });
        const gateway = createInferenceGateway({ backend: buildProviderRouter(config), port: 0 });
        await gateway.listen();
        try {
            const a = await (await postCompletion(gateway.url, "alpha")).json();
            assert.equal(a.model, "alpha", "the alpha profile is served by the alpha provider");
            assert.equal(a.echoedModel, "alpha-upstream", "the route rewrites to the provider's upstream model");
            const b = await (await postCompletion(gateway.url, "beta")).json();
            assert.equal(b.model, "beta");
            assert.equal(b.echoedModel, "beta-upstream");
            assert.equal(alpha.calls(), 1);
            assert.equal(beta.calls(), 1);
            assert.equal(selectProvider(config, "alpha")?.baseUrl, alpha.url);
        }
        finally {
            await gateway.close();
        }
    }
    finally {
        await alpha.close();
        await beta.close();
    }
});
test("opencode-go is one profile among many, selected by config", async () => {
    const opencodeGo = await fakeProvider("opencode-go");
    const other = await fakeProvider("other");
    try {
        const config = parseGatewayConfig({ providers: [
                { id: "opencode-go", baseUrl: opencodeGo.url, model: "go-model" },
                { id: "other", baseUrl: other.url, model: "other-model" },
            ] });
        const router = buildProviderRouter(config);
        assert.deepEqual((await router.listModels()).map((m) => m.id).sort(), ["opencode-go", "other"]);
        const gateway = createInferenceGateway({ backend: router, port: 0 });
        await gateway.listen();
        try {
            assert.equal((await (await postCompletion(gateway.url, "opencode-go")).json()).model, "opencode-go");
            assert.equal((await (await postCompletion(gateway.url, "other")).json()).model, "other");
        }
        finally {
            await gateway.close();
        }
    }
    finally {
        await opencodeGo.close();
        await other.close();
    }
});
test("providers sharing a profile fail over in config order", async () => {
    const down = await fakeProvider("down", { status: 503 });
    const up = await fakeProvider("up");
    try {
        const config = parseGatewayConfig({ providers: [
                { id: "primary", baseUrl: down.url, model: "m", profile: "cheap" },
                { id: "fallback", baseUrl: up.url, model: "m", profile: "cheap" },
            ] });
        const gateway = createInferenceGateway({ backend: buildProviderRouter(config), port: 0 });
        await gateway.listen();
        try {
            const served = await (await postCompletion(gateway.url, "cheap")).json();
            assert.equal(served.model, "up", "the healthy configured route served the profile");
            assert.equal(down.calls(), 1);
            assert.equal(up.calls(), 1);
        }
        finally {
            await gateway.close();
        }
    }
    finally {
        await down.close();
        await up.close();
    }
});
test("a provider is swapped in by config alone", async () => {
    const alpha = await fakeProvider("alpha");
    const gamma = await fakeProvider("gamma");
    try {
        // Same id/profile, different baseUrl: only the config changed.
        const config = parseGatewayConfig({ providers: [{ id: "alpha", baseUrl: gamma.url, model: "alpha-upstream" }] });
        const gateway = createInferenceGateway({ backend: buildProviderRouter(config), port: 0 });
        await gateway.listen();
        try {
            const served = await (await postCompletion(gateway.url, "alpha")).json();
            assert.equal(served.model, "gamma", "the swapped-in provider served the same profile");
            assert.equal(gamma.calls(), 1);
            assert.equal(alpha.calls(), 0, "the original provider was not called");
        }
        finally {
            await gateway.close();
        }
    }
    finally {
        await alpha.close();
        await gamma.close();
    }
});
test("a synthetic run reaches a declared provider directly (no gateway, no opencode)", async () => {
    const delta = await fakeProvider("delta");
    try {
        const provider = { id: "delta", baseUrl: delta.url, model: "delta-upstream" };
        const engine = createGatewayAgentEngine({
            ...directProviderSettings(provider),
            systemPrompt: "You are a cheap synthetic run.",
            buildUserMessage: () => "hi",
        });
        const context = {
            agentId: "agt_provider",
            workspaceId: "ws_provider",
            definition: { id: "delta", inferenceProfile: { id: "delta" } },
            inferenceProfile: { id: "delta" },
            signal: new AbortController().signal,
            emitOutput: () => { },
            emitTool: () => { },
        };
        const outcome = await engine.run([{ id: "m1", role: "human", text: "hi", createdAt: 1 }], context);
        assert.equal(outcome.requestedModel, "delta-upstream");
        assert.equal(outcome.servedModel, "delta", "the provider answered directly");
        assert.equal(delta.calls(), 1);
    }
    finally {
        await delta.close();
    }
});
test("providers come from the environment with no hardcoded provider or key", () => {
    assert.deepEqual(providersFromEnv({ SYNTH_GATEWAY_PROVIDERS: JSON.stringify([{ id: "x", baseUrl: "http://x", model: "m" }]) }).map((p) => p.id), ["x"]);
    assert.deepEqual(providersFromEnv({ SYNTH_PROVIDER_ALPHA_BASEURL: "http://a", SYNTH_PROVIDER_ALPHA_MODEL: "am", SYNTH_PROVIDER_ALPHA_API_KEY: "k" }), [{ id: "alpha", baseUrl: "http://a", model: "am", apiKey: "k" }]);
    assert.throws(() => parseGatewayConfig({ providers: [] }), /non-empty/);
    assert.throws(() => parseGatewayConfig({ providers: [{ id: "a", baseUrl: "", model: "m" }] }), /baseUrl/);
    assert.throws(() => parseGatewayConfig({ providers: [{ id: "a", baseUrl: "http://a", model: "m" }, { id: "a", baseUrl: "http://b", model: "n" }] }), /duplicate/);
});
