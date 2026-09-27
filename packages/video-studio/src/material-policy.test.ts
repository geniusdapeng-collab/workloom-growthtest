/**
 * 素材用途硬约束回归（2026-09-25 产品所有者口径）
 *
 * 覆盖三件事：
 *   ① 用途声明是硬性的——旧卡（只写 photo）必须被拒，不能"静默兼容"；
 *   ② 生成提示词必须同时说清"保真""真运动""禁止静态直出"，且不得出现退化标记；
 *   ③ 静态直出判定的量化口径（后段连续高 PSNR 即直出）。
 */
import { describe, expect, it } from "vitest";
import {
  MATERIAL_MOTION_POLICY,
  MATERIAL_POLICY_STATEMENT,
  MATERIAL_REUSE_POLICY,
  MATERIAL_SCENE_POLICY_STATEMENT,
  REFERENCE_INDEPENDENCE_POLICY,
  MaterialPolicyError,
  assessMotionRichness,
  motionPolicyForShot,
  assessReferenceIndependence,
  assessMaterialReuse,
  assertMaterialGenerationProvenance,
  buildMaterialScenePrompt,
  buildMaterialMotionPrompt,
  isMaterialShot,
  readMaterialSpec
} from "./material-policy.js";

const baseShot = {
  shotId: "SC-02",
  duration: 5,
  scene: "真实实拍：南昌滕王阁白天全景，红柱绿瓦的主体楼阁与赣江、城市天际线同框",
  sceneDescription: "江面开阔，画面上方留有天空，建筑主体居中偏右",
  lighting: "白天自然光，天光偏冷，不影响建筑本色",
  color_palette: "青蓝天光 + 红柱绿瓦 + 江水青灰，中低饱和",
  props: "赣江、城市天际线、滕王阁主楼",
  negative: "卡通、插画、3D渲染感、文字水印",
  camera_movement: "缓速推近后稳住",
  photo: "/tmp/twg-day.jpg",
  materialUsage: "generation-reference",
  motion: "缓速推近后稳住"
};

describe("素材用途硬约束", () => {
  it("没有用途声明的旧镜头卡被拒（不静默兼容）", () => {
    const legacy = { shotId: "SC-02", duration: 5, photo: "/tmp/twg-day.jpg", motion: "push-in-hard" };
    expect(isMaterialShot(legacy)).toBe(true);
    expect(() => readMaterialSpec(legacy)).toThrowError(MaterialPolicyError);
    try {
      readMaterialSpec(legacy);
    } catch (err) {
      const policyError = err as MaterialPolicyError;
      expect(policyError.code).toBe("material_usage_undeclared");
      expect(policyError.message).toContain("generation-reference");
      expect(policyError.message).toContain("素材只作生成输入");
    }
  });

  it("静态直出/展示类用途被明确否决，并指出被禁的用法", () => {
    for (const usage of ["direct-display", "static-display", "slideshow", "b-roll-photo"]) {
      const shot = { ...baseShot, materialUsage: usage };
      expect(() => readMaterialSpec(shot)).toThrowError(MaterialPolicyError);
      try {
        readMaterialSpec(shot);
      } catch (err) {
        expect((err as MaterialPolicyError).code).toBe("material_static_display_forbidden");
      }
    }
  });

  it("声明正确时读回规范化的素材规格（含描述与聚焦点钳位）", () => {
    const spec = readMaterialSpec({ ...baseShot, focus: { x: 1.8, y: -0.3 } });
    expect(spec.usage).toBe("generation-reference");
    expect(spec.photo).toBe("/tmp/twg-day.jpg");
    expect(spec.motion).toBe("缓速推近后稳住");
    expect(spec.description).toContain("滕王阁");
    expect(spec.focus).toEqual({ x: 1, y: 0 });
  });

  it("策略原文把四条红线说全（生成输入/禁止静态/禁止贴图动效/不回归成片）", () => {
    expect(MATERIAL_POLICY_STATEMENT).toContain("只作生成输入");
    expect(MATERIAL_POLICY_STATEMENT).toContain("禁止静态直出");
    expect(MATERIAL_POLICY_STATEMENT).toContain("禁止贴图式动效");
    expect(MATERIAL_POLICY_STATEMENT).toContain("无回执不算完成");
  });
});

