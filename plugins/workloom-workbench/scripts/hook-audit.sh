#!/bin/sh
# Codex PostToolUse / Stop hook：把 hook 事件原样交给网关账本（append-only 五元事件）。
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PLUGIN_DIR=$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)
REPO_ROOT=$(CDPATH= cd -- "${PLUGIN_DIR}/../.." && pwd)

export WORKLOOM_REPO_ROOT="${REPO_ROOT}"

# shellcheck source=resolve-node.sh
. "${SCRIPT_DIR}/resolve-node.sh"

if ! NODE_BIN=$(resolve_workloom_node); then
  exit 0
fi

exec "${NODE_BIN}" "${REPO_ROOT}/tools/codex-gateway/bin/cli.mjs" audit --source codex-hook
