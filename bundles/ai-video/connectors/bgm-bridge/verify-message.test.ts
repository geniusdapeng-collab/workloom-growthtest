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
import { describe, expect, it } from "vitest";

import { BgmError, explainMusicAudibility } from "./core.mjs";

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
