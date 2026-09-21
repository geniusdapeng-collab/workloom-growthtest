/**
 * ai-video × 配乐工位 · 自算作曲内核（synth.mjs）
 *
 * 定位：不依赖任何第三方曲库、任何云端音乐 API，直接按"题材×情绪配方"合成一条可交付的 BGM。
 * 全部为确定性合成：同一配方 + 同一种子 → 同一份 PCM → 同一个 sha256（可复现、可核验）。
 *
 * 为什么自己算而不是只接外部曲库：
 * 1. 许可干净：不引入第三方音源，商用链路无版权尾巴（对外部曲库的支持另见 library/bgm-library）；
 * 2. 时长可裁：片子多长就写多长，不用"裁歌"（裁歌必然破坏结构）；
 * 3. 卡点可控：BPM/节拍网格由配方与剪辑点共同决定，能给"卡点对齐"提供确定性输入。
 *
 * 作曲口径（本仓自有参数，来自公开乐理与合成常识）：
 * 调式（mode）→ 音阶 → 和弦级数（roman）→ 三和弦音高；配器（instrumentation）→ 分层；
 * 结构（structure）= 前奏 / 主体 / 尾奏三段，主体内按配方给力度；打击只出现在主体段。
 *
 * 输出：44.1kHz / 16-bit / 立体声 WAV（PCM），峰值归一化到 -6dBFS 留混音余量。
 */

import fsp from "node:fs/promises";
import path from "node:path";

import { MeasureError, round, sha256File } from "./measure.mjs";

/* ============================ 乐理表 ============================ */

/** 音阶（半音偏移，根音为 0）。 */
export const SCALES = {
  ionian: [0, 2, 4, 5, 7, 9, 11],
  major: [0, 2, 4, 5, 7, 9, 11],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
};

/** 和弦级数（相对根音的半音偏移；大小写即三和弦性质）。 */
export const CHORDS = {
  I: [0, 4, 7],
  ii: [2, 5, 9],
  iii: [4, 7, 11],
  IV: [5, 9, 12],
  V: [7, 11, 14],
  vi: [9, 12, 16],
  "vii°": [11, 14, 17],
  i: [0, 3, 7],
  "ii°": [2, 5, 8],
  III: [3, 7, 10],
  iv: [5, 8, 12],
  v: [7, 10, 14],
  VI: [8, 12, 15],
  VII: [10, 14, 17],
  II: [2, 6, 9],
  Vsus: [7, 12, 14],
};

/** 音名 → MIDI（C4 = 60）。 */
const NOTE_NAMES = {
  C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5,
  "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11,
};

