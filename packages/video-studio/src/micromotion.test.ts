import { describe, expect, it } from "vitest";
import { applyMicromotion, MICROMOTION_MARKER, planMicromotion } from "./micromotion.js";

const walkingShot = {
  shotId: "SC-01",
  duration: 5,
  action: "女主从巷口向前走两步，看向镜头微笑",
  mood: "温柔收束：嘴角浅笑",
  pacing: "结尾放慢半拍",
  dialogue: [{ text: "慢慢走，才看得见。" }]
};

describe("微动作增强（5 路）", () => {
  it("五路齐备：面部/眼神/身体/呼吸/融合，且每条都能说出依据", () => {
    const trace = planMicromotion(walkingShot);
    expect(trace.applied.map((c) => c.id)).toEqual(["facial", "eyes", "body", "breath", "fusion"]);
    for (const channel of trace.applied) {
      expect(channel.clause.length, `${channel.id} 必须有画面语言`).toBeGreaterThan(6);
      expect(channel.because.length, `${channel.id} 必须说明依据`).toBeGreaterThan(2);
    }
    expect(trace.applied.find((c) => c.id === "body")!.clause).toContain("重心");
    expect(trace.applied.find((c) => c.id === "breath")!.because).toContain("5s");
  });

  it("情绪词决定面部口径（惊喜 → 眉先动，不是泛泛的'表情自然'）", () => {
    const trace = planMicromotion({ shotId: "SC-02", duration: 5, action: "抬眼", mood: "惊喜：眼睛发亮" });
    expect(trace.applied.find((c) => c.id === "facial")!.clause).toContain("眉峰");
  });

  it("只写画面语言，不写 f 值/ISO/帧率等技术参数", () => {
    const trace = planMicromotion(walkingShot);
    expect(/f\/|ISO|帧率|焦段/.test(trace.text)).toBe(false);
  });

  it("增量有界（≤200 字），且相同输入结果确定", () => {
    const a = planMicromotion(walkingShot);
    const b = planMicromotion(walkingShot);
    expect(a.text).toBe(b.text);
    expect(a.charDelta).toBeLessThanOrEqual(200);
  });

  it("幂等：已增强的卡片不会被叠加第二遍", () => {
    const first = applyMicromotion(walkingShot);
    expect(first.card.action).toContain(MICROMOTION_MARKER);
    expect(first.card.action).toContain(walkingShot.action);
    const second = applyMicromotion(first.card);
    expect(second.trace.skipped).toContain("幂等");
    expect(second.trace.charDelta).toBe(0);
    expect(second.card.action).toBe(first.card.action);
  });

  it("不改动原对象（返回新卡片，便于对照与回滚）", () => {
    const before = { ...walkingShot };
    applyMicromotion(walkingShot);
    expect(walkingShot).toEqual(before);
  });
});
