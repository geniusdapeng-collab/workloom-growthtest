#!/usr/bin/env bash
# 调色工位 ffmpeg 安装（受控下载 + 摘要校验；二进制不进仓库）
#
#   bash install.sh            # 安装到 ${WORKLOOM_COLOR_HOME:-$HOME/.workloom-color}/bin
#   bash install.sh --check    # 只检查现状，不下载
#
# 纪律：下载 .gz → 解压 → 校验 sha256 → 原子替换；摘要不符立即失败且不覆盖现有文件。
# 注意：脚本内变量一律写 ${var}（bash 3.2 会把紧随变量的中文字节并进变量名）。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PIN="${HERE}/ffmpeg-pin.json"
TARGET_DIR="${WORKLOOM_COLOR_HOME:-${HOME}/.workloom-color}/bin"
CHECK_ONLY=0
if [ "${1:-}" = "--check" ]; then CHECK_ONLY=1; fi

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"
case "${os}-${arch}" in
  darwin-arm64|darwin-x64) platform="${os}-${arch}" ;;
  *) echo "✗ 未登记的工位平台：${os}-${arch}" >&2; exit 2 ;;
esac

read_pin() {
  /usr/bin/python3 - "${PIN}" "${platform}" "$1" <<'PY'
import json, sys
pin, platform, key = sys.argv[1], sys.argv[2], sys.argv[3]
doc = json.load(open(pin, encoding="utf-8"))
entry = doc["targets"].get(platform, {}).get(key, {})
print(entry.get("url", ""), entry.get("sha256", ""))
PY
}

verify_one() {
  local name="$1"
  local url sha current tmp got
  read -r url sha <<<"$(read_pin "${name}")"
  if [ -z "${url}" ] || [ -z "${sha}" ]; then
    echo "✗ ${name} 未在该平台登记（ffmpeg-pin.json）" >&2
    return 1
  fi
  if [ "${sha}" = "UNVERIFIED" ]; then
    echo "✗ ${name} 摘要未核验（UNVERIFIED）：请在目标平台核验后回填 ffmpeg-pin.json" >&2
    return 1
  fi
  if [ -x "${TARGET_DIR}/${name}" ]; then
    current="$(shasum -a 256 "${TARGET_DIR}/${name}" | awk '{print $1}')"
    if [ "${current}" = "${sha}" ]; then
      echo "✓ ${name} 已安装且摘要匹配"
      return 0
    fi
    echo "… ${name} 摘要不符（本地 ${current} 与 pin ${sha} 不同），重新安装"
  fi
  if [ "${CHECK_ONLY}" = "1" ]; then
    echo "✗ ${name} 未安装（--check 模式不下载）" >&2
    return 1
  fi

  tmp="$(mktemp -d)"
  echo "… 下载 ${name} 自 ${url}"
  curl -fsSL -o "${tmp}/${name}.gz" "${url}"
  gunzip -c "${tmp}/${name}.gz" > "${tmp}/${name}"
  chmod +x "${tmp}/${name}"
  got="$(shasum -a 256 "${tmp}/${name}" | awk '{print $1}')"
  if [ "${got}" != "${sha}" ]; then
    echo "✗ ${name} 摘要校验失败：期望 ${sha}，实际 ${got}" >&2
    rm -rf "${tmp}"
    return 1
  fi
  mkdir -p "${TARGET_DIR}"
  mv -f "${tmp}/${name}" "${TARGET_DIR}/${name}"
  rm -rf "${tmp}"
  echo "✓ ${name} 安装完成（sha256=${got}）"
}

echo "调色工位平台：${platform}"
echo "安装目录：${TARGET_DIR}"
verify_one ffmpeg
verify_one ffprobe

if [ -x "${TARGET_DIR}/ffmpeg" ]; then
  "${TARGET_DIR}/ffmpeg" -hide_banner -version | head -1
  "${TARGET_DIR}/ffprobe" -hide_banner -version | head -1
  echo
  echo "许可提示：该构建 configure 含 --enable-gpl --enable-nonfree，仅限工位本地使用，"
  echo "不可随产品分发；详见 kit/ffmpeg-pin.json 的 license 字段。"
fi
