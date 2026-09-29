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

/**
 * T3 专业服务等身出镜（2026-09-28）：中景≥35% / 人近特≥30% / 信任状细节≥15% / 工作状态≥15% / 运动 20–30%，
 * 并守住"庄重可信底线"（生活化场景、娱乐化包装、职业禁忌画面）与合规承诺（稳赚/包赢/保证治好…）。
 */
const t3 = policies.find((item) => item.id === "professional-service")!;

function serviceShot(index: number, tags: string[], duration: number, fields: Partial<ScenePolicyShot>): ScenePolicyShot {
  return {
    shotId: `PS-${String(index).padStart(2, "0")}`, duration, policyTags: tags,
    scene: "明亮的律所独立办公室，整洁有序，书架与卷宗整齐排列",
    composition: "坐姿中景，人物在办公桌后居于画面中心",
    camera_movement: "固定机位",
    costume: "深色正装西装与衬衫领带，整洁挺括",
    ...fields,
  } as ScenePolicyShot;
}

function serviceCompliant(): ScenePolicyInput {
  return {
    title: "主任律师出镜解读合同风险",
    shots: [
      serviceShot(1, ["medium"], 4.5, { composition: "坐姿中景，人物在办公桌后居于画面中心，书架前，画面干净明亮" }),
      serviceShot(2, ["medium"], 4.5, { composition: "腰部以上中景，会客室沙发对谈，环境明亮整洁" }),
      serviceShot(3, ["medium", "moving"], 4.5, { composition: "半身中景，独立办公室内讲解，背景干净有序", camera_movement: "平稳横移" }),
      serviceShot(4, ["medium"], 4.5, { composition: "中景，会议室白板前讲解，画面明亮通透" }),
      serviceShot(5, ["medium"], 4.5, { composition: "坐姿中景，办公桌后直视镜头，构图端正对称" }),
      serviceShot(6, ["person-close"], 4.5, { composition: "胸部以上近景，眼神坚定诚恳，面部光均匀无硬阴影" }),
      serviceShot(7, ["person-close"], 4.5, { composition: "面部近景特写，微笑适度，背景干净明亮" }),
      serviceShot(8, ["person-close"], 4.5, { composition: "近景呈现讲述微表情，光线柔和" }),
      serviceShot(9, ["person-close"], 4.5, { composition: "胸部以上特写，讲到结论时直视镜头" }),
      serviceShot(10, ["trust-detail"], 4.5, { composition: "信任状细节特写：证书与执业资格文件，画面干净", scene: "律师事务所办公室荣誉墙，明亮整洁" }),
      serviceShot(11, ["trust-detail"], 4.5, { composition: "专业工具与案卷卷宗的细节特写，光线干净", scene: "独立办公室桌面，卷宗整齐" }),
      serviceShot(12, ["working", "moving"], 9, { composition: "工作场景中景：翻阅卷宗并书写批注，专业状态自然", scene: "明亮的律所办公室，桌面整洁", camera_movement: "缓推" }),
    ],
  };
}

describe("T3 专业服务出镜知识条目", () => {
  it("按职业信号自动选中，合规片单满足配比与必备证据", () => {
    expect(t3.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(selectScenePolicy({ title: "主任律师出镜解读合同风险", shots: [] }, null, policies).policy?.id).toBe("professional-service");
    expect(selectScenePolicy({ title: "医生出镜讲解体检指标", shots: [] }, null, policies).policy?.id).toBe("professional-service");
    const report = auditScenePolicy(serviceCompliant(), t3);
    expect(report.defects).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.ratios.medium?.share ?? 0).toBeGreaterThanOrEqual(0.35);
    expect(report.ratios["person-close"]?.share ?? 0).toBeGreaterThanOrEqual(0.3);
    expect(report.ratios["trust-detail"]?.share ?? 0).toBeGreaterThanOrEqual(0.15);
    expect(report.ratios.working?.share ?? 0).toBeGreaterThanOrEqual(0.15);
    expect(report.ratios.moving?.share ?? 0).toBeGreaterThanOrEqual(0.2);
    expect(report.ratios.moving?.share ?? 1).toBeLessThanOrEqual(0.3);
  });

  it("缺信任状/缺工作状态/运动超标/生活化场景/娱乐包装/职业禁忌都判硬失败", () => {
    const broken = serviceCompliant();
    /** ① 去掉信任状与工作状态镜头 → 两支 required-plan-cue 与两项 ratio-min 同时失败 */
    broken.shots = broken.shots.filter((item) => item.shotId !== "PS-10" && item.shotId !== "PS-11" && item.shotId !== "PS-12");
    /** ② 运动镜头占比过高（超过 30% 上限）：给 4/9 镜打上 moving 标签 */
    broken.shots = broken.shots.map((item, index) => index < 4
      ? { ...item, policyTags: [...(item.policyTags ?? []), "moving"].filter((tag, i, list) => list.indexOf(tag) === i), camera_movement: "平稳横移" }
      : { ...item, camera_movement: "固定机位" });
    /** ③ 生活化场景 + 娱乐化包装 + 医疗禁忌 */
    broken.shots = broken.shots.map((item) => item.shotId === "PS-02"
      ? { ...item, scene: "居家客厅沙发，综艺花字包装，背景有病房" } : item);
    const report = auditScenePolicy(broken, t3);
    const rules = report.defects.map((item) => item.rule);
    expect(report.passed).toBe(false);
    expect(rules).toContain("required-plan-cue");
    expect(rules).toContain("ratio-min");
    expect(rules).toContain("ratio-max");
    expect(rules).toContain("restricted-location");
    expect(rules).toContain("quality-floor");
  });

  it("口播含合规风险承诺（稳赚/包赢/保证治好）直接拦下，且与 T1 不冲突", () => {
    const fluent = serviceCompliant();
    fluent.shots = fluent.shots.map((item) => item.shotId === "PS-06"
      ? { ...item, dialogue: [{ speaker: "律师", text: "委托我们包赢。" }], speechMode: "on-camera", speechScene: "executive-office" } : item);
    const report = auditScenePolicy(fluent, t3);
    expect(report.defects).toContainEqual(expect.objectContaining({ rule: "speech-prohibition", shotId: "PS-06" }));
    /** 与 T1 的判优：企业负责人 + 律师出镜 → T1（人物主线且 priority 更高） */
    const both = selectScenePolicy({ title: "企业负责人专访，同时请律师出镜解读合规", shots: [] }, null, policies);
    expect(both.policy?.id).toBe("commercial-person");
    expect(both.reason).toContain("判优胜出");
  });

  it("生活化场景可按客户逐镜原话例外，但职业禁忌与庄重底线不豁免", () => {
    const input = serviceCompliant();
    input.shots = input.shots.map((item) => item.shotId === "PS-03"
      ? { ...item, scene: "居家客厅改造的书房，明亮整洁、正装出镜" } : item);
    input.scenePolicy = { exceptions: [{ rule: "restricted-location", shotId: "PS-03", term: "居家客厅",
      customerRequest: "客户要求在家里的居家客厅拍摄书房段落", source: "brief#scene" }] };
    const withException = auditScenePolicy(input, t3);
    expect(withException.defects.some((item) => item.rule === "restricted-location")).toBe(false);
    expect(withException.exceptionsApplied).toContainEqual(expect.objectContaining({ shotId: "PS-03", term: "居家客厅" }));

    const forbidden = serviceCompliant();
    forbidden.shots = forbidden.shots.map((item) => item.shotId === "PS-04"
      ? { ...item, scene: "诊断室外的病房走廊，画面出现血腥" } : item);
    const report = auditScenePolicy(forbidden, t3);
    expect(report.defects.filter((item) => item.rule === "quality-floor" && item.shotId === "PS-04").length).toBeGreaterThan(0);
  });
});

