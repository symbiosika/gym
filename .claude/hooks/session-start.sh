#!/bin/bash
set -euo pipefail
# SessionStart hook for Claude Code on the web: check out the framework
# submodule and install dependencies so backend and frontend work in a fresh
# container. Idempotent, non-interactive. Locally nothing happens.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then exit 0; fi
cd "${CLAUDE_PROJECT_DIR:-.}"
echo "[session-start] refreshing origin refs"
git fetch --quiet --no-tags --no-recurse-submodules --prune origin || echo "[session-start] git fetch failed"
git submodule update --init --recursive || echo "[session-start] framework submodule checkout failed"
for pkg in backend frontend; do
  if [ ! -f "$pkg/package.json" ]; then continue; fi
  echo "[session-start] installing $pkg dependencies"
  (cd "$pkg" && bun install)
done
