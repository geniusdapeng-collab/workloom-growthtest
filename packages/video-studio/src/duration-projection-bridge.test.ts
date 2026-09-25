import { createRequire } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  installSharedBridge,
  installVendorDurationProjectionBridge,
  listSharedBridges,
  type DurationProjectionEvent,
} from "./vendor-compat.js";

/**
 * T-2026-0925-0001：时长投影桥的**真行为**回归。
 * 断言的是"vendor 侧任何路径都不可能再产出越界/失衡/说不完的时长"，
 * 而不是"某一行代码被改过"。
 */
const repoRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "../../..");
const vendorRequire = createRequire(resolvePath(repoRoot, "package.json"));

/**
 * vendor `systems/*.js` 是 CJS 但所在目录无 package.json，在纯 ESM 加载器（vitest）下会失败；
 * 因此逐个容错加载：加载不到的用例跳过，并由 `scripts/tools/duration-projection-e2e.mts`
 *（tsx 运行时，与生产一致）覆盖。
 */
function tryLoadVendor<T>(path: string): T | null {
  try {
    return vendorRequire(resolvePath(repoRoot, path)) as T;
  } catch {
    return null;
  }
}

const ScriptGeneratorMod = tryLoadVendor<{ ScriptGenerator: { prototype: Record<string, unknown> } }>(
  "vendor/supermickey/hyperreality-system/engines/script-engine/core/script-generator.js"
);
const ProductionEngineMod = tryLoadVendor<{ ProductionEngine: { prototype: Record<string, unknown> } }>(
  "vendor/supermickey/hyperreality-system/engines/production-engine/production-engine.js"
);
const DcmMod = tryLoadVendor<{ DurationConstraintManager: new (o?: Record<string, unknown>) => Record<string, unknown> }>(
  "vendor/supermickey/hyperreality-system/engines/duration-constraint/duration-constraint-manager.js"
);
const DtcMod = tryLoadVendor<{ DialogueTimingCalculator: new (o?: Record<string, unknown>) => Record<string, unknown> }>(
  "vendor/supermickey/hyperreality-system/utils/dialogue-timing-calculator.js"
);

const ScriptGenerator = ScriptGeneratorMod?.ScriptGenerator;
const ProductionEngine = ProductionEngineMod?.ProductionEngine;
const DurationConstraintManager = DcmMod?.DurationConstraintManager;
const DialogueTimingCalculator = DtcMod?.DialogueTimingCalculator;

const LINE_48 =
  "第七天清晨他在会议室里突然失手打翻了咖啡，手抖得连杯子都握不住，那一刻他才意识到身体真的在报警。";

function scene(id: string, duration: number, text?: string, extra: Record<string, unknown> = {}) {
  return {
    scene_id: id,
    scene_type: "conflict",
    timing: { start: 0, duration, end: duration },
    duration,
    dialogue: text ? { has_dialogue: true, lines: [{ text }], blocks: [{ line: text }] } : undefined,
    ...extra,
  };
}

let uninstall: (() => void) | null = null;
afterEach(() => {
  uninstall?.();
  uninstall = null;
});

