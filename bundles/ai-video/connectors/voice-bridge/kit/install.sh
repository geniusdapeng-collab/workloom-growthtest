#!/usr/bin/env bash
# 配音工位一次性安装（macOS Apple Silicon）：本机引擎 sidecar + 模型 + 目录骨架。
#
#   bash kit/install.sh [--station <dir>] [--skip-models]
#
# 只做四件事：建目录 → 建 venv（uv）→ 装 mlx-audio（MIT）→ 下模型；不碰系统 Python、不装驱动、不写系统目录。
# 幂等：重复执行只补齐缺失部分。所有下载都可用 HTTPS_PROXY 走本机代理。
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
# kit/ → voice-bridge/ → connectors/ → ai-video/ → bundles/ → 仓库根
REPO_ROOT="$(cd "$HERE/../../../../.." && pwd)"
STATION="${WORKLOOM_VOICE_STATION_DIR:-$HOME/.workloom/voice-station}"
VPY="${WORKLOOM_VOICE_PYTHON:-python3.12}"
TTS_MODEL="${WORKLOOM_VOICE_TTS_MODEL:-mlx-community/OmniVoice-bf16}"
ASR_MODEL="${WORKLOOM_VOICE_ASR_MODEL:-mlx-community/whisper-large-v3-turbo}"

while [ $# -gt 0 ]; do
  case "$1" in
    --station) STATION="$2"; shift ;;
    --skip-models) SKIP_MODELS=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
  shift
done

log() { printf '[voice-station] %s\n' "$*"; }

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  log "✗ 本安装脚本面向 macOS Apple Silicon（当前：$(uname -s)/$(uname -m)）"
  log "  其他平台请把 WORKLOOM_VOICE_ENGINE 指向 OpenAI 兼容端点（VoiceStudio / GPT-SoVITS 等）"
  exit 2
fi

command -v uv >/dev/null 2>&1 || {
  log "✗ 缺少 uv（本工位用 uv 管 Python 环境）：curl -LsSf https://astral.sh/uv/install.sh | sh"
  exit 2
}
command -v ffmpeg >/dev/null 2>&1 || {
  log "✗ 缺少 ffmpeg（录音/裁剪/混音内核）：brew install ffmpeg 或把静态构建放进 ~/.local/bin"
  exit 2
}

log "station=$STATION"
mkdir -p "$STATION"/{bin,models,captures,deliveries,profiles,jobs,logs}

if [ ! -x "$STATION/bin/python" ]; then
  log "创建 venv（${VPY}）"
  uv venv --python "$VPY" "$STATION/venv"
  ln -sf "$STATION/venv/bin/python" "$STATION/bin/python"
fi

# 装 [server] extra：工位以常驻 HTTP sidecar 形态提供 /v1/audio/speech 与 /v1/audio/transcriptions，
# 缺 uvicorn/fastapi 时 mlx_audio.server 起不来（实测报 ModuleNotFoundError: uvicorn）。
log "安装 mlx-audio[server]（MIT，Apple Silicon 原生）"
UV_LINK_MODE="${UV_LINK_MODE:-clone}" uv pip install --python "$STATION/venv/bin/python" \
  "mlx-audio[server]>=0.5.5" soundfile

if [ "${SKIP_MODELS:-0}" != "1" ]; then
  log "下载模型（首次约 3.3GB；可用 HTTPS_PROXY 走代理）"
  HF_HOME="$STATION/models" "$STATION/venv/bin/python" - "$TTS_MODEL" "$ASR_MODEL" <<'PY'
import os, sys
from huggingface_hub import snapshot_download

for model in sys.argv[1:]:
    print(f"[voice-station] snapshot {model}", flush=True)
    path = snapshot_download(model)
    print(f"[voice-station] ok {model} → {path}", flush=True)
PY

  # ASR 处理器补齐：mlx-community 的 Whisper 权重仓只有 config.json + weights，
  # 而 mlx_audio 的 Whisper 实现要求 WhisperProcessor（tokenizer/preprocessor）——
  # 缺它时 /v1/audio/transcriptions 直接 500（实测报 "Processor not found"）。
  # 这里从原始 openai 仓补 8 个处理器文件（约 4MB），让参考音频转写与可懂度回读可用。
  log "补齐 ASR 处理器文件（tokenizer/preprocessor，约 4MB）"
  HF_HOME="$STATION/models" "$STATION/venv/bin/python" - "$ASR_MODEL" <<'PY'
import os, shutil, sys
from huggingface_hub import snapshot_download

def find_snapshot(root: str, repo: str) -> str | None:
    model_dir = os.path.join(root, "hub", "models--" + repo.replace("/", "--"))
    snapshots = os.path.join(model_dir, "snapshots")
    if not os.path.isdir(snapshots):
        return None
    entries = sorted(os.listdir(snapshots))
    return os.path.join(snapshots, entries[-1]) if entries else None

asr_repo = sys.argv[1]
root = os.environ["HF_HOME"]
target = find_snapshot(root, asr_repo)
if target is None:
    print(f"[voice-station] ✗ 找不到 {asr_repo} 的快照目录，跳过处理器补齐", flush=True)
    raise SystemExit(0)

processor_files = [
    "preprocessor_config.json", "tokenizer.json", "tokenizer_config.json",
    "special_tokens_map.json", "vocab.json", "merges.txt", "normalizer.json", "added_tokens.json",
]
if all(os.path.exists(os.path.join(target, name)) for name in processor_files):
    print("[voice-station] 处理器文件已在位，跳过", flush=True)
    raise SystemExit(0)
if "/" not in asr_repo:
    print("[voice-station] 本地模型路径，跳过处理器补齐", flush=True)
    raise SystemExit(0)

source = snapshot_download("openai/" + asr_repo.split("/", 1)[1], allow_patterns=processor_files)
copied = []
for name in processor_files:
    src = os.path.join(source, name)
    if os.path.exists(src):
        shutil.copy2(src, os.path.join(target, name))
        copied.append(name)
print(f"[voice-station] 处理器补齐完成：{len(copied)} 个文件 → {target}", flush=True)
PY
fi

"$STATION/venv/bin/python" - <<'PY'
import mlx.core, mlx_audio  # noqa: F401
print("[voice-station] mlx + mlx_audio 导入成功")
PY

cat > "$STATION/station.json" <<JSON
{
  "schema": "workloom.voice-station/v1",
  "installed_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "station_dir": "$STATION",
  "host": "127.0.0.1",
  "port": ${WORKLOOM_VOICE_BRIDGE_PORT:-9776},
  "engine_port": ${WORKLOOM_VOICE_ENGINE_PORT:-8099},
  "engine": "mlx",
  "engine_url": "http://127.0.0.1:${WORKLOOM_VOICE_ENGINE_PORT:-8099}",
  "tts_model": "$TTS_MODEL",
  "asr_model": "$ASR_MODEL",
  "hf_home": "$STATION/models",
  "pin_file": "bundles/ai-video/connectors/voice-bridge/kit/engine-pin.json"
}
JSON

log "✓ 完成。下一步："
log "  1) 起引擎：bash $REPO_ROOT/bundles/ai-video/connectors/voice-bridge/kit/station.sh start"
log "  2) 自检：  bash $REPO_ROOT/bundles/ai-video/connectors/voice-bridge/kit/selftest.sh"
log "  配置：export WORKLOOM_VOICE_STATION_DIR=$STATION WORKLOOM_VOICE_ENGINE=mlx WORKLOOM_VOICE_ENGINE_URL=http://127.0.0.1:${WORKLOOM_VOICE_ENGINE_PORT:-8099}"
