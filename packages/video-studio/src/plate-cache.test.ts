import { describe, expect, it } from "vitest";
import { decidePlateCache, PLATE_CACHE_MIN_BYTES, type PlateCacheInput } from "./plate-cache.js";

const SHA = "a".repeat(64);

function input(overrides: Partial<PlateCacheInput> = {}): PlateCacheInput {
  return {
    exists: true,
    sizeBytes: 180_000,
    meta: { promptSha256: SHA, anchorMode: "none", model: "doubao-seedream-5-0-pro-260628", at: "2026-09-26T15:00:00Z" },
    currentPromptSha256: SHA,
    anchorMode: "none",
    lastApproved: true,
    ...overrides
  };
}

describe("decidePlateCache（关键帧缓存失效判据）", () => {
  it("四道判据全过 → 命中", () => {
    const decision = decidePlateCache(input());
    expect(decision.valid).toBe(true);
    expect(decision.reason).toContain("命中");
  });

  it("文件不存在 → 失效", () => {
    expect(decidePlateCache(input({ exists: false })).valid).toBe(false);
  });

  it("文件小于阈值 → 失效", () => {
    const decision = decidePlateCache(input({ sizeBytes: PLATE_CACHE_MIN_BYTES - 1 }));
    expect(decision.valid).toBe(false);
    expect(decision.reason).toContain("过小");
  });

  it("缺指纹元文件（历史产物）→ 失效（真机：改卡片后旧图不得复用）", () => {
    const decision = decidePlateCache(input({ meta: null }));
    expect(decision.valid).toBe(false);
    expect(decision.reason).toContain("缺指纹元文件");
  });

  it("提示词变更（如服装改回档案 w1）→ 失效", () => {
    const decision = decidePlateCache(input({ meta: { promptSha256: "b".repeat(64), anchorMode: "none" } }));
    expect(decision.valid).toBe(false);
    expect(decision.reason).toBe("提示词已变更");
  });

  it("锚点模式变更（none → real）→ 失效", () => {
    const decision = decidePlateCache(input({ anchorMode: "real" }));
    expect(decision.valid).toBe(false);
    expect(decision.reason).toContain("锚点模式已变更");
  });

  it("上次裁决未放行 → 失效（被驳回的图不得被复用洗白）", () => {
    const decision = decidePlateCache(input({ lastApproved: false }));
    expect(decision.valid).toBe(false);
    expect(decision.reason).toBe("上次裁决未放行");
  });

  it("当前提示词缺失 → 失效（不拿没有指纹依据的产物冒险）", () => {
    const decision = decidePlateCache(input({ currentPromptSha256: null }));
    expect(decision.valid).toBe(false);
    expect(decision.reason).toContain("提示词缺失");
  });
});
