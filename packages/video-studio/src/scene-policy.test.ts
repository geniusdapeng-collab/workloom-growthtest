import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { applyScenePolicy, auditScenePolicy, loadScenePolicies, selectScenePolicy, type ScenePolicyInput, type ScenePolicyShot } from "./scene-policy.js";
import { buildPlatePrompt } from "./plate-prompt.js";
import { prepareShotPrompt } from "./shot-spec.js";

const policies = loadScenePolicies(resolve(import.meta.dirname, "../../../bundles/ai-video/library/scene-policies"));
const t1 = policies.find((item) => item.id === "commercial-person")!;
const costume = "陈卓穿合体高定商务小黑裙，珍珠耳钉与细吊坠";
function shot(index: number, tags: string[], composition: string, camera = "固定新闻访谈机位"): ScenePolicyShot {
  return {
    shotId: `CZ-${String(index).padStart(2, "0")}`, duration: 4.5, policyTags: tags,
    scene: "明亮的别墅式企业会客厅首层正式访谈位", composition,
    camera_movement: camera, costume,
    speechMode: "on-camera", speechScene: "interview",
    dialogue: [{ speaker: "陈卓", text: "欢迎了解方案。" }],
  };
}
function compliant(): ScenePolicyInput {
  const specs: Array<[string[], string, string?]> = [
    [["wide", "moving"], "大场面全景，人物陈卓站在大厅中央", "缓推镜展示空间纵深"],
    [["wide"], "广角全景，人物陈卓在画面中保留视觉主导", "固定新闻访谈机位"],
    [["medium", "moving"], "半身中景，人物与大厅材质同框", "轨道移镜围绕访谈位"],
    [["medium"], "腰部以上中景，人物与实体织物墙屏同框"],
    [["medium"], "膝上中景，人物站在会客厅首层"],
    [["person-close", "moving"], "面部近景特写，神态沉稳", "轻推镜到人物双眼"],
    [["person-close"], "胸部以上人物特写，右手说明手势"],
    [["person-close"], "面部近景，人物直视镜头"],
    [["environment-detail"], "实体羊毛经纬纹样特写与材质工艺微距"],
    [["environment-detail"], "胡桃木与大理石材质特写，人物不入镜"],
  ];
  return {
    title: "陈卓正式商务短片", character: { id: "chen-zhuo" },
    shots: specs.map(([tags, composition, camera], i) => {
      const item = shot(i + 1, tags, composition, camera);
      item.action = [
        "正面直视镜头，以坚定眼神和从容停掌开始口播",
        "镜头从45°侧前方看她自然微笑",
        "侧面轮廓可辨，她用一个小手势说明重点",
        "背影气场后转身，留下沉思瞬间",
      ][i] ?? "自然讲述并保持专业气质";
      if (i === 8) item.props = "实体羊毛交织纹样与材质工艺";
      if (tags.includes("environment-detail")) {
        item.speechMode = "voice-over";
        delete item.speechScene;
      }
      return item;
    }),
  };
}

