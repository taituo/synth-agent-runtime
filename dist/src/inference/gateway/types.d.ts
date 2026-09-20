export interface GatewayModel {
    id: string;
    object?: "model";
    owned_by?: string;
    /** Provider that actually offers the model (e.g. "opencode-go"). */
    provider?: string;
    /** Gateway profile/route the model is exposed under, when it is a routed profile. */
    profile?: string;
}
export interface GatewayBackend {
    listModels(): Promise<GatewayModel[]>;
    /** Pass through one OpenAI-compatible request and return a standard Response. */
    handle(request: Request, model: string): Promise<Response>;
}
