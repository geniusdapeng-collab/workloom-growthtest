import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EMPTY_FACTS,
  QUEST_STAGE_ORDER,
  autoAdvance,
  completeStage,
  computeXp,
  createQuestState,
  factsFromRecentActions,
  levelOf,
  lightCard,
  parseQuestState,
  progressSummary,
  serializeQuestState,
  skipStage,
  stageSatisfiedByFacts,
  startQuestline,
  unlockAchievements,
  withThreadId,
  type QuestFacts,
} from "./questline";
import {
  QUESTLINE,
  QUESTLINE_GEO,
  QUESTLINE_PACKS,
  QUESTLINE_VIDEO,
  MATE_GUIDE_VOICE,
  coreCardIds,
  questlineForBundle,
  stageDef,
} from "./questline.config";
import { MATE_VOICE_PROFILE } from "../voice/mateVoice";

const facts = (patch: Partial<QuestFacts> = {}): QuestFacts => ({ ...EMPTY_FACTS, ...patch });

describe("首日上岗状态机", () => {
  it("初始状态停留在第 1 关，且没有任何虚假进度", () => {
    const state = createQuestState(1000);
    expect(state.status).toBe("idle");
    expect(state.stage).toBe("meet");
    expect(state.stageDone).toEqual([]);
    expect(state.achievements).toEqual([]);
    expect(state.litCards).toEqual([]);
    expect(state.startedAt).toBeNull();
    expect(state.completedAt).toBeNull();
  });

  it("起跑幂等：重复调用不会重置已完成进度", () => {
    const started = startQuestline(createQuestState(1000), 1000);
    expect(started.status).toBe("running");
    expect(started.startedAt).toBe(1000);
    const again = startQuestline(started, 2000);
    expect(again.startedAt).toBe(1000);
    const done = completeStage(completeStage(again, "meet", 3000), "goal", 4000);
    expect(startQuestline(done, 5000).status).toBe("running");
  });

  it("按顺序推进四关，最后一关完成即整条主线完成", () => {
    let state = startQuestline(createQuestState(0), 0);
    state = completeStage(state, "meet", 10);
    expect(state.stage).toBe("goal");
    state = completeStage(state, "goal", 20);
    expect(state.stage).toBe("dispatch");
    state = completeStage(state, "dispatch", 30);
    expect(state.stage).toBe("review");
    state = completeStage(state, "review", 50);
    expect(state.status).toBe("completed");
    expect(state.completedAt).toBe(50);
    expect(state.stageDone).toEqual([...QUEST_STAGE_ORDER]);
  });

  it("跳过会留痕但不冒充完成", () => {
    const state = skipStage(startQuestline(createQuestState(0), 0), "meet", 10);
    expect(state.stage).toBe("goal");
    expect(state.skipped).toEqual(["meet"]);
    expect(state.stageDone).toEqual([]);
  });

  it("越关完成不会把当前指针拉回去", () => {
    let state = startQuestline(createQuestState(0), 0);
    state = completeStage(state, "meet", 10); // 当前应是 goal
    const backfilled = completeStage(state, "meet", 20);
    expect(backfilled.stage).toBe("goal");
  });

  it("点亮员工卡幂等，且不改变关卡", () => {
    const once = lightCard(createQuestState(0), "pricing", 10);
    const twice = lightCard(once, "pricing", 20);
    expect(twice.litCards).toEqual(["pricing"]);
    expect(twice.stage).toBe("meet");
    expect(lightCard(once, "  ", 30)).toBe(once);
  });
});

