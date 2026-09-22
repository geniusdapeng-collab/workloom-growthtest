#!/usr/bin/env bash
# 配音工位真机自检：健康 → 麦克风 → 录音（质量门）→ 建音色档案 → 播报 → 核验。
#
#   bash kit/selftest.sh [--profile <id>] [--seconds 12] [--ref <已有参考音频>] [--ref-text "<逐字稿>"]
#
# 默认走本机麦克风（真机验收口径）；已有参考音频时用 --ref 跳过录音环节。
# 任何一步不达标都如实报错退出（不伪造 via mock）。
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
BRIDGE="$(cd "$HERE/.." && pwd)"
STATION="${WORKLOOM_VOICE_STATION_DIR:-$HOME/.workloom/voice-station}"
PROFILE="${WORKLOOM_VOICE_SELFTEST_PROFILE:-zh-selftest}"
SECONDS_CAP=12
REF=""
REF_TEXT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="$2"; shift ;;
    --seconds) SECONDS_CAP="$2"; shift ;;
    --ref) REF="$2"; shift ;;
    --ref-text) REF_TEXT="$2"; shift ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
  shift
done

export WORKLOOM_VOICE_STATION_DIR="$STATION"
CLI=(node "$BRIDGE/cli.mjs")

echo "=== 1/6 工位健康 ==="
"${CLI[@]}" health

echo
echo "=== 2/6 麦克风设备 ==="
"${CLI[@]}" devices

if [ -z "$REF" ]; then
  echo
  echo "=== 3/6 麦克风录音（${SECONDS_CAP}s，请在麦克风前用自然语速念一段中文） ==="
  RECORDED=$("${CLI[@]}" record --out "$STATION/captures/selftest-$(date +%s).wav" --seconds "$SECONDS_CAP")
  echo "$RECORDED"
  REF=$(printf '%s' "$RECORDED" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log((j.result&&(j.result.reference||j.result.prepared?.path))||"")})')
  # 录音质量门不达标时，register 会在下一步以 bad_reference 明确拒绝（保留证据，不静默降级）
  if [ -z "$REF_TEXT" ]; then
    echo "提示：未提供 --ref-text，将由引擎 ASR 自动转写（需要引擎已起）"
  fi
else
  echo
  echo "=== 3/6 跳过录音（使用已有参考音频：${REF}） ==="
fi

echo
echo "=== 4/6 注册音色档案 ==="
"${CLI[@]}" consent --profile "$PROFILE" --speaker self --scope internal --by "selftest" --evidence "kit/selftest.sh 自检"
if [ -n "$REF_TEXT" ]; then
  "${CLI[@]}" register --profile "$PROFILE" --ref "$REF" --ref-text "$REF_TEXT"
else
  "${CLI[@]}" register --profile "$PROFILE" --ref "$REF"
fi

echo
echo "=== 5/6 播报合成 ==="
"${CLI[@]}" speak \
  --profile "$PROFILE" \
  --text "你好，我是 WorkLoom 的数字员工小织。今天是自检：录音、克隆、播报三条链路全部打通，产物已附哈希与响度回执。" \
  --out "$STATION/deliveries/selftest-speak.wav"

echo
echo "=== 6/6 产物核验 ==="
"${CLI[@]}" verify \
  --in "$STATION/deliveries/selftest-speak.wav" \
  --expect-text "你好，我是 WorkLoom 的数字员工小织。今天是自检：录音、克隆、播报三条链路全部打通，产物已附哈希与响度回执。"

echo
echo "✓ 自检完成（产物：$STATION/deliveries/selftest-speak.wav）"
