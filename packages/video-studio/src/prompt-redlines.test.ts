import { describe, expect, it } from "vitest";
import { auditFilmRedlines, auditShotRedlines, PROMPT_REDLINE_POLICY_VERSION } from "./prompt-redlines.js";

const base = { shotId: "T-01", scene: "酒店大堂", sceneDescription: "明亮通透的大堂", action: "她开口", props: "自助入住机", negative: "无卡通、无文字水印" };

describe("花钱前提示词红线（提高一次过率）", () => {
  it("屏幕镜头必须写明虚化 + 负面排除文字与 LOGO", () => {
    const bad = auditShotRedlines({ ...base, sceneDescription: "机器触控面亮着界面" });
    expect(bad.map((i) => i.id)).toEqual(expect.arrayContaining(["screen-must-be-blurred", "screen-no-text-negative", "screen-no-logo-negative"]));
    const good = auditShotRedlines({ ...base, sceneDescription: "触控面只呈现柔和光晕（界面内容虚化不可辨认）", negative: "无界面文字、无图标、无LOGO、无屏幕可读文字" });
    expect(good.filter((i) => i.hard)).toEqual([]);
  });
  it("证件镜头必须不可辨认并排除字迹号码（隐私红线）", () => {
    const bad = auditShotRedlines({ ...base, props: "身份证放到感应区" });
    expect(bad.map((i) => i.id)).toEqual(expect.arrayContaining(["document-must-be-unreadable", "document-no-text-negative"]));
  });
  it("卡片类道具要约束数量，避免幻影道具", () => {
    expect(auditShotRedlines({ ...base, props: "房卡吐出" }).map((i) => i.id)).toContain("prop-duplication");
  });
  it("时间轴说定住、运镜没写定住 → 拦截", () => {
    expect(auditShotRedlines({ ...base, timeline: "T00:02.5–T00:06 完全定住", camera_movement: "缓推" }).map((i) => i.id)).toContain("camera-timeline-mismatch");
  });
  it("帧率不一致 → 拦截；整片汇总区分 hard/soft", () => {
    expect(auditShotRedlines({ ...base, constraint: "9:16画幅，1080x1920，30fps，MP4格式" }, { fps: 24 }).map((i) => i.id)).toContain("fps-mismatch");
    const film = auditFilmRedlines([{ ...base, sceneDescription: "落地窗" }, { ...base, shotId: "T-02" }], { fps: 24 });
    expect(film.policy).toBe(PROMPT_REDLINE_POLICY_VERSION);
    expect(film.soft.length).toBeGreaterThan(0);
  });
});
