#!/usr/bin/env bash
set -euo pipefail
ROOT="${1:-.}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROTO="$HERE/../pi-synthetic-git-prototype"
cd "$ROOT"
if [[ ! -f packages/agent/package.json ]]; then
  echo "Run from a Pi checkout root, or pass the checkout path." >&2
  exit 2
fi
mkdir -p packages/agent/src/harness/env packages/agent/test
for f in memory-source.ts github-snapshot-source.ts memory-git.ts memory.ts; do
  cp "$PROTO/packages/agent/src/harness/env/$f" "packages/agent/src/harness/env/$f"
done
cp "$HERE/pi-memory-env.e2e.test.ts" packages/agent/test/synth-runtime-memory.e2e.test.ts
printf '%s\n' "Installed MemoryExecutionEnv + Pi E2E contract test." \
  "Run:" \
  "  pnpm vitest packages/agent/test/synth-runtime-memory.e2e.test.ts"
