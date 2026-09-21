#!/bin/sh
# 解析 WorkLoom 仓库根。插件安装到 Codex 缓存后，PLUGIN_DIR/../.. 不再是源仓，
# 因此按以下顺序解析：显式环境变量 → 仓内相对（开发态）→ 插件内 repo-root.txt → 本机 WorkLoom-fleet 搜索。
# 用法：REPO_ROOT=$(resolve_workloom_repo_root "$PLUGIN_DIR") || { ... }
resolve_workloom_repo_root() {
  PLUGIN_DIR_IN="$1"

  if [ -n "${WORKLOOM_REPO_ROOT:-}" ] && [ -f "${WORKLOOM_REPO_ROOT}/product.manifest.json" ] && [ -d "${WORKLOOM_REPO_ROOT}/tools/codex-gateway" ]; then
    printf '%s' "${WORKLOOM_REPO_ROOT}"
    return 0
  fi

  for candidate in "${PLUGIN_DIR_IN}/../.." "${PLUGIN_DIR_IN}"; do
    if [ -f "${candidate}/product.manifest.json" ] && [ -d "${candidate}/tools/codex-gateway" ]; then
      printf '%s' "${candidate}"
      return 0
    fi
  done

  if [ -f "${PLUGIN_DIR_IN}/repo-root.txt" ]; then
    candidate=$(head -n 1 "${PLUGIN_DIR_IN}/repo-root.txt" | tr -d '[:space:]')
    if [ -n "${candidate}" ] && [ -f "${candidate}/product.manifest.json" ] && [ -d "${candidate}/tools/codex-gateway" ]; then
      printf '%s' "${candidate}"
      return 0
    fi
  fi

  for candidate in "${HOME}/WorkLoom-fleet/workloom-growthtest" "${HOME}"/WorkLoom-fleet/*; do
    if [ -f "${candidate}/product.manifest.json" ] && [ -d "${candidate}/tools/codex-gateway" ]; then
      printf '%s' "${candidate}"
      return 0
    fi
  done
  return 1
}