describe("T1 商业真人出镜知识条目", () => {
  it("知识库可加载并按正式商务需求自动选用", () => {
    expect(t1.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    const selected = selectScenePolicy(compliant(), { audience: "企业负责人", goal: "销售演示" }, policies);
    expect(selected.policy?.id).toBe("commercial-person");
    expect(selectScenePolicy({ title: "山间风景片", shots: [] }, null, policies).policy).toBeNull();
    expect(() => selectScenePolicy({ title: "母婴亲子短视频", shots: [] }, null, policies)).toThrow(/没有可核实/);
    expect(() => selectScenePolicy({ ...compliant(), scenePolicy: { id: "missing" } }, null, policies)).toThrow(/未知片型/);
    const raw = selectScenePolicy({ title: "给企业负责人看的销售演示，陈卓出镜口播", shots: [] },
      { request: { audience: "企业负责人", format: "正式商务短片" } }, policies);
    expect(raw.policy?.id).toBe("commercial-person");
    expect(raw.evidence).toContain("brief.request.format: 正式商务短片");
  });

  it("完整十镜按时长计算四景别和运动配比，局部渲染不能改变审计输入", () => {
    const report = auditScenePolicy(compliant(), t1);
    expect(report.defects).toEqual([]);
    expect(report.ratios.wide?.share).toBe(0.2);
    expect(report.ratios.medium?.share).toBe(0.3);
    expect(report.ratios["person-close"]?.share).toBe(0.3);
    expect(report.ratios["environment-detail"]?.share).toBe(0.2);
    expect(report.ratios.moving?.share).toBe(0.3);
  });

  it("不足配比、虚标景别、虚标运动和口播场景缺证据均判硬失败", () => {
    const input = compliant();
    input.shots[0]!.policyTags = ["medium", "moving"];
    input.shots[2]!.camera_movement = "固定机位";
    input.shots[3]!.speechScene = "news";
    const rules = auditScenePolicy(input, t1).defects.map((item) => item.rule);
    expect(rules).toContain("ratio-min");
    expect(rules).toContain("tag-evidence");
    expect(rules).toContain("motion-consistency");
    expect(rules).toContain("speech-scene");
  });

  it("客户特定工地场景需逐镜引用原话；杂乱与死黑底线不能被例外豁免", () => {
    const input = compliant();
    input.shots[0]!.scene = "客户工地现场，地面杂乱且面部死黑";
    expect(auditScenePolicy(input, t1).defects.map((item) => item.rule)).toContain("restricted-location");
    input.scenePolicy = { exceptions: [{ rule: "restricted-location", shotId: "CZ-01", term: "工地", customerRequest: "请展示我的工地", source: "brief#scene" }] };
    const report = auditScenePolicy(input, t1);
    expect(report.exceptionsApplied).toHaveLength(1);
    expect(report.defects.some((item) => item.rule === "restricted-location")).toBe(false);
    expect(report.defects.filter((item) => item.rule === "quality-floor")).toHaveLength(2);
  });

  it("每镜亮度和正式场景有独立证据，休闲服饰只接受逐镜客户原话例外", () => {
    const input = compliant();
    input.shots[0]!.scene = "昏暗的普通客厅";
    input.shots[0]!.costume = "休闲装";
    const rules = auditScenePolicy(input, t1).defects.map((item) => item.rule);
    expect(rules).toContain("required-shot-cue");
    expect(rules).toContain("restricted-costume");
    input.scenePolicy = { exceptions: [{ rule: "restricted-costume", shotId: "CZ-01", term: "休闲装", customerRequest: "请穿休闲装讲解", source: "brief#wardrobe" }] };
    const report = auditScenePolicy(input, t1);
    expect(report.exceptionsApplied).toHaveLength(1);
    expect(report.defects.some((item) => item.rule === "restricted-costume")).toBe(false);
    expect(report.defects.some((item) => item.rule === "quality-floor")).toBe(true);
  });

  it("提示注入保留台词、构图、机位和时长，并进入关键帧与视频共用的 sceneDescription", () => {
    const card = compliant().shots[0]!;
    const applied = applyScenePolicy(card, t1);
    expect(applied.sceneDescription).toContain("T1正式商务片");
    expect(applied.sceneDescription).toContain("正式访谈");
    expect(applied.dialogue).toEqual(card.dialogue);
    expect(applied.composition).toBe(card.composition);
    expect(applied.camera_movement).toBe(card.camera_movement);
    expect(applied.duration).toBe(card.duration);
    expect(applyScenePolicy(applied, t1).sceneDescription).toBe(applied.sceneDescription);
    expect(buildPlatePrompt(applied, { characterName: "陈卓" })).toContain("T1正式商务片");
    expect(prepareShotPrompt(applied, { ratio: "9:16", resolution: "1080p" }).prompt).toContain("T1正式商务片");
    const prewritten = applyScenePolicy({ ...card, prompt: "已有镜头提示词" }, t1);
    expect(prewritten.prompt).toContain("T1正式商务片");
    expect(applyScenePolicy(prewritten, t1).prompt).toBe(prewritten.prompt);
  });

  it("仅写职业名也识别有人出镜，禁用承诺从实际台词取证", () => {
    const professional = { ...t1, id: "professional-test", autoSignals: ["法律咨询"], speechProhibitionTerms: ["包赢"] };
    const selected = selectScenePolicy({ title: "律师讲解法律咨询", shots: [] }, null, [professional]);
    expect(selected.policy?.id).toBe("professional-test");
    const input = compliant();
    input.shots[0]!.dialogue = [{ speaker: "律师", text: "这案子包赢。" }];
    expect(auditScenePolicy(input, professional).defects).toContainEqual(expect.objectContaining({ rule: "speech-prohibition", shotId: "CZ-01" }));
    input.shots[0]!.dialogue = [{ speaker: "律师", text: "不做结果承诺。" }];
    expect(auditScenePolicy(input, professional).defects.some((item) => item.rule === "speech-prohibition")).toBe(false);
  });

  it("政策注入的提示词不能冒充原始镜头画面证据", () => {
    const policy = { ...t1, requiredPlanCues: { "高级材质": ["高级材质"] } };
    const input = compliant();
    input.shots = input.shots.map((item) => applyScenePolicy(item, policy));
    const report = auditScenePolicy(input, policy);
    expect(report.defects).toContainEqual(expect.objectContaining({ rule: "required-plan-cue", shotId: null }));
  });
});
