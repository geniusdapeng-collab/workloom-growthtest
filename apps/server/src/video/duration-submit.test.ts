import { describe, expect, it } from "vitest";
import { plannedDurationOf } from "./router.js";

/**
 * T-2026-0925-0001：提交时长必须从镜头卡/渲染脚本派生（计划=执行）。
 *
 * 此前的行为：`render.submit` 缺省回落 `estimatedSeconds=30`，与脚本计划零关系，
 * 导致"计划 8–12s 的镜头按 30s 烧额度"（2.5–3.75×）且 G6 审的计划与付钱的值不一致。
 */
describe("渲染脚本计划时长解析（计划=执行的取值口径）", () => {
  it("优先读 fields.durationSec（结构化字段）", () => {
    const planned = plannedDurationOf({ fields: { durationSec: 12 }, md: "- 时长: 30s" });
    expect(planned).toEqual({ seconds: 12, source: "script-fields" });
  });

  it("结构化字段缺失时回落 md 的「时长: Ns」行", () => {
    const planned = plannedDurationOf({ fields: {}, md: "# 渲染脚本 · S01\n\n- 场景类型: establishing\n- 时长: 8s\n" });
    expect(planned).toEqual({ seconds: 8, source: "script-md" });
  });

  it("支持中英文与半角/全角冒号（渲染脚本模板两种写法）", () => {
    expect(plannedDurationOf({ md: "duration: 10 s" }).seconds).toBe(10);
    expect(plannedDurationOf({ md: "时长：15s" }).seconds).toBe(15);
  });

  it("读不到计划时长时返回 null（由调用方决定拒绝或告警，绝不静默回落 30s）", () => {
    expect(plannedDurationOf({ fields: {}, md: "无时长字段的脚本" })).toEqual({ seconds: null, source: null });
    expect(plannedDurationOf({}).seconds).toBeNull();
  });
});
