#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-.}"
cd "$ROOT"

if [[ ! -f packages/coding-agent/src/experimental/mini/worker/run.ts ]]; then
  echo "Run this from the Pi repository root (or pass the repo path)." >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="packages/coding-agent/src/experimental/stack-router"
mkdir -p "$TARGET"
cp "$HERE"/src/inference/*.ts "$TARGET"/

cp packages/coding-agent/src/experimental/mini/worker/run.ts \
  packages/coding-agent/src/experimental/mini/worker/run.ts.before-stack-router
cp "$HERE"/integration/mini-worker-run.ts \
  packages/coding-agent/src/experimental/mini/worker/run.ts

echo "Installed transparent OpenCode Go stack router."
echo "Configure e.g.:"
echo "  export OPENCODE_GO_KEY_A=..."
echo "  export OPENCODE_GO_KEY_B=..."
echo "  export PI_OPENCODE_GO_STACK='go-a:OPENCODE_GO_KEY_A,go-b:OPENCODE_GO_KEY_B'"
echo "Optional normal-provider fallback routes:"
echo '  export PI_INFERENCE_FALLBACKS_JSON='"'"'[{"id":"zen","provider":"opencode","model":"$requested"}]'"'"''
