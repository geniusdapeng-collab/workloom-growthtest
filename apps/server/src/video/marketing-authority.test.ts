/** 实际来源HTTP、A1–A5 vendor装订、reviewStage及文件摘要；只有模型回答是HTTP协议替身。 */
import { createServer, type Server } from "node:http";
import { mkdtemp, realpath, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { checkpointMarketingFacts, prepareMarketingFacts, restoreMarketingFacts, finalizeMarketingFacts, verifyMarketingFacts,
  marketingFactReviewCacheKey, verifyRejectedMarketingFactReview, type PreparedMarketingFacts, type MarketingShotFactReview } from "./marketing-authority.js";
import { primeSearchCache } from "./data-mining-executor.js";
import { fetchMarketingSource, requestSource } from "./marketing-source-fetcher.js";
import { canonicalRenderJson, renderSha256 } from "./gen/compiled-request.js";
import { reviewStage } from "@hyperreality/video-studio";
const scope = { tenantId: "tenant-a", workspaceId: "ws-a", projectId: "P1", runId: "RUN1", attempt: 1 };
const env = { LLM_BASE_URL: "https://api.deepseek.com", LLM_API_KEY: "test-only", LLM_MODEL: "deepseek-flash" };
const sourceUrl = "https://source.example.com/f3";
const sourceText = "星野 F3 是一款风扇，风量 9 档。尾部注意：9 档是风量档位，不是能耗等级；不得声称静音或市场第一。";
const currencyText = `${sourceText} 海外规格价格99美元；海外另一规格109美元；国内规格699元；国内另一规格799元；免费试用规格0美元。`;
const longSourceText = `${sourceText} ${"公开来源正文".repeat(3_800)}正文末尾证据`;
const longSourceHtml = `<article>${longSourceText}</article>` + Array.from({ length: 50 }, (_, index) =>
  `<img src="https://source.example.com/product/${"detail-".repeat(25)}${index}.jpg">`).join("");
const longMetadata = "授权创作背景".repeat(18_000) + "需求末尾证据";
let server: Server, origin: string, root: string, modelCalls: any[], rejectJudge: boolean, extractionCalls: string[];
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/redirect-a" || req.url === "/redirect-b") {
      res.writeHead(302, { location: "/f3" }); res.end(); return;
    }
    if (req.url === "/large") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(longSourceHtml); return;
    }
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }); res.end(req.url === "/currencies" ? currencyText : sourceText);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "marketing-authority-"))); modelCalls = []; extractionCalls = []; rejectJudge = false;
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    modelCalls.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({
      id: "marketing-authority-judge",
      model: "deepseek-flash",
      choices: [{
        finish_reason: "stop",
        message: { content: JSON.stringify({
          approved: !rejectJudge,
          score: rejectJudge ? 10 : 96,
          issues: rejectJudge ? ["来源不支持此主张"] : [],
          suggestions: [],
          reason: rejectJudge ? "原文限定相冲突" : "逐项原文支持",
        }) },
      }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 30,
        total_tokens: 130,
        completion_tokens_details: { reasoning_tokens: 10 },
      },
    }));
  }));
});
afterEach(async () => { vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });
async function prepare(options: {
  noSearch?: boolean;
  noAux?: boolean;
  badQuote?: boolean;
  modelFailure?: boolean;
  mode?: string;
  attempt?: number;
  stageId?: "preproduction" | "prompt_review";
  intent?: string;
  searchCacheFile?: string;
  redirectAliases?: boolean;
  mixedCurrencies?: boolean;
  zeroPrice?: boolean;
  fragmentAliases?: boolean;
  largeSources?: boolean;
  largeGate?: boolean;
  queryHints?: { brand?: string; category?: string; model?: string };
  structuralDefect?: "note" | "multiple-specs";
} = {}): Promise<PreparedMarketingFacts> {
  let searches = 0;
  return prepareMarketingFacts({ scope: { ...scope, attempt: options.attempt ?? 1 }, stageId: options.stageId, root,
    intent: options.intent ?? "做一条风扇介绍", metadata: { brief: { product: "星野 F3", brand: "星野" }, ...(options.queryHints ? { dataMining: { name: "星野 F3", ...options.queryHints } } : {}), ...(options.largeGate ? { notes: longMetadata } : {}) }, env: { ...env, ...(options.mode ? { VM_DATA_MINING_MODE: options.mode } : {}) },
    llm: { reason: async prompt => {
      extractionCalls.push(prompt); if (options.modelFailure) return { success: false, error: "LLM unavailable" };
      const match = /当前阶段：(A[123])\n(.*)$/s.exec(prompt)!; const extractionInput = JSON.parse(match[2]!); const source = extractionInput.sources[0];
      if (match[1] !== "A1") return { success: true, data: { payload: match[1] === "A2" ? { reviews: [] } : { competitors: [] }, citations: [], noEvidenceReason: "页面仅商品规格，无可核实评价或竞品" } };
      const prices = options.structuralDefect === "note" ? [
        { amount: 99, currency: "USD", source_url: sourceUrl, ...(!extractionInput.invalidExtraction ? { note: "官方定价" } : {}) },
      ] : options.zeroPrice ? [
        { amount: 0, currency: "USD", source_url: sourceUrl }, { amount: 699, currency: "CNY", source_url: sourceUrl },
      ] : options.mixedCurrencies ? [
        { amount: 99, currency: "USD", source_url: sourceUrl }, { amount: 109, currency: "USD", source_url: sourceUrl },
        { amount: 699, currency: "CNY", source_url: sourceUrl }, { amount: 799, currency: "CNY", source_url: sourceUrl },
      ] : undefined;
      const missingSpecs = options.structuralDefect === "multiple-specs" && !extractionInput.invalidExtraction;
      return { success: true, data: { payload: { identity: { name: "星野 F3", specs: missingSpecs ? { "z-last": "9 档", "a-first": "9 档" } : { 风量: "9 档" }, official_selling_points: [{ point: "风量 9 档", source_url: sourceUrl }], ...(prices ? { prices } : {}) }, images: [] }, citations: [
        ...["/identity/name", ...(!missingSpecs ? ["/identity/specs/风量"] : []), "/identity/official_selling_points/0/point"].map(pointer => ({ pointer, sourceId: source.sourceId, quote: options.badQuote ? "不存在的事实" : sourceText })),
        ...(prices ?? []).flatMap((price, index) => ["amount", "currency"].map(field => ({ pointer: `/identity/prices/${index}/${field}`, sourceId: source.sourceId, quote: `${price.amount}${price.currency === "USD" ? "美元" : "元"}` }))),
      ] } };
    } }, dependencies: {
      ...(options.searchCacheFile
        ? { searchCacheFile: options.searchCacheFile }
        : {
            search: async () => {
              searches++;
              if (options.noSearch || options.noAux && searches > 20) return [];
              if (options.largeSources) return [sourceUrl, `${sourceUrl}-second`, `${sourceUrl}-third`].map(url =>
                ({ title: "星野规格", url, snippet: "候选摘要" }));
              return [{ title: "星野规格", url: options.fragmentAliases
                ? `${sourceUrl}#${searches <= 8 ? "specs" : "reviews"}`
                : options.redirectAliases
                ? `https://source.example.com/${searches <= 8 ? "redirect-a" : "redirect-b"}`
                : sourceUrl, snippet: "故意错误摘要999档，不能当事实" }];
            },
          }),
      fetchSource: async url => {
        if (options.fragmentAliases) await new Promise(resolve => setTimeout(resolve, 5));
        const fixturePath = options.largeSources ? "/large" : options.mixedCurrencies || options.structuralDefect === "note" ? "/currencies" : undefined;
        return fetchMarketingSource(url, { resolver: async () => [{ address: "93.184.216.34", family: 4 }], transport: async (requested, _address, signal) =>
          requestSource(new URL(fixturePath ?? requested.pathname, origin), { address: "127.0.0.1", family: 4 }, signal) });
      },
    } });
}
const shots = [{ shotId: "S1", prompt: "窗边展示星野 F3 风扇，字幕说明风量 9 档。", fields: { 场景: "窗边", 产品: "星野 F3", 规格: "9 档" } }];
describe("营销事实宿主完整执行", () => {
  it.each(["note", "multiple-specs"] as const)("%s结构失败的原raw/实际诊断/修复请求及选定有效raw完整复读", async structuralDefect => {
    const prepared = await prepare({ structuralDefect });
    const stage = prepared.bundle.stages[0]!, attempt = stage.supportAttempts![0]!, history = attempt.structureRepair!;
    expect(history).toBeDefined();
    expect(attempt.extraction.ref).toBe(`${prepared.prefix}-A1.structure-1.extraction.json`);
    const diagnostic = JSON.parse(await readFile(path.join(root, history.validation.ref), "utf8"));
    expect(diagnostic.error.message).toContain(structuralDefect === "note" ? "/identity/prices/0/note" : "/identity/specs/a-first,/identity/specs/z-last");
    expect(extractionCalls.filter(prompt => /当前阶段：A1\n/u.test(prompt))).toHaveLength(2);
    expect(modelCalls).toHaveLength(3);
    const saved = await finalizeMarketingFacts(prepared, shots, env);
    const checked = await verifyMarketingFacts({ root, ...saved, scope, shots });
    expect(checked.stages[0]!.supportAttempts![0]!.structureRepair).toEqual(history);
    const original = JSON.parse(await readFile(path.join(root, history.rejectedExtraction.ref), "utf8"));
    if (structuralDefect === "note") expect(original.payload.identity.prices[0].note).toBe("官方定价");
    else expect(original.payload.identity.specs).toEqual({ "a-first": "9 档", "z-last": "9 档" });
  });

  it.each(["raw", "diagnosis", "request-source", "selected-raw"])("结构修复history的%s同步改摘要也不能冒充原始成功链", async kind => {
    const prepared = await prepare({ structuralDefect: "multiple-specs" });
    const saved = await finalizeMarketingFacts(prepared, shots, env);
    const bundle = JSON.parse(await readFile(path.join(root, saved.ref), "utf8")) as PreparedMarketingFacts["bundle"];
    const attempt = bundle.stages[0]!.supportAttempts![0]!, history = attempt.structureRepair!;
    const pointer = kind === "raw" ? history.rejectedExtraction : kind === "diagnosis" ? history.validation
      : kind === "request-source" ? history.request : attempt.extraction;
    const value = JSON.parse(await readFile(path.join(root, pointer.ref), "utf8"));
    if (kind === "raw") value.citations.push({ pointer: "/identity/specs/a-first", sourceId: bundle.sources[0]!.sourceId, quote: sourceText });
    if (kind === "diagnosis") value.error.message = "自行声明没有错误";
    if (kind === "request-source") value.input.sources[0].text = "替换过的正文";
    if (kind === "selected-raw") value.payload.identity.specs.风量 = "999 档";
    const changed = canonicalRenderJson(value); await writeFile(path.join(root, pointer.ref), changed); pointer.sha256 = renderSha256(changed);
    const text = canonicalRenderJson(bundle); await writeFile(path.join(root, saved.ref), text);
    await expect(verifyMarketingFacts({ root, ref: saved.ref, sha256: renderSha256(text), scope, shots })).rejects.toThrow();
  });

  it("晚期真实事实拒绝会保存负回执，相同坏镜恢复时0次重新判审，改稿后仅审改变镜头", async () => {
    const original = await checkpointMarketingFacts(await prepare());
    const passed = new Map<string, MarketingShotFactReview>(), rejected = new Map<string, MarketingShotFactReview>();
    let rejectFollowing = true;
    const reject = vi.fn(async (key: string, review: MarketingShotFactReview) => { rejected.set(key, structuredClone(review)); });
    const cache = { load: async (key: string) => passed.get(key) ?? null,
      save: async (key: string, review: MarketingShotFactReview) => {
        passed.set(key, structuredClone(review));
        if (rejectFollowing && review.shotId === "S1") rejectJudge = true;
      }, loadRejected: async (key: string) => rejected.get(key) ?? null, reject };
    const bad = { ...shots[0]!, shotId: "S2", prompt: "镜头二虚构999档商品规格。" };
    const input = [...shots, bad];
    const sourceCalls = modelCalls.length;
    await expect(finalizeMarketingFacts(original, input, env, cache)).rejects.toThrow("MARKETING_PROMPT_FACTS_REJECTED");
    expect(modelCalls.length - sourceCalls).toBe(2);
    expect(passed.size).toBe(1); expect(rejected.size).toBe(1);
    const negative = [...rejected.values()][0]!;
    expect(negative.rejectedShot).toEqual(bad);
    expect(negative.verdictArchive).toMatchObject({ ref: `${original.prefix}-shot-2.verdict.json` });
    await expect(verifyRejectedMarketingFactReview(original, bad, negative)).resolves.toBeUndefined();
    rejectFollowing = false; rejectJudge = false;
    const next = await restoreMarketingFacts(original, { root, scope: { ...scope, runId: "RUN2", attempt: 2 }, intent: "做一条风扇介绍", stageId: "preproduction" });
    expect(marketingFactReviewCacheKey(next.bundle, bad)).toBe(marketingFactReviewCacheKey(original.bundle, bad));
    const before = modelCalls.length;
    await expect(finalizeMarketingFacts(next, input, env, cache)).rejects.toThrow("已有完整事实拒绝");
    expect(modelCalls).toHaveLength(before);
    expect(reject).toHaveBeenCalledTimes(2);
    const corrected = { ...bad, prompt: "镜头二展示有来源的风量9档。" };
    expect(marketingFactReviewCacheKey(next.bundle, corrected)).not.toBe(marketingFactReviewCacheKey(next.bundle, bad));
    const third = await restoreMarketingFacts(original, { root, scope: { ...scope, runId: "RUN3", attempt: 3 }, intent: "做一条风扇介绍", stageId: "preproduction" });
    const saved = await finalizeMarketingFacts(third, [...shots, corrected], env, cache);
    expect(modelCalls.length - before).toBe(1);
    const checked = await verifyMarketingFacts({ root, ...saved, scope: third.bundle.scope, shots: [...shots, corrected] });
    expect(checked.outputReviews.map(review => review.scope?.runId)).toEqual([scope.runId, "RUN3"]);
  });

  it.each(["prompt", "fields", "source", "scope", "unknown", "fallback", "passed", "missing-shot", "missing-verdict", "verdict-inline", "verdict-file"])("负回执%s变化或伪状态不能阻断别的内容或当作真实语义拒绝", async kind => {
    const prepared = await checkpointMarketingFacts(await prepare());
    const rejected = new Map<string, MarketingShotFactReview>();
    rejectJudge = true;
    await expect(finalizeMarketingFacts(prepared, shots, env, { load: async () => null, save: async () => {},
      reject: async (key, review) => { rejected.set(key, structuredClone(review)); } })).rejects.toThrow("MARKETING_PROMPT_FACTS_REJECTED");
    const negative = [...rejected.values()][0]!, current = structuredClone(shots[0]!);
    if (kind === "prompt") current.prompt += " changed";
    if (kind === "fields") current.fields.规格 = "100档";
    if (kind === "source") prepared.bundle.restrictions.push("新事实限制");
    if (kind === "scope") negative.scope!.tenantId = "another-tenant";
    if (kind === "unknown") negative.verdict.unknownOutcome = true;
    if (kind === "fallback") negative.verdict.via = "fallback";
    if (kind === "passed") { negative.verdict.status = "passed"; negative.verdict.approved = true; negative.verdict.score = 96; }
    if (kind === "missing-shot") delete negative.rejectedShot;
    if (kind === "missing-verdict") delete negative.verdictArchive;
    if (kind === "verdict-inline") negative.verdict.reason = "篡改的诊断";
    if (kind === "verdict-file") await writeFile(path.join(root, negative.verdictArchive!.ref), "changed");
    const before = modelCalls.length;
    await expect(verifyRejectedMarketingFactReview(prepared, current, negative)).rejects.toThrow();
    expect(modelCalls).toHaveLength(before);
  });

  it("模型不可用的晚期未验证结果不保存negative，恢复时保留作者内容只补独立事实审核", async () => {
    const original = await checkpointMarketingFacts(await prepare());
    const reject = vi.fn(async () => {}), before = modelCalls.length;
    await expect(finalizeMarketingFacts(original, shots, {}, { load: async () => null, save: async () => {}, reject })).rejects.toThrow("MARKETING_PROMPT_FACTS_REJECTED");
    expect(reject).not.toHaveBeenCalled();
    expect(modelCalls).toHaveLength(before);
    const next = await restoreMarketingFacts(original, { root, scope: { ...scope, runId: "RUN2", attempt: 2 }, intent: "做一条风扇介绍", stageId: "preproduction" });
    await finalizeMarketingFacts(next, shots, env, { load: async () => null, save: async () => {}, reject });
    expect(modelCalls.length - before).toBe(1);
    expect(reject).not.toHaveBeenCalled();
  });

  it("晚期已知negative裁决归档失败标记回执待核实，不保存半个negative或再次判审", async () => {
    const prepared = await prepare(), reject = vi.fn(async () => {});
    const verdictRef = `${prepared.prefix}-shot-1.verdict.json`;
    await writeFile(path.join(root, verdictRef), "immutable earlier evidence");
    rejectJudge = true;
    const before = modelCalls.length;
    const cache = { load: async () => null, save: async () => {}, reject };
    await expect(finalizeMarketingFacts(prepared, shots, env, cache)).rejects.toMatchObject({ code: "MARKETING_FACTS_RECEIPT_UNVERIFIED", cause: { code: "EEXIST" } });
    expect(reject).not.toHaveBeenCalled();
    expect(modelCalls.length - before).toBe(1);
    await expect(finalizeMarketingFacts(prepared, shots, env, cache)).rejects.toThrow();
    expect(modelCalls.length - before).toBe(1);
    expect(await readFile(path.join(root, verdictRef), "utf8")).toBe("immutable earlier evidence");
  });

  it("晚期负缓存若返回篡改主张，实际finalize也在模型调用前拒绝", async () => {
    const original = await checkpointMarketingFacts(await prepare());
    let negative: MarketingShotFactReview | null = null;
    rejectJudge = true;
    await expect(finalizeMarketingFacts(original, shots, env, { load: async () => null, save: async () => {},
      reject: async (_key, review) => { negative = structuredClone(review); } })).rejects.toThrow("MARKETING_PROMPT_FACTS_REJECTED");
    const tampered = negative as unknown as MarketingShotFactReview;
    tampered.promptSha256 = "0".repeat(64);
    const next = await restoreMarketingFacts(original, { root, scope: { ...scope, runId: "RUN2", attempt: 2 }, intent: "做一条风扇介绍", stageId: "preproduction" });
    const before = modelCalls.length;
    await expect(finalizeMarketingFacts(next, shots, env, { load: async () => null, save: async () => {}, loadRejected: async () => tampered }))
      .rejects.toMatchObject({ code: "MARKETING_PROMPTS_UNVERIFIED" });
    expect(modelCalls).toHaveLength(before);
  });

  it("晚期provider结果未知且verdict归档冲突时保留unknown优先，不写semantic负回执", async () => {
    const prepared = await prepare(), reject = vi.fn(async () => {});
    await writeFile(path.join(root, `${prepared.prefix}-shot-1.verdict.json`), "immutable earlier evidence");
    const request = vi.fn(async () => { throw new Error("socket lost after dispatch"); });
    vi.stubGlobal("fetch", request);
    await expect(finalizeMarketingFacts(prepared, shots, env, { load: async () => null, save: async () => {}, reject }))
      .rejects.toMatchObject({ code: "VIDEO_MODEL_OUTCOME_UNKNOWN", cause: { code: "EEXIST" } });
    expect(request).toHaveBeenCalledOnce();
    expect(reject).not.toHaveBeenCalled();
  });

  it("第二镜事实审核失败后只重审该镜，保留第一镜已完成的真实审核", async () => {
    const original = await checkpointMarketingFacts(await prepare());
    const records = new Map<string, MarketingShotFactReview>();
    let rejectSecond = true;
    const cache = { load: async (key: string) => records.get(key) ?? null,
      save: async (key: string, review: MarketingShotFactReview) => {
        records.set(key, structuredClone(review));
        if (rejectSecond && review.shotId === "S1") rejectJudge = true;
      } };
    const twoShots = [...shots, { ...shots[0]!, shotId: "S2", prompt: "镜头二继续展示已核实的风量 9 档。" }];
    const sourceCalls = modelCalls.length;
    await expect(finalizeMarketingFacts(original, twoShots, env, cache)).rejects.toThrow("MARKETING_PROMPT_FACTS_REJECTED");
    expect(modelCalls.length - sourceCalls).toBe(2);
    expect(records.size).toBe(1);
    rejectSecond = false;
    rejectJudge = false;
    const nextScope = { ...scope, runId: "RUN-next", attempt: 2 };
    const resumed = await restoreMarketingFacts(original, { root, scope: nextScope, intent: "做一条风扇介绍", stageId: "preproduction" });
    const before = modelCalls.length;
    const saved = await finalizeMarketingFacts(resumed, twoShots, env, cache);
    expect(modelCalls.length - before).toBe(1);
    const verified = await verifyMarketingFacts({ root, ...saved, scope: nextScope, shots: twoShots });
    expect(verified.outputReviews.map(review => review.scope?.runId)).toEqual([scope.runId, nextScope.runId]);
  });

  it.each([false, true])("来源审核保留原身份和原始字节，最终镜头绑定新attempt，同run=%s", async sameRun => {
    const intent = "做一条风扇介绍";
    const original = await checkpointMarketingFacts(await prepare({ intent }));
    const nextScope = { ...scope, runId: sameRun ? scope.runId : "RUN-resumed", attempt: 2 };
    const before = extractionCalls.length;
    const resumed = await restoreMarketingFacts(original, { root, scope: nextScope, intent, stageId: "preproduction" });
    expect(extractionCalls).toHaveLength(before);
    expect(resumed.g1Content).toBe(original.g1Content);
    expect(resumed.bundle).toMatchObject({ scope: nextScope, sourceScope: scope });
    expect(resumed.storeRoot).toBe(path.join(root, "stages/preproduction/attempt-2.marketing-dossier"));
    const saved = await finalizeMarketingFacts(resumed, shots, env);
    const checked = await verifyMarketingFacts({ root, ...saved, scope: nextScope, shots });
    expect(checked.sources[0]!.textRef).toContain("attempt-1.");
    expect(checked.outputReviews[0]!.ref).toContain("attempt-2.");
    const sourceReview = JSON.parse(await readFile(path.join(root, checked.stages[0]!.review!.ref), "utf8"));
    const shotReview = JSON.parse(await readFile(path.join(root, checked.outputReviews[0]!.ref), "utf8"));
    expect(sourceReview.scope.runId).toBe(scope.runId);
    expect(shotReview.scope.runId).toBe(nextScope.runId);
  });

  it.each(["different-intent", "different-project", "tampered-source", "expired"])("来源接续拒绝 %s", async kind => {
    const original = await checkpointMarketingFacts(await prepare());
    if (kind === "tampered-source") await writeFile(path.join(root, original.bundle.sources[0]!.textRef), "改过的来源");
    if (kind === "expired") {
      const expired = { ...original.bundle, collectedAt: new Date(Date.now() - 25 * 3600_000).toISOString() };
      const text = canonicalRenderJson(expired);
      await writeFile(path.join(root, original.sourceCheckpoint!.ref), text);
      original.sourceCheckpoint!.sha256 = renderSha256(text);
      original.bundle = expired;
    }
    await expect(restoreMarketingFacts(original, { root,
      scope: { ...scope, projectId: kind === "different-project" ? "OTHER" : scope.projectId, runId: "RUN-next", attempt: 2 },
      intent: kind === "different-intent" ? "新的意图" : "做一条风扇介绍", stageId: "preproduction" })).rejects.toThrow();
  });

  it("同项目同执行号的提示词审核和正式前期使用独立来源与事实目录", async () => {
    const full = await finalizeMarketingFacts(await prepare(), shots, env);
    const prompt = await finalizeMarketingFacts(await prepare({ stageId: "prompt_review" }), shots, env);
    expect(full.ref).toBe("stages/preproduction/attempt-1.marketing-facts.json");
    expect(prompt.ref).toBe("stages/prompt_review/attempt-1.marketing-facts.json");
    const verified = await verifyMarketingFacts({ root, ...prompt, scope, shots, stageId: "prompt_review" });
    expect(verified.sources[0]!.rawRef).toMatch(/^stages\/prompt_review\//);
    expect(verified.outputReviews[0]!.ref).toMatch(/^stages\/prompt_review\//);
    await expect(verifyMarketingFacts({ root, ...prompt, scope, shots })).rejects.toMatchObject({ code: "MARKETING_PATH_INVALID" });
    await expect(verifyMarketingFacts({ root, ...full, scope, shots, stageId: "prompt_review" })).rejects.toMatchObject({ code: "MARKETING_PATH_INVALID" });
  });

  it("无授权商品图的交接和虚构披露尾帧要求分别归档，后者原样进入 G1 和逐镜事实审核", async () => {
    const intent = "用虚构角色演示风扇。成片叠加“情节为创作演示”，尾帧显示“星野 F3”。";
    const prepared = await prepare({ intent });
    const { creativeRequirements, cards } = prepared.bundle;
    expect(cards.portrait_manifest).toMatchObject({ reference_images: [], hero_image_id: null,
      needs_more_reference: true, handoff_note: expect.stringContaining("没有可交接的商品参考图") });
    expect(JSON.stringify(cards.portrait_manifest)).not.toContain("免重复检索");
    expect(creativeRequirements).toEqual({ role: "creative-and-delivery", intent, intentSha256: renderSha256(intent) });
    const g1 = JSON.parse(prepared.g1Content);
    expect(g1.facts.creativeRequirements).toEqual(creativeRequirements);
    expect(g1.facts.restrictions).toEqual(expect.arrayContaining([expect.stringContaining("披露、屏幕文字、字幕和尾帧")]));
    expect(JSON.stringify(prepared.raw)).not.toContain("情节为创作演示");
    const saved = await finalizeMarketingFacts(prepared, shots, env);
    const verified = await verifyMarketingFacts({ root, ...saved, scope, shots, intentSha256: renderSha256(intent) });
    const evidence = JSON.parse(await readFile(path.join(root, verified.outputReviews[0]!.ref), "utf8"));
    expect(evidence.creativeRequirements).toEqual(creativeRequirements);
    await expect(verifyMarketingFacts({ root, ...saved, scope, shots, intentSha256: renderSha256("另一个客户原文") }))
      .rejects.toMatchObject({ code: "MARKETING_CREATIVE_REQUIREMENTS_UNBOUND" });
  });

  it("未进入已审A1主张的品牌、类别、型号仍只是检索线索，不能兜底成档案身份", async () => {
    const hints = { brand: "仅供检索品牌", category: "仅供检索服务", model: "仅供检索型号" };
    const prepared = await prepare({ queryHints: hints });
    expect(prepared.bundle.productQuery).toMatchObject(hints);
    expect(prepared.raw.A1.identity).not.toHaveProperty("brand");
    expect(prepared.raw.A1.identity).not.toHaveProperty("category");
    expect(prepared.raw.A1.identity).not.toHaveProperty("model");
    expect(prepared.bundle.dossier.identity).toMatchObject({ name: "星野 F3", brand: "", category: "", model: "" });
    expect(prepared.bundle.cards.brief_card).toMatchObject({ product: "星野 F3", category: "" });
    const persisted = JSON.parse(await readFile(path.join(prepared.storeRoot, String(prepared.bundle.dossier.product_id), "dossier.json"), "utf8"));
    expect(persisted.identity).toMatchObject({ name: "星野 F3", brand: "", category: "", model: "" });
  });
  it("没有竞品证据时不把己方卖点补集当成竞争差异事实交给创作", async () => {
    const prepared = await prepare();
    expect(prepared.raw.A3.competitors).toEqual([]);
    expect(prepared.bundle.restrictions).toContain("没有可核实竞品证据：禁止对比、竞品弱点或市场领先主张");
    expect(prepared.bundle.dossier.differentiation).toEqual({ our_opening: [], crowded_points: [], weakness_openings: [] });
    expect((prepared.bundle.cards.theme_card as { differentiation_space: string[] }).differentiation_space).toEqual([]);
    expect((prepared.bundle.cards.insight_card as { market_position: { our_opening: string[] } }).market_position.our_opening).toEqual([]);
    expect((prepared.bundle.dossier.identity as { official_selling_points: unknown[] }).official_selling_points).toHaveLength(1);
  });
  it("没有采纳价格的事实包明确禁止下游从来源正文或客户期望补回报价", async () => {
    const prepared = await prepare();
    expect((prepared.raw.A1.identity as { prices: unknown[] }).prices).toEqual([]);
    expect(prepared.bundle.restrictions).toContain("没有可采纳的当前价格证据：禁止报价、优惠、价格比较或性价比数字主张；不得从未采纳的来源价格或用户期望补回。");
    expect(prepared.g1Content).toContain("没有可采纳的当前价格证据");
    expect(prepared.bundle.stages[0]!.supportAttempts).toHaveLength(1);
  });
  it("跨站不同fragment指向同一规范来源时复用同次抓取快照，不因抓取时间不同破坏审核绑定", async () => {
    const prepared = await prepare({ fragmentAliases: true });
    const saved = await finalizeMarketingFacts(prepared, shots, env);
    const checked = await verifyMarketingFacts({ root, ...saved, scope, shots });
    expect(checked.sources).toHaveLength(1);
    expect(checked.sources[0]!.requestedUrl).toBe(sourceUrl);
  });
  it.each([false, true])("混币报价从来源提取、G1档案到最终镜头复核始终逐币种表达，零价=%s", async zeroPrice => {
    const expectedBand = zeroPrice ? "USD 0；CNY 699" : "USD 99-109；CNY 699-799";
    const prepared = await prepare({ mixedCurrencies: true, zeroPrice });
    expect((prepared.bundle.dossier.identity as Record<string, unknown>).price_band).toBe(expectedBand);
    expect(prepared.g1Content).toContain(expectedBand);
    expect(prepared.g1Content).not.toContain("USD 99-799");
    expect((prepared.bundle.cards.insight_card as { market_position: { price_band: string } }).market_position.price_band).toBe(expectedBand);
    expect(JSON.stringify(prepared.bundle.cards.prd_card)).toContain(expectedBand);
    const a1 = prepared.bundle.stages[0]!.facts;
    expect(a1.claims.filter(claim => claim.pointer.endsWith("/currency")).map(claim => claim.value)).toEqual(zeroPrice ? ["USD", "CNY"] : ["USD", "USD", "CNY", "CNY"]);
    expect(prepared.bundle.rawSha256).toBe(renderSha256(canonicalRenderJson(prepared.raw)));
    const g1File = path.join(root, "g1-facts.json"); await writeFile(g1File, prepared.g1Content);
    const verdict = await reviewStage({ stage: "script", projectId: scope.projectId, env,
      artifacts: [{ path: g1File, kind: "json", note: "完整G1事实档案与价格来源" }],
      deterministic: [{ id: "currency-groups", pass: true, hard: true, detail: "原始报价按币种分组，未汇率换算" }],
      requiredCheckIds: ["currency-groups"], minScore: 85,
      rubric: ["报价必须保留原币种，不能将美元与人民币数值合成同一价格区间"],
    });
    expect(verdict.status).toBe("passed");
    const outputShots = [{ ...shots[0]!, prompt: `按来源分别展示价格区间：${expectedBand}。` }];
    const saved = await finalizeMarketingFacts(prepared, outputShots, env);
    const checked = await verifyMarketingFacts({ root, ...saved, scope, shots: outputShots });
    expect((checked.dossier.identity as Record<string, unknown>).price_band).toBe(expectedBand);
    const persisted = JSON.parse(await readFile(path.join(prepared.storeRoot, String(prepared.bundle.dossier.product_id), "dossier.json"), "utf8"));
    expect(persisted.identity.price_band).toBe(expectedBand);
  });
  it("不同检索跳转指向同一正文时，逐站来源审核仍绑定其实际抓取快照", async () => {
    const prepared = await prepare({ redirectAliases: true });
    const saved = await finalizeMarketingFacts(prepared, shots, env);
    const checked = await verifyMarketingFacts({ root, ...saved, scope, shots });
    expect(checked.sources).toHaveLength(2);
    expect(new Set(checked.sources.map(source => source.sourceId)).size).toBe(2);
    expect(checked.sources.map(source => source.requestedUrl)).toEqual([
      "https://source.example.com/redirect-a", "https://source.example.com/redirect-b",
    ]);
    expect(checked.sources.every(source => source.finalUrl === sourceUrl)).toBe(true);
    expect(checked.sources[0]!.textSha256).toBe(checked.sources[1]!.textSha256);
  });
  it("CLI 预置检索缓存可直接注入宿主，不需要调用方另造检索函数", async () => {
    const cacheFile = path.join(root, "search-cache.json");
    primeSearchCache(cacheFile, {
      "星野 F3 官网": [{ title: "星野规格", url: sourceUrl, snippet: "公开规格页" }],
    });
    const previous = process.env.WL_SEARCH_PROVIDERS;
    process.env.WL_SEARCH_PROVIDERS = "api";
    try {
      const prepared = await prepare({ searchCacheFile: cacheFile });
      expect(prepared.bundle.stages[0]).toMatchObject({ stage: "A1", facts: { status: "source_bound" } });
      expect(prepared.bundle.sources).toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env.WL_SEARCH_PROVIDERS;
      else process.env.WL_SEARCH_PROVIDERS = previous;
    }
  });

  it("真实HTTP正文→三站提取/完整支持审核→A1–A5→逐最终镜头事实审核→复读", async () => {
    const prepared = await prepare();
    expect(prepared.bundle.stages.map(stage => [stage.stage, stage.facts.status])).toEqual([["A1", "source_bound"], ["A2", "no_evidence"], ["A3", "no_evidence"]]);
    expect(prepared.bundle.sources).toHaveLength(1);
    expect(prepared.bundle.restrictions).toEqual(expect.arrayContaining([expect.stringContaining("没有可核实用户评价"), expect.stringContaining("没有可核实竞品证据")]));
    expect(extractionCalls).toHaveLength(3);
    expect((prepared.bundle.dossier.provenance as Array<{ claim_ref?: string }>).some(item => item.claim_ref === "identity.specs.风量")).toBe(true);
    expect(JSON.stringify(prepared.bundle.dossier.gaps)).not.toContain("规格 \"风量\" 无来源");
    expect(prepared.g1Content).toContain('"schemaVersion":"workloom.marketing-facts/v1"'); expect(modelCalls).toHaveLength(3);
    expect(JSON.stringify(modelCalls)).toContain("不得声称静音或市场第一"); expect(JSON.stringify(modelCalls)).not.toContain("999档");
    const saved = await finalizeMarketingFacts(prepared, shots, env); expect(modelCalls).toHaveLength(4);
    const checked = await verifyMarketingFacts({ root, ...saved, scope, shots }); expect(checked.outputReviews[0]?.promptSha256).toBe(renderSha256(shots[0]!.prompt));
    expect(await readFile(path.join(root, checked.sources[0]!.textRef), "utf8")).toBe(sourceText);
  });
  it("组合来源超过旧提取字符上限时仍完整交给模型", async () => {
    const prepared = await prepare({ largeSources: true });
    expect(extractionCalls).toHaveLength(3);
    expect(extractionCalls[0]!.length).toBeGreaterThan(90_000);
    const sourceJson = /当前阶段：A1\n(.*)$/s.exec(extractionCalls[0]!)![1]!;
    const sources = (JSON.parse(sourceJson) as { sources: Array<{ text: string }> }).sources;
    expect(sources).toHaveLength(3);
    expect(sources.every(source => source.text === longSourceText)).toBe(true);
    expect(prepared.bundle.stages[0]?.facts.status).toBe("source_bound");
  });
  it("超过旧字符上限的 G1 事实包按完整字节送审并绑定", async () => {
    const prepared = await prepare({ largeGate: true });
    expect(prepared.g1Content.length).toBeGreaterThan(100_000);
    const file = path.join(root, "large-g1.json");
    await writeFile(file, prepared.g1Content);
    const verdict = await reviewStage({ stage: "script", projectId: scope.projectId, env,
      artifacts: [{ path: file, kind: "json" }], deterministic: [] });
    expect(verdict.approved).toBe(true);
    expect(verdict.evidence?.[0]).toMatchObject({ sha256: prepared.bundle.g1ContentSha256, scope: "complete-text" });
    expect(JSON.stringify(modelCalls.at(-1)).includes("需求末尾证据")).toBe(true);
  });
  it.each(["spec", "no-search", "bad-quote", "model-failure", "support-rejected"])("%s不能得到可送G1的事实包", async kind => {
    rejectJudge = kind === "support-rejected";
    await expect(prepare({ mode: kind === "spec" ? "spec" : undefined, noSearch: kind === "no-search", badQuote: kind === "bad-quote", modelFailure: kind === "model-failure" })).rejects.toThrow();
    if (["spec", "no-search", "bad-quote", "model-failure"].includes(kind)) expect(modelCalls).toHaveLength(0);
  });
  it("最终镜头夸大主张被监制拒绝，事实包不能完成", async () => {
    const prepared = await prepare(); rejectJudge = true;
    await expect(finalizeMarketingFacts(prepared, [{ ...shots[0]!, prompt: "全市场第一，零噪音" }], env)).rejects.toThrow("MARKETING_PROMPT_FACTS_REJECTED");
    await expect(readFile(path.join(root, `${prepared.prefix}-facts.json`))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["raw", "text", "review", "prompt", "fields", "scope", "attempt", "expired", "claim-offset"])("%s变化不能复用营销事实资格", async kind => {
    const prepared = await prepare(), saved = await finalizeMarketingFacts(prepared, shots, env); let hash = saved.sha256;
    const requestedShots = structuredClone(shots), expectedScope = { ...scope };
    if (["raw", "text", "review"].includes(kind)) {
      const source = prepared.bundle.sources[0]!, file = kind === "raw" ? source.rawRef : kind === "text" ? source.textRef : prepared.bundle.stages[0]!.review!.ref;
      await writeFile(path.join(root, file), "changed");
    }
    if (kind === "prompt") requestedShots[0]!.prompt += "未审主张";
    if (kind === "fields") requestedShots[0]!.fields.规格 = "99 档";
    if (kind === "scope") expectedScope.tenantId = "other";
    if (kind === "attempt") expectedScope.attempt = 2;
    if (kind === "expired" || kind === "claim-offset") {
      if (kind === "expired") prepared.bundle.collectedAt = new Date(Date.now() - 25 * 3600_000).toISOString();
      else prepared.bundle.stages[0]!.facts.claims[0]!.quoteStart++;
      const text = canonicalRenderJson(prepared.bundle); await writeFile(path.join(root, saved.ref), text); hash = renderSha256(text);
    }
    await expect(verifyMarketingFacts({ root, ref: saved.ref, sha256: hash, scope: expectedScope, shots: requestedShots })).rejects.toThrow();
  });
  it.each(["source", "shot"] as const)("%s通过裁决若同时标记结果未知，完整同步摘要后仍拒绝复用", async kind => {
    const prepared = await prepare();
    const saved = await finalizeMarketingFacts(prepared, shots, env);
    const bundle = JSON.parse(await readFile(path.join(root, saved.ref), "utf8")) as PreparedMarketingFacts["bundle"];
    if (kind === "source") {
      const record = bundle.stages[0]!;
      record.review!.verdict = { ...record.review!.verdict, unknownOutcome: true };
      const attempt = record.supportAttempts!.at(-1)!;
      const verdictText = canonicalRenderJson(record.review!.verdict);
      await writeFile(path.join(root, attempt.verdict.ref), verdictText);
      attempt.verdict.sha256 = renderSha256(verdictText);
    } else {
      bundle.outputReviews[0]!.verdict = { ...bundle.outputReviews[0]!.verdict, unknownOutcome: true };
    }
    const bytes = canonicalRenderJson(bundle);
    await writeFile(path.join(root, saved.ref), bytes);
    await expect(verifyMarketingFacts({ root, ref: saved.ref, sha256: renderSha256(bytes), scope, shots }))
      .rejects.toMatchObject({ code: kind === "source" ? "MARKETING_SUPPORT_UNVERIFIED" : "MARKETING_PROMPTS_UNVERIFIED" });
  });

  it("重复attempt写盘失败必须终止，不能当抓源失败换候选", async () => {
    await prepare(); await expect(prepare()).rejects.toMatchObject({ code: "EEXIST" });
  });
});
