#!/usr/bin/env bash
# 小织声音工坊 · 图形界面背后的执行器（给不敲命令的人用）
#
#   bash kit/gui-voice.sh record  [--profile zh-myvoice] [--seconds 12] [--result <json>]
#   bash kit/gui-voice.sh speak   --text "要播报的文字"                 [--result <json>]
#   bash kit/gui-voice.sh dub     --video /path/film.mp4 --text "文案"  [--result <json>]
#   bash kit/gui-voice.sh --summary <json>          # 把结果 JSON 变成一句人话（给对话框用）
#   bash kit/gui-voice.sh doctor                    # 自检：node/ffmpeg/引擎/麦克风
#
# 设计口径：
# - 每一步都如实报错：没检测到人声、引擎不可达、超时，都写成人话给对话框，不假装成功；
# - 引擎没起就自动起（launchd 常驻），用户不需要知道"服务"是什么；
# - 参考音频与声纹只落本机 ~/.workloom/voice-station；
# - 结果统一写一份 JSON（App 用 --summary 读它），日志落 logs/gui-*.log 便于复盘。
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BRIDGE="$(cd "$HERE/.." && pwd)"
STATION="${WORKLOOM_VOICE_STATION_DIR:-$HOME/.workloom/voice-station}"
PROFILE="${WORKLOOM_VOICE_DEFAULT_PROFILE:-zh-myvoice}"
RESULT_FILE=""
MODE=""
SECONDS_TO_RECORD=12
TEXT=""
VIDEO=""

while [ $# -gt 0 ]; do
  case "$1" in
    record|speak|dub|doctor) MODE="$1"; shift ;;
    --summary) MODE="summary"; RESULT_FILE="${2:?--summary 需要文件}"; shift 2 ;;
    --result) RESULT_FILE="${2:?--result 需要文件}"; shift 2 ;;
    --profile) PROFILE="${2:?}"; shift 2 ;;
    --seconds) SECONDS_TO_RECORD="${2:?}"; shift 2 ;;
    --text) TEXT="${2-}"; shift 2 ;;
    --video) VIDEO="${2:?}"; shift 2 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

[ -n "$MODE" ] || { sed -n '2,13p' "$0"; exit 2; }

find_node() {
  for candidate in "${WORKLOOM_VOICE_NODE:-}" "$(command -v node 2>/dev/null || true)" \
      "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" \
      /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -n "$candidate" ] && [ -x "$candidate" ] && { printf '%s' "$candidate"; return 0; }
  done
  return 1
}
NODE="$(find_node || true)"
NODE_DIR=""; [ -n "$NODE" ] && NODE_DIR="$(dirname "$NODE")"
export PATH="$STATION/bin:$NODE_DIR:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export WORKLOOM_VOICE_STATION_DIR="$STATION"
export WORKLOOM_VOICE_ENGINE="${WORKLOOM_VOICE_ENGINE:-mlx}"
export WORKLOOM_VOICE_ENGINE_URL="${WORKLOOM_VOICE_ENGINE_URL:-http://127.0.0.1:8099}"
export WORKLOOM_VOICE_ALLOWED_ROOTS="${WORKLOOM_VOICE_ALLOWED_ROOTS:-$HOME/Movies:$HOME/Desktop:$HOME/Downloads:$HOME/Documents}"
mkdir -p "$STATION/logs"
LOG="$STATION/logs/gui-$(date +%Y%m%d-%H%M%S).log"

log() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$LOG" >&2; }

json_pick() { # json_pick <file> <dotted.path>
  python3 - "$1" "$2" <<'PY'
import json, sys
path, dotted = sys.argv[1], sys.argv[2]
try:
    node = json.load(open(path))
except Exception:
    print("")
    raise SystemExit(0)
for part in dotted.split("."):
    node = node.get(part) if isinstance(node, dict) else None
print("" if node is None else node)
PY
}

write_result() { # write_result <status> <message> [key value]...
  local status="$1" message="$2"; shift 2
  [ -n "$RESULT_FILE" ] || return 0
  python3 - "$RESULT_FILE" "$status" "$message" "$@" <<'PY'
import json, sys
path, status, message = sys.argv[1], sys.argv[2], sys.argv[3]
pairs = sys.argv[4:]
payload = {"status": status, "message": message}
payload.update(dict(zip(pairs[0::2], pairs[1::2])))
json.dump(payload, open(path, "w"), ensure_ascii=False, indent=2)
PY
}

