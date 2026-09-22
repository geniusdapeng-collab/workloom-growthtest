/**
 * 结构识别 + 自动选段的**真机**验证（真实 ffmpeg 造素材；没装 ffmpeg 的环境自动跳过）。
 *
 * 为什么单独一组：这两件事只有"真听真算"才能验证——
 *  · 曲目结构：人造一条 安静→高潮→安静 的曲子，看分段是否把高潮找出来；
 *  · 片子高潮：人造一条"前段安静、后段三连切+更响"的片子，看是否按剪辑密度定高潮（而不是按台词音量）；
 *  · 选段落点：把曲子高潮段的峰值对到片子高潮时刻，误差要在 1.5s 内，并且回执里要有依据。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { analyzeStructure, filmClimaxTime, filmEnergyArc, mix } from "./core.mjs";
import { detectCuts, detectVoiceBandSegments, resolveBinaries, probeMedia } from "./measure.mjs";

const bins = resolveBinaries();
const hasFfmpeg = (() => {
  try {
    execFileSync(bins.ffmpeg, ["-hide_banner", "-version"], { stdio: "ignore" });
    execFileSync(bins.ffprobe, ["-hide_banner", "-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const workDir = join(tmpdir(), `bgm-structure-${Date.now().toString(36)}`);
const musicPath = join(workDir, "music.wav");
const filmPath = join(workDir, "film.mp4");
const mixedPath = join(workDir, "film-scored.mp4");

function buildStructuredMusic() {
  // 26s：0–8 安静铺底 / 8–20 高潮（带 2Hz 脉冲 = 120BPM）/ 20–26 安静收尾
  execFileSync(bins.ffmpeg, [
    "-hide_banner", "-v", "error", "-y",
    "-f", "lavfi", "-i", "aevalsrc=0.18*sin(2*PI*220*t)+0.10*sin(2*PI*330*t):d=26:s=44100",
    "-f", "lavfi", "-i", "aevalsrc=0.5*exp(-mod(t\\,0.5)*9)*sin(2*PI*90*t):d=26:s=44100",
    "-filter_complex",
    "[0:a]volume='if(between(t,8,20),1.0,0.28)':eval=frame[pad];"
    + "[1:a]volume='if(between(t,8,20),1.0,0.0)':eval=frame[beat];"
    + "[pad][beat]amix=inputs=2:duration=longest:normalize=0[mix];"
    + "[mix]loudnorm=I=-16:TP=-2:LRA=8[aout]",
    "-map", "[aout]", "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2", musicPath,
  ]);
}

function buildFilmWithClimax() {
  // 30s 画面：0–18 单镜（暗）/ 18–21 三连切 / 21–30 单镜（亮）
  execFileSync(bins.ffmpeg, [
    "-hide_banner", "-v", "error", "-y",
    "-f", "lavfi", "-i", "color=c=0x1b2b4d:size=320x180:rate=15:duration=18",
    "-f", "lavfi", "-i", "color=c=0xe8dcc8:size=320x180:rate=15:duration=1",
    "-f", "lavfi", "-i", "color=c=0x15525a:size=320x180:rate=15:duration=1",
    "-f", "lavfi", "-i", "color=c=0xd9762a:size=320x180:rate=15:duration=1",
    "-f", "lavfi", "-i", "color=c=0x0f3b2e:size=320x180:rate=15:duration=9",
    "-filter_complex",
    "[0:v][1:v][2:v][3:v][4:v]concat=n=5:v=1:a=0[vout]",
    "-map", "[vout]", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "26", "-pix_fmt", "yuv420p", join(workDir, "video-only.mp4"),
  ]);
  // 音轨：全程环境声；18–24s 明显更响（对应"画面高潮段"）
  execFileSync(bins.ffmpeg, [
    "-hide_banner", "-v", "error", "-y",
    "-f", "lavfi", "-i", "anoisesrc=duration=30:color=pink:amplitude=0.3:seed=17",
    "-af", "lowpass=f=4500,volume='if(between(t,18,24),1.0,0.10)':eval=frame,loudnorm=I=-20:TP=-2:LRA=8",
    "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2", join(workDir, "film-audio.wav"),
  ]);
  execFileSync(bins.ffmpeg, [
    "-hide_banner", "-v", "error", "-y",
    "-i", join(workDir, "video-only.mp4"), "-i", join(workDir, "film-audio.wav"),
    "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart", "-shortest", filmPath,
  ]);
}

describe.skipIf(!hasFfmpeg)("配乐结构识别与选段（真实 ffmpeg）", () => {
  beforeAll(() => {
    mkdirSync(workDir, { recursive: true });
    buildStructuredMusic();
    buildFilmWithClimax();
  }, 180_000);

  afterAll(() => {
    if (!process.env.BGM_KEEP_FIXTURES) rmSync(workDir, { recursive: true, force: true });
  });

  it("曲目结构：8–20s 的高潮段被识别为 drop，拍速落在 120BPM 附近", async () => {
    const structure = await analyzeStructure({ input: musicPath });
    const drop = structure.structure.segments.find((segment) => segment.type === "drop");
    expect(drop, `分段结果：${JSON.stringify(structure.structure.segments)}`).toBeTruthy();
    expect(drop!.startSec).toBeGreaterThanOrEqual(7);
    expect(drop!.startSec).toBeLessThanOrEqual(10);
    expect(drop!.endSec).toBeGreaterThanOrEqual(19);
    expect(drop!.endSec).toBeLessThanOrEqual(21.5);
    expect(structure.climax.candidates[0]!.type).toBe("drop");
    // 2Hz 脉冲 → 120BPM（允许倍频候选 60/240）
    expect(structure.tempo.bpm).not.toBeNull();
    expect([60, 120, 240]).toContain(structure.tempo.bpm);
    expect(structure.tempo.confidence).not.toBe("low");
  }, 30_000);

  it("片子高潮：三连切处被识别为 cut-density 高潮（不是音量峰值）", async () => {
    const probe = await probeMedia(filmPath, { bins });
    const arc = await filmEnergyArc({ input: filmPath });
    const cuts = (await detectCuts({ input: filmPath })).cuts;
    const voice = await detectVoiceBandSegments({ input: filmPath, duration: probe.duration });
    const climax = filmClimaxTime({ arc, cuts, voice, durationSec: probe.duration });
    expect(cuts.length).toBeGreaterThanOrEqual(3);
    expect(climax.basis).toBe("cut-density");
    expect(climax.timeSec).toBeGreaterThanOrEqual(17.5);
    expect(climax.timeSec).toBeLessThanOrEqual(21.5);
  }, 30_000);

  it("自动选段出片：用曲子高潮段对齐片子高潮时刻，误差 ≤1.5s 且复检全绿", async () => {
    const report = await mix({
      input: filmPath,
      output: mixedPath,
      bgmPath: musicPath,
      policy: "keep-all",
      musicLevelDb: -24,
      duckingDb: 10,
      section: "auto",
      evidenceDir: workDir,
      bins,
    });
    expect(existsSync(mixedPath)).toBe(true);
    expect(report.section.mode).toBe("auto");
    expect(report.section.chosen!.type).toBe("drop");
    expect(report.section.filmPeakAlign).toBeTruthy();
    expect(report.section.played).toBeTruthy();

    // 落点校验：曲子高潮峰值 + 起播偏移 ≈ 片子高潮时刻
    const align = report.section.filmPeakAlign as { filmPeakSec: number; musicAnchorOffsetSec: number; placedAtSec: number };
    const landed = align.placedAtSec + align.musicAnchorOffsetSec;
    expect(Math.abs(landed - align.filmPeakSec)).toBeLessThanOrEqual(1.5);
    expect(Object.values(report.checks).every(Boolean)).toBe(true);
    expect(report.evidence.sectionPicked).toBeTruthy();
  }, 180_000);
});
