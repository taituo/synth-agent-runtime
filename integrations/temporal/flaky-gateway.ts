/**
 * Fault-injecting reverse proxy for a real OpenAI-compatible gateway, used to
 * exercise the inference activity's failure handling with genuine HTTP faults
 * instead of mocks.
 *
 *   UPSTREAM=http://127.0.0.1:8787 PORT=8788 MODE=502 FAIL_FIRST=2 npx tsx flaky-gateway.ts
 *
 * Only `POST .../chat/completions` requests are counted and faulted; every
 * other request (e.g. `GET /v1/models`) and every non-faulted completion is
 * forwarded unchanged to UPSTREAM.
 *
 *   MODE=502      the faulted requests get an HTTP 502
 *   MODE=429      the faulted requests get an HTTP 429 with a Retry-After hint
 *   MODE=garbage  the faulted requests get HTTP 200 with a reply that is not JSON
 *   MODE=hang     the faulted requests are accepted and never answered
 *   FAIL_FIRST=N  fault the first N completion requests (default 2); use a huge
 *                 number to fault every request
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

export interface FlakyGatewayOptions {
  upstream: string;
  port: number;
  mode: "502" | "429" | "garbage" | "hang";
  failFirst: number;
  /** Retry-After seconds advertised by MODE=429. */
  retryAfterSeconds?: number;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export function startFlakyGateway(options: FlakyGatewayOptions) {
  let completionRequests = 0;
  let faulted = 0;
  const upstream = options.upstream.replace(/\/$/, "");

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readBody(req);
    const isCompletion = req.method === "POST" && (req.url ?? "").includes("/chat/completions");
    if (isCompletion) {
      completionRequests++;
      if (completionRequests <= options.failFirst) {
        faulted++;
        if (options.mode === "hang") return; // never answer; the caller's timeout must save it
        if (options.mode === "garbage") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Sorry, I can't help with that." } }] }));
          return;
        }
        if (options.mode === "429") {
          res.writeHead(429, { "content-type": "text/plain", "retry-after": String(options.retryAfterSeconds ?? 1) });
          res.end("injected rate limit");
          return;
        }
        res.writeHead(502, { "content-type": "text/plain" });
        res.end("injected upstream failure");
        return;
      }
    }
    try {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string" && !["host", "content-length", "connection"].includes(key)) headers[key] = value;
      }
      const response = await fetch(`${upstream}${req.url}`, {
        method: req.method,
        headers,
        ...(body.length > 0 ? { body } : {}),
      });
      res.writeHead(response.status, { "content-type": response.headers.get("content-type") ?? "application/json" });
      res.end(await response.text());
    } catch (error) {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`flaky-gateway could not reach upstream: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  return {
    server,
    stats: () => ({ completionRequests, faulted }),
    listen: () => new Promise<void>((resolve) => server.listen(options.port, "127.0.0.1", resolve)),
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = (process.env.MODE ?? "502") as FlakyGatewayOptions["mode"];
  const proxy = startFlakyGateway({
    upstream: process.env.UPSTREAM ?? "http://127.0.0.1:8787",
    port: Number(process.env.PORT ?? 8788),
    mode,
    failFirst: Number(process.env.FAIL_FIRST ?? 2),
  });
  await proxy.listen();
  console.log(`flaky-gateway on :${process.env.PORT ?? 8788} mode=${mode} failFirst=${process.env.FAIL_FIRST ?? 2}`);
}
