/** 实际总装回归：本地 FFmpeg、仓内调色/字体/配乐，不替换生产函数。 */
import { execFileSync } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assembleTimeline, buildDeliveryPackage, readRevisionBase, reedit, resolveBinaries } from "./core.mjs";
import { describeAudioStemSources } from "../bgm-bridge/audio-stems.mjs";
import { audioStemReceiptPayload } from "../bgm-bridge/audio-stems-trust.mjs";
import { inspectEditedRhythm } from "../../../../scripts/tools/lib/edit-rhythm.mts";
import type { EditTimeline } from "../../../../packages/video-studio/src/edit/timeline.js";
import type { RhythmPlanInput } from "../../../../packages/video-studio/src/rhythm-plan.js";

const bins = resolveBinaries();
const hasMediaTools = (() => {
  try {
    execFileSync(bins.ffmpeg, ["-version"], { stdio: "ignore" });
    execFileSync(bins.ffprobe, ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const hash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const expectedBase = (file: string) => {
  const base = readRevisionBase(file);
  return { expectedVersion: base.version, expectedProjectSha256: base.sha256 };
};

function testLibrary(root: string) {
  const dir = path.join(root, "custom-library");
  fs.mkdirSync(dir);
  const tracks = [
    ["acoustic-warm", "温暖自在"], ["corporate-clean", "干净可信"], ["sports-hype", "激昂有力"],
  ].map(([style, mood], index) => {
    const file = `${style}.wav`;
    execFileSync(bins.ffmpeg, ["-hide_banner", "-v", "error", "-n", "-f", "lavfi", "-i",
      `sine=frequency=${600 + index * 200}:duration=8`, "-c:a", "pcm_s16le", path.join(dir, file)]);
    return { id: `000-growth-${style}`, title: style, style, mood, file, durationSec: 8,
      license: "workloom-self-generated", source: "offline-synthetic-fixture", artist: "test fixture" };
  });
  fs.writeFileSync(path.join(dir, "tracks.json"), JSON.stringify({ tracks }));
  return dir;
}

describe.skipIf(!hasMediaTools)("后期真实总装与连续返修（需 FFmpeg/FFprobe）", () => {
  let root: string;
  let shots: Array<{ shotId: string; path: string; audioStems: Record<string, any> }>;
  let delivery: Awaited<ReturnType<typeof buildDeliveryPackage>>;
  const env = {
    ...process.env, WORKLOOM_BGM_DISCOVER: "0",
    WORKLOOM_BGM_LIBRARY_DIR: "", WORKLOOM_BGM_HOME: "",
    WORKLOOM_AUDIO_STEM_SIGNING_SECRET: randomBytes(32).toString("hex"), WORKLOOM_AUDIO_STEM_SIGNING_KEY_ID: "synthetic-test-only",
    WORKLOOM_POST_ALLOWED_ROOTS: "", WORKLOOM_BGM_ALLOWED_ROOTS: "",
  };
  const scope = { tenantId: "fixture-t", workspaceId: "fixture-w", projectId: "post-p1-fixture", revision: 1 };
  const project = {
    projectId: "post-p1-fixture",
    audioScope: scope,
    title: "真实回归",
    resolution: [320, 240],
    fps: 30,
    targetDurationSec: 7.5,
    copy: { title: "真实回归", hook: "连续返修", body: "本地合成验证", cta: "查看产物" },
  };
  const subtitles = { zhText: "1\n00:00:00,100 --> 00:00:02,000\n真实回归\n\n" };

  function makeClip(file: string, seed: number, hue: number) {
    // 三个独立噪声信号能查出错位；纯音/静音无法可靠证明拼接血缘和音画窗口。
    execFileSync(bins.ffmpeg, [
      "-hide_banner", "-v", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=2.5",
      "-f", "lavfi", "-i", `anoisesrc=color=white:amplitude=0.2:seed=${seed}:sample_rate=48000:duration=2.5`,
      "-vf", `hue=h=${hue}`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-ar", "48000", "-ac", "2", "-shortest", file,
    ], { stdio: "pipe", timeout: 30_000 });
  }

  function sourceDescriptors(video: string, shotId: string, seed: number) {
    // Independent audio-only synthetic source; never extract the scored video's audio.
    const file = path.join(root, `ambience-${seed}.wav`);
    execFileSync(bins.ffmpeg, ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i",
      `anoisesrc=color=pink:amplitude=0.001:seed=${seed}:sample_rate=48000:duration=2.5`,
      "-c:a", "pcm_f32le", "-ac", "2", file], { stdio: "pipe", timeout: 30000 });
    const stems: Record<string, any> = {
      ambience: { status: "ready", path: file, sha256: hash(file), sourceKind: "synthesized_ambience" },
      ...Object.fromEntries(["dialogue", "foley", "music"].map((role) => [role, { status: "not_applicable", reason: "Synthetic ambience-only test scene" }])),
    };
    for (const { binding, bindingSha256 } of describeAudioStemSources({ scope, shots: [{ shotId, videoSha256: hash(video), durationSec: 2.5, stems }] })) {
      const now = Date.now();
      const receipt: Record<string, string> = { schemaVersion: "workloom.audio-stem-receipt/v1", purpose: "independent-audio-source",
        bindingSha256, workerId: "synthetic-test-worker", jobId: `fixture-${seed}`, evidenceSha256: "e".repeat(64),
        issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 3600000).toISOString(), keyId: "synthetic-test-only" };
      receipt.signature = createHmac("sha256", env.WORKLOOM_AUDIO_STEM_SIGNING_SECRET).update(audioStemReceiptPayload(receipt)).digest("hex");
      stems[binding.role].receipt = receipt;
    }
    return stems;
  }

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "post-p1-")));
    env.WORKLOOM_POST_ALLOWED_ROOTS = [root, path.resolve("bundles/ai-video/library")].join(path.delimiter);
    env.WORKLOOM_BGM_ALLOWED_ROOTS = [root, path.resolve("bundles/ai-video/library")].join(path.delimiter);
    env.WORKLOOM_BGM_LIBRARY_DIR = path.join(root, "custom-library");
    env.WORKLOOM_BGM_HOME = path.join(root, "bgm-home");
    shots = [11, 29, 47].map((seed, index) => {
      const file = path.join(root, `镜头 ${index + 1}.mp4`);
      makeClip(file, seed, index * 35);
      const shotId = `NC-${index + 1}`;
      return { shotId, path: file, audioStems: sourceDescriptors(file, shotId, seed) };
    });
  }, 60_000);

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("硬切与淡入淡出将 duration 送入样点拼接和实测，三镜均有有效窗口", async () => {
    for (const mode of ["hard", "fade"]) {
      const output = path.join(root, `assemble-${mode}`, "result.mp4");
      const result = await assembleTimeline({
        clips: shots.map((shot) => ({ ...shot, duration: 2.5 })),
        transitions: { mode, fadeSec: 0.3 }, output, resolution: [320, 240], fps: 30, bins,
      });
      expect(result.avSync.processingSucceeded).toBe(true);
      expect(result.avSync.audioAlignmentMeasured).toBe(false);
      expect(readJson(output.replace(/\.mp4$/, ".av-sync.json"))).toMatchObject({ processingSucceeded: true, audioAlignmentMeasured: false });
    }
  }, 120_000);

  it("无效时长和空镜头明确拒绝，不能以未校验结果继续合流", async () => {
    for (const duration of [undefined, 0, -1, Number.NaN]) {
      await expect(assembleTimeline({
        clips: [{ ...shots[0], duration }], output: path.join(root, "invalid.mp4"), bins,
      })).rejects.toMatchObject({ code: "bad_media" });
    }
    await expect(assembleTimeline({ clips: [], output: path.join(root, "empty.mp4"), bins }))
      .rejects.toMatchObject({ code: "bad_request" });
  });

  it("真实交付同时验证有计划和无计划分支，净时长不再抛 ReferenceError", async () => {
    const outDir = path.join(root, "交付 包");
    const sourceHashes = shots.map((shot) => hash(shot.path));
    delivery = await buildDeliveryPackage({
      project, shots, subtitles, variants: ["warm-story", "clean-tech"], outDir, bins, env,
    });
    const duration = delivery.checks.find((check: { kind: string }) => check.kind === "duration_plan_consistent");
    const measured = delivery.normalised.reduce((sum: number, clip: { duration: number }) => sum + clip.duration, 0);
    expect(duration.ok).toBe(true);
    expect(duration.detail.actualSeconds).toBeCloseTo(measured, 5);
    expect(duration.detail.plannedSeconds).toBe(7.5);
    expect(delivery.master.avSync.processingSucceeded).toBe(true); expect(delivery.master.avSync.audioAlignmentMeasured).toBe(false);
    expect(fs.existsSync(delivery.manifestPath)).toBe(true);
    expect(shots.map((shot) => hash(shot.path))).toEqual(sourceHashes);

    const unplanned = await buildDeliveryPackage({
      project: { ...project, targetDurationSec: undefined }, shots, subtitles,
      variants: ["warm-story", "clean-tech"], outDir: path.join(root, "unplanned"), bins, env,
    });
    expect(unplanned.checks.find((check: { kind: string }) => check.kind === "duration_plan_consistent").detail)
      .toMatchObject({ plannedSeconds: null, actualSeconds: measured, note: "计划时长未提供（未校验）" });
    const tooLong = await buildDeliveryPackage({
      project: { ...project, targetDurationSec: 20 }, shots, subtitles,
      variants: ["warm-story", "clean-tech"], outDir: path.join(root, "too-long"), bins, env,
    });
    expect(tooLong.checks.find((check: { kind: string }) => check.kind === "duration_plan_consistent").ok).toBe(false);
    expect(tooLong.checks.find((check: { kind: string }) => check.kind === "duration_plan_consistent").blocking).toBe(false);
    expect(tooLong.passed).toBe(true);
    // 实际配乐处理错误会中止，不进行品质审查或静默降级。
    const audioFailures = delivery.manifest.variants.filter((variant: { audio?: { failed?: boolean } }) => variant.audio?.failed);
    expect(delivery.checks.find((check: { kind: string }) => check.kind === "bgm_layer").ok).toBe(audioFailures.length === 0);
    if (audioFailures.length) {
      expect(delivery.passed).toBe(false);
      expect(fs.readFileSync(delivery.reportPath, "utf8")).toContain("未冒充带配乐成片");
    }
    console.info("P1 media evidence", JSON.stringify({
      measuredSeconds: measured, avSync: delivery.master.avSync,
      checks: delivery.checks.map((check: { kind: string; ok: boolean }) => ({ kind: check.kind, ok: check.ok })),
      audioFailures: audioFailures.map((variant: { id: string; audio: { code?: string } }) => ({ variant: variant.id, code: variant.audio.code })),
    }));
  }, 300_000);

  it("转场 + 字幕可交付：旁挂按母版、各变体按自身转场重映射（T-2026-1013-0002 移植回归）", async () => {
    const outDir = path.join(root, "转场字幕");
    const timelineSubtitles = { zhText: "1\n00:00:00,000 --> 00:00:02,000\n开场\n\n2\n00:00:06,400 --> 00:00:07,500\n收尾一句话\n\n" };
    const outcome = await buildDeliveryPackage({
      project: { ...project, transitions: { mode: "xfade", fadeSec: 0.5 } },
      shots, subtitles: timelineSubtitles, variants: ["warm-story", "bold-promo"], outDir, bins, env,
    });
    expect(outcome.passed).toBe(true);
    const subtitlesDir = path.join(outDir, "subtitles");
    const timelineSrt = fs.readFileSync(path.join(subtitlesDir, "post-p1-fixture.timeline.zh.srt"), "utf8");
    expect(timelineSrt).toContain("00:00:06,400 --> 00:00:07,500");
    const masterSrt = fs.readFileSync(path.join(subtitlesDir, "post-p1-fixture.zh.srt"), "utf8");
    expect(masterSrt).not.toContain("00:00:07,500");
    const warmSrt = fs.readFileSync(path.join(outcome.outDir, "variants", "warm-story", "warm-story.zh.srt"), "utf8");
    expect(warmSrt).toContain("00:00:06,400 --> 00:00:07,500");
    const boldSrt = fs.readFileSync(path.join(outcome.outDir, "variants", "bold-promo", "bold-promo.zh.srt"), "utf8");
    expect(boldSrt).not.toContain("00:00:07,500");
    expect(boldSrt).not.toBe(masterSrt);
  }, 300_000);

  it("显式换镜后 v2→v3 持续指向新素材和新归一化文件，未点名镜头保持哈希及 mtime", async () => {
    expect(delivery).toBeDefined();
    const replacement = path.join(root, "新 镜头.mp4");
    makeClip(replacement, 73, 145);
    const oldShots = delivery.filmProject.layers.shots;
    const oldPaths = oldShots.map((shot: { normalised: string }) => path.resolve(delivery.outDir, shot.normalised));
    const oldHashes = oldPaths.map(hash);
    const oldMtimes = oldPaths.map((file: string) => fs.statSync(file).mtimeMs);
    const v2 = await reedit({
      projectPath: delivery.projectPath, deliveryDir: delivery.outDir,
      ...expectedBase(delivery.projectPath),
      patch: { shots: { replace: [{ shotId: "NC-1" }] } }, shotPaths: { "NC-1": replacement }, bins, env,
      audioStemsByShot: { "NC-1": sourceDescriptors(replacement, "NC-1", 73) },
    });
    expect(v2.executed).toBe(true);
    const second = readJson(v2.projectPath);
    const newShot = second.layers.shots[0];
    const newPath = path.resolve(path.dirname(v2.projectPath), newShot.normalised);
    expect(newPath).not.toBe(oldPaths[0]);
    expect(hash(newPath)).toBe(newShot.sha256);
    expect(newShot.sha256).not.toBe(oldHashes[0]);
    expect(path.resolve(path.dirname(v2.projectPath), newShot.source)).toBe(replacement);
    expect(newShot.sourceSha256).toBe(hash(replacement));

    const v3 = await reedit({
      projectPath: v2.projectPath, deliveryDir: delivery.outDir,
      ...expectedBase(v2.projectPath),
      patch: { copy: { body: "第二次只改文案" } }, bins, env,
    });
    const third = readJson(v3.projectPath);
    expect(v3.version).toBe(3);
    expect(v3.targetDir).toBe(path.join(delivery.outDir, "versions", "v3"));
    for (const [index, shot] of third.layers.shots.entries()) {
      const storedPath = path.resolve(path.dirname(v3.projectPath), shot.normalised);
      expect(hash(storedPath)).toBe(shot.sha256);
      expect(storedPath).toBe(index === 0 ? newPath : oldPaths[index]);
    }
    expect(path.resolve(path.dirname(v3.projectPath), third.layers.shots[0].source)).toBe(replacement);
    expect(third.layers.shots[0].sourceSha256).toBe(hash(replacement));
    expect(v3.rebuilt.some((entry: { layer: string }) => entry.layer === "shots")).toBe(false);
    expect(v3.reused.filter((entry: { layer: string }) => entry.layer === "shots")).toHaveLength(3);
    expect(oldPaths.map(hash)).toEqual(oldHashes);
    expect(oldPaths.map((file: string) => fs.statSync(file).mtimeMs)).toEqual(oldMtimes);

    const originalBytes = fs.readFileSync(newPath);
    try {
      fs.appendFileSync(newPath, "external-tamper");
      const rejectedDir = path.join(delivery.outDir, "versions", "v4");
      await expect(reedit({
        projectPath: v3.projectPath, deliveryDir: delivery.outDir, outDir: rejectedDir,
        ...expectedBase(v3.projectPath),
        patch: { copy: { body: "不得接纳漂移" } }, bins, env,
      })).rejects.toMatchObject({ code: "verify_failed", retryable: false });
      expect(fs.existsSync(path.join(rejectedDir, "film-project.json"))).toBe(false);
      expect(fs.existsSync(path.join(rejectedDir, "revision.json"))).toBe(false);
      expect(readJson(path.join(rejectedDir, "revision-failed.json")).code).toBe("verify_failed");
    } finally {
      fs.writeFileSync(newPath, originalBytes);
    }
    const noMusic = await reedit({ projectPath: v3.projectPath, deliveryDir: delivery.outDir,
      ...expectedBase(v3.projectPath), patch: { bgm: { enabled: false } }, bins, env });
    expect(noMusic.version).toBe(5); // The rejected v4 remains reserved.
    expect(noMusic.revision.checks.find((check: { kind: string }) => check.kind === "bgm_layer").ok).toBe(true);
    for (const variant of noMusic.variants) {
      const data = execFileSync(bins.ffmpeg, ["-v", "error", "-i", variant.video.path, "-vn", "-f", "f32le", "-ac", "1", "-ar", "48000", "-"], { maxBuffer: 8 << 20 });
      let squared = 0;
      for (let index = 0; index < data.byteLength; index += 4) squared += data.readFloatLE(index) ** 2;
      expect(Math.sqrt(squared / (data.byteLength / 4))).toBeLessThan(0.002); // Only the independent quiet ambience, no original noise or old BGM.
      expect(readJson(path.join(variant.dir, "audio.json")).track).toBeNull();
    }
    const copyOnly = await reedit({ projectPath: noMusic.projectPath, deliveryDir: delivery.outDir,
      ...expectedBase(noMusic.projectPath), patch: { copy: { body: "保留无配乐版本" } }, bins, env });
    expect(copyOnly.variants.map((variant: any) => variant.video.sha256)).toEqual(noMusic.variants.map((variant: any) => variant.video.sha256));
    expect(copyOnly.revision.checks.find((check: { kind: string }) => check.kind === "bgm_layer").ok).toBe(true);
  }, 300_000);
});

