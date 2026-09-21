#!/bin/sh
# 解析 Node ≥24：优先 WORKLOOM_NODE，其次仓内运行时的 node，再其次 Codex 捆绑运行时，最后 PATH。
resolve_workloom_node() {
  if [ -n "${WORKLOOM_NODE:-}" ] && [ -x "${WORKLOOM_NODE}" ]; then
    printf '%s' "${WORKLOOM_NODE}"
    return 0
  fi

  for candidate in \
    "${WORKLOOM_REPO_ROOT:-}/.workloom-runtime-deps/node/bin/node" \
    "${WORKLOOM_REPO_ROOT:-}/.workloom-runtime-deps/node/node" \
    "${WORKLOOM_REPO_ROOT:-}/node_modules/.bin/node"
  do
    if [ -n "${candidate}" ] && [ -x "${candidate}" ]; then
      printf '%s' "${candidate}"
      return 0
    fi
  done

  for candidate in "${HOME}"/.cache/codex-runtimes/*/dependencies/node/bin/node; do
    if [ -x "${candidate}" ]; then
      printf '%s' "${candidate}"
      return 0
    fi
  done

  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  for candidate in /usr/local/bin/node /opt/homebrew/bin/node "${HOME}"/.nvm/versions/node/*/bin/node; do
    if [ -x "${candidate}" ]; then
      printf '%s' "${candidate}"
      return 0
    fi
  done
  return 1
}
