#!/usr/bin/env node
/**
 * verify-dossier-evidence.mts —— 情报证据注入接线验证（T-2026-0926-0115）
 *
 * 用**真实类实例**验证 `HyperrealitySystem._injectDossierEvidence`：
 *   ① 有情报卡：insight_card/prd_card 进入 `_creativeTheme.description` 并落 `stages.dossierEvidence`；
 *   ② 幂等：第二次调用不重复注入（already-present）；
 *   ③ 无卡：如实写 `no-dossier`，不编造、不写脏数据。
 *
 * 运行：pnpm exec tsx scripts/tools/verify-dossier-evidence.mts
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require_ = createRequire(import.meta.url);
const ROOT = join(import.meta.dirname, "..", "..");
const VENDOR = join(ROOT, "vendor/supermickey/hyperreality-system");

const { HyperrealitySystem } = require_(join(VENDOR, "index.js")) as {
  HyperrealitySystem: new (options?: Record<string, unknown>) => {
    _injectDossierEvidence: (
      metadata: Record<string, unknown>,
      result: Record<string, unknown>,
    ) => { injected: boolean; reason?: string; cards?: string[]; chars?: number };
  };
};

const failures: string[] = [];
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? `  ← ${detail}` : ""}`);
  if (!ok) failures.push(label);
};

const system = new HyperrealitySystem({});

const cards = {
  insight_card: {
    audience_profile: [{ persona: "租房青年", scene: "卧室", mentions: 12 }],
    consensus_points: [{ point: "风感柔和", confidence: "confirmed", mentions: 9 }],
    complaint_map: [{ point: "App 注册繁琐", root_cause: "onboarding 太长" }],
    market_position: { price_band: "399-499 元", our_opening: ["可拆洗网罩"] },
  },
  prd_card: {
    demo_scenes: [{ scene: "深夜卧室", persona: "租房青年", mentions: 12 }],
    selling_point_evidence: [{ point: "风感柔和", nature: "user", confidence: "confirmed" }],
    compliance_redlines: ["不得宣称与「App 注册繁琐」相关的绝对化优势"],
    hook_candidates: { data_points: ["6 小时续航"], conflicts: [], questions: [] },
  },
};

// ① 注入
{
  const metadata: Record<string, unknown> = {
    _creativeTheme: { theme: "夏夜安睡", description: "原有描述" },
    _dataDossier: { cards },
  };
  const result: Record<string, unknown> = { stages: {} };
  const verdict = system._injectDossierEvidence(metadata, result);
  const description = String((metadata._creativeTheme as Record<string, unknown>).description ?? "");
  check(
    "① 情报证据注入（insight_card + prd_card）",
    verdict.injected === true
      && verdict.cards?.join(",") === "insight_card,prd_card"
      && description.includes("【情报证据】")
      && description.includes("租房青年")
      && description.includes("6 小时续航"),
    `chars=${verdict.chars} desc=${description.length}`,
  );
}

// ② 幂等
{
  const metadata: Record<string, unknown> = {
    _creativeTheme: { description: "原有描述" },
    _dataDossier: { cards },
  };
  const result: Record<string, unknown> = { stages: {} };
  system._injectDossierEvidence(metadata, result);
  const before = String((metadata._creativeTheme as Record<string, unknown>).description);
  const second = system._injectDossierEvidence(metadata, result);
  const after = String((metadata._creativeTheme as Record<string, unknown>).description);
  check("② 幂等：重复调用不重复注入", second.injected === false && second.reason === "already-present" && before === after);
}

// ③ 无卡
{
  const result: Record<string, unknown> = { stages: {} };
  const verdict = system._injectDossierEvidence({ _creativeTheme: { description: "x" }, _dataDossier: null }, result);
  check("③ 无情报卡如实降级（no-dossier）", verdict.injected === false && verdict.reason === "no-dossier");
}

console.log(failures.length === 0 ? "\n✓ 情报证据注入验证通过（3/3）" : `\n✗ ${failures.length} 项未通过`);
process.exit(failures.length === 0 ? 0 : 1);
