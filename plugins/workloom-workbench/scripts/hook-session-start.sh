#!/bin/sh
# Codex SessionStart hook：输出 WorkLoom 能力/在岗/待审批摘要（JSON 到 stdout）。
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PLUGIN_DIR=$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)

# shellcheck source=resolve-node.sh
. "${SCRIPT_DIR}/resolve-node.sh"
# shellcheck source=resolve-repo.sh
. "${SCRIPT_DIR}/resolve-repo.sh"

if ! REPO_ROOT=$(resolve_workloom_repo_root "${PLUGIN_DIR}"); then
  echo '{"systemMessage":"WorkLoom 工作台未就绪：未找到 WorkLoom 仓库根，请设置 WORKLOOM_REPO_ROOT"}'
  exit 0
fi

export WORKLOOM_REPO_ROOT="${REPO_ROOT}"

if ! NODE_BIN=$(resolve_workloom_node); then
  echo '{"systemMessage":"WorkLoom 工作台未就绪：未找到 Node ≥24"}'
  exit 0
fi

SESSION_CWD="${WORKLOOM_SESSION_CWD:-$PWD}"
exec "${NODE_BIN}" "${REPO_ROOT}/tools/codex-gateway/bin/cli.mjs" context --cwd "${SESSION_CWD}"
