import { createInferenceGateway, type GatewayBackend } from "../src/index.js";

const backend: GatewayBackend = {
  async listModels() { return [{ id: "worker/cheap" }, { id: "super/strong" }]; },
  async handle(request, model) {
    const body = await request.json() as Record<string, unknown>;
    return Response.json({
      id: "demo",
      object: "chat.completion",
      model,
      choices: [{ index: 0, message: { role: "assistant", content: `routed ${String(body.model)}` }, finish_reason: "stop" }],
    });
  },
};

const gateway = createInferenceGateway({ backend, port: Number(process.env.PORT ?? 8787) });
await gateway.listen();
console.log(`gateway listening at ${gateway.url}`);