/**
 * T4 科技数码测评（2026-09-28）：产品特写≥40% / 功能演示≥25% / 人物 20–30% / 氛围≤10% / 运动≥30%，
 * 必备 360° 环绕、微距工艺与"眼见为实"的功能演示；产品打亮打透与屏摄无事故是不可突破底线。
 */
const t4 = policies.find((item) => item.id === "tech-review")!;

function techShot(index: number, tags: string[], fields: Partial<ScenePolicyShot>): ScenePolicyShot {
  return {
    shotId: `TR-${String(index).padStart(2, "0")}`, duration: 4.5, policyTags: tags,
    scene: "极简科技工作台，桌面干净整洁、有线管理",
    composition: "产品打亮打透、色彩真实，主体明确",
    camera_movement: "固定机位",
    costume: "纯色简约T恤，手部干净",
    ...fields,
  } as ScenePolicyShot;
}

function techCompliant(): ScenePolicyInput {
  return {
    title: "新款手机深度测评：外观、屏幕与充电实测",
    shots: [
      techShot(1, ["product-close", "moving"], { composition: "环绕镜头 360° 缓慢旋转展示整机材质工艺，产品打亮打透、色彩真实", camera_movement: "环绕" }),
      techShot(2, ["product-close", "moving"], { composition: "微距推进拍 CNC 切边与镜头模组工艺，产品打亮打透、色彩真实", camera_movement: "微距推进" }),
      techShot(3, ["product-close"], { composition: "材质纹理特写，产品打亮打透、色彩真实" }),
      techShot(4, ["product-close", "moving"], { composition: "滑轨平移拍中框与接口特写，主体明确", camera_movement: "滑轨平移" }),
      techShot(5, ["demo", "moving"], { composition: "屏幕界面实测演示，画面清晰、演示与结论对应，产品打亮打透、色彩真实", camera_movement: "平移" }),
      techShot(6, ["demo"], { composition: "跑分实测画面，屏幕参数与口播一致、屏摄干净，产品打亮打透、色彩真实" }),
      techShot(7, ["demo"], { composition: "充电计时实测演示，界面读数清晰，产品打亮打透、色彩真实" }),
      techShot(8, ["host"], { composition: "上半身人物讲解，工作面干净整齐、面部主光充足，产品打亮打透、色彩真实" }),
      techShot(9, ["host"], { composition: "半身人物手持产品讲解，桌面整洁有序，产品打亮打透、色彩真实" }),
      techShot(10, ["ambience"], { scene: "极简科技工作台，桌面全景定调，设备质感统一、干净留白", composition: "环境氛围全景，画面极简留白、产品打亮打透、色彩真实" }),
    ],
  };
}

