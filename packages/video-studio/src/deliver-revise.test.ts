import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assessVariantDistinctness, buildDeliveryManifest, buildVariantPlan, DELIVERY_VARIANTS } from "./deliver.js";
import { buildRevisionPlan, buildRevisionReport, classifyRevision } from "./revise.js";

const gray = (v: number) => ({ r: v, g: v, b: v });

describe("多风格交付包（deliver · G-DLV1 变体雷同否决）", () => {
  it("变体计划：每个变体都走 color-bridge 调色（干净母版本体是交付主件，不占变体名额）", () => {
    const plans = buildVariantPlan({ master: "/m/master.mp4", outDir: "/out", projectId: "VID-1", coverHook: "滕王阁 落霞秋水" });
    expect(plans).toHaveLength(DELIVERY_VARIANTS.length);
    const cool = plans.find((p) => p.variant.id === "cool-tech")!;
    expect(cool.passthrough).toBe(false);
    expect(cool.gradeArgs).toContain("grade");
    expect(cool.gradeArgs).toContain("cool-technical");
    expect(cool.coverCopy).toBe("滕王阁 落霞秋水｜冷调");
    const punchy = plans.find((p) => p.variant.id === "punchy-social")!;
    expect(punchy.gradeArgs).toContain("high-contrast-social");
    expect(plans.every((p) => p.variant.gradeProfile !== null)).toBe(true);
  });

  it("画面与音轨都测不出差别 → 一票否决（G-DLV1）", () => {
    const report = assessVariantDistinctness([
      { variantId: "cool-tech", frames: [gray(120), gray(118)], loudness: { lufs: -14.1, peakDb: -1.4 } },
      { variantId: "warm-film", frames: [gray(121), gray(119)], loudness: { lufs: -14.2, peakDb: -1.5 } }
    ]);
    expect(report.approved).toBe(false);
    expect(report.worstPair?.identical).toBe(true);
    expect(report.detail).toContain("变体雷同");
  });

  it("画面差异达标即放行（音轨相同不影响：风格差异只要在画面/音轨任一维度显著即可）", () => {
    const report = assessVariantDistinctness([
      { variantId: "cool-tech", frames: [gray(120)], loudness: { lufs: -14.1, peakDb: -1.4 } },
      { variantId: "warm-film", frames: [gray(150)], loudness: { lufs: -14.1, peakDb: -1.4 } },
      { variantId: "clean", frames: [gray(90)], loudness: { lufs: -14.0, peakDb: -1.3 } }
    ]);
    expect(report.approved).toBe(true);
    expect(report.pairs.every((p) => !p.identical)).toBe(true);
    expect(report.detail).toContain("差异达标");
  });

  it("交付清单记录：母版/字幕/封面/变体指纹 + G-DLV1 判定 + 复用纪律", () => {
    const distinctness = assessVariantDistinctness([
      { variantId: "cool-tech", frames: [gray(60)], loudness: { lufs: -14, peakDb: -1.2 } },
      { variantId: "warm-film", frames: [gray(140)], loudness: { lufs: -13.5, peakDb: -1.1 } }
    ]);
    const manifest = buildDeliveryManifest({
      projectId: "VID-1", platform: "小红书",
      deliverable: { path: "/out/final.mp4", sha256: "abc", bytes: 100 },
      subtitles: { sidecarDir: "/out/subtitles", softsub: "/out/softsub.mp4", burned: true },
      cover: { path: "/out/cover.png", hook: "滕王阁 落霞秋水" },
      variants: [{ id: "cool-tech", label: "冷调技术感", path: "/out/v1.mp4", sha256: "v1", note: "低饱和冷调", gradeProfile: "cool-technical" }],
      distinctness, samples: [], at: "2026-09-25T00:00:00Z"
    });
    expect(manifest.generatedAt).toBe("2026-09-25T00:00:00Z");
    expect(manifest.variants[0]!.sha256).toBe("v1");
    expect(manifest.reuseDiscipline).toContain("零 token");
    expect(manifest.distinctness.approved).toBe(true);
  });
});

describe("返修闭环（revise · 影响分析 + 复用证据）", () => {
  const shots = [
    { shotId: "SC-01", clipPath: "/clips/SC-01.mp4" },
    { shotId: "SC-02", clipPath: "/clips/SC-02.mp4" },
    { shotId: "SC-03", clipPath: "/clips/SC-03.mp4" }
  ];
  const hasher = (path: string) => createHash("sha256").update(path).digest("hex");

  it("分诊：只提字幕 → 层增量；点名画面 → 要重跑镜头", () => {
    expect(classifyRevision("第 3 条字幕有错字，改一下")).toBe("layer-level");
    expect(classifyRevision("SC-02 里人物手指畸变，重拍这一镜")).toBe("shot-level");
    expect(classifyRevision("SC-02 手部畸变，另外配乐换掉")).toBe("mixed");
  });

  it("层增量返修：镜头全部复用并带 sha256 证据，不需要 G8", () => {
    const plan = buildRevisionPlan({ note: "字幕有错字，配乐再轻一点", shots, hasher });
    expect(plan.kind).toBe("layer-level");
    expect(plan.rerunShots).toEqual([]);
    expect(plan.requestedLayers).toEqual(["subtitle", "bgm"]);
    expect(plan.layers).toEqual(["subtitle", "danmaku", "bgm", "mux", "master", "deliver"]);
    expect(plan.stages).toEqual(plan.layers);
    expect(plan.executable).toBe(true);
    expect(plan.reuseEvidence.map((e) => e.shotId)).toEqual(["SC-01", "SC-02", "SC-03"]);
    expect(plan.requiresRenderSubmitGate).toBe(false);
  });

  it("画面返修：只重跑点名镜头，其余镜头带 sha256 复用证据，并要求 G8", () => {
    const plan = buildRevisionPlan({ note: "SC-02 手部畸变，重拍", shots, hasher });
    expect(plan.kind).toBe("shot-level");
    expect(plan.rerunShots).toEqual(["SC-02"]);
    expect(plan.executionSteps[0]).toEqual({ scope: "selected-shots", shotIds: ["SC-02"], stages: ["cine-kb", "continuity", "micromotion", "spec", "plates", "material-gen", "videos", "voice"] });
    expect(plan.executionSteps[1]?.scope).toBe("project");
    expect(plan.executionSteps[1]?.shotIds).toEqual(shots.map((shot) => shot.shotId));
    expect(plan.reuseEvidence.map((e) => e.shotId)).toEqual(["SC-01", "SC-03"]);
    expect(plan.reuseEvidence[0]!.sha256).toBe(hasher("/clips/SC-01.mp4"));
    expect(plan.requiresRenderSubmitGate).toBe(true);
    const report = buildRevisionReport(plan, "SC-02 手部畸变，重拍", "2026-09-25T00:00:00Z");
    expect(report.executable).toBe(true);
    expect(report.gate.approved).toBe(false);
    expect(report.renderSubmitApproval.status).toBe("unverified");
  });

  it("无法归类的意见：报告标不放行（要求人工确认，不静默跳过）", () => {
    const plan = buildRevisionPlan({ note: "整体再高级一点", shots, hasher });
    expect(plan.kind).toBe("unclassified");
    expect(plan.layers).toEqual([]);
    expect(plan.executable).toBe(false);
    const report = buildRevisionReport(plan, "整体再高级一点");
    expect(report.gate.approved).toBe(false);
    expect(report.gate.detail).toContain("不可执行");
  });
});
