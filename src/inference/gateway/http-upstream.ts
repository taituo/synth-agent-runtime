import type { GatewayBackend, GatewayModel } from "./types.js";

/** Simple transparent backend for another OpenAI-compatible endpoint. */
export class HttpGatewayBackend implements GatewayBackend {
  constructor(private readonly options: {
    baseUrl: string;
    apiKey?: string;
    models: GatewayModel[];
    headers?: Record<string, string>;
    fetch?: typeof globalThis.fetch;
  }) {}

  async listModels(): Promise<GatewayModel[]> {
    return this.options.models.map((model) => ({ ...model }));
  }

  async handle(request: Request): Promise<Response> {
    const source = new URL(request.url);
    // Join the base path with the request path. A leading-slash path would
    // otherwise REPLACE the base path, so a provider mounted under a prefix
    // (e.g. https://opencode.ai/zen) could never be reached: the /zen prefix
    // was silently dropped and the upstream returned 404.
    const base = new URL(ensureSlash(this.options.baseUrl));
    const target = new URL(`${base.pathname.replace(/\/$/, "")}${source.pathname}${source.search}`, base);
    const headers = new Headers(request.headers);
    // Fetch owns framing/connection headers. Forwarding caller-provided hop-by-hop
    // values can produce invalid upstream requests or connection confusion.
    for (const name of [
      "host", "connection", "keep-alive", "proxy-authenticate",
      "proxy-authorization", "te", "trailer", "transfer-encoding",
      "upgrade", "content-length",
    ]) headers.delete(name);
    if (this.options.apiKey) headers.set("authorization", `Bearer ${this.options.apiKey}`);
    for (const [key, value] of Object.entries(this.options.headers ?? {})) headers.set(key, value);
    const fetchFn = this.options.fetch ?? globalThis.fetch;
    return fetchFn(target, {
      method: request.method,
      headers,
      body: request.body,
      signal: request.signal,
      // Node fetch requires duplex when streaming a request body.
      ...(request.body ? ({ duplex: "half" } as unknown as Record<string, unknown>) : {}),
    } as RequestInit);
  }
}

function ensureSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
