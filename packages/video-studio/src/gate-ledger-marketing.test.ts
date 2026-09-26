/**
 * 营销片/经营线门账本覆盖回归（T-2026-0926-0117）
 *
 * 背景（读码事实）：`marketing-film.yml` 声明了 g1/g2/g3/g4/g9 五个门、
 * `account-ops`/`ads-creative-factory`/`settlement-recon` 各声明一个门，
 * 但门账本白名单此前只有叙事片 7 个 step_key → 这些门在账本里查不到。
 *
 * 本测试只读管线 yml（正则解析，不引入跨包依赖），锁定：
 *   ① 每个带门 step_key 都在白名单内；② 映射门号与 yml 声明一致；③ 事件能落账与审计。
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  auditGateLedger,
  buildGateEvent,
  gateForStepKey,
  readGateEvents,
  PIPELINE_GATE_STEP_KEYS,
  type PipelineGateStepKey,
} from "./gate-ledger.js";

const PIPELINES_DIR = join(resolve(import.meta.dirname, "../../.."), "bundles/ai-video/pipelines");
const FILES = [
  "marketing-film.yml",
  "narrative-film.yml",
  "account-ops.yml",
  "ads-creative-factory.yml",
  "settlement-recon.yml",
];

/** 极简解析：`- step_key: X` 起一个步骤，随后 4 空格缩进的 `gate: Y` 归该步骤 */
function pipelineGatePairs(): Array<{ pipeline: string; stepKey: string; gate: string }> {
  const out: Array<{ pipeline: string; stepKey: string; gate: string }> = [];
  for (const file of FILES) {
    const text = readFileSync(join(PIPELINES_DIR, file), "utf8");
    const pipeline = file.replace(".yml", "");
    let current: string | null = null;
    for (const raw of text.split("\n")) {
      const stepMatch = /^\s*-\s*step_key:\s*(\S+)/.exec(raw);
      if (stepMatch) {
        current = stepMatch[1]!;
        continue;
      }
      const gateMatch = /^\s{4}gate:\s*(\S+)/.exec(raw);
      if (gateMatch && current) {
        out.push({ pipeline, stepKey: current, gate: gateMatch[1]! });
        current = null;
      }
    }
  }
  return out;
}

describe("门账本 · 营销片与经营线覆盖", () => {
  const pairs = pipelineGatePairs();

  it("管线里每个带门 step_key 都在门账本白名单内", () => {
    const missing = pairs
      .filter((p) => !PIPELINE_GATE_STEP_KEYS.includes(p.stepKey as PipelineGateStepKey))
      .map((p) => `${p.pipeline}:${p.stepKey}`);
    expect(missing, `未登记进白名单：${missing.join(", ")}`).toEqual([]);
  });

  it("step_key 映射门号与 yml 声明一致（G10 允许 a–d 细分）", () => {
    for (const p of pairs) {
      // 叙事片的 g5/g6/g7/g8 是"step_key 即门号"的命名，单独放过
      if (/^g[5-8]-/.test(p.stepKey)) continue;
      const mapped = gateForStepKey(p.stepKey);
      const ok = mapped === p.gate || (p.gate === "G10" && /^G10/.test(mapped));
      expect(ok, `${p.stepKey} 映射为 ${mapped}，yml 声明 ${p.gate}`).toBe(true);
    }
  });

  it("营销片 G1 门事件可落账、可按 step_key 检索并审计", () => {
    const event = buildGateEvent({
      stepKey: "g1-dossier-confirm",
      projectId: "VID-MKT-1",
      checks: [{ id: "evidence", pass: true, detail: "情报档案证据齐全", hard: true }],
      sourceStage: "dataMining",
      via: "llm",
      reason: "监制放行",
      at: "2026-09-27T01:00:00.000Z",
    });
    const read = readGateEvents([event as unknown as Record<string, unknown>]);
    expect(read.length).toBe(1);
    const audit = auditGateLedger(read, ["g1-dossier-confirm", "g2-theme-confirm"]);
    expect(audit.summary[0]).toMatchObject({ stepKey: "g1-dossier-confirm", gate: "G1", approved: true });
    expect(audit.missing).toEqual(["g2-theme-confirm"]);
    expect(audit.mismatched).toEqual([]);
  });

  it("经营线门按总号记账（G10/G12/G13）", () => {
    expect(gateForStepKey("g10-dispatch")).toBe("G10");
    expect(gateForStepKey("g12-boost-confirm")).toBe("G12");
    expect(gateForStepKey("g13-diff-alert")).toBe("G13");
  });
});
