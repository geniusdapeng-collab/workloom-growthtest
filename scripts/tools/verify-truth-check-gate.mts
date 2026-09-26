#!/usr/bin/env node
/**
 * verify-truth-check-gate.mts —— 营销片「事实红线闸」接线验证（T-2026-0926-0103）
 *
 * 为什么不用 vitest：vendor `index.js` 是 CommonJS 源码树，其中 `vendor/supermickey/systems/*.js`
 * 位于根的 `"type": "module"` 作用域下，vitest 的 ESM 解析器会把它当 ES Module 报
 * `module is not defined`（既有事实）。应用运行时走 tsx/CJS 互操作，因此这里用 tsx 脚本验证，
 * 直接实例化真实的 `HyperrealitySystem` 并调用接线后的 `_runProductTruthCheckGate`。
 *
 * 三类断言（任一不满足即退出码 1）：
 *   ① 非营销片：不执行闸、不写阶段（故事片零影响）；
 *   ② 营销片 + 无情报证据：degraded=no-evidence，不误阻断；
 *   ③ 营销片 + 档案事实与创意前提矛盾：blocking=true、status=rejected、factRedLines 落账。
 *
 * 运行：pnpm exec tsx scripts/tools/verify-truth-check-gate.mts
 */
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const require_ = createRequire(import.meta.url);
const ROOT = resolve(import.meta.dirname, "..", "..");
const VENDOR = join(ROOT, "vendor/supermickey/hyperreality-system");

const { HyperrealitySystem } = require_(join(VENDOR, "index.js")) as {
  HyperrealitySystem: new (options?: Record<string, unknown>) => {
    _runProductTruthCheckGate: (
      metadata: Record<string, unknown>,
      result: Record<string, unknown>,
    ) => { blocking: boolean; degraded: boolean };
  };
};

const failures: string[] = [];
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? `  ← ${detail}` : ""}`);
  if (!ok) failures.push(label);
};

const system = new HyperrealitySystem({});

// ① 非营销片：零影响
{
  const result: Record<string, unknown> = { stages: {} };
  const gate = system._runProductTruthCheckGate({ pipelineRoute: { kind: "narrative" } }, result);
  check("① 非营销片不执行闸", gate.blocking === false && (result.stages as Record<string, unknown>).truthCheck === undefined);
}

// ② 营销片无情报证据：降级通过，不误阻断
{
  const result: Record<string, unknown> = { stages: {} };
  const gate = system._runProductTruthCheckGate({ pipelineRoute: { kind: "marketing" } }, result);
  const stage = (result.stages as Record<string, { degraded?: boolean; degradedReason?: string }>).truthCheck;
  check(
    "② 无证据降级通过（no-evidence）",
    gate.blocking === false && gate.degraded === true && stage.degraded === true && stage.degradedReason === "no-evidence",
    `gate=${JSON.stringify(gate)} stage=${JSON.stringify(stage)}`,
  );
}

// ③ 事实矛盾：阻断 + 红线落账
{
  const metadata: Record<string, unknown> = {
    pipelineRoute: { kind: "marketing" },
    brief: { product: "星野空气循环扇", category: "3C 数码 家电" },
    _creativeTheme: { theme: "无需手机、脱离 App 也能直接用", title: "解放双手" },
  };
  const result: Record<string, unknown> = {
    stages: {
      dataMining: {
        data: {
          dossier: {
            identity: {
              name: "星野空气循环扇",
              category: "3C 数码 家电",
              price_band: "399-499 元",
              specs: {
                控制方式: { value: "必须绑定手机 App 才能启用自然风", source_url: "https://brand.example.com/spec" },
              },
              official_selling_points: [],
            },
            pros_cons: { pros: [], cons: [] },
          },
        },
      },
    },
  };
  const gate = system._runProductTruthCheckGate(metadata, result);
  const stage = (result.stages as Record<string, { status?: string; conflicts?: unknown[]; factRedLines?: string[] }>).truthCheck;
  const errors = (result.errors as Array<{ stage: string; fatal?: boolean }>) ?? [];
  check(
    "③ 事实矛盾 → 阻断（rejected）",
    gate.blocking === true && stage.status === "rejected" && (stage.conflicts?.length ?? 0) > 0,
    `conflicts=${JSON.stringify(stage.conflicts)}`,
  );
  check(
    "③′ 事实红线写回 metadata + 报错留痕",
    (stage.factRedLines?.length ?? 0) > 0
      && JSON.stringify(metadata._factRedLines) === JSON.stringify(stage.factRedLines)
      && errors.some((e) => e.stage === "ProductTruthChecker" && e.fatal),
    `redLines=${stage.factRedLines?.length ?? 0}`,
  );
}

console.log(failures.length === 0 ? "\n✓ 事实红线闸接线验证通过（3/3）" : `\n✗ ${failures.length} 项未通过`);
process.exit(failures.length === 0 ? 0 : 1);
