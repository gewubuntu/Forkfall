#!/bin/bash
# Cloud sessions: install the toolchain CI uses (Node 26, pnpm, Foundry + solc), the workspace packages and the
# contract libraries, so `pnpm typecheck|lint|test` and `forge test` work from the first prompt.
# foundryup and Foundry's solc downloads (foundry.paradigm.xyz, binaries.soliditylang.org) are blocked in the cloud
# sandbox, so Foundry and solc come from their GitHub releases. Everything lands under ~/.cache, which the container
# snapshot keeps, so later sessions skip the downloads.
set -euo pipefail
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

FOUNDRY_VERSION=v1.8.3   # .github/workflows/ci.yml
SOLC_VERSION=0.8.37      # contracts/foundry.toml
TOOLS="$HOME/.cache/forkfall-tools"
mkdir -p "$TOOLS"
cd "$CLAUDE_PROJECT_DIR"

# Node: the major version in .nvmrc (CI uses the same file).
major=$(tr -dc '0-9' < .nvmrc)
node_dir=$(ls -d "$TOOLS"/node-v"$major".* 2>/dev/null | tail -1 || true)
if [ -z "$node_dir" ]; then
  version=$(curl -fsSL https://nodejs.org/dist/index.json | python3 -c \
    "import json,sys; print(next(r['version'] for r in json.load(sys.stdin) if r['version'].startswith('v$major.')))")
  curl -fsSL "https://nodejs.org/dist/$version/node-$version-linux-x64.tar.xz" | tar xJ -C "$TOOLS"
  node_dir="$TOOLS/node-$version-linux-x64"
fi
export PATH="$node_dir/bin:$TOOLS/foundry:$PATH"

# pnpm: the version pinned in package.json "packageManager".
want_pnpm=$(node -p "require('./package.json').packageManager.split('@')[1]")
# Check this Node's own pnpm: an older one elsewhere on PATH would otherwise hide that it is missing.
[ "$("$node_dir/bin/pnpm" --version 2>/dev/null || true)" = "$want_pnpm" ] || npm install -g --silent "pnpm@$want_pnpm"

# Foundry and solc. forge finds solc in ~/.svm without downloading it.
if [ ! -x "$TOOLS/foundry/forge" ] || ! "$TOOLS/foundry/forge" --version | grep -q "${FOUNDRY_VERSION#v}"; then
  mkdir -p "$TOOLS/foundry"
  curl -fsSL "https://github.com/foundry-rs/foundry/releases/download/$FOUNDRY_VERSION/foundry_${FOUNDRY_VERSION}_linux_amd64.tar.gz" \
    | tar xz -C "$TOOLS/foundry"
fi
solc="$HOME/.svm/$SOLC_VERSION/solc-$SOLC_VERSION"
if [ ! -x "$solc" ]; then
  mkdir -p "$(dirname "$solc")"
  curl -fsSL -o "$solc" "https://github.com/ethereum/solidity/releases/download/v$SOLC_VERSION/solc-static-linux"
  chmod +x "$solc"
fi

git submodule update --init --recursive --quiet
pnpm install --frozen-lockfile --reporter=silent

{
  echo "export PATH=\"$node_dir/bin:$TOOLS/foundry:\$PATH\""
  echo "export FOUNDRY_OFFLINE=true"   # solc is in ~/.svm; don't let forge try the blocked download host
} >> "$CLAUDE_ENV_FILE"
