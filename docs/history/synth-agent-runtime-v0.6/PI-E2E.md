# Pi E2E contracts

The Pi integration is built around the current `ExecutionEnv` seam, not by replacing Pi's tool semantics.

```text
AgentHarness
  ├ createReadTool()
  ├ createWriteTool()
  ├ createEditTool()
  └ createBashTool()
           │
           ▼
      toolContext.env
           │
     ExecutionEnv implementation
```

Target source baseline: `earendil-works/pi` commit `36b60d2e8985899743c4cf5bd5f8929832a3f05d`.

## Baseline NodeExecutionEnv contract

```bash
./integrations/pi-e2e/install-test.sh /path/to/pi
cd /path/to/pi
pnpm vitest packages/agent/test/synth-runtime-pi.e2e.test.ts
```

This proves our assumptions about the current Pi `AgentHarness`/tool contract.

## Synthetic MemoryExecutionEnv contract

```bash
./integrations/pi-e2e/install-memory-test.sh /path/to/pi
cd /path/to/pi
pnpm vitest packages/agent/test/synth-runtime-memory.e2e.test.ts
```

The installer copies only the synthetic environment source files plus the test; it does not replace the coding-agent mini worker. The test seeds an immutable source revision, lets Pi's normal tools modify/read it in RAM, then validates the exported workspace artifact.

The artifact environment used to build v0.6 does not contain a Pi checkout, so these external tests are syntax-checked but are not reported as executed here.