describe("T4 科技数码测评知识条目", () => {
  it("按测评信号选中，合规十镜满足配比与三项必备画面", () => {
    expect(t4.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(selectScenePolicy({ title: "新款手机深度测评与开箱", shots: [] }, null, policies).policy?.id).toBe("tech-review");
    expect(selectScenePolicy({ title: "智能硬件新品开箱", shots: [] }, null, policies).policy?.id).toBe("tech-review");
    const report = auditScenePolicy(techCompliant(), t4);
    expect(report.defects).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.ratios["product-close"]?.share ?? 0).toBeGreaterThanOrEqual(0.4);
    expect(report.ratios.demo?.share ?? 0).toBeGreaterThanOrEqual(0.25);
    expect(report.ratios.host?.share ?? 0).toBeGreaterThanOrEqual(0.2);
    expect(report.ratios.host?.share ?? 1).toBeLessThanOrEqual(0.3);
    expect(report.ratios.ambience?.share ?? 1).toBeLessThanOrEqual(0.1);
    expect(report.ratios.moving?.share ?? 0).toBeGreaterThanOrEqual(0.3);
    expect(report.planCues["360°环绕镜头"]?.found).toBe(true);
    expect(report.planCues["微距工艺特写"]?.found).toBe(true);
    expect(report.planCues["功能演示画面"]?.found).toBe(true);
  });

  it("缺环绕/缺演示/人物与氛围超配/杂乱桌面/屏摄事故/手持晃动都判硬失败", () => {
    const broken = techCompliant();
    /** ① 去掉环绕与微距镜 → 必备画面缺失且产品特写跌到 40% 以下 */
    broken.shots = broken.shots.filter((item) => !["TR-01", "TR-02"].includes(item.shotId));
    /** ② 演示镜全去掉 → 功能演示为 0，人物与氛围占比被动上升 */
    broken.shots = broken.shots.filter((item) => !["TR-05", "TR-06", "TR-07"].includes(item.shotId));
    /** ③ 画面出现杂乱桌面、线缆缠绕、摩尔纹与手持晃动 */
    broken.shots = broken.shots.map((item) => item.shotId === "TR-03"
      ? { ...item, scene: "杂乱桌面，线缆缠绕，桌面有零食饮料", composition: "产品打亮打透，但屏摄有摩尔纹与屏幕反光，手持晃动随手拍" } : item);
    const report = auditScenePolicy(broken, t4);
    const rules = report.defects.map((item) => item.rule);
    expect(report.passed).toBe(false);
    expect(rules).toContain("required-plan-cue");
    expect(rules).toContain("ratio-min");
    expect(rules).toContain("ratio-max");
    expect(rules).toContain("quality-floor");
  });

  it("生活化背景可凭客户原话例外（生活方式科技品类），但屏摄与产品质感底线不豁免", () => {
    const input = techCompliant();
    input.shots = input.shots.map((item) => item.shotId === "TR-08"
      ? { ...item, scene: "居家客厅的极简测评位，桌面干净整洁、有线管理，明亮" } : item);
    input.scenePolicy = { exceptions: [{ rule: "restricted-location", shotId: "TR-08", term: "居家客厅",
      customerRequest: "这是生活方式科技品类，客户要求在家里的居家客厅拍体验段落", source: "brief#scene" }] };
    const withException = auditScenePolicy(input, t4);
    expect(withException.defects.some((item) => item.rule === "restricted-location")).toBe(false);
    expect(withException.exceptionsApplied).toContainEqual(expect.objectContaining({ shotId: "TR-08", term: "居家客厅" }));

    const broken = techCompliant();
    broken.shots = broken.shots.map((item) => item.shotId === "TR-09"
      ? { ...item, composition: "产品死黑、彩色灯光污染，屏摄有频闪条纹" } : item);
    const report = auditScenePolicy(broken, t4);
    expect(report.defects.filter((item) => item.rule === "quality-floor" && item.shotId === "TR-09").length).toBeGreaterThan(0);
  });

  it("夸张震惊体与拉踩话术从实际台词取证", () => {
    const fluent = techCompliant();
    fluent.shots = fluent.shots.map((item) => item.shotId === "TR-08"
      ? { ...item, dialogue: [{ speaker: "编辑", text: "这代直接颠覆行业，吊打友商。" }], speechMode: "on-camera", speechScene: "desk-review" } : item);
    const report = auditScenePolicy(fluent, t4);
    expect(report.defects).toContainEqual(expect.objectContaining({ rule: "speech-prohibition", shotId: "TR-08" }));
  });
});

/**
 * T5 电商带货/产品种草（2026-09-28）：产品特写≥35% / 使用场景≥30% / 人物 20–30% / 氛围≥10% / 运动≥30%，
 * 必备「融入场景」「特写抽出」与向往证据；场景档次=感知价格，产品事故与廉价元素不可豁免。
 */
const t5 = policies.find((item) => item.id === "commerce-seeding")!;

function shopShot(index: number, tags: string[], fields: Partial<ScenePolicyShot>): ScenePolicyShot {
  return {
    shotId: `CS-${String(index).padStart(2, "0")}`, duration: 4.5, policyTags: tags,
    scene: "明亮精致的现代厨房，台面干净整洁",
    composition: "产品打亮打透、色彩真实，主体明确",
    camera_movement: "固定机位",
    costume: "简约质感家居服，手部干净、指甲整洁",
    ...fields,
  } as ScenePolicyShot;
}

