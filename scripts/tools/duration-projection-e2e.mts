#!/usr/bin/env tsx
/**
 * duration-projection-e2e.mts —— 镜头时长投影的**全链路校验**（T-2026-0925-0001）
 *
 * 为什么要单独一个 tsx 脚本：vendor `systems/*.js` 是 CJS 但所在目录没有 package.json，
 * 在纯 ESM 加载器（vitest）下无法加载；本项目生产运行时是 tsx（`apps/server` 的启动方式），
 * 所以凡涉及 vendor `systems/**` 的断言都放在这里跑，保证"测的就是生产真实路径"。
 *
 * 覆盖：
 *   ① ProductionEngine._normalizeDurations：不再把差额塞给最后一镜、不再越出 [4,30]
 *   ② 端到端编排：LLM 输出 → 剧本总量对齐 → 台词修复 → 制作归一 → 运行期约束
 *      最终必须满足：台词 critical = 0、Σ时长 = 目标、每镜 ∈ [4,30]、duration 与 timing 不分叉
 *
 * 用法：tsx scripts/tools/duration-projection-e2e.mts
 */
import { createRequire } from "node:module";
import { resolve as resolvePath } from "node:path";
import { installVendorDurationProjectionBridge } from "../../packages/video-studio/src/index.js";

const REPO_ROOT = resolvePath(import.meta.dirname ?? process.cwd(), "../..");
const require = createRequire(resolvePath(REPO_ROOT, "package.json"));

const { DialogueTimingCalculator } = require(
  resolvePath(REPO_ROOT, "vendor/supermickey/hyperreality-system/utils/dialogue-timing-calculator.js")
) as { DialogueTimingCalculator: new (o?: Record<string, unknown>) => { validateShots(shots: unknown[]): { criticalCount: number; results: Array<Record<string, unknown>> } } };
const { ProductionEngine } = require(
  resolvePath(REPO_ROOT, "vendor/supermickey/hyperreality-system/engines/production-engine/production-engine.js")
) as { ProductionEngine: { prototype: Record<string, unknown> } };
const { ScriptGenerator } = require(
  resolvePath(REPO_ROOT, "vendor/supermickey/hyperreality-system/engines/script-engine/core/script-generator.js")
) as { ScriptGenerator: { prototype: Record<string, unknown> } };
const { Phase3PromptFusion } = require(
  resolvePath(REPO_ROOT, "vendor/supermickey/hyperreality-system/engines/production-engine/phases/phase-3-prompt-fusion.js")
) as { Phase3PromptFusion: { prototype: Record<string, unknown> } };
const { DurationConstraintManager } = require(
  resolvePath(REPO_ROOT, "vendor/supermickey/hyperreality-system/engines/duration-constraint/duration-constraint-manager.js")
) as { DurationConstraintManager: new (o?: Record<string, unknown>) => Record<string, unknown> };

const LINE_LONG =
  "第七天清晨他在会议室里突然失手打翻了咖啡，手抖得连杯子都握不住，那一刻他才意识到身体真的在报警。";

function scene(id: string, type: string, duration: number, text: string, emotion = "normal") {
  return {
    scene_id: id,
    scene_type: type,
    scene_function: type,
    emotion,
    timing: { start: 0, duration, end: duration },
    duration,
    dialogue: { has_dialogue: true, lines: [{ text, emotion }], blocks: [{ line: text, emotion, type: "narration" }] },
  };
}

function fixture() {
  return [
    scene("SC01", "opening", 6, "熬夜加班三个月，他的体检报告出现了三个红箭头。"),
    scene("SC02", "establishing", 12, "医生说问题不大，但需要立刻调整作息，否则半年后就是另一份报告。"),
    scene("SC03", "conflict", 12, "他把所有希望押在一款号称三天见效的保健品上，每天按时服用，却越睡越晚。"),
    scene("SC04", "emotional_climax", 12, LINE_LONG, "gently"),
    scene("SC05", "resolution", 12, "医生给他列了三条最朴素的建议：定时睡、每天走六千步、把夜宵换成一杯温水。"),
    scene("SC06", "resolution", 6, "三个月后，他的报告只剩下一个箭头。"),
  ];
}

function feasibility(shots: Array<Record<string, unknown>>) {
  const calc = new DialogueTimingCalculator({ autoAdjust: false });
  return calc.validateShots(
    shots.map((shot) => ({
      shot_id: shot.scene_id ?? shot.shotId,
      duration: Number(shot.duration ?? (shot.timing as Record<string, unknown> | undefined)?.duration ?? 0),
      emotion: shot.emotion,
      dialogue: shot.dialogue,
    }))
  );
}

