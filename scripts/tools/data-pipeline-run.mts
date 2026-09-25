#!/usr/bin/env tsx
/**
 * data-pipeline-run.mts —— 「不提交生产渲染」的完整数据管线跑批 + 逐环节产物落盘
 * （T-2026-0925-0002）
 *
 * 用途：把营销片/叙事片的**数据段**端到端跑一遍——意图分流 → 商品情报五站（营销路由）
 * → 创意主题 → 需求洞察 → PRD → 剧本 → 镜头卡 → 提示词 → 定妆照 → 渲染脚本，
 * **不向渲染服务提交任何作业**（`deferRender=true` 恒开，由宿主 render-operator 另走 G8）。
 *
 * 与其它工具的关系：
 *   · `full-chain-film.mts` 是"成片制片"（含渲染/后期，烧额度）；
 *   · 本工具只跑到预生产收口，产物目录与 `video.studio.start` 的运行目录同形
 *     （`result.json` / `shots.json` / `meta.json` / `route.json` / `gates.jsonl` / `events.jsonl`），
 *     因此可直接接 `pipeline-audit.mts` 与 `pipeline-agent-audit.mts` 做逐环节审计。
 *
 * 用法：
 *   tsx scripts/tools/data-pipeline-run.mts \
 *     --intent "给米家空气净化器 4 Lite 做一条抖音种草视频，突出静音" \
 *     [--product "米家空气净化器 4 Lite"] [--brand 米家] [--category 空气净化器] \
 *     [--route auto|marketing|narrative] [--producer review|auto] \
 *     [--project VID-AUDIT-01] [--work-dir .vm-work] [--out outputs/VID-AUDIT-01] \
 *     [--keys-file ~/.workloom/live.env] [--no-portraits] [--refresh-dossier] [--json]
 *
 * 退出码：0=跑通；2=缺 LLM 配置；3=分流判定为"需澄清"（这是**正确行为**，不是失败）；
 *        4=运行失败（vendor 抛错）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  VideoStudio,
  WorkloomLLMEngine,
  installVendorEngineBridge,
  reviewStage,
  routeVideoPipeline,
  applyRouteToMetadata,
  buildPipelineIntent,
  describeRouteDecision,
  type ApprovalCallback,
  type EventSink,
  type GateKey,
  type StudioConfig,
} from "../../packages/video-studio/src/index.js";
import {
  AUTO_GATES,
  GATE_PRODUCER_STAGE,
  GATE_RUBRIC,
  gateDeterministicChecks,
  isProducerRejection,
  writeGateArtifact,
  type ProducerMode,
} from "../../apps/server/src/video/gate-policy.js";
import {
  createDataMiningExecutor,
  primeSearchCache,
  type ExecutorLlm,
  type SearchHit,
} from "../../apps/server/src/video/data-mining-executor.js";

const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}
const flag = (name: string) => process.argv.includes(name);
const stamp = () => new Date().toISOString();
const log = (line: string): void => process.stdout.write(`[${stamp().slice(11, 19)}] ${line}\n`);

/* ================= 环境与密钥（不写盘；只从已有秘密文件读入进程内存） ================= */

function loadKeys(file: string): number {
  if (!existsSync(file)) return 0;
  let loaded = 0;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!key || !value || process.env[key]) continue;
    process.env[key] = value;
    loaded += 1;
  }
  return loaded;
}

/* ================= 参数 ================= */

const INTENT = arg("--intent");
if (!INTENT) throw new Error("需要 --intent <创作意图原文>");
const PROJECT = arg("--project", `VID-AUDIT-${new Date().toISOString().slice(5, 10).replace("-", "")}`);
const WORK_DIR = resolve(REPO_ROOT, arg("--work-dir", ".vm-work"));
const OUT_DIR = resolve(REPO_ROOT, arg("--out", join("outputs", PROJECT)));
const KEYS_FILE = resolve(arg("--keys-file", join(homedir(), ".workloom", "live.env")).replace(/^~/, homedir()));
const ROUTE_ARG = arg("--route", "auto");
const PRODUCER = (arg("--producer", "review").toLowerCase() === "auto" ? "auto" : "review") as ProducerMode;
const PORTRAITS_ENABLED = !flag("--no-portraits") && (process.env.HR_PORTRAIT_ENABLED ?? "1") !== "0";
/** 需求口径（写进意图块，供生成器与 G2 监制核对；缺省与本仓 marketing brief 默认一致） */
const PROFILE = {
  durationSec: Number(arg("--duration", "30")) || 30,
  aspectRatio: arg("--aspect", "9:16"),
  platform: arg("--platform", "douyin"),
  goal: arg("--goal", "seeding"),
};

