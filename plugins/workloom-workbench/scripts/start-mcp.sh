#!/bin/sh
# 启动 workloom-core MCP server（stdio）。自身可定位仓库根，不依赖 cwd 与 PATH。
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PLUGIN_DIR=$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)

# shellcheck source=resolve-node.sh
. "${SCRIPT_DIR}/resolve-node.sh"
# shellcheck source=resolve-repo.sh
. "${SCRIPT_DIR}/resolve-repo.sh"

if ! REPO_ROOT=$(resolve_workloom_repo_root "${PLUGIN_DIR}"); then
  echo "workloom-workbench: 未找到 WorkLoom 仓库根。请设置 WORKLOOM_REPO_ROOT=/path/to/workloom-growthtest，或在插件目录写入 repo-root.txt" >&2
  exit 1
fi

export WORKLOOM_REPO_ROOT="${REPO_ROOT}"

if ! NODE_BIN=$(resolve_workloom_node); then
  echo "workloom-workbench: 未找到 Node ≥24。请安装 Node，或设置 WORKLOOM_NODE=/path/to/node" >&2
  exit 1
fi

exec "${NODE_BIN}" "${REPO_ROOT}/tools/codex-gateway/bin/mcp.mjs"
