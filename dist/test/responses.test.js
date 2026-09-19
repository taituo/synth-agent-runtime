import test from "node:test";
import assert from "node:assert/strict";
import { ResponsesStreamEncoder, parseResponsesInputText, toResponsesObject } from "../src/inference/gateway/responses-protocol.js";
test("Responses object preserves text, function calls and usage", () => {
    const response = toResponsesObject({
        id: "resp_test",
        model: "worker/cheap",
        createdAt: 123,
        blocks: [
            { type: "text", text: "hello" },
            { type: "function_call", id: "call_1", name: "read", arguments: '{"path":"a.ts"}' },
        ],
        usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
    });
    assert.equal(response.id, "resp_test");
    assert.equal(response.status, "completed");
    assert.equal(response.output[0].content[0].text, "hello");
    assert.equal(response.output[1].call_id, "call_1");
    assert.deepEqual(response.usage, { input_tokens: 10, output_tokens: 4, total_tokens: 14 });
});
test("Responses stream emits canonical text and function-call event families", () => {
    const stream = new ResponsesStreamEncoder("worker/cheap", { responseId: "resp_stream", createdAt: 1 });
    const frames = [
        stream.created(),
        ...stream.textStart(0),
        stream.textDelta(0, "hel"),
        ...stream.textDone(0, "hello"),
        stream.functionStart(1, "call_1", "read"),
        stream.functionDelta(1, "call_1", '{"path"'),
        ...stream.functionDone(1, "call_1", "read", '{"path":"a.ts"}'),
        stream.completed({
            blocks: [
                { type: "text", text: "hello" },
                { type: "function_call", id: "call_1", name: "read", arguments: '{"path":"a.ts"}' },
            ],
            usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
        }),
    ].join("");
    for (const type of [
        "response.created",
        "response.output_item.added",
        "response.content_part.added",
        "response.output_text.delta",
        "response.output_text.done",
        "response.function_call_arguments.delta",
        "response.function_call_arguments.done",
        "response.output_item.done",
        "response.completed",
    ])
        assert.match(frames, new RegExp(`event: ${type.replaceAll(".", "\\.")}`));
    assert.match(frames, /"sequence_number":0/);
    assert.match(frames, /"sequence_number":11/);
});
test("Responses input text accepts strings and content arrays", () => {
    assert.equal(parseResponsesInputText("hello"), "hello");
    assert.equal(parseResponsesInputText([{ type: "input_text", text: "a" }, { type: "output_text", text: "b" }]), "ab");
});
test("Responses object and stream preserve reasoning summaries", () => {
    const response = toResponsesObject({
        id: "resp_reasoning",
        model: "worker/strong",
        createdAt: 123,
        blocks: [
            { type: "reasoning", summary: "Checked the constraints." },
            { type: "text", text: "answer" },
        ],
        usage: {
            input_tokens: 10,
            output_tokens: 6,
            total_tokens: 16,
            output_tokens_details: { reasoning_tokens: 2 },
        },
    });
    assert.equal(response.output[0].type, "reasoning");
    assert.equal(response.output[0].summary[0].text, "Checked the constraints.");
    assert.equal(response.usage?.output_tokens_details?.reasoning_tokens, 2);
    const stream = new ResponsesStreamEncoder("worker/strong", { responseId: "resp_reasoning_stream", createdAt: 1 });
    const frames = [
        ...stream.reasoningStart(0),
        stream.reasoningDelta(0, "Checked "),
        stream.reasoningDelta(0, "constraints."),
        ...stream.reasoningDone(0, "Checked constraints."),
    ].join("");
    assert.match(frames, /event: response\.reasoning_summary_part\.added/);
    assert.match(frames, /event: response\.reasoning_summary_text\.delta/);
    assert.match(frames, /event: response\.reasoning_summary_text\.done/);
    assert.match(frames, /event: response\.reasoning_summary_part\.done/);
});
test("Responses incomplete terminal event includes incomplete_details", () => {
    const stream = new ResponsesStreamEncoder("worker/cheap", { responseId: "resp_incomplete", createdAt: 1 });
    const frame = stream.incomplete({
        blocks: [{ type: "text", text: "partial" }],
        usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
    }, "max_output_tokens");
    assert.match(frame, /event: response\.incomplete/);
    assert.match(frame, /"status":"incomplete"/);
    assert.match(frame, /"incomplete_details":\{"reason":"max_output_tokens"\}/);
});
test("Responses input text descends into message content arrays", () => {
    assert.equal(parseResponsesInputText([
        { type: "message", role: "user", content: [
                { type: "input_text", text: "hello " },
                { type: "input_text", text: "world" },
            ] },
    ]), "hello world");
});
