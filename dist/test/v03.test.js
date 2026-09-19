import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime, InMemoryWorldStore, JsonFileWorldStore, LocalMemoryDurability, MemoryWorkspace, ProfileRouterBackend, Supervisor, runTransactionalTurn, } from "../src/index.js";
test("transactional turn restores workspace before fallback attempt", async () => {
    const workspace = new MemoryWorkspace();
    workspace.write("a.txt", "base");
    const seen = [];
    const value = await runTransactionalTurn({
        workspace,
        attempts: [
            {
                id: "a",
                retryable: () => true,
                async run() {
                    workspace.write("a.txt", "broken");
                    throw new Error("retry");
                },
            },
            {
                id: "b",
                retryable: () => false,
                async run() {
                    seen.push((await workspace.readText("a.txt")) ?? "missing");
                    workspace.write("a.txt", "good");
                    return 7;
                },
            },
        ],
    });
    assert.equal(value, 7);
    assert.deepEqual(seen, ["base"]);
    assert.equal(await workspace.readText("a.txt"), "good");
});
test("world store builds a compact project projection", async () => {
    const world = new InMemoryWorldStore();
    const project = await world.createProject({ name: "p", objective: "ship", constraints: ["no host writes"] });
    const durability = new LocalMemoryDurability();
    const runtime = new AgentRuntime(durability);
    const task = await runtime.createTask({ title: "t", objective: "do it" });
    await world.attachTask(project.id, task);
    await world.addDecision(project.id, { title: "RAM first", rationale: "cheap forks", status: "accepted" });
    const projection = await world.projection(project.id);
    assert.ok(projection?.contextText.includes("no host writes"));
    assert.ok(projection?.contextText.includes("RAM first"));
    assert.ok(projection?.contextText.includes("do it"));
});
test("supervisor delegates onto isolated workspace forks", async () => {
    const runtime = new AgentRuntime(new LocalMemoryDurability());
    const workspace = await runtime.createWorkspace(new MemoryWorkspace());
    workspace.write("x", "parent");
    const engine = { async run() { return "ok"; } };
    const parent = await runtime.spawn({ definition: { id: "super", inferenceProfile: { id: "super" } }, engine, workspace });
    const supervisor = new Supervisor(runtime);
    const child = await supervisor.delegate({ supervisorId: parent.id, title: "child", objective: "work", engine, autoRun: false });
    const childSnapshot = runtime.get(child.agentId);
    const childWorkspace = runtime.workspaces.get(childSnapshot.workspaceId);
    assert.ok(childWorkspace);
    childWorkspace.write("x", "child");
    assert.equal(await workspace.readText("x"), "parent");
    assert.equal(await childWorkspace.readText("x"), "child");
});
test("profile router rewrites virtual model and falls back on 429", async () => {
    const seen = [];
    const backend = (name, status) => ({
        async listModels() { return []; },
        async handle(request, model) {
            const body = await request.json();
            seen.push([name, body.model]);
            return new Response(JSON.stringify({ name }), { status, headers: { "content-type": "application/json" } });
        },
    });
    const router = new ProfileRouterBackend({
        backends: { first: backend("first", 429), second: backend("second", 200) },
        profiles: [{ model: { id: "worker/cheap" }, routes: [
                    { id: "r1", backend: "first", model: "go-model" },
                    { id: "r2", backend: "second", model: "fallback-model" },
                ] }],
    });
    const response = await router.handle(new Request("http://router/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "worker/cheap", messages: [] }),
    }), "worker/cheap");
    assert.equal(response.status, 200);
    assert.deepEqual(seen, [["first", "go-model"], ["second", "fallback-model"]]);
});
test("json file world persists project state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "synth-world-"));
    try {
        const file = join(dir, "world.json");
        const world = await JsonFileWorldStore.open(file);
        const project = await world.createProject({ name: "durable", objective: "persist" });
        await world.addDecision(project.id, { title: "D", rationale: "R", status: "accepted" });
        const reopened = await JsonFileWorldStore.open(file);
        const projection = await reopened.projection(project.id);
        assert.equal(projection?.project.name, "durable");
        assert.ok(projection?.contextText.includes("D"));
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
