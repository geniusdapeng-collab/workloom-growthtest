#!/bin/sh
# 安装 workloom-workbench-mcp 启动器到 PATH。
#
# 背景（2026-09-22 真机取证）：Codex 启动插件 MCP server 时 cwd=项目目录，
# PLUGIN_ROOT/CLAUDE_PLUGIN_ROOT 均未设置，因此 .mcp.json 不能用相对路径或 $PLUGIN_ROOT。
# 官方便携格式目前只支持远程 HTTPS MCP；本地 stdio 的兼容用法需要一个 PATH 命令或绝对路径。
# 本脚本把启动器写入 $HOME/.local/bin（Codex 的 PATH 已包含该目录），并把源仓路径写入
# 插件根 repo-root.txt 作为回调兜底。
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PLUGIN_DIR=$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)

# shellcheck source=resolve-repo.sh
. "${SCRIPT_DIR}/resolve-repo.sh"

if ! REPO_ROOT=$(resolve_workloom_repo_root "${PLUGIN_DIR}"); then
  echo "install-launcher: 未找到 WorkLoom 仓库根，请先设置 WORKLOOM_REPO_ROOT" >&2
  exit 1
fi
REPO_ROOT=$(CDPATH= cd -- "${REPO_ROOT}" && pwd)

printf '%s\n' "${REPO_ROOT}" > "${PLUGIN_DIR}/repo-root.txt"
BIN_DIR="${HOME}/.local/bin"
mkdir -p "${BIN_DIR}"
LAUNCHER="${BIN_DIR}/workloom-workbench-mcp"

cat > "${LAUNCHER}" <<EOF
#!/bin/sh
# 由 workloom-workbench/scripts/install-launcher.sh 生成；源仓：${REPO_ROOT}
exec "${REPO_ROOT}/plugins/workloom-workbench/scripts/start-mcp.sh" "\$@"
EOF
chmod +x "${LAUNCHER}"

echo "installed launcher: ${LAUNCHER}"
echo "repo root: ${REPO_ROOT}"
echo "next: restart Codex (or the plugin) so the plugin MCP server is relaunched."
