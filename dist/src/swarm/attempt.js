import { scoreFindings } from "./findings.js";
import { PLANTED_STREAM } from "./stream.js";
import { buildSwarmSystemPrompt, buildSwarmUserPrompt, createSwarmTools, FINDINGS_FILE, materializeStream, } from "./tools.js";
export async function runSwarmAttempt(options) {
    const stream = options.stream ?? PLANTED_STREAM;
    const now = options.now ?? Date.now;
    const maxTurns = options.maxTurns ?? 8;
    const deadline = now() + (options.deadlineMs ?? 5 * 60_000);
    await materializeStream(options.runner, stream);
    const tools = createSwarmTools(options.runner, { stream });
    const systemPrompt = buildSwarmSystemPrompt(tools.definitions);
    const userPrompt = buildSwarmUserPrompt(stream);
    let turnIndex = 0;
    let transcript = [];
    let requestedModel;
    let servedModel;
    let modelSubstituted = false;
    // Resume from a checkpoint: restore the findings AND write them back into the
    // workspace, since a retried durable attempt re-materializes an empty one.
    if (options.checkpoint && options.checkpointKey) {
        const restored = await options.checkpoint.load(options.checkpointKey);
        if (restored) {
            turnIndex = restored.turnIndex;
            transcript = restored.transcript;
            requestedModel = restored.requestedModel;
            servedModel = restored.servedModel;
            if (restored.findings.length > 0) {
                await options.runner.write(FINDINGS_FILE, `${restored.findings.map((finding) => JSON.stringify(finding)).join("\n")}\n`);
            }
        }
    }
    while (turnIndex < maxTurns && now() < deadline && !tools.finished()) {
        const result = await options.turn({
            turnIndex,
            streamName: stream.name,
            systemPrompt,
            userPrompt,
            transcript,
            tools: tools.definitions,
            findings: await tools.readFindings(),
        });
        turnIndex += 1;
        if (requestedModel === undefined)
            requestedModel = result.requestedModel ?? null;
        if (servedModel === undefined)
            servedModel = result.servedModel ?? null;
        if (result.modelSubstituted)
            modelSubstituted = true;
        if (result.content)
            transcript.push({ role: "assistant", content: result.content });
        for (const call of result.toolCalls) {
            const executed = await tools.execute(call);
            transcript.push({ role: "tool", name: call.name, content: executed.observation });
            options.onTool?.({ turnIndex, call, ok: executed.ok, observation: executed.observation });
            if (call.name === "finish")
                break;
        }
        if (options.checkpoint && options.checkpointKey) {
            await options.checkpoint.save(options.checkpointKey, {
                turnIndex,
                findings: await tools.readFindings(),
                transcript,
                requestedModel: requestedModel ?? null,
                servedModel: servedModel ?? null,
            });
        }
    }
    const findings = await tools.readFindings();
    return {
        findings,
        score: scoreFindings(stream, findings),
        turns: turnIndex,
        transcript,
        requestedModel: requestedModel ?? null,
        servedModel: servedModel ?? null,
        modelSubstituted,
        finished: tools.finished(),
    };
}
