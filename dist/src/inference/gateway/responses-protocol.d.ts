export interface ResponsesUsage {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    input_tokens_details?: {
        cached_tokens?: number;
    };
    output_tokens_details?: {
        reasoning_tokens?: number;
    };
}
export type NormalizedResponseBlock = {
    type: "text";
    text: string;
    id?: string;
} | {
    type: "reasoning";
    summary: string;
    id?: string;
} | {
    type: "function_call";
    id: string;
    name: string;
    arguments: string;
    itemId?: string;
};
export interface NormalizedResponseResult {
    id?: string;
    model: string;
    createdAt?: number;
    blocks: NormalizedResponseBlock[];
    usage?: ResponsesUsage;
    status?: "completed" | "incomplete" | "failed";
    error?: {
        code?: string;
        message: string;
    };
    incompleteDetails?: {
        reason: string;
    };
    previousResponseId?: string | null;
    instructions?: string | null;
}
export interface ResponsesObject {
    id: string;
    object: "response";
    created_at: number;
    completed_at?: number | null;
    status: "completed" | "incomplete" | "failed" | "in_progress";
    model: string;
    output: Array<Record<string, unknown>>;
    usage?: ResponsesUsage;
    error?: {
        code?: string;
        message: string;
    } | null;
    incomplete_details?: {
        reason: string;
    } | null;
    previous_response_id?: string | null;
    instructions?: string | null;
}
export declare function toResponsesObject(result: NormalizedResponseResult): ResponsesObject;
/** Stateful encoder for the Responses streaming event families used by coding agents. */
export declare class ResponsesStreamEncoder {
    #private;
    readonly model: string;
    readonly responseId: string;
    readonly createdAt: number;
    constructor(model: string, options?: {
        responseId?: string;
        createdAt?: number;
    });
    created(): string;
    inProgress(): string;
    textStart(outputIndex: number, itemId?: string): string[];
    textDelta(outputIndex: number, delta: string, itemId?: string): string;
    textDone(outputIndex: number, text: string, itemId?: string): string[];
    reasoningStart(outputIndex: number, itemId?: string): string[];
    reasoningDelta(outputIndex: number, delta: string, itemId?: string): string;
    reasoningDone(outputIndex: number, text: string, itemId?: string): string[];
    functionStart(outputIndex: number, callId: string, name: string, itemId?: string): string;
    functionDelta(outputIndex: number, callId: string, delta: string, itemId?: string): string;
    functionDone(outputIndex: number, callId: string, name: string, args: string, itemId?: string): string[];
    completed(result: Omit<NormalizedResponseResult, "id" | "createdAt" | "model" | "status">): string;
    incomplete(result: Omit<NormalizedResponseResult, "id" | "createdAt" | "model" | "status">, reason?: string): string;
    failed(message: string, code?: string): string;
    event(type: string, fields: Record<string, unknown>): string;
}
export declare function parseResponsesInputText(input: unknown): string;