describe("素材镜生成提示词", () => {
  const prompt = buildMaterialMotionPrompt(baseShot, { aspect: "9:16", resolution: "1080p", title: "滕王阁 · 落霞秋水" });

  it("保真、真运动、禁止静态直出三件事都在提示词里", () => {
    expect(prompt).toContain("保真硬约束");
    expect(prompt).toContain("匾额与牌匾文字");
    expect(prompt).toContain("必须生成真实运动");
    expect(prompt).toContain("云层与天空缓慢流动");
    expect(prompt).toContain("禁止静态直出");
    expect(prompt).toContain("不得整幅不变");
    expect(prompt).toContain("9:16");
    expect(prompt).toContain("无水印、无字幕");
  });

  it("没有退化标记（NaN/undefined/[object Object]）", () => {
    expect(prompt).not.toMatch(/NaN|undefined|\[object Object\]/);
    expect(prompt.length).toBeGreaterThan(500);
  });

  it("镜头运动意图与知识库注入都会被带上（缺省时给稳镜兜底）", () => {
    expect(prompt).toContain("【镜头运动】缓速推近后稳住");
    const injected = buildMaterialMotionPrompt(baseShot, { injection: "【摄影知识】光圈只进 trace，正文不写 f 值" });
    expect(injected).toContain("光圈只进 trace");
    const noMotion = buildMaterialMotionPrompt({ ...baseShot, motion: undefined, camera_movement: undefined });
    expect(noMotion).toContain("缓速推进后稳住");
  });

  it("平稳运镜保持意图，不被升级成速度坡道", () => {
    expect(prompt).toContain("运动强度要求");
    expect(prompt).toContain("不强加速度坡道或甩镜");
    expect(prompt).toContain("速度坡道");
    expect(prompt).toContain("视差");
    expect(prompt).toContain("贴图式运动");
  });

  it("重试保留原节奏，只针对失败项返修", () => {
    const escalated = buildMaterialMotionPrompt(baseShot, { motionStrength: "assertive" });
    expect(escalated).toContain("保留原动作、运镜和节奏");
    expect(escalated).not.toContain("显著加大");
  });
});

describe("运动强度判定（产品所有者第二轮反馈）", () => {
  it("真机达标的甩镜通过（9.2 / 5.6）", () => {
    const verdict = assessMotionRichness({ meanEnergy: 9.2, maxEnergy: 51.76, rampRatio: 5.63 });
    expect(verdict.rich).toBe(true);
  });

  it("「会呼吸的照片」被拦下（真机 7.4 / 1.2、2.7 / 1.1、4.1 / 1.5）", () => {
    for (const sample of [
      { meanEnergy: 7.43, maxEnergy: 9.03, rampRatio: 1.22 },
      { meanEnergy: 2.69, maxEnergy: 3.02, rampRatio: 1.12 },
      { meanEnergy: 4.05, maxEnergy: 5.91, rampRatio: 1.46 }
    ]) {
      const verdict = assessMotionRichness(sample, MATERIAL_MOTION_POLICY);
      expect(verdict.rich).toBe(false);
      expect(verdict.detail).toMatch(/运动幅度不足|缺少速度坡道/);
    }
    expect(MATERIAL_MOTION_POLICY.minMeanEnergy).toBe(8);
    expect(MATERIAL_MOTION_POLICY.minRampRatio).toBe(1.8);
  });
});

/**
 * 场景构建口径（material-scene/v1，产品所有者第三轮纠偏）：
 * "图片只是实景素材参考，是用来构建真实视频场景的，不是简单做个运镜了事，我们做的是视频。"
 */
