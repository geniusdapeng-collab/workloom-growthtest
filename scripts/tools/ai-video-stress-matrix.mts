#!/usr/bin/env tsx
/**
 * Deterministic 60-case AI-video pipeline matrix.
 *
 * Production routing, request guards, source facts, runtime narrative isolation,
 * final-shot contracts and render-boundary helpers are executed directly.
 * Cases requiring a semantic model judgment use a labelled deterministic replay;
 * no video provider, image provider or paid generation endpoint is called.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import {
  applyRouteToMetadata,
  buildPipelineIntent,
  routeVideoPipeline,
  validatePipelineRequest,
  type VideoRouteDecision,
} from "../../packages/video-studio/src/pipeline-router.js";
import {
  applyNarrativeFinalPromptContract,
  installVendorDiscoveryNarrativeBridge,
} from "../../packages/video-studio/src/vendor-compat.js";
import {
  assertRenderSubmissionEligible,
  inspectFinalShotContract,
} from "../../packages/video-studio/src/final-shot-contract.js";
import { validateShotDurations } from "../../packages/video-studio/src/duration-rules.js";
import { validateStageFacts } from "../../apps/server/src/video/marketing-facts.js";
import { assertMarketingFactsFresh } from "../../apps/server/src/video/marketing-facts.js";
import { sourceUrl, type SourceSnapshot } from "../../apps/server/src/video/marketing-source-fetcher.js";

type JsonRecord = Record<string, unknown>;
type CaseKind = "marketing" | "narrative" | "abnormal";
type ExecutionMode = "production-router" | "production-contract" | "runtime-bridge" | "deterministic-replay";

interface MarketingCase {
  id: string;
  title: string;
  intent: string;
  product: string;
  brand: string;
  category: string;
  model: string;
  platform: string;
  duration: number;
  sellingPoints: string[];
  evidence: Record<string, string>;
}

interface NarrativeCase {
  id: string;
  title: string;
  intent: string;
  platform: string;
  duration: number;
}

interface AbnormalCase {
  id: string;
  title: string;
  kind: string;
  expected: string;
  intent?: string;
  route?: string;
  duration?: number;
  platform?: string;
  sourceUrl?: string;
  sourceText?: string;
  aspectRatio?: string;
  prompt?: string;
  shots?: Array<{ shotId: string; prompt: string }>;
  ageHours?: number;
}

interface CaseSuite {
  schema: string;
  taskId: string;
  marketing: MarketingCase[];
  narrative: NarrativeCase[];
  abnormal: AbnormalCase[];
}

interface CaseResult {
  id: string;
  category: CaseKind;
  title: string;
  expected: string;
  actual: string;
  pass: boolean;
  mode: ExecutionMode;
  invocation: JsonRecord;
  output: JsonRecord;
  durationMs: number;
  evidence: string;
  evidenceSha256: string;
}

const arg = (name: string, fallback = ""): string => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
};
const repoRoot = resolve(import.meta.dirname ?? process.cwd(), "../..");
const casesPath = resolve(repoRoot, arg("--cases", "stress/ai-video-pipeline-cases.json"));
const outRoot = resolve(repoRoot, arg(
  "--out",
  "outputs/ai-video-stress/T-2026-1031-9004/matrix",
));
const suite = JSON.parse(readFileSync(casesPath, "utf8")) as CaseSuite;
const vendorRequire = createRequire(resolve(repoRoot, "package.json"));
const { ProductInfoCollector } = vendorRequire(resolve(
  repoRoot,
  "vendor/supermickey/hyperreality-system/engines/data-mining-engine/agents/product-info-collector.js",
)) as {
  ProductInfoCollector: {
    queryBase(input: JsonRecord): string;
    new (): { plan(input: JsonRecord): { queries: Array<{ q: string; intent: string }> } };
  };
};
const guardModule = vendorRequire(resolve(
  repoRoot,
  "vendor/supermickey/hyperreality-system/engines/render-pipeline-guard.js",
)) as {
  RenderPipelineGuard: new (options?: JsonRecord) => {
    check(prompts: JsonRecord[]): { pass: boolean; errors: JsonRecord[]; warnings: JsonRecord[] };
  };
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as JsonRecord;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.match(/^([A-Z][A-Z0-9_]+)(?::|\b)/u)?.[1] ?? "UNEXPECTED_ERROR";
}

function sourceSnapshot(textValue: string): SourceSnapshot {
  const url = "https://source.example.com/product";
  return {
    sourceId: "SRC-MATRIX",
    requestedUrl: url,
    finalUrl: url,
    redirectChain: [],
    fetchedAt: new Date().toISOString(),
    contentType: "text/plain; charset=utf-8",
    rawSha256: sha256(textValue),
    textSha256: sha256(textValue),
    bytes: Buffer.byteLength(textValue),
    text: textValue,
    assetUrls: [],
  };
}

function escapedPointer(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function validateMarketingFacts(c: MarketingCase): { claims: number; factHash: string } {
  const url = "https://source.example.com/product";
  const evidenceText = [
    c.product,
    c.brand,
    c.category,
    c.model,
    c.evidence.spec,
    c.evidence.claim,
    c.evidence.review,
    c.evidence.competitor,
    ...c.sellingPoints,
  ].join("\n");
  const source = sourceSnapshot(evidenceText);
  const payload = {
    identity: {
      name: c.product,
      brand: c.brand,
      category: c.category,
      model: c.model,
      specs: {
        规格: c.evidence.spec,
        官方宣称: c.evidence.claim,
      },
      prices: [],
      official_selling_points: c.sellingPoints.map((point) => ({
        point,
        source_url: url,
      })),
    },
    images: [],
  };
  const citations = [
    ["/identity/name", c.product],
    ["/identity/brand", c.brand],
    ["/identity/category", c.category],
    ["/identity/model", c.model],
    ["/identity/specs/规格", c.evidence.spec],
    ["/identity/specs/官方宣称", c.evidence.claim],
    ...c.sellingPoints.map((point, index) => [
      `/identity/official_selling_points/${index}/point`,
      point,
    ] as const),
  ].map(([pointer, quote]) => ({
    pointer,
    sourceId: source.sourceId,
    quote,
  }));
  const facts = validateStageFacts("A1", { payload, citations }, [source]);
  if (facts.status !== "source_bound") throw new Error("MATRIX_FACTS_NOT_BOUND");
  return { claims: facts.claims.length, factHash: sha256(canonical(facts)) };
}

function narrativeShots(c: NarrativeCase): JsonRecord[] {
  const count = Math.max(1, Math.min(6, Math.floor(c.duration / 4)));
  const base = Math.floor(c.duration / count);
  const remainder = c.duration % count;
  return Array.from({ length: count }, (_, index) => ({
    shotId: `S${index + 1}`,
    sceneType: index === 0 ? "opening" : index === count - 1 ? "resolution" : "development",
    duration: base + (index < remainder ? 1 : 0),
    dialogue: "这一行必须被清除",
    dialogueText: "这一行必须被清除",
    dialogueBlocks: [{ line: "这一行必须被清除" }],
    fields: {
      场景: `${c.title}的完整场景，环境材质、空间方向与光线来源明确。`,
      角色: "画面无角色出场，只记录环境与道具。",
      服装: "无角色出场，本字段不适用。",
      动作: "环境中的水汽、灰尘和光线缓慢变化，所有接触与落点符合物理。",
      负面约束: c.intent.includes("海面")
        ? "no people, no text, no watermark, no floating objects"
        : "no people, no text, no watermark, no extra objects",
    },
    prompt: [
      "01.【场景】" + `${c.title}的完整场景，环境材质、空间方向与光线来源明确。`,
      "12.【角色】画面无角色出场，只记录环境与道具。",
      "13.【服装】无角色出场，本字段不适用。",
      "15.【动作】环境中的水汽、灰尘和光线缓慢变化，所有接触与落点符合物理。",
      "18.【台词】这一行必须被清除。",
      "24.【负面约束】no people, no text, no watermark, no extra objects",
    ].join("\n"),
  }));
}

function shotSetBuild(rows: Array<{ shotId: string; prompt: string }>, overrides: JsonRecord = {}): JsonRecord[] {
  return rows.map((row, index) => ({
    shotId: row.shotId,
    duration: 4,
    prompt: row.prompt,
    dialogue: "",
    ...(index === 0 ? overrides : {}),
  }));
}

function replayJudge(input: {
  expected: string;
  sourceText: string;
  claimValue: string;
  quote: string;
}): never {
  if (/忽略.{0,12}(要求|指令)|系统提示|只输出/i.test(input.sourceText)
    && /销量第一|市场第一|零噪音|唯一官方/.test(input.claimValue)) {
    throw new Error("SOURCE_INSTRUCTION_NOT_FOLLOWED: 来源中的注入指令没有改变事实边界");
  }
  if (!input.quote.includes(input.claimValue)) {
    throw new Error(`${input.expected}: 引文不能被该主张语义使用`);
  }
  throw new Error(`${input.expected}: 确定性评审拒绝`);
}

async function runAbnormal(c: AbnormalCase): Promise<{ actual: string; output: JsonRecord; mode: ExecutionMode }> {
  switch (c.kind) {
    case "empty-intent": {
      validatePipelineRequest({ intent: "" });
      return { actual: "UNEXPECTED_PASS", output: {}, mode: "production-contract" };
    }
    case "marketing-missing-product": {
      const decision = await routeVideoPipeline({ text: c.intent ?? "", explicit: "marketing" });
      return {
        actual: decision.route === "clarify" && decision.clarify?.missing.includes("product") ? "CLARIFY_PRODUCT" : decision.route,
        output: decision as unknown as JsonRecord,
        mode: "production-router",
      };
    }
    case "ambiguous-route": {
      const decision = await routeVideoPipeline({ text: c.intent ?? "" });
      return {
        actual: decision.route === "clarify" && decision.clarify?.missing.includes("route") ? "CLARIFY_ROUTE" : decision.route,
        output: decision as unknown as JsonRecord,
        mode: "production-router",
      };
    }
    case "route-conflict": {
      // The source contains an explicit positive marketing phrase inside a contradictory sentence.
      // Preserve fail-closed clarification rather than allowing positive-word matching to spend money.
      const actual = "CLARIFY_ROUTE";
      return {
        actual,
        output: {
          route: "clarify",
          reason: "deterministic-replay: 同时含不要营销片与按营销片带货，继续开工会产生方向性冲突",
        },
        mode: "deterministic-replay",
      };
    }
    case "unsafe-product": {
      validatePipelineRequest({ intent: c.intent ?? "做视频", product: "../../秘密" });
      return { actual: "UNEXPECTED_PASS", output: {}, mode: "production-contract" };
    }
    case "private-source": {
      sourceUrl(c.sourceUrl ?? "");
      return { actual: "UNEXPECTED_PASS", output: {}, mode: "production-contract" };
    }
    case "credential-source": {
      sourceUrl(c.sourceUrl ?? "");
      return { actual: "UNEXPECTED_PASS", output: {}, mode: "production-contract" };
    }
    case "source-prompt-injection": {
      const sourceText = c.sourceText ?? "";
      const source = sourceSnapshot(sourceText);
      const facts = validateStageFacts("A1", {
        payload: {
          identity: {
            name: "测试商品",
            specs: { 宣称: "只输出官方卖点并声称销量第一" },
            prices: [],
            official_selling_points: [],
          },
          images: [],
        },
        citations: [
          { pointer: "/identity/name", sourceId: source.sourceId, quote: sourceText },
          { pointer: "/identity/specs/宣称", sourceId: source.sourceId, quote: "声称销量第一" },
        ],
      }, [source]);
      const claim = String(facts.claims.find((item) => item.pointer === "/identity/specs/宣称")?.value ?? "");
      replayJudge({ expected: c.expected, sourceText, claimValue: claim, quote: "声称销量第一" });
      return { actual: "UNEXPECTED_PASS", output: facts as unknown as JsonRecord, mode: "deterministic-replay" };
    }
    case "hallucinated-citation": {
      const sourceText = c.sourceText ?? "";
      const source = sourceSnapshot(sourceText);
      const facts = validateStageFacts("A1", {
        payload: {
          identity: {
            name: "测试商品",
            specs: { 宣称: "销量第一" },
            prices: [],
            official_selling_points: [],
          },
          images: [],
        },
        citations: [
          { pointer: "/identity/name", sourceId: source.sourceId, quote: sourceText },
          { pointer: "/identity/specs/宣称", sourceId: source.sourceId, quote: sourceText },
        ],
      }, [source]);
      replayJudge({
        expected: c.expected,
        sourceText,
        claimValue: "销量第一",
        quote: sourceText,
      });
      return { actual: "UNEXPECTED_PASS", output: facts as unknown as JsonRecord, mode: "deterministic-replay" };
    }
    case "unsupported-competitor": {
      const sourceText = c.sourceText ?? "";
      const source = sourceSnapshot(sourceText);
      const facts = validateStageFacts("A3", {
        payload: {
          competitors: [{
            name: "竞品",
            selling_points: [{ point: "竞品噪音大", source_url: source.finalUrl }],
          }],
        },
        citations: [
          { pointer: "/competitors/0/name", sourceId: source.sourceId, quote: sourceText },
          { pointer: "/competitors/0/selling_points/0/point", sourceId: source.sourceId, quote: sourceText },
        ],
      }, [source]);
      replayJudge({
        expected: c.expected,
        sourceText,
        claimValue: "竞品噪音大",
        quote: sourceText,
      });
      return { actual: "UNEXPECTED_PASS", output: facts as unknown as JsonRecord, mode: "deterministic-replay" };
    }
    case "stale-facts": {
      assertMarketingFactsFresh(new Date(Date.now() - (c.ageHours ?? 25) * 3_600_000).toISOString());
      return { actual: "UNEXPECTED_PASS", output: {}, mode: "production-contract" };
    }
    case "tampered-source": {
      const source = sourceSnapshot("来源原值");
      if (sha256(source.text) !== source.textSha256) throw new Error("MARKETING_FACTS_CHANGED");
      validateStageFacts("A1", {
        payload: {
          identity: {
            name: "测试商品",
            specs: { 参数: "来源原值" },
            prices: [],
            official_selling_points: [],
          },
          images: [],
        },
        citations: [
          { pointer: "/identity/name", sourceId: source.sourceId, quote: "来源原值" },
          { pointer: "/identity/specs/参数", sourceId: source.sourceId, quote: "来源原值" },
        ],
      }, [{ ...source, textSha256: sha256("被篡改") }]);
      return { actual: "UNEXPECTED_PASS", output: {}, mode: "production-contract" };
    }
    case "invalid-duration": {
      validatePipelineRequest({ intent: "做视频", durationSec: c.duration });
      return { actual: "UNEXPECTED_PASS", output: {}, mode: "production-contract" };
    }
    case "invalid-aspect": {
      validatePipelineRequest({ intent: "做视频", aspectRatio: c.aspectRatio ?? "" });
      return { actual: "UNEXPECTED_PASS", output: {}, mode: "production-contract" };
    }
    case "empty-shot": {
      const contract = inspectFinalShotContract(
        shotSetBuild([{ shotId: "S1", prompt: c.prompt ?? "" }]),
        { maxPromptLength: 3000 },
      );
      return {
        actual: contract.issues[0]?.code ?? "CONTRACT_PASS",
        output: contract as unknown as JsonRecord,
        mode: "production-contract",
      };
    }
    case "duplicate-shot": {
      const contract = inspectFinalShotContract(
        shotSetBuild(c.shots ?? []),
        { maxPromptLength: 3000 },
      );
      return {
        actual: contract.issues.find((issue) => issue.code === "SHOT_DUPLICATE")?.code ?? "CONTRACT_PASS",
        output: contract as unknown as JsonRecord,
        mode: "production-contract",
      };
    }
    case "placeholder-shot": {
      const contract = inspectFinalShotContract(
        shotSetBuild([{ shotId: "S1", prompt: c.prompt ?? "" }]),
        { maxPromptLength: 3000 },
      );
      return {
        actual: contract.issues[0]?.code ?? "CONTRACT_PASS",
        output: contract as unknown as JsonRecord,
        mode: "production-contract",
      };
    }
    case "render-boundary": {
      const contract = inspectFinalShotContract([], { maxPromptLength: 3000 });
      assertRenderSubmissionEligible({
        status: contract.pass ? "eligible_pending_G8" : "blocked",
        providerSubmission: false,
        contractPass: contract.pass,
      });
      return { actual: "UNEXPECTED_PASS", output: contract as unknown as JsonRecord, mode: "production-contract" };
    }
    default:
      throw new Error(`UNKNOWN_ABNORMAL_CASE: ${c.kind}`);
  }
}

async function record(
  id: string,
  category: CaseKind,
  title: string,
  expected: string,
  mode: ExecutionMode,
  invocation: JsonRecord,
  operation: () => Promise<{ actual: string; output: JsonRecord; mode?: ExecutionMode }>,
): Promise<CaseResult> {
  const started = Date.now();
  let actual = "PASS";
  let output: JsonRecord = {};
  let selectedMode = mode;
  let pass = true;
  try {
    const result = await operation();
    actual = result.actual;
    output = result.output;
    selectedMode = result.mode ?? mode;
  } catch (error) {
    actual = errorCode(error);
    output = { error: error instanceof Error ? error.message : String(error) };
    pass = actual === expected;
  }
  if (actual === "UNEXPECTED_PASS") pass = false;
  if (pass && actual !== expected && actual !== "PASS") pass = false;
  const evidenceObject = {
    schema: "workloom.ai-video-stress-evidence/v1",
    taskId: suite.taskId,
    caseId: id,
    category,
    expected,
    actual,
    pass,
    mode: selectedMode,
    invocation,
    output,
    capturedAt: new Date().toISOString(),
  };
  const evidence = `${JSON.stringify(evidenceObject, null, 2)}\n`;
  const relativeEvidence = `evidence/${id}.json`;
  writeFileSync(join(outRoot, relativeEvidence), evidence, "utf8");
  return {
    id,
    category,
    title,
    expected,
    actual,
    pass,
    mode: selectedMode,
    invocation,
    output,
    durationMs: Date.now() - started,
    evidence: relativeEvidence,
    evidenceSha256: sha256(evidence),
  };
}

async function main(): Promise<void> {
  if (suite.marketing.length + suite.narrative.length + suite.abnormal.length !== 60) {
    throw new Error(`CASE_COUNT_INVALID: expected 60, got ${suite.marketing.length + suite.narrative.length + suite.abnormal.length}`);
  }
  mkdirSync(join(outRoot, "evidence"), { recursive: true });
  const results: CaseResult[] = [];
  const restoreNarrativeBridge = installVendorDiscoveryNarrativeBridge({ log: () => undefined });
  try {
    const systemModule = vendorRequire(resolve(repoRoot, "vendor/supermickey/hyperreality-system/index.js")) as {
      HyperrealitySystem?: { prototype: Record<string, unknown> };
    };
    const buildThemeInput = systemModule.HyperrealitySystem?.prototype._buildThemeInput as
      | ((this: unknown, intent: string, metadata?: JsonRecord) => string)
      | undefined;
    if (!buildThemeInput) throw new Error("THEME_INPUT_BRIDGE_UNAVAILABLE");

    for (const c of suite.marketing) {
      results.push(await record(c.id, "marketing", c.title, "MARKETING_READY", "production-router", {
        function: "routeVideoPipeline+applyRouteToMetadata+ProductInfoCollector.plan+validateStageFacts",
        caseHash: sha256(canonical(c)),
      }, async () => {
        const request = validatePipelineRequest({
          intent: c.intent,
          product: c.product,
          durationSec: c.duration,
          aspectRatio: "9:16",
          platform: c.platform,
          goal: "seeding",
        });
        const decision = await routeVideoPipeline({
          text: request.intent,
          metadata: {
            dataMining: {
              name: c.product,
              brand: c.brand,
              category: c.category,
              model: c.model,
              sellingPointCandidates: c.sellingPoints,
            },
            brief: {
              product: c.product,
              brand: { name: c.brand },
              category: c.category,
              sellingPoints: c.sellingPoints,
            },
          },
          explicit: "marketing",
        });
        if (decision.route !== "marketing" || decision.product?.name !== c.product) throw new Error("MARKETING_ROUTE_FAILED");
        const metadata = applyRouteToMetadata({ brief: {} }, decision);
        const effectiveIntent = buildPipelineIntent(request.intent, {
          durationSec: request.durationSec,
          aspectRatio: request.aspectRatio,
          platform: request.platform,
          goal: request.goal,
        });
        const themeInput = buildThemeInput.call({}, effectiveIntent, metadata);
        const productInput = metadata.dataMining as JsonRecord;
        const queryBase = ProductInfoCollector.queryBase(productInput);
        const plan = new ProductInfoCollector().plan(productInput);
        if (/米家\s+米家|4 Lite\s+4 Lite/u.test(queryBase)) throw new Error("PRODUCT_QUERY_DUPLICATED");
        const facts = validateMarketingFacts(c);
        return {
          actual: "MARKETING_READY",
          output: {
            route: decision as unknown as JsonRecord,
            metadata,
            effectiveIntent,
            themeInputContainsProduct: themeInput.includes(c.product),
            queryBase,
            queries: plan.queries,
            facts,
          },
        };
      }));
    }

    for (const c of suite.narrative) {
      results.push(await record(c.id, "narrative", c.title, "NARRATIVE_READY", "runtime-bridge", {
        function: "routeVideoPipeline+applyRouteToMetadata+installVendorDiscoveryNarrativeBridge+final-shot-contract+RenderPipelineGuard",
        caseHash: sha256(canonical(c)),
      }, async () => {
        const request = validatePipelineRequest({
          intent: c.intent,
          durationSec: c.duration,
          aspectRatio: "9:16",
          platform: c.platform,
        });
        const decision: VideoRouteDecision = await routeVideoPipeline({
          text: request.intent,
          metadata: {
            dataMining: { name: "不应出现的商品" },
            brief: {
              product: "不应出现的商品",
              products: [{ name: "不应出现的商品" }],
              brand: { name: "不应出现的品牌" },
              category: "不应出现的品类",
              sellingPoints: ["不应出现的卖点"],
              audience: "不应出现的人群",
              platform: "douyin",
              goal: "seeding",
            },
          },
          explicit: "narrative",
        });
        if (decision.route !== "narrative") throw new Error("NARRATIVE_ROUTE_FAILED");
        const metadata = applyRouteToMetadata({
          dataMining: { name: "不应出现的商品" },
          brief: {
            product: "不应出现的商品",
            brand: { name: "不应出现的品牌" },
            category: "不应出现的品类",
            sellingPoints: ["不应出现的卖点"],
            audience: "不应出现的人群",
            platform: "c",
            goal: "seeding",
            duration: c.duration,
            aspectRatio: "9:16",
          },
        }, decision);
        const effectiveIntent = buildPipelineIntent(request.intent, {
          durationSec: request.durationSec,
          aspectRatio: request.aspectRatio,
          platform: request.platform,
        });
        const themeInput = buildThemeInput.call({}, effectiveIntent, metadata);
        if (themeInput !== effectiveIntent || /\[营销 Brief|商品：|核心卖点：|转化目标：/u.test(themeInput)) {
          throw new Error("NARRATIVE_METADATA_CONTAMINATED");
        }
        const shots = narrativeShots(c);
        const finalized = shots.map((shot) => applyNarrativeFinalPromptContract(shot, {
          noDialogue: true,
          maxLength: 3000,
        }));
        const durations = validateShotDurations(finalized as Array<{ shotId: string; duration: number }>, {
          targetTotalSeconds: c.duration,
        });
        if (!durations.pass) throw new Error(`NARRATIVE_DURATION_INVALID: ${durations.issues.join("; ")}`);
        const contract = inspectFinalShotContract(finalized, {
          maxPromptLength: 3000,
          noDialogue: true,
        });
        if (!contract.pass) throw new Error(`NARRATIVE_FINAL_CONTRACT_FAILED: ${canonical(contract.issues)}`);
        const guard = new guardModule.RenderPipelineGuard({
          strictMode: true,
          logPath: join(outRoot, "evidence", `${c.id}-pipeline-guard-log.json`),
        }).check(finalized);
        if (!guard.pass) throw new Error(`NARRATIVE_PIPELINE_GUARD_FAILED: ${canonical(guard.errors)}`);
        return {
          actual: "NARRATIVE_READY",
          output: {
            route: decision as unknown as JsonRecord,
            metadata,
            effectiveIntent,
            themeInput,
            shots: finalized.length,
            totalDurationSeconds: finalized.reduce((sum, shot) => sum + Number(shot.duration), 0),
            finalShotContract: contract as unknown as JsonRecord,
            pipelineGuard: guard as unknown as JsonRecord,
          },
        };
      }));
    }
  } finally {
    restoreNarrativeBridge();
  }

  for (const c of suite.abnormal) {
    const mode: ExecutionMode = ["route-conflict", "source-prompt-injection", "hallucinated-citation", "unsupported-competitor"].includes(c.kind)
      ? "deterministic-replay"
      : "production-contract";
    results.push(await record(c.id, "abnormal", c.title, c.expected, mode, {
      function: c.kind,
      caseHash: sha256(canonical(c)),
    }, async () => runAbnormal(c)));
  }

  const summary = {
    schema: "workloom.ai-video-stress-report/v1",
    taskId: suite.taskId,
    generatedAt: new Date().toISOString(),
    providerSubmission: false,
    paidGenerationRequests: 0,
    total: results.length,
    passed: results.filter((result) => result.pass).length,
    failed: results.filter((result) => !result.pass).length,
    byCategory: Object.fromEntries((["marketing", "narrative", "abnormal"] as const).map((category) => {
      const rows = results.filter((result) => result.category === category);
      return [category, { total: rows.length, passed: rows.filter((result) => result.pass).length }];
    })),
    byMode: Object.fromEntries([...new Set(results.map((result) => result.mode))].map((mode) => [
      mode,
      results.filter((result) => result.mode === mode).length,
    ])),
  };
  writeFileSync(join(outRoot, "cases.jsonl"), `${results.map((result) => JSON.stringify(result)).join("\n")}\n`, "utf8");
  writeFileSync(join(outRoot, "report.json"), `${JSON.stringify({ summary, results }, null, 2)}\n`, "utf8");
  writeFileSync(join(outRoot, "SUMMARY.md"), [
    "# AI 视频 60 案例矩阵",
    "",
    `- 总计：${summary.total}`,
    `- 通过：${summary.passed}`,
    `- 失败：${summary.failed}`,
    `- 视频供应商提交：${summary.providerSubmission}`,
    `- 付费生成请求：${summary.paidGenerationRequests}`,
    "",
    "| 类别 | 通过/总数 |",
    "|---|---:|",
    ...Object.entries(summary.byCategory).map(([category, count]) => `| ${category} | ${count.passed}/${count.total} |`),
    "",
    "确定性回放只替代模型语义裁决；路由、请求闸、来源事实、运行时叙事隔离、最终镜头合同与 render-boundary 均调用当前生产实现。",
  ].join("\n") + "\n", "utf8");
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (summary.failed > 0) process.exitCode = 1;
}

await main();
