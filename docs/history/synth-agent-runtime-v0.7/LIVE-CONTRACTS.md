# Live external contracts

The root unit suite is self-contained. These contracts deliberately require real external systems and are separated so CI can opt into them.

## PostgreSQL contention

```bash
cd integrations/postgres
npm install
export SYNTH_POSTGRES_URL='postgres://...'
npx tsx smoke.ts
npx tsx concurrency.ts
```

The contention test opens multiple independent pools and races one command ID and one effect ID. Exactly one claimant must win each identity.

## Pi AgentHarness + MemoryExecutionEnv

```bash
./integrations/pi-e2e/install-memory-test.sh /path/to/pi
cd /path/to/pi
pnpm vitest packages/agent/test/synth-runtime-memory.e2e.test.ts
```

The test uses Pi's real `AgentHarness`, faux provider, session repo and normal read/write/edit/bash tools while `toolContext.env` is the synthetic in-memory environment.

## Kubernetes Pod kill

Prerequisites:

- `kubectl` configured for a test cluster;
- gVisor RuntimeClass (or explicitly chosen equivalent);
- executor image that contains a POSIX shell and Git;
- isolated test namespace permissions.

```bash
export SYNTH_EXECUTOR_IMAGE='registry/synth-executor@sha256:...'
export SYNTH_RUNTIME_CLASS='gvisor'
npx tsx integrations/kubernetes/kill-chaos.ts
```

The script creates an executor Pod, starts a long-running command, force-deletes the Pod, and asserts that the command does not report successful completion.

## Reporting rule

A bundled contract is not the same as an executed contract. `TEST-RESULTS.txt` must distinguish:

```text
PASS     executed here and passed
SKIPPED  prerequisite unavailable
NOT RUN  intentionally not invoked
```

This prevents architecture claims from outrunning actual verification.
