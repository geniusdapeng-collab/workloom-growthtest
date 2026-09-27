import { describe, expect, it } from "vitest";
import {
  appendShotContributions, ENHANCEMENT_META_KEY, normalizeShotIntent, resolveShotIntent,
  restoreShotContributions, shotIntentHash, splitShotAssertions,
} from "./shot-intent.js";

describe("原始镜头意图：主体、动作与可见性", () => {
  it.each([
    [{ scene: "无人会议室空镜", portraits: [], character: "默认模特" }, "environment"],
    [{ scene: "手表商品微距", camera_movement: "缓慢推近" }, "object"],
    [{ scene: "树林中的鹰，特写鹰眼" }, "animal"],
    [{ scene: "女人拿着手表", action: "坐在椅子上" }, "person"],
    [{ scene: "双人远景，两人站在桥上" }, "person"],
    [{ scene: "无人机航拍女人走过广场" }, "person"],
    [{ scene: "办公室", subject: { kind: "environment" }, character: "预设角色" }, "environment"],
  ] as const)("源卡 %j → %s", (card, kind) => {
    const before = structuredClone(card);
    const intent = normalizeShotIntent(card);
    expect(intent.subject.kind).toBe(kind);
    expect(intent.subject.hasPerson).toBe(kind === "person");
    expect(card).toEqual(before);
  });

  it.each([
    [{ scene: "女人背对镜头", composition: "近景" }, false, "unknown"],
    [{ scene: "女人的手部", composition: "只有双手入画" }, false, "unknown"],
    [{ scene: "女人走过广场", composition: "远景" }, false, "unknown"],
    [{ scene: "女人睡在床上", action: "保持熟睡，双眼闭合" }, true, "sleeping"],
    [{ scene: "女人在屋内", action: "保持蹲姿，不要起身" }, true, "crouching"],
    [{ scene: "女人在屋内", action: "坐着看书" }, true, "sitting"],
  ] as const)("可见性与原姿态守恒：%j", (card, faceVisible, posture) => {
    const intent = normalizeShotIntent(card);
    expect(intent.subject.faceVisible).toBe(faceVisible);
    expect(intent.subject.posture).toBe(posture);
    if (posture === "sleeping") {
      expect(intent.subject.eyesClosed).toBe(true);
      expect(intent.subject.visibleParts).not.toContain("eyes");
    }
  });

  it("无人物与双人人数不由 portraits 空数组或默认角色制造", () => {
    expect(normalizeShotIntent({ scene: "房间", subject: { count: 0 }, portraits: ["全局角色"] }).subject.count).toBe(0);
    expect(normalizeShotIntent({ scene: "两人坐在窗边", character: "甲、乙" }).subject.count).toBe(2);
  });

  it("只读原动作判断走动，服装和运镜中的跟随词不能给人物加走路", () => {
    const intent = normalizeShotIntent({ scene: "女人坐在椅子上", action: "看书", costume: "裙摆随行走摆动", camera_movement: "缓慢跟随" });
    expect(intent.performance.walking).toBe(false);
    expect(intent.subject.posture).toBe("sitting");
  });
});

