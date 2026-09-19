# Synth Agent Runtime v0.1

This is the first concrete extraction of the architecture we designed around Pi/OpenCode:

```text
User / TUI / Desktop / Voice
            |
         AgentRuntime
       /      |       \
 Agent graph  Tasks   Durable world
      |                 |
   Pi adapter         Temporal adapter
      |
 MemoryWorkspace ---- ExecutionBroker
      |                  |
 native Git base      synthetic -> physical
      |
 Inference profiles -> OpenAI-compatible gateway -> OpenCode stack / manual providers
```

## What is real in this version

- `AgentRuntime`: one agent object works both attached/interactively and unattended.
- Agent/task/relation/artifact primitives.
- RAM-only mutable `MemoryWorkspace` with cheap `fork()` and diff artifacts.
- Checkout-less `NativeGitSource`: bare + shallow + partial (`blob:none`) source with optional sparse view.
- `ExecutionBroker` with a synthetic executor and explicit escalation for physical execution.
- `DurabilityProvider`, local implementation, and a Temporal-shaped adapter that keeps Temporal behind the runtime API.
- Structural Pi adapter (`PiAgentEngine`) so Pi remains an engine, not the architecture.
- Tiny OpenAI-compatible gateway shell exposing `/health`, `/v1/models`, `/v1/chat/completions`, `/v1/responses`.

## Git model

The mutable agent workspace never writes project files to disk. Native Git is used only as an immutable backing/object cache:

```text
bare partial clone (shared cache)
  --depth=1
  --filter=blob:none
       |
       v
 NativeGitSource
       |
       v
 MemoryWorkspace
   RAM overlay
```

Example:

```ts
const source = await NativeGitSource.open({
  gitDir: "/var/cache/synth/git/my-repo.git",
  remote: "git@github.com:org/repo.git",
  ref: "main",
  depth: 1,
  filter: "blob:none",
  sparse: ["package.json", "src", "packages/api"],
});

const workspace = new MemoryWorkspace({ source });
```

The Git object cache can live on normal disk, tmpfs, or an ephemeral volume. Agent edits remain RAM-only.

## Run

```bash
npm run build
npm test
npm run demo
```

Gateway demo:

```bash
npm run gateway:demo
curl http://127.0.0.1:8787/v1/models
```

## Integrating Pi

`PiAgentEngine` deliberately uses a structural `PiSessionLike`, so this package has no hard dependency on Pi. In your Pi fork/wrapper, provide a factory around `createAgentSession()` and bind its tools to the synthetic execution environment.

The existing OpenCode Go stack router prototype should become a `GatewayBackend`: clients (Pi, OpenCode Desktop/TUI, Temporal workers) then see one normal provider URL while account stacking and manual fallbacks stay behind it.

See `ARCHITECTURE.md` for the next implementation slice.