const loadedKeys = loadKeys(KEYS_FILE);
log(`密钥装载：${loadedKeys} 项（来自 ${KEYS_FILE.replace(homedir(), "~")}；已在环境里的不覆盖）`);

/**
 * 模型名兜底：本机秘密文件（~/.workloom/live*.env）登记的是 `DEEPSEEK_MODEL`，
 * 而 `WorkloomLLMEngine.fromEnv()` 只认 `LLM_MODEL`。两者同源（OpenAI 兼容端点），
 * 这里做一次显式映射并打印，避免"以为配了模型其实没配"。
 */
if (!process.env.LLM_MODEL && process.env.DEEPSEEK_MODEL) {
  process.env.LLM_MODEL = process.env.DEEPSEEK_MODEL;
  log(`LLM_MODEL 未设置 → 采用 DEEPSEEK_MODEL=${process.env.DEEPSEEK_MODEL}`);
}

mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(join(WORK_DIR, "logs"), { recursive: true });
const gatesFile = join(OUT_DIR, "gates.jsonl");
const eventsFile = join(OUT_DIR, "events.jsonl");
/** 检索缓存：跨站/跨次复用同一批真实结果，避免重复轰击公开检索端点（被反爬时仍可复现） */
const SEARCH_CACHE_FILE = resolve(REPO_ROOT, arg("--search-cache", join(WORK_DIR, "search-cache.json")));

/**
 * `--prime-search <fixture.json>`：把平台检索/人工回填的真实结果预置进缓存。
 * fixture 形如 { "queries": { "米家空气净化器 4 Lite 参数": [{title,url,snippet}, ...] } }。
 * 预置结果与线上结果同权（同样过 URL 白名单与相关性过滤），只替代 HTTP 传输通道。
 */
const PRIME_FILE = arg("--prime-search");
if (PRIME_FILE) {
  const fixturePath = resolve(REPO_ROOT, PRIME_FILE);
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as { queries?: Record<string, SearchHit[]> };
  const primed = primeSearchCache(SEARCH_CACHE_FILE, fixture.queries ?? {});
  log(`检索预置完成：${primed.queries} 条查询 / ${primed.written} 条结果 → ${SEARCH_CACHE_FILE.replace(REPO_ROOT + "/", "")}`);
}

/* ================= LLM 引擎（缺配置即拒跑，禁止静默降级） ================= */

const llm = WorkloomLLMEngine.fromEnv();
if (!llm) {
  log("❌ 缺 LLM 配置（LLM_BASE_URL / LLM_API_KEY / LLM_MODEL），拒绝启动（vendor 纪律：禁止静默降级）");
  process.exit(2);
}
log(`LLM 引擎就绪：model=${llm.model}`);

/* ================= ① 意图分流 ================= */

const routeExplicit = ROUTE_ARG === "marketing" || ROUTE_ARG === "narrative" ? ROUTE_ARG : undefined;
const decision = await routeVideoPipeline(
  {
    text: INTENT,
    metadata: arg("--product") ? { dataMining: { name: arg("--product"), brand: arg("--brand"), category: arg("--category") } } : undefined,
    explicit: routeExplicit,
  },
  { llmCall: async (prompt: string) => (await llm.reason(prompt, { forceJson: true, temperature: 0.1, maxTokens: 512 })).content ?? "" },
);
log(`分流结论：${describeRouteDecision(decision)}`);
writeFileSync(join(OUT_DIR, "route.json"), `${JSON.stringify(decision, null, 2)}\n`, "utf8");

if (decision.route === "clarify") {
  log("→ 分流判定需要澄清（正确行为：宁可不跑，也不按错误管线花钱）");
  process.stdout.write(`${decision.clarify?.question ?? ""}\n`);
  process.exit(3);
}

