#!/bin/sh
workloom_repo_ok() {
  [ -f "$1/product.manifest.json" ] && [ -f "$1/tools/codex-gateway/bin/mcp.mjs" ]
}
resolve_workloom_repo_root() {
  plugin_dir_in="$1"
  if [ -n "${WORKLOOM_REPO_ROOT:-}" ]; then
    workloom_repo_ok "$WORKLOOM_REPO_ROOT" || return 1
    (CDPATH= cd -- "$WORKLOOM_REPO_ROOT" && pwd); return
  fi
  for candidate in "$plugin_dir_in/../.." "$plugin_dir_in"; do
    if workloom_repo_ok "$candidate"; then (CDPATH= cd -- "$candidate" && pwd); return; fi
  done
  if [ -f "$plugin_dir_in/repo-root.txt" ]; then
    IFS= read -r candidate < "$plugin_dir_in/repo-root.txt" || [ -n "$candidate" ]
    if workloom_repo_ok "$candidate"; then (CDPATH= cd -- "$candidate" && pwd); return; fi
  fi
  for candidate in "$HOME/WorkLoom-fleet/workloom-growthtest" "$HOME"/WorkLoom-fleet/*; do
    if workloom_repo_ok "$candidate"; then (CDPATH= cd -- "$candidate" && pwd); return; fi
  done
  return 1
}
