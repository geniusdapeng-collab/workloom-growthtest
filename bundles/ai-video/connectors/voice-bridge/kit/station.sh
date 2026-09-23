#!/usr/bin/env bash
# 本机引擎 sidecar 的起停（mlx-audio server，默认 127.0.0.1:8099）。
#
#   bash kit/station.sh start|stop|status|logs|fg
#
# 为什么单独一个常驻进程：模型加载一次约 40s（M3 实测），常驻后单次合成立刻开工；
# 8GB 统一内存机器上，绝不要在播报期间再并行拉起第二个引擎进程（见 docs 的实测口径）。
#
# 常驻方式：macOS 用 LaunchAgent 托管（launchd），而不是 nohup —— nohup 起的进程会随
# 终端/父进程退出被回收（实测：会话结束后引擎消失，播报直接 network_error）。
# `fg` 用于排障：前台起服务，Ctrl-C 结束。
set -eu

STATION="${WORKLOOM_VOICE_STATION_DIR:-$HOME/.workloom/voice-station}"
PORT="${WORKLOOM_VOICE_ENGINE_PORT:-8099}"
HOST="${WORKLOOM_VOICE_ENGINE_HOST:-127.0.0.1}"
LOG_FILE="$STATION/logs/engine.log"
PY="$STATION/venv/bin/python"
LABEL="cool.workloom.voice-station.engine"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

usage() { sed -n '2,12p' "$0"; exit 2; }

write_plist() {
  mkdir -p "$STATION/logs" "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PY</string>
    <string>-m</string>
    <string>mlx_audio.server</string>
    <string>--host</string>
    <string>$HOST</string>
    <string>--port</string>
    <string>$PORT</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HF_HOME</key><string>$STATION/models</string>
  </dict>
  <key>WorkingDirectory</key><string>$STATION</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>StandardOutPath</key><string>$LOG_FILE</string>
  <key>StandardErrorPath</key><string>$LOG_FILE</string>
</dict>
</plist>
PLIST_EOF
}

wait_ready() {
  for _ in $(seq 1 90); do
    if curl -fsS "http://$HOST:$PORT/v1/models" >/dev/null 2>&1; then
      echo "[voice-station] ✓ 引擎就绪 http://${HOST}:${PORT}（launchd: ${LABEL}）"
      return 0
    fi
    sleep 1
  done
  echo "[voice-station] ✗ 90s 内未见引擎就绪，看日志：$LOG_FILE" >&2
  return 1
}

start() {
  [ -x "$PY" ] || { echo "[voice-station] ✗ 未安装：先跑 bash kit/install.sh" >&2; exit 2; }
  if curl -fsS "http://$HOST:$PORT/v1/models" >/dev/null 2>&1; then
    echo "[voice-station] 引擎已在运行 http://${HOST}:${PORT}"
    return 0
  fi
  write_plist
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    launchctl kickstart -k "$DOMAIN/$LABEL"
  else
    launchctl bootstrap "$DOMAIN" "$PLIST"
  fi
  wait_ready
}

stop() {
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || launchctl bootout "$DOMAIN" "$PLIST" 2>/dev/null || true
    echo "[voice-station] 已停止（launchd: ${LABEL}）"
  else
    echo "[voice-station] 未在运行"
  fi
}

status() {
  if curl -fsS "http://$HOST:$PORT/v1/models" >/dev/null 2>&1; then
    echo "[voice-station] ✓ 引擎可达 http://${HOST}:${PORT}"
    curl -fsS "http://$HOST:$PORT/v1/models" | head -c 400; echo
  else
    echo "[voice-station] ✗ 引擎不可达 http://${HOST}:${PORT}"
    launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 && echo "  launchd 任务已加载但端口不通，看日志：$LOG_FILE"
    return 1
  fi
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  logs) tail -n 80 "$LOG_FILE" ;;
  fg)
    [ -x "$PY" ] || { echo "[voice-station] ✗ 未安装：先跑 bash kit/install.sh" >&2; exit 2; }
    HF_HOME="$STATION/models" exec "$PY" -m mlx_audio.server --host "$HOST" --port "$PORT"
    ;;
  *) usage ;;
esac