export function noteToMidi(name) {
  const match = /^([A-G][#b]?)(-?\d+)$/.exec(String(name ?? "").trim());
  if (!match) throw new MeasureError(`音名无法解析：${name}`, "bad_recipe");
  const semitone = NOTE_NAMES[match[1]];
  if (semitone === undefined) throw new MeasureError(`音名无法解析：${name}`, "bad_recipe");
  return (Number(match[2]) + 1) * 12 + semitone;
}

export function midiToFreq(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

/* ============================ 确定性随机 ============================ */

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedFrom(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/* ============================ 作曲规划 ============================ */

const DEFAULT_INSTRUMENTATION = ["pad", "bass", "pluck"];

/**
 * 把配方 + 片长编排成一份"可执行乐谱"（只有结构与时值，不含样本）。
 * @param {{recipe:object, durationSec:number, seed?:number, bpmOverride?:number, offsetSec?:number}} params
 */
export function planComposition({ recipe, durationSec, seed = 0, bpmOverride = null, offsetSec = 0 }) {
  if (!recipe || typeof recipe !== "object") throw new MeasureError("缺少配乐配方", "bad_recipe");
  const requested = Number(durationSec);
  if (!Number.isFinite(requested) || requested <= 0) throw new MeasureError("片长非法（必须 > 0 秒）", "bad_request");

  const bpm = Number(bpmOverride ?? recipe.bpm);
  if (!Number.isFinite(bpm) || bpm < 40 || bpm > 200) throw new MeasureError(`BPM 非法：${recipe.bpm}`, "bad_recipe");
  const beatSec = 60 / bpm;
  const barSec = beatSec * 4;
  const offset = Math.max(0, Number(offsetSec) || 0);
  const bars = Math.max(4, Math.ceil((requested + offset) / barSec));
  const introBars = Math.min(Math.max(1, Math.round(bars * 0.15)), Math.max(1, Math.floor(bars / 4)));
  const outroBars = Math.min(Math.max(1, Math.round(bars * 0.12)), Math.max(1, Math.floor(bars / 4)));
  const bodyBars = Math.max(1, bars - introBars - outroBars);

  const progression = Array.isArray(recipe.chords) && recipe.chords.length ? recipe.chords : ["I", "V", "vi", "IV"];
  for (const chord of progression) {
    if (!CHORDS[chord]) throw new MeasureError(`和弦级数无法解析：${chord}（可用：${Object.keys(CHORDS).join(", ")}）`, "bad_recipe");
  }
  const instrumentation = (Array.isArray(recipe.instrumentation) && recipe.instrumentation.length
    ? recipe.instrumentation
    : DEFAULT_INSTRUMENTATION).filter((name) => typeof name === "string");
  if (!instrumentation.length) throw new MeasureError("配器为空", "bad_recipe");

  const mode = String(recipe.mode ?? "major");
  if (!SCALES[mode]) throw new MeasureError(`调式无法解析：${mode}（可用：${Object.keys(SCALES).join(", ")}）`, "bad_recipe");
  const rootMidi = noteToMidi(recipe.key ?? "C4");

  const barsPlan = [];
  for (let bar = 0; bar < bars; bar += 1) {
    const section = bar < introBars ? "intro" : bar >= introBars + bodyBars ? "outro" : "body";
    const intensity = section === "intro" ? 0.55 : section === "outro" ? 0.45 : 1;
    barsPlan.push({
      bar,
      startSec: round(bar * barSec + offset, 3),
      chord: progression[bar % progression.length],
      section,
      intensity,
    });
  }

  return {
    recipeId: recipe.id ?? null,
    genre: recipe.genre ?? null,
    mood: recipe.mood ?? null,
    key: recipe.key ?? "C4",
    mode,
    rootMidi,
    scale: SCALES[mode],
    bpm,
    beatSec: round(beatSec, 4),
    barSec: round(barSec, 4),
    bars,
    introBars,
    bodyBars,
    outroBars,
    durationSec: round(bars * barSec, 3),
    requestedDurationSec: round(requested, 3),
    offsetSec: round(offset, 3),
    instrumentation,
    chords: progression,
    bars_: barsPlan,
    seed,
  };
}

/* ============================ 合成器 ============================ */

const SAMPLE_RATE = 44100;
const PEAK_TARGET = 0.5; // -6 dBFS：给混音留余量

function envelope(t, { attack = 0.01, decay = 0.2, sustain = 0.8, release = 0.3, length = 1 }) {
  if (t < 0 || t > length) return 0;
  if (t < attack) return t / attack;
  if (t < attack + decay) {
    const k = (t - attack) / Math.max(decay, 1e-6);
    return 1 + (sustain - 1) * k;
  }
  const releaseStart = Math.max(length - release, attack + decay);
  if (t >= releaseStart) {
    const k = (t - releaseStart) / Math.max(release, 1e-6);
    return sustain * Math.max(0, 1 - k);
  }
  return sustain;
}

function addVoice(buffer, {
  startSample, lengthSamples, freq, amplitude, harmonics = [[1, 1]], detune = 0,
  env = { attack: 0.01, decay: 0.2, sustain: 0.8, release: 0.3 }, pan = 0,
}) {
  const start = Math.max(0, Math.floor(startSample));
  const end = Math.min(buffer.left.length, start + Math.floor(lengthSamples));
  const leftGain = Math.cos((pan + 1) * Math.PI / 4);
  const rightGain = Math.sin((pan + 1) * Math.PI / 4);
  const lengthSec = lengthSamples / SAMPLE_RATE;
  const phases = detune > 0 ? [1 + detune, 1 - detune] : [1];
  for (let index = start; index < end; index += 1) {
    const t = (index - start) / SAMPLE_RATE;
    const envValue = envelope(t, { ...env, length: lengthSec });
    if (envValue <= 0) continue;
    let sample = 0;
    for (const factor of phases) {
      const phase = 2 * Math.PI * freq * factor * t;
      for (const [multiple, weight] of harmonics) sample += weight * Math.sin(phase * multiple);
    }
    sample = (sample / phases.length) * amplitude * envValue;
    buffer.left[index] += sample * leftGain;
    buffer.right[index] += sample * rightGain;
  }
}

function addNoise(buffer, { startSample, lengthSamples, amplitude, decay, pan = 0, random, highpass = true }) {
  const start = Math.max(0, Math.floor(startSample));
  const end = Math.min(buffer.left.length, start + Math.floor(lengthSamples));
  const leftGain = Math.cos((pan + 1) * Math.PI / 4);
  const rightGain = Math.sin((pan + 1) * Math.PI / 4);
  let previous = 0;
  for (let index = start; index < end; index += 1) {
    const t = (index - start) / SAMPLE_RATE;
    const envValue = Math.exp(-t / Math.max(decay, 1e-6));
    const raw = random() * 2 - 1;
    const value = highpass ? raw - previous : raw;
    previous = raw;
    const sample = value * amplitude * envValue;
    buffer.left[index] += sample * leftGain;
    buffer.right[index] += sample * rightGain;
  }
}

/**
 * 按乐谱渲染 PCM：pad（情绪地基）/ bass（低频走向）/ pluck（推进感）/ kick·hat（主体段节拍）/ bell（点缀）。
 * @returns {{buffer:{left:Float64Array,right:Float64Array}, peak:number, rms:number}}
 */
export function renderPlan(plan) {
  const totalSamples = Math.ceil(plan.durationSec * SAMPLE_RATE) + Math.ceil(0.5 * SAMPLE_RATE);
  const buffer = { left: new Float64Array(totalSamples), right: new Float64Array(totalSamples) };
  const random = mulberry32((plan.seed ?? 0) ^ seedFrom(`${plan.recipeId}|${plan.bpm}|${plan.key}|${plan.mode}`));
  const has = (name) => plan.instrumentation.includes(name);
  // 同一配方的不同"take"：种子只影响演奏法（琶音型、点缀落点、和声力度抖动），不改调性/速度/结构。
  // 这样"同配方不同种子"听起来是两条不同的演绎，但仍然属于同一套配乐语言。
  const PLUCK_PATTERNS = [
    [0, 1, 2, 1, 0, 2, 1, 2],
    [0, 2, 1, 2, 0, 1, 2, 1],
    [0, 1, 2, 2, 1, 0, 2, 1],
    [0, 2, 2, 1, 0, 1, 2, 0],
  ];
  const pluckPattern = PLUCK_PATTERNS[Math.floor(random() * PLUCK_PATTERNS.length) % PLUCK_PATTERNS.length];
  const bellBeat = [1.5, 2, 2.5][Math.floor(random() * 3) % 3];
  const padVelocity = Array.from({ length: 4 }, () => 1 + (random() - 0.5) * 0.08);
  const pluckVelocity = 1 + (random() - 0.5) * 0.12;

  for (const bar of plan.bars_) {
    const chordTones = CHORDS[bar.chord].map((offset) => plan.rootMidi + offset);
    const barStartSample = bar.startSec * SAMPLE_RATE;
    const barSamples = plan.barSec * SAMPLE_RATE;
    const intensity = bar.intensity;

    if (has("pad")) {
      chordTones.forEach((midi, voiceIndex) => {
        addVoice(buffer, {
          startSample: barStartSample - 0.15 * SAMPLE_RATE,
          lengthSamples: (plan.barSec + 0.9) * SAMPLE_RATE,
          freq: midiToFreq(midi + 12),
          amplitude: 0.075 * intensity * (1 - voiceIndex * 0.12) * (padVelocity[voiceIndex % padVelocity.length] ?? 1),
          harmonics: [[1, 1], [2, 0.3], [3, 0.11]],
          detune: 0.0012,
          env: { attack: 0.7, decay: 0.4, sustain: 0.85, release: 1.1 },
          pan: voiceIndex % 2 === 0 ? -0.35 : 0.35,
        });
      });
    }

    if (has("bass")) {
      addVoice(buffer, {
        startSample: barStartSample,
        lengthSamples: (plan.barSec * 0.95) * SAMPLE_RATE,
        freq: midiToFreq(plan.rootMidi - 24),
        amplitude: 0.2 * (0.7 + 0.3 * intensity),
        harmonics: [[1, 1], [2, 0.18]],
        env: { attack: 0.02, decay: 0.35, sustain: 0.72, release: 0.25 },
        pan: 0,
      });
      if (bar.chord === "V" || bar.chord === "v") {
        addVoice(buffer, {
          startSample: barStartSample + plan.beatSec * 2 * SAMPLE_RATE,
          lengthSamples: (plan.beatSec * 1.6) * SAMPLE_RATE,
          freq: midiToFreq(plan.rootMidi - 17),
          amplitude: 0.14,
          harmonics: [[1, 1]],
          env: { attack: 0.02, decay: 0.3, sustain: 0.6, release: 0.2 },
          pan: 0,
        });
      }
    }

    if (has("pluck") && bar.section === "body") {
      const pattern = pluckPattern;
      for (let step = 0; step < pattern.length; step += 1) {
        const tone = chordTones[pattern[step] % chordTones.length] + 12;
        addVoice(buffer, {
          startSample: barStartSample + step * (barSamples / pattern.length),
          lengthSamples: 0.4 * SAMPLE_RATE,
          freq: midiToFreq(tone),
          amplitude: 0.058 * intensity * pluckVelocity,
          harmonics: [[1, 1], [3, 0.22]],
          env: { attack: 0.006, decay: 0.12, sustain: 0.28, release: 0.22 },
          pan: step % 2 === 0 ? -0.22 : 0.22,
        });
      }
    }

    if (bar.section === "body" && (has("kick") || has("hat"))) {
      for (let beat = 0; beat < 4; beat += 1) {
        const beatStart = barStartSample + beat * plan.beatSec * SAMPLE_RATE;
        if (has("kick") && (beat === 0 || beat === 2)) {
          const lengthSamples = 0.28 * SAMPLE_RATE;
          const start = Math.floor(beatStart);
          const end = Math.min(buffer.left.length, start + Math.floor(lengthSamples));
          for (let index = start; index < end; index += 1) {
            const t = (index - start) / SAMPLE_RATE;
            const freq = 45 + 65 * Math.exp(-t / 0.045);
            const envValue = Math.exp(-t / 0.11);
            const sample = Math.sin(2 * Math.PI * freq * t) * 0.3 * envValue * intensity;
            buffer.left[index] += sample;
            buffer.right[index] += sample;
          }
        }
        if (has("hat")) {
          addNoise(buffer, {
            startSample: beatStart + plan.beatSec * 0.5 * SAMPLE_RATE,
            lengthSamples: 0.07 * SAMPLE_RATE,
            amplitude: 0.05 * intensity,
            decay: 0.02,
            pan: 0.25,
            random,
          });
        }
      }
    }

    if (has("bell") && bar.section === "body" && bar.bar % 2 === 0) {
      addVoice(buffer, {
        startSample: barStartSample + plan.beatSec * bellBeat * SAMPLE_RATE,
        lengthSamples: 1.3 * SAMPLE_RATE,
        freq: midiToFreq(chordTones[chordTones.length - 1] + 24),
        amplitude: 0.038 * intensity,
        harmonics: [[1, 1], [2.01, 0.45]],
        env: { attack: 0.008, decay: 0.25, sustain: 0.18, release: 1.0 },
        pan: 0.18,
      });
    }
  }

  let peak = 0;
  let sumSquares = 0;
  for (let index = 0; index < totalSamples; index += 1) {
    const left = Math.tanh(buffer.left[index]);
    const right = Math.tanh(buffer.right[index]);
    buffer.left[index] = left;
    buffer.right[index] = right;
    peak = Math.max(peak, Math.abs(left), Math.abs(right));
    sumSquares += left * left + right * right;
  }
  return { buffer, peak, rms: Math.sqrt(sumSquares / (totalSamples * 2)) };
}

/** 16-bit PCM 立体声 WAV 编码（44 字节标准头）。 */
export function encodeWav({ left, right }, { sampleRate = SAMPLE_RATE, gain = 1 } = {}) {
  const frames = left.length;
  const dataBytes = frames * 2 * 2;
  const out = Buffer.alloc(44 + dataBytes);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write("WAVE", 8, "ascii");
  out.write("fmt ", 12, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(2, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2 * 2, 28);
  out.writeUInt16LE(4, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < frames; index += 1) {
    const l = Math.max(-1, Math.min(1, left[index] * gain));
    const r = Math.max(-1, Math.min(1, right[index] * gain));
    out.writeInt16LE(Math.round(l * 32767), 44 + index * 4);
    out.writeInt16LE(Math.round(r * 32767), 46 + index * 4);
  }
  return out;
}

/**
 * 合成一条 BGM 到磁盘（WAV），返回可核验的产物信息（sha256 + 实测峰值/RMS）。
 */
export async function renderCompositionToWav({ plan, output }) {
  const { buffer, peak, rms } = renderPlan(plan);
  const gain = peak > 0 ? PEAK_TARGET / peak : 1;
  const wav = encodeWav(buffer, { gain });
  await fsp.mkdir(path.dirname(output), { recursive: true });
  await fsp.writeFile(output, wav);
  return {
    output,
    format: "wav/pcm_s16le",
    sampleRate: SAMPLE_RATE,
    channels: 2,
    durationSeconds: plan.durationSec,
    sizeBytes: wav.length,
    peakDbfs: round(20 * Math.log10(Math.max(peak * gain, 1e-6)), 2),
    rmsDbfs: round(20 * Math.log10(Math.max(rms * gain, 1e-6)), 2),
    sha256: await sha256File(output),
    plan: {
      recipeId: plan.recipeId,
      key: plan.key,
      mode: plan.mode,
      bpm: plan.bpm,
      chords: plan.chords,
      instrumentation: plan.instrumentation,
      bars: plan.bars,
      structure: { introBars: plan.introBars, bodyBars: plan.bodyBars, outroBars: plan.outroBars },
      beatSec: plan.beatSec,
      barSec: plan.barSec,
      offsetSec: plan.offsetSec,
      seed: plan.seed,
    },
  };
}

/** 便捷入口：配方 + 片长 → WAV 文件。 */
export async function composeToWav({ recipe, durationSec, output, seed = 0, bpmOverride = null, offsetSec = 0 }) {
  const plan = planComposition({ recipe, durationSec, seed, bpmOverride, offsetSec });
  return await renderCompositionToWav({ plan, output });
}
