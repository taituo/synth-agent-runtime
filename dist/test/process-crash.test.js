import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import { JsonFileDurabilityProvider } from "../src/durability/json-file-durability.js";
import { JsonFileRuntimeStateStore } from "../src/durability/json-file-runtime-state.js";
import { MemoryWorkspace } from "../src/workspace/memory-workspace.js";
test("SIGKILL during a durable turn is recovered from persisted state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "synth-crash-contract-"));
    try {
        const durabilityPath = join(dir, "durability.json");
        const statePath = join(dir, "runtime-state.json");
        const fixture = fileURLToPath(new URL("./fixtures/process-crash-worker.js", import.meta.url));
        const child = spawn(process.execPath, [fixture, durabilityPath, statePath], {
            stdio: ["ignore", "pipe", "pipe"],
        });
        const ready = await waitForReady(child);
        child.kill("SIGKILL");
        const exit = await waitForExit(child);
        assert.equal(exit.signal, "SIGKILL");
        const durability = new JsonFileDurabilityProvider(durabilityPath);
        const state = new JsonFileRuntimeStateStore(statePath);
        const runtime = new AgentRuntime(durability, undefined, new Map(), state);
        const definition = { id: "crash-worker", inferenceProfile: { id: "test" } };
        const recovered = await runtime.recover({
            definition: () => definition,
            engine: () => ({ async run() { return "recovered"; } }),
            workspace: (snapshot) => new MemoryWorkspace({ id: snapshot.workspaceId }),
        });
        assert.equal(recovered.agents, 1);
        assert.equal(recovered.incompleteTurnsRolledBack, 1);
        const agent = runtime.get(ready.agentId);
        assert.equal(agent.state, "idle");
        assert.equal(agent.metadata.recoveredFromState, "thinking");
        const turn = await state.getTurn(ready.turnId);
        assert.equal(turn?.status, "rolled_back");
        assert.equal(turn?.error, "Recovered after process interruption");
        const workspace = runtime.workspaces.get(ready.workspaceId);
        assert.ok(workspace);
        assert.equal(await workspace.readText("dirty-before-crash.txt"), undefined);
        const checkpoint = await state.getWorkspaceCheckpoint(ready.workspaceId);
        assert.ok(checkpoint);
        assert.match(checkpoint.reason, /^recover\.turn\./);
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
function waitForReady(child) {
    return new Promise((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`Timed out waiting for crash worker. stderr=${stderr}`));
        }, 10_000);
        child.stdout?.on("data", (chunk) => {
            stdout += String(chunk);
            const lines = stdout.split("\n");
            stdout = lines.pop() ?? "";
            for (const line of lines) {
                if (!line.trim())
                    continue;
                try {
                    const parsed = JSON.parse(line);
                    if (parsed.type === "ready") {
                        clearTimeout(timer);
                        resolve(parsed);
                        return;
                    }
                }
                catch { }
            }
        });
        child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
        child.once("error", (error) => { clearTimeout(timer); reject(error); });
        child.once("exit", (code, signal) => {
            if (code !== null || signal !== "SIGKILL") {
                clearTimeout(timer);
                reject(new Error(`Crash worker exited before ready: code=${code} signal=${signal} stderr=${stderr}`));
            }
        });
    });
}
function waitForExit(child) {
    if (child.exitCode !== null || child.signalCode !== null) {
        return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
    }
    return new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
    });
}