summary() {
  [ -n "${1:-}" ] || { echo "任务没有留下结果文件。"; return 0; }
  python3 - "$1" <<'PY'
import json, sys
try:
    payload = json.load(open(sys.argv[1]))
except Exception as error:
    print("任务没有留下可读的结果文件（%s）。" % error)
    raise SystemExit(0)
status = payload.get("status")
message = payload.get("message", "")
if status != "ok":
    print("✗ %s\n\n想重试的话，再双击一次这个应用就行。" % message)
    raise SystemExit(0)
lines = ["✓ %s" % message, ""]
if payload.get("transcript"):
    lines.append("识别到的逐字稿：%s" % payload["transcript"])
if payload.get("duration_sec"):
    lines.append("成品时长：%s 秒" % payload["duration_sec"])
if payload.get("lufs"):
    lines.append("响度：%s LUFS" % payload["lufs"])
if payload.get("drift_sec") is not None:
    lines.append("与原片时长差：%s 秒" % payload["drift_sec"])
if payload.get("reference"):
    lines.append("")
    lines.append("你的声音样本：%s" % payload["reference"])
if payload.get("output"):
    lines.append("成品文件：%s" % payload["output"])
lines.append("")
lines.append("刚才已经播放给你听了。" if status == "ok" else "")
print("\n".join([line for line in lines if line is not None]))
PY
}

engine_up() { curl -fsS -m 3 "$WORKLOOM_VOICE_ENGINE_URL/v1/models" >/dev/null 2>&1; }
ensure_engine() {
  engine_up && return 0
  log "引擎未就绪，自动启动…"
  bash "$HERE/station.sh" start >>"$LOG" 2>&1 || true
  engine_up
}
cli() { "$NODE" "$BRIDGE/cli.mjs" "$@"; }

if [ "$MODE" = "doctor" ]; then
  printf 'node:   %s\n' "${NODE:-未找到}"
  printf 'ffmpeg: %s\n' "$(command -v ffmpeg || echo 未找到)"
  printf '引擎:   %s\n' "$(engine_up && echo 就绪 || echo 未就绪)"
  printf '工位:   %s\n' "$STATION"
  printf '档案:   %s\n' "$(ls "$STATION/profiles" 2>/dev/null | tr '\n' ' ')"
  exit 0
fi
if [ "$MODE" = "summary" ]; then summary "$RESULT_FILE"; exit 0; fi

if [ -z "$NODE" ]; then
  write_result failed "没找到 node 运行时，无法启动配音工位（日志：${LOG}）"
  summary "$RESULT_FILE"; exit 1
fi

if [ "$MODE" = "record" ]; then
  log "mode=record profile=$PROFILE seconds=$SECONDS_TO_RECORD"
  ensure_engine || { write_result failed "语音引擎没起来（${WORKLOOM_VOICE_ENGINE_URL}）。日志：$LOG"; summary "$RESULT_FILE"; exit 1; }
  CAPTURE="$STATION/captures/gui-$(date +%s).wav"
  log "开始录音 → $CAPTURE"
  RECORDED="$(cli record --out "$CAPTURE" --seconds "$SECONDS_TO_RECORD" 2>>"$LOG")"
  if [ -z "$RECORDED" ]; then
    write_result failed "录音没成功：麦克风可能被别的程序占用，或系统还没给麦克风权限（日志：${LOG}）"
    summary "$RESULT_FILE"; exit 1
  fi
  printf '%s' "$RECORDED" > "$STATION/logs/last-record.json"
  REFERENCE="$(json_pick "$STATION/logs/last-record.json" result.reference)"
  GATE_OK="$(json_pick "$STATION/logs/last-record.json" result.gate.ok)"
  GATE_WHY="$(json_pick "$STATION/logs/last-record.json" result.gate.reasons.0)"
  if [ "$GATE_OK" != "True" ]; then
    write_result retry "录到的这段没通过质量检查（${GATE_WHY:-没有检测到说话声}）。请靠近麦克风、用正常语速再念一次，周围尽量安静。"
    summary "$RESULT_FILE"; exit 0
  fi
  [ -n "$REFERENCE" ] || REFERENCE="$CAPTURE"
  log "建档 + 转写 → profile=$PROFILE"
  if [ ! -f "$STATION/profiles/$PROFILE/consent.json" ]; then
    cli consent --profile "$PROFILE" --speaker self --scope internal \
      --by "本机用户（应用内确认）" --evidence "小织声音工坊：用户在应用里点击『开始录音』即确认使用本人声音" >>"$LOG" 2>&1 || true
  fi
  REGISTERED="$(cli register --profile "$PROFILE" --ref "$REFERENCE" --speaker-label "我的声音" 2>>"$LOG")"
  if [ -z "$REGISTERED" ]; then
    write_result failed "建档失败：参考音频或逐字稿有问题（日志：${LOG}）"
    summary "$RESULT_FILE"; exit 1
  fi
  printf '%s' "$REGISTERED" > "$STATION/logs/last-register.json"
  TRANSCRIPT="$(json_pick "$STATION/logs/last-register.json" result.ref_text)"
  log "合成试听…"
  DEMO="$STATION/deliveries/$PROFILE-试听.wav"
  SPOKEN="$(cli speak --profile "$PROFILE" \
    --text "您好，我是小织。这条声音是用您刚才的录音克隆出来的，接下来我会用它为您播报经营日报。" \
    --out "$DEMO" 2>>"$LOG")"
  if [ -z "$SPOKEN" ]; then
    write_result failed "声音档案建好了，但试听合成失败（日志：${LOG}）" profile "$PROFILE" reference "$REFERENCE"
    summary "$RESULT_FILE"; exit 1
  fi
  printf '%s' "$SPOKEN" > "$STATION/logs/last-speak.json"
  afplay "$DEMO" >>"$LOG" 2>&1 || true
  write_result ok "声音克隆完成，专属音色已建好（档案名：${PROFILE}）" \
    profile "$PROFILE" reference "$REFERENCE" output "$DEMO" transcript "$TRANSCRIPT" \
    duration_sec "$(json_pick "$STATION/logs/last-speak.json" result.duration_sec)" \
    lufs "$(json_pick "$STATION/logs/last-speak.json" result.lufs)"
  summary "$RESULT_FILE"; exit 0