describe("场景构建口径", () => {
  const prompt = buildMaterialScenePrompt(baseShot, { aspect: "9:16", resolution: "1080p", title: "南昌 · 滕王阁" });

  it("提示词要求「构建视频场景」而不是「把参考图动起来」", () => {
    expect(prompt).toContain("构建一段");
    expect(prompt).toContain("实景依据");
    expect(prompt).toContain("不是首帧");
    expect(prompt).toContain("机位与取景遵循镜头卡");
    expect(prompt).toContain("不得用参考照片平移缩放冒充视频");
    expect(prompt).toContain("真实三维视差");
    expect(prompt).toContain("补全画面");
    expect(prompt).toContain("参考图的边界");
    expect(prompt).toContain("禁止");
    expect(prompt).not.toMatch(/NaN|undefined|\[object Object\]/);
  });

  it("策略原文把五条红线说全（实景依据/构建场景/视差与环境运动/不复刻构图/运镜不是遮羞布）", () => {
    expect(MATERIAL_SCENE_POLICY_STATEMENT).toContain("只作实景依据");
    expect(MATERIAL_SCENE_POLICY_STATEMENT).toContain("构建出来的视频场景");
    expect(MATERIAL_SCENE_POLICY_STATEMENT).toContain("真实三维视差");
    expect(MATERIAL_SCENE_POLICY_STATEMENT).toContain("不得复刻参考图构图");
    expect(MATERIAL_SCENE_POLICY_STATEMENT).toContain("不是遮羞布");
  });

  it("重试不得擅自改变机位或新增场景元素", () => {
    const escalated = buildMaterialScenePrompt(baseShot, { motionStrength: "assertive" });
    expect(escalated).toContain("不因重试擅自加大运动");
    expect(escalated).not.toContain("云/水/人群至少两处在动");
  });
});

describe("参考独立性判定（是构建场景，还是参考图被推动）", () => {
  it("首帧就是参考图（最佳匹配 ≥32dB）判复刻", () => {
    const verdict = assessReferenceIndependence({ firstFrameBestPsnrDb: 41.2, midFrameBestPsnrDb: 18.4, directPsnrDb: 36.0 });
    expect(verdict.independent).toBe(false);
    expect(verdict.detail).toContain("参考图被推动");
  });

  it("直比同图（≥40dB）也判复刻", () => {
    const verdict = assessReferenceIndependence({ firstFrameBestPsnrDb: 30.1, midFrameBestPsnrDb: 22.0, directPsnrDb: 44.8 });
    expect(verdict.independent).toBe(false);
    expect(verdict.detail).toContain("同图");
  });

  it("中段还能高精度对回参考图（≥34dB）判复刻", () => {
    const verdict = assessReferenceIndependence({ firstFrameBestPsnrDb: 24.0, midFrameBestPsnrDb: 37.5, directPsnrDb: 27.0 });
    expect(verdict.independent).toBe(false);
  });

  it("换机位构建出来的场景（首帧/中段都对不回参考图）判通过", () => {
    const verdict = assessReferenceIndependence({ firstFrameBestPsnrDb: 22.4, midFrameBestPsnrDb: 19.8, directPsnrDb: 18.2 });
    expect(verdict.independent).toBe(true);
    expect(verdict.detail).toContain(`≥${REFERENCE_INDEPENDENCE_POLICY.reproducedPsnrDb} 判复刻`);
  });
});