/* ================= ② 装配 metadata（营销路由激活情报层 / 叙事路由显式关闭） ================= */

const brief: Record<string, unknown> = {
  duration: Number(arg("--duration", "30")) || 30,
  platform: arg("--platform", "douyin"),
  goal: arg("--goal", "seeding"),
};
const seeded = applyRouteToMetadata({ brief }, decision);
if (arg("--product") && decision.product) {
  // CLI 显式给出的商品信息优先（用户口径 > 抽取结果）
  seeded.dataMining = {
    ...(seeded.dataMining as Record<string, unknown>),
    name: arg("--product"),
    ...(arg("--brand") ? { brand: arg("--brand") } : {}),
    ...(arg("--category") ? { category: arg("--category") } : {}),
    ...(arg("--model") ? { model: arg("--model") } : {}),
  };
  (seeded.brief as Record<string, unknown>).product = arg("--product");
}
if (arg("--selling-points")) {
  const points = arg("--selling-points").split(/[,，、;；]/).map((s) => s.trim()).filter(Boolean);
  if (points.length > 0) {
    (seeded.dataMining as Record<string, unknown>).sellingPointCandidates = points;
    (seeded.brief as Record<string, unknown>).sellingPoints = points.slice(0, 3);
  }
}

/** `--dry-run`：只做分流 + metadata 装配（不跑管线、不花钱），用于验收分流口径 */
if (flag("--dry-run")) {
  writeFileSync(join(OUT_DIR, "route-dry-run.json"), `${JSON.stringify({ decision, seeded }, null, 2)}\n`, "utf8");
  log("--dry-run：已完成分流与 metadata 装配，未启动管线");
  process.stdout.write(`${JSON.stringify({ decision, metadata: seeded }, null, 2)}\n`);
  process.exit(0);
}

/* ================= ③ 门策略（与生产同一份定义） ================= */

const gateRecords: Array<Record<string, unknown>> = [];
const onApproval: ApprovalCallback = async (req) => {
  const gate = req.gate as GateKey;
  const deterministic = gateDeterministicChecks(gate, req.contentMd ?? "");
  let verdict: Awaited<ReturnType<typeof reviewStage>> | null = null;
  if (PRODUCER === "review" && AUTO_GATES.has(gate)) {
    // 与生产同一口径：门内容落盘成真实文件再送审（否则监制只看到 600 字摘录）
    const artifact = writeGateArtifact(WORK_DIR, PROJECT, gate, req.contentMd ?? "");
    verdict = await reviewStage({
      stage: GATE_PRODUCER_STAGE[gate] ?? "script",
      projectId: PROJECT,
      artifacts: [{ path: artifact.path, kind: "text", note: req.title }],
      deterministic,
      rubric: [
        ...(GATE_RUBRIC[gate] ?? []),
        `门内容全长 ${artifact.chars} 字，已随附件送审；摘录（供定位）：${(req.contentMd ?? "").slice(0, 600)}`,
      ],
      context: { gate, vendorType: req.vendorType, contentChars: (req.contentMd ?? "").length },
      allowFallbackApprove: false,
      log: (line) => console.log(line),
    });
  }
  const approved = PRODUCER === "auto" ? !deterministic.some((c) => c.hard && !c.pass) : Boolean(verdict?.approved);
  gateRecords.push({
    at: stamp(), gate, vendorType: req.vendorType,
    approved, via: verdict?.via ?? (PRODUCER === "auto" ? "auto" : "none"),
    score: verdict?.score ?? null, deterministic,
    reason: verdict?.reason ?? (PRODUCER === "auto" ? "auto 模式：仅跑确定性硬闸" : ""),
    issues: verdict?.issues?.slice(0, 5) ?? [],
  });
  appendFileSync(gatesFile, `${JSON.stringify(gateRecords[gateRecords.length - 1])}\n`, "utf8");
  log(`  [gate ${gate}] ${approved ? "放行" : "打回"}（${verdict ? `监制 ${verdict.score} 分 / via=${verdict.via}` : PRODUCER === "auto" ? "auto" : "无监制"}）`);
  return {
    approved,
    reason: verdict ? `${approved ? "producer-approved" : "producer-rejected"}(${gate} · score=${verdict.score})` : `auto(${gate})`,
    ...(verdict?.suggestions?.length ? { suggestions: verdict.suggestions } : {}),
    ...(approved ? {} : { fatal: "producer_rejected" }),
  };
};

