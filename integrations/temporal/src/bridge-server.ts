import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { TemporalHarnessBridgeClient } from "./bridge-client.js";
import type { HarnessInferenceApi, HarnessToolRequest } from "./bridge-contracts.js";

export interface RunHarnessBridgeServerOptions {
  client: TemporalHarnessBridgeClient;
  host?: string;
  port?: number;
  bearerToken?: string;
}

async function readJson(req: IncomingMessage, limit = 16 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > limit) throw new Error("request body too large");
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export async function runHarnessBridgeServer(options: RunHarnessBridgeServerOptions): Promise<void> {
  const server = createServer(async (req, res) => {
    try {
      if (req.url === "/healthz") {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (options.bearerToken && header(req, "authorization") !== `Bearer ${options.bearerToken}`) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "method not allowed" });
        return;
      }

      if (req.url === "/v1/chat/completions" || req.url === "/v1/responses") {
        const body = await readJson(req);
        const api: HarnessInferenceApi =
          req.url === "/v1/responses" ? "responses" : "chat.completions";
        const agentId = header(req, "x-synth-agent-id") ?? "external";
        const sessionId = header(req, "x-synth-session-id") ?? agentId;
        const callId =
          header(req, "x-synth-call-id") ??
          header(req, "idempotency-key") ??
          randomUUID();
        const result = await options.client.infer({ agentId, sessionId, callId, api, body });
        res.writeHead(result.status, result.headers);
        res.end(result.bodyText);
        return;
      }

      if (req.url === "/v1/synth/tools/execute") {
        const body = (await readJson(req)) as HarnessToolRequest;
        if (
          !body ||
          typeof body.agentId !== "string" ||
          typeof body.sessionId !== "string" ||
          typeof body.toolCallId !== "string" ||
          typeof body.toolName !== "string" ||
          typeof body.callbackUrl !== "string"
        ) {
          sendJson(res, 400, { error: "invalid tool request" });
          return;
        }
        sendJson(res, 200, await options.client.executeTool(body));
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8788, options.host ?? "127.0.0.1", () => resolve());
  });
  await new Promise<void>((resolve) => server.once("close", resolve));
}
