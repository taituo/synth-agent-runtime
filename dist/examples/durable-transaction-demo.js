import { LocalRuntimeStateStore, MemoryWorkspace, runDurableTransactionalTurn } from "../src/index.js";
const workspace = new MemoryWorkspace();
workspace.write("result.txt", "base");
const state = new LocalRuntimeStateStore();
const output = [];
await runDurableTransactionalTurn({
    workspace,
    store: state,
    publishOutput: (text) => { output.push(text); },
    attempts: [
        {
            id: "opencode-a",
            retryable: () => true,
            async run(turn) {
                workspace.write("result.txt", "failed attempt");
                turn.emitOutput("this is buffered and will disappear");
                throw new Error("provider quota");
            },
        },
        {
            id: "opencode-b",
            retryable: () => false,
            async run(turn) {
                workspace.write("result.txt", "committed attempt");
                turn.emitOutput("visible only after commit");
                return "ok";
            },
        },
    ],
});
console.log({ output, file: await workspace.readText("result.txt") });
