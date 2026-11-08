/** 营销宿主资格：原文抓取→逐主张核验→A1–A5装订→G1→完整提示词事实复核。vendor保持只读。 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { constants } from "node:fs";
import { mkdir, open, realpath, writeFile } from "node:fs/promises";
import { freezeMarketingCreativeRequirements, installVendorMarketingPriceBridge, installVendorMarketingReferenceBridge,
  MARKETING_CREATIVE_RESTRICTIONS, sourceBoundMarketingAssemblyRaw, verifyMarketingCreativeRequirements,
  verifiedMarketingDossierInput, reviewStage, normalizePromptFinding, type MarketingCreativeRequirements,
  type ProducerVerdict, type PromptFinding } from "@hyperreality/video-studio";
import { createDataMiningExecutor, type DataMiningStagePlan, type ExecutorLlm, type IntelStage, type SearchFn, type SearchHit } from "./data-mining-executor.js";
import { fetchMarketingSource, sourceUrl, type SourceSnapshot } from "./marketing-source-fetcher.js";
import { assertMarketingFactsFresh, validateStageFacts, revalidateStageFacts, type ValidatedStageFacts } from "./marketing-facts.js";
import { canonicalRenderJson, renderSha256 } from "./gen/compiled-request.js";
import { SubmissionError } from "./gen/submission-ledger.js";
import { extractAndReviewMarketingSources, isRepairableMarketingExtractionError, marketingExtractionValidationRecord, marketingFactsReceiptError,
  MARKETING_SOURCE_POLICY_VERSION, type MarketingSourceSupportAttempt } from "./marketing-source-support.js";
export { MARKETING_SOURCE_POLICY_VERSION } from "./marketing-source-support.js";

type RecordValue = Record<string, unknown>;
type MarketingStageId = "preproduction" | "prompt_review";
export interface MarketingScope { tenantId: string; workspaceId: string; projectId: string; runId: string; attempt: number }
interface ArchivedSource extends Omit<SourceSnapshot, "text"> { rawRef: string; textRef: string }
interface StageFactsReport {
  stage: IntelStage; facts: ValidatedStageFacts; sourceIds: string[];
  discovery: { queries: unknown[]; candidates: number; fetched: number; omittedCandidates: number; failures: Array<{ url: string; reason: string }> };
  review?: { ref: string; sha256: string; verdict: ProducerVerdict };
  supportAttempts?: MarketingSourceSupportAttempt[];
}
export interface MarketingShotFactReview {
  shotId: string; promptSha256: string; fieldsSha256: string; ref: string; sha256: string; verdict: ProducerVerdict;
  scope?: MarketingScope;
  verdictArchive?: { ref: string; sha256: string };
  /** A negative receipt carries the complete rejected bytes for diagnosed author repair. */
  rejectedShot?: { shotId: string; prompt: string; fields: unknown };
}
export interface MarketingFactReviewCache {
  load(key: string): Promise<MarketingShotFactReview | null>;
  save(key: string, review: MarketingShotFactReview): Promise<void>;
  loadRejected?(key: string): Promise<MarketingShotFactReview | null>;
  reject?(key: string, review: MarketingShotFactReview): Promise<void>;
}
export interface MarketingFactsBundle {
  schemaVersion: "workloom.marketing-facts/v1"; issuer: "workloom.marketing-authority"; scope: MarketingScope;
  /** Reused source reviews keep their original run and immutable archive paths. */
  sourceScope?: MarketingScope;
  collectedAt: string; policyVersion: typeof MARKETING_SOURCE_POLICY_VERSION; productQuery: RecordValue;
  sources: ArchivedSource[]; stages: StageFactsReport[]; rawByAgent: Record<IntelStage, RecordValue>;
  rawSha256: string; dossier: RecordValue; cards: RecordValue; dossierSha256: string;
  restrictions: string[]; creativeRequirements?: MarketingCreativeRequirements; g1ContentSha256: string; outputReviews: MarketingShotFactReview[];
}
export interface PreparedMarketingFacts {
  bundle: MarketingFactsBundle; g1Content: string; raw: Record<IntelStage, RecordValue>; storeRoot: string;
  root: string; prefix: string; stageId: MarketingStageId; specSourceUrls: Record<string, string>;
  sourceCheckpoint?: { ref: string; sha256: string };
}
interface DossierEngine {
  plan(input: RecordValue): { trace_id: string; plans: Record<IntelStage, DataMiningStagePlan> };
  assemble(trace: string, input: RecordValue, raw: Record<IntelStage, RecordValue>): {
    ok?: boolean; dossier?: RecordValue; cards?: RecordValue; chain?: { ok?: boolean }; errors?: unknown[];
  };
}
function fail(code: string, message: string): never { throw new SubmissionError(code, message); }
function object(value: unknown, name: string): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("MARKETING_FACTS_INVALID", `${name}不是有效对象`);
  return value as RecordValue;
}
function component(value: string): string {
  if (!value || value === "." || value === ".." || /[/\\\0]/.test(value)) fail("MARKETING_SCOPE_INVALID", "来源作用域标识非法");
  return value;
}
function marketingPrefix(stageId: MarketingStageId, attempt: number): string {
  if (stageId !== "preproduction" && stageId !== "prompt_review") fail("MARKETING_PATH_INVALID", "营销证据阶段非法");
  if (!Number.isInteger(attempt) || attempt < 1) fail("MARKETING_SCOPE_INVALID", "来源执行编号非法");
  return `stages/${stageId}/attempt-${attempt}.marketing`;
}
function accepted(verdict: ProducerVerdict | undefined, file: string, hash: string): boolean {
  return Boolean(verdict?.status === "passed" && verdict.approved === true && verdict.via === "llm" && verdict.degraded === false && verdict.unknownOutcome !== true
    && typeof verdict.score === "number" && Number.isFinite(verdict.score) && verdict.score >= 85 && verdict.score <= 100
    && verdict.model && verdict.evidence?.some(item => item.path === file && item.sha256 === hash && item.scope === "complete-text"));
}
function rejected(verdict: ProducerVerdict | undefined, file: string, hash: string): boolean {
  return Boolean(verdict?.status === "failed" && verdict.approved === false && verdict.via === "llm" && verdict.degraded === false
    && verdict.unknownOutcome !== true && verdict.model && typeof verdict.score === "number" && Number.isFinite(verdict.score)
    && verdict.score >= 0 && verdict.score <= 100
    && verdict.evidence?.some(item => item.path === file && item.sha256 === hash && item.scope === "complete-text"));
}
async function writeBound(root: string, ref: string, bytes: string | Buffer): Promise<{ ref: string; path: string; sha256: string }> {
  const file = path.resolve(root, ref);
  if (!file.startsWith(`${root}${path.sep}`) || ref.split(/[\\/]/).some(part => part === "..")) fail("MARKETING_PATH_INVALID", "来源证据必须留在本次项目档案");
  await mkdir(path.dirname(file), { recursive: true });
  if (await realpath(path.dirname(file)) !== path.dirname(file)) fail("MARKETING_PATH_INVALID", "来源目录经过符号链接");
  await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
  return { ref, path: file, sha256: renderSha256(bytes) };
}
async function readBound(root: string, ref: string, hash: string): Promise<Buffer> {
  const file = path.resolve(root, ref);
  if (!/^[a-f0-9]{64}$/.test(hash) || !ref || path.isAbsolute(ref) || ref.split(/[\\/]/).some(part => part === ".." || part === ".")
    || !file.startsWith(`${root}${path.sep}`) || await realpath(file) !== file) fail("MARKETING_PATH_INVALID", "来源证据路径或摘要非法");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !stat.size || stat.size > 2 * 1024 * 1024) fail("MARKETING_FACTS_INVALID", "来源证据为空或过大");
    const bytes = await handle.readFile();
    if (renderSha256(bytes) !== hash) fail("MARKETING_FACTS_CHANGED", "来源正文或事实评审字节已变化");
    return bytes;
  } finally { await handle.close(); }
}
function productInput(metadata: RecordValue): RecordValue {
  const source = metadata.dataMining && typeof metadata.dataMining === "object" ? object(metadata.dataMining, "商品线索") : {};
  const brief = metadata.brief && typeof metadata.brief === "object" ? object(metadata.brief, "Brief") : {};
  const brand = brief.brand && typeof brief.brand === "object" ? object(brief.brand, "品牌").name : brief.brand;
  const input: RecordValue = {};
  for (const [key, value] of Object.entries({ name: source.name ?? brief.product, brand: source.brand ?? brand, category: source.category ?? brief.category, model: source.model })) {
    if (typeof value === "string" && value.trim()) input[key] = value.trim();
  }
  if (!input.name) fail("MARKETING_PRODUCT_REQUIRED", "营销预生产需要明确商品名，不能把自由文本猜成已核实商品事实");
  return input;
}
function engine(storeRoot: string): DossierEngine {
  const entry = fileURLToPath(new URL("../../../../vendor/supermickey/hyperreality-system/engines/data-mining-engine/index.js", import.meta.url));
  const module = createRequire(import.meta.url)(entry) as { JennyLoomEngine: new (options: RecordValue) => DossierEngine };
  return new module.JennyLoomEngine({ mode: "api", storeRoot });
}
export async function prepareMarketingFacts(input: {
  scope: MarketingScope; root: string; metadata: RecordValue; intent: string; llm: ExecutorLlm; env?: NodeJS.ProcessEnv;
  stageId?: MarketingStageId;
  dependencies?: {
    search?: SearchFn;
    /** 复用 CLI 预置的真实检索缓存；A1 有命中时其它查询不会继续轰击线上引擎。 */
    searchCacheFile?: string;
    fetchSource?: typeof fetchMarketingSource;
    review?: typeof reviewStage;
    log?: (line: string) => void;
  };
}): Promise<PreparedMarketingFacts> {
  const env = input.env ?? process.env;
  if (env.VM_DATA_MINING === "0" || env.VM_DATA_MINING_MODE === "spec") fail("MARKETING_SOURCE_REQUIRED", "正式营销不支持跳过来源采集或用任务书代替事实证据");
  const scope = { ...input.scope }; Object.values({ ...scope, attempt: String(scope.attempt) }).forEach(component);
  const stageId = input.stageId ?? "preproduction";
  const root = await realpath(input.root), prefix = marketingPrefix(stageId, scope.attempt);
  const storeRoot = path.join(root, `${prefix}-dossier`), product = productInput(input.metadata), collector = engine(storeRoot);
  const plan = collector.plan(product);
  const reports: StageFactsReport[] = [], sources: ArchivedSource[] = [];
  const cache = new Map<string, SourceSnapshot>();
  const sourceFetch = input.dependencies?.fetchSource ?? fetchMarketingSource;
  const review = input.dependencies?.review ?? reviewStage;
  const executor = createDataMiningExecutor({
    llm: input.llm,
    search: input.dependencies?.search,
    searchCacheFile: input.dependencies?.searchCacheFile,
    log: input.dependencies?.log,
    evidenceCollector: async (stage, stagePlan, hits: SearchHit[]) => {
      const pages: SourceSnapshot[] = [], failures: Array<{ url: string; reason: string }> = [];
      const candidates = [...new Map(hits.map(hit => [hit.url, hit])).values()]; let attempted = 0;
      for (const hit of candidates.slice(0, 6)) {
        if (pages.length === 3) break;
        attempted++;
        let cacheKey: string;
        try { cacheKey = sourceUrl(hit.url).href; }
        catch (error) { failures.push({ url: hit.url, reason: error instanceof Error ? error.message : String(error) }); continue; }
        let snapshot = cache.get(cacheKey);
        if (!snapshot) {
          let result: Awaited<ReturnType<typeof fetchMarketingSource>>;
          try { result = await sourceFetch(cacheKey); }
          catch (error) { failures.push({ url: hit.url, reason: error instanceof Error ? error.message : String(error) }); continue; }
          snapshot = result.snapshot;
          // 网络不可用可换候选；证据写盘失败必须终止，不能伪装成来源不可用继续。
          if (!sources.some(source => source.sourceId === snapshot!.sourceId)) {
            const raw = await writeBound(root, `${prefix}-sources/${snapshot.sourceId}.raw`, result.rawBytes);
            const text = await writeBound(root, `${prefix}-sources/${snapshot.sourceId}.txt`, snapshot.text);
            const { text: _text, ...stored } = snapshot;
            sources.push({ ...stored, rawRef: raw.ref, textRef: text.ref });
          }
          cache.set(cacheKey, snapshot);
        }
        if (!pages.some(page => page.sourceId === snapshot!.sourceId)) pages.push(snapshot);
      }
      const discovery = { queries: stagePlan.queries ?? stagePlan.discovery_queries ?? [], candidates: candidates.length,
        fetched: pages.length, omittedCandidates: Math.max(0, candidates.length - attempted), failures };
      if (!pages.length) {
        if (stage === "A1") fail("MARKETING_A1_UNVERIFIED", "商品身份/规格没有任何可抓取核实的来源正文");
        const payload = stage === "A2" ? { reviews: [] } : { competitors: [] };
        const facts = validateStageFacts(stage, { payload, citations: [], noEvidenceReason: "本次未取得可核实正文；不能生产用户口碑、评分、对比或竞品主张" }, []);
        reports.push({ stage, facts, sourceIds: [], discovery }); return facts.payload;
      }
      const support = await extractAndReviewMarketingSources({ scope, stage, productQuery: product, plan: stagePlan,
        sources: pages, llm: input.llm, env, review, log: input.dependencies?.log,
        writeArtifact: (suffix, bytes) => writeBound(root, `${prefix}-${stage}${suffix}`, bytes),
        verifyArtifact: artifact => readBound(root, artifact.ref, artifact.sha256),
      });
      reports.push({ stage, ...support, sourceIds: pages.map(page => page.sourceId), discovery });
      return support.facts.payload;
    } });
  const raw = {} as Record<IntelStage, RecordValue>;
  for (const stage of ["A1", "A2", "A3"] as const) {
    const payload = await executor(stage, plan.plans[stage]);
    if (!payload) fail("MARKETING_STAGE_UNVERIFIED", `${stage}没有受控事实回填`);
    raw[stage] = payload;
  }
  /**
   * Vendor 的 distill 只给对象形态的 spec 登记来源。宿主逐条审核得到的
   * claims 已经绑定到原文；装订时把这些来源附着到临时副本，避免档案把
   * 已审规格误报成“无来源”。rawByAgent 仍保留原始提取形状，审计哈希不漂移。
   */
  const specSourceUrls: Record<string, string> = Object.create(null);
  const a1Facts = reports.find((report) => report.stage === "A1")?.facts;
  if (a1Facts && raw.A1?.identity && typeof raw.A1.identity === "object") {
    const identity = raw.A1.identity as RecordValue;
    const specs = identity.specs && typeof identity.specs === "object" && !Array.isArray(identity.specs)
      ? identity.specs as RecordValue
      : {};
    for (const key of Object.keys(specs)) {
      const pointer = `/identity/specs/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
      const claim = a1Facts.claims.find((item) => item.pointer === pointer);
      const source = claim ? sources.find((item) => item.sourceId === claim.sourceId) : undefined;
      if (source) specSourceUrls[key] = source.requestedUrl;
    }
  }
  const assemblyRaw = sourceBoundMarketingAssemblyRaw(raw, specSourceUrls) as Record<IntelStage, RecordValue>;
  const restoreReferenceBridge = installVendorMarketingReferenceBridge();
  let assembled: ReturnType<DossierEngine["assemble"]>;
  try {
    const restorePriceBridge = installVendorMarketingPriceBridge();
    try { assembled = collector.assemble(plan.trace_id, verifiedMarketingDossierInput(raw), assemblyRaw); }
    finally { restorePriceBridge(); }
  } finally { restoreReferenceBridge(); }
  if (assembled.ok !== true || assembled.chain?.ok !== true || !assembled.dossier || !assembled.cards) fail("MARKETING_DOSSIER_UNVERIFIED", "情报五站未完成有效档案装订");
  const restrictions: string[] = reports.filter(report => report.facts.status === "no_evidence").map(report => report.stage === "A2"
    ? "没有可核实用户评价：禁止用户口碑、评分、人数、销量或使用效果共识主张" : "没有可核实竞品证据：禁止对比、竞品弱点或市场领先主张");
  const approvedIdentity = raw.A1.identity as { prices?: unknown[] };
  if (!approvedIdentity.prices?.length) restrictions.push("没有可采纳的当前价格证据：禁止报价、优惠、价格比较或性价比数字主张；不得从未采纳的来源价格或用户期望补回。");
  const creativeRequirements = freezeMarketingCreativeRequirements(input.intent);
  const bundle: MarketingFactsBundle = { schemaVersion: "workloom.marketing-facts/v1", issuer: "workloom.marketing-authority", scope,
    collectedAt: new Date().toISOString(), policyVersion: MARKETING_SOURCE_POLICY_VERSION, productQuery: product, sources, stages: reports, rawByAgent: raw,
    rawSha256: renderSha256(canonicalRenderJson(raw)), dossier: assembled.dossier, cards: assembled.cards,
    dossierSha256: renderSha256(canonicalRenderJson(assembled.dossier)), creativeRequirements,
    restrictions: [...restrictions,
      "source-bound仅表示已核对主张与来源正文的支持关系；保留媒体报道与真实来源归属，没有对应的一手或实测依据时，不得宣称官方确认、独立交叉验证、认证或实测。已排除的冲突、绝对化或其他型号主张禁止在下游恢复。",
      ...MARKETING_CREATIVE_RESTRICTIONS], g1ContentSha256: "", outputReviews: [] };
  const g1Content = canonicalRenderJson({ facts: bundle, requestedIntent: input.intent, requestedMetadata: input.metadata,
    instruction: "商品事实只能来自已核实claims。creativeRequirements.intent 保留客户创作、披露与尾帧原文，作为后续执行合同；审核其与事实分区及restrictions是否明确，具体落实留给后续创作和镜头审核。" });
  bundle.g1ContentSha256 = renderSha256(g1Content);
  return { bundle, g1Content, raw: structuredClone(raw), storeRoot, root, prefix, stageId, specSourceUrls };
}

function shotFactReviewEvidence(bundle: MarketingFactsBundle, shot: { shotId: string; prompt: string; fields: unknown }, scope = bundle.scope): RecordValue {
  return { scope, sourcePolicyVersion: bundle.policyVersion, sourceClaims: bundle.stages.map(stage => stage.facts), restrictions: bundle.restrictions,
    ...(bundle.creativeRequirements ? { creativeRequirements: bundle.creativeRequirements } : {}), shot };
}

export function marketingFactReviewCacheKey(bundle: MarketingFactsBundle, shot: { shotId: string; prompt: string; fields: unknown }): string {
  const { scope: _currentScope, ...reviewInput } = shotFactReviewEvidence(bundle, shot);
  return `FACT_${renderSha256(canonicalRenderJson({ policy: "marketing-shot-facts/v2", ...reviewInput }))}`;
}

export async function checkpointMarketingFacts(prepared: PreparedMarketingFacts): Promise<PreparedMarketingFacts> {
  const saved = await writeBound(prepared.root, `${prepared.prefix}-prepared-source.json`, canonicalRenderJson(prepared.bundle));
  return { ...prepared, sourceCheckpoint: { ref: saved.ref, sha256: saved.sha256 } };
}

/** Preserve the exact reviewed sources while binding subsequent shot reviews to the new run. */
export async function restoreMarketingFacts(prepared: PreparedMarketingFacts, input: {
  root: string; scope: MarketingScope; intent: string; stageId: MarketingStageId;
}): Promise<PreparedMarketingFacts> {
  const sourceScope = prepared.bundle.sourceScope ?? prepared.bundle.scope;
  if (prepared.root !== input.root || prepared.stageId !== input.stageId || !prepared.sourceCheckpoint
    || sourceScope.tenantId !== input.scope.tenantId || sourceScope.workspaceId !== input.scope.workspaceId
    || sourceScope.projectId !== input.scope.projectId || sourceScope.attempt >= input.scope.attempt
    || prepared.bundle.creativeRequirements?.intentSha256 !== renderSha256(input.intent)
    || renderSha256(prepared.g1Content) !== prepared.bundle.g1ContentSha256) {
    fail("MARKETING_CHECKPOINT_UNBOUND", "来源断点与同一项目原需求及原审核正文不一致");
  }
  const source = await verifyMarketingFacts({ root: input.root, ...prepared.sourceCheckpoint, scope: sourceScope,
    stageId: input.stageId, intentSha256: renderSha256(input.intent), shots: [], sourcesOnly: true });
  const sourceFields = (bundle: MarketingFactsBundle) => ({ ...bundle, scope: sourceScope, sourceScope: undefined, outputReviews: [] });
  if (canonicalRenderJson(sourceFields(source)) !== canonicalRenderJson(sourceFields(prepared.bundle))) {
    fail("MARKETING_CHECKPOINT_CHANGED", "来源断点与原始来源事实文件不一致");
  }
  const prefix = marketingPrefix(input.stageId, input.scope.attempt);
  return { ...structuredClone(prepared), prefix, storeRoot: path.join(input.root, `${prefix}-dossier`),
    bundle: { ...structuredClone(source), scope: input.scope, sourceScope, outputReviews: [] } };
}

export interface MarketingFactReviewBatch {
  pass: boolean;
  reviews: MarketingShotFactReview[];
  findings: PromptFinding[];
  verdicts: ProducerVerdict[];
  rejectedShotIds: string[];
  reasons: string[];
}

async function reviewMarketingShot(input: {
  prepared: PreparedMarketingFacts;
  shot: { shotId: string; prompt: string; fields: unknown };
  index: number;
  env: NodeJS.ProcessEnv;
  cache?: MarketingFactReviewCache;
  beforeRequest?: () => void;
}): Promise<
  | { accepted: true; review: MarketingShotFactReview }
  | { accepted: false; reason: string; findings: PromptFinding[]; verdict: ProducerVerdict }
> {
  const { prepared, shot, index, env, cache, beforeRequest } = input;
  const evidenceBody = shotFactReviewEvidence(prepared.bundle, shot);
  const cacheKey = marketingFactReviewCacheKey(prepared.bundle, shot);
  const knownRejection = await cache?.loadRejected?.(cacheKey);
  if (knownRejection) {
    await verifyRejectedMarketingFactReview(prepared, shot, knownRejection);
    try { await cache?.reject?.(cacheKey, knownRejection); }
    catch (error) { throw marketingFactsReceiptError("原镜头语义拒绝的接续回执保存失败，保留原审核后对账", error); }
    return {
      accepted: false,
      reason: `同一镜头内容已有完整事实拒绝，须先由作者修复，禁止重复评审：${knownRejection.verdict.reason}`,
      findings: verdictFindings(knownRejection.verdict, shot.shotId),
      verdict: knownRejection.verdict,
    };
  }
  const cached = await cache?.load(cacheKey);
  if (cached) {
    await verifyShotFactReview(prepared, shot, cached);
    try { await cache!.save(cacheKey, cached); }
    catch (error) { throw marketingFactsReceiptError("原镜头通过审核的接续回执保存失败，保留原审核后对账", error); }
    return { accepted: true, review: cached };
  }
  const evidence = await writeBound(prepared.root, `${prepared.prefix}-shot-${index + 1}.review.json`, canonicalRenderJson(
    evidenceBody));
  const verdict = await reviewStage({ stage: "prompt", projectId: prepared.bundle.scope.projectId, env,
    ...(beforeRequest ? { beforeRequest } : {}),
    artifacts: [{ path: evidence.path, kind: "json", note: "完整最终镜头与逐主张事实证据；禁止无证据营销声明" }],
    deterministic: [{ id: "marketing-current-facts", pass: true, hard: true, detail: "本次G1事实包与完整最终镜头同scope/run/attempt" }],
    requiredCheckIds: ["marketing-current-facts"], minScore: 85,
    rubric: ["逐句核对shot.prompt与全部结构fields中的商品事实、数字、价格、效果、评价和竞品主张，仅sourceClaims可作为事实依据",
      "必须遵守restrictions；不得把用户意图、推断、生成情节、广告愿望、缺证据或无冲突当成事实支持；任一未支持或夸大主张必须拒绝",
      "创意可使用虚构情节和角色设定，但不得暗示真实战绩、无来源的商品性能、认证或真实人物背书",
      "creativeRequirements 是本片原始创作与交付合同。核对当前镜头承担的角色、画面文字、披露或尾帧要求；全片、其他镜头或后期才承担的内容不要求在每个镜头重复",
      "若拒绝，findings 必须绑定当前 shotId，至少指出 prompt 或 structure fields 中的准确问题。"],
    context: { purpose: "marketing-final-fact-review", shotId: shot.shotId, scope: prepared.bundle.scope },
  });
  let verdictArchive: { ref: string; sha256: string };
  try {
    verdictArchive = await writeBound(prepared.root, `${prepared.prefix}-shot-${index + 1}.verdict.json`, canonicalRenderJson(verdict));
  } catch (error) { throw marketingFactsReceiptError("镜头事实审核已返回，但完整裁决归档未完成，保留原请求先对账", error, verdict.unknownOutcome === true); }
  if (verdict.unknownOutcome) fail("VIDEO_MODEL_OUTCOME_UNKNOWN", "镜头事实评审的供应商回执待核实，保留原请求");
  const reviewed: MarketingShotFactReview = { shotId: shot.shotId, promptSha256: renderSha256(shot.prompt), fieldsSha256: renderSha256(canonicalRenderJson(shot.fields)),
    ref: evidence.ref, sha256: evidence.sha256, verdict, scope: prepared.bundle.scope,
    verdictArchive: { ref: verdictArchive.ref, sha256: verdictArchive.sha256 } };
  if (rejected(verdict, evidence.path, evidence.sha256)) {
    reviewed.rejectedShot = structuredClone(shot);
    await verifyRejectedMarketingFactReview(prepared, shot, reviewed);
    try { await cache?.reject?.(cacheKey, reviewed); }
    catch (error) { throw marketingFactsReceiptError("镜头语义拒绝已核实，但负回执保存未完成，保留原审核先对账", error); }
    return {
      accepted: false,
      reason: `营销镜头事实未通过，须按原裁决修复作者内容：${verdict.reason}`,
      findings: verdictFindings(verdict, shot.shotId),
      verdict,
    };
  }
  if (!accepted(verdict, evidence.path, evidence.sha256)) {
    return {
      accepted: false,
      reason: `营销镜头事实未通过：${verdict.reason}`,
      findings: verdictFindings(verdict, shot.shotId),
      verdict,
    };
  }
  try { await cache?.save(cacheKey, reviewed); }
  catch (error) { throw marketingFactsReceiptError("镜头事实审核已通过，但接续回执保存未完成，保留原审核先对账", error); }
  return { accepted: true, review: reviewed };
}

function verdictFindings(verdict: ProducerVerdict, shotId: string): PromptFinding[] {
  const findings = verdict.findings?.filter(item => item.severity === "blocking" || item.severity === "major") ?? [];
  if (findings.length > 0) {
    return findings.map(item => ({
      ...item,
      shotId: item.shotId ?? shotId,
      severity: "blocking",
      repairClass: "evidence",
    }));
  }
  const derived = verdict.issues.flatMap((issue, index) => {
    const finding = normalizePromptFinding({
      code: "MARKETING_FACT_REJECTED",
      severity: "blocking",
      shotId,
      issue,
      suggestion: verdict.suggestions[index] ?? verdict.suggestions[0] ?? null,
      repairClass: "evidence",
    }, index);
    return finding ? [finding] : [];
  });
  if (derived.length) return derived;
  const fallback = normalizePromptFinding({
    code: "MARKETING_FACT_REJECTED",
    severity: "blocking",
    shotId,
    issue: verdict.reason,
    suggestion: verdict.suggestions[0] ?? null,
    repairClass: "evidence",
  });
  return fallback ? [fallback] : [];
}

export async function preflightMarketingFacts(
  prepared: PreparedMarketingFacts,
  shots: Array<{ shotId: string; prompt: string; fields: unknown }>,
  env: NodeJS.ProcessEnv = process.env,
  cache?: MarketingFactReviewCache,
  beforeRequest?: () => void,
): Promise<MarketingFactReviewBatch> {
  if (!shots.length || new Set(shots.map(shot => shot.shotId)).size !== shots.length) fail("MARKETING_PROMPTS_INVALID", "营销镜头为空或镜头标识重复");
  const reviews: MarketingShotFactReview[] = [];
  const findings: PromptFinding[] = [];
  const verdicts: ProducerVerdict[] = [];
  const rejectedShotIds: string[] = [];
  const reasons: string[] = [];
  for (const [index, item] of shots.entries()) {
    const shot = { shotId: item.shotId, prompt: item.prompt, fields: item.fields };
    if (!shot.prompt.trim()) fail("MARKETING_PROMPTS_INVALID", "营销镜头正文为空");
    const reviewed = await reviewMarketingShot({ prepared, shot, index, env, cache, beforeRequest });
    if (reviewed.accepted) reviews.push(reviewed.review);
    else {
      findings.push(...reviewed.findings);
      verdicts.push(reviewed.verdict);
      rejectedShotIds.push(shot.shotId);
      reasons.push(reviewed.reason);
    }
  }
  return { pass: rejectedShotIds.length === 0, reviews, findings, verdicts, rejectedShotIds, reasons };
}

export async function finalizeMarketingFacts(prepared: PreparedMarketingFacts, shots: Array<{ shotId: string; prompt: string; fields: unknown }>, env: NodeJS.ProcessEnv = process.env,
  cache?: MarketingFactReviewCache, preReviewed?: MarketingFactReviewBatch, beforeRequest?: () => void): Promise<{ ref: string; sha256: string }> {
  const batch = preReviewed ?? await preflightMarketingFacts(prepared, shots, env, cache, beforeRequest);
  if (preReviewed && (preReviewed.pass === false || preReviewed.reviews.length !== shots.length)) {
    fail("MARKETING_PROMPT_FACTS_REJECTED", preReviewed.reasons.join("；") || "预审回执与当前镜头不一致");
  }
  if (!batch.pass) {
    fail("MARKETING_PROMPT_FACTS_REJECTED", batch.reasons.join("；"));
  }
  prepared.bundle.outputReviews = structuredClone(batch.reviews);
  const saved = await writeBound(prepared.root, `${prepared.prefix}-facts.json`, canonicalRenderJson(prepared.bundle));
  await verifyMarketingFacts({ root: prepared.root, ref: saved.ref, sha256: saved.sha256, scope: prepared.bundle.scope,
    stageId: prepared.stageId, shots });
  return { ref: saved.ref, sha256: saved.sha256 };
}

async function verifyShotFactReview(prepared: Pick<PreparedMarketingFacts, "bundle" | "root" | "stageId">,
  shot: { shotId: string; prompt: string; fields: unknown }, review: MarketingShotFactReview, negative = false): Promise<void> {
  const scope = review.scope ?? prepared.bundle.scope;
  const current = prepared.bundle.scope;
  if (scope.tenantId !== current.tenantId || scope.workspaceId !== current.workspaceId || scope.projectId !== current.projectId
    || !Number.isSafeInteger(scope.attempt) || scope.attempt < 1 || scope.attempt > current.attempt
    || scope.attempt === current.attempt && scope.runId !== current.runId
    || review.shotId !== shot.shotId || review.promptSha256 !== renderSha256(shot.prompt)
    || review.fieldsSha256 !== renderSha256(canonicalRenderJson(shot.fields))
    || !review.ref.startsWith(`${marketingPrefix(prepared.stageId, scope.attempt)}-shot-`)
    || !(negative ? rejected : accepted)(review.verdict, path.join(prepared.root, review.ref), review.sha256)
    || negative && (!review.scope || !review.rejectedShot || !review.verdictArchive
      || canonicalRenderJson(review.rejectedShot) !== canonicalRenderJson(shot))) {
    fail("MARKETING_PROMPTS_UNVERIFIED", "营销镜头不是同一项目已核实的完整最终内容");
  }
  const bytes = await readBound(prepared.root, review.ref, review.sha256);
  if (bytes.toString("utf8") !== canonicalRenderJson(shotFactReviewEvidence(prepared.bundle, shot, scope))) {
    fail("MARKETING_PROMPTS_UNBOUND", "最终镜头审核未绑定当前完整镜头和事实用途限制");
  }
  if (review.verdictArchive) {
    if (!review.ref.endsWith(".review.json") || review.verdictArchive.ref !== review.ref.replace(/\.review\.json$/u, ".verdict.json")) {
      fail("MARKETING_PROMPTS_UNBOUND", "镜头审核裁决文件不属于原始完整证据");
    }
    const verdict = await readBound(prepared.root, review.verdictArchive.ref, review.verdictArchive.sha256);
    if (verdict.toString("utf8") !== canonicalRenderJson(review.verdict)) fail("MARKETING_PROMPTS_UNBOUND", "镜头审核裁决与原始回执不一致");
  }
}

export async function verifyRejectedMarketingFactReview(prepared: Pick<PreparedMarketingFacts, "bundle" | "root" | "stageId">,
  shot: { shotId: string; prompt: string; fields: unknown }, review: MarketingShotFactReview): Promise<void> {
  await verifyShotFactReview(prepared, shot, review, true);
}

export async function verifyMarketingFacts(input: {
  root: string; ref: string; sha256: string; scope: MarketingScope;
  stageId?: MarketingStageId; intentSha256?: string;
  sourcesOnly?: boolean;
  shots: Array<{ shotId: string; prompt: string; fields: unknown }>;
}): Promise<MarketingFactsBundle> {
  const expectedPrefix = marketingPrefix(input.stageId ?? "preproduction", input.scope.attempt);
  if (input.ref !== `${expectedPrefix}-${input.sourcesOnly ? "prepared-source" : "facts"}.json`) fail("MARKETING_PATH_INVALID", "营销事实包不是当前执行产物");
  const bundle = JSON.parse((await readBound(input.root, input.ref, input.sha256)).toString("utf8")) as MarketingFactsBundle;
  if (bundle.schemaVersion !== "workloom.marketing-facts/v1" || bundle.issuer !== "workloom.marketing-authority" || bundle.policyVersion !== MARKETING_SOURCE_POLICY_VERSION
    || canonicalRenderJson(bundle.scope) !== canonicalRenderJson(input.scope) || !Array.isArray(bundle.sources) || !Array.isArray(bundle.stages)
    || !Array.isArray(bundle.outputReviews) || !/^[a-f0-9]{64}$/.test(bundle.g1ContentSha256)) fail("MARKETING_FACTS_INVALID", "营销事实包身份或结构无效");
  if ((input.intentSha256 !== undefined || bundle.creativeRequirements !== undefined)
    && (!verifyMarketingCreativeRequirements(bundle.creativeRequirements)
      || input.intentSha256 !== undefined && bundle.creativeRequirements.intentSha256 !== input.intentSha256)) {
    fail("MARKETING_CREATIVE_REQUIREMENTS_UNBOUND", "创作与交付原文不属于当前营销工作单");
  }
  assertMarketingFactsFresh(bundle.collectedAt);
  const sourceScope = bundle.sourceScope ?? input.scope;
  if (sourceScope.tenantId !== input.scope.tenantId || sourceScope.workspaceId !== input.scope.workspaceId
    || sourceScope.projectId !== input.scope.projectId || !Number.isSafeInteger(sourceScope.attempt)
    || sourceScope.attempt < 1 || sourceScope.attempt > input.scope.attempt
    || (bundle.sourceScope && sourceScope.attempt >= input.scope.attempt)) fail("MARKETING_SCOPE_INVALID", "来源复用必须保留同一项目更早执行的原身份");
  const sourcePrefix = marketingPrefix(input.stageId ?? "preproduction", sourceScope.attempt);
  const pages: SourceSnapshot[] = [];
  if (new Set(bundle.sources.map(source => source.sourceId)).size !== bundle.sources.length) fail("MARKETING_SOURCE_INVALID", "营销来源ID重复");
  for (const source of bundle.sources) {
    if (!source.rawRef.startsWith(`${sourcePrefix}-sources/`) || !source.textRef.startsWith(`${sourcePrefix}-sources/`)) fail("MARKETING_PATH_INVALID", "营销来源不是已绑定的原来源目录");
    await readBound(input.root, source.rawRef, source.rawSha256);
    const text = (await readBound(input.root, source.textRef, source.textSha256)).toString("utf8");
    const { rawRef: _rawRef, textRef: _textRef, ...snapshot } = source;
    pages.push({ ...snapshot, text });
  }
  for (const stage of ["A1", "A2", "A3"] as const) {
    const records = bundle.stages.filter(record => record.stage === stage), record = records[0];
    if (records.length !== 1 || !record || record.facts.stage !== stage) fail("MARKETING_STAGE_UNVERIFIED", `当前营销事实缺少${stage}实际执行记录`);
    const used = record.sourceIds.map(id => pages.find(source => source.sourceId === id)).filter((source): source is SourceSnapshot => Boolean(source));
    if (used.length !== record.sourceIds.length || new Set(record.sourceIds).size !== record.sourceIds.length) fail("MARKETING_SOURCE_INVALID", "营销来源记录缺失或重复");
    revalidateStageFacts(record.facts, used);
    if (record.facts.claims.length > 0 || record.review) {
      if (!record.review || !record.review.ref.startsWith(sourcePrefix) || !accepted(record.review.verdict, path.join(input.root, record.review.ref), record.review.sha256)) fail("MARKETING_SUPPORT_UNVERIFIED", "缺少真实原文支持关系审核");
      const reviewBytes = await readBound(input.root, record.review.ref, record.review.sha256);
      const expectedReview = canonicalRenderJson({ scope: sourceScope, productQuery: bundle.productQuery, facts: record.facts, sources: used });
      if (reviewBytes.toString("utf8") !== expectedReview) fail("MARKETING_SUPPORT_UNBOUND", "支持关系审核未绑定当前完整主张与来源正文");
      const attempts = record.supportAttempts;
      if (!Array.isArray(attempts) || attempts.length < 1 || attempts.length > 2) fail("MARKETING_SUPPORT_UNVERIFIED", "来源提取和审核历史不完整");
      if (attempts.filter(attempt => attempt.structureRepair).length > 1) fail("MARKETING_SUPPORT_UNBOUND", "来源结构修复次数与合同不符");
      for (const [index, attempt] of attempts.entries()) {
        const attemptPrefix = `${sourcePrefix}-${stage}${index ? ".repair-1" : ""}`;
        if (attempt.extraction.ref !== `${attemptPrefix}${attempt.structureRepair ? ".structure-1" : ""}.extraction.json` || attempt.evidence.ref !== `${attemptPrefix}.review.json`
          || attempt.verdict.ref !== `${attemptPrefix}.verdict.json`) fail("MARKETING_SUPPORT_UNBOUND", "来源修复历史不属于原执行");
        if (attempt.structureRepair) {
          const history = attempt.structureRepair;
          if (history.rejectedExtraction.ref !== `${attemptPrefix}.extraction.json` || history.validation.ref !== `${attemptPrefix}.validation.json`
            || history.request.ref !== `${attemptPrefix}.structure-1.input.json`) fail("MARKETING_SUPPORT_UNBOUND", "来源结构修复未绑定原始失败产物");
          const invalidRaw = JSON.parse((await readBound(input.root, history.rejectedExtraction.ref, history.rejectedExtraction.sha256)).toString("utf8"));
          let validationError: unknown;
          try { validateStageFacts(stage, invalidRaw, used); }
          catch (error) { validationError = error; }
          if (!isRepairableMarketingExtractionError(validationError)) fail("MARKETING_SUPPORT_UNBOUND", "来源结构修复没有可复现的作者合同错误");
          const expectedValidation = marketingExtractionValidationRecord({ scope: sourceScope, stage, productQuery: bundle.productQuery,
            sources: used, extraction: history.rejectedExtraction, error: validationError });
          const validation = await readBound(input.root, history.validation.ref, history.validation.sha256);
          if (validation.toString("utf8") !== canonicalRenderJson(expectedValidation)) fail("MARKETING_SUPPORT_UNBOUND", "来源结构修复诊断与原始失败不一致");
          const request = JSON.parse((await readBound(input.root, history.request.ref, history.request.sha256)).toString("utf8"));
          const { prompt, input: repairInput, ...binding } = request;
          if (canonicalRenderJson(binding) !== canonicalRenderJson({ policyVersion: MARKETING_SOURCE_POLICY_VERSION,
            scope: sourceScope, stage, productQuery: bundle.productQuery, sourcesSha256: expectedValidation.sourcesSha256,
            rejectedExtraction: history.rejectedExtraction, validation: history.validation })
            || canonicalRenderJson(repairInput?.sources) !== canonicalRenderJson(used)
            || canonicalRenderJson(repairInput?.invalidExtraction) !== canonicalRenderJson(invalidRaw)
            || canonicalRenderJson(repairInput?.validationError) !== canonicalRenderJson(expectedValidation.error)
            || typeof prompt !== "string" || !prompt.endsWith(canonicalRenderJson(repairInput))) {
            fail("MARKETING_SUPPORT_UNBOUND", "来源结构修复请求未绑定相同完整来源和实际错误");
          }
        }
        const extraction = JSON.parse((await readBound(input.root, attempt.extraction.ref, attempt.extraction.sha256)).toString("utf8"));
        const facts = validateStageFacts(stage, extraction, used);
        const evidence = await readBound(input.root, attempt.evidence.ref, attempt.evidence.sha256);
        if (evidence.toString("utf8") !== canonicalRenderJson({ scope: sourceScope, productQuery: bundle.productQuery, facts, sources: used })) {
          fail("MARKETING_SUPPORT_UNBOUND", "来源修复历史与完整原文不一致");
        }
        const verdict = JSON.parse((await readBound(input.root, attempt.verdict.ref, attempt.verdict.sha256)).toString("utf8")) as ProducerVerdict;
        if (index === attempts.length - 1) {
          if (attempt.evidence.ref !== record.review.ref || attempt.evidence.sha256 !== record.review.sha256
            || canonicalRenderJson(verdict) !== canonicalRenderJson(record.review.verdict)) fail("MARKETING_SUPPORT_UNBOUND", "最终来源审核未绑定修复历史");
        } else if (verdict.status !== "failed" || verdict.approved !== false || verdict.via !== "llm" || verdict.degraded !== false
          || verdict.unknownOutcome || !verdict.model || typeof verdict.score !== "number" || !Number.isFinite(verdict.score)
          || verdict.score < 0 || verdict.score > 100
          || !verdict.evidence?.some(item => item.path === path.join(input.root, attempt.evidence.ref)
            && item.sha256 === attempt.evidence.sha256 && item.scope === "complete-text")) {
          fail("MARKETING_SUPPORT_UNBOUND", "来源修复缺少原始完整语义拒绝");
        }
      }
    }
    if (canonicalRenderJson(record.facts.payload) !== canonicalRenderJson(bundle.rawByAgent[stage])) fail("MARKETING_FACTS_CHANGED", "下游回填与已审核事实不一致");
  }
  if (renderSha256(canonicalRenderJson(bundle.rawByAgent)) !== bundle.rawSha256 || renderSha256(canonicalRenderJson(bundle.dossier)) !== bundle.dossierSha256) fail("MARKETING_FACTS_CHANGED", "营销原始回填或档案摘要不一致");
  if (bundle.outputReviews.length !== input.shots.length) fail("MARKETING_PROMPTS_UNVERIFIED", "并非每个最终镜头都有事实审核");
  for (const item of input.shots) {
    const shot = { shotId: item.shotId, prompt: item.prompt, fields: item.fields };
    const records = bundle.outputReviews.filter(record => record.shotId === shot.shotId), review = records[0];
    if (records.length !== 1 || !review) fail("MARKETING_PROMPTS_UNVERIFIED", "营销镜头缺少唯一的事实审核");
    await verifyShotFactReview({ bundle, root: input.root, stageId: input.stageId ?? "preproduction" }, shot, review);
  }
  return bundle;
}
