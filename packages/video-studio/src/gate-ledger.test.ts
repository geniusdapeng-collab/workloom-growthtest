import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendGateEvent, buildGateEvent, gateForStepKey, readGateEvents, summarizeGates } from "./gate-ledger.js";

describe("门账本（G5/G6/G7/G8 的 step_key 运行时记账）", () => {
  it("空判据、重复标识、无效类型或评分均不授予通过", () => {
    const check = { id: "exists", pass: true, hard: true, detail: "实测" };
    const base = { stepKey: "g8-render-submit" as const, projectId: "VID-1", checks: [check] };
    for (const patch of [{ checks: [] }, { checks: [check, check] }, { projectId: " " },
      { checks: [{ ...check, pass: "true" }] }, { checks: [{ ...check, hard: "true" }] },
      { score: NaN }, { score: Infinity }, { score: -1 }, { score: 101 }, { softApproved: "yes" }]) {
      const event = buildGateEvent({ ...base, ...patch } as Parameters<typeof buildGateEvent>[0]);
      expect(event.ok).toBe(false); expect(event.approved).toBe(false); expect(event.reason).toContain("证据无效");
    }
  });
  it("降级与 fallback 即使上游同意也不能当作合格门", () => {
    const base = { stepKey: "g8-render-submit" as const, projectId: "VID-1", checks: [{ id: "exists", pass: true, detail: "实测", hard: true }], softApproved: true };
    expect(buildGateEvent({ ...base, degraded: true }).approved).toBe(false);
    expect(buildGateEvent({ ...base, via: "fallback" }).approved).toBe(false);
    expect(buildGateEvent(base).approved).toBe(true);
  });
  it("step_key ↔ 门编号映射固定，未知 key 直接抛错（不许写野 key）", () => {
    expect(gateForStepKey("g5-portrait-confirm")).toBe("G5");
    expect(gateForStepKey("g6-prompt-confirm")).toBe("G6");
    expect(gateForStepKey("g7-preproduction")).toBe("G7");
    expect(gateForStepKey("g8-render-submit")).toBe("G8");
    expect(gateForStepKey("material-generate")).toBe("G-MAT1");
    expect(() => gateForStepKey("g9-whatever")).toThrow(/未知的门 step_key/);
  });

  it("硬闸失败 → 门不通过，且理由里点名是哪几条", () => {
    const event = buildGateEvent({
      stepKey: "g8-render-submit", projectId: "VID-1",
      checks: [
        { id: "prompt-length", pass: true, hard: true, detail: "2296 字" },
        { id: "no-hard-params", pass: false, hard: true, detail: "正文出现 f 值" }
      ]
    });
    expect(event.ok).toBe(false);
    expect(event.gate).toBe("G8");
    expect(event.reason).toContain("no-hard-params");
  });

  it("上游软裁决未通过 → 门不通过（即使硬闸全过）", () => {
    const event = buildGateEvent({
      stepKey: "g6-prompt-confirm", projectId: "VID-1",
      checks: [{ id: "delivery", pass: true, hard: true, detail: "交付闸通过" }],
      softApproved: false, via: "llm", score: 42, reason: "节拍过密"
    });
    expect(event.ok).toBe(false);
    expect(event.via).toBe("llm");
    expect(event.score).toBe(42);
  });

  it("写入 stages.jsonl 后可按门检索，并取每次调用的最新裁决", () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-ledger-"));
    const log = join(dir, "stages.jsonl");
    try {
      appendGateEvent(log, buildGateEvent({
        stepKey: "g7-preproduction", projectId: "VID-1",
        checks: [{ id: "plate-files", pass: false, hard: true, detail: "SC-02 关键帧缺失" }]
      }));
      appendGateEvent(log, buildGateEvent({
        stepKey: "g7-preproduction", projectId: "VID-1",
        checks: [{ id: "plate-files", pass: true, hard: true, detail: "6 镜齐备" }]
      }));
      // 掺入普通阶段记录，确认不会被误读成门事件
      const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      lines.push({ at: new Date().toISOString(), stage: "shot", ok: true, verdict: null });
      const gates = readGateEvents(lines);
      expect(gates).toHaveLength(2);
      const summary = summarizeGates(gates);
      expect(summary).toHaveLength(1);
      expect(summary[0]!.stepKey).toBe("g7-preproduction");
      expect(summary[0]!.approved).toBe(true);
      expect(summary[0]!.reason).toContain("门通过");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