function shopCompliant(): ScenePolicyInput {
  return {
    title: "厨房好物种草：一锅到底的珐琅锅",
    shots: [
      shopShot(1, ["product-close", "moving"], { composition: "产品特写：珐琅质感与边缘光泽，打亮打透、色彩真实", camera_movement: "环绕产品" }),
      shopShot(2, ["product-close", "moving"], { composition: "微距特写手柄纹理与釉面细节，打亮打透", camera_movement: "推进" }),
      shopShot(3, ["product-close"], { composition: "特写抽出：产品孤立于干净背景，材质光泽清晰" }),
      shopShot(4, ["product-close"], { composition: "俯拍细节特写，产品色彩真实、光泽诱人" }),
      shopShot(5, ["usage", "moving"], { scene: "明亮的现代厨房使用场景中，台面干净精致", composition: "使用演示：倒出汤汁，动作自然，产品打亮打透、色彩真实", camera_movement: "跟随" }),
      shopShot(6, ["usage"], { scene: "明亮整洁的厨房台面，场景精致有序", composition: "使用中：小火慢炖演示，产品打亮打透、光泽可辨" }),
      shopShot(7, ["usage"], { scene: "干净精致的餐桌场景，摆盘有序", composition: "试用：盛出装盘演示，色彩真实诱人" }),
      shopShot(8, ["host"], { scene: "明亮精致的开放式厨房，场景高一档", composition: "人物手持产品讲解，产品打亮打透、色彩真实，画面整洁精致" }),
      shopShot(9, ["host"], { scene: "明亮客厅使用场景中", composition: "人物半身出镜分享使用后的满足感，产品光泽真实，画面明亮精致" }),
      shopShot(10, ["ambience"], { scene: "设计感厨房的氛围镜头，晨光通透，场景空镜定调生活美学", composition: "环境氛围：把产品摆在场景中，营造高一档的使用向往" }),
    ],
  };
}

describe("T5 电商带货知识条目", () => {
  it("按带货/种草信号选中，合规十镜满足配比与三项必备画面", () => {
    expect(t5.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(selectScenePolicy({ title: "厨房好物种草：一锅到底的珐琅锅", shots: [] }, null, policies).policy?.id).toBe("commerce-seeding");
    expect(selectScenePolicy({ title: "直播切片精剪带货片", shots: [] }, null, policies).policy?.id).toBe("commerce-seeding");
    const report = auditScenePolicy(shopCompliant(), t5);
    expect(report.defects).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.ratios["product-close"]?.share ?? 0).toBeGreaterThanOrEqual(0.35);
    expect(report.ratios.usage?.share ?? 0).toBeGreaterThanOrEqual(0.3);
    expect(report.ratios.host?.share ?? 1).toBeLessThanOrEqual(0.3);
    expect(report.ratios.ambience?.share ?? 0).toBeGreaterThanOrEqual(0.1);
    expect(report.ratios.moving?.share ?? 0).toBeGreaterThanOrEqual(0.3);
    expect(report.planCues["融入场景镜头"]?.found).toBe(true);
    expect(report.planCues["特写抽出镜头"]?.found).toBe(true);
    expect(report.planCues["使用向往证据"]?.found).toBe(true);
  });

  it("缺抽出/缺使用演示/人物超配/出租屋感与产品事故都判硬失败", () => {
    const broken = shopCompliant();
    /** ① 去掉「特写抽出」与使用演示镜 → 必备画面缺失、使用镜头跌到 30% 以下 */
    broken.shots = broken.shots.filter((item) => !["CS-03", "CS-05", "CS-06", "CS-07"].includes(item.shotId));
    /** ② 剩下镜头全改成人物出镜 → 人物占比超上限 */
    broken.shots = broken.shots.map((item) => ({ ...item, policyTags: ["host"] }));
    /** ③ 出租屋感 + 产品事故 */
    broken.shots = broken.shots.map((item) => item.shotId === "CS-01"
      ? { ...item, scene: "出租屋昏暗日光灯，廉价家具与杂乱电线", composition: "产品变形、有污渍、塑料感高光" } : item);
    const report = auditScenePolicy(broken, t5);
    const rules = report.defects.map((item) => item.rule);
    expect(report.passed).toBe(false);
    expect(rules).toContain("required-plan-cue");
    expect(rules).toContain("ratio-min");
    expect(rules).toContain("ratio-max");
    expect(rules).toContain("restricted-location");
    expect(rules).toContain("quality-floor");
  });

  it("工厂/仓库场景可凭客户原话例外（源头好货定位），但产品质感底线不豁免", () => {
    const input = shopCompliant();
    input.shots = input.shots.map((item) => item.shotId === "CS-10"
      ? { ...item, scene: "工厂车间内的展示位，画面整洁有序、明亮通透", composition: "环境氛围：把产品摆在场景中，明亮整洁" } : item);
    input.scenePolicy = { exceptions: [{ rule: "restricted-location", shotId: "CS-10", term: "工厂车间",
      customerRequest: "我们品牌定位是工厂直销源头好货，客户要求到工厂车间实拍", source: "brief#scene" }] };
    const withException = auditScenePolicy(input, t5);
    expect(withException.defects.some((item) => item.rule === "restricted-location")).toBe(false);
    expect(withException.exceptionsApplied).toContainEqual(expect.objectContaining({ shotId: "CS-10", term: "工厂车间" }));

    const broken = shopCompliant();
    broken.shots = broken.shots.map((item) => item.shotId === "CS-02"
      ? { ...item, composition: "色差失真、塑料感高光，产品变形" } : item);
    const report = auditScenePolicy(broken, t5);
    expect(report.defects.filter((item) => item.rule === "quality-floor" && item.shotId === "CS-02").length).toBeGreaterThan(0);
  });

  it("极限承诺话术从实际台词取证", () => {
    const fluent = shopCompliant();
    fluent.shots = fluent.shots.map((item) => item.shotId === "CS-08"
      ? { ...item, dialogue: [{ speaker: "主播", text: "全网最低，最后三天！" }], speechMode: "on-camera", speechScene: "scene-seeding" } : item);
    const report = auditScenePolicy(fluent, t5);
    expect(report.defects).toContainEqual(expect.objectContaining({ rule: "speech-prohibition", shotId: "CS-08" }));
  });
});

