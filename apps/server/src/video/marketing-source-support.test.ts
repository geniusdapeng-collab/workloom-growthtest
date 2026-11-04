import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProducerVerdict } from "@hyperreality/video-studio";
import type { SourceSnapshot } from "./marketing-source-fetcher.js";
import { extractAndReviewMarketingSources, MARKETING_SOURCE_POLICY_VERSION } from "./marketing-source-support.js";
import { canonicalRenderJson, renderSha256 } from "./gen/compiled-request.js";

const sourceText = "星野 R 型风扇有9档风量。媒体首段称售价1200元，末段又称同一版本售价1300元。媒体宣传称全行业第一。完整尾部证据。";
const alternateText = "星野 A 型风扇支持100档，价格99元。这是其他型号，不能拼入R型。";
const snapshot = (sourceId: string, text: string): SourceSnapshot => ({ sourceId,
  requestedUrl: `https://source.example.com/${sourceId}`, finalUrl: `https://source.example.com/${sourceId}`,
  redirectChain: [], fetchedAt: "2026-11-04T14:00:00.000Z", contentType: "text/plain", bytes: Buffer.byteLength(text), text,
  textSha256: renderSha256(text), rawSha256: renderSha256(text), assetUrls: [] });
const sources = [snapshot("SRC-R", sourceText), snapshot("SRC-A", alternateText)];
const cite = (pointer: string, quote: string) => ({ pointer, sourceId: "SRC-R", quote });
function extraction(conflicted = false) {
  const prices = conflicted ? [{ amount: 1200, currency: "CNY", source_url: sources[0]!.finalUrl }] : [];
  const points = conflicted ? [{ point: "全行业第一", source_url: sources[0]!.finalUrl }] : [];
  return { payload: { identity: { name: "星野 R", model: "R", specs: { 风量: "9档" }, prices, official_selling_points: points }, images: [] },
    citations: [cite("/identity/name", "星野 R"), cite("/identity/model", "R 型"), cite("/identity/specs/风量", "9档风量"),
      ...(conflicted ? [cite("/identity/prices/0/amount", "售价1200元"), cite("/identity/prices/0/currency", "售价1200元"),
        cite("/identity/official_selling_points/0/point", "全行业第一")] : [])] };
}

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "marketing-support-repair-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function run(options: {
  drafts?: unknown[];
  failVerdictArchive?: boolean;
  verdict?: (index: number, accepted: ProducerVerdict, artifact: { path: string; sha256: string }) => ProducerVerdict | Promise<ProducerVerdict>;
} = {}) {
  const prompts: string[] = [], reviews: Array<{ body: any; options: Parameters<NonNullable<Parameters<typeof extractAndReviewMarketingSources>[0]["review"]>>[0] }> = [];
  const author = vi.fn(async (prompt: string) => {
    prompts.push(prompt);
    return { success: true as const, data: structuredClone((options.drafts ?? [extraction(true), extraction(false)])[prompts.length - 1]) };
  });
  const promise = extractAndReviewMarketingSources({
    scope: { tenantId: "tenant-a", workspaceId: "ws-a", projectId: "P1", runId: "RUN1", attempt: 1 },
    stage: "A1", productQuery: { name: "星野 R", model: "R", category: "风扇" }, plan: {}, sources, env: {}, llm: { reason: author },
    writeArtifact: async (suffix, bytes) => {
      if (options.failVerdictArchive && suffix.endsWith(".verdict.json")) throw new Error("verdict disk full");
      const ref = `A1${suffix}`, file = path.join(root, ref);
      await writeFile(file, bytes, { flag: "wx" });
      return { ref, path: file, sha256: renderSha256(bytes) };
    },
    verifyArtifact: async artifact => {
      if (renderSha256(await readFile(artifact.path)) !== artifact.sha256) throw new Error("changed evidence");
    },
    review: async input => {
      const artifact = input.artifacts[0]!, bytes = await readFile(artifact.path), body = JSON.parse(bytes.toString());
      const bound = { path: artifact.path, sha256: renderSha256(bytes) };
      reviews.push({ body, options: input });
      const rejected = body.facts.payload.identity.prices.length > 0;
      const verdict: ProducerVerdict = { stage: "script", status: rejected ? "failed" : "passed", approved: !rejected,
        score: rejected ? 40 : 94, via: "llm", model: "deepseek-flash", degraded: false, hardFailures: [],
        issues: rejected ? ["/identity/prices/0: 同一型号同一版本价格冲突", "/identity/official_selling_points/0: 未支持绝对化主张"] : [],
        suggestions: rejected ? ["删除不能解决的可选价格与绝对化卖点，保留R型真实9档规格，不得借A型参数"] : [],
        reason: rejected ? "1200与1300冲突；全行业第一没有依据" : "保留的R型规格有完整来源支持，其他型号与争议价格没有被采纳",
        rerun: rejected, ms: 1, evidence: [{ ...bound, scope: "complete-text" }] };
      return options.verdict ? options.verdict(reviews.length - 1, verdict, bound) : verdict;
    },
  });
  return { promise, author, prompts, reviews };
}

