export class PiAgentEngine {
    createSession;
    #session;
    constructor(createSession) {
        this.createSession = createSession;
    }
    async run(messages, context) {
        const session = await this.createSession(context);
        this.#session = session;
        const unsubscribe = session.subscribe?.((event) => context.emitOutput(JSON.stringify(event)));
        try {
            const input = [...messages].reverse().find((m) => m.role === "human")?.text ?? "Continue the assigned task.";
            await session.prompt(input, { source: "runtime" });
            return { ok: true };
        }
        finally {
            unsubscribe?.();
            this.#session = undefined;
        }
    }
    async steer(message) {
        if (!this.#session)
            return;
        await this.#session.prompt(message.text, { streamingBehavior: "steer", source: "runtime" });
    }
}