/**
 * T6 知识口播（2026-09-28）：主口播中近景 50–60%、近景 ≥15%、B-roll ≥20%、信任状 ≥5%；
 * 机位 ≥2、直视交流感、B-roll 与信任状为必备画面；背景不抢戏与面部光线是不可突破底线。
 */
const t6 = policies.find((item) => item.id === "knowledge-talking-head")!;

function talkShot(index: number, tags: string[], fields: Partial<ScenePolicyShot>): ScenePolicyShot {
  return {
    shotId: `KT-${String(index).padStart(2, "0")}`, duration: 4.5, policyTags: tags,
    scene: "明亮的书房主讲位，书架整齐、背景干净简洁",
    composition: "胸部以上中近景，正对镜头，画面明亮清爽、人物最亮",
    camera_movement: "固定机位",
    costume: "纯色质感衬衫，与背景明度对比清楚",
    ...fields,
  } as ScenePolicyShot;
}

function talkCompliant(): ScenePolicyInput {
  return {
    title: "金融知识口播：三分钟读懂资产配置",
    shots: [
      talkShot(1, ["talking"], { scene: "明亮的书房主讲位，书架与数据屏整齐、背景干净简洁", composition: "胸部以上中近景，直视镜头，画面明亮清爽、人物最亮" }),
      talkShot(2, ["talking"], { composition: "胸部以上中近景，正对镜头讲述，背景简洁统一" }),
      talkShot(3, ["talking"], { composition: "坐姿口播中近景，正对镜头，画面明亮干净" }),
      talkShot(4, ["talking"], { composition: "站姿口播中近景，直视镜头，背景干净清爽" }),
      talkShot(5, ["talking"], { camera_movement: "45°侧机位", composition: "胸部以上中近景，45°侧机位正反打，画面明亮清爽" }),
      talkShot(6, ["person-close"], { composition: "面部近景，眼神交流清楚，情绪强调，画面明亮" }),
      talkShot(7, ["person-close"], { composition: "近景特写，直视镜头讲结论，背景干净" }),
      talkShot(8, ["b-roll"], { scene: "明亮的工作室，屏幕演示位", composition: "B-roll 示意图与案例画面，字幕卡干净统一" }),
      talkShot(9, ["b-roll"], { scene: "明亮的工作室桌面演示位", composition: "B-roll 屏幕演示与数据界面，画面清爽" }),
      talkShot(10, ["trust-detail"], { scene: "书房数据屏与证书陈列，环境干净明亮", composition: "信任状细节特写：证书与数据屏，画面干净统一" }),
    ],
  };
}

describe("T6 知识口播知识条目", () => {
  it("按知识口播信号选中，合规十镜满足配比与四项必备画面", () => {
    expect(t6.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(selectScenePolicy({ title: "金融知识口播：三分钟读懂资产配置", shots: [] }, null, policies).policy?.id).toBe("knowledge-talking-head");
    expect(selectScenePolicy({ title: "行业科普口播：干货分享", shots: [] }, null, policies).policy?.id).toBe("knowledge-talking-head");
    /** 没点人/口播的纯「科普干货」不再自动套用讲师口播知识条目（避免误配）。 */
    expect(selectScenePolicy({ title: "行业科普干货分享", shots: [] }, null, policies).policy).toBeNull();
    const report = auditScenePolicy(talkCompliant(), t6);
    expect(report.defects).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.ratios.talking?.share ?? 0).toBeGreaterThanOrEqual(0.5);
    expect(report.ratios.talking?.share ?? 1).toBeLessThanOrEqual(0.6);
    expect(report.ratios["person-close"]?.share ?? 0).toBeGreaterThanOrEqual(0.15);
    expect(report.ratios["b-roll"]?.share ?? 0).toBeGreaterThanOrEqual(0.2);
    expect(report.ratios["trust-detail"]?.share ?? 0).toBeGreaterThanOrEqual(0.05);
    expect(report.planCues["B-roll 辅助画面"]?.found).toBe(true);
    expect(report.planCues["第二机位"]?.found).toBe(true);
    expect(report.planCues["直视交流感"]?.found).toBe(true);
  });

  it("缺 B-roll/缺机位变化/口播超时长/空书壳与眼镜反光都判硬失败", () => {
    const broken = talkCompliant();
    /** ① 去掉 B-roll 与信任状镜 → 必备画面缺失、B-roll 掉到 20% 以下 */
    broken.shots = broken.shots.filter((item) => !["KT-08", "KT-09", "KT-10"].includes(item.shotId));
    /** ② 把近景全部改成主口播 → talking 超过 60% 上限、近景不足 */
    broken.shots = broken.shots.map((item) => ({ ...item, policyTags: ["talking"] }));
    /** ③ 书架空书壳 + 眼镜反光 + 阴阳脸 */
    broken.shots = broken.shots.map((item) => item.shotId === "KT-02"
      ? { ...item, scene: "书房书架有空书壳，背景起皱背景布", composition: "面部眼镜反光、阴阳脸，画面仍明亮" } : item);
    const report = auditScenePolicy(broken, t6);
    const rules = report.defects.map((item) => item.rule);
    expect(report.passed).toBe(false);
    expect(rules).toContain("required-plan-cue");
    expect(rules).toContain("ratio-min");
    expect(rules).toContain("ratio-max");
    expect(rules).toContain("quality-floor");
  });

  it("陪伴型人设的居家场景可凭客户原话例外，但面部光线与不抢戏底线不豁免", () => {
    const input = talkCompliant();
    input.shots = input.shots.map((item) => item.shotId === "KT-03"
      ? { ...item, scene: "卧室书桌前的整洁版居家场景，画面明亮干净统一" } : item);
    input.scenePolicy = { exceptions: [{ rule: "restricted-location", shotId: "KT-03", term: "卧室",
      customerRequest: "这是晚间电台式心理陪伴内容，客户要求在卧室拍整洁版居家场景", source: "brief#scene" }] };
    const withException = auditScenePolicy(input, t6);
    expect(withException.defects.some((item) => item.rule === "restricted-location")).toBe(false);
    expect(withException.exceptionsApplied).toContainEqual(expect.objectContaining({ shotId: "KT-03", term: "卧室" }));

    const broken = talkCompliant();
    broken.shots = broken.shots.map((item) => item.shotId === "KT-04"
      ? { ...item, composition: "背后窗户过曝成白板，顶光眼袋阴影" } : item);
    const report = auditScenePolicy(broken, t6);
    expect(report.defects.filter((item) => item.rule === "quality-floor" && item.shotId === "KT-04").length).toBeGreaterThan(0);
  });

  it("夸张震惊体话术从实际台词取证", () => {
    const fluent = talkCompliant();
    fluent.shots = fluent.shots.map((item) => item.shotId === "KT-06"
      ? { ...item, dialogue: [{ speaker: "讲师", text: "震惊！不看后悔的配置方法。" }], speechMode: "on-camera", speechScene: "desk-talk" } : item);
    const report = auditScenePolicy(fluent, t6);
    expect(report.defects).toContainEqual(expect.objectContaining({ rule: "speech-prohibition", shotId: "KT-06" }));
  });
});

