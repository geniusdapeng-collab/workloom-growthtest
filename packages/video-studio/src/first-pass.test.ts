import { describe, expect, it } from "vitest";
import { assessFilmFirstPass, assessShotFirstPass, FIRST_PASS_POLICY_VERSION } from "./first-pass.js";

describe("一次过就绪度（花钱前判定）", () => {
  it("画面里让模型'别写字'的镜头判高风险，并给出移出画面的建议", () => {
    const r = assessShotFirstPass({ shotId: "S1", sceneDescription: "机器触控面亮着界面", props: "身份证放到感应区", negative: "无文字水印" });
    expect(r.blockers.map((b) => b.id)).toEqual(expect.arrayContaining(["text-in-frame:screen", "text-in-frame:document"]));
    expect(r.suggestions.join()).toContain("移出取景");
  });
  it("已把风险物移出画面/虚化 → 不算阻塞", () => {
    const r = assessShotFirstPass({ shotId: "S2", sceneDescription: "只拍机身背面与取卡口，画面内不出现屏幕" , props: "房卡", negative: "无多余手指" });
    expect(r.blockers).toEqual([]);
  });
  it("秒级'定住'与推镜并存 → 高风险（模型做不到）", () => {
    const r = assessShotFirstPass({ shotId: "S3", timeline: "T00:02.5–T00:06 完全定住", camera_movement: "缓推后定住" });
    expect(r.blockers.map((b) => b.id)).toContain("timing-lock-vs-motion");
  });
  it("服装锁到面料配饰、同镜多诉求 → 中风险（计入分数但不阻塞）", () => {
    const r = assessShotFirstPass({ shotId: "S4", costume: "黑色粗花呢套装配珍珠耳饰及膝裙", composition: "广角全景，人物中近景占比并保持视觉主导，机身清晰可辨" });
    const ids = r.findings.map((f) => f.id);
    expect(ids).toContain("costume-over-specified");
    expect(ids).toContain("competing-subjects");
    expect(r.blockers).toEqual([]);
  });
  it("整片：给 canary 渲染顺序（风险高的先渲），policy 版本可追溯", () => {
    const film = assessFilmFirstPass([
      { shotId: "S1", camera_movement: "固定机位", timeline: "T00:00–T00:05 稳定", composition: "中景" },
      { shotId: "S2", sceneDescription: "屏幕界面清晰可见", timeline: "T00:02 定住", camera_movement: "缓推" }
    ], { fps: 24 });
    expect(film.policy).toBe(FIRST_PASS_POLICY_VERSION);
    expect(film.ready).toBe(false);
    expect(film.renderOrder[0]).toBe("S2");
  });
});
