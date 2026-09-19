# Pi E2E contracts

These tests target the Pi source interfaces inspected at commit
`36b60d2e8985899743c4cf5bd5f8929832a3f05d`.

## NodeExecutionEnv baseline

```bash
./install-test.sh /path/to/pi
cd /path/to/pi
pnpm vitest packages/agent/test/synth-runtime-pi.e2e.test.ts
```

## MemoryExecutionEnv contract

This installs the synthetic in-memory environment files only (it does **not**
replace the coding-agent mini worker) and adds an E2E test proving that Pi's
normal read/write/edit/bash tools can execute against a seeded RAM-only world.

```bash
./install-memory-test.sh /path/to/pi
cd /path/to/pi
pnpm vitest packages/agent/test/synth-runtime-memory.e2e.test.ts
```

The test seeds `hello.txt` from an immutable synthetic Git-like revision, lets
normal Pi tools modify/read it, then checks `MemoryExecutionEnv.exportArtifact()`.
