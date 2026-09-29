/**
 * 配乐复检文案与重试语义（2026-09-24 真机复核回归）：
 *
 * 真机现象（交付包实测）：素材全程连续现场声（既无绝对静音、也找不到相对安静窗口）时，
 * `clean-tech` 变体的配乐复检报「配乐可闻度 **nulldB** < 3dB」——那是**没有发生过**的比较；
 * 实际结论是「测不到」，而且降 3dB 重试同样测不到（不是电平问题）。
 *
 * 本例把两种结论钉住：测得偏低 → 报实测差值与目标；测不到 → 报原因与可执行下一步，
 * 并显式标 `retryable=false`（post-bridge 据此跳过一次注定白跑的 -3dB 混音）。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { BgmError, enforceMixChecks, evaluateMixChecks, explainMusicAudibility, measuredDuckingDepthDb } from "./core.mjs";

describe("配乐可闻度结论文案", () => {
  it("测得偏低：报实测差值 vs 目标", () => {
    const text = explainMusicAudibility({
      musicPresenceDb: 1.5, targetDb: 3, measured: true, quietWindowSource: "quiet-window",
    });
    expect(text).toBe("配乐可闻度 1.5dB < 3dB");
  });

  it("测不到（无安静窗口）：不写未发生的比较，给出原因与下一步", () => {
    const text = explainMusicAudibility({
      musicPresenceDb: null, targetDb: 3, measured: false, quietWindowSource: "none",
    });
    expect(text).toContain("无法测量");
    expect(text).toContain("连续现场声");
    expect(text).toContain("未核实");
    expect(text).not.toContain("dB <");
  });

  it("测不到（其它来源）：把 quietWindowSource 如实写出，便于排查", () => {
    const text = explainMusicAudibility({ measured: false, quietWindowSource: "relative-quiet(noise+12dB)" });
    expect(text).toContain("relative-quiet(noise+12dB)");
    expect(text).not.toContain("dB <");
  });
});

describe("配乐复检错误的重试语义", () => {
  it("retryable 随构造参数如实传递（false = 不许降档重试）", () => {
    expect(new BgmError("配乐复检未通过", "verify_failed", false).retryable).toBe(false);
    expect(new BgmError("配乐复检未通过", "verify_failed", true).retryable).toBe(true);
  });
});

describe("配乐复检失败关闭", () => {
  const measured = {
    loudnessAfter: { integratedLufs: -14, truePeakDbtp: -1.2 },
    targetLufs: -14,
    truePeak: -1,
    musicPresenceDb: 4,
    musicPresenceTargetDb: 3,
    speechToMusicMarginDb: 6,
    duckingDepthDb: -8,
    policy: "keep-dialogue",
  };

  it("真峰值测不到不得判通过；非 music-only 的让位测不到也不得判通过", () => {
    expect(evaluateMixChecks(measured)).toEqual({
      loudness_ok: true,
      true_peak_ok: true,
      music_audible: true,
      dialogue_preserved: true,
      ducking_applied: true,
    });
    expect(evaluateMixChecks({ ...measured, loudnessAfter: { integratedLufs: -14, truePeakDbtp: null } }).true_peak_ok).toBe(false);
    expect(evaluateMixChecks({ ...measured, duckingDepthDb: null }).ducking_applied).toBe(false);
    expect(evaluateMixChecks({ ...measured, policy: "music-only", duckingDepthDb: null }).ducking_applied).toBe(false);
    expect(evaluateMixChecks({ ...measured, dialogueStatus: "not_applicable", duckingDepthDb: null }).ducking_applied).toBe(true);
    expect(evaluateMixChecks({ ...measured, speechToMusicMarginDb: null }).dialogue_preserved).toBe(false);
    expect(measuredDuckingDepthDb(-20, -28)).toBe(-8);
    expect(measuredDuckingDepthDb(null, -28)).toBeNull();
  });

  it.each([
    ["loudness_ok", { loudnessAfter: { integratedLufs: -10, truePeakDbtp: -1.2 } }],
    ["true_peak_ok", { loudnessAfter: { integratedLufs: -14, truePeakDbtp: -0.5 } }],
    ["ducking_applied", { duckingDepthDb: -2 }],
  ] as const)("%s 失败时删除产物并抛 verify_failed，不能返回成功回执", async (failedName, override) => {
    const dir = mkdtempSync(join(tmpdir(), "bgm-verify-"));
    const output = join(dir, "mix.wav");
    writeFileSync(output, "unverified mix");
    try {
      const checks = evaluateMixChecks({ ...measured, ...override });
      expect(checks[failedName as keyof typeof checks]).toBe(false);
      await expect(enforceMixChecks({ checks, output, retryable: true })).rejects.toMatchObject({
        code: "verify_failed",
        retryable: true,
        failedChecks: [failedName],
        message: expect.stringContaining(failedName),
      });
      expect(existsSync(output)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("缺少检查键也不能被空对象伪装成全通过", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bgm-verify-"));
    const output = join(dir, "mix.wav");
    writeFileSync(output, "unverified mix");
    try {
      await expect(enforceMixChecks({ checks: {}, output })).rejects.toMatchObject({ code: "verify_failed" });
      expect(existsSync(output)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("删除产物失败时仍报告失败检查键且不可重试", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bgm-verify-"));
    writeFileSync(join(dir, "keep.txt"), "nonempty directory");
    try {
      const checks = { ...evaluateMixChecks(measured), true_peak_ok: false };
      await expect(enforceMixChecks({ checks, output: dir, retryable: true })).rejects.toMatchObject({
        code: "verify_failed",
        retryable: false,
        failedChecks: ["true_peak_ok"],
        message: expect.stringContaining("删除产物失败"),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