fi

if [ "$MODE" = "speak" ]; then
  [ -n "$TEXT" ] || { write_result failed "没有文字可播报"; summary "$RESULT_FILE"; exit 1; }
  ensure_engine || { write_result failed "语音引擎没起来（${WORKLOOM_VOICE_ENGINE_URL}）。日志：$LOG"; summary "$RESULT_FILE"; exit 1; }
  if [ ! -f "$STATION/profiles/$PROFILE/profile.json" ]; then
    write_result failed "还没有你的音色档案。请先选『克隆我的声音』录一次（约 12 秒）。"
    summary "$RESULT_FILE"; exit 0
  fi
  OUT="$STATION/deliveries/播报-$(date +%H%M%S).wav"
  log "mode=speak profile=$PROFILE"
  SPOKEN="$(cli speak --profile "$PROFILE" --text "$TEXT" --out "$OUT" 2>>"$LOG")"
  if [ -z "$SPOKEN" ]; then
    write_result failed "合成失败（日志：${LOG}）"; summary "$RESULT_FILE"; exit 1
  fi
  printf '%s' "$SPOKEN" > "$STATION/logs/last-speak.json"
  afplay "$OUT" >>"$LOG" 2>&1 || true
  write_result ok "播报已生成并播放" output "$OUT" \
    duration_sec "$(json_pick "$STATION/logs/last-speak.json" result.duration_sec)" \
    lufs "$(json_pick "$STATION/logs/last-speak.json" result.lufs)"
  summary "$RESULT_FILE"; exit 0
fi

if [ "$MODE" = "dub" ]; then
  [ -n "$VIDEO" ] && [ -f "$VIDEO" ] || { write_result failed "没选到视频文件"; summary "$RESULT_FILE"; exit 1; }
  [ -n "$TEXT" ] || { write_result failed "没有配音文案"; summary "$RESULT_FILE"; exit 1; }
  ensure_engine || { write_result failed "语音引擎没起来（${WORKLOOM_VOICE_ENGINE_URL}）。日志：$LOG"; summary "$RESULT_FILE"; exit 1; }
  if [ ! -f "$STATION/profiles/$PROFILE/profile.json" ]; then
    write_result failed "还没有你的音色档案。请先选『克隆我的声音』录一次（约 12 秒）。"
    summary "$RESULT_FILE"; exit 0
  fi
  BASE="$(basename "${VIDEO%.*}")"
  OUT="$HOME/Movies/${BASE}-配音.mp4"
  log "mode=dub video=$VIDEO out=$OUT"
  DUBBED="$(cli dub --in "$VIDEO" --out "$OUT" --profile "$PROFILE" --text "$TEXT" --policy keep-dialogue --lufs -14 2>>"$LOG")"
  if [ -z "$DUBBED" ]; then
    write_result failed "配音失败：可能是文案放不进画面对应的时间段，或视频没有音轨（日志：${LOG}）"
    summary "$RESULT_FILE"; exit 1
  fi
  printf '%s' "$DUBBED" > "$STATION/logs/last-dub.json"
  open -R "$OUT" >>"$LOG" 2>&1 || true
  write_result ok "配音完成，已在访达里为你选中成片" output "$OUT" \
    drift_sec "$(json_pick "$STATION/logs/last-dub.json" result.drift_sec)" \
    lufs "$(json_pick "$STATION/logs/last-dub.json" result.lufs)"
  summary "$RESULT_FILE"; exit 0
fi

write_result failed "未知动作：$MODE"; summary "$RESULT_FILE"; exit 2