/**
 * T7 美妆时尚/穿搭（2026-09-28）：妆容特写≥30% / 全身造型≥25% / 细节特写≥20% / 中景≥20% / 运动 20–35%，
 * 必备 妆容或全身主镜头 + 细节特写 + 动态镜头；皮肤与色彩真实、无廉价元素不可突破。
 */
const t7 = policies.find((item) => item.id === "beauty-fashion")!;

function fashionShot(index: number, tags: string[], duration: number, fields: Partial<ScenePolicyShot>): ScenePolicyShot {
  return {
    shotId: `BF-${String(index).padStart(2, "0")}`, duration, policyTags: tags,
    scene: "杂志感米色纯色空间，一盏设计感灯，画面干净有呼吸感",
    composition: "柔光通透、皮肤纹理真实，画面精致克制",
    camera_movement: "固定机位",
    costume: "设计感简约造型，熨烫平整",
    ...fields,
  } as ScenePolicyShot;
}

function fashionCompliant(): ScenePolicyInput {
  return {
    title: "秋冬妆容教程与穿搭分享",
    shots: [
      fashionShot(1, ["makeup-close"], 6, { composition: "眼妆妆容特写，柔光通透、皮肤纹理真实、有眼神光", scene: "整洁梳妆区，带灯化妆镜，化妆品有序陈列" }),
      fashionShot(2, ["makeup-close"], 6, { composition: "唇妆妆效特写，色号还原准确、柔光通透、画面精致" }),
      fashionShot(3, ["makeup-close"], 6, { composition: "底妆质感特写，皮肤纹理真实，柔光均匀、干净有呼吸感" }),
      fashionShot(4, ["full-look"], 7.5, { composition: "全身整体造型镜头，比例与搭配逻辑清楚，柔光通透、画面干净精致" }),
      fashionShot(5, ["full-look", "moving"], 7.5, { composition: "穿搭全身造型，服装平整、柔光通透", camera_movement: "跟随行走" }),
      fashionShot(6, ["detail"], 6, { composition: "面料细节特写，缝线与质感清晰，柔光通透、画面精致" }),
      fashionShot(7, ["detail"], 6, { composition: "配饰与美甲细节特写，干净克制、光泽真实" }),
      fashionShot(8, ["medium"], 5, { composition: "中景人物气质镜头，背景克制精致、柔光通透" }),
      fashionShot(9, ["medium", "moving"], 5, { composition: "镜前中景，人物松弛自信，柔光通透、画面干净有呼吸感", camera_movement: "缓慢推进" }),
      fashionShot(10, ["medium", "moving"], 5, { composition: "中景气质镜头，转身回眸，柔光通透、服装动态美清楚", camera_movement: "跟随转身" }),
    ],
  };
}

