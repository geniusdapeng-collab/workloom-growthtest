/**
 * 转场音效层回归（2026-09-25，为《瞭望塔》式城市片补的第三层声音）
 *
 * 三条口径：
 *   ① 音效是**合成**的（无第三方采样），参数确定性可复现；
 *   ② 摆放规则：每个剪辑点最多一个 whoosh（过密就丢），段落重音用 impact，高潮前有 riser；
 *   ③ 剪辑点推算与 compose 的逐刀转场口径一致（转场会吃掉时长）。
 */
import { describe, expect, it } from "vitest";
import {
  CUT_SFX_POLICY,
  HOOK_SFX_POLICY,
  buildSfxArgs,
  cutTimesFromShots,
  planCutSfx,
  planCutSfxDetailed,
  planHookSfx,
  resolveSfxDuration
} from "./sfx-synth.js";

describe("音效合成参数", () => {
  it("三种音色的默认时长与钳制区间", () => {
    expect(resolveSfxDuration("whoosh")).toBeCloseTo(0.36, 3);
    expect(resolveSfxDuration("impact")).toBeCloseTo(0.26, 3);
    expect(resolveSfxDuration("riser")).toBeCloseTo(1.2, 3);
    expect(resolveSfxDuration("impact", 9)).toBe(0.5);
    expect(resolveSfxDuration("riser", 0.01)).toBe(0.6);
  });

  it("参数里没有随机源：噪声用固定 seed，同 spec 两次一致", () => {
    const a = buildSfxArgs({ kind: "whoosh", durationSec: 0.36 });
    const b = buildSfxArgs({ kind: "whoosh", durationSec: 0.36 });
    expect(a).toEqual(b);
    expect(a.join(" ")).toContain("seed=20260925");
    expect(a.join(" ")).not.toMatch(/random|Math\.random/);
    expect(a.join(" ")).toContain("anoisesrc");
  });

  it("impact 用低频、riser 用抬升、whoosh 用带通气流", () => {
    expect(buildSfxArgs({ kind: "impact", durationSec: 0.26 }).join(" ")).toContain("lowpass=f=180");
    expect(buildSfxArgs({ kind: "riser", durationSec: 1.2 }).join(" ")).toContain("highpass=f=300");
    const whoosh = buildSfxArgs({ kind: "whoosh", durationSec: 0.36 }).join(" ");
    expect(whoosh).toContain("highpass=f=420");
    expect(whoosh).toContain("lowpass=f=6800");
  });
});

describe("音效摆放", () => {
  it("段落重音用 impact、其余剪辑点用 whoosh，且过密的剪辑点会被丢掉", () => {
    const placements = planCutSfx({
      cutTimes: [5, 9.8, 10.1, 15, 20],
      accentTimes: [5, 20],
      durationSec: 25
    });
    const kinds = placements.map((p) => `${p.atSec}:${p.kind}`);
    /** 10.1 与 9.8 只差 0.3s（< 0.45 最小间隔）→ 后者被丢弃；重音点优先保留 */
    expect(kinds).toEqual(["4.94:impact", "9.74:whoosh", "14.94:whoosh", "19.94:impact"]);
    expect(placements.every((p) => p.gainDb < 0)).toBe(true);
    expect(placements.every((p) => p.atSec >= 0 && p.atSec < 25)).toBe(true);
  });

  it("riser 结束在高潮那一刻（前置抬升），越界不生成", () => {
    const plan = planCutSfxDetailed({ cutTimes: [3, 6, 9], durationSec: 12, climaxAtSec: 9, riserDurationSec: 1.2 });
    const riser = plan.placements.find((p) => p.kind === "riser");
    expect(riser?.atSec).toBeCloseTo(7.75, 2);
    expect(plan.dropped.length).toBeGreaterThanOrEqual(0);
    const outOfRange = planCutSfx({ cutTimes: [3], durationSec: 12, riserAtSec: 99 });
    expect(outOfRange.some((p) => p.kind === "riser")).toBe(false);
  });

  it("间隔不足时按优先级保留（impact > riser > whoosh）并如实记录被丢弃者", () => {
    const plan = planCutSfxDetailed({
      cutTimes: [4, 7.9],
      durationSec: 12,
      accentTimes: [4],
      climaxAtSec: 9,
      riserDurationSec: 1.2
    });
    /** riser@7.75 与 whoosh@7.84 只差 0.09s：whoosh（优先级最低）被丢弃，riser 保留 */
    expect(plan.placements.some((p) => p.kind === "riser")).toBe(true);
    expect(plan.placements.some((p) => p.kind === "impact")).toBe(true);
    expect(plan.dropped).toHaveLength(1);
    expect(plan.dropped[0]!.kind).toBe("whoosh");
    expect(plan.dropped.every((p) => p.reason.includes("被丢弃"))).toBe(true);
  });

  it("没有剪辑点时只可能产出 riser（不凭空造音效）", () => {
    expect(planCutSfx({ cutTimes: [], durationSec: 10 })).toEqual([]);
  });

  it("策略默认值写死可审计（混音增益/提前量/最小间隔）", () => {
    expect(CUT_SFX_POLICY.whooshGainDb).toBe(-13);
    expect(CUT_SFX_POLICY.impactGainDb).toBe(-9);
    expect(CUT_SFX_POLICY.riserGainDb).toBe(-16);
    expect(CUT_SFX_POLICY.whooshLeadSec).toBeCloseTo(0.06, 3);
    expect(CUT_SFX_POLICY.minGapSec).toBeCloseTo(0.45, 3);
  });
});

