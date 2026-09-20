/**
 * Step 5: the plain arm's turn — one direct OpenAI-compatible request. Tested
 * with a fake fetch so no model call is spent, and so the tool-call protocol and
 * model attribution are pinned.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createGatewayGymTurn, createScriptedGymTurn, GYM_TOOL_DEFINITIONS } from "../src/index.js";
const INPUT = {
    turnIndex: 0,
    repoDir: "/tmp/does-not-matter",
    visibleTestPath: "test/visible.test.mjs",
    systemPrompt: "SYS",
    userPrompt: "USER",
    transcript: [],
    tools: GYM_TOOL_DEFINITIONS,
};
function fakeFetch(response, capture) {
    return (async (_url, init) => {
        capture?.(init ?? {});
        const status = response.status ?? 200;
        const text = typeof response.body === "string" ? response.body : JSON.stringify(response.body);
        return new Response(text, { status, headers: { "content-type": "application/json" } });
    });
}
test("the plain turn parses tool_calls and records the served model", async () => {
    let body;
    const turn = createGatewayGymTurn({
        baseUrl: "http://gateway.test",
        model: "wanted",
        fetchImpl: fakeFetch({ body: { model: "served-other", choices: [{ message: { content: JSON.stringify({ tool_calls: [{ name: "finish" }] }) } }] } }, (init) => {
            body = JSON.parse(String(init.body));
        }),
    });
    const result = await turn(INPUT);
    assert.deepEqual(result.toolCalls, [{ name: "finish", arguments: {} }]);
    assert.equal(result.requestedModel, "wanted");
    assert.equal(result.servedModel, "served-other");
    assert.equal(result.modelSubstituted, true);
    assert.equal(body?.model, "wanted");
    assert.equal(body?.messages?.length, 2, "system + user prompt");
});
test("an omitted served model is recorded as unknown, never guessed", async () => {
    const turn = createGatewayGymTurn({
        baseUrl: "http://gateway.test",
        model: "wanted",
        fetchImpl: fakeFetch({ body: { choices: [{ message: { content: JSON.stringify({ tool_calls: [{ name: "finish" }] }) } }] } }),
    });
    const result = await turn(INPUT);
    assert.equal(result.servedModel, null);
    assert.equal(result.modelSubstituted, false);
});
test("a non-JSON reply throws so the attempt records errored", async () => {
    const turn = createGatewayGymTurn({
        baseUrl: "http://gateway.test",
        model: "wanted",
        fetchImpl: fakeFetch({ body: { choices: [{ message: { content: "I cannot help with that." } }] } }),
    });
    await assert.rejects(() => turn(INPUT), /not JSON/);
});
test("an HTTP error throws so the attempt records errored", async () => {
    const turn = createGatewayGymTurn({
        baseUrl: "http://gateway.test",
        model: "wanted",
        fetchImpl: fakeFetch({ status: 429, body: "rate limited" }),
    });
    await assert.rejects(() => turn(INPUT), /HTTP 429/);
});
test("the scripted turn computes substitution and calls finish when the script is exhausted", async () => {
    const turn = createScriptedGymTurn([{ toolCalls: [{ name: "run_visible_test" }] }], { requestedModel: "a", servedModel: "b" });
    const first = await turn(INPUT);
    assert.equal(first.modelSubstituted, true);
    assert.equal(first.toolCalls[0]?.name, "run_visible_test");
    const second = await turn({ ...INPUT, turnIndex: 1 });
    assert.equal(second.toolCalls[0]?.name, "finish");
});