describe("原始镜头意图：否定、时段、光源与台词", () => {
  it.each(["无手机", "无任何电脑", "无显示器", "无键盘", "无磨损", "无划痕", "无任何使用痕迹", "无指纹", "无杯痕"])("设备/状态领域否定不充当肯定事实：%s", (phrase) => {
    const assertions = splitShotAssertions(`现场空镜；${phrase}，但保留窗光`);
    expect(assertions.negative).toContain(phrase);
    expect(assertions.positive).toBe("现场空镜；保留窗光");
  });
  it("定语否定仍保留原物件，有限规则不误伤无人机、无线设备或无反相机", () => {
    expect(splitShotAssertions("无划痕的胡桃木桌面")).toEqual({ positive: "胡桃木桌面", negative: ["无划痕的"] });
    for (const text of ["无人机航拍街道", "无线鼠标放在桌面", "无反相机架在三脚架上", "无光污染的星空"]) {
      expect(splitShotAssertions(text).positive).toContain(text.startsWith("无光污染") ? "星空" : text);
    }
  });
  it("否定不倒置，转折后的肯定仍保留", () => {
    const intent = normalizeShotIntent({ scene: "女人在窗边", action: "不笑；保持蹲姿，不要起身", camera_movement: "不要推近，但固定机位观察" });
    expect(intent.performance.forbidSmile).toBe(true);
    expect(intent.performance.forbidRise).toBe(true);
    expect(intent.performance.action).not.toContain("起身");
    expect(intent.camera.modes).toEqual(["static"]);
    expect(splitShotAssertions("无光污染的星空银河").positive).toContain("星空银河");
    expect(splitShotAssertions("不舍地看向远方").positive).toContain("不舍");
  });

  it("暖色右侧窗光不变成左窗、夜景或蓝调", () => {
    const intent = normalizeShotIntent({ scene: "下午的室内，女人坐着", lighting: "暖色自然光从右侧窗户照入；不要蓝调或冷白光" });
    expect(intent.scene.timeOfDay).toContain("afternoon");
    expect(intent.scene.timeOfDay).not.toContain("blueHour");
    expect(intent.scene.lightDirections).toEqual(["right"]);
    expect(intent.scene.lightSources).toEqual(expect.arrayContaining(["window", "daylight"]));
    expect(intent.scene.temperatures).toContain("warm");
    expect(intent.scene.temperatures).not.toContain("cool");
  });

  it("只看见窗户不证明光来自窗，烛台不证明点燃", () => {
    const intent = normalizeShotIntent({ scene: "室内白墙，窗外是青瓦", props: "未点燃的烛台" });
    expect(intent.scene.lightSources).not.toContain("window");
    expect(intent.scene.lightSources).not.toContain("candle");
  });

  it.each([undefined, "", "无台词", [], [{ text: "" }]])("空台词 %j 不制造说话节拍", (dialogue) => {
    expect(normalizeShotIntent({ scene: "女人看书", dialogue }).performance.hasDialogue).toBe(false);
  });

  it("说出的否定句仍是台词；不是用否定剥离去删说话内容", () => {
    const intent = normalizeShotIntent({ scene: "女人看向镜头", dialogue: [{ text: "不要怕。" }] });
    expect(intent.performance.dialogue).toEqual(["不要怕。"]);
    expect(intent.performance.hasDialogue).toBe(true);
  });

  it("深景深与有限数值有明确合同，字段键顺序不影响源哈希", () => {
    expect(normalizeShotIntent({ depth_of_field: "深景深，前景到地平线清晰" }).scene.depthMode).toBe("deep");
    expect(shotIntentHash({ b: 2, a: 1 })).toBe(shotIntentHash({ a: 1, b: 2 }));
    expect(() => normalizeShotIntent({ duration: NaN })).toThrow("SHOT_INTENT_INPUT_INVALID");
    expect(() => normalizeShotIntent({ subject: { count: -1 } })).toThrow("SHOT_INTENT_INPUT_INVALID");
  });

  it.each([null, undefined, [], "空镜"])("非对象来料不能形成通过意图：%j", (input) => {
    expect(() => normalizeShotIntent(input)).toThrow("SHOT_INTENT_INPUT_INVALID");
  });
});

describe("增强贡献与幂等的可验证来源", () => {
  const card = { shotId: "SC-01", scene: "女人坐在椅子上", action: "  看书；  " };
  const options = { owner: "micromotion" as const, policyVersion: "test/v1", sourceHash: normalizeShotIntent(card).sourceHash };
  const additions = [{ field: "action", text: "【微动作】保持坐姿，呼吸轻缓" }];

  it("原文逐字保留，来源可经 JSON 保存后恢复，重复增强完全相同", () => {
    const first = appendShotContributions(card, options, additions);
    expect(String(first.card.action).startsWith(card.action)).toBe(true);
    const saved = JSON.parse(JSON.stringify(first.card));
    expect(restoreShotContributions(saved).card).toEqual(card);
    expect(normalizeShotIntent(saved)).toEqual(normalizeShotIntent(card));
    expect(appendShotContributions(saved, options, additions).card).toEqual(first.card);
  });

  it("作者修改原文但保留已知后缀时，只摘除本系统贡献，保留新原文", () => {
    const first = appendShotContributions(card, options, additions).card;
    first.action = String(first.action).replace("看书", "看窗外");
    const restored = restoreShotContributions(first).card;
    expect(restored.action).toBe("  看窗外；  ");
    expect(normalizeShotIntent(first).sourceHash).not.toBe(options.sourceHash);
  });

  it("未知或篡改的增强来源拒绝，不用全局字符串替换删除用户内容", () => {
    const first = appendShotContributions(card, options, additions).card;
    first.action = String(first.action).replace("呼吸轻缓", "起身离开");
    expect(() => restoreShotContributions(first)).toThrow("ENHANCEMENT_PROVENANCE_INVALID");
    expect(() => restoreShotContributions({ ...card, [ENHANCEMENT_META_KEY]: { schemaVersion: "unknown", owners: {} } })).toThrow("ENHANCEMENT_PROVENANCE_INVALID");
  });

  it("字段预算不足时整句丢弃，不截原文或生成半句话", () => {
    const out = appendShotContributions(card, options, [{ ...additions[0]!, maxFieldChars: 10 }]);
    expect(out.card).toEqual(card);
    expect(out.applied[0]).toEqual(expect.objectContaining({ writtenChars: 0, dropped: "field-over-budget" }));
  });

  it("结构化原字段不能被增强器替换成拼接字符串", () => {
    expect(() => appendShotContributions({ ...card, action: { text: "看书" } }, options, additions)).toThrow("SHOT_INTENT_FIELD_INVALID");
  });

  it("显式意图只接受与当前原卡一致的版本，不能复用旧 sourceHash", () => {
    const intent = normalizeShotIntent(card);
    expect(resolveShotIntent(card, intent)).toEqual(intent);
    expect(() => resolveShotIntent({ ...card, action: "起身" }, intent)).toThrow("SHOT_INTENT_STALE");
    expect(() => resolveShotIntent(card, { ...intent, subject: { ...intent.subject, kind: "object" } })).toThrow("SHOT_INTENT_STALE");
  });
});
