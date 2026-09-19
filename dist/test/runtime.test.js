import test from "node:test";
import assert from "node:assert/strict";
import { AgentRuntime, InMemoryMailboxStore, LocalMemoryDurability, MemoryWorkspace } from "../src/index.js";
test("same agent runs unattended and can be observed interactively", async () => {
    const durability = new LocalMemoryDurability();
    const runtime = new AgentRuntime(durability);
    const ws = await runtime.createWorkspace(new MemoryWorkspace());
    const seen = [];
    const detach = runtime.attach((e) => seen.push(e.type));
    const engine = { async run() { ws.write("a.txt", "hello"); return "ok"; } };
    const agent = await runtime.spawn({ definition: { id: "x", inferenceProfile: { id: "worker" } }, engine, workspace: ws });
    await runtime.run(agent.id);
    detach();
    assert.equal(await ws.readText("a.txt"), "hello");
    assert.ok(seen.includes("agent.completed"));
});
test("forked workspaces isolate mutations", async () => {
    const ws = new MemoryWorkspace();
    ws.write("a.txt", "base");
    const child = ws.fork();
    child.write("a.txt", "child");
    assert.equal(await ws.readText("a.txt"), "base");
    assert.equal(await child.readText("a.txt"), "child");
});
test("runtime serializes streamed output events before completed state", async () => {
    class DelayedDurability extends LocalMemoryDurability {
        async appendEvent(event) {
            if (event.type === "agent.output")
                await new Promise((resolve) => setTimeout(resolve, 25));
            await super.appendEvent(event);
        }
    }
    const durability = new DelayedDurability();
    const runtime = new AgentRuntime(durability);
    const workspace = await runtime.createWorkspace(new MemoryWorkspace());
    const engine = {
        async run(_messages, context) {
            context.emitOutput("one");
            context.emitTool("read", "start");
            context.emitTool("read", "end");
            context.emitOutput("two");
            return "ok";
        },
    };
    const agent = await runtime.spawn({
        definition: { id: "ordered-events", inferenceProfile: { id: "worker" } },
        engine,
        workspace,
    });
    await runtime.run(agent.id);
    const events = await durability.listEvents();
    const relevant = events.filter((event) => "agentId" in event && event.agentId === agent.id).map((event) => event.type);
    const completed = relevant.lastIndexOf("agent.completed");
    assert.ok(completed >= 0);
    assert.ok(relevant.lastIndexOf("agent.output") < completed);
    assert.ok(relevant.lastIndexOf("agent.tool") < completed);
});
test("throwing runtime listeners are isolated from durable agent execution", async () => {
    const durability = new LocalMemoryDurability();
    const runtime = new AgentRuntime(durability);
    const workspace = await runtime.createWorkspace(new MemoryWorkspace());
    runtime.attach(() => { throw new Error("broken UI observer"); });
    const agent = await runtime.spawn({
        definition: { id: "listener-isolation", inferenceProfile: { id: "worker" } },
        engine: { async run() { return "ok"; } },
        workspace,
    });
    assert.equal(await runtime.run(agent.id), "ok");
    assert.equal(runtime.get(agent.id).state, "completed");
});
test("duplicate spawn id is rejected instead of clobbering the live agent", async () => {
    const durability = new LocalMemoryDurability();
    const runtime = new AgentRuntime(durability);
    const workspace = await runtime.createWorkspace(new MemoryWorkspace());
    const engine = { async run() { return "ok"; } };
    const options = {
        id: "dup-agent",
        definition: { id: "w", inferenceProfile: { id: "p" } },
        engine,
        workspace,
    };
    const first = await runtime.spawn(options);
    await runtime.send(first.id, "important-message");
    await assert.rejects(() => runtime.spawn(options), /AGENT_ALREADY_EXISTS:dup-agent/);
    assert.deepEqual(runtime.get(first.id).mailbox.map((m) => m.text), ["important-message"]);
});
test("concurrent sends with the same message id are delivered once", async () => {
    const durability = new LocalMemoryDurability();
    const runtime = new AgentRuntime(durability, undefined, new Map(), undefined, new InMemoryMailboxStore());
    const workspace = await runtime.createWorkspace(new MemoryWorkspace());
    const steered = [];
    const engine = {
        async run() { return "ok"; },
        async steer(message) { steered.push(message.id); },
    };
    const agent = await runtime.spawn({
        definition: { id: "w", inferenceProfile: { id: "p" } },
        engine,
        workspace,
    });
    await Promise.all([
        runtime.send(agent.id, "hello", "human", undefined, "11111111-1111-4111-8111-111111111111"),
        runtime.send(agent.id, "hello", "human", undefined, "11111111-1111-4111-8111-111111111111"),
    ]);
    assert.equal(runtime.get(agent.id).mailbox.filter((m) => m.id === "11111111-1111-4111-8111-111111111111").length, 1);
    assert.equal(steered.filter((id) => id === "11111111-1111-4111-8111-111111111111").length, 1);
});
test("concurrent duplicate spawns across runtime replicas create one durable identity", async () => {
    const durability = new LocalMemoryDurability();
    const left = new AgentRuntime(durability);
    const right = new AgentRuntime(durability);
    const leftWorkspace = await left.createWorkspace(new MemoryWorkspace());
    const rightWorkspace = await right.createWorkspace(new MemoryWorkspace());
    const engine = { async run() { return "ok"; } };
    const id = "replica-race";
    const [a, b] = await Promise.allSettled([
        left.spawn({ id, definition: { id: "w", inferenceProfile: { id: "p" } }, engine, workspace: leftWorkspace }),
        right.spawn({ id, definition: { id: "w", inferenceProfile: { id: "p" } }, engine, workspace: rightWorkspace }),
    ]);
    assert.equal([a, b].filter((result) => result.status === "fulfilled").length, 1);
    const rejected = [a, b].find((result) => result.status === "rejected");
    assert.ok(rejected && rejected.status === "rejected");
    assert.match(String(rejected.reason), /AGENT_ALREADY_EXISTS:replica-race/);
    assert.equal((await durability.listAgents()).filter((agent) => agent.id === id).length, 1);
});
test("durable mailbox dedup prevents duplicate steer across runtime replicas", async () => {
    const durability = new LocalMemoryDurability();
    const mailbox = new InMemoryMailboxStore();
    const firstSteers = [];
    const secondSteers = [];
    const firstEngine = { async run() { return "ok"; }, async steer(message) { firstSteers.push(message.id); } };
    const secondEngine = { async run() { return "ok"; }, async steer(message) { secondSteers.push(message.id); } };
    const first = new AgentRuntime(durability, undefined, new Map(), undefined, mailbox);
    const workspace = await first.createWorkspace(new MemoryWorkspace());
    const agent = await first.spawn({
        id: "mailbox-replica",
        definition: { id: "w", inferenceProfile: { id: "p" } },
        engine: firstEngine,
        workspace,
    });
    const second = new AgentRuntime(durability, undefined, new Map(), undefined, mailbox);
    await second.recover({
        definition: () => ({ id: "w", inferenceProfile: { id: "p" } }),
        engine: () => secondEngine,
        workspace: (snapshot) => new MemoryWorkspace({ id: snapshot.workspaceId }),
    });
    const messageId = "22222222-2222-4222-8222-222222222222";
    await Promise.all([
        first.send(agent.id, "hello", "human", undefined, messageId),
        second.send(agent.id, "hello", "human", undefined, messageId),
    ]);
    assert.equal(firstSteers.length + secondSteers.length, 1);
    const envelopes = await mailbox.readMailbox(agent.id, 0);
    assert.equal(envelopes.length, 1);
    assert.equal(envelopes[0].message.id, messageId);
});