describe("事实驱动推进", () => {
  it("认人不能被事实代替完成", () => {
    expect(stageSatisfiedByFacts("meet", facts({ goalConfirmed: true, dispatched: true }))).toBe(false);
  });

  it("客户在别处把活干了，也能自动推进到对应关卡", () => {
    // 认人需要客户自己确认（或跳过），事实不能替他完成；先手动过第一关
    const started = completeStage(startQuestline(createQuestState(0), 0), "meet", 5);
    const advanced = autoAdvance(started, facts({ goalConfirmed: true, dispatched: true }), 10);
    // 第 3 关（派活）被事实点亮后直接进入验收关：原「拍板」关已随基座审批环节移除
    expect(advanced.stage).toBe("review");
    expect(advanced.stageDone).toEqual(["meet", "goal", "dispatch"]);
  });

  it("没有事实时不前进（空事实是安全的）", () => {
    const started = startQuestline(createQuestState(0), 0);
    expect(autoAdvance(started, facts(), 10).stage).toBe("meet");
  });

  it("事实齐了会推到验收关，但验收必须由客户亲自确认（S4b）", () => {
    const started = completeStage(startQuestline(createQuestState(0), 0), "meet", 5);
    const advanced = autoAdvance(started, facts({
      goalConfirmed: true,
      dispatched: true,
      decided: true,
      delivered: true,
    }), 10);
    // 交付事实已满足，但 review 关不允许被事实自动关掉——否则客户看不到成绩单
    expect(advanced.stage).toBe("review");
    expect(advanced.status).toBe("running");
    expect(advanced.stageDone).toContain("meet");
    // 客户点"我看到了"之后才算完成
    expect(completeStage(advanced, "review", 20).status).toBe("completed");
  });

  it("跨页面事实只认本人动作，认不出就不推进（S3）", () => {
    expect(factsFromRecentActions([
      { action: "thread.dispatch", who: "MEM-001" },
      { action: "approval.gesture", who: "MEM-001" },
    ], "MEM-001")).toEqual({ dispatched: true, decided: true });
    // 别人的动作不算我的
    expect(factsFromRecentActions([{ action: "thread.dispatch", who: "MEM-002" }], "MEM-001"))
      .toEqual({ dispatched: false, decided: false });
    // 无身份 / 空数据一律不推进
    expect(factsFromRecentActions([{ action: "thread.dispatch", who: "MEM-001" }], null))
      .toEqual({ dispatched: false, decided: false });
    expect(factsFromRecentActions([], "MEM-001")).toEqual({ dispatched: false, decided: false });
  });

  it("首单线程号可持久化并幂等写入（S4a）", () => {
    const once = withThreadId(createQuestState(0), "T-107", 10);
    expect(once.lastThreadId).toBe("T-107");
    expect(withThreadId(once, "T-107", 20)).toBe(once);
    expect(withThreadId(once, "  ", 30).lastThreadId).toBe("T-107");
    expect(parseQuestState(serializeQuestState(once), 99).lastThreadId).toBe("T-107");
    expect(parseQuestState(JSON.stringify({ version: 1 }), 1).lastThreadId).toBeNull();
  });
});

describe("XP 与等级（与团队页同口径）", () => {
  it("XP = 裁决×3 + 派遣×2 + 沉淀×5", () => {
    expect(computeXp({ decided: 1, dispatched: 1, settled: 1 })).toBe(10);
    expect(computeXp({ decided: 0, dispatched: 0, settled: 0 })).toBe(0);
  });

  it("等级阶梯为 xp ≥ 8·LV²，段位随等级提升", () => {
    expect(levelOf(0).level).toBe(1);
    expect(levelOf(31).level).toBe(1);
    expect(levelOf(32).level).toBe(2);
    expect(levelOf(32).rank).toBe("青铜");
    expect(levelOf(72).level).toBe(3);
    expect(levelOf(72).rank).toBe("白银");
    expect(levelOf(8 * 15 * 15).level).toBe(15);
    expect(levelOf(8 * 15 * 15).rank).toBe("星钻");
  });
});

describe("成就解锁", () => {
  it("同一成就只解锁一次，并只回报新解锁项", () => {
    const first = unlockAchievements(createQuestState(0), ["aboard", "aboard"], 10);
    expect(first.state.achievements).toEqual(["aboard"]);
    expect(first.unlocked).toEqual(["aboard"]);
    const second = unlockAchievements(first.state, ["aboard"], 20);
    expect(second.unlocked).toEqual([]);
    expect(second.state).toBe(first.state);
  });
});

describe("持久化与容错", () => {
  it("序列化后可原样恢复", () => {
    const state = lightCard(startQuestline(createQuestState(0), 0), "pricing", 5);
    expect(parseQuestState(serializeQuestState(state), 99)).toEqual(state);
  });

  it("脏数据/旧版本一律回落为全新状态，不抛错", () => {
    expect(parseQuestState("{ not json", 1).status).toBe("idle");
    expect(parseQuestState("null", 1).stage).toBe("meet");
    expect(parseQuestState(JSON.stringify({ version: 0, stage: "review" }), 1).stage).toBe("meet");
    expect(parseQuestState(JSON.stringify({ version: 1, xp: "bad", stage: "unknown" }), 1).stage).toBe("meet");
  });

  it("负数与非法 XP 记为零，不会出现负经验", () => {
    const raw = JSON.stringify({ version: 1, xp: { decided: -5, dispatched: "x", settled: 2.7 } });
    const state = parseQuestState(raw, 1);
    expect(state.xp).toEqual({ decided: 0, dispatched: 0, settled: 2 });
  });
});

