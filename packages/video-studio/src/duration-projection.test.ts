import { describe, expect, it } from "vitest";
import {
  applyProjectedDurations,
  computeVoiceFloor,
  countVisibleUnits,
  projectShotDurations,
  resolveRateKey,
  type ProjectionShotInput,
} from "./duration-projection.js";

/**
 * T-2026-0925-0001：镜头时长单点守恒投影器。
 *
 * 断言口径（对应本仓实测问题）：
 *   ① 每镜 ≥ 台词硬下限（含"占比 ≤80%"推导出的 1.25× 与单句极限语速）
 *   ② Σ镜长 = 目标总时长（整数秒，无漂移）
 *   ③ 每镜 ∈ [模型下限, 模型上限]
 *   ④ 无解时返回结构化 INFEASIBLE，而不是静默压低台词下限
 *   ⑤ 情绪归一后同一句台词得到同一下限（原实现恒回落 3.5 字/s）
 */

const LINE_48 = "第七天清晨他在会议室里突然失手打翻了咖啡，手抖得连杯子都握不住，那一刻他才意识到身体真的在报警。";

function shot(id: string, duration: number, text?: string, extra: Partial<ProjectionShotInput> = {}): ProjectionShotInput {
  return {
    shotId: id,
    duration,
    dialogue: text === undefined ? undefined : { has_dialogue: true, lines: [{ text }], blocks: [{ line: text }] },
    ...extra,
  };
}

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

describe("情绪 → 语速归一（修复恒回落 3.5 字/s）", () => {
  it("英文副词 / 复合 mood 串 / arousal 数值都能命中同一档位", () => {
    expect(resolveRateKey("confidently")).toBe("fast");
    expect(resolveRateKey("hesitates")).toBe("slow");
    expect(resolveRateKey("gently")).toBe("slow");
    expect(resolveRateKey("tense, serious, intense, dramatic")).toBe("fast");
    expect(resolveRateKey("紧张, 沉重, 爆发")).toBe("normal");
    expect(resolveRateKey("arousal:0.9")).toBe("fast");
    expect(resolveRateKey("arousal:0.1")).toBe("slow");
    expect(resolveRateKey(undefined)).toBe("normal");
    expect(resolveRateKey("very gently")).toBe("slow");
  });

  it("同一句台词：慢情绪的下限必须高于快情绪（原实现两者相同）", () => {
    const slow = computeVoiceFloor(shot("S1", 12, LINE_48, { emotion: "gently" }));
    const fast = computeVoiceFloor(shot("S1", 12, LINE_48, { emotion: "confidently" }));
    expect(slow.seconds).toBeGreaterThan(fast.seconds);
    // 原实现把复合 mood 串当未命中 → 与"显式 slow"不同；归一后必须命中
    const compoundSlow = computeVoiceFloor(shot("S1", 12, LINE_48, { mood: "peaceful, gently, nostalgic" }));
    expect(compoundSlow.seconds).toBe(slow.seconds);
  });
});

describe("台词硬下限（三条规则取 max）", () => {
  it("占比规则（÷0.8）在长台词场景下成为主导下限", () => {
    const floor = computeVoiceFloor(shot("S1", 30, LINE_48));
    expect(floor.driver).toBe("ratio-0.8");
    expect(floor.seconds).toBe(Math.ceil(floor.ratioSeconds));
    expect(floor.ratioSeconds).toBeGreaterThan(floor.lineLimitSeconds);
  });

  it("无台词镜头下限为 0（由模型下限兜底）", () => {
    const floor = computeVoiceFloor(shot("S1", 6));
    expect(floor.seconds).toBe(0);
  });

  it("可见字数口径与交付闸一致（剔除标点）", () => {
    expect(countVisibleUnits("你好，世界！")).toBe(4);
    expect(countVisibleUnits("Done already.")).toBe(11);
  });
});

