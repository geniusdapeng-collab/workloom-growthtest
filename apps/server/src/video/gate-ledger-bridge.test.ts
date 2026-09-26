import { describe, expect, it } from "vitest";
import { buildServerGateRecord, SERVER_GATE_STEP_KEY, UNMAPPED_PIPELINE_GATES, withGateLedger } from "./gate-ledger-bridge.js";

describe("平台侧门账本桥（apps/server → step_key 记账）", () => {
  it("G1–G7 映射到管线 step_key（营销片前置门已补齐）；未知门返回 null（不猜）", () => {
    // 【T-2026-0926-0117】营销片前置门：vendor 的 dossier/theme/requirement/prd 确认单 = G1–G4
    expect(SERVER_GATE_STEP_KEY.G1_DOSSIER).toBe("g1-dossier-confirm");
    expect(SERVER_GATE_STEP_KEY.G2_THEME).toBe("g2-theme-confirm");
    expect(SERVER_GATE_STEP_KEY.G3_INSIGHT).toBe("g3-insight-confirm");
    expect(SERVER_GATE_STEP_KEY.G4_PRD).toBe("g4-prd-confirm");
    expect(SERVER_GATE_STEP_KEY.G5_PORTRAIT).toBe("g5-portrait-confirm");
    expect(SERVER_GATE_STEP_KEY.G6_PROMPT).toBe("g6-prompt-confirm");
    expect(SERVER_GATE_STEP_KEY.G7_FINAL).toBe("g7-preproduction");
    // 真未知门仍然不猜（返回 null）
    expect(buildServerGateRecord({ gate: "UNKNOWN", vendorType: "mystery", projectId: "VID-1", runId: "run-1", approved: true })).toBeNull();
    /** 素材门（G-MAT1）平台侧没有对应 vendor 门：如实登记为未映射，不猜映射 */
    expect(UNMAPPED_PIPELINE_GATES).toContain("material-generate");
  });

  it("监制打回 → 门事件未通过，理由与分数随裁决落账", () => {
    const record = buildServerGateRecord({
      gate: "G6_PROMPT", vendorType: "prompt-review", projectId: "VID-1", runId: "run-9",
      approved: false,
      verdict: { approved: false, score: 58, via: "llm", degraded: false, reason: "字段与红线项无正文可核验", issues: ["无正文"], model: "deepseek-flash" }
    })!;
    expect(record.stepKey).toBe("g6-prompt-confirm");
    expect(record.event.gate).toBe("G6");
    expect(record.event.ok).toBe(false);
    expect(record.event.score).toBe(58);
    expect(record.event.reason).toContain("无正文可核验");
    expect(record.event.evidence?.runId).toBe("run-9");
    expect(record.event.checks[0]!.detail).toContain("score=58");
  });

  it("无监制裁决（auto/human 模式）也能落账：按处置结果给一条代理判据", () => {
    const record = buildServerGateRecord({ gate: "G7_FINAL", vendorType: "preproduction", projectId: "VID-2", runId: "run-2", approved: true, producerMode: "auto" })!;
    expect(record.event.ok).toBe(true);
    expect(record.event.via).toBe("deterministic");
    expect(record.event.checks[0]!.detail).toContain("producerMode=auto");
    expect(record.event.evidence?.producerMode).toBe("auto");
  });

  it("并账本字段不就地修改原 payload，且未映射门时原样返回", () => {
    const payload = { gate: "G6_PROMPT", approved: true, title: "提示词审核" };
    const record = buildServerGateRecord({ gate: "G6_PROMPT", vendorType: "prompt", projectId: "VID-3", runId: "run-3", approved: true })!;
    const merged = withGateLedger(payload, record);
    expect(payload).toEqual({ gate: "G6_PROMPT", approved: true, title: "提示词审核" });
    expect(merged.stepKey).toBe("g6-prompt-confirm");
    expect(merged.title).toBe("提示词审核");
    expect(merged.gateEvent?.ok).toBe(true);
    expect(withGateLedger(payload, null).stepKey).toBeUndefined();
  });
});
