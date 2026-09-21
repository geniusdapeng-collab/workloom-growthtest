#!/bin/sh
# Codex SessionStart hook：输出 WorkLoom 能力/在岗/待审批摘要（JSON 到 stdout）。
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PLUGIN_DIR=$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)
REPO_ROOT=$(CDPATH= cd -- "${PLUGIN_DIR}/../.." && pwd)

export WORKLOOM_REPO_ROOT="${REPO_ROOT}"

# shellcheck source=resolve-node.sh
. "${SCRIPT_DIR}/resolve-node.sh"

if ! NODE_BIN=$(resolve_workloom_node); then
  echo '{"systemMessage":"WorkLoom 工作台未就绪：未找到 Node ≥24"}'
  exit 0
fi

SESSION_CWD="${WORKLOOM_SESSION_CWD:-$PWD}"
exec "${NODE_BIN}" "${REPO_ROOT}/tools/codex-gateway/bin/cli.mjs" context --cwd "${SESSION_CWD}"
