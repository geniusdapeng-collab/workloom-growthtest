#!/bin/sh
# Explicit Node configuration is validated and fails closed; candidates need major >=24.
workloom_node_ok() {
  [ -x "$1" ] || return 1
  major=$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null) || return 1
  case "$major" in ''|*[!0-9]*) return 1;; esac
  [ "$major" -ge 24 ]
}
resolve_workloom_node() {
  if [ -n "${WORKLOOM_NODE:-}" ]; then
    workloom_node_ok "$WORKLOOM_NODE" || return 1
    printf '%s' "$WORKLOOM_NODE"; return 0
  fi
  for candidate in "${WORKLOOM_REPO_ROOT:-}/.workloom-runtime-deps/node/bin/node" "${WORKLOOM_REPO_ROOT:-}/.workloom-runtime-deps/node/node" "${HOME}"/.cache/codex-runtimes/*/dependencies/node/bin/node; do
    if workloom_node_ok "$candidate"; then printf '%s' "$candidate"; return 0; fi
  done
  if command -v node >/dev/null 2>&1; then
    candidate=$(command -v node)
    if workloom_node_ok "$candidate"; then printf '%s' "$candidate"; return 0; fi
  fi
  for candidate in /usr/local/bin/node /opt/homebrew/bin/node "${HOME}"/.nvm/versions/node/*/bin/node; do
    if workloom_node_ok "$candidate"; then printf '%s' "$candidate"; return 0; fi
  done
  return 1
}