const onEvent: EventSink = (e) => {
  appendFileSync(eventsFile, `${JSON.stringify({ at: stamp(), ...e })}\n`, "utf8");
};

/* ================= ④ 跑批（不提交渲染） ================= */

const dataMining: StudioConfig["dataMining"] = decision.route === "marketing"
  ? {
      mode: "api",
      executor: createDataMiningExecutor({
        llm: llm as unknown as ExecutorLlm,
        log,
        searchCacheFile: SEARCH_CACHE_FILE,
        searchPaceMs: Number(arg("--search-pace-ms", "1200")) || 1_200,
      }) as unknown as (
        stage: string,
        plan: Record<string, unknown>,
      ) => Promise<Record<string, unknown> | null>,
      refresh: flag("--refresh-dossier"),
      storeRoot: join(WORK_DIR, "dossiers", "audit"),
      staleAfterDays: 30,
    }
  : undefined;

const portraits: StudioConfig["portraits"] = PORTRAITS_ENABLED && process.env.VOLCENGINE_ARK_API_KEY
  ? {
      enabled: true,
      apiKey: process.env.VOLCENGINE_ARK_API_KEY,
      model: process.env.SEEDREAM_MODEL ?? "doubao-seedream-4-0-250828",
      baseUrl: process.env.ARK_BASE_URL?.trim(),
      timeoutMs: Number(process.env.HR_PORTRAIT_TIMEOUT_MS ?? 240_000),
      maxReferenceImages: 4,
      referenceImages: [],
      characterAnchorImages: (process.env.HR_PORTRAIT_ANCHORS ?? "")
        .split(",").map((s) => s.trim()).filter(Boolean)
        .map((p) => (isAbsolute(p) ? p : join(REPO_ROOT, p))),
      requireCharacterDescription: true,
    }
  : { enabled: false };

/** 创作意图：清掉分流行指令 + 写入需求口径（时长/画幅/平台/目标） */
const PIPELINE_INTENT = buildPipelineIntent(INTENT, PROFILE);
log(`创作意图（下行）：${PIPELINE_INTENT.replace(/\n/g, " ")}`);

installVendorEngineBridge(llm);
const studio = new VideoStudio({
  llm,
  workDir: WORK_DIR,
  onApproval,
  onEvent,
  totalDeadlineMs: Number(process.env.VM_TOTAL_DEADLINE_MS ?? 3_600_000),
  deferRender: true, // 本工具的铁律：不提交生产渲染
  portraits,
  dataMining,
  log: (line) => console.log(line),
});

