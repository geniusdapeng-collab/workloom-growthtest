import { describe, expect, it, vi } from "vitest";
import {
  affirmativeSkillText, boundCinematicSkillContext, checkCinematicSkillCompliance,
  cinematicSkillHash, normalizeCinematicSkillShot, planCinematicSkills,
  type CinematicSkillRouter, type RankedCinematicSkill,
} from "./cinematic-skill-policy.js";

const shot = {
  shotId: "SC-01", scene: "女人坐在窗边", composition: "面部近景", mood: "温情",
  camera_movement: "斯坦尼康缓慢环绕", duration: 5,
};
const skill = (file = "温情摄影.md", domain = "cinematography"): RankedCinematicSkill => ({
  skill: { file, domain, emotions: ["tender"], camera_modes: ["steadicam"], oneLiner: "缓慢稳定运镜" },
  score: 38, reasons: ["emotion", "camera"],
});
function makeRouter(candidates: RankedCinematicSkill[] = [skill()]): CinematicSkillRouter {
  return {
    assignFilmDirector: vi.fn(() => ({ director: "斯皮尔伯格", source: "default" })),
    normalizeShotMeta: vi.fn(() => ({ cameraMode: "steadicam", emotion: "tender", director: "" })),
    matchSkillsV2: vi.fn(() => candidates),
    buildSkillContextText: vi.fn(() => "镜头手法:\n**速度纪律**：缓慢匀速环绕，收尾停稳。\n禁止词:\n禁止快速运镜。"),
    getSkillQCBlocks: vi.fn((files: string[]) => files.map((file) => ({ file, qc: ["检查镜头速度"], forbidden: ["快速运镜：会打断情绪"] }))),
  };
}

describe("宿主摄影技能元数据与主体", () => {
  it("蛇形字段映射到 vendor 的真实入参，不改变原卡", () => {
    const original = structuredClone(shot);
    const result = normalizeCinematicSkillShot(shot);
    expect(result.shot.cameraMovement).toBe(shot.camera_movement);
    expect((result.shot.camera as { movement: string }).movement).toBe(shot.camera_movement);
    expect(shot).toEqual(original);
    expect(result.subject).toEqual({ hasPerson: true, faceVisible: true, shotScale: "close" });
  });

  it.each([
    { scene: "无人会议室空镜", portraits: [] },
    { scene: "手表表盘微距", portraits: [] },
    { scene: "鹰眼镜头中的玻璃窗", portraits: [] },
    { scene: "风景", subject: { kind: "environment" }, character: "默认模特" },
    { scene: "无人物", character: "无人物" },
  ])("空镜与物件不能因为空 portraits/手/眼字样获得人物技能：%j", (card) => {
    const { subject } = normalizeCinematicSkillShot(card);
    expect(subject.hasPerson).toBe(false);
    expect(subject.faceVisible).toBe(false);
  });

  it.each([
    { scene: "女人背对镜头", composition: "近景" },
    { scene: "男人的双手", composition: "只有双手入画" },
    { scene: "女人走过街道", composition: "远景" },
  ])("人物背影/手部/远景不投放面部技能：%j", (card) => {
    const { subject } = normalizeCinematicSkillShot(card);
    expect(subject.hasPerson).toBe(true);
    expect(subject.faceVisible).toBe(false);
  });

  it("无人机不是无人镜头，显式可见面部优先于远景猜测", () => {
    const { subject } = normalizeCinematicSkillShot({ scene: "无人机航拍女人", subject: { hasPerson: true, faceVisible: true } });
    expect(subject.hasPerson).toBe(true);
    expect(subject.faceVisible).toBe(true);
  });

  it("被否定的情绪不会经 vendor 的 emotion/emotional_target/prompt 回退重新成为肯定信息", () => {
    const input = { scene: "房间", emotion: "不要愤怒", emotional_target: { emotion: "悲伤" }, prompt: "旧的战争史诗技能" };
    const normalized = normalizeCinematicSkillShot(input).shot;
    expect(normalized.mood).toBe("");
    expect(normalized.emotion).toBe("");
    expect(normalized.emotional_target).toEqual({ emotion: "" });
    expect(normalized.prompt).toBe("");
    expect(input.emotion).toBe("不要愤怒");
  });
});