describe.skipIf(!hasMediaTools)("独立音轨、声明音效与配乐返修的真实最终成片", () => {
  it("授权节目先合流再加 impact，最终配乐和音频返修均保留音效、原速和当前原生帧时钟", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "post-stems-sfx-")));
    const env: NodeJS.ProcessEnv = { ...process.env, WORKLOOM_BGM_DISCOVER: "0",
      WORKLOOM_POST_ALLOWED_ROOTS: root, WORKLOOM_BGM_ALLOWED_ROOTS: root,
      WORKLOOM_BGM_HOME: path.join(root, "bgm-home"),
      WORKLOOM_AUDIO_STEM_SIGNING_SECRET: randomBytes(32).toString("hex"),
      WORKLOOM_AUDIO_STEM_SIGNING_KEY_ID: "independent-stems-sfx-fixture" };
    const scope = { tenantId: "fixture-t", workspaceId: "fixture-w", projectId: "independent-stems-sfx", revision: 1 };
    const sources = new Map<string, string>();
    const frequencies = { dialogue: 440, ambience: 880, foley: 1320, music: 1760 };
    const sourceKinds = { dialogue: "isolated_recording", ambience: "synthesized_ambience", foley: "synthesized_foley", music: "composed_music" };
    const pcm = (file: string, at: number, duration = 0.2, filter?: string) => execFileSync(bins.ffmpeg,
      ["-v", "error", "-i", file, "-ss", String(at), "-t", String(duration), "-map", "0:a:0",
        ...(filter ? ["-af", filter] : []), "-ac", "1", "-ar", "48000", "-f", "f32le", "-"], { maxBuffer: 8 << 20 });
    const amplitude = (data: Buffer, frequency: number) => {
      let cosine = 0, sine = 0; const samples = data.byteLength / 4;
      for (let index = 0; index < samples; index++) {
        const phase = 2 * Math.PI * frequency * index / 48000, sample = data.readFloatLE(index * 4);
        cosine += sample * Math.cos(phase); sine += sample * Math.sin(phase);
      }
      return 2 * Math.hypot(cosine, sine) / samples;
    };
    const rms = (data: Buffer) => {
      let squared = 0; for (let index = 0; index < data.byteLength; index += 4) squared += data.readFloatLE(index) ** 2;
      return Math.sqrt(squared / (data.byteLength / 4));
    };
    const packets = (file: string) => JSON.parse(execFileSync(bins.ffprobe,
      ["-v", "error", "-select_streams", "v:0", "-show_packets", "-show_data_hash", "sha256",
        "-show_entries", "packet=data_hash", "-of", "json", file], { encoding: "utf8" }))
      .packets.map((packet: { data_hash: string }) => packet.data_hash);
    const evidence: Array<Record<string, any>> = [];
    const verifyFinal = (file: string, sound: { file: string; reportFile: string }, step: string) => {
      const probe = JSON.parse(execFileSync(bins.ffprobe,
        ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", file], { encoding: "utf8" }));
      const video = probe.streams.find((stream: any) => stream.codec_type === "video");
      expect(video).toMatchObject({ width: 320, height: 180, avg_frame_rate: "30/1", nb_read_frames: "165" });
      expect(Number(video.duration)).toBeCloseTo(5.5, 3);
      execFileSync(bins.ffmpeg, ["-v", "error", "-xerror", "-i", file, "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-"], { stdio: "pipe" });
      const report = readJson(sound.reportFile);
      expect(report).toMatchObject({ schemaVersion: "workloom.rhythm-sound/v1", programmeSpeed: 1, videoPacketsUnchanged: true,
        qualityReviewPerformed: false, artisticQuality: "unverified" });
      expect(hash(report.source.file)).toBe(report.source.sha256);
      expect(hash(sound.file)).toBe(report.output.sha256);
      expect(packets(file)).toEqual(packets(sound.file));
      const dialogue = pcm(file, 1.2), tones = Object.fromEntries(Object.entries(frequencies).map(([role, hz]) => [role, amplitude(dialogue, hz)]));
      const originalMixedMusic = amplitude(dialogue, 2200);
      expect(tones.dialogue).toBeGreaterThan(0.004);
      expect(tones.ambience).toBeGreaterThan(0.004);
      expect(tones.foley).toBeGreaterThan(0.004);
      expect(tones.music).toBeLessThan(tones.dialogue * 0.025);
      expect(originalMixedMusic).toBeLessThan(tones.dialogue * 0.025);
      const pitch = Array.from({ length: 11 }, (_, index) => 435 + index)
        .sort((a, b) => amplitude(dialogue, b) - amplitude(dialogue, a))[0];
      expect(pitch).toBe(440);
      const activeImpact = rms(pcm(file, 0.53, 0.15, "highpass=f=30,lowpass=f=180"));
      const quietBreath = rms(pcm(file, 1.3, 0.15, "highpass=f=30,lowpass=f=180"));
      expect(activeImpact).toBeGreaterThan(quietBreath * 4);
      for (const [source, digest] of sources) expect(hash(source)).toBe(digest);
      evidence.push({ step, outputSha256: hash(file), videoFrames: Number(video.nb_read_frames), fps: video.avg_frame_rate,
        canvas: [video.width, video.height], programmePitchHz: pitch, tones, originalMixedMusic, activeImpact, quietBreath,
        soundSha256: report.output.sha256, soundSourceSha256: report.source.sha256, packetPayloadUnchanged: true });
    };
    try {
      env.WORKLOOM_BGM_LIBRARY_DIR = testLibrary(root);
      const shots = [0.5, 2, 3].map((seconds, index) => {
        const shotId = `S${index + 1}`, file = path.join(root, `${shotId}.mp4`);
        execFileSync(bins.ffmpeg, ["-v", "error", "-n", "-f", "lavfi", "-i", `testsrc2=size=320x180:rate=30:duration=${seconds}`,
          "-f", "lavfi", "-i", `sine=frequency=2200:sample_rate=48000:duration=${seconds}`,
          "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
          "-c:a", "aac", "-ar", "48000", "-ac", "2", file], { stdio: "pipe" });
        sources.set(file, hash(file));
        const stems = Object.fromEntries(Object.entries(frequencies).map(([role, frequency]) => {
          const audio = path.join(root, `${shotId}-${role}.wav`);
          execFileSync(bins.ffmpeg, ["-v", "error", "-n", "-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=48000:duration=${seconds}`,
            "-af", "volume=0.15", "-ac", "2", "-c:a", "pcm_f32le", audio], { stdio: "pipe" });
          sources.set(audio, hash(audio));
          return [role, { status: "ready", path: audio, sha256: hash(audio), sourceKind: sourceKinds[role as keyof typeof sourceKinds] }];
        })) as Record<string, any>;
        for (const { binding, bindingSha256 } of describeAudioStemSources({ scope,
          shots: [{ shotId, videoSha256: hash(file), durationSec: seconds, stems }] })) {
          const now = Date.now(), receipt: Record<string, string> = { schemaVersion: "workloom.audio-stem-receipt/v1",
            purpose: "independent-audio-source", bindingSha256, workerId: "independent-stems-sfx-fixture",
            jobId: `${shotId}-${binding.role}`, evidenceSha256: "d".repeat(64),
            issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 3600000).toISOString(),
            keyId: "independent-stems-sfx-fixture" };
          receipt.signature = createHmac("sha256", env.WORKLOOM_AUDIO_STEM_SIGNING_SECRET!).update(audioStemReceiptPayload(receipt)).digest("hex");
          stems[binding.role].receipt = receipt;
        }
        return { shotId, path: file, audioStems: stems };
      });
      const rhythmPlan: RhythmPlanInput = { profile: "fast-cut", segments: [
        { id: "S1", sourceId: "S1", inSeconds: 0, outSeconds: 0.5, role: "fast", cutReason: "动作完成即进入展开" },
        { id: "S2", sourceId: "S2", inSeconds: 0, outSeconds: 2, role: "hold", cutReason: "保留展开动作" },
        { id: "S3", sourceId: "S3", inSeconds: 0, outSeconds: 3, role: "breath", cutReason: "原环境声呼吸" },
      ], soundCues: [{ atSeconds: 0.5, kind: "impact", gainDb: 0, reason: "仅明确段落重音" }] };
      const project = { projectId: scope.projectId, audioScope: scope, title: "分轨音效实测", fps: 30, targetDurationSec: 5.5,
        transitions: { mode: "hard", fadeSec: 0, perCut: {} }, rhythmPlan,
        copy: { title: "分轨音效实测", hook: "原速节目音与重音", body: "当前文件实测" } };
      const timeline: EditTimeline = { schemaVersion: "workloom.video-edit/edit-timeline/v2", timelineId: "independent-stems-sfx",
        target: { durationSeconds: 5.5, aspectRatio: "16:9", fps: 30, platform: "test" },
        sources: shots.map((shot, index) => ({ sourceId: shot.shotId, path: shot.path, sha256: hash(shot.path), fps: 30,
          durationSeconds: [0.5, 2, 3][index], hasAudio: true })),
        segments: rhythmPlan.segments.map((segment, seq) => ({ seq, segmentId: segment.id, sourceId: segment.sourceId,
          sourceIn: segment.inSeconds, sourceOut: segment.outSeconds, durationSeconds: segment.outSeconds - segment.inSeconds,
          speed: 1, motive: segment.cutReason })), audioDesign: { originalAudioPolicy: "keep" } };
      const rhythmRequest = { timeline, profile: "fast-cut" as const, declared: rhythmPlan,
        clips: shots, ffprobe: bins.ffprobe };
      const measured = await inspectEditedRhythm(rhythmRequest);
      expect(measured).toMatchObject({ status: "passed", passed: true, artisticQuality: "unverified", paidCalls: 0 });
      await expect(inspectEditedRhythm({ ...rhythmRequest, declared: { ...rhythmPlan, profile: "cinematic" } }))
        .rejects.toThrow("RHYTHM_PROFILE_CONFLICT");
      await expect(inspectEditedRhythm({ ...rhythmRequest, declared: { ...rhythmPlan,
        segments: rhythmPlan.segments.map((segment, index) => index === 0 ? { ...segment, inSeconds: 0.1 } : segment) } }))
        .rejects.toThrow("RHYTHM_TIMELINE_PLAN_CONFLICT");
      await expect(inspectEditedRhythm({ ...rhythmRequest, clips: [...shots].reverse() }))
        .rejects.toThrow("RHYTHM_CLIP_SEQUENCE_CONFLICT");
      await expect(inspectEditedRhythm({ ...rhythmRequest, clips: shots.map((shot, index) => index === 1 ? { ...shot, path: shots[0]!.path } : shot) }))
        .rejects.toThrow("RHYTHM_EDIT_FAILED");
      const fastTimeline = { ...timeline, segments: timeline.segments.map((segment) => ({ ...segment, speed: 2 })) };
      await expect(inspectEditedRhythm({ ...rhythmRequest, timeline: fastTimeline }))
        .rejects.toThrow("RHYTHM_EXPLICIT_1X_REQUIRED");
      expect(await inspectEditedRhythm({ ...rhythmRequest, timeline: fastTimeline, profile: "natural", declared: null }))
        .toMatchObject({ status: "unverified", passed: true, artisticQuality: "unverified" });
      await expect(inspectEditedRhythm({ ...rhythmRequest, timeline: { ...timeline,
        sources: timeline.sources.map((source, index) => index === 0 ? { ...source, sha256: "a".repeat(64) } : source) } }))
        .rejects.toThrow("RHYTHM_SOURCE_HASH_CHANGED");
      await expect(inspectEditedRhythm({ ...rhythmRequest, ffprobe: path.join(root, "missing-ffprobe") })).rejects.toThrow();
      // The JavaScript engine accepts the documented runtime contract; its inferred TS signature treats default [] as never[].
      const build = buildDeliveryPackage as (options: Record<string, unknown>) => Promise<any>;
      const base = await build({ project, shots, variants: ["clean-tech", "bold-promo"],
        outDir: path.join(root, "delivery"), bins, env });
      expect(base.passed).toBe(true);
      for (const variant of base.variants) verifyFinal(variant.artifacts.video.path, variant.layers.sound, `build-${variant.id}`);
      const oldSounds = base.variants.map((variant: any) => ({ file: variant.layers.sound.file, sha256: hash(variant.layers.sound.file),
        source: readJson(variant.layers.sound.reportFile).source.file, sourceSha256: readJson(variant.layers.sound.reportFile).source.sha256 }));
      const noMusic = await reedit({ projectPath: base.projectPath, deliveryDir: base.outDir, ...expectedBase(base.projectPath),
        patch: { bgm: { variantId: "clean-tech", enabled: false } }, bins, env });
      expect(noMusic.executed).toBe(true);
      const noMusicProject = readJson(noMusic.projectPath);
      for (const variant of noMusic.variants) {
        const stored = noMusicProject.layers.variants.find((entry: any) => entry.id === variant.id);
        verifyFinal(variant.video.path, { file: path.resolve(noMusic.targetDir, stored.sound.path),
          reportFile: path.resolve(noMusic.targetDir, stored.sound.receiptPath) }, `bgm-off-${variant.id}`);
      }
      for (const value of oldSounds) { expect(hash(value.file)).toBe(value.sha256); expect(hash(value.source)).toBe(value.sourceSha256); }
      const backToMusic = await reedit({ projectPath: noMusic.projectPath, deliveryDir: base.outDir, ...expectedBase(noMusic.projectPath),
        patch: { bgm: { variantId: "clean-tech", enabled: true, style: "corporate-clean", policy: "keep-all" } }, bins, env });
      expect(backToMusic.executed).toBe(true);
      const restoredProject = readJson(backToMusic.projectPath);
      for (const variant of backToMusic.variants) {
        const stored = restoredProject.layers.variants.find((entry: any) => entry.id === variant.id);
        verifyFinal(variant.video.path, { file: path.resolve(backToMusic.targetDir, stored.sound.path),
          reportFile: path.resolve(backToMusic.targetDir, stored.sound.receiptPath) }, `bgm-on-${variant.id}`);
      }
      const copyOnly = await reedit({ projectPath: backToMusic.projectPath, deliveryDir: base.outDir, ...expectedBase(backToMusic.projectPath),
        patch: { copy: { body: "仅文字修改保留现有节目与音效" } }, bins, env });
      expect(copyOnly.variants.map((variant: any) => variant.video.sha256)).toEqual(backToMusic.variants.map((variant: any) => variant.video.sha256));
      const copiedProject = readJson(copyOnly.projectPath);
      for (const variant of copyOnly.variants) {
        const stored = copiedProject.layers.variants.find((entry: any) => entry.id === variant.id);
        verifyFinal(variant.video.path, { file: path.resolve(copyOnly.targetDir, stored.sound.path),
          reportFile: path.resolve(copyOnly.targetDir, stored.sound.receiptPath) }, `copy-only-${variant.id}`);
      }
      for (const value of oldSounds) { expect(hash(value.file)).toBe(value.sha256); expect(hash(value.source)).toBe(value.sourceSha256); }
      console.info("independent stems sound final evidence", JSON.stringify({ paidCalls: 0, sourceFiles: sources.size,
        sourceFilesUnchanged: true, independentMusicExcluded: true, embeddedOldMusicExcluded: true, evidence }));
    } catch (error) {
      const report = (error as { report?: { checks?: Array<{ hard?: boolean; ok?: boolean }>; stages?: unknown } }).report;
      if (report) console.error("independent stems sound failure evidence", JSON.stringify({
        checks: report.checks?.filter((check) => check.hard && !check.ok), stages: report.stages }));
      throw error;
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }, 300_000);
});
