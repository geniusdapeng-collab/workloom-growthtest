/**
 * 门账本只读审计回归（T-2026-0926-0112）
 *
 * 覆盖四类真实形态：正常全放行 / 打回后复核放行 / 缺门（被绕过）/ 门号错配（脏账本）。
 */
import { describe, expect, it } from "vitest";

import { auditGateLedger, buildGateEvent, type GateEvent } from "./gate-ledger.js";

const ev = (
  stepKey: Parameters<typeof buildGateEvent>[0]["stepKey"],
  approved: boolean,
  at: string,
  gate?: string,
): GateEvent => {
  const event = buildGateEvent({
    stepKey,
    sourceStage: "test",
    checks: [{ id: "c1", pass: approved, detail: "test", hard: true }],
    via: "deterministic",
    reason: approved ? "ok" : "打回",
    projectId: "VID-TEST",
    at,
  });
  return gate ? ({ ...event, gate } as GateEvent) : event;
};

const EXPECTED = ["g5-portrait-confirm", "g6-prompt-confirm", "g7-preproduction"] as const;

describe("门账本审计", () => {
  it("全放行：无缺门、无打回、无错配", () => {
    const audit = auditGateLedger(
      [
        ev("g5-portrait-confirm", true, "2026-09-27T00:00:00.000Z"),
        ev("g6-prompt-confirm", true, "2026-09-27T00:01:00.000Z"),
        ev("g7-preproduction", true, "2026-09-27T00:02:00.000Z"),
      ],
      EXPECTED,
    );
    expect(audit.total).toBe(3);
    expect(audit.missing).toEqual([]);
    expect(audit.rejectedWithoutRecheck).toEqual([]);
    expect(audit.mismatched).toEqual([]);
    expect(audit.summary.map((s) => s.approved)).toEqual([true, true, true]);
  });

  it("打回后复核放行：最终裁决为放行，不算异常", () => {
    const audit = auditGateLedger(
      [
        ev("g6-prompt-confirm", false, "2026-09-27T00:00:00.000Z"),
        ev("g6-prompt-confirm", true, "2026-09-27T00:05:00.000Z"),
      ],
      ["g6-prompt-confirm"],
    );
    expect(audit.counts[0]).toEqual({ stepKey: "g6-prompt-confirm", count: 2 });
    expect(audit.rejectedWithoutRecheck).toEqual([]);
  });

  it("打回后没有复核：标记为 rejectedWithoutRecheck", () => {
    const audit = auditGateLedger([ev("g6-prompt-confirm", false, "2026-09-27T00:00:00.000Z")], ["g6-prompt-confirm"]);
    expect(audit.rejectedWithoutRecheck).toEqual(["g6-prompt-confirm"]);
  });

  it("缺门与被绕过：missing 列出期望但未出现的门", () => {
    const audit = auditGateLedger([ev("g5-portrait-confirm", true, "2026-09-27T00:00:00.000Z")], EXPECTED);
    expect(audit.missing).toEqual(["g6-prompt-confirm", "g7-preproduction"]);
  });

  it("门号错配：脏账本被识别", () => {
    const audit = auditGateLedger([ev("g6-prompt-confirm", true, "2026-09-27T00:00:00.000Z", "G5")], ["g6-prompt-confirm"]);
    expect(audit.mismatched).toEqual([{ stepKey: "g6-prompt-confirm", gate: "G5", expected: "G6" }]);
  });
});