describe("守恒投影（性质测试）", () => {
  it("200 组随机用例：守恒 + 上下限 + 不低于台词下限", () => {
    const rnd = lcg(20260925);
    for (let round = 0; round < 200; round += 1) {
      const count = 3 + Math.floor(rnd() * 6);
      const shots: ProjectionShotInput[] = Array.from({ length: count }, (_, index) => {
        const text = rnd() < 0.6 ? "字".repeat(4 + Math.floor(rnd() * 60)) : undefined;
        const emotion = ["gently", "confidently", "normal", "tense, serious", "calm"][Math.floor(rnd() * 5)];
        return shot(`S${index + 1}`, 3 + Math.floor(rnd() * 40), text, { emotion });
      });
      const target = 20 + Math.floor(rnd() * 120);
      const result = projectShotDurations(shots, { targetSeconds: target, minSeconds: 4, maxSeconds: 30 });
      if (!result.ok) continue; // INFEASIBLE 由下一组用例专门覆盖
      expect(result.totalSeconds, `round=${round} 目标 ${target} 未守恒`).toBe(target);
      for (const entry of result.entries) {
        expect(entry.seconds).toBeGreaterThanOrEqual(4);
        expect(entry.seconds).toBeLessThanOrEqual(30);
        expect(entry.seconds).toBeGreaterThanOrEqual(Math.min(30, entry.voiceFloorSeconds));
      }
    }
  });

  it("确定性：同输入两次投影结果完全一致", () => {
    const shots = [shot("S1", 5, "字".repeat(20)), shot("S2", 20, "字".repeat(40), { emotion: "gently" }), shot("S3", 8)];
    const first = projectShotDurations(shots, { targetSeconds: 45 });
    const second = projectShotDurations(shots, { targetSeconds: 45 });
    expect(first).toEqual(second);
  });

  it("台词下限超过目标 → INFEASIBLE（不静默压低台词）", () => {
    const shots = [shot("S1", 5, LINE_48), shot("S2", 5, LINE_48), shot("S3", 5, LINE_48)];
    const result = projectShotDurations(shots, { targetSeconds: 20, minSeconds: 4, maxSeconds: 30 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("应当 INFEASIBLE");
    expect(result.reason).toBe("voice-floor-exceeds-target");
    expect(result.overloadSeconds).toBeGreaterThan(0);
    expect(result.suggestions.join(" ")).toContain("精简台词");
  });

  it("镜头数 × 上限 < 目标 → INFEASIBLE（并给出加镜建议）", () => {
    const shots = [shot("S1", 10), shot("S2", 10)];
    const result = projectShotDurations(shots, { targetSeconds: 90, minSeconds: 4, maxSeconds: 30 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("应当 INFEASIBLE");
    expect(result.reason).toBe("capacity-below-target");
    expect(result.suggestions.join(" ")).toContain("增加镜头数");
  });

  it("计划时长低于台词下限时被抬高，并在 raisedShotIds 里如实登记", () => {
    const shots = [shot("S1", 5, LINE_48), shot("S2", 35)];
    const result = projectShotDurations(shots, { targetSeconds: 60, minSeconds: 4, maxSeconds: 30 });
    if (!result.ok) throw new Error(`不应 INFEASIBLE：${JSON.stringify(result)}`);
    expect(result.raisedShotIds).toContain("S1");
    const s1 = result.entries.find((entry) => entry.shotId === "S1")!;
    expect(s1.seconds).toBeGreaterThanOrEqual(s1.voiceFloorSeconds);
    expect(result.totalSeconds).toBe(60);
  });
});

describe("写回：消除 duration / timing 双字段分叉", () => {
  it("同步顶层 duration 与 timing{start,duration,end}，时间轴连续", () => {
    const shots = [
      { shotId: "S1", duration: 5, timing: { start: 0, duration: 5, end: 5 } },
      { shotId: "S2", duration: 20, timing: { start: 5, duration: 20, end: 25 } },
    ];
    const result = projectShotDurations(shots, { targetSeconds: 30, minSeconds: 4, maxSeconds: 30 });
    if (!result.ok) throw new Error("不应 INFEASIBLE");
    const applied = applyProjectedDurations(shots, result.entries);
    expect(applied[0]!.duration).toBe(applied[0]!.timing.duration);
    expect(applied[0]!.timing.start).toBe(0);
    expect(applied[0]!.timing.end).toBe(applied[1]!.timing.start);
    expect(applied[1]!.timing.end).toBe(30);
  });
});
