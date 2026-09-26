#!/usr/bin/env python3
"""talkcraft-asr-words.py —— 配音 → 词级时间戳（我方实现，T-2026-0926-0008）

用途：给 `apps/server/src/video/explainer/aligner.ts` 提供"ASR 词表"输入，
由 TypeScript 侧完成与口播稿的逐字对齐（产出 vendor 同 schema 的 timestamps.json）。

两条后端：
  ① mlx-whisper（缺省，Apple Silicon 原生）：`mlx_whisper.transcribe(..., word_timestamps=True)`
     —— 中文 TTS 音频上词级误差约 20–140ms（与 vendor 文档的 faster-whisper 档位同量级）；
  ② engine-http（兜底）：向本机 mlx-audio 引擎 `/v1/audio/transcriptions` 要 verbose_json，
     只有句级时间戳——**精度降档会写进输出的 precision 字段**，由上层决定是否接受。

输出（stdout 与 --out 文件同内容）：
  {"backend":"mlx-whisper","model":"...","duration":12.34,"precision":"word","words":[{"text","start","end"}...],
   "segments":[{"start","end","text"}...]}

退出码：0 成功；2 用法错误；3 后端不可用（两条都不可用）；4 音频不可读。
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import urllib.request


def probe_duration(path: str) -> float:
    ffprobe = shutil.which("ffprobe") or os.path.expanduser("~/.local/bin/ffprobe")
    try:
        out = subprocess.run(
            [ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "json", path],
            capture_output=True, text=True, timeout=60, check=True,
        ).stdout
        return float(json.loads(out)["format"]["duration"])
    except Exception:
        return 0.0


def transcribe_mlx(audio: str, model: str, language: str) -> dict:
    import mlx_whisper  # 缺包 → ImportError，由调用方回退

    result = mlx_whisper.transcribe(
        audio,
        path_or_hf_repo=model,
        language=language or None,
        word_timestamps=True,
        condition_on_previous_text=False,
    )
    words = []
    segments = []
    for seg in result.get("segments", []):
        segments.append({
            "start": round(float(seg.get("start", 0.0)), 3),
            "end": round(float(seg.get("end", 0.0)), 3),
            "text": str(seg.get("text", "")).strip(),
        })
        for word in seg.get("words", []) or []:
            text = str(word.get("word", "")).strip()
            if not text:
                continue
            words.append({
                "text": text,
                "start": round(float(word.get("start", 0.0)), 3),
                "end": round(float(word.get("end", 0.0)), 3),
            })
    if not words:
        raise RuntimeError("mlx-whisper 未产出词级时间戳（word_timestamps 未生效）")
    return {"backend": "mlx-whisper", "model": model, "precision": "word", "words": words, "segments": segments}


def transcribe_engine_http(audio: str, engine_url: str, model: str, language: str) -> dict:
    """OpenAI 兼容 `/v1/audio/transcriptions`（mlx-audio server）。只有句级时间戳 → precision=segment。"""
    boundary = "----talkcraftasrboundary"
    with open(audio, "rb") as fh:
        payload = fh.read()
    parts = []

    def field(name, value):
        parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode())

    parts.append(
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"\r\n"
        f"Content-Type: audio/wav\r\n\r\n".encode() + payload + b"\r\n"
    )
    field("model", model)
    field("response_format", "verbose_json")
    if language:
        field("language", language)
    parts.append(f"--{boundary}--\r\n".encode())
    body = b"".join(parts)
    request = urllib.request.Request(
        f"{engine_url.rstrip('/')}/v1/audio/transcriptions",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=1800) as response:
        parsed = json.loads(response.read().decode("utf-8"))
    segments = []
    for seg in parsed.get("segments", []) or []:
        segments.append({
            "start": round(float(seg.get("start", 0.0)), 3),
            "end": round(float(seg.get("end", 0.0)), 3),
            "text": str(seg.get("text", "")).strip(),
        })
    if not segments:
        raise RuntimeError("引擎返回里没有 segments（无法降档到句级对齐）")
    # 句级 → "词"即整句（对齐器仍会按字展开，但时间精度退化为句内均匀分布）
    words = [{"text": s["text"], "start": s["start"], "end": s["end"]} for s in segments if s["text"]]
    return {"backend": "engine-http", "model": model, "precision": "segment", "words": words, "segments": segments}


def main() -> int:
    parser = argparse.ArgumentParser(description="配音 → 词级时间戳（mlx-whisper / 引擎 HTTP）")
    parser.add_argument("audio", help="配音 wav/mp3（与最终成片同一条）")
    parser.add_argument("out", help="输出 JSON 路径")
    parser.add_argument("--model", default=os.environ.get("TALKCRAFT_ASR_MODEL", "mlx-community/whisper-large-v3-turbo"))
    parser.add_argument("--language", default="zh")
    parser.add_argument("--hf-home", default=os.environ.get("HF_HOME", ""))
    parser.add_argument("--engine-url", default=os.environ.get("TALKCRAFT_ASR_ENGINE_URL", "http://127.0.0.1:8099"))
    parser.add_argument("--backend", choices=["auto", "mlx", "engine-http"], default="auto")
    args = parser.parse_args()

    if not os.path.exists(args.audio):
        print(f"音频不存在：{args.audio}", file=sys.stderr)
        return 4
    if args.hf_home:
        os.environ["HF_HOME"] = args.hf_home

    order = ["mlx", "engine-http"] if args.backend == "auto" else [args.backend]
    errors = []
    result = None
    for backend in order:
        try:
            if backend == "mlx":
                result = transcribe_mlx(args.audio, args.model, args.language)
            else:
                result = transcribe_engine_http(args.audio, args.engine_url, args.model, args.language)
            break
        except Exception as exc:  # noqa: BLE001 —— 逐后端降级，原因全部带出去（不静默）
            errors.append(f"{backend}: {type(exc).__name__}: {exc}")
    if result is None:
        print("所有 ASR 后端均失败：" + " | ".join(errors), file=sys.stderr)
        return 3

    result["duration"] = round(probe_duration(args.audio), 3)
    result["attempts"] = errors
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False, indent=1)
    print(json.dumps({k: v for k, v in result.items() if k != "words"}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
