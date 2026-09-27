import { describe, expect, it } from "vitest";
import { decidePlateCache, plateRequestSha256, PLATE_CACHE_MIN_BYTES, type PlateCacheInput } from "./plate-cache.js";

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

describe("完整生图请求与产物指纹", () => {
  const request = { prompt: "右窗自然光的关键帧", model: "image-model", anchorMode: "none", size: "2K", referenceSha256: [SHA] };

  it("源生图请求一致可复用，监制重试实际提示词单独留痕", () => {
    const hash = plateRequestSha256(request);
    const meta = { ...input().meta!, requestSha256: hash, artifactSha256: SHA, submittedPromptSha256: "b".repeat(64) };
    expect(decidePlateCache(input({ meta, currentRequestSha256: hash, currentArtifactSha256: SHA })).valid).toBe(true);
  });

  it.each([
    { prompt: "左窗自然光的关键帧" }, { model: "other-model" }, { size: "4K" },
    { anchorMode: "real" }, { referenceSha256: ["b".repeat(64)] },
    { referenceSha256: [SHA, "b".repeat(64)] }
  ])("请求变化必须失效：%j", (change) => {
    const meta = { ...input().meta!, requestSha256: plateRequestSha256(request), artifactSha256: SHA };
    expect(decidePlateCache(input({ meta, currentRequestSha256: plateRequestSha256({ ...request, ...change }), currentArtifactSha256: SHA })).valid).toBe(false);
  });

  it("拒绝缺少完整指纹的历史产物及字节被替换的产物", () => {
    expect(decidePlateCache(input({ currentRequestSha256: plateRequestSha256(request) })).valid).toBe(false);
    const meta = { ...input().meta!, requestSha256: plateRequestSha256(request), artifactSha256: SHA };
    expect(decidePlateCache(input({ meta, currentArtifactSha256: "b".repeat(64) })).valid).toBe(false);
    expect(decidePlateCache(input({ meta, currentArtifactSha256: null })).valid).toBe(false);
  });
});
