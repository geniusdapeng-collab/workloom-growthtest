import { describe, expect, it } from "vitest";
import {
  allocateShotDurations,
  durationRulesMarkdown,
  durationValidationMarkdown,
  loadDurationRules,
  loadDurationSources,
  loadModelDurationLimits,
  validateShotDurations
} from "./duration-rules.js";

/**
 * T-2026-0923-0047：单镜 30s 的**全量口径校验**。
 * 第一版只覆盖 2 处（且 ThemeConfig 打错层级），本版清单按源码逐个核对：
 * 关键断言不是"改了某一行"，而是「没有任何**在用**口径还把模型上限夹回去」。
 */
describe("镜头时长规则（真机实测 4–30s）", () => {
  it("媒体目录口径：Seedance 2.5 单镜 4–30s", () => {
    const limits = loadModelDurationLimits("doubao-seedance-2-5");
    expect(limits.min).toBe(4);
    expect(limits.max).toBe(30);
    const rules = loadDurationRules("doubao-seedance-2-5");
    expect(rules.modelMin).toBe(4);
    expect(rules.modelMax).toBe(30);
  }, 60_000);

  it("全量口径清单：在用口径要么已到模型上限，要么有运行期桥；不再存在夹回 15s 的死角", () => {
    const rules = loadDurationRules("doubao-seedance-2-5");
    /** blockers = 在用 + 无桥 + 低于 30s（唯一允许的「provider」类是被放宽到的目标本身） */
    expect(rules.blockers).toEqual([]);
    expect(rules.aligned).toBe(true);
    for (const source of rules.sources) {
      if (!source.live) continue;
      if (source.kind === "provider") continue;
      if (source.value !== null && source.value < rules.modelMax) {
        expect(source.bridge, `${source.id} 低于模型上限又没有桥`).toBe(true);
      }
    }
  }, 60_000);

  it("清单登记了本轮核对出的 5 处在用口径与 3 处未接线口径（防止偷偷回退成只改一处）", () => {
    const sources = loadDurationSources("doubao-seedance-2-5");
    const live = sources.filter((s) => s.live).map((s) => s.id);
    for (const id of [
      "media-catalog",
      "dcm-class-default",
      "dcm-rhythm-profiles",
      "theme-config-resource-quota",
      "platform-profiles-shot-band",
      "shot-duration-allocator",
      "requirement-list-defaults",
      "requirement-list-result"
    ]) {
      expect(live, `清单缺少在用口径 ${id}`).toContain(id);
    }
    const orphans = sources.filter((s) => s.kind === "orphan");
    expect(orphans.map((s) => s.id).sort()).toEqual(
      ["duration-calculator", "duration-narration-alignment", "pre-production-report-generator"].sort()
    );
    for (const orphan of orphans) {
      /** 未接线口径的「不在用」必须由引用扫描得出（全仓无其它文件引用），不是拍脑袋 */
      expect(orphan.live, `${orphan.id} 实际已被接线，清单需要更新`).toBe(false);
      expect(orphan.referencedBy, `${orphan.id} 不应被任何文件引用`).toEqual([]);
    }
  }, 60_000);

  it("清单读到的默认值来自源码：DCM 15s / 题材配额 10–15s / 平台带 5–12s / 分配器 15s", () => {
    const sources = loadDurationSources("doubao-seedance-2-5");
    const byId = new Map(sources.map((s) => [s.id, s.value]));
    expect(byId.get("dcm-class-default")).toBe(15);
    expect(byId.get("dcm-rhythm-profiles")).toBe(15);
    expect(byId.get("theme-config-resource-quota")).toBe(10); // 取最小（KIDS 儿童片）
    expect(byId.get("platform-profiles-shot-band")).toBe(12); // 取最大（cinematic）
    expect(byId.get("shot-duration-allocator")).toBe(15);
    expect(byId.get("requirement-list-defaults")).toBe(15);
  }, 60_000);

  it("分配：30s 单镜不缩水、60s 三镜等比分配且不超上限", () => {
    const single = allocateShotDurations([{ shotId: "S1", duration: 30 }], { totalSeconds: 30 });
    expect(single.map.get("S1")).toBe(30);

    const three = allocateShotDurations(
      [{ shotId: "S1", duration: 10 }, { shotId: "S2", duration: 10 }, { shotId: "S3", duration: 10 }],
      { totalSeconds: 60 }
    );
    expect([...three.map.values()].reduce((a, b) => a + b, 0)).toBe(60);
    for (const value of three.map.values()) expect(value).toBeLessThanOrEqual(30);
  }, 60_000);

  it("分配：超过模型上限的计划被夹紧并标记（不静默）", () => {
    const plan = allocateShotDurations([{ shotId: "S1", duration: 45 }], { totalSeconds: 45 });
    expect(plan.map.get("S1")).toBe(30);
    expect(plan.entries[0]?.clamped).toBe(true);
  }, 60_000);

  it("校验：3s（低于下限）与 45s（高于上限）都判不合格，30s 单镜通过", () => {
    const tooShort = validateShotDurations([{ shotId: "S1", duration: 3 }], { targetTotalSeconds: 3 });
    expect(tooShort.pass).toBe(false);
    expect(tooShort.issues.join()).toContain("低于模型下限");

    const tooLong = validateShotDurations([{ shotId: "S1", duration: 45 }], { targetTotalSeconds: 45 });
    expect(tooLong.pass).toBe(false);
    expect(tooLong.issues.join()).toContain("超过模型上限");

    const ok = validateShotDurations([{ shotId: "S1", duration: 30, sceneType: "opening" }], { targetTotalSeconds: 30 });
    expect(ok.pass).toBe(true);
    expect(ok.actualTotalSeconds).toBe(30);
  }, 60_000);

  it("校验：总时长与目标偏差会被显式报出（±1s 容差）", () => {
    const drift = validateShotDurations(
      [{ shotId: "S1", duration: 10 }, { shotId: "S2", duration: 10 }],
      { targetTotalSeconds: 30 }
    );
    expect(drift.pass).toBe(false);
    expect(drift.issues.join()).toContain("总时长");
  }, 60_000);

  it("报告：逐镜表 + 口径清单都带结论行", () => {
    const markdown = durationValidationMarkdown(
      validateShotDurations([{ shotId: "S1", duration: 30 }], { targetTotalSeconds: 30 })
    );
    expect(markdown).toContain("| S1 | 30 | 30 |");
    expect(markdown).toContain("结论：✅ 通过");

    const inventory = durationRulesMarkdown("doubao-seedance-2-5");
    expect(inventory).toContain("单镜时长口径清单");
    expect(inventory).toContain("`platform-profiles-shot-band`");
    expect(inventory).toContain("所有**在用**口径都已放宽到模型上限");
    expect(inventory).toContain("未接线口径：");
  });
});
