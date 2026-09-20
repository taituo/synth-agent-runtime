#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-.}"
cd "$ROOT"

if [[ ! -f packages/agent/package.json || ! -f packages/coding-agent/src/experimental/mini/worker/run.ts ]]; then
  echo "Run from a Pi checkout root, or pass the checkout path." >&2
  exit 2
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p packages/agent/src/harness/env packages/agent/test/harness/env
cp "$HERE/packages/agent/src/harness/env/memory-source.ts" packages/agent/src/harness/env/memory-source.ts
cp "$HERE/packages/agent/src/harness/env/github-snapshot-source.ts" packages/agent/src/harness/env/github-snapshot-source.ts
cp "$HERE/packages/agent/src/harness/env/memory-git.ts" packages/agent/src/harness/env/memory-git.ts
cp "$HERE/packages/agent/src/harness/env/memory.ts" packages/agent/src/harness/env/memory.ts
cp "$HERE/packages/agent/test/harness/env/memory-git.test.ts" packages/agent/test/harness/env/memory-git.test.ts

python - <<'PY'
from pathlib import Path
import json
p = Path("packages/agent/package.json")
data = json.loads(p.read_text())
exports = data.setdefault("exports", {})
exports.setdefault("./harness/env/memory", {
    "types": "./dist/harness/env/memory.d.ts",
    "import": "./dist/harness/env/memory.js",
})
p.write_text(json.dumps(data, indent="\t", ensure_ascii=False) + "\n")
PY

cp packages/coding-agent/src/experimental/mini/worker/run.ts \
   packages/coding-agent/src/experimental/mini/worker/run.ts.pre-synthetic-backup
cp "$HERE/packages/coding-agent/src/experimental/mini/worker/run.ts" packages/coding-agent/src/experimental/mini/worker/run.ts

echo "Synthetic in-memory Git workspace prototype installed."
echo "Try:"
echo "  export OPENCODE_API_KEY=..."
echo "  export PI_SYNTH_GITHUB_REPO=owner/repo"
echo "  export PI_SYNTH_GITHUB_REF=main"
echo "  export PI_SYNTH_GITHUB_SPARSE=src,package.json"
echo "Then run Pi's experimental mini client/server as usual."
echo
echo "Recommended checks:"
echo "  npm --prefix packages/agent test -- --run test/harness/env/memory-git.test.ts"
echo "  npm --prefix packages/agent run build"
