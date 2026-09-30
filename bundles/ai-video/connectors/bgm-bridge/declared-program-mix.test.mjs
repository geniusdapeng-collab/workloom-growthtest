/**
 * 声明式直混真机冒烟（T-2026-0930-0014/0015）。
 *
 * 背景（2026-09-30 复盘）：本机没有"独立音轨签发者"（`WORKLOOM_AUDIO_STEM_SIGNING_SECRET` 未配置）时，
 * 旧行为是 fail-closed 直接拒绝 —— 结果"本地无版权曲库直接选曲混音"这条**正常交付路径被卡死**
 * （真机：成片迟迟出不来，配乐环节报 `audio_stems_source_unverified`）。
 * 现在：调用方**显式声明** `--declared-program-mix` 就能直混，但回执必须如实标注未取证，不冒充签章分轨。
 *
 * 本测试是"happy path 冒烟"：没有签发者时也必须能出片；同时守住 fail-closed 的另一半——
 * 不声明、也没有签章时，仍然必须拒绝。
 */
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
     * 1.0–2.0s 留一段静音当"安静窗口"：配乐可闻度复检需要它，否则会以"无法测量"拒绝出片（fail-closed）。
     */
    encode(["-f", "lavfi", "-i", "color=c=black:s=320x240:d=3",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
      "-filter_complex", "[1:a]volume='if(between(t,1,2),0,1)':eval=frame[a]",
      "-map", "0:v", "-map", "[a]",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source]);
    encode(["-f", "lavfi", "-i", "sine=frequency=1760:duration=3", "-c:a", "pcm_s16le", music]);
  });

  it("无签发者 + 显式声明：直混出片，回执如实标注 declared-unverified", async () => {
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
    assert.equal(result.independentAudio.sourceAuthority, "declared-unverified");
    assert.equal(result.independentAudio.stemsVerified, false);
    assert.equal(result.independentAudio.retainedMusicExcluded, false);
    assert.equal(result.independentAudio.dialogueStatus, "declared-unverified");
    assert.match(String(result.independentAudio.duckingSource ?? ""), /program-mix/);
    /** 不冒充签章：声明路径不得出现 signed/passed 的来源口径 */
    assert.notEqual(result.independentAudio.sourceAuthority, "passed");
  });

  it("不声明、也没有签章：仍然 fail-closed（audio_stems_source_unverified）", async () => {
    const env = {
      ...process.env,
      WORKLOOM_AUDIO_STEM_SIGNING_SECRET: "",
      WORKLOOM_AUDIO_STEM_SIGNING_KEY_ID: "",
      WORKLOOM_BGM_DISCOVER: "0",
      WORKLOOM_BGM_ALLOWED_ROOTS: root
    };
    await assert.rejects(
      () => mix({
        input: source, output: path.join(root, "unsigned.mp4"), bgmPath: music,
        policy: "keep-dialogue", musicLevelDb: -24, duckingDb: 12,
        fadeInSec: 0.1, fadeOutSec: 0.1, align: false, section: "full",
        env, bins
      }),
      (error) => {
        assert.equal(error?.code, "audio_stems_source_unverified");
        return true;
      }
    );
  });
});
