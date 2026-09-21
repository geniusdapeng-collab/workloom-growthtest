#!/usr/bin/env bash

# Download a pinned release asset and verify it before any caller can unpack it.
# Mirrors are allowed only when they return the exact digest recorded in
# scripts/release-assets.json.
#
# 2026-09-21 真机修复（打包可重复性）：装配脚本此前每次打包都要重新下载
# Node / PostgreSQL / nats（合计 200MB+），一旦 GitHub 或 nodejs.org 抖动，
# 整包装配就卡死（真机实测连续出现 curl (28) 超时，第三次打包因此中止）。
# 现在先按「资产名 + SHA-256」查本地缓存，命中即跳过网络；下载成功并验签后回填缓存。
# 缓存目录可用 WORKLOOM_ASSET_CACHE 覆盖（默认 ~/.cache/workloom-assets）。
workloom_asset_cache_dir() {
  echo "${WORKLOOM_ASSET_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/workloom-assets}"
}

workloom_fetch_verified() { # <out> <asset-name> <url...>
  local out="$1"
  local asset_name="$2"
  local partial="${out}.part.$$"
  shift 2
  local url
  rm -f "$out" "$partial"
  local cache_dir cached
  cache_dir="$(workloom_asset_cache_dir)"
  cached="${cache_dir}/${asset_name}"
  if [ -f "$cached" ] && node scripts/release-assets.mjs verify "$cached" "$asset_name" >/dev/null 2>&1; then
    echo "  ✓ 命中本地资产缓存：${asset_name}（${cache_dir}）"
    cp "$cached" "$out"
    return 0
  fi
  for url in "$@"; do
    echo "  ↓ $url"
    if curl --http1.1 -fsSL \
      --retry 10 --retry-all-errors --retry-delay 4 \
      --connect-timeout 30 --max-time 1800 \
      -o "$partial" "$url"; then
      if node scripts/release-assets.mjs verify "$partial" "$asset_name"; then
        mv -f "$partial" "$out"
        if mkdir -p "$cache_dir" 2>/dev/null; then
          cp "$out" "$cached" 2>/dev/null || true
        fi
        return 0
      fi
      echo "  ⚠️  摘要不匹配，删除下载并回退下一源"
      rm -f "$partial"
    else
      echo "  ⚠️  下载失败，回退下一源"
      rm -f "$partial"
    fi
  done
  rm -f "$partial"
  echo "❌ 全部下载源失败或摘要不匹配：$asset_name"
  return 1
}
