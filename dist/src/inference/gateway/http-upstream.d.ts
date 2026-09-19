import type { GatewayBackend, GatewayModel } from "./types.js";
/** Simple transparent backend for another OpenAI-compatible endpoint. */
export declare class HttpGatewayBackend implements GatewayBackend {
    private readonly options;
    constructor(options: {
        baseUrl: string;
        apiKey?: string;
        models: GatewayModel[];
        headers?: Record<string, string>;
        fetch?: typeof globalThis.fetch;
    });
    listModels(): Promise<GatewayModel[]>;
    handle(request: Request): Promise<Response>;
}
