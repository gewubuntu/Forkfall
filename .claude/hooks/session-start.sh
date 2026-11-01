#!/bin/bash
# Cloud sessions: install the toolchain CI uses (Node 26, pnpm, Foundry + solc), the workspace packages and the
# contract libraries, so `pnpm typecheck|lint|test` and `forge test` work from the first prompt.
# foundryup and Foundry's solc downloads (foundry.paradigm.xyz, binaries.soliditylang.org) are blocked in the cloud
# sandbox, so Foundry and solc come from their GitHub releases. Everything lands under ~/.cache/forkfall-tools, so
# re-runs in the same container (resume, /clear, compaction) take under a second; a fresh container downloads again.
set -euo pipefail
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
# On failure, tell Claude: a SessionStart hook's stdout on exit 0 becomes context (the user then sees no error notice).
trap '[ $? = 0 ] || echo "Forkfall toolchain setup failed at: $BASH_COMMAND. Tell the user; check node --version and forge --version before running checks; rerun .claude/hooks/session-start.sh to retry."; exit 0' EXIT

TOOLS="$HOME/.cache/forkfall-tools"
mkdir -p "$TOOLS"
cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"   # both unset when the script is rerun by hand
ENV_FILE="${CLAUDE_ENV_FILE:-/dev/null}"

# Downloads extract into a temp dir and move into place only once complete, so a cut-off transfer never leaves a
# half-extracted tool that later runs would accept.
fetch_tar() { # url, flags for tar, final dir, name of the single top-level dir in the archive ("" = none)
  local tmp; tmp=$(mktemp -d "$TOOLS/.tmp.XXXXXX")
  curl -fsSL "$1" | tar "$2" -C "$tmp"
  rm -rf "$3"
  if [ -n "$4" ]; then mv "$tmp/$4" "$3"; rm -rf "$tmp"; else mv "$tmp" "$3"; fi
}
rm -rf "$TOOLS"/.tmp.*

# Node: the newest cached build of the major version in .nvmrc (CI uses the same file).
major=$(tr -dc '0-9' < .nvmrc)
node_dir=$(ls -d "$TOOLS"/node-v"$major".* 2>/dev/null | sort -V | tail -1 || true)
if [ -z "$node_dir" ] || ! "$node_dir/bin/node" --version >/dev/null 2>&1; then
  version=$(curl -fsSL https://nodejs.org/dist/index.json | python3 -c \
    "import json,sys; print(next(r['version'] for r in json.load(sys.stdin) if r['version'].startswith('v$major.')))")
  node_dir="$TOOLS/node-$version-linux-x64"
  fetch_tar "https://nodejs.org/dist/$version/node-$version-linux-x64.tar.xz" xJ "$node_dir" "node-$version-linux-x64"
fi
export PATH="$node_dir/bin:$TOOLS/foundry:$PATH"

# pnpm: the version pinned in package.json "packageManager".
want_pnpm=$("$node_dir/bin/node" -p "require('./package.json').packageManager.split('@')[1]")
# Check this Node's own pnpm: an older one elsewhere on PATH would otherwise hide that it is missing.
[ "$("$node_dir/bin/pnpm" --version 2>/dev/null || true)" = "$want_pnpm" ] || "$node_dir/bin/npm" install -g --silent "pnpm@$want_pnpm"
# Hand the tools to the session now: a failure below still leaves Node and pnpm on PATH, and forge appears once a
# rerun installs it.
{
  echo "export PATH=\"$node_dir/bin:$TOOLS/foundry:\$PATH\""
  echo "export FOUNDRY_OFFLINE=true"   # solc is in ~/.svm; don't let forge try the blocked download host
} >> "$ENV_FILE"

# The versions CI uses, read from where CI reads them.
FOUNDRY_VERSION=$(sed -n 's/.*{ *version: *\(v[0-9.]*\) *}.*/\1/p' .github/workflows/ci.yml | head -1)
SOLC_VERSION=$(sed -n 's/^solc_version *= *"\([0-9.]*\)".*/\1/p' contracts/foundry.toml)
[ -n "$FOUNDRY_VERSION" ]
[ -n "$SOLC_VERSION" ]

# Foundry and solc. forge finds solc in ~/.svm without downloading it.
if [ ! -x "$TOOLS/foundry/forge" ] || ! "$TOOLS/foundry/forge" --version | grep -qxF "forge Version: ${FOUNDRY_VERSION#v}"; then
  fetch_tar "https://github.com/foundry-rs/foundry/releases/download/$FOUNDRY_VERSION/foundry_${FOUNDRY_VERSION}_linux_amd64.tar.gz" \
    xz "$TOOLS/foundry" ""
fi
solc="$HOME/.svm/$SOLC_VERSION/solc-$SOLC_VERSION"
if [ ! -x "$solc" ]; then
  mkdir -p "$(dirname "$solc")"
  curl -fsSL -o "$solc" "https://github.com/ethereum/solidity/releases/download/v$SOLC_VERSION/solc-static-linux"
  chmod +x "$solc"
fi

git submodule update --init --recursive --quiet
pnpm install --frozen-lockfile --reporter=silent