describe("静态直出判定", () => {
  it("中后段连续匹配到素材像素 → 判静态直出", () => {
    const verdict = assessMaterialReuse(
      [{ atSec: 0.5, bestPsnrDb: 30 }, { atSec: 2.5, bestPsnrDb: 47.2 }, { atSec: 4.5, bestPsnrDb: 46.1 }],
      { durationSec: 5 }
    );
    expect(verdict.staticDisplay).toBe(true);
    expect(verdict.hits).toBe(2);
    expect(verdict.detail).toContain(`${MATERIAL_REUSE_POLICY.identicalPsnrDb}dB`);
  });

  it("只有前段像素材（生成从首帧开始演化）不算直出", () => {
    const verdict = assessMaterialReuse(
      [{ atSec: 0.3, bestPsnrDb: 48 }, { atSec: 2.5, bestPsnrDb: 31.4 }, { atSec: 4.5, bestPsnrDb: 27.9 }],
      { durationSec: 5 }
    );
    expect(verdict.staticDisplay).toBe(false);
    expect(verdict.hits).toBe(0);
  });

  it("测不到复用度时不冒充通过（static 判定为 false 但如实报未测到）", () => {
    const verdict = assessMaterialReuse([{ atSec: 4, bestPsnrDb: null }], { durationSec: 5 });
    expect(verdict.staticDisplay).toBe(false);
    expect(verdict.detail).toContain("未测到");
    expect(verdict.status).toBe("unverified");
    expect(verdict.passed).toBe(false);
  });

  /**
   * 真机回归（2026-09-26 · 南昌片 NC-02）：模型"从远景推近到参考照片"的后段是**深度变焦**——
   * PSNR 到不了 45dB（像素级拷贝），但结构与参考图几乎一致。只看 PSNR 会漏掉"画面就是那张照片"。
   */
  it("深度变焦后段：PSNR 未到像素级但 SSIM 高 → 仍判静态直出（视觉级命中）", () => {
    const verdict = assessMaterialReuse(
      [
        { atSec: 0.5, bestPsnrDb: 12.8, bestSsim: 0.41 },
        { atSec: 2.5, bestPsnrDb: 28.4, bestSsim: 0.86 },
        { atSec: 4.0, bestPsnrDb: 31.2, bestSsim: 0.91 }
      ],
      { durationSec: 4.9 }
    );
    expect(verdict.staticDisplay).toBe(true);
    expect(verdict.hitKind).toBe("visual");
    expect(verdict.hits).toBe(2);
    /** 首次命中要能定位到尾部起点，供自动裁剪使用 */
    expect(verdict.firstHitSec).toBe(2.5);
    expect(verdict.maxSsim).toBeCloseTo(0.91, 2);
  });

  it("真实重建场景（构图相似但两张图）不误杀：PSNR/SSIM 双低", () => {
    const verdict = assessMaterialReuse(
      [
        { atSec: 1.0, bestPsnrDb: 18.2, bestSsim: 0.58 },
        { atSec: 3.0, bestPsnrDb: 19.6, bestSsim: 0.62 },
        { atSec: 4.5, bestPsnrDb: 17.4, bestSsim: 0.55 }
      ],
      { durationSec: 5 }
    );
    expect(verdict.staticDisplay).toBe(false);
    expect(verdict.hitKind).toBeNull();
    expect(verdict.firstHitSec).toBeNull();
  });

  it("结构像但 PSNR 太低（只是构图雷同）不算命中——两指标必须互证", () => {
    const verdict = assessMaterialReuse(
      [
        { atSec: 2.0, bestPsnrDb: 21.5, bestSsim: 0.88 },
        { atSec: 4.0, bestPsnrDb: 20.1, bestSsim: 0.9 }
      ],
      { durationSec: 4.5 }
    );
    expect(verdict.staticDisplay).toBe(false);
  });
});

describe("生成溯源判据", () => {
  it("任务号/模型/素材与产物指纹齐备才放行", () => {
    expect(assertMaterialGenerationProvenance({}).ok).toBe(false);
    const ok = assertMaterialGenerationProvenance({
      renderTaskId: "task-123", model: "doubao-seedance-2-5-260628",
      sourceMaterialSha256: "aaa", outputSha256: "bbb"
    });
    expect(ok.ok).toBe(true);
    expect(ok.detail).toContain("task-123");
  });

  it("产物指纹等于素材指纹 = 素材本身（静态直出）", () => {
    const same = assertMaterialGenerationProvenance({
      renderTaskId: "task-123", model: "m", sourceMaterialSha256: "same", outputSha256: "same"
    });
    expect(same.ok).toBe(false);
    expect(same.detail).toContain("静态直出");
  });
});


