/**
 * 声明式直混真机冒烟（T-2026-0930-0014/0015）。
 *
 * 背景（2026-09-30 复盘）：本机没有"独立音轨签发者"（`WORKLOOM_AUDIO_STEM_SIGNING_SECRET` 未配置）时，
 * 旧行为是 fail-closed 直接拒绝 —— 结果"本地无版权曲库直接选曲混音"这条**正常交付路径被卡死**
 * （真机：成片迟迟出不来，配乐环节报 `audio_stems_source_unverified`）。
 * 现在默认保留原片混合音轨，回执必须如实标注 native-source，不冒充签章分轨。
 * 显式签章引用仍须通过验证；兼容声明不能使损坏引用变成默认原声。
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mix } from "./core.mjs";

const bins = {
  ffmpeg: process.env.WORKLOOM_POST_FFMPEG_PATH || process.env.WL_FFMPEG || "ffmpeg",
  ffprobe: process.env.WORKLOOM_POST_FFPROBE_PATH || process.env.WL_FFPROBE || "ffprobe"
};
const hasMedia = (() => {
  try {
    execFileSync(bins.ffmpeg, ["-version"], { stdio: "ignore" });
    execFileSync(bins.ffprobe, ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const suite = hasMedia ? describe : describe.skip;
const encode = (args) => execFileSync(bins.ffmpeg, ["-hide_banner", "-v", "error", "-y", ...args], { timeout: 60000, stdio: "pipe" });

let root, source, music;

suite("配乐声明式直混（无签章签发者时的正常交付路径）", () => {
  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "bgm-declared-"));
    source = path.join(root, "source.mp4");
    music = path.join(root, "music.wav");
    /**
     * 源片 = 对白（440Hz）+ 环境混音成品；曲库曲目 = 1760Hz（与对白频段错开，便于复检）。
     * 1.0–2.0s 留一段静音；静音与有声都应完成配方处理，不做源片声音品质否决。
     */
    encode(["-f", "lavfi", "-i", "color=c=black:s=320x240:d=3",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
      "-filter_complex", "[1:a]volume='if(between(t,1,2),0,1)':eval=frame[a]",
      "-map", "0:v", "-map", "[a]",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source]);
    encode(["-f", "lavfi", "-i", "sine=frequency=1760:duration=3", "-c:a", "pcm_s16le", music]);
  });

  after(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });
  it("无签发者 + 兼容显式声明：直混出片，回执如实标注原生节目且未作分轨或品质认证", async () => {
    const env = {
      ...process.env,
      /** 明确模拟"本机没有签发者" */
      WORKLOOM_AUDIO_STEM_SIGNING_SECRET: "",
      WORKLOOM_AUDIO_STEM_SIGNING_KEY_ID: "",
      WORKLOOM_BGM_DISCOVER: "0",
      /** 路径监狱：本地曲库根（正是真机被拦的那类路径）必须放行 */
      WORKLOOM_BGM_ALLOWED_ROOTS: root
    };
    const output = path.join(root, "declared.mp4");
    const result = await mix({
      input: source, output, bgmPath: music, declaredProgramMix: true,
      policy: "keep-dialogue", musicLevelDb: -24, duckingDb: 12,
      fadeInSec: 0.1, fadeOutSec: 0.1, align: false, section: "full",
      env, bins
    });
    assert.ok(fs.existsSync(result.output.path), "声明式直混必须产出成片");
    assert.equal(result.independentAudio.sourceAuthority, "native-source");
    assert.equal(result.independentAudio.stemsVerified, false);
    assert.equal(result.independentAudio.retainedMusicExcluded, false);
    assert.match(String(result.independentAudio.duckingSource ?? ""), /program-mix/);
    assert.equal(result.metrics, null); assert.equal(result.qualityReviewPerformed, false); assert.equal(result.qualityRetries, 0);
    /** 不冒充签章：声明路径不得出现 signed/passed 的来源口径 */
    assert.notEqual(result.independentAudio.sourceAuthority, "passed");
    const presentedAudio = execFileSync(bins.ffmpeg, ["-hide_banner", "-v", "error", "-i", result.output.path,
      "-map", "0:a:0", "-ar", "48000", "-ac", "2", "-f", "s16le", "pipe:1"], { timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
    assert.ok(presentedAudio.length / 4 >= 3 * 48000, "最终AAC必须保全原画面三秒时间钟，不能因-shortest丢掉尾部采样");
    const finalVideo = JSON.parse(execFileSync(bins.ffprobe, ["-v", "error", "-count_frames", "-select_streams", "v:0",
      "-show_entries", "stream=nb_read_frames", "-of", "json", result.output.path], { timeout: 60000, encoding: "utf8" }));
    assert.equal(Number(finalVideo.streams[0].nb_read_frames), 75, "合流不得修改原画面帧数");
  });

  it("不声明、也没有签章：默认消费原片音轨，完成单次请求混音", async () => {
    const env = {
      ...process.env,
      WORKLOOM_AUDIO_STEM_SIGNING_SECRET: "",
      WORKLOOM_AUDIO_STEM_SIGNING_KEY_ID: "",
      WORKLOOM_BGM_DISCOVER: "0",
      WORKLOOM_BGM_ALLOWED_ROOTS: root
    };
    const result = await mix({
        input: source, output: path.join(root, "unsigned.mp4"), bgmPath: music,
        policy: "keep-dialogue", musicLevelDb: -24, duckingDb: 12,
        fadeInSec: 0.1, fadeOutSec: 0.1, align: false, section: "full",
        env, bins
      });
    assert.equal(result.independentAudio.embeddedAudioUsed, true);
    assert.equal(result.independentAudio.sourceAuthority, "native-source");
    assert.ok(fs.existsSync(result.output.path));
  });

  it("高峰值混合源执行请求混音，不做响度/峰值/让位品质审核或重试", async () => {
    const peaked = path.join(root, "high-crest.mp4");
    encode(["-f", "lavfi", "-i", "color=c=black:s=160x120:r=24:d=8",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=8",
      "-filter_complex", "[1:a]volume='if(between(t,0,0.04),6,if(between(t,2,4),0,0.6))':eval=frame[a]",
      "-map", "0:v", "-map", "[a]", "-c:v", "libx264", "-c:a", "aac", "-shortest", peaked]);
    const digest = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    const beforeHash = digest(peaked);
    const result = await mix({ input: peaked, output: path.join(root, "high-crest-master.mp4"), bgmPath: music,
      declaredProgramMix: true, policy: "keep-dialogue", musicLevelDb: -24, duckingDb: 14,
      fadeInSec: 0.1, fadeOutSec: 0.1, align: false, section: "full",
      env: { ...process.env, WORKLOOM_BGM_ALLOWED_ROOTS: root, WORKLOOM_BGM_DISCOVER: "0" }, bins });
    assert.equal(digest(peaked), beforeHash, "原片只读");
    assert.equal(result.checks.processingSucceeded, true); assert.equal(result.checks.sourceBytesUnchanged, true);
    assert.equal(result.independentAudio.stemsVerified, false);
    assert.equal(result.loudness.status, "not-measured"); assert.equal(result.qualityRetries, 0); assert.equal(result.metrics, null);
    assert.ok(Math.abs(result.output.durationSeconds - 8) < 0.04);
  }, { timeout: 120000 });

  it("静音混合源正常配乐，静音不是二次品质否决", async () => {
    const silent = path.join(root, "silent.mp4"), output = path.join(root, "silent-result.mp4");
    encode(["-f", "lavfi", "-i", "color=c=black:s=160x120:d=3",
      "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", "3",
      "-c:v", "libx264", "-c:a", "aac", "-shortest", silent]);
    const result = await mix({ input: silent, output, bgmPath: music, declaredProgramMix: true,
      env: { ...process.env, WORKLOOM_BGM_ALLOWED_ROOTS: root }, bins });
    assert.equal(fs.existsSync(output), true); assert.equal(result.qualityReviewPerformed, false);
  });

  it("真实 mix/best CLI 的显式坏引用不得被兼容声明或默认原声路径吞掉", () => {
    const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.mjs");
    const invalid = [null, false, 42, "native", [], {}, { dir: path.join(root, "nonexistent-stems") }];
    let checked = 0;
    for (const command of ["mix", "best"]) {
      for (const compatibilityFlag of [false, true]) {
        for (let index = 0; index < invalid.length; index += 1) {
          const reference = path.join(root, `invalid-${index}.json`);
          fs.writeFileSync(reference, JSON.stringify(invalid[index]));
          const output = path.join(root, `bad-${command}-${compatibilityFlag}-${index}.mp4`);
          const result = spawnSync(process.execPath, [cli, command, "--in", source, "--out", output,
            ...(command === "mix" ? ["--bgm", music] : ["--source-policy", "compose-only"]),
            "--audio-stems", reference, ...(compatibilityFlag ? ["--declared-program-mix"] : [])],
          { env: { ...process.env, WORKLOOM_BGM_ALLOWED_ROOTS: root, WORKLOOM_AUDIO_STEM_SIGNING_SECRET: "", WORKLOOM_BGM_DISCOVER: "0" }, encoding: "utf8", timeout: 30_000 });
          assert.equal(result.status, 3, `${command} ${JSON.stringify(invalid[index])}: ${result.stderr}`);
          assert.match(result.stderr, /audio_stems_source_unverified|audio_stems_stale|audio_stems_invalid|bad_request|not_found/);
          assert.equal(fs.existsSync(output), false);
          checked += 1;
        }
        const noValue = spawnSync(process.execPath, [cli, command, "--in", source, "--out", path.join(root, `naked-${command}-${compatibilityFlag}.mp4`),
          ...(command === "mix" ? ["--bgm", music] : []), "--audio-stems", ...(compatibilityFlag ? ["--declared-program-mix"] : [])],
        { env: { ...process.env, WORKLOOM_BGM_ALLOWED_ROOTS: root }, encoding: "utf8", timeout: 30_000 });
        assert.equal(noValue.status, 3); assert.match(noValue.stderr, /audio_stems_source_unverified/); checked += 1;
      }
    }
    assert.equal(checked, 32);
  }, { timeout: 120_000 });
});
