import { describe, expect, it } from "vitest";
import { auditDeliverableNaming, buildDeliveryManifest, type DistinctnessReport } from "./deliver.js";

const distinct: DistinctnessReport = { pairs: [], worstPair: null, approved: true, detail: "ok" };

describe("auditDeliverableNaming（文件名/时长口径）", () => {
  it("真机事故形态：文件名写 30s、成片 51.07s → 判不合格并给改名建议", () => {
    const audit = auditDeliverableNaming({ path: "/out/VID-NC-WT01-30s-final.mp4", durationSec: 51.07 });
    expect(audit.ok).toBe(false);
    expect(audit.claimedDurationSec).toBe(30);
    expect(audit.actualDurationSec).toBe(51.07);
    expect(audit.suggestedName).toBe("VID-NC-WT01-51s-final.mp4");
    expect(audit.detail).toMatch(/不符/);
  });

  it("文件名与成片一致（±1s 容差内）→ 放行", () => {
    expect(auditDeliverableNaming({ path: "/out/VID-48s-final.mp4", durationSec: 48.0 }).ok).toBe(true);
    expect(auditDeliverableNaming({ path: "/out/VID-48s-final.mp4", durationSec: 48.6 }).ok).toBe(true);
    expect(auditDeliverableNaming({ path: "/out/VID-30秒-final.mp4", durationSec: 30.2 }).ok).toBe(true);
  });

  it("文件名没写时长 → 放行但提示建议（不判死）", () => {
    const audit = auditDeliverableNaming({ path: "/out/VID-NC-WT01-final.mp4", durationSec: 48 });
    expect(audit.ok).toBe(true);
    expect(audit.claimedDurationSec).toBeNull();
    expect(audit.detail).toMatch(/未写时长/);
  });

  it("时长未知 → 判不合格（不许在口径不明时签字）", () => {
    const audit = auditDeliverableNaming({ path: "/out/VID-48s-final.mp4", durationSec: 0 });
    expect(audit.ok).toBe(false);
    expect(audit.detail).toMatch(/时长未知/);
  });
});

describe("delivery manifest 口径", () => {
  it("清单带成片时长与命名审计（发布方不必再猜路径对应哪支片）", () => {
    const audit = auditDeliverableNaming({ path: "/out/VID-NC-WT01-48s-final.mp4", durationSec: 48.0 });
    const manifest = buildDeliveryManifest({
      projectId: "VID-NC-WT01",
      platform: "小红书",
      deliverable: {
        path: "/out/VID-NC-WT01-48s-final.mp4", sha256: "abc", bytes: 123,
        durationSec: 48.0, namingAudit: audit,
      },
      subtitles: { sidecarDir: null, softsub: null, burned: true },
      cover: { path: null, hook: "南昌 48 秒" },
      variants: [],
      distinctness: distinct,
      samples: [],
      at: "2026-09-27T00:00:00.000Z",
    });
    expect(manifest.deliverable.durationSec).toBe(48);
    expect(manifest.deliverable.namingAudit?.ok).toBe(true);
    expect(manifest.deliverable.path.endsWith("-48s-final.mp4")).toBe(true);
  });
});
