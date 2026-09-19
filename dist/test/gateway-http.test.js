import test from "node:test";
import assert from "node:assert/strict";
import { createInferenceGateway } from "../src/inference/gateway/server.js";
import { ResponsesStreamEncoder } from "../src/inference/gateway/responses-protocol.js";
import { ProfileRouterBackend } from "../src/inference/gateway/profile-router-backend.js";
import { HttpGatewayBackend } from "../src/inference/gateway/http-upstream.js";
test("HTTP gateway exposes dynamic port, models, and Responses transport", async () => {
    const backend = {
        async listModels() { return [{ id: "worker/cheap" }]; },
        async handle(request, model) {
            assert.equal(new URL(request.url).pathname, "/v1/responses");
            assert.equal(model, "worker/cheap");
            assert.equal(request.headers.get("x-synth-session"), "session-1");
            const wire = new ResponsesStreamEncoder(model, { responseId: "resp_http", createdAt: 1 });
            return new Response([
                wire.created(),
                ...wire.textStart(0),
                wire.textDelta(0, "hello"),
                ...wire.textDone(0, "hello"),
                wire.completed({ blocks: [{ type: "text", text: "hello" }] }),
            ].flat().join(""), { headers: { "content-type": "text/event-stream" } });
        },
    };
    const gateway = createInferenceGateway({ backend, port: 0 });
    await gateway.listen();
    try {
        assert.doesNotMatch(gateway.url, /:0$/);
        const models = await fetch(`${gateway.url}/v1/models`).then((response) => response.json());
        assert.equal(models.data[0].id, "worker/cheap");
        const response = await fetch(`${gateway.url}/v1/responses`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-synth-session": "session-1" },
            body: JSON.stringify({ model: "worker/cheap", input: "hi", stream: true }),
        });
        assert.equal(response.status, 200);
        const text = await response.text();
        assert.match(text, /event: response\.created/);
        assert.match(text, /event: response\.output_text\.delta/);
        assert.match(text, /event: response\.completed/);
    }
    finally {
        await gateway.close();
    }
});
test("HTTP gateway rejects oversized JSON bodies before backend dispatch", async () => {
    let calls = 0;
    const backend = {
        async listModels() { return [{ id: "m" }]; },
        async handle() { calls++; return new Response("ok"); },
    };
    const gateway = createInferenceGateway({ backend, port: 0, maxRequestBytes: 64 });
    await gateway.listen();
    try {
        const response = await fetch(`${gateway.url}/v1/responses`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "m", input: "x".repeat(256) }),
        });
        assert.equal(response.status, 413);
        assert.equal(calls, 0);
    }
    finally {
        await gateway.close();
    }
});
test("profile router preserves AbortSignal through failover layer", async () => {
    let observedSignal;
    const blocking = {
        async listModels() { return [{ id: "upstream" }]; },
        async handle(request) {
            observedSignal = request.signal;
            await new Promise((resolve, reject) => {
                if (request.signal.aborted) {
                    reject(request.signal.reason);
                    return;
                }
                request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
            });
            return new Response("unreachable");
        },
    };
    const router = new ProfileRouterBackend({
        backends: { b: blocking },
        profiles: [{ model: { id: "virtual" }, routes: [{ id: "r", backend: "b", model: "upstream" }] }],
    });
    const abort = new AbortController();
    const pending = router.handle(new Request("http://local/v1/responses", {
        method: "POST",
        body: JSON.stringify({ model: "virtual", input: "hi" }),
        signal: abort.signal,
    }), "virtual");
    await new Promise((resolve) => setTimeout(resolve, 0));
    abort.abort(new Error("test abort"));
    await assert.rejects(pending, /test abort/);
    assert.equal(observedSignal?.aborted, true);
});
test("HTTP upstream backend forwards AbortSignal to fetch", async () => {
    let seen;
    const backend = new HttpGatewayBackend({
        baseUrl: "https://example.invalid",
        models: [{ id: "m" }],
        fetch: (async (_input, init) => {
            seen = init?.signal;
            return new Response("ok");
        }),
    });
    const abort = new AbortController();
    const request = new Request("http://local/v1/responses", {
        method: "POST",
        body: JSON.stringify({ model: "m" }),
        signal: abort.signal,
    });
    await backend.handle(request);
    assert.equal(seen?.aborted, false);
    abort.abort(new Error("stop"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(seen?.aborted, true);
});
test("profile router uses Responses metadata.session_id for sticky routing", async () => {
    const calls = [];
    const backend = (id, firstStatus = 200) => ({
        async listModels() { return [{ id }]; },
        async handle() {
            calls.push(id);
            const status = calls.filter((value) => value === id).length === 1 ? firstStatus : 200;
            return new Response(JSON.stringify({ id }), { status, headers: { "content-type": "application/json" } });
        },
    });
    const router = new ProfileRouterBackend({
        backends: { a: backend("a", 429), b: backend("b") },
        profiles: [{ model: { id: "virtual" }, routes: [
                    { id: "route-a", backend: "a", model: "upstream-a", cooldownMs: 1 },
                    { id: "route-b", backend: "b", model: "upstream-b" },
                ] }],
    });
    const make = () => new Request("http://local/v1/responses", {
        method: "POST",
        body: JSON.stringify({ model: "virtual", input: "hi", metadata: { session_id: "s-1" } }),
    });
    assert.equal((await router.handle(make(), "virtual")).status, 200);
    assert.deepEqual(calls, ["a", "b"]);
    calls.length = 0;
    assert.equal((await router.handle(make(), "virtual")).status, 200);
    assert.deepEqual(calls, ["b"]);
});
test("profile router scopes route health by virtual model", async () => {
    let failingCalls = 0;
    const backend = (status) => ({
        async listModels() { return []; },
        async handle() { if (status === 429)
            failingCalls++; return new Response("{}", { status }); },
    });
    const router = new ProfileRouterBackend({
        backends: { bad: backend(429), fallback: backend(200), healthy: backend(200) },
        profiles: [
            { model: { id: "model-a" }, routes: [
                    { id: "primary", backend: "bad" },
                    { id: "fallback", backend: "fallback" },
                ] },
            { model: { id: "model-b" }, routes: [
                    { id: "primary", backend: "healthy" },
                ] },
        ],
    });
    const req = (model) => new Request("http://router/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, input: "x" }),
    });
    assert.equal((await router.handle(req("model-a"), "model-a")).status, 200);
    assert.equal((await router.handle(req("model-b"), "model-b")).status, 200);
    assert.equal(failingCalls, 1);
});
test("HTTP upstream strips hop-by-hop request headers", async () => {
    let seen = new Headers();
    const backend = new HttpGatewayBackend({
        baseUrl: "https://upstream.example/v1/",
        models: [],
        fetch: async (_input, init) => {
            seen = new Headers(init?.headers);
            return new Response("{}", { status: 200 });
        },
    });
    await backend.handle(new Request("http://gateway/v1/responses", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "connection": "keep-alive",
            "transfer-encoding": "chunked",
            "x-keep-me": "yes",
        },
        body: JSON.stringify({ model: "x", input: "hi" }),
    }));
    assert.equal(seen.get("connection"), null);
    assert.equal(seen.get("transfer-encoding"), null);
    assert.equal(seen.get("content-length"), null);
    assert.equal(seen.get("x-keep-me"), "yes");
});