describe("T7 美妆时尚知识条目", () => {
  it("按美妆/穿搭信号选中，合规十镜满足配比与三项必备画面", () => {
    expect(t7.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(selectScenePolicy({ title: "秋冬妆容教程：三分钟通勤妆", shots: [] }, null, policies).policy?.id).toBe("beauty-fashion");
    expect(selectScenePolicy({ title: "通勤穿搭分享", shots: [] }, null, policies).policy?.id).toBe("beauty-fashion");
    const report = auditScenePolicy(fashionCompliant(), t7);
    expect(report.defects).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.ratios["makeup-close"]?.share ?? 0).toBeGreaterThanOrEqual(0.3);
    expect(report.ratios["full-look"]?.share ?? 0).toBeGreaterThanOrEqual(0.25);
    expect(report.ratios.detail?.share ?? 0).toBeGreaterThanOrEqual(0.2);
    expect(report.ratios.medium?.share ?? 0).toBeGreaterThanOrEqual(0.2);
    expect(report.ratios.moving?.share ?? 0).toBeGreaterThanOrEqual(0.2);
    expect(report.ratios.moving?.share ?? 1).toBeLessThanOrEqual(0.35);
    expect(report.planCues["妆容特写或全身造型"]?.found).toBe(true);
    expect(report.planCues["细节特写"]?.found).toBe(true);
    expect(report.planCues["动态镜头"]?.found).toBe(true);
  });

  it("缺细节/缺动态/妆容不足/快切晃镜超上限/廉价堆砌与滤镜事故都判硬失败", () => {
    const broken = fashionCompliant();
    /** ① 去掉细节与动态镜 → 必备画面缺失、细节与运动均不足 */
    broken.shots = broken.shots.filter((item) => !["BF-06", "BF-07", "BF-05", "BF-10"].includes(item.shotId));
    /** ② 剩余镜头全打 moving 标签 → 运动超 35% 上限（同时妆容不足） */
    broken.shots = broken.shots.map((item, index) => index < 3
      ? { ...item, policyTags: [...(item.policyTags ?? []), "moving"], camera_movement: "快切晃镜" }
      : item);
    /** ③ 廉价网红风堆砌 + 滤镜事故 */
    broken.shots = broken.shots.map((item) => item.shotId === "BF-02"
      ? { ...item, scene: "杂乱化妆台，艳俗假花与掉漆字母灯，起球地毯", composition: "磨皮成硅胶脸、假白脸，口红变色" } : item);
    const report = auditScenePolicy(broken, t7);
    const rules = report.defects.map((item) => item.rule);
    expect(report.passed).toBe(false);
    expect(rules).toContain("required-plan-cue");
    expect(rules).toContain("ratio-min");
    expect(rules).toContain("ratio-max");
    expect(rules).toContain("quality-floor");
    expect(rules).toContain("motion-consistency");
  });

  it("平价生活化场景可凭客户原话例外，但皮肤质感与色彩真实底线不豁免", () => {
    const input = fashionCompliant();
    input.shots = input.shots.map((item) => item.shotId === "BF-08"
      ? { ...item, scene: "出租屋改造后的整洁梳妆角，画面干净精致有呼吸感" } : item);
    input.scenePolicy = { exceptions: [{ rule: "restricted-location", shotId: "BF-08", term: "出租屋",
      customerRequest: "这是平价改造内容，客户要求在出租屋拍整洁版梳妆角", source: "brief#scene" }] };
    const withException = auditScenePolicy(input, t7);
    expect(withException.defects.some((item) => item.rule === "restricted-location")).toBe(false);
    expect(withException.exceptionsApplied).toContainEqual(expect.objectContaining({ shotId: "BF-08", term: "出租屋" }));

    const broken = fashionCompliant();
    broken.shots = broken.shots.map((item) => item.shotId === "BF-09"
      ? { ...item, composition: "强黄光顶光，肤色蜡黄，镜面指纹与水渍" } : item);
    const report = auditScenePolicy(broken, t7);
    expect(report.defects.filter((item) => item.rule === "quality-floor" && item.shotId === "BF-09").length).toBeGreaterThan(0);
  });

  it("夸大妆效与拉踩话术从实际台词取证", () => {
    const fluent = fashionCompliant();
    fluent.shots = fluent.shots.map((item) => item.shotId === "BF-01"
      ? { ...item, dialogue: [{ speaker: "博主", text: "一抹换头，直接吊打大牌。" }], speechMode: "on-camera", speechScene: "tutorial" } : item);
    const report = auditScenePolicy(fluent, t7);
    expect(report.defects).toContainEqual(expect.objectContaining({ rule: "speech-prohibition", shotId: "BF-01" }));
  });
});

/**
 * T8 美食餐饮（2026-09-28）：菜品特写≥30% / 食欲瞬间≥20% / 制作过程≥25% / 食材≥10% / 环境人物≤15%；
 * 诱惑链条三环齐备、食欲瞬间≥3 个、卫生零风险联想为不可突破底线。
 */
const t8 = policies.find((item) => item.id === "food-dining")!;

function foodShot(index: number, tags: string[], duration: number, fields: Partial<ScenePolicyShot>): ScenePolicyShot {
  return {
    shotId: `FD-${String(index).padStart(2, "0")}`, duration, policyTags: tags,
    scene: "明厨亮灶的烹饪操作台，台面干净整洁、调料有序",
    composition: "侧逆光下打亮打透，菜品油润水润、色泽诱人",
    camera_movement: "固定机位",
    ...fields,
  } as ScenePolicyShot;
}

function foodCompliant(): ScenePolicyInput {
  return {
    title: "餐厅菜品宣传：黑松露芝士焗饭",
    shots: [
      foodShot(1, ["dish-close"], 10, { scene: "精致餐桌，质感餐具与木质桌面，画面干净整洁", composition: "成品特写摆盘，侧逆光打亮打透、色泽诱人" }),
      foodShot(2, ["dish-close"], 10, { composition: "菜品特写成品呈现，油润水润、水珠质感清楚" }),
      foodShot(3, ["dish-close"], 10, { composition: "菜品成品特写，热气可见、画面干净" }),
      foodShot(4, ["appetite"], 10, { composition: "拉丝垂坠的食欲瞬间：芝士拉丝半米、打亮打透，切开横截面汁水清楚、油润光泽" }),
      foodShot(5, ["appetite"], 10, { composition: "浇汁流动与热气升腾的第一口食欲瞬间，侧逆光让热气可见、打亮打透" }),
      foodShot(6, ["cooking"], 12.5, { composition: "明火灶台翻炒制作过程，锅气十足、热气升腾、打亮打透，操作台干净规范作业" }),
      foodShot(7, ["cooking"], 12.5, { composition: "炙烤与淋酱的制作过程，动作真实、打亮打透、油润清晰，画面整洁有序" }),
      foodShot(8, ["ingredient"], 10, { scene: "木质砧板与竹编容器，自然光下台面干净整洁", composition: "食材特写：带水珠的蔬果与纹理清晰的原料，新鲜可见、画面干净" }),
      foodShot(9, ["ambience-host"], 7.5, { composition: "餐厅氛围环境镜头，堂食整洁、画面干净有序，菜品打亮打透", scene: "整洁版烟火气餐厅堂食区，桌面干净" }),
      foodShot(10, ["ambience-host"], 7.5, { composition: "主理人厨师出镜讲述，厨师服围裙整洁、经营养规范，菜品打亮打透、色泽诱人", scene: "开放式厨房前台，台面干净整洁" }),
    ],
  };
}

