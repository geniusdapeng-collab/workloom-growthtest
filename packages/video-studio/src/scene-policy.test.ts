import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

/**
 * T2 企业品牌宣传片（2026-09-28）：知识与 T1 同 schema，
 * 但配比、必备镜头清单、黑名单与"厚重感/未来感二选一"不同——
 * 既有用例同时守住「多命中按人物主线 + priority 判优」这条新增选择规则。
 */
const t2 = policies.find((item) => item.id === "enterprise-brand")!;

function brandShot(index: number, tags: string[], fields: Partial<ScenePolicyShot>): ScenePolicyShot {
  return {
    shotId: `EB-${String(index).padStart(2, "0")}`, duration: 4.5, policyTags: tags,
    scene: "未来感总部园区，明亮通透，整洁有序",
    composition: "大全景，黄金时刻蓝天白云，画面干净规整",
    camera_movement: "航拍推进穿越园区",
    ...fields,
  } as ScenePolicyShot;
}

function brandCompliant(): ScenePolicyInput {
  return {
    title: "企业形象片：未来感总部与智能产线",
    shots: [
      brandShot(1, ["wide", "moving"], { composition: "航拍大全景黄金时刻，总部大楼与园区全景，推镜展示规模与格局" }),
      brandShot(2, ["wide", "moving"], { composition: "大全景城市天际线，明亮通透，升降镜俯瞰园区秩序", scene: "未来感总部园区，蓝天天际线" }),
      brandShot(3, ["environment", "moving"], { composition: "挑高大堂纵深，穿过前厅，灯光明亮有层次", scene: "总部大堂：大理石与金属线条，明亮整洁" }),
      brandShot(4, ["environment", "moving"], { composition: "开放办公区纵深，轨道移镜穿过整齐工位与落地窗", scene: "开放办公区，绿植与协作氛围，明亮通透" }),
      brandShot(5, ["environment", "moving"], { composition: "智能产线纵深，机械臂与自动化流水线，金属质感锐利，冷暖对比层次分明", scene: "智能产线，整洁有序、地面干净" }),
      brandShot(6, ["detail", "moving"], { composition: "工艺细节微距特写，材质纹理清晰，缓推镜", scene: "精密工艺台面，灯光明亮" }),
      brandShot(7, ["detail", "moving"], { composition: "产品细节特写微距，结构锐利干净，移镜", scene: "展厅产品矩阵，明亮通透" }),
      brandShot(8, ["people", "moving"], { composition: "团队协作中景，员工专注工作，跟拍移动，灯光明亮有层次", scene: "开放办公区，未来感协作氛围，整洁明亮" }),
      brandShot(9, ["people", "moving"], { composition: "工程师专注工作状态中景，推镜靠近", scene: "研发实验室，白大褂规范作业，明亮通透" }),
      brandShot(10, ["wide", "moving"], { composition: "日落城市天际线升华收尾，愿景画面与社会责任夜景灯火通明，画面通透，推镜", scene: "城市天际线，日落黄金时刻，空气通透" }),
    ],
  };
}