describe("进度摘要", () => {
  it("按已完成关卡计算剩余时间与文案", () => {
    let state = startQuestline(createQuestState(0), 0);
    expect(progressSummary(state).done).toBe(0);
    expect(progressSummary(state).label).toContain("还差 4 关");
    state = completeStage(state, "meet", 1);
    state = completeStage(state, "goal", 2);
    expect(progressSummary(state).done).toBe(2);
    expect(progressSummary(state).label).toContain("还差 2 关");
    const finished = completeStage(state, "dispatch", 3);
    expect(progressSummary(finished).label).toBe("就差最后一关");
    expect(progressSummary(completeStage(finished, "review", 5)).label).toBe("首日上岗已完成");
  });
});

describe("内容包完整性（行业可替换的硬约束）", () => {
  it("四关齐备，每关都有三句台词与主按钮", () => {
    expect(QUESTLINE.stages).toHaveLength(QUEST_STAGE_ORDER.length);
    for (const id of QUEST_STAGE_ORDER) {
      const def = stageDef(id);
      expect(def.id).toBe(id);
      expect(def.title.length).toBeGreaterThan(0);
      expect(def.objective.length).toBeGreaterThan(0);
      expect(def.primaryLabel.length).toBeGreaterThan(0);
      expect(def.script.enter.length).toBeGreaterThan(0);
      expect(def.script.hint.length).toBeGreaterThan(0);
      expect(def.script.success.length).toBeGreaterThan(0);
    }
  });

  it("三张首单卡的负责人必须来自员工卡里的真实岗位", () => {
    const presetKeys = new Set(QUESTLINE.employees.map((item) => item.presetKey));
    expect(QUESTLINE.tasks).toHaveLength(3);
    for (const task of QUESTLINE.tasks) {
      expect(presetKeys.has(task.ownerPresetKey)).toBe(true);
      expect(task.steps).toBeGreaterThan(0);
      expect(task.artifact.length).toBeGreaterThan(0);
      expect(task.dispatchTitle.length).toBeGreaterThan(0);
    }
  });

  it("三个目标模板都能指到员工卡上的负责人", () => {
    const presetKeys = new Set(QUESTLINE.employees.map((item) => item.presetKey));
    expect(QUESTLINE.goals).toHaveLength(3);
    for (const goal of QUESTLINE.goals) {
      expect(presetKeys.has(goal.ownerPresetKey)).toBe(true);
      expect(goal.artifact.length).toBeGreaterThan(0);
    }
  });

  it("成就都指向已有类型且带说明", () => {
    expect(QUESTLINE.achievements.length).toBeGreaterThanOrEqual(4);
    for (const achievement of QUESTLINE.achievements) {
      expect(achievement.title.length).toBeGreaterThan(0);
      expect(achievement.hint.length).toBeGreaterThan(0);
      expect(QUEST_STAGE_ORDER).toContain(achievement.stage);
    }
  });

  it("演示样例必须被标注，避免把样例当成真实经营数据", () => {
    for (const card of QUESTLINE.employees) {
      if (card.sample.length > 0) expect(card.sampleIsDemo).toBe(true);
    }
  });

  it("内容包按 Bundle 解析：未知 Bundle 不显示引导（禁止张冠李戴）", () => {
    expect(questlineForBundle("hotel")).toBe(QUESTLINE);
    expect(questlineForBundle("geo-growth")).toBe(QUESTLINE_GEO);
    expect(questlineForBundle("ai-video")).toBe(QUESTLINE_VIDEO);
    expect(questlineForBundle("some-other-industry")).toBeNull();
    expect(questlineForBundle(null)).toBeNull();
    expect(questlineForBundle("  ")).toBeNull();
  });

  it("人设与音色：三套内容包都是织伴（首席增长官），音色与欢迎仪式同源", () => {
    // 产品既有数字人 = 织伴（昵称小织），产品名 = WorkLoom 织元；引导岗位 = 首席增长官。
    // 不许出现第二个角色名，也不许给引导单独配一套音色（否则同一屏里织伴像两个人）。
    for (const content of Object.values(QUESTLINE_PACKS)) {
      expect(content.mateName).toBe("织伴");
      expect(content.mateRole).toBe("首席增长官");
      expect(content.mateVoice).toBe(MATE_VOICE_PROFILE);
      expect(content.mateVoice.female).toBe(true);
    }
    // 与欢迎仪式共用同一档案（导入的是同一个对象，不是各写一份相同数值）
    expect(QUESTLINE.mateVoice).toBe(MATE_GUIDE_VOICE);
    // 台词里不得残留迁移前的角色名
    for (const content of Object.values(QUESTLINE_PACKS)) {
      const text = JSON.stringify(content);
      expect(text.includes("狐狸")).toBe(false);
      expect(text.includes("汇报官")).toBe(false);
    }
  });

  it("三位当家人 = 内容包前三张卡（机制里不得硬编码岗位 id）", () => {
    for (const content of Object.values(QUESTLINE_PACKS)) {
      expect(coreCardIds(content)).toEqual(content.employees.slice(0, 3).map((card) => card.id));
      expect(new Set(coreCardIds(content)).size).toBe(3);
    }
  });

  /** 逐包门禁：员工卡/目标/任务引用的岗位必须真实存在于该行业包，否则界面会出现点不开的幽灵岗位 */
  for (const [bundleId, content] of Object.entries(QUESTLINE_PACKS)) {
    it(`[${bundleId}] 四关齐备且引用岗位与行业包一致`, () => {
      const bundlesRootDir = join(dirname(fileURLToPath(import.meta.url)), "../../../../bundles");
      const presetsDir = join(bundlesRootDir, bundleId, "presets");
      const available = new Set(
        readdirSync(presetsDir)
          .filter((file) => file.endsWith(".yml"))
          .map((file) => (readFileSync(join(presetsDir, file), "utf-8").match(/^preset_key:\s*(\S+)/m)?.[1] ?? file.replace(/\.yml$/, ""))),
      );
      expect(available.size).toBeGreaterThan(0);

      // ① 四关与台词齐备
      expect(content.stages).toHaveLength(QUEST_STAGE_ORDER.length);
      for (const id of QUEST_STAGE_ORDER) {
        const def = stageDef(id, content);
        expect(def.id).toBe(id);
        expect(def.script.enter.length).toBeGreaterThan(0);
        expect(def.script.hint.length).toBeGreaterThan(0);
        expect(def.script.success.length).toBeGreaterThan(0);
      }
      // ② 员工卡 / 目标 / 任务卡的岗位都真实存在
      expect(content.employees.length).toBeGreaterThanOrEqual(3);
      for (const card of content.employees) {
        expect(available.has(card.presetKey), `${bundleId} 员工卡 ${card.id} → ${card.presetKey}`).toBe(true);
        if (card.sample.length > 0) expect(card.sampleIsDemo).toBe(true);
      }
      const cardKeys = new Set(content.employees.map((card) => card.presetKey));
      for (const goal of content.goals) {
        expect(cardKeys.has(goal.ownerPresetKey), `${bundleId} 目标 ${goal.id} → ${goal.ownerPresetKey}`).toBe(true);
      }
      for (const task of content.tasks) {
        expect(cardKeys.has(task.ownerPresetKey), `${bundleId} 任务 ${task.id} → ${task.ownerPresetKey}`).toBe(true);
        expect(task.dispatchTitle.length).toBeGreaterThan(0);
      }
      // ③ 驳回枚举：行业包必须装配反馈枚举表（第⑧槽），且内容包用到的码逐条命中
      //    （服务端 registerFeedbackEnumsFromDisk 按 workspaces.industry 装载、decide 逐码校验）
      const enumsPath = join(bundlesRootDir, bundleId, "feedback-enums.yml");
      expect(existsSync(enumsPath), `${bundleId} 缺第⑧槽 feedback-enums.yml`).toBe(true);
      const enumsText = readFileSync(enumsPath, "utf-8");
      const rejectCodes = new Set(
        [...enumsText.matchAll(/-\s*code:\s*(\S+)\n(?:.*\n)*?\s*appliesTo:\s*\[([^\]]*)\]/g)]
          .filter((m) => (m[2] ?? "").includes("reject"))
          .map((m) => m[1]!),
      );
      expect(rejectCodes.size).toBeGreaterThan(0);
      expect(content.rejectReasons.length).toBeGreaterThan(0);
      for (const reason of content.rejectReasons) {
        expect(rejectCodes.has(reason.code), `${bundleId} 驳回原因 ${reason.code} 未在枚举表登记`).toBe(true);
        expect(reason.label.trim().length).toBeGreaterThan(0);
      }
    });
  }
});
