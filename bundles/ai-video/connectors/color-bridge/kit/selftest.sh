#!/usr/bin/env bash
# 调色工位自检：引擎在位 → 滤镜齐备 → 真实跑一遍（诊断/调色/scope/前后对比）→ 输出可核验摘要
#
#   bash selftest.sh [输出目录]
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BRIDGE="$(cd "$HERE/.." && pwd)"
NODE_BIN="${NODE_BIN:-node}"
OUT="${1:-${WORKLOOM_COLOR_HOME:-$HOME/.workloom-color}/selftest}"
mkdir -p "$OUT"

echo "== 1/4 引擎在位 =="
export FFMPEG_PATH="${FFMPEG_PATH:-${WORKLOOM_COLOR_HOME:-$HOME/.workloom-color}/bin/ffmpeg}"
export FFPROBE_PATH="${FFPROBE_PATH:-${WORKLOOM_COLOR_HOME:-$HOME/.workloom-color}/bin/ffprobe}"
if [ ! -x "$FFMPEG_PATH" ]; then
  echo "✗ 未找到 ffmpeg：$FFMPEG_PATH（先跑 kit/install.sh）" >&2
  exit 3
fi
"$FFMPEG_PATH" -hide_banner -version | head -1

echo "== 2/4 滤镜齐备 =="
missing=()
for f in signalstats lut3d colorbalance colortemperature curves eq normalize waveform vectorscope histogram blend split; do
  "$FFMPEG_PATH" -hide_banner -filters 2>/dev/null | awk '{print $2}' | grep -qx "$f" || missing+=("$f")
done
if [ "${#missing[@]}" -gt 0 ]; then
  echo "✗ 缺少滤镜：${missing[*]}" >&2
  exit 3
fi
echo "✓ 12 个必需滤镜全部可用"

echo "== 3/4 真实处理（合成测试片段 → 诊断 → 调色 → scope）=="
export WORKLOOM_COLOR_ALLOWED_ROOTS="$OUT"
"$FFMPEG_PATH" -hide_banner -v error -y \
  -f lavfi -i "testsrc2=size=320x240:rate=15:duration=3" \
  -vf "eq=brightness=-0.12:saturation=0.6" \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p "$OUT/selftest-src.mp4"

"$NODE_BIN" "$BRIDGE/cli.mjs" analyze --in "$OUT/selftest-src.mp4" --at 1 --json > "$OUT/analyze.json"
"$NODE_BIN" "$BRIDGE/cli.mjs" grade --in "$OUT/selftest-src.mp4" --out "$OUT/selftest-graded.mp4" --auto --profile clean-bright --intensity 0.8 --json > "$OUT/grade.json"
"$NODE_BIN" "$BRIDGE/cli.mjs" scope --in "$OUT/selftest-src.mp4" --at 1 --out "$OUT/scopes" --json > "$OUT/scope.json"
"$NODE_BIN" "$BRIDGE/cli.mjs" compare --before "$OUT/selftest-src.mp4" --after "$OUT/selftest-graded.mp4" --at 1 --out "$OUT/compare.png" > "$OUT/compare.json"

echo "== 4/4 回执核验 =="
/usr/bin/python3 - "$OUT" <<'PY'
import hashlib, json, os, sys
out = sys.argv[1]
grade = json.load(open(os.path.join(out, "grade.json"), encoding="utf-8"))
scopes = json.load(open(os.path.join(out, "scope.json"), encoding="utf-8"))
graded = os.path.join(out, "selftest-graded.mp4")
actual = hashlib.sha256(open(graded, "rb").read()).hexdigest()
ok = actual == grade["sha256"] and len(scopes["outputs"]) == 3 and all(os.path.exists(o["path"]) for o in scopes["outputs"])
print(json.dumps({
  "ok": ok,
  "graded": graded,
  "sha256": actual,
  "receipt_sha256": grade["sha256"],
  "before": {k: round(v, 1) for k, v in grade["before"].items() if isinstance(v, (int, float))},
  "after": {k: round(v, 1) for k, v in grade["after"].items() if isinstance(v, (int, float))},
  "delta": grade["delta"],
  "scopes": [o["kind"] for o in scopes["outputs"]],
  "compare_frame": os.path.join(out, "compare.png"),
}, ensure_ascii=False, indent=2))
sys.exit(0 if ok else 4)
PY
echo "✓ 工位自检通过；产物在 $OUT"