describe("T8 美食餐饮知识条目", () => {
  it("按美食信号选中，合规十镜满足配比与诱惑链条", () => {
    expect(t8.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(selectScenePolicy({ title: "餐厅菜品宣传：黑松露芝士焗饭", shots: [] }, null, policies).policy?.id).toBe("food-dining");
    expect(selectScenePolicy({ title: "烹饪教程：家常红烧肉", shots: [] }, null, policies).policy?.id).toBe("food-dining");
    const report = auditScenePolicy(foodCompliant(), t8);
    expect(report.defects).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.ratios["dish-close"]?.share ?? 0).toBeGreaterThanOrEqual(0.3);
    expect(report.ratios.appetite?.share ?? 0).toBeGreaterThanOrEqual(0.2);
    expect(report.ratios.cooking?.share ?? 0).toBeGreaterThanOrEqual(0.25);
    expect(report.ratios.ingredient?.share ?? 0).toBeGreaterThanOrEqual(0.1);
    expect(report.ratios["ambience-host"]?.share ?? 1).toBeLessThanOrEqual(0.15);
    expect(report.planCues["制作过程（锅气）"]?.found).toBe(true);
    expect(report.planCues["食欲瞬间·切开或拉丝"]?.found).toBe(true);
    expect(report.planCues["食欲瞬间·热气或油花"]?.found).toBe(true);
    expect(report.planCues["食欲瞬间·第一口或浇汁"]?.found).toBe(true);
  });

  it("食欲瞬间不足/缺制作过程/环境超配/脏乱后厨与食材翻车都判硬失败", () => {
    const broken = foodCompliant();
    /** ① 去掉全部食欲瞬间与制作过程镜 → 必备画面缺失、两类配比不足 */
    broken.shots = broken.shots.filter((item) => !["FD-04", "FD-05", "FD-06", "FD-07"].includes(item.shotId));
    /** ② 剩下镜头全改成环境/人物 → 环境人物超 15% 上限 */
    broken.shots = broken.shots.map((item) => ({ ...item, policyTags: ["ambience-host"] }));
    /** ③ 脏乱后厨与食材翻车 */
    broken.shots = broken.shots.map((item) => item.shotId === "FD-01"
      ? { ...item, scene: "油污灶台与发黑抹布，地面积水、食材乱堆", composition: "发蔫青菜与氧化切面，饱和拉满的荧光色" } : item);
    const report = auditScenePolicy(broken, t8);
    const rules = report.defects.map((item) => item.rule);
    expect(report.passed).toBe(false);
    expect(rules).toContain("required-plan-cue");
    expect(rules).toContain("ratio-min");
    expect(rules).toContain("ratio-max");
    expect(rules).toContain("quality-floor");
  });

  it("街边摊位可凭客户原话例外（大众餐饮），但卫生与食欲底线不豁免", () => {
    const input = foodCompliant();
    input.shots = input.shots.map((item) => item.shotId === "FD-09"
      ? { ...item, scene: "整洁版街边摊位，操作台干净有序、锅气十足", composition: "摊位环境镜头，画面整洁、菜品打亮打透" } : item);
    input.scenePolicy = { exceptions: [{ rule: "restricted-location", shotId: "FD-09", term: "街边摊位",
      customerRequest: "客户是街边小吃品牌，要求在街边摊位拍整洁版烟火气场景", source: "brief#scene" }] };
    const withException = auditScenePolicy(input, t8);
    expect(withException.defects.some((item) => item.rule === "restricted-location")).toBe(false);
    expect(withException.exceptionsApplied).toContainEqual(expect.objectContaining({ shotId: "FD-09", term: "街边摊位" }));

    const broken = foodCompliant();
    broken.shots = broken.shots.map((item) => item.shotId === "FD-08"
      ? { ...item, scene: "砧板旁有烟头与苍蝇，垃圾桶敞开", composition: "徒手抓熟食，惨白闪光" } : item);
    const report = auditScenePolicy(broken, t8);
    expect(report.defects.filter((item) => item.rule === "quality-floor" && item.shotId === "FD-08").length).toBeGreaterThan(0);
  });

  it("贬低同行话术从实际台词取证", () => {
    const fluent = foodCompliant();
    fluent.shots = fluent.shots.map((item) => item.shotId === "FD-10"
      ? { ...item, dialogue: [{ speaker: "主理人", text: "我们家最好，贬低同行的都别去。" }], speechMode: "on-camera", speechScene: "host" } : item);
    const report = auditScenePolicy(fluent, t8);
    expect(report.defects).toContainEqual(expect.objectContaining({ rule: "speech-prohibition", shotId: "FD-10" }));
  });
});
