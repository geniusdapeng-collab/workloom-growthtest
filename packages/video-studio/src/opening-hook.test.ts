/**
 * 开场钩子回归（2026-09-27 产品所有者要求：新增岗位/机制，针对抖音类平台强化前 3 秒）
 *
 * 三条纪律：
 *   ① 钩子必须是**产物**（类型/承诺/兑现镜/首镜模板/钩子音），不是形容词；
 *   ② 钩子不许撒谎：承诺没有兑现镜 = 标题党 = 硬失败；
 *   ③ 短平台缺钩子卡 = 硬失败；长视频平台缺钩子卡 = 软提示（不误伤长片）。
 */
import { describe, expect, it } from "vitest";
import {
  HOOK_SFX_WINDOW_SEC,
  HOOK_WINDOW_SEC,
  defaultHookSfx,
  hookWindowFor,
  openingHookChecks,
  promiseOverlap,
  summarizeHookChecks,
  validateHookCard,
  type HookCard
} from "./opening-hook.js";

const shots = [
  {
    shotId: "CF-01",
    duration: 8,
    action: "坐在会议室长桌边，右手按住档案夹，抬眼看镜头",
    dialogue: [{ text: "获客成本涨了三成，问题真在投放吗？" }],
    scene: "1930 年代外滩银行改建办公楼 18 层会议室"
  },
  {
    shotId: "CF-04",
    duration: 12,
    action: "翻开档案夹，指向打印出的漏斗图",
    dialogue: [{ text: "投放没变，获客成本却涨了三成——问题在漏斗中段没人接住。" }]
  }
];

const hook: HookCard = {
  type: "question",
  promise: "获客成本涨了三成，问题真在投放吗？",
  payoffShotId: "CF-04",
  firstShotTemplate: { visual: "人物坐在长桌边按住档案夹，抬眼直视镜头", line: "获客成本涨了三成，问题真在投放吗？" },
  sfx: { kind: "impact", atSec: 0.08, gainDb: -11 }
};

describe("钩子卡自检（validateHookCard）", () => {
  it("完备的钩子卡零问题", () => {
    expect(validateHookCard(hook)).toEqual([]);
  });

  it("类型必须在类型库内", () => {
    expect(validateHookCard({ ...hook, type: "vibes" as HookCard["type"] }).join("")).toContain("不在类型库内");
  });

  it("缺承诺或兑现镜头都要判红（没有兑现镜头的钩子即标题党）", () => {
    expect(validateHookCard({ ...hook, promise: "" }).join("")).toContain("promise");
    expect(validateHookCard({ ...hook, payoffShotId: "" }).join("")).toContain("payoffShotId");
  });

  it("首句超过 18 字要判红（短平台念不完）", () => {
    const long = { ...hook, firstShotTemplate: { visual: "人物看向镜头", line: "这是一句在开头三秒绝对念不完的特别长的钩子台词内容" } };
    expect(validateHookCard(long).join("")).toContain("念不完");
  });

  it("钩子音超出 0–0.6s 要判红", () => {
    expect(validateHookCard({ ...hook, sfx: { kind: "impact", atSec: 2 } }).join("")).toContain("窗口内");
  });
});

describe("平台钩子窗口", () => {
  it("短平台 3s、长视频平台 5s", () => {
    expect(hookWindowFor("抖音/快手")).toBe(HOOK_WINDOW_SEC);
    expect(hookWindowFor("视频号")).toBe(HOOK_WINDOW_SEC);
    expect(hookWindowFor("YouTube")).toBe(5);
    expect(hookWindowFor("B站")).toBe(5);
  });

  it("钩子音默认值随平台切换（短平台 impact、长视频 whoosh），且都在 0–0.6s 内", () => {
    expect(defaultHookSfx("抖音").kind).toBe("impact");
    expect(defaultHookSfx("B站").kind).toBe("whoosh");
    for (const platform of ["抖音", "B站"]) {
      expect(defaultHookSfx(platform).atSec).toBeLessThanOrEqual(HOOK_SFX_WINDOW_SEC);
    }
  });
});

describe("开场钩子确定性判据（openingHookChecks）", () => {
  it("短平台缺钩子卡 = 硬失败；长视频平台缺钩子卡 = 软提示", () => {
    const short = summarizeHookChecks(openingHookChecks({ shots, hook: null, platform: "抖音" }));
    expect(short.hard).toBe(1);
    expect(short.soft).toBe(0);
    const long = summarizeHookChecks(openingHookChecks({ shots, hook: null, platform: "B站" }));
    expect(long.hard).toBe(0);
    expect(long.soft).toBe(1);
  });

  it("钩子卡齐备时全部通过（含兑现镜在场）", () => {
    const checks = openingHookChecks({ shots, hook, platform: "抖音" });
    const summary = summarizeHookChecks(checks);
    expect(summary.hard).toBe(0);
    expect(summary.soft).toBe(0);
    expect(checks.map((check) => check.id)).toEqual([
      "hook-card",
      "hook-card-complete",
      "hook-payoff-shot",
      "hook-window",
      "hook-promise-stated",
      "hook-promise-paid",
      "hook-sfx-window"
    ]);
  });

  it("兑现镜不存在 = 硬失败（承诺无处兑现）", () => {
    const summary = summarizeHookChecks(openingHookChecks({ shots, hook: { ...hook, payoffShotId: "CF-99" }, platform: "抖音" }));
    expect(summary.hard).toBe(1);
    expect(summary.hardFailures[0]!.id).toBe("hook-payoff-shot");
  });

  it("首镜太短（把钩子切在半句里）只给软提示，不误伤", () => {
    const shortFirst = [{ ...shots[0]!, duration: 1.5 }, shots[1]!];
    const checks = openingHookChecks({ shots: shortFirst, hook, platform: "抖音" });
    const windowCheck = checks.find((check) => check.id === "hook-window")!;
    expect(windowCheck.pass).toBe(false);
    expect(windowCheck.hard).toBe(false);
  });

  it("承诺在首镜提出、在兑现镜落实（2-gram 重叠度）", () => {
    expect(promiseOverlap(hook.promise, String(shots[0]!.dialogue[0]!.text))).toBeGreaterThan(0.9);
    expect(promiseOverlap(hook.promise, "全然无关的一句台词")).toBeLessThan(0.2);
  });

  it("疑问型钩子以「回应」为兑现判据（字面可以不重叠）", () => {
    const questionHook: HookCard = {
      type: "question",
      promise: "还在给平台打工吗",
      payoffShotId: "CF-04",
      firstShotTemplate: { visual: "人物抬眼直视镜头", line: "还在给平台打工吗？" }
    };
    const withAnswer = openingHookChecks({
      shots: [{ ...shots[0]!, dialogue: [{ text: "还在给平台打工吗？" }] }, { ...shots[1]!, dialogue: [{ text: "别再买工具，你缺的是一支班组。" }] }],
      hook: questionHook,
      platform: "抖音"
    });
    const paid = withAnswer.find((check) => check.id === "hook-promise-paid")!;
    expect(paid.pass).toBe(true);
    expect(paid.detail).toContain("以台词回应");

    /** 兑现镜没有任何台词 → 不成立（承诺没人接） */
    const silent = openingHookChecks({
      shots: [{ ...shots[0]!, dialogue: [{ text: "还在给平台打工吗？" }] }, { ...shots[1]!, dialogue: [] }],
      hook: questionHook,
      platform: "抖音"
    });
    expect(silent.find((check) => check.id === "hook-promise-paid")!.pass).toBe(false);
  });
});
