import { describe, expect, it } from "vitest";
import {
  buildEntityFilterComplex, entityReceiptRows, isFoodLabel, planEntityGrade, summarizeEntityPlans,
  weightCurrentMask, type EntitySignal,
} from "./entity-color.js";

function signal(overrides: Partial<EntitySignal> = {}): EntitySignal {
  return {
    segmentId: "seg-001",
    personRatio: 0,
    faces: [],
    personInstances: 0,
    personFrames: null,
    personSkinRatio: null,
    personRequest: null,
    foodRatio: 0,
    foodLabels: [],
    foodFrames: null,
    sampledAt: [1],
    personMaskPath: "/tmp/person.png",
    foodMaskPath: "/tmp/food.png",
    ...overrides,
  };
}

describe("edit/entity-color：实体级局部调色", () => {
  it("同镜人物+食物：两条都开，互不串色（人像美白 / 食物暖黄分别作用）", () => {
    const plan = planEntityGrade(signal({
      personRatio: 0.18,
      faces: [{ x: 0.2, y: 0.1, w: 0.2, h: 0.3 }],
      personInstances: 1,
      foodRatio: 0.22,
      foodLabels: ["soup", "dish"],
    }));
    expect(plan.person.enabled).toBe(true);
    expect(plan.food.enabled).toBe(true);
    expect(plan.person.opacity).toBeGreaterThan(0.3);
    expect(plan.person.reason).toContain("美白");
    expect(plan.food.reason).toContain("加暖");
    expect(plan.notes.some((note) => note.includes("互不串色"))).toBe(true);
    const outcome = buildEntityFilterComplex(plan, { width: 3840, height: 2160 });
    expect(outcome.applied).toBe(true);
    expect(outcome.filterComplex).toContain("colorbalance=rs=-0.010");
    expect(outcome.filterComplex).toContain("colorbalance=rs=0.030");
    expect(outcome.filterComplex).toContain("[1:v]format=gray");
    expect(outcome.filterComplex).toContain("[2:v]format=gray");
    expect(outcome.filterComplex.endsWith("maskedmerge[vout]")).toBe(true);
  });

  it("只有食物：只加食物暖黄，不产生人像链", () => {
    const plan = planEntityGrade(signal({ foodRatio: 0.4, foodLabels: ["noodles"] }));
    expect(plan.person.enabled).toBe(false);
    expect(plan.food.enabled).toBe(true);
    const outcome = buildEntityFilterComplex(plan, { width: 1920, height: 1080 });
    expect(outcome.filterComplex).toContain("[0:v]format=gbrp,split=2[base][f0]");
    expect(outcome.filterComplex).not.toContain("[p0]");
  });

  it("食物掩膜未被分类命中（如暖色木头）：不作用，避免误暖", () => {
    const plan = planEntityGrade(signal({ foodRatio: 0.3, foodLabels: ["wood", "table"] }));
    expect(plan.food.enabled).toBe(false);
    expect(plan.food.reason).toContain("未命中食物词表");
  });

  it("俯拍食物镜的假人物掩膜（通用分割把盘子当人）不触发美白：无实例/人脸证据就不作用", () => {
    const plan = planEntityGrade(signal({
      personRatio: 0.63,
      faces: [],
      personInstances: 0,
      personRequest: "segmentation",
      personSkinRatio: 0.82,
      foodRatio: 0.21,
      foodLabels: ["food", "soup"],
    }));
    expect(plan.person.enabled).toBe(false);
    expect(plan.person.reason).toContain("疑似把食物/桌面误判成人");
    expect(plan.food.enabled).toBe(true);
  });

  it("时间一致性：单帧偶发的人物实例/食物实例不触发局部优化（须 ≥2 个采样帧）", () => {
    const personOnce = planEntityGrade(signal({
      personRatio: 0.049,
      personInstances: 1,
      personFrames: 1,
      personRequest: "instance",
      personSkinRatio: 0.435,
    }));
    expect(personOnce.person.enabled).toBe(false);
    expect(personOnce.person.reason).toContain("偶发误检");

    const personTwice = planEntityGrade(signal({
      personRatio: 0.3,
      personInstances: 1,
      personFrames: 2,
      personRequest: "instance",
    }));
    expect(personTwice.person.enabled).toBe(true);

    const foodOnce = planEntityGrade(signal({ foodRatio: 0.2, foodLabels: ["dish"], foodFrames: 1 }));
    expect(foodOnce.food.enabled).toBe(false);
    expect(foodOnce.food.reason).toContain("偶发误检");
    /** 单帧但占比 ≥25%（整盘/整锅）算强证据：人物+食物同镜时不能漏掉那道菜。 */
    const foodOnceBig = planEntityGrade(signal({ foodRatio: 0.42, foodLabels: ["soup", "dish"], foodFrames: 1 }));
    expect(foodOnceBig.food.enabled).toBe(true);
    const foodTwice = planEntityGrade(signal({ foodRatio: 0.2, foodLabels: ["dish"], foodFrames: 2 }));
    expect(foodTwice.food.enabled).toBe(true);
  });

  it("同镜食物 + 无脸人物实例（俯拍面碗误判）：不做人像美白；有人脸则照常美白", () => {
    const bowlOnly = planEntityGrade(signal({
      personRatio: 0.454,
      personInstances: 1,
      personFrames: 3,
      personRequest: "instance",
      personSkinRatio: 0.485,
      foodRatio: 0.545,
      foodLabels: ["food", "soup"],
      foodFrames: 3,
    }));
    expect(bowlOnly.food.enabled).toBe(true);
    expect(bowlOnly.person.enabled).toBe(false);
    expect(bowlOnly.person.reason).toContain("同镜有食物");

    const faceToo = planEntityGrade(signal({
      personRatio: 0.3,
      personInstances: 1,
      personFrames: 3,
      faces: [{ x: 0.2, y: 0.1, w: 0.2, h: 0.3 }],
      personRequest: "instance",
      foodRatio: 0.4,
      foodLabels: ["food", "soup"],
      foodFrames: 3,
    }));
    expect(faceToo.person.enabled).toBe(true);
    expect(faceToo.food.enabled).toBe(true);
    expect(faceToo.notes.some((note) => note.includes("互不串色"))).toBe(true);
  });

  it("有人脸但缺当前掩膜时关闭人像层并如实降级", () => {
    const plan = planEntityGrade(signal({ personRatio: 0.001, faces: [{ x: 0.4, y: 0.2, w: 0.05, h: 0.05 }], personMaskPath: null }));
    expect(plan.person.enabled).toBe(false);
    expect(plan.notes.some((note) => note.includes("跳过人像层"))).toBe(true);
  });

  it("无实体：恒等滤镜图且标记未执行（调用方直接 copy，不重编码）", () => {
    const plan = planEntityGrade(signal());
    const outcome = buildEntityFilterComplex(plan, { width: 1920, height: 1080 });
    expect(outcome.applied).toBe(false);
    expect(outcome.filterComplex).toBe("[0:v]null[vout]");
  });

  it("强度为 0 视为只出计划不执行；回执行与汇总可复算", () => {
    const plans = [
      planEntityGrade(signal({ segmentId: "seg-001", personRatio: 0.2, faces: [{ x: 0, y: 0, w: 0.1, h: 0.1 }], foodRatio: 0.2, foodLabels: ["dish"] })),
      planEntityGrade(signal({ segmentId: "seg-002", personRatio: 0.2, faces: [{ x: 0, y: 0, w: 0.1, h: 0.1 }] })),
      planEntityGrade(signal({ segmentId: "seg-003" })),
    ];
    const summary = summarizeEntityPlans(plans);
    expect(summary).toEqual({ segments: 3, personSegments: 2, foodSegments: 1, bothSegments: 1 });
    const rows = entityReceiptRows([signal({ segmentId: "seg-001" })], plans);
    expect(rows[0]?.segmentId).toBe("seg-001");
    expect(rows[0]?.person.enabled).toBe(true);
    expect(planEntityGrade(signal({ personRatio: 0.5, faces: [{ x: 0, y: 0, w: 0.1, h: 0.1 }] }), { intensity: 0 }).person.enabled).toBe(false);
  });

  it("食物词表覆盖中英常见子类且不误伤无关标签", () => {
    expect(isFoodLabel("hotpot")).toBe(true);
    expect(isFoodLabel("Chinese cuisine")).toBe(true);
    expect(isFoodLabel("羊汤")).toBe(true);
    expect(isFoodLabel("apple")).toBe(true);
    expect(isFoodLabel("person")).toBe(false);
    expect(isFoodLabel("wooden table")).toBe(false);
  });
});

