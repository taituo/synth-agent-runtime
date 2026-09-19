const base = process.env.SYNTH_GATEWAY_URL;
if (!base) throw new Error("Set SYNTH_GATEWAY_URL");
const headers = { "content-type": "application/json" };
if (process.env.SYNTH_GATEWAY_BEARER) headers.authorization = `Bearer ${process.env.SYNTH_GATEWAY_BEARER}`;
if (process.env.SYNTH_SESSION_ID) headers["x-synth-session"] = process.env.SYNTH_SESSION_ID;

const health = await fetch(new URL("/health", base), { headers });
if (!health.ok) throw new Error(`health failed: ${health.status}`);
const catalogResponse = await fetch(new URL("/v1/models", base), { headers });
if (!catalogResponse.ok) throw new Error(`models failed: ${catalogResponse.status}`);
const catalog = await catalogResponse.json();
const model = process.env.SYNTH_GATEWAY_MODEL ?? catalog?.data?.[0]?.id;
if (!model) throw new Error("No model in /v1/models and SYNTH_GATEWAY_MODEL not set");

const response = await fetch(new URL("/v1/responses", base), {
  method: "POST",
  headers,
  body: JSON.stringify({
    model,
    input: process.env.SYNTH_GATEWAY_PROMPT ?? "Reply with the single word READY.",
    stream: true,
    metadata: { session_id: process.env.SYNTH_SESSION_ID ?? `probe-${Date.now()}` },
  }),
});
if (!response.ok) throw new Error(`Responses request failed: ${response.status} ${await response.text()}`);
const text = await response.text();
if (!text.includes("response.created")) throw new Error("missing response.created");
if (!text.includes("response.completed") && !text.includes("response.incomplete")) throw new Error("missing terminal Responses event");
console.log(JSON.stringify({ ok: true, model, bytes: text.length }));