describe("证据完整性与镜头意图", () => {
  it("缺失、NaN、越界和重复时间采样不能通过", () => {
    for (const samples of [[], [{ atSec: 4, bestPsnrDb: NaN }], [{ atSec: 4, bestPsnrDb: 20, bestSsim: 0.5 }, { atSec: 4, bestPsnrDb: 20, bestSsim: 0.5 }], [{ atSec: 8, bestPsnrDb: 20, bestSsim: 0.5 }, { atSec: 9, bestPsnrDb: 20, bestSsim: 0.5 }]]) {
      expect(assessMaterialReuse(samples, { durationSec: 5 }).status).toBe("unverified");
    }
    expect(assessReferenceIndependence({ firstFrameBestPsnrDb: null, midFrameBestPsnrDb: null, directPsnrDb: null })).toMatchObject({ status: "unverified", independent: false });
    expect(assessReferenceIndependence({ firstFrameBestPsnrDb: NaN, midFrameBestPsnrDb: 20, directPsnrDb: 20 }).independent).toBe(false);
  });
  it("PSNR 正无穷是像素相同，不是缺失测量", () => {
    expect(assessMaterialReuse([{ atSec: 2, bestPsnrDb: Infinity }, { atSec: 4, bestPsnrDb: Infinity }], { durationSec: 5 }).status).toBe("failed");
    expect(assessReferenceIndependence({ firstFrameBestPsnrDb: Infinity, midFrameBestPsnrDb: 20, directPsnrDb: 20 }).status).toBe("failed");
  });
  it("完整低相似采样可以通过，但缺SSIM不能证明视觉级未复用", () => {
    const samples = [{ atSec: 2.5, bestPsnrDb: 20, bestSsim: 0.4 }, { atSec: 4.5, bestPsnrDb: 21, bestSsim: 0.5 }];
    expect(assessMaterialReuse(samples, { durationSec: 5 }).status).toBe("passed");
    expect(assessMaterialReuse(samples.map(({ bestSsim, ...s }) => s), { durationSec: 5 }).status).toBe("unverified");
  });
  it("固定机位、平稳推镜、快速镜与速度坡道分别评估", () => {
    const quiet = { meanEnergy: 0.1, maxEnergy: 0.15, rampRatio: 1.5, frames: 12 };
    expect(assessMotionRichness(quiet, motionPolicyForShot({ motion: "固定机位" })).rich).toBe(true);
    expect(assessMotionRichness({ meanEnergy: 2, maxEnergy: 2, rampRatio: 1 }, motionPolicyForShot({ motion: "缓慢匀速推近" })).rich).toBe(true);
    expect(assessMotionRichness(quiet, motionPolicyForShot({ motion: "高速甩镜" })).rich).toBe(false);
    expect(motionPolicyForShot({ motion: "匀速推进，不要速度坡道" }).intent).toBe("steady");
    expect(motionPolicyForShot({ motion: "速度坡道快起稳收" }).intent).toBe("speed-ramp");
    expect(buildMaterialScenePrompt({ ...baseShot, motion: "固定机位" }, { motionStrength: "assertive" })).toContain("不额外加入推拉或速度坡道");
  });
  it("坏运动读数不能用高分掩盖", () => {
    for (const v of [NaN, Infinity, -1]) expect(assessMotionRichness({ meanEnergy: v, maxEnergy: 20, rampRatio: 2 }).status).toBe("unverified");
    expect(assessMotionRichness({ meanEnergy: 20, maxEnergy: 10, rampRatio: 2 }).status).toBe("unverified");
  });
});
