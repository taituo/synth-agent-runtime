export function toResponsesObject(result) {
    const id = result.id ?? `resp_${crypto.randomUUID()}`;
    const created = result.createdAt ?? Math.floor(Date.now() / 1000);
    const status = result.status ?? "completed";
    return {
        id,
        object: "response",
        created_at: created,
        completed_at: status === "completed" ? Math.max(created, Math.floor(Date.now() / 1000)) : null,
        status,
        model: result.model,
        output: result.blocks.map((block, index) => {
            if (block.type === "text") {
                return {
                    id: block.id ?? `msg_${id}_${index}`,
                    type: "message",
                    status: "completed",
                    role: "assistant",
                    content: [{ type: "output_text", text: block.text, annotations: [] }],
                };
            }
            if (block.type === "reasoning") {
                return {
                    id: block.id ?? `rs_${id}_${index}`,
                    type: "reasoning",
                    summary: [{ type: "summary_text", text: block.summary }],
                };
            }
            return {
                id: block.itemId ?? `fc_${id}_${index}`,
                type: "function_call",
                status: "completed",
                call_id: block.id,
                name: block.name,
                arguments: block.arguments,
            };
        }),
        ...(result.usage ? { usage: result.usage } : {}),
        ...(result.error ? { error: result.error } : { error: null }),
        incomplete_details: status === "incomplete" ? (result.incompleteDetails ?? { reason: "max_output_tokens" }) : null,
        previous_response_id: result.previousResponseId ?? null,
        instructions: result.instructions ?? null,
    };
}
/** Stateful encoder for the Responses streaming event families used by coding agents. */
export class ResponsesStreamEncoder {
    model;
    responseId;
    createdAt;
    #sequence = 0;
    constructor(model, options = {}) {
        this.model = model;
        this.responseId = options.responseId ?? `resp_${crypto.randomUUID()}`;
        this.createdAt = options.createdAt ?? Math.floor(Date.now() / 1000);
    }
    created() {
        return this.event("response.created", {
            response: {
                id: this.responseId,
                object: "response",
                created_at: this.createdAt,
                status: "in_progress",
                model: this.model,
                output: [],
                error: null,
            },
        });
    }
    inProgress() {
        return this.event("response.in_progress", {
            response: {
                id: this.responseId,
                object: "response",
                created_at: this.createdAt,
                status: "in_progress",
                model: this.model,
                output: [],
                error: null,
            },
        });
    }
    textStart(outputIndex, itemId = `msg_${this.responseId}_${outputIndex}`) {
        return [
            this.event("response.output_item.added", {
                output_index: outputIndex,
                item: { id: itemId, type: "message", status: "in_progress", role: "assistant", content: [] },
            }),
            this.event("response.content_part.added", {
                item_id: itemId,
                output_index: outputIndex,
                content_index: 0,
                part: { type: "output_text", text: "", annotations: [] },
            }),
        ];
    }
    textDelta(outputIndex, delta, itemId = `msg_${this.responseId}_${outputIndex}`) {
        return this.event("response.output_text.delta", {
            item_id: itemId,
            output_index: outputIndex,
            content_index: 0,
            delta,
        });
    }
    textDone(outputIndex, text, itemId = `msg_${this.responseId}_${outputIndex}`) {
        const part = { type: "output_text", text, annotations: [] };
        return [
            this.event("response.output_text.done", {
                item_id: itemId,
                output_index: outputIndex,
                content_index: 0,
                text,
            }),
            this.event("response.content_part.done", {
                item_id: itemId,
                output_index: outputIndex,
                content_index: 0,
                part,
            }),
            this.event("response.output_item.done", {
                output_index: outputIndex,
                item: { id: itemId, type: "message", status: "completed", role: "assistant", content: [part] },
            }),
        ];
    }
    reasoningStart(outputIndex, itemId = `rs_${this.responseId}_${outputIndex}`) {
        return [
            this.event("response.output_item.added", {
                output_index: outputIndex,
                item: { id: itemId, type: "reasoning", summary: [] },
            }),
            this.event("response.reasoning_summary_part.added", {
                item_id: itemId,
                output_index: outputIndex,
                summary_index: 0,
                part: { type: "summary_text", text: "" },
            }),
        ];
    }
    reasoningDelta(outputIndex, delta, itemId = `rs_${this.responseId}_${outputIndex}`) {
        return this.event("response.reasoning_summary_text.delta", {
            item_id: itemId,
            output_index: outputIndex,
            summary_index: 0,
            delta,
        });
    }
    reasoningDone(outputIndex, text, itemId = `rs_${this.responseId}_${outputIndex}`) {
        const part = { type: "summary_text", text };
        return [
            this.event("response.reasoning_summary_text.done", {
                item_id: itemId,
                output_index: outputIndex,
                summary_index: 0,
                text,
            }),
            this.event("response.reasoning_summary_part.done", {
                item_id: itemId,
                output_index: outputIndex,
                summary_index: 0,
                part,
            }),
            this.event("response.output_item.done", {
                output_index: outputIndex,
                item: { id: itemId, type: "reasoning", summary: [part] },
            }),
        ];
    }
    functionStart(outputIndex, callId, name, itemId = `fc_${this.responseId}_${outputIndex}`) {
        return this.event("response.output_item.added", {
            output_index: outputIndex,
            item: { id: itemId, type: "function_call", status: "in_progress", call_id: callId, name, arguments: "" },
        });
    }
    functionDelta(outputIndex, callId, delta, itemId = `fc_${this.responseId}_${outputIndex}`) {
        return this.event("response.function_call_arguments.delta", {
            item_id: itemId,
            output_index: outputIndex,
            call_id: callId,
            delta,
        });
    }
    functionDone(outputIndex, callId, name, args, itemId = `fc_${this.responseId}_${outputIndex}`) {
        return [
            this.event("response.function_call_arguments.done", {
                item_id: itemId,
                output_index: outputIndex,
                call_id: callId,
                arguments: args,
            }),
            this.event("response.output_item.done", {
                output_index: outputIndex,
                item: { id: itemId, type: "function_call", status: "completed", call_id: callId, name, arguments: args },
            }),
        ];
    }
    completed(result) {
        return this.event("response.completed", {
            response: toResponsesObject({ ...result, id: this.responseId, createdAt: this.createdAt, model: this.model, status: "completed" }),
        });
    }
    incomplete(result, reason = "max_output_tokens") {
        return this.event("response.incomplete", {
            response: toResponsesObject({
                ...result,
                id: this.responseId,
                createdAt: this.createdAt,
                model: this.model,
                status: "incomplete",
                incompleteDetails: { reason },
            }),
        });
    }
    failed(message, code = "upstream_error") {
        return this.event("response.failed", {
            response: toResponsesObject({
                id: this.responseId,
                createdAt: this.createdAt,
                model: this.model,
                blocks: [],
                status: "failed",
                error: { code, message },
            }),
        });
    }
    event(type, fields) {
        return `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: this.#sequence++, ...fields })}\n\n`;
    }
}
export function parseResponsesInputText(input) {
    if (typeof input === "string")
        return input;
    if (!Array.isArray(input))
        return "";
    const chunks = [];
    for (const item of input) {
        if (!item || typeof item !== "object")
            continue;
        const value = item;
        if (value.type === "input_text" || value.type === "output_text") {
            if (typeof value.text === "string")
                chunks.push(value.text);
            continue;
        }
        if (typeof value.text === "string")
            chunks.push(value.text);
        if (Array.isArray(value.content))
            chunks.push(parseResponsesInputText(value.content));
    }
    return chunks.join("");
}