log(`启动数据管线：project=${PROJECT} | 管线=${decision.route} | 定妆照=${portraits?.enabled ? "开" : "关"} | 提交渲染=否`);
const startedAt = Date.now();
let result: Awaited<ReturnType<VideoStudio["runPreproduction"]>>;
try {
  const maxAttempts = Math.max(1, Number(arg("--producer-retry", "1")) + 1);
  result = await studio.runPreproduction({
    projectId: PROJECT,
    intent: PIPELINE_INTENT,
    metadata: seeded,
    isMarketing: decision.route === "marketing",
  });
  let attempts = 1;
  while (attempts < maxAttempts && isProducerRejection(result)) {
    attempts += 1;
    log(`AI 监制打回 → 自动重跑第 ${attempts}/${maxAttempts} 次（打回理由见 gates.jsonl）`);
    result = await studio.runPreproduction({
      projectId: PROJECT,
      intent: PIPELINE_INTENT,
      metadata: seeded,
      isMarketing: decision.route === "marketing",
    });
  }
  (result as Record<string, unknown>).producerAttempts = attempts;
} catch (err) {
  log(`❌ 运行失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(4);
}
const elapsedMs = Date.now() - startedAt;

/* ================= ⑤ 产物落盘（与 video.studio.start 运行目录同形） ================= */

const stagesRaw = (result.stages ?? {}) as Record<string, unknown>;
const production = (stagesRaw.productionEngine ?? {}) as { shots?: Array<Record<string, unknown>>; prompts?: Array<Record<string, unknown>> };
const shots = Array.isArray(production.shots) ? production.shots : [];
const prompts = Array.isArray(production.prompts) ? production.prompts : [];
const dataMiningStage = (stagesRaw.dataMining ?? null) as
  | { status?: string; product_id?: string; timing?: number; data?: { ok?: boolean; reused?: boolean; saved?: unknown; envelopes?: unknown[]; chain?: { ok?: boolean }; dossier?: Record<string, unknown>; cards?: Record<string, unknown>; errors?: unknown[]; verification_report?: Record<string, unknown> } }
  | null;

writeFileSync(join(OUT_DIR, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
writeFileSync(join(OUT_DIR, "shots.json"), `${JSON.stringify(shots, null, 2)}\n`, "utf8");
writeFileSync(join(OUT_DIR, "meta.json"), `${JSON.stringify({
  projectId: PROJECT,
  intent: PIPELINE_INTENT,
  intentRaw: INTENT,
  pipeline: decision.route,
  routeDecision: decision,
  producerMode: PRODUCER,
  portraitsEnabled: Boolean(portraits?.enabled),
  renderSubmitted: false,
  startedAt: new Date(Date.now() - elapsedMs).toISOString(),
  finishedAt: stamp(),
  elapsedMs,
  stages: Object.keys(stagesRaw),
}, null, 2)}\n`, "utf8");

/* ================= ⑥ 逐环节摘要（人读 + --json 机读） ================= */

const dossier = dataMiningStage?.data?.dossier as Record<string, unknown> | undefined;
const provenance = Array.isArray(dossier?.provenance) ? dossier!.provenance as unknown[] : [];
const gaps = Array.isArray(dossier?.gaps) ? dossier!.gaps as unknown[] : [];
const images = ((dossier?.visual_assets as { images?: unknown[] } | undefined)?.images ?? []) as unknown[];
const summary = {
  projectId: PROJECT,
  pipeline: decision.route,
  success: result.success,
  elapsedMs,
  stages: Object.entries(stagesRaw).map(([name, value]) => ({
    name,
    present: value !== undefined && value !== null,
    timingMs: typeof (value as { timing?: unknown })?.timing === "number" ? (value as { timing: number }).timing : null,
  })),
  dataMining: dataMiningStage
    ? {
        status: dataMiningStage.status ?? null,
        productId: dataMiningStage.product_id ?? null,
        ok: dataMiningStage.data?.ok ?? null,
        reused: dataMiningStage.data?.reused ?? null,
        chainOk: dataMiningStage.data?.chain?.ok ?? null,
        evidenceCount: provenance.length,
        gapCount: gaps.length,
        imageCount: images.length,
        heroImageId: (dossier?.visual_assets as { hero_image_id?: string } | undefined)?.hero_image_id ?? null,
        sellingPoints: ((dataMiningStage.data?.cards as { brief_card?: { sellingPoints?: string[] } } | undefined)?.brief_card?.sellingPoints) ?? [],
        errors: dataMiningStage.data?.errors ?? [],
      }
    : null,
  shots: shots.length,
  prompts: prompts.length,
  gates: gateRecords.map((g) => ({ gate: g.gate, approved: g.approved, score: g.score })),
};

writeFileSync(join(OUT_DIR, "data-pipeline-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
if (flag("--json")) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
else {
  log("—— 逐环节摘要 ——");
  for (const stage of summary.stages) log(`  ${stage.present ? "✓" : "×"} ${stage.name}${stage.timingMs ? `（${stage.timingMs}ms）` : ""}`);
  if (summary.dataMining) {
    log(`  情报档案：status=${summary.dataMining.status} ok=${summary.dataMining.ok} 证据=${summary.dataMining.evidenceCount} 缺口=${summary.dataMining.gapCount} 图=${summary.dataMining.imageCount} 链=${summary.dataMining.chainOk}`);
  }
  log(`  镜头卡 ${summary.shots} 张 / 提示词 ${summary.prompts} 条 / 门记录 ${summary.gates.length} 条`);
  log(`产物目录：${OUT_DIR.replace(REPO_ROOT + "/", "")}（result.json / shots.json / meta.json / gates.jsonl / events.jsonl）`);
}
