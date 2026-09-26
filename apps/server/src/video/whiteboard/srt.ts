/**
 * video/whiteboard/srt.ts —— SRT 解析 / 生成 / 分幕（T-2026-0926-0020）
 *
 * 与上游 `vendor/srt-whiteboard/scripts/parse_srt.py` 的分幕算法**逐行同构**
 * （累积到 target 附近断幕；不小于 min；超过 max 强制断幕），
 * 差别只是跑在 Node 里，省掉一次进程往返。同构性由单测保证：
 * `whiteboard.test.ts` 用同一份 SRT 跑两边并比对 scenes（证据见 docs/whiteboard-engine.md）。
 *
 * 为什么不用 LLM 分幕：分幕必须是**确定性**的——同一份配音不能这次 4 幕、下次 5 幕，
 * 否则"断点续跑"和"只重渲一幕"都失去意义。
 */

export interface SrtCue {
  index: number;
  startMs: number;
  endMs: number;
  durMs: number;
  text: string;
}

export interface SceneGroup {
  sceneIndex: number;
  startMs: number;
  endMs: number;
  sceneDurationMs: number;
  cueRange: [number, number];
  text: string;
}

const TIME_RE = /(\d+):(\d{2}):(\d{2})[,.](\d{1,3})/g;

function toMs(h: string, m: string, s: string, ms: string): number {
  return ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(ms.padEnd(3, "0"));
}

/** 解析 SRT（容忍 BOM、CRLF、多余空行、逗号/点毫秒分隔符）——与上游 parse_srt.parse_srt 同口径 */
export function parseSrt(text: string): SrtCue[] {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const cues: SrtCue[] = [];
  for (const block of normalized.trim().split(/\n\s*\n/)) {
    const lines = block.split("\n").filter((line) => line.trim() !== "");
    if (lines.length === 0) continue;
    const timeLineIdx = lines.findIndex((line) => line.includes("-->"));
    if (timeLineIdx < 0) continue;
    const times = [...lines[timeLineIdx]!.matchAll(TIME_RE)];
    if (times.length < 2) continue;
    const start = toMs(...(times[0]!.slice(1, 5) as [string, string, string, string]));
    const end = toMs(...(times[1]!.slice(1, 5) as [string, string, string, string]));
    cues.push({
      index: cues.length + 1,
      startMs: start,
      endMs: end,
      durMs: Math.max(0, end - start),
      text: lines.slice(timeLineIdx + 1).join(" ").trim(),
    });
  }
  return cues;
}

export interface GroupOptions {
  targetSec?: number;
  minSec?: number;
  maxSec?: number;
}

/** 分幕（与上游 group_scenes 同构） */
export function groupScenes(cues: SrtCue[], opts: GroupOptions = {}): SceneGroup[] {
  const targetMs = (opts.targetSec ?? 30) * 1000;
  const minMs = (opts.minSec ?? 25) * 1000;
  const maxMs = (opts.maxSec ?? 35) * 1000;
  const scenes: SceneGroup[] = [];
  let bucket: SrtCue[] = [];
  const flush = () => {
    if (bucket.length === 0) return;
    const start = bucket[0]!.startMs;
    const end = bucket[bucket.length - 1]!.endMs;
    scenes.push({
      sceneIndex: scenes.length + 1,
      startMs: start,
      endMs: end,
      sceneDurationMs: Math.max(0, end - start),
      cueRange: [bucket[0]!.index, bucket[bucket.length - 1]!.index],
      text: bucket.map((cue) => cue.text).join(" ").trim(),
    });
    bucket = [];
  };
  for (const cue of cues) {
    if (bucket.length > 0) {
      const spanWith = cue.endMs - bucket[0]!.startMs;
      if (spanWith > maxMs) flush();
    }
    bucket.push(cue);
    const span = bucket[bucket.length - 1]!.endMs - bucket[0]!.startMs;
    if (span >= targetMs && span >= minMs) flush();
  }
  flush();
  return scenes;
}

/** `HH:MM:SS,mmm`（SRT 时间戳口径） */
export function srtTime(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const hh = String(Math.floor(clamped / 3600)).padStart(2, "0");
  const mm = String(Math.floor((clamped % 3600) / 60)).padStart(2, "0");
  const ss = String(Math.floor(clamped % 60)).padStart(2, "0");
  const ms = String(Math.round((clamped % 1) * 1000)).padStart(3, "0");
  return `${hh}:${mm}:${ss},${ms}`;
}

/**
 * 生成 SRT。
 *
 * 与 `scripts/tools/full-chain-film.mts#buildSrt` 的差别：那边按镜头切点排时间轴，
 * 这边按**配音逐句的真实时长**排（白板片的时间轴就是配音时间轴——幕长、元素时序
 * 全部由它派生，所以这里是全链路的时间唯一权威）。
 */
export function buildSrt(cues: SrtCue[]): string {
  const lines: string[] = [];
  cues.forEach((cue, i) => {
    lines.push(String(i + 1), `${srtTime(cue.startMs / 1000)} --> ${srtTime(cue.endMs / 1000)}`, cue.text, "");
  });
  return lines.join("\n");
}

/** 单幕字幕段（写进 whiteboard_scenes.subtitle_srt，供审阅与返修） */
export function buildSceneSrt(cues: SrtCue[]): string {
  return buildSrt(cues);
}

/**
 * 幕级时间轴"铺满"（视频与配音严格对齐的关键一步）。
 *
 * 问题：口播句之间有空隙，若幕长 = 首句起 → 末句止，则整片视频时长短于配音，
 * 混流后画面会提前结束（真机表现为"最后一幕被截掉半句"）。
 * 解法：把每一幕的结束时间推到**下一幕首句开始**，最后一幕推到音频总时长——
 * 于是 Σ 幕长 == 音频总长，混流时不需要任何补偿。
 *
 * 注意：字幕（`cues`）仍保留**逐句真实发声区间**，不跟着拉长；
 * 只有幕长（渲染时长）用铺满后的值。
 */
export function tileScenes(scenes: SceneGroup[], totalMs: number): SceneGroup[] {
  return scenes.map((scene, i) => {
    const next = scenes[i + 1];
    const endMs = next ? next.startMs : Math.max(totalMs, scene.endMs);
    return { ...scene, endMs, sceneDurationMs: Math.max(0, endMs - scene.startMs) };
  });
}