describe("T2 企业品牌宣传知识条目", () => {
  it("非人物主线需求自动选中 T2；同时命中人物主线时按人物优先与 priority 判优", () => {
    expect(t2.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    const selected = selectScenePolicy({ title: "企业品牌宣传片：未来感总部与智能产线", shots: [] }, null, policies);
    expect(selected.policy?.id).toBe("enterprise-brand");
    /** 客户需求里点了人 + 企业宣传片 → T1（人物主线·priority 100）胜出，判优理由写进 reason。 */
    const personLed = selectScenePolicy({ title: "企业宣传片，企业负责人陈卓出镜讲述品牌故事", shots: [] }, null, policies);
    expect(personLed.policy?.id).toBe("commercial-person");
    expect(personLed.reason).toContain("判优胜出");
    /** 显式指定永远优先。 */
    expect(selectScenePolicy({ title: "企业宣传片", scenePolicy: { id: "enterprise-brand" }, shots: [] }, null, policies).policy?.id)
      .toBe("enterprise-brand");
  });

  it("合规十镜满足 航拍/穿越/细节/人文/升华 与气质路线，且配比达标", () => {
    const report = auditScenePolicy(brandCompliant(), t2);
    expect(report.defects).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.ratios.wide?.share ?? 0).toBeGreaterThanOrEqual(0.2);
    expect(report.ratios.environment?.share ?? 0).toBeGreaterThanOrEqual(0.3);
    expect(report.ratios.detail?.share ?? 0).toBeGreaterThanOrEqual(0.2);
    expect(report.ratios.people?.share ?? 0).toBeGreaterThanOrEqual(0.15);
    expect(report.ratios.moving?.share ?? 0).toBeGreaterThanOrEqual(0.4);
    expect(report.planCues["航拍定调镜头"]?.found).toBe(true);
    expect(report.planCues["气质路线"]?.found).toBe(true);
  });

  it("缺航线定调/缺细节/运动不足/气质路线缺失/空镜无人/陈旧空间都判硬失败", () => {
    const broken = brandCompliant();
    /** ① 删掉航拍定调与升华收尾：wide 跌到 20% 以下且必备镜头缺失 */
    broken.shots = broken.shots.filter((item) => !["EB-01", "EB-02", "EB-10"].includes(item.shotId));
    /** ② 细节镜改成固定机位 → moving 不足，且细节取证消失 */
    broken.shots = broken.shots.map((item) => item.shotId === "EB-06" ? { ...item, policyTags: ["detail"], camera_movement: "固定机位" } : item);
    /** ③ 画面出现监控画质/物料乱堆 + 受限老旧空间 */
    broken.shots = broken.shots.map((item) => item.shotId === "EB-03"
      ? { ...item, scene: "老旧办公楼昏暗走廊，物料乱堆、监控画质的长镜头" } : item);
    const report = auditScenePolicy(broken, t2);
    const rules = report.defects.map((item) => item.rule);
    expect(report.passed).toBe(false);
    expect(rules).toContain("required-plan-cue");
    expect(rules).toContain("ratio-min");
    expect(rules).toContain("quality-floor");
    expect(rules).toContain("restricted-location");
    expect(report.defects).toContainEqual(expect.objectContaining({ rule: "required-plan-cue", detail: expect.stringContaining("航拍定调镜头") }));
  });

  it("受限的陈旧空间可凭客户逐镜原话例外，但空镜无人等品质底线不可豁免", () => {
    const input = brandCompliant();
    input.shots = input.shots.map((item) => item.shotId === "EB-03"
      ? { ...item, scene: "老旧办公楼走廊，但拍摄整洁、灯光明亮通透" } : item);
    input.scenePolicy = { exceptions: [{ rule: "restricted-location", shotId: "EB-03", term: "老旧办公楼",
      customerRequest: "请拍我们 1958 年的老旧办公楼做历史传承段落", source: "brief#scene" }] };
    const withException = auditScenePolicy(input, t2);
    expect(withException.defects.some((item) => item.rule === "restricted-location")).toBe(false);
    expect(withException.exceptionsApplied).toContainEqual(expect.objectContaining({ shotId: "EB-03", term: "老旧办公楼" }));

    const dirty = brandCompliant();
    dirty.shots = dirty.shots.map((item) => item.shotId === "EB-04"
      ? { ...item, scene: "开放办公区，物料乱堆、地面油污" } : item);
    dirty.scenePolicy = { exceptions: [{ rule: "restricted-location", shotId: "EB-04", term: "物料乱堆",
      customerRequest: "客户说可以拍到「物料乱堆」的真实工作状态", source: "brief#scene" }] };
    const dirtyReport = auditScenePolicy(dirty, t2);
    expect(dirtyReport.defects).toContainEqual(expect.objectContaining({ rule: "quality-floor", shotId: "EB-04" }));
  });

  it("品质底线词写成「无…」会在加载期被拒（肯定文本归一后永不命中的陷阱）", () => {
    const dir = mkdtempSync(join(tmpdir(), "scene-policy-"));
    try {
      const broken = { ...JSON.parse(JSON.stringify(t2)), qualityFloorTerms: ["无人感"] } as Record<string, unknown>;
      delete broken.sourceSha256;
      writeFileSync(join(dir, "broken.json"), `${JSON.stringify(broken, null, 2)}\n`, "utf8");
      expect(() => loadScenePolicies(dir)).toThrow(/qualityFloorTerms 不能以/);
      const ok = { ...JSON.parse(JSON.stringify(t2)), qualityFloorTerms: ["物料乱堆"] } as Record<string, unknown>;
      delete ok.sourceSha256;
      writeFileSync(join(dir, "broken.json"), `${JSON.stringify(ok, null, 2)}\n`, "utf8");
      expect(loadScenePolicies(dir)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