describe("时长投影桥：vendor 侧不再产出越界/失衡时长", () => {
  it.skipIf(!ScriptGenerator)("剧本总量对齐：60s 巨镜被压回模型上限，且总时长守恒", () => {
    const events: DurationProjectionEvent[] = [];
    uninstall = installVendorDurationProjectionBridge({ log: () => undefined, onEvent: (e) => events.push(e), maxShotSeconds: 30, minShotSeconds: 4 });
    const parsed = {
      structure: { scenes: [scene("SC01", 3), scene("SC02", 60, LINE_48), scene("SC03", 3)] },
      meta: {},
    };
    (ScriptGenerator!.prototype._enforceTargetDuration as (p: unknown, t: unknown) => void).call({}, parsed, 60);
    const durations = parsed.structure.scenes.map((s) => Number(s.timing.duration));
    expect(durations.reduce((a, b) => a + b, 0)).toBe(60);
    expect(Math.max(...durations)).toBeLessThanOrEqual(30);
    expect(Math.min(...durations)).toBeGreaterThanOrEqual(4);
    // 台词硬下限必须被尊重（48 字长台词镜头不可能只给 3s）
    const longShot = parsed.structure.scenes.find((s) => s.scene_id === "SC02")!;
    expect(Number(longShot.timing.duration)).toBeGreaterThanOrEqual(18);
    expect(events.some((e) => e.kind === "projected" && e.source === "script-generator")).toBe(true);
  });

  it.skipIf(!ProductionEngine)("制作引擎归一：不再把差额全塞给最后一镜（100s → 60s 无 31s 越界镜）", () => {
    uninstall = installVendorDurationProjectionBridge({ log: () => undefined });
    const shots = [
      { shotId: "S1", duration: 6, timing: { start: 0, duration: 6, end: 6 } },
      { shotId: "S2", duration: 12, timing: { start: 6, duration: 12, end: 18 } },
      { shotId: "S3", duration: 12, timing: { start: 18, duration: 12, end: 30 } },
      { shotId: "S4", duration: 52, timing: { start: 30, duration: 52, end: 82 }, dialogue: { lines: [{ text: LINE_48 }] } },
      { shotId: "S5", duration: 12, timing: { start: 82, duration: 12, end: 94 } },
      { shotId: "S6", duration: 6, timing: { start: 94, duration: 6, end: 100 } },
    ];
    const out = (ProductionEngine!.prototype._normalizeDurations as (s: unknown, t: unknown) => Array<{ shotId: string; duration: number; timing: { duration: number } }>).call(
      {},
      shots,
      60
    );
    const total = out.reduce((sum, shot) => sum + Number(shot.duration), 0);
    expect(total).toBe(60);
    for (const shot of out) {
      expect(shot.duration).toBeLessThanOrEqual(30);
      expect(shot.duration).toBeGreaterThanOrEqual(4);
      // duration 与 timing.duration 不再分叉
      expect(shot.duration).toBe(shot.timing.duration);
    }
  });

  it.skipIf(!DurationConstraintManager)("运行期约束：权重表重分配停用（不再抹平台词适配），总时长守恒", () => {
    const events: DurationProjectionEvent[] = [];
    uninstall = installVendorDurationProjectionBridge({ log: () => undefined, onEvent: (e) => events.push(e) });
    const manager = new DurationConstraintManager!({ maxSingleShot: 30, minSingleShot: 4 });
    const scenes = [
      scene("SC01", 6),
      scene("SC02", 12),
      scene("SC03", 12),
      scene("SC04", 26, LINE_48, { scene_type: "emotional_climax" }),
      scene("SC05", 12),
      scene("SC06", 6),
    ];
    (manager.constrain as (s: unknown, o?: unknown) => unknown).call(manager, scenes, { targetDuration: 60, rhythmType: "standard" });
    const total = scenes.reduce((sum, s) => sum + Number(s.timing.duration), 0);
    expect(total).toBe(60);
    const long = scenes.find((s) => s.scene_id === "SC04")!;
    expect(Number(long.timing.duration)).toBeGreaterThanOrEqual(18);
    expect(events.some((e) => e.source === "dcm.constrain")).toBe(true);
  });

  it.skipIf(!DialogueTimingCalculator)("台词引擎情绪归一：复合 mood 串与副词都能改变语速", () => {
    uninstall = installVendorDurationProjectionBridge({ log: () => undefined });
    const calc = new DialogueTimingCalculator!({ autoAdjust: false }) as Record<string, unknown>;
    const getRate = (emotion?: string): number =>
      (calc._getSpeechRate as (this: unknown, e?: string) => number).call(calc, emotion);
    expect(getRate("tense, serious, intense, dramatic")).toBe(4.5);
    expect(getRate("gently")).toBe(2.5);
    expect(getRate("confidently")).toBe(4.5);
    expect(getRate("正常/未收录词")).toBe(3.5);
  });

  it.skipIf(!DialogueTimingCalculator)("缩短台词目标自洽：缩短后的可见字数满足占比 ≤80% 规则", () => {
    uninstall = installVendorDurationProjectionBridge({ log: () => undefined });
    const calc = new DialogueTimingCalculator!({ autoAdjust: true, adjustStrategy: "smart" }) as Record<string, unknown>;
    const shot = {
      shot_id: "S1",
      duration: 12,
      dialogue: { lines: [{ text: LINE_48 }], blocks: [{ line: LINE_48 }] },
    };
    const fix = (calc._generateFix as (s: unknown, t: string) => { type: string; suggestedText: string; targetChars: number } | null).call(
      calc,
      shot,
      "overflow"
    );
    expect(fix?.type).toBe("shorten_dialogue");
    const visible = String(fix!.suggestedText).replace(/[，。！？；：、…—""''（）,.!?;:'"()\-—…\s]/g, "").length;
    // 12s × 0.8 × 3.5 = 33.6 → 缩短后可见字数必须 ≤ 33
    expect(visible).toBeLessThanOrEqual(33);
    // 且不得留下残句（不能以逗号/顿号收尾）
    expect(/[，、；：,;:]$/.test(fix!.suggestedText)).toBe(false);
  });
});

describe("共享桥引用计数（并发 run 不互相拆桥）", () => {
  it("两个持有者：先释放一个，补丁仍在；全部释放后才还原", () => {
    let installed = 0;
    let restored = 0;
    const a = installSharedBridge("test-bridge", () => {
      installed += 1;
      return () => {
        restored += 1;
      };
    });
    const b = installSharedBridge("test-bridge", () => {
      installed += 1;
      return () => {
        restored += 1;
      };
    });
    expect(installed).toBe(1);
    expect(listSharedBridges().find((entry) => entry.key === "test-bridge")?.refs).toBe(2);
    a();
    expect(restored).toBe(0);
    b();
    expect(restored).toBe(1);
    expect(listSharedBridges().some((entry) => entry.key === "test-bridge")).toBe(false);
  });
});
