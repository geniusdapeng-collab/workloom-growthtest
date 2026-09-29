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
    env.WORKLOOM_POST_ALLOWED_ROOTS = root;
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
      expect(result.avSync.ok).toBe(true);
      expect(result.avSync.measured).toBe(3);
      expect(result.avSync.maxAbsLagMs).toBeLessThanOrEqual(40);
      expect(readJson(output.replace(/\.mp4$/, ".av-sync.json"))).toMatchObject({ ok: true, degraded: false });
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
    expect(delivery.master.avSync.measured).toBe(3);
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
    expect(tooLong.passed).toBe(false);
    // 配乐质量是独立闸门；如音频合成样本不足以通过，必须在整包结果和报告中如实失败。
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
