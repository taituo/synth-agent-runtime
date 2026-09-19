/** Simple transparent backend for another OpenAI-compatible endpoint. */
export class HttpGatewayBackend {
    options;
    constructor(options) {
        this.options = options;
    }
    async listModels() {
        return this.options.models.map((model) => ({ ...model }));
    }
    async handle(request) {
        const source = new URL(request.url);
        const target = new URL(source.pathname + source.search, ensureSlash(this.options.baseUrl));
        const headers = new Headers(request.headers);
        // Fetch owns framing/connection headers. Forwarding caller-provided hop-by-hop
        // values can produce invalid upstream requests or connection confusion.
        for (const name of [
            "host", "connection", "keep-alive", "proxy-authenticate",
            "proxy-authorization", "te", "trailer", "transfer-encoding",
            "upgrade", "content-length",
        ])
            headers.delete(name);
        if (this.options.apiKey)
            headers.set("authorization", `Bearer ${this.options.apiKey}`);
        for (const [key, value] of Object.entries(this.options.headers ?? {}))
            headers.set(key, value);
        const fetchFn = this.options.fetch ?? globalThis.fetch;
        return fetchFn(target, {
            method: request.method,
            headers,
            body: request.body,
            signal: request.signal,
            // Node fetch requires duplex when streaming a request body.
            ...(request.body ? { duplex: "half" } : {}),
        });
    }
}
function ensureSlash(value) {
    return value.endsWith("/") ? value : `${value}/`;
}
