#!/usr/bin/env bash
# 配乐工位 ffmpeg 安装（受控下载 + 摘要校验；二进制不进仓库）
#
#   bash install.sh            # 安装到 ${WORKLOOM_BGM_HOME:-$HOME/.workloom-bgm}/bin
#   bash install.sh --check    # 只检查现状，不下载
#
# 纪律：下载 .gz → 解压 → 校验 sha256 → 原子替换；摘要不符立即失败且不覆盖现有文件。
# 与调色工位（color-bridge/kit）独立：两个工位可分别 pin 版本、分别升级、互不影响。
# 注意：脚本内变量一律写 ${var}（bash 3.2 会把紧随变量的中文字节并进变量名）。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PIN="${HERE}/ffmpeg-pin.json"
TARGET_DIR="${WORKLOOM_BGM_HOME:-${HOME}/.workloom-bgm}/bin"
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
    echo "… ${name} 摘要不匹配，重新安装"
  fi
  if [ "${CHECK_ONLY}" = "1" ]; then
    echo "✗ ${name} 未安装（--check 不下载）" >&2
    return 1
  fi
  tmp="$(mktemp -d)"
  echo "… 下载 ${name}"
  curl -fsSL "${url}" -o "${tmp}/${name}.gz"
  gunzip -c "${tmp}/${name}.gz" > "${tmp}/${name}"
  chmod +x "${tmp}/${name}"
  got="$(shasum -a 256 "${tmp}/${name}" | awk '{print $1}')"
  if [ "${got}" != "${sha}" ]; then
    echo "✗ ${name} 摘要不符：期望 ${sha}，实得 ${got}（不覆盖现有文件）" >&2
    rm -rf "${tmp}"
    return 1
  fi
  mkdir -p "${TARGET_DIR}"
  mv "${tmp}/${name}" "${TARGET_DIR}/${name}"
  rm -rf "${tmp}"
  echo "✓ ${name} 安装完成（${TARGET_DIR}/${name}）"
}

echo "配乐工位平台：${platform}｜安装目录：${TARGET_DIR}"
verify_one ffmpeg
verify_one ffprobe

FILTERS="$("${TARGET_DIR}/ffmpeg" -hide_banner -filters 2>/dev/null || true)"
missing=0
while IFS= read -r name; do
  [ -z "${name}" ] && continue
  if ! grep -qE "[[:space:]]${name}[[:space:]]" <<<"${FILTERS}"; then
    echo "✗ 缺少滤镜：${name}" >&2
    missing=1
  fi
done < <(/usr/bin/python3 - "${PIN}" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1], encoding="utf-8"))
for name in doc.get("requiredFilters", []):
    print(name)
PY
)
if [ "${missing}" != "0" ]; then
  echo "✗ 滤镜清单不完整：配乐链（loudnorm/sidechaincompress/…）无法完整执行" >&2
  exit 1
fi
echo "✓ 必需滤镜齐备（$(/usr/bin/python3 -c "import json,sys;print(len(json.load(open(sys.argv[1],encoding='utf-8'))['requiredFilters']))" "${PIN}") 项）"
echo "下一步：bash selftest.sh（真实跑一遍作曲 + 诊断 + 混音）"
