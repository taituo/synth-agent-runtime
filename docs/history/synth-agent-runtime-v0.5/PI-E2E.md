# Pi E2E contract

The Pi integration is intentionally based on the current `ExecutionEnv` seam rather than replacing Pi's normal tools.

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

`integrations/pi-e2e/pi-harness.e2e.test.ts` installs into the Pi monorepo and runs a real tool turn using Pi's faux provider. The first model response calls `write`, Pi executes the normal tool through `ExecutionEnv`, and a second response completes the run. The test asserts the file was actually written and the model was called twice.

This separates two questions:

1. Does our adapter match Pi's real harness/tool contract? The E2E test verifies that inside Pi.
2. Does the synthetic `MemoryExecutionEnv` behave correctly? That implementation has its own tests/prototype bundle and can be substituted at `toolContext.env` without changing the agent tools.

Target source baseline for this v0.5 test: `earendil-works/pi` commit `36b60d2e8985899743c4cf5bd5f8929832a3f05d`.

```bash
./integrations/pi-e2e/install-test.sh /path/to/pi
cd /path/to/pi
pnpm vitest packages/agent/test/synth-runtime-pi.e2e.test.ts
```

The local artifact sandbox did not contain a Pi checkout, so the external monorepo test is not reported as executed in `TEST-RESULTS.txt`; only syntax validation is performed here.
