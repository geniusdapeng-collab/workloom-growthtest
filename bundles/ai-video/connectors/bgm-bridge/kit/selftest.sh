#!/usr/bin/env bash
# 配乐工位自检：引擎在位 → 滤镜齐备 → 真实造一条片子 → 诊断 → 作曲 → 混音 → 复检指标
#
#   bash selftest.sh [输出目录]      # 默认 $TMPDIR/workloom-bgm-selftest-<时间戳>
#
# 退出码：0 全绿；1 有指标不达标（脚本会打印失败项）。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BRIDGE="$(cd "${HERE}/.." && pwd)"
OUT="${1:-${TMPDIR:-/tmp}/workloom-bgm-selftest-$(date +%s)}"
BIN_DIR="${WORKLOOM_BGM_HOME:-${HOME}/.workloom-bgm}/bin"
NODE_BIN="${NODE_BIN:-node}"

if [ -x "${BIN_DIR}/ffmpeg" ]; then
  export WORKLOOM_BGM_FFMPEG_PATH="${BIN_DIR}/ffmpeg"
  export WORKLOOM_BGM_FFPROBE_PATH="${BIN_DIR}/ffprobe"
fi
export WORKLOOM_BGM_ALLOWED_ROOTS="${OUT}:${TMPDIR:-/tmp}"

echo "① 引擎自检"
bash "${HERE}/install.sh" --check

echo "② 端到端演示（自造素材 → 配乐 → 复检）"
"${NODE_BIN}" "${BRIDGE}/demo-artifacts.mjs" --out "${OUT}" --recipe food

echo "③ 指标核验"
/usr/bin/python3 - "${OUT}/bgm-report.json" <<'PY'
import json, sys
report = json.load(open(sys.argv[1], encoding="utf-8"))
mix = report["mixReport"]
checks = mix["checks"]
targets = {
    "响度": abs(mix["loudness"]["after"]["integratedLufs"] + 14) <= 1.5,
    "真峰值": mix["loudness"]["after"]["truePeakDbtp"] <= -0.8,
    "配乐可闻": mix["levels"]["musicPresenceDb"] >= 3,
    "人声余量": mix["levels"]["speechToMusicMarginDb"] >= 6,
    "让位生效": mix["levels"]["duckingDepthDb"] <= -4,
}
failed = [name for name, ok in targets.items() if not ok]
for name, ok in targets.items():
    print(f"  {'✓' if ok else '✗'} {name}")
print(f"  让位深度 {mix['levels']['duckingDepthDb']}dB · 人声余量 {mix['levels']['speechToMusicMarginDb']}dB · 卡点 {mix['alignment']['verdict']}")
if failed or not all(checks.values()):
    print(f"✗ 自检未通过：{', '.join(failed) if failed else 'checks 未全绿'}")
    sys.exit(1)
print("✓ 自检通过")
PY
echo "产物目录：${OUT}"
