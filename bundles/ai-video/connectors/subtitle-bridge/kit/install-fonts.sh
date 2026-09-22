#!/usr/bin/env bash
# 字幕工位字体安装/核验（受控获取；字体二进制不进仓库）
#
#   bash install-fonts.sh --from-dir <dir>   # 从字体包/客户字体目录导入（推荐：离线可用、逐文件校验 sha256）
#   bash install-fonts.sh --download         # 从登记的上游直链获取（只放行已逐字节核验的条目）
#   bash install-fonts.sh --check            # 只核对现状，不写入
#
# 目标目录：${WORKLOOM_SUBTITLE_FONTS_DIR:-$HOME/.workloom-subtitle/fonts}（布局 cn/ en/ 与档案 file 字段一致）
# 纪律：逐文件 sha256 校验，摘要不符立即失败且不覆盖现有文件；OFL 许可文本随字体一并落盘。
# 注意：脚本内变量一律写 ${var}（bash 3.2 会把紧随变量的中文字节并进变量名）。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BUNDLE_ROOT="$(cd "${HERE}/../../.." && pwd)"
PIN="${HERE}/fonts-pin.json"
CATALOG="${BUNDLE_ROOT}/library/font-catalog/font_db.json"
TARGET_DIR="${WORKLOOM_SUBTITLE_FONTS_DIR:-${HOME}/.workloom-subtitle/fonts}"
MODE="check"
FROM_DIR=""
PROXY="${HTTPS_PROXY:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --from-dir) FROM_DIR="${2:?--from-dir 需要目录}"; MODE="import"; shift ;;
    --download) MODE="download" ;;
    --check) MODE="check" ;;
    --proxy) PROXY="${2:?--proxy 需要 URL}"; shift ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
  shift
done

python3 - "${PIN}" "${CATALOG}" "${TARGET_DIR}" "${MODE}" "${FROM_DIR}" "${PROXY}" <<'PY'
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile

pin_path, catalog_path, target_dir, mode, from_dir, proxy = sys.argv[1:7]
pin = json.load(open(pin_path, encoding="utf-8"))
catalog = json.load(open(catalog_path, encoding="utf-8"))


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


by_file = {font["file"]: font for font in pin["fonts"]}
catalog_files = {font["file"] for font in catalog["fonts"]}
if set(by_file) != catalog_files:
    print("✗ 引脚与档案不一致：fonts-pin.json 的 file 集合 ≠ font_db.json 的 file 集合", file=sys.stderr)
    sys.exit(2)
for item in pin["fonts"]:
    entry = next(font for font in catalog["fonts"] if font["file"] == item["file"])
    if entry["sha256"] != item["sha256"]:
        print(f"✗ 引脚与档案 sha256 不一致：{item['file']}", file=sys.stderr)
        sys.exit(2)

missing, mismatch, ok = [], [], 0
for item in pin["fonts"]:
    target = os.path.join(target_dir, item["file"])
    if not os.path.exists(target):
        missing.append(item["file"])
        continue
    if sha256(target) != item["sha256"]:
        mismatch.append(item["file"])
        continue
    ok += 1

print(f"字体目录：{target_dir}")
print(f"现状：已安装且摘要匹配 {ok}/{len(pin['fonts'])}（缺失 {len(missing)}，摘要不符 {len(mismatch)}）")
for name in mismatch:
    print(f"  ✗ 摘要不符（请重新安装）：{name}")
if mode == "check":
    for name in missing:
        print(f"  · 未安装：{name}")
    sys.exit(1 if mismatch else 0)


def write_target(source_file: str, item: dict) -> bool:
    target = os.path.join(target_dir, item["file"])
    os.makedirs(os.path.dirname(target), exist_ok=True)
    got = sha256(source_file)
    if got != item["sha256"]:
        print(f"  ✗ 摘要不符 {item['file']}：期望 {item['sha256'][:12]}，实得 {got[:12]}（不写入）")
        return False
    tmp_dir = tempfile.mkdtemp(prefix="workloom-font-", dir=os.path.dirname(target))
    tmp = os.path.join(tmp_dir, os.path.basename(target))
    shutil.copyfile(source_file, tmp)
    os.replace(tmp, target)
    shutil.rmtree(tmp_dir, ignore_errors=True)
    print(f"  ✓ {item['file']}（{item['name']}）")
    return True


def copy_licenses() -> None:
    source = os.path.join(os.path.dirname(catalog_path), "LICENSES.md")
    if os.path.exists(source):
        os.makedirs(target_dir, exist_ok=True)
        shutil.copyfile(source, os.path.join(target_dir, "LICENSES.md"))
        print("  ✓ LICENSES.md（OFL 再分发要求）")


if mode == "import":
    if not from_dir or not os.path.isdir(from_dir):
        print(f"✗ --from-dir 目录不存在：{from_dir}", file=sys.stderr)
        sys.exit(2)
    installed = 0
    for item in pin["fonts"]:
        candidates = [
            os.path.join(from_dir, item["file"]),                   # cn/X.ttf
            os.path.join(from_dir, "fonts", item["file"]),          # fonts/cn/X.ttf
            os.path.join(from_dir, os.path.basename(item["file"])),  # 平铺目录
        ]
        source = next((path for path in candidates if os.path.exists(path)), None)
        if not source:
            print(f"  · 源目录缺少 {item['file']}：跳过")
            continue
        installed += 1 if write_target(source, item) else 0
    copy_licenses()
    print(f"完成：本次安装 {installed} 款（{target_dir}）")
    sys.exit(0)

if mode == "download":
    unverified = [item for item in pin["fonts"] if not item["upstream"].get("verifiedAt")]
    if unverified:
        print(f"✗ {len(unverified)} 款字体的上游直链未逐字节核验（verifiedAt 为空），拒绝下载：", file=sys.stderr)
        for item in unverified[:8]:
            print(f"    · {item['file']}", file=sys.stderr)
        print("  处置：用 --from-dir 从字体包/客户字体目录导入（本仓不携带字体二进制）", file=sys.stderr)
        sys.exit(2)
    work = tempfile.mkdtemp(prefix="workloom-font-download-")
    installed = 0
    for item in pin["fonts"]:
        raw = os.path.join(work, os.path.basename(item["file"]) + ".download")
        curl = ["curl", "-fsSL", "--max-time", "600", "-o", raw, item["upstream"]["url"]]
        if proxy:
            curl[1:1] = ["-x", proxy]
        subprocess.run(curl, check=True)
        source = raw
        member = item["upstream"].get("zipMember")
        if member:
            with zipfile.ZipFile(raw) as archive:
                source = os.path.join(work, member)
                with archive.open(member) as handle, open(source, "wb") as out:
                    shutil.copyfileobj(handle, out)
        installed += 1 if write_target(source, item) else 0
    shutil.rmtree(work, ignore_errors=True)
    copy_licenses()
    print(f"完成：本次安装 {installed} 款（{target_dir}）")
    sys.exit(0)

print(f"未知模式：{mode}", file=sys.stderr)
sys.exit(2)
PY

echo "下一步：bash ${HERE}/selftest.sh（真实跑一遍选型 → 方案 → 烧录 → 复检）"