describe("来源语义拒绝后的定点修复", () => {
  it("保留完整来源及原拒绝，纠正可选坏事实后重新独立审核，不重搜或自动选择争议价格", async () => {
    const state = await run();
    const result = await state.promise;
    expect(state.author).toHaveBeenCalledTimes(2);
    expect(state.reviews).toHaveLength(2);
    expect(state.reviews.map(review => review.options.minScore)).toEqual([85, 85]);
    expect(state.reviews.every(review => canonicalRenderJson(review.body.sources) === canonicalRenderJson(sources))).toBe(true);
    expect(state.prompts[1]).toContain(sourceText);
    expect(state.prompts[1]).toContain(alternateText);
    expect(state.prompts[1]).toContain("1200与1300冲突");
    expect(state.prompts[1]).toContain("删数组项时同步重排所有citations指针");
    expect(result.facts.payload.identity).toMatchObject({ name: "星野 R", model: "R", specs: { 风量: "9档" }, prices: [], official_selling_points: [] });
    expect(result.supportAttempts).toHaveLength(2);
    expect(result.review.ref).toBe("A1.repair-1.review.json");
    expect(JSON.parse(await readFile(path.join(root, "A1.review.json"), "utf8")).facts.payload.identity.prices[0].amount).toBe(1200);
    expect(JSON.parse(await readFile(path.join(root, "A1.verdict.json"), "utf8"))).toMatchObject({ approved: false, score: 40 });
    expect(JSON.parse(await readFile(path.join(root, "A1.repair-1.verdict.json"), "utf8"))).toMatchObject({ approved: true, score: 94 });
    expect(JSON.parse(await readFile(path.join(root, "A1.repair-1.input.json"), "utf8")).policyVersion).toBe(MARKETING_SOURCE_POLICY_VERSION);
  });

  it("初次事实已获支持时不额外修复", async () => {
    const state = await run({ drafts: [extraction(false)] });
    expect((await state.promise).supportAttempts).toHaveLength(1);
    expect(state.author).toHaveBeenCalledOnce();
    expect(state.reviews).toHaveLength(1);
  });

  it.each(["unverified", "fallback", "unknown", "bad-binding", "false-pass", "low-pass"])("%s不是可触发内容重写的完整语义拒绝", async kind => {
    const state = await run({ verdict: (_index, verdict) => ({ ...verdict,
      ...(kind === "unverified" ? { status: "unverified" as const } : {}),
      ...(kind === "fallback" ? { via: "fallback" as const, degraded: true } : {}),
      ...(kind === "unknown" ? { unknownOutcome: true as const } : {}),
      ...(kind === "bad-binding" ? { evidence: [{ path: "/not/current", sha256: "0".repeat(64), scope: "complete-text" }] } : {}),
      ...(kind === "false-pass" || kind === "low-pass" ? { status: "passed" as const, approved: true, score: kind === "low-pass" ? 84 : 94,
        ...(kind === "false-pass" ? { evidence: [] } : {}) } : {}),
    }) });
    await expect(state.promise).rejects.toThrow(kind === "unknown" ? "VIDEO_MODEL_OUTCOME_UNKNOWN" : "MARKETING_SUPPORT_REJECTED");
    expect(state.author).toHaveBeenCalledOnce();
    expect(state.reviews).toHaveLength(1);
  });

  it("作者原样交回拒绝事实时停止，不以反复询问监制赌通过", async () => {
    const state = await run({ drafts: [extraction(true), extraction(true)] });
    await expect(state.promise).rejects.toThrow("定点修复未改变被拒绝的事实");
    expect(state.author).toHaveBeenCalledTimes(2);
    expect(state.reviews).toHaveLength(1);
  });

  it("供应商结果未知且回执归档又失败时，未知状态和原写盘错误仍保留，不进入修复", async () => {
    const state = await run({ failVerdictArchive: true, verdict: (_index, verdict) => ({ ...verdict, unknownOutcome: true }) });
    await expect(state.promise).rejects.toMatchObject({ code: "VIDEO_MODEL_OUTCOME_UNKNOWN", cause: { message: "verdict disk full" } });
    expect(state.author).toHaveBeenCalledOnce();
    expect(state.reviews).toHaveLength(1);
    expect(await readFile(path.join(root, "A1.review.json"), "utf8")).toContain(sourceText);
  });

  it("修复后缺引文仍被确定性合同拒绝，不送出下一次审核", async () => {
    const bad = extraction(false); bad.citations.pop();
    const state = await run({ drafts: [extraction(true), bad] });
    await expect(state.promise).rejects.toThrow("MARKETING_CLAIM_UNSOURCED");
    expect(state.reviews).toHaveLength(1);
  });

  it("修复后仍被完整来源审核拒绝时保留新旧两版并结束，不循环付费", async () => {
    const state = await run({ verdict: (_index, verdict) => ({ ...verdict, status: "failed", approved: false, score: 40 }) });
    await expect(state.promise).rejects.toThrow("MARKETING_SUPPORT_REJECTED");
    expect(state.author).toHaveBeenCalledTimes(2);
    expect(state.reviews).toHaveLength(2);
    expect(JSON.parse(await readFile(path.join(root, "A1.repair-1.verdict.json"), "utf8")).approved).toBe(false);
  });

  it("原证据在审核期间被改时停止，不调用作者修复掩盖漂移", async () => {
    const state = await run({ verdict: async (_index, verdict, artifact) => {
      await writeFile(artifact.path, "changed");
      return verdict;
    } });
    await expect(state.promise).rejects.toThrow("changed evidence");
    expect(state.author).toHaveBeenCalledOnce();
  });
});
