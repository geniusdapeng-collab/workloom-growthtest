#!/usr/bin/env bash
# 字幕工位字体安装/核验（受控获取；字体二进制不进仓库）
#
#   bash install-fonts.sh --check            # 校验仓内随包字体（默认）与工位外置目录现状
#   bash install-fonts.sh --install          # 把仓内随包字体安装到工位外置目录（可选，便于客户自备字体覆盖）
#   bash install-fonts.sh --from-dir <dir>   # 从客户字体目录导入（逐文件校验 sha256，不覆盖仓内字体）
#   bash install-fonts.sh --download         # 从登记的上游直链获取（只放行已逐字节核验的条目，用于升级）
#
# 字体事实源：随包字体 `bundles/ai-video/library/fonts/`（29 款，font-library v1.1 全量入库），
# 由「字体档案 sha256 + bundle 完整性索引」双重校验；字幕工位默认直接读该目录。
# 外置目录：${WORKLOOM_SUBTITLE_FONTS_DIR:-$HOME/.workloom-subtitle/fonts}（客户自备/升级字体的覆盖位）
# 纪律：逐文件 sha256 校验，摘要不符立即失败且不覆盖现有文件；OFL 许可文本随字体一并落盘。
# 注意：脚本内变量一律写 ${var}（bash 3.2 会把紧随变量的中文字节并进变量名）。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BUNDLE_ROOT="$(cd "${HERE}/../../.." && pwd)"
PIN="${HERE}/fonts-pin.json"
CATALOG="${BUNDLE_ROOT}/library/font-catalog/font_db.json"
BUNDLED_DIR="${BUNDLE_ROOT}/library/fonts"
EXTERNAL_DIR="${WORKLOOM_SUBTITLE_FONTS_DIR:-${HOME}/.workloom-subtitle/fonts}"
TARGET_DIR="${BUNDLED_DIR}"
MODE="check"
FROM_DIR=""
PROXY="${HTTPS_PROXY:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --from-dir) FROM_DIR="${2:?--from-dir 需要目录}"; MODE="import"; shift ;;
    --download) MODE="download" ;;
    --install) MODE="install" ;;
    --check) MODE="check" ;;
    --proxy) PROXY="${2:?--proxy 需要 URL}"; shift ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
  shift
done

python3 - "${PIN}" "${CATALOG}" "${BUNDLED_DIR}" "${EXTERNAL_DIR}" "${MODE}" "${FROM_DIR}" "${PROXY}" <<'PY'
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile

pin_path, catalog_path, bundled_dir, external_dir, mode, from_dir, proxy = sys.argv[1:8]
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

def audit(root):
    missing, mismatch, ok = [], [], 0
    for item in pin["fonts"]:
        target = os.path.join(root, item["file"])
        if not os.path.exists(target):
            missing.append(item["file"])
            continue
        if sha256(target) != item["sha256"]:
            mismatch.append(item["file"])
            continue
        ok += 1
    return ok, missing, mismatch


bundled_ok, bundled_missing, bundled_mismatch = audit(bundled_dir)
print(f"随包字体目录：{bundled_dir}")
print(f"  已随仓分发且摘要匹配 {bundled_ok}/{len(pin['fonts'])}（缺失 {len(bundled_missing)}，摘要不符 {len(bundled_mismatch)}）")
for name in bundled_mismatch:
    print(f"  ✗ 摘要不符（随包字体被改动过，必须回退）：{name}")
for name in bundled_missing:
    print(f"  ✗ 随包字体缺失：{name}")
if bundled_mismatch or bundled_missing:
    sys.exit(2)

if os.path.isdir(external_dir):
    external_ok, external_missing, external_mismatch = audit(external_dir)
    print(f"外置覆盖目录：{external_dir}")
    print(f"  摘要匹配 {external_ok}/{len(pin['fonts'])}（缺失 {len(external_missing)}，摘要不符 {len(external_mismatch)}）")
else:
    print(f"外置覆盖目录：{external_dir}（不存在：字幕工位默认直接使用随包字体）")
if mode == "check":
    sys.exit(0)


def write_target(source_file: str, item: dict, root: str) -> bool:
    target = os.path.join(root, item["file"])
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


def copy_licenses(root: str) -> None:
    source = os.path.join(os.path.dirname(catalog_path), "LICENSES.md")
    if os.path.exists(source):
        os.makedirs(root, exist_ok=True)
        shutil.copyfile(source, os.path.join(root, "LICENSES.md"))
        print("  ✓ LICENSES.md（OFL 再分发要求）")


if mode == "install":
    installed = 0
    for item in pin["fonts"]:
        source = os.path.join(bundled_dir, item["file"])
        installed += 1 if write_target(source, item, external_dir) else 0
    copy_licenses(external_dir)
    print(f"完成：随包字体已安装到工位外置目录 {installed} 款（{external_dir}）")
    sys.exit(0)


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
        installed += 1 if write_target(source, item, external_dir) else 0
    copy_licenses(external_dir)
    print(f"完成：本次安装 {installed} 款（{external_dir}）")
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
        installed += 1 if write_target(source, item, external_dir) else 0
    shutil.rmtree(work, ignore_errors=True)
    copy_licenses(external_dir)
    print(f"完成：本次安装 {installed} 款（{external_dir}）")
    sys.exit(0)

print(f"未知模式：{mode}", file=sys.stderr)
sys.exit(2)
PY

echo "下一步：bash ${HERE}/selftest.sh（真实跑一遍选型 → 方案 → 烧录 → 复检）"