describe("技能选择准入", () => {
  it("只有导演/类型分不算适用；默认导演不强制写入", async () => {
    const candidate = { ...skill(), reasons: ["director", "type"] };
    const router = makeRouter([candidate]);
    const call = vi.fn();
    const plan = (await planCinematicSkills([shot], {}, router, { llmCaller: call })).get(shot.shotId)!;
    expect(plan.status).toBe("not_applicable");
    expect(plan.contextText).toBe("");
    expect(plan.directorSource).toBe("none");
    expect(call).not.toHaveBeenCalled();
    expect(router.normalizeShotMeta).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ assignedDirector: "" }));
  });

  it("LLM 显式 picks=[] 保持空匹配，不降级塞入候选", async () => {
    const router = makeRouter();
    const before = vi.fn();
    const plan = (await planCinematicSkills([shot], {}, router, { llmCaller: async () => ({ picks: [] }), beforeExternalCall: before })).get(shot.shotId)!;
    expect(plan.status).toBe("not_applicable");
    expect(plan.matched).toEqual([]);
    expect(plan.contextText).toBe("");
    expect(before).toHaveBeenCalledOnce();
    expect(router.buildSkillContextText).not.toHaveBeenCalled();
  });

  it("情绪不匹配时即使运镜与导演高分仍不注入", async () => {
    const candidate = skill();
    candidate.skill.emotions = ["epic"];
    const plan = await planCinematicSkills([shot], {}, makeRouter([candidate]));
    expect(plan.get(shot.shotId)?.status).toBe("not_applicable");
  });

  it("人物缺失或脸不可见时不注入演技技能", async () => {
    const router = makeRouter([skill("表演.md", "acting")]);
    for (const card of [{ ...shot, scene: "空镜", character: "" }, { ...shot, scene: "女人背对镜头" }]) {
      expect((await planCinematicSkills([card], {}, router)).get(shot.shotId)?.status).toBe("not_applicable");
    }
  });

  it("显式固定机位不接受慢环绕技能", async () => {
    const router = makeRouter();
    router.normalizeShotMeta = () => ({ cameraMode: "static", emotion: "tender" });
    expect((await planCinematicSkills([shot], {}, router)).get(shot.shotId)?.status).toBe("not_applicable");
  });

  it("合法匹配可追踪源卡、上下文与 QC，保持确定性", async () => {
    const router = makeRouter();
    const plan = (await planCinematicSkills([shot], { title: "日常" }, router)).get(shot.shotId)!;
    expect(plan.status).toBe("passed");
    expect(plan.matched[0]?.file).toBe("温情摄影.md");
    expect(plan.contextText).toContain("原镜头的主体");
    expect(plan.contextText).toContain("缓慢匀速环绕");
    expect(plan.sourceHash).toMatch(/^[a-f\d]{64}$/);
    expect(plan.contextHash).toBe(cinematicSkillHash(plan.contextText));
    expect(plan.qcEntries).toHaveLength(1);
    const again = await planCinematicSkills([structuredClone(shot)], { title: "日常" }, router);
    expect(again.get(shot.shotId)?.sourceHash).toBe(plan.sourceHash);
    expect((await planCinematicSkills([{ ...shot, duration: 8 }], { title: "日常" }, router)).get(shot.shotId)?.sourceHash).not.toBe(plan.sourceHash);
  });

  it("两个选中技能各自有实际正文，长主技能不会吃掉辅技能预算", async () => {
    const router = makeRouter([skill("主摄影.md"), skill("辅表演.md", "acting")]);
    router.buildSkillContextText = (matches) => matches.map(({ skill: entry }) =>
      `${entry.file} 的实质技法。\n` + Array.from({ length: 15 }, () => `${entry.file} 保持主体原始动作与慢速运镜。`).join("\n")
    ).join("\n");
    const result = (await planCinematicSkills([shot], {}, router)).get(shot.shotId)!;
    expect(result.matched).toHaveLength(2);
    expect(result.contextText).toContain("主摄影.md 的实质技法。");
    expect(result.contextText).toContain("辅表演.md 的实质技法。");
    expect(result.contextText.length).toBeLessThanOrEqual(1800);
  });

  it.each([null, {}, { picks: ["bad"] }, { picks: [{ file: "不存在.md", reason: "任意" }] }, { picks: [{ file: "温情摄影.md" }] }, "not JSON"])("非法模型返回不得伪装成不匹配：%j", async (value) => {
    await expect(planCinematicSkills([shot], {}, makeRouter(), { llmCaller: async () => value })).rejects.toThrow(/SKILL_SELECTION_INVALID/);
  });

  it("网络异常直接上浮，重复镜头 id 和缺 QC 明确失败", async () => {
    await expect(planCinematicSkills([shot], {}, makeRouter(), { llmCaller: async () => { throw new Error("offline"); } })).rejects.toThrow("offline");
    await expect(planCinematicSkills([shot, shot], {}, makeRouter())).rejects.toThrow("SKILL_SHOT_ID_INVALID");
    const router = makeRouter();
    router.getSkillQCBlocks = () => [];
    await expect(planCinematicSkills([shot], {}, router)).rejects.toThrow("SKILL_QC_MISSING");
  });
});

describe("技能文本 QC 的否定与预算", () => {
  const entries = [{ file: "稳镜.md", qc: [], forbidden: ["快速运镜：破坏稳定", "手持抖动：破坏主体关系"] }];
  it.each([
    "【负面约束】快速运镜、手持抖动",
    "【运镜】固定机位；禁止快速运镜、手持抖动。",
    "【运镜】缓慢环绕；避免快速运镜。",
    "【负面约束】快速运镜\n【场景】正常场景",
  ])("否定/负面字段不会命中肯定式违规：%s", (text) => {
    expect(checkCinematicSkillCompliance(text, entries)).toEqual([]);
  });

  it("负面要求之后的肯定式违规仍被发现", () => {
    expect(checkCinematicSkillCompliance("【负面约束】手持抖动\n【运镜】快速运镜后停住", entries)).toEqual([{ skill: "稳镜.md", term: "快速运镜" }]);
    expect(checkCinematicSkillCompliance("禁止手持抖动，但快速运镜接近主体", entries)).toEqual([{ skill: "稳镜.md", term: "快速运镜" }]);
    expect(affirmativeSkillText("不笑；温情")).toBe("温情");
  });

  it("单条超预算时跳过完整条目，绝不截半句", () => {
    const text = "短句。\n" + "长".repeat(2000) + "禁止漂浮。\n最后完整句。";
    const bounded = boundCinematicSkillContext(text, 30);
    expect(bounded).toBe("短句。\n最后完整句。");
    expect(bounded.length).toBeLessThanOrEqual(30);
    expect(() => boundCinematicSkillContext(text, 0)).toThrow("SKILL_CONTEXT_BUDGET_INVALID");
  });
});
