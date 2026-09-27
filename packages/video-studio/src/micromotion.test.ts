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

describe("微动作增强（按原意图适用的通道）", () => {
  it("逐路判断适用性：说话镜不强制呼吸节拍，每条有原意图依据", () => {
    const trace = planMicromotion(walkingShot);
    expect(trace.applied.map((c) => c.id)).toEqual(["facial", "eyes", "body", "fusion"]);
    for (const channel of trace.applied) {
      expect(channel.clause.length, `${channel.id} 必须有画面语言`).toBeGreaterThan(6);
      expect(channel.because.length, `${channel.id} 必须说明依据`).toBeGreaterThan(2);
    }
    expect(trace.applied.find((c) => c.id === "body")!.clause).toContain("重心");
    expect(trace.channels.find((c) => c.id === "breath")!.status).toBe("not_applicable");
    expect(trace.status).toBe("passed");
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

describe("微动作适用性与失败关闭", () => {
  it.each([
    { scene: "无人办公室空镜", portraits: [] },
    { scene: "手表商品微距", character: "手表" },
    { scene: "猫坐在窗边", action: "坐着观察" },
    { subject: { count: 0 }, scene: "房间", character: "预设女主" },
  ])("非人物主体不添加人的微动作：%j", (card) => {
    const out = applyMicromotion(card);
    expect(out.card).toEqual(card);
    expect(out.trace.status).toBe("not_applicable");
    expect(out.trace.applied).toEqual([]);
    expect(out.trace.charDelta).toBe(0);
  });

  it("未知主体不冒充不适用或通过", () => {
    const out = applyMicromotion({ mood: "温柔", action: "静静地" });
    expect(out.trace.status).toBe("unverified");
    expect(out.card.action).toBe("静静地");
  });

  it.each([
    [{ scene: "女人躺在床上", action: "保持熟睡，双眼闭合", mood: "温柔" }, ["body", "breath"]],
    [{ scene: "女人背影", action: "站立观察窗外", mood: "惊喜" }, ["body", "breath"]],
    [{ scene: "女人在广场", composition: "远景", action: "向前走", mood: "温柔" }, ["body", "breath"]],
    [{ scene: "女人的手", composition: "只有双手入画", action: "拿着一本书", mood: "温柔" }, ["body"]],
  ] as const)("可见部位限制通道：%j", (card, channels) => {
    const out = applyMicromotion(card);
    expect(out.trace.status).toBe("passed");
    expect(out.trace.applied.map((item) => item.id)).toEqual(channels);
    expect(out.trace.text).not.toMatch(/笑意|眨眼|抬眼/);
  });

  it("蹲姿保持蹲姿；坐姿不变成单脚站姿；否定不反转", () => {
    const crouch = applyMicromotion({ scene: "女人在屋内", action: "保持蹲姿，不要起身，不笑", mood: "温柔" });
    expect(crouch.trace.text).toContain("保持原蹲姿");
    expect(crouch.trace.text).not.toMatch(/起身|站起|笑意|微笑/);
    const seated = applyMicromotion({ scene: "女人坐在椅子上", action: "看书" });
    expect(seated.trace.text).toContain("保持原坐姿");
    expect(seated.trace.text).not.toMatch(/一只脚|站姿|站起/);
  });

  it("禁止眨眼与无台词时不添加对应表演", () => {
    const out = applyMicromotion({ scene: "女人站立", action: "看向镜头，不眨眼", pacing: "结尾留半拍", dialogue: "无台词" });
    expect(out.trace.applied.map((item) => item.id)).not.toEqual(expect.arrayContaining(["eyes", "fusion"]));
    expect(out.trace.text).not.toMatch(/眨眼|台词|句末/);
  });

  it("未知旧标记与篡改贡献不形成已完成回执", () => {
    const old = { scene: "女人站立", action: "【微动作】起身" };
    const oldOut = applyMicromotion(old);
    expect(oldOut.trace.status).toBe("unverified");
    expect(oldOut.card).toEqual(old);
    const first = applyMicromotion(walkingShot).card;
    first.action = String(first.action).replace("重心", "起身");
    const altered = applyMicromotion(first);
    expect(altered.trace.status).toBe("unverified");
    expect(altered.trace.errorCode).toBe("ENHANCEMENT_PROVENANCE_INVALID");
    expect(altered.card).toEqual(first);
  });

  it("源动作改变后重新计算，JSON保存后幂等；返回的应用列表都在真实字段中", () => {
    const first = applyMicromotion({ scene: "女人在屋内", action: "坐着看书" });
    const revised = JSON.parse(JSON.stringify(first.card));
    revised.action = revised.action.replace("坐着看书", "保持蹲姿");
    const second = applyMicromotion(revised);
    expect(second.trace.sourceHash).not.toBe(first.trace.sourceHash);
    expect(second.trace.text).toContain("保持原蹲姿");
    expect(second.trace.text).not.toContain("保持原坐姿");
    for (const channel of second.trace.applied) expect(second.card.action).toContain(channel.clause);
    const third = applyMicromotion(JSON.parse(JSON.stringify(second.card)));
    expect(JSON.stringify(third.card)).toBe(JSON.stringify(second.card));
    expect(third.trace.charDelta).toBe(0);
  });

  it("仅 fields 中的原动作完整进入消费字段，特殊字符空格和标点不丢失", () => {
    const card = { fields: { scene: "女人坐在椅子上", action: "  看书；🙂  " } };
    const out = applyMicromotion(card);
    expect(String(out.card.action).startsWith(card.fields.action)).toBe(true);
    expect(applyMicromotion(JSON.parse(JSON.stringify(out.card))).card).toEqual(out.card);
    expect(out.card.fields).toEqual(card.fields);
    expect(out.trace.charDelta).toBe(String(out.card.action).length - card.fields.action.length);
    expect(out.trace.charDelta).toBeLessThanOrEqual(200);
  });

  it("起始坐姿不吞掉起身动作；奔跑不强塞轻缓呼吸；手部特写不添面部表演", () => {
    const rising = applyMicromotion({ scene: "女人坐在椅子上", action: "起身站起" });
    expect(rising.trace.text).toContain("原起身方向");
    expect(rising.trace.text).not.toContain("保持原坐姿");
    const running = applyMicromotion({ scene: "男人在操场", action: "全速奔跑" });
    expect(running.trace.text).not.toContain("呼吸轻缓");
    const hands = applyMicromotion({ scene: "女人整理书桌", composition: "手部特写", action: "拿起茶杯", mood: "惊喜" });
    expect(hands.trace.applied.map((item) => item.id)).toEqual(["body"]);
    expect(hands.trace.text).not.toMatch(/眉|嘴|眼|呼吸/);
  });

  it("无效结构化字段与非有限数值返回未验证，不覆盖原文", () => {
    for (const card of [{ scene: "女人站立", action: { text: "看向镜头" } }, { ...walkingShot, duration: NaN }]) {
      const out = applyMicromotion(card);
      expect(out.trace.status).toBe("unverified");
      expect(out.card).toEqual(card);
    }
  });

  it("并发纯调用没有共享计数或跨镜污染", async () => {
    const outputs = await Promise.all(Array.from({ length: 20 }, (_, i) => Promise.resolve(applyMicromotion({ ...walkingShot, shotId: `SC-${i}` }))));
    expect(new Set(outputs.map((out) => out.trace.sourceHash)).size).toBe(20);
    for (const out of outputs) {
      expect(out.trace.charDelta).toBeLessThanOrEqual(200);
      expect(out.trace.text).not.toContain("…");
      expect(String(out.card.action).length - walkingShot.action.length).toBe(out.trace.charDelta);
    }
  });
});