describe("实体掩膜的时间与词表边界", () => {
  it("英文前缀和中文相似词不能充当食物证据", () => {
    for (const label of ["mealworm", "fishbone", "bunting", "vegetation", "面包车", "桌面", "菜市场"]) expect(isFoodLabel(label)).toBe(false);
    expect(isFoodLabel("dumplings")).toBe(true);
  });
  it("没有当前食物掩膜时计划和汇总均不能宣称已作用", () => {
    const plan = planEntityGrade(signal({ foodRatio: 0.4, foodLabels: ["soup"], foodMaskPath: null }));
    expect(plan.food.enabled).toBe(false);
    expect(summarizeEntityPlans([plan]).foodSegments).toBe(0);
  });
  it("移动实体仅权重当前支持；消失立即清零，再出现缓入", () => {
    const first = weightCurrentMask(Uint8Array.from([255, 0, 0]), 0.45);
    const moved = weightCurrentMask(Uint8Array.from([0, 0, 255]), 0.45, first.opacity);
    expect(moved.mask[0]).toBe(0);
    expect(moved.mask[2]).toBeGreaterThan(first.mask[0]!);
    const absent = weightCurrentMask(Uint8Array.from([0, 0, 0]), 0.45, moved.opacity);
    expect(absent.opacity).toBe(0);
    expect(Array.from(absent.mask)).toEqual([0, 0, 0]);
    expect(weightCurrentMask(Uint8Array.from([255, 0, 0]), 0.45, absent.opacity).opacity).toBe(0.08);
  });
});

it("只有通用人物分割加肤色带没有脸/实例时，不能把食物或桌面当人", () => {
  expect(planEntityGrade(signal({ personRatio: 0.4, personRequest: "segmentation", personSkinRatio: 0.82 })).person.enabled).toBe(false);
});
