#!/usr/bin/env bash
set -euo pipefail
PI_REPO=${1:?usage: install-test.sh /path/to/pi}
HERE=$(cd "$(dirname "$0")" && pwd)
TARGET="$PI_REPO/packages/agent/test/synth-runtime-pi.e2e.test.ts"
cp "$HERE/pi-harness.e2e.test.ts" "$TARGET"
echo "Installed: $TARGET"
echo "Run from Pi repo: pnpm vitest packages/agent/test/synth-runtime-pi.e2e.test.ts"
