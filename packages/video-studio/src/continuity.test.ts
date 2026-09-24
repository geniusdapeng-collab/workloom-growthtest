import { describe, expect, it } from "vitest";
import { auditContinuity } from "./continuity.js";

const costume = "月白色苏式改良旗袍，立领盘扣";
const makeup = "通透裸妆：自然眉形、豆沙唇";

const baseShots = [
  {
    shotId: "SC-01", duration: 5, costume, makeup,
    scene: "苏州平江路清晨的青石板主街，河岸垂柳", lighting: "上午十点柔和散射日光",
    sceneDescription: "河道水面反光，白墙黛瓦", action: "女主向前走两步，看向镜头",
    props: "河道、白墙", mood: "开场留白", pacing: "舒缓", camera_movement: "向右横移跟拍",
    dialogue: [{ text: "慢慢走，才看得见。" }]
  },
  {
    shotId: "SC-02", duration: 5, costume, makeup,
    scene: "平江路石拱桥边，河道摇橹船经过", lighting: "午后斜光",
    sceneDescription: "河道水面反光，白墙黛瓦，桥面石阶", action: "女主正面走近镜头",
    props: "河道、白墙", mood: "推进", pacing: "中速", camera_movement: "向右推近",
    dialogue: [{ text: "桥下的船，走得比人慢。" }]
  }
];

describe("连贯性导演评审（6 问 + 5 维）", () => {
  it("正常双镜：无硬阻断、5 维满分、6 问齐备", () => {
    const report = auditContinuity(baseShots, { targetSeconds: 10, projectId: "VID-T" });
    expect(report.approved).toBe(true);
    expect(report.blocking).toEqual([]);
    expect(report.questions).toHaveLength(6);
    expect(report.dimensions).toHaveLength(5);
    expect(report.score).toBe(report.dimensions.reduce((s, d) => s + d.score, 0));
  });

  it("无理由换造型 → 硬阻断（同一个人在同一场戏里悄悄换款）", () => {
    const shots = baseShots.map((s, i) => i === 1 ? { ...s, costume: "藕粉色对襟上袄" } : s);
    const report = auditContinuity(shots, { targetSeconds: 10 });
    expect(report.approved).toBe(false);
    expect(report.blocking.join(" ")).toContain("造型核心出现 2 组");
    expect(report.blocking.join(" ")).toContain("上袄|藕粉");
    expect(report.dimensions[0]!.score).toBeLessThan(20);
  });

  it("显式声明换装则不算不一致", () => {
    const shots = baseShots.map((s, i) => i === 1 ? { ...s, costume: "藕粉色对襟上袄", action: "换上另一套衣服后走出" } : s);
    expect(auditContinuity(shots, { targetSeconds: 10 }).approved).toBe(true);
  });

  it("总时长与目标不符、台词重复 → 硬阻断", () => {
    const shots = baseShots.map((s, i) => i === 1 ? { ...s, dialogue: [{ text: "慢慢走，才看得见。" }] } : s);
    const report = auditContinuity(shots, { targetSeconds: 20 });
    expect(report.approved).toBe(false);
    expect(report.blocking.join(" ")).toMatch(/总时长|台词重复/);
  });

  it("时段跨档倒退 → 软信号（有闪回交代则通过）", () => {
    const dark = { ...baseShots[0]!, shotId: "SC-03", scene: "入夜的平江路，灯笼亮起", lighting: "夜景灯笼光" };
    const morning = { ...baseShots[1]!, shotId: "SC-04", scene: "清晨的青石板街", lighting: "上午十点日光" };
    const soft = auditContinuity([dark, morning], { targetSeconds: 10 });
    expect(soft.approved).toBe(true);
    expect(soft.checks.find((c) => c.id === "time-flow")!.pass).toBe(false);
    const flashback = auditContinuity([{ ...dark, director_instruction: "闪回前一晚" }, morning], { targetSeconds: 10 });
    expect(flashback.checks.find((c) => c.id === "time-flow")!.pass).toBe(true);
  });

  it("相邻镜运动方向相反 → 软信号（读成来回折返）", () => {
    const shots = baseShots.map((s, i) => i === 1 ? { ...s, camera_movement: "向左摇摄" } : s);
    const report = auditContinuity(shots, { targetSeconds: 10 });
    expect(report.approved).toBe(true);
    expect(report.checks.find((c) => c.id === "direction-continuity")!.pass).toBe(false);
  });

  it("没有收束镜 → 软信号，节奏维扣分", () => {
    const shots = baseShots.map((s) => ({ ...s, mood: "中段推进", pacing: "中速" }));
    const report = auditContinuity(shots, { targetSeconds: 10 });
    expect(report.checks.find((c) => c.id === "emotion-arc")!.pass).toBe(false);
    expect(report.dimensions.at(-1)!.score).toBeLessThan(20);
  });

  it("'避免日落'不会被读成日落（时段判定先剥否定语境）", () => {
    const shots = [
      { ...baseShots[0]!, lighting: "上午十点柔和散射日光，白平衡中性；避免日落时段的金色调、避免暖黄滤镜" },
      { ...baseShots[1]!, lighting: "午后斜光，方向明确；避免橙色调" }
    ];
    const report = auditContinuity(shots, { targetSeconds: 10 });
    expect(report.checks.find((c) => c.id === "time-flow")!.detail).toContain("morning → afternoon");
  });

  it("道具：同一处空间里**故事道具**消失 → 软信号；纯陈设消失不算", () => {
    const place = { scene: "平江路支巷，粉墙黛瓦与白墙木格窗", sceneDescription: "巷口青石板" };
    const withStoryProp = { shotId: "SC-A", duration: 5, costume, makeup, ...place, props: "红灯笼、青石板", action: "站在灯笼下向前走两步", dialogue: [{ text: "第一句台词在这里。" }] };
    const storyPropGone = { shotId: "SC-B", duration: 5, costume, makeup, ...place, props: "青石板", action: "继续向前走两步", dialogue: [{ text: "第二句台词接着来。" }] };
    const setDressingGone = { ...storyPropGone, action: "继续向前走两步，手里什么都没拿" };
    const warned = auditContinuity([withStoryProp, storyPropGone], { targetSeconds: 10 });
    expect(warned.checks.find((c) => c.id === "prop-continuity")!.pass).toBe(false);
    // 陈设版：道具还在 props 里但 action 没提到 → 不算故事道具，不告警
    const quiet = auditContinuity([{ ...withStoryProp, action: "站在巷口向前走两步" }, setDressingGone], { targetSeconds: 10 });
    expect(quiet.checks.find((c) => c.id === "prop-continuity")!.pass).toBe(true);
  });
});
