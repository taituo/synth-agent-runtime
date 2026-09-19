import test from "node:test";
import assert from "node:assert/strict";
import { OpenCodeStackGatewayBackend } from "../adapter.js";

function fakeModels() {
  return {
    getModels: () => [{ id: "test-model" }],
    getModel: () => ({ id: "test-model" }),
    streamSimple(_model: unknown, _context: unknown, options: { signal?: AbortSignal } = {}) {
      const handle = {
        aborted: false,
        abort() { handle.aborted = true; },
        async *[Symbol.asyncIterator]() {
          yield { type: "text_start", contentIndex: 0 };
          let i = 0;
          for (;;) {
            if (options.signal?.aborted || handle.aborted) throw new Error("upstream aborted");
            await new Promise((resolve) => setTimeout(resolve, 5));
            if (options.signal?.aborted || handle.aborted) throw new Error("upstream aborted");
            yield { type: "text_delta", contentIndex: 0, delta: `tok${i++} ` };
          }
        },
      };
      return handle;
    },
  };
}

function streamRequest() {
  return new Request("http://gateway/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "test-model", input: "hi", stream: true }),
  });
}

test("client disconnect mid-stream does not crash the gateway", async () => {
  const backend = new OpenCodeStackGatewayBackend(fakeModels() as never);
  const response = await backend.handle(streamRequest(), "test-model");
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  // Simulate client disconnect: tears down the controller and aborts upstream.
  await reader.cancel();
  // Let the abort race play out: the loop observes abort, and the catch path
  // must not enqueue into the closed controller (previously: uncaught
  // ERR_INVALID_STATE killed the gateway process).
  await new Promise((resolve) => setTimeout(resolve, 200));
  // Gateway still serves afterwards.
  const again = await backend.handle(streamRequest(), "test-model");
  const reader2 = again.body!.getReader();
  let chunks = 0;
  for (;;) {
    const next = await reader2.read();
    if (next.done) break;
    if (++chunks > 12) { await reader2.cancel(); break; }
  }
  assert.ok(chunks > 0);
});