const failures: string[] = [];
function check(label: string, condition: boolean, detail: string): void {
  console.log(`${condition ? "✅" : "❌"} ${label}${detail ? ` · ${detail}` : ""}`);
  if (!condition) failures.push(label);
}

const uninstall = installVendorDurationProjectionBridge({ log: (line) => console.log(`   ${line}`) });
try {
  /* ---------- ① 制作引擎归一：最后一镜不再兜底 ---------- */
  const normalizeInput = [
    { shotId: "S1", duration: 6, timing: { start: 0, duration: 6, end: 6 } },
    { shotId: "S2", duration: 12, timing: { start: 6, duration: 12, end: 18 } },
    { shotId: "S3", duration: 12, timing: { start: 18, duration: 12, end: 30 } },
    { shotId: "S4", duration: 52, timing: { start: 30, duration: 52, end: 82 }, dialogue: { lines: [{ text: LINE_LONG }] } },
    { shotId: "S5", duration: 12, timing: { start: 82, duration: 12, end: 94 } },
    { shotId: "S6", duration: 6, timing: { start: 94, duration: 6, end: 100 } },
  ];
  const normalized = (
    ProductionEngine.prototype._normalizeDurations as (shots: unknown, target: unknown) => Array<Record<string, unknown>>
  ).call({}, normalizeInput, 60);
  const normDurations = normalized.map((shot) => Number(shot.duration));
  check(
    "制作引擎归一：总时长守恒",
    normDurations.reduce((sum, value) => sum + value, 0) === 60,
    `Σ=${normDurations.reduce((sum, value) => sum + value, 0)}s`
  );
  check("制作引擎归一：无 >30s 越界镜", Math.max(...normDurations) <= 30, `max=${Math.max(...normDurations)}s`);
  check("制作引擎归一：无 <4s 镜", Math.min(...normDurations) >= 4, `min=${Math.min(...normDurations)}s`);
  check(
    "制作引擎归一：duration 与 timing.duration 不分叉",
    normalized.every(
      (shot) => Number(shot.duration) === Number((shot.timing as Record<string, unknown>).duration)
    ),
    ""
  );

  /* ---------- ② 端到端编排（与生产同序） ---------- */
  const scenes = fixture();
  const parsed = { structure: { scenes }, meta: {} as Record<string, unknown> };
  (ScriptGenerator.prototype._enforceTargetDuration as (p: unknown, t: unknown) => void).call({}, parsed, 60);
  const afterScript = scenes.map((item) => ({ ...item }));

  const fusion = Object.create(Phase3PromptFusion.prototype) as Record<string, unknown>;
  fusion.log = () => undefined;
  const shotsAfterPhase3 = (await (fusion._checkDialogueTiming as (s: unknown, b: unknown) => Promise<Array<Record<string, unknown>>>).call(
    fusion,
    afterScript.map((item) => ({ ...item })),
    { productionProfile: { dialogue_density: "high" } }
  )) as Array<Record<string, unknown>>;

  const finalShots = (
    ProductionEngine.prototype._normalizeDurations as (shots: unknown, target: unknown) => Array<Record<string, unknown>>
  ).call({}, shotsAfterPhase3, 60);

  const manager = new DurationConstraintManager({ maxSingleShot: 30, minSingleShot: 4 }) as Record<string, unknown>;
  (manager.constrain as (s: unknown, o?: unknown) => unknown).call(manager, finalShots, {
    targetDuration: 60,
    rhythmType: "standard",
    forceAdjust: true,
  });

  const durations = finalShots.map((shot) => Number(shot.duration));
  const total = durations.reduce((sum, value) => sum + value, 0);
  const report = feasibility(finalShots);
  check("端到端：总时长守恒（60s）", total === 60, `Σ=${total}s`);
  check("端到端：每镜 ∈ [4,30]", Math.min(...durations) >= 4 && Math.max(...durations) <= 30, `[${Math.min(...durations)}, ${Math.max(...durations)}]`);
  check("端到端：台词 critical 溢出 = 0", report.criticalCount === 0, `critical=${report.criticalCount}`);
  check(
    "端到端：duration 与 timing.duration 不分叉",
    finalShots.every((shot) => Number(shot.duration) === Number((shot.timing as Record<string, unknown>).duration)),
    ""
  );
  console.log(
    `   逐镜：${finalShots
      .map((shot) => `${shot.scene_id ?? shot.shotId}:${shot.duration}s`)
      .join("  ")}`
  );
} finally {
  uninstall();
}

if (failures.length > 0) {
  console.error(`\n时长投影端到端校验失败：${failures.join("；")}`);
  process.exit(1);
}
console.log("\n✅ 时长投影端到端校验全部通过");