describe("剪辑点推算（与 compose 逐刀转场一致）", () => {
  it("无转场：剪辑点就是累计时长", () => {
    expect(cutTimesFromShots([5, 5, 5])).toEqual([5, 10]);
  });

  it("逐刀转场会按刀数吃掉时长（第 2、3 刀 @0.18s）", () => {
    const cuts = cutTimesFromShots([5, 5, 5], 0.18, [2, 3]);
    expect(cuts[0]).toBeCloseTo(4.82, 3);
    expect(cuts[1]).toBeCloseTo(9.64, 3);
  });

  it("只在指定入点做转场时，其余刀口按硬切累计", () => {
    const cuts = cutTimesFromShots([5, 5, 5, 5], 0.18, [2]);
    expect(cuts.map((c) => Number(c.toFixed(2)))).toEqual([4.82, 9.82, 14.82]);
  });
});

/**
 * 开场钩子音（2026-09-27 前 3 秒机制）：转场音效只铺剪辑点，0–0.6s 一直是空白，
 * 而短平台"钉住观众"恰恰发生在第 1 秒。这一组守住窗口边界（越窗必须抛错，不静默摆放）。
 */
describe("开场钩子音（0–0.6s 窗口）", () => {
  it("未启用时返回 null（不凭空造音效）", () => {
    expect(planHookSfx({ enabled: false })).toBeNull();
  });

  it("默认落在窗口内，且增益低于段落重音（不盖首句台词）", () => {
    const placement = planHookSfx({ enabled: true });
    expect(placement).not.toBeNull();
    expect(placement!.atSec).toBeCloseTo(HOOK_SFX_POLICY.atSec, 3);
    expect(placement!.kind).toBe("impact");
    /** 增益是负 dB：数值更小 = 更轻。钩子音要比段落重音更克制，避免盖住首句台词 */
    expect(placement!.gainDb).toBeLessThan(CUT_SFX_POLICY.impactGainDb);
    expect(placement!.atSec).toBeLessThanOrEqual(HOOK_SFX_POLICY.windowSec);
    expect(placement!.reason).toContain("开场钩子音");
  });

  it("越过 0–0.6s 窗口直接抛错（宁可不出声，也不在 2s 处放一个「开场音」）", () => {
    expect(() => planHookSfx({ enabled: true, atSec: 2 })).toThrow(/窗口/);
    expect(() => planHookSfx({ enabled: true, atSec: -0.1 })).toThrow(/窗口/);
    expect(planHookSfx({ enabled: true, atSec: HOOK_SFX_POLICY.windowSec })).not.toBeNull();
  });

  it("音色与增益可覆盖（长视频平台可用 whoosh）", () => {
    const placement = planHookSfx({ enabled: true, kind: "whoosh", atSec: 0.12, gainDb: -13 });
    expect(placement!.kind).toBe("whoosh");
    expect(placement!.atSec).toBeCloseTo(0.12, 3);
    expect(placement!.gainDb).toBe(-13);
  });
});
