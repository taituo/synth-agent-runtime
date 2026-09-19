import { MemoryWorkspace, runTransactionalTurn } from "../src/index.js";

const workspace = new MemoryWorkspace();
workspace.write("state.txt", "base");

const result = await runTransactionalTurn({
  workspace,
  onEvent: console.log,
  attempts: [
    {
      id: "provider-a",
      retryable: () => true,
      async run() {
        workspace.write("state.txt", "provider-a-mutated");
        throw new Error("transient upstream failure before semantic output");
      },
    },
    {
      id: "provider-b",
      retryable: () => false,
      async run() {
        const before = await workspace.readText("state.txt");
        workspace.write("state.txt", `${before}:provider-b`);
        return "ok";
      },
    },
  ],
});

console.log(result, await workspace.readText("state.txt"));
