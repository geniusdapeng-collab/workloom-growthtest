/**
 * video/studio-worker.ts —— 预生产运行工作器（融合设计 §3 门矩阵 G1–G7 接线）
 *
 * 职责：
 *  1. 内存 run 注册表（runId → 运行投影），studio.start 异步启动不阻塞 tRPC 响应
 *  2. onApproval：确认门 → gatewayAppendOnClient 落门动作事件 + INSERT approvals（pending）
 *     → 轮询审批状态（HR_APPROVAL_POLL_MS / HR_APPROVAL_TIMEOUT_MS）→ 映射 GateVerdict
 *  3. onEvent：pipeline.* 生命周期事件经 gatewayAppend 落五元事件库
 *  4. LLM engine：WorkloomLLMEngine.fromEnv()；为 null 拒绝启动（禁止静默降级，vendor 纪律）
 *
 * 纪律：门事件与 approvals 行同一事务同一 COMMIT（D16）；事件一律经 workdata 安全网关。
 * 注意：ApprovalCallback 签名（packages/video-studio，冻结）不透传 vendor 的 shouldAbort，
 *      本工作器以 run 注册表 aborted 位实现同等中止语义（轮询每拍检查）。
 */
import path from "node:path";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getAppPool, getGatewayPool } from "@workloom/db";
import { GatewayEventSink, poolFromEnv } from "@workloom/base/model-router";
import { modelPolicyFor } from "../service/llm.js";
import { gatewayAppend, gatewayAppendOnClient, insertWithReadableId, VIDEO_PROJECT_ID_SOURCE } from "@workloom/base/workdata";
import { makeReadableId, newId } from "@workloom/shared";
import {
  VideoStudio,
  WorkloomLLMEngine,
  ArchiveStore,
  StageRunner,
  auditScenePolicy,
  attachStructuredLog,
  classifyError,
  installVendorEngineBridge,
  installVendorPortraitBindingBridge,
  installVendorRenderCompatBridge,
  reviewStage,
  updateContextBundle,
  buildDirectorDefaults, directorGuidance, resolveDeliveryTargets, compilePersonPresentation, shotPresentationGuidance,
  type CreativeDelegation, type DeliveryTargetPlan,
  type ApprovalCallback,
  type EventSink,
  type GateKey,
  type GateVerdict,
  type PipelineKind,
  type PortraitIndex,
  type ProducerStage,
  type ProducerVerdict,
  type RunInput,
  type ScenePolicyException,
  type ScenePolicyShot,
  type StudioConfig,
  type StudioPortraitConfig,
} from "@hyperreality/video-studio";
import { buildServerGateRecord, withGateLedger } from "./gate-ledger-bridge.js";
import { createDataMiningExecutor } from "./data-mining-executor.js";
import { prepareMarketingFacts, finalizeMarketingFacts, type PreparedMarketingFacts } from "./marketing-authority.js";
import { canonicalRenderJson, renderSha256 } from "./gen/compiled-request.js";
import { acquireProjectLease, archiveWorkDir, makeLedgerWriter, readProjectMeta } from "./archive-host.js";
import { ingestPortraitsFromIndex } from "./media/library.js";
import { upsertProductProfileFromDossier } from "./media/products.js";
import { appendScenePolicyGuidance, resolveScenePolicyForIntent } from "./scene-policy-routing.js";
import { appendPlatformGuidance, resolvePlatformForIntent } from "./platform-routing.js";
import { createDirectorGrantOnClient, verifyDirectorGrant, readExplicitDirectorPreferences } from "./director-store.js";
import {
  AUTO_GATES,
  GATE_PRODUCER_STAGE,
  GATE_RUBRIC,
  gateDeterministicChecks,
  isProducerRejection,
  producerModeFromEnv,
  portraitGateEvidence,
  portraitReviewManifest,
  writeGateArtifact,
  type ProducerMode,
} from "./gate-policy.js";

/* ================= 可配项（环境变量） ================= */

/** 审批等待上限（默认 2 小时；超时 → { approved:false, fatal:'timeout' }） */
const APPROVAL_TIMEOUT_MS = Number(process.env.HR_APPROVAL_TIMEOUT_MS ?? 7_200_000);
/** 审批状态轮询间隔（默认 2s） */
const APPROVAL_POLL_MS = Number(process.env.HR_APPROVAL_POLL_MS ?? 2_000);
/** 流水线总截止（透传 vendor STORMAXE_TOTAL_DEADLINE_MS 口径，默认 1 小时） */
const TOTAL_DEADLINE_MS = Number(process.env.VM_TOTAL_DEADLINE_MS ?? 3_600_000);

/**
 * 内部门三档处置与逐门口径见 `./gate-policy.js`（服务端与本地审计跑批共用同一份定义，
 * 避免"审计过的门 ≠ 生产的门"漂移）。花钱/对外门（G8 渲染提交、G9 发布、G10 对外评论）
 * 不在 AUTO_GATES 内，仍按高风险走人审。
 */
const PRODUCER_MODE: ProducerMode = producerModeFromEnv();

const here = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根（apps/server/src/video → 上溯四级）：参考图相对路径按此解析 */
const REPO_ROOT = path.resolve(here, "../../../..");
/**
 * 运行产物根（checkpoints/characters/confirmations/archive）：默认仓库根 `.vm-work/`。
 * 与 archive-watch / archive-resume CLI 共用 `archiveWorkDir()` 解析（相对路径按仓库根，
 * 历史 cwd 相对路径自动兼容），避免"服务器写一处、巡检读另一处"的路径漂移。
 */
const WORK_DIR = archiveWorkDir();

/**
 * 营销路由判定 → 情报层装配开关（2026-09-25 激活）。
 *
 * 判定与 vendor 的激活条件同源（`metadata.dataMining` / `metadata.brief.product`），
 * 另接受 `metadata.pipelineRoute.kind === 'marketing'`（分流器的落库口径）与 `products[]`
 * （产品所有者给的实拍图登记）。命中即为本次 run 装配**真实检索执行器**：
 *   - 情报五站由 api 模式的 executor 真跑（Bing 公开 RSS + 模型结构化回填）；
 *   - 档案落盘按工作区隔离：`<WORK_DIR>/dossiers/<workspaceId>`；
 *   - 未命中（叙事片）保持原行为，vendor 不会进情报层。
 */
function dataMiningConfigFor(
  metadata: Record<string, unknown> | undefined,
  llm: WorkloomLLMEngine,
  workspaceId: string,
): StudioConfig["dataMining"] | undefined {
  if ((process.env.VM_DATA_MINING ?? "1") === "0") return undefined;
  const dm = metadata?.dataMining as { name?: unknown } | undefined;
  const brief = metadata?.brief as { product?: unknown } | undefined;
  const route = metadata?.pipelineRoute as { kind?: unknown } | undefined;
  const products = metadata?.products;
  const marketing = Boolean(
    (dm && typeof dm.name === "string" && dm.name.trim())
    || (brief && typeof brief.product === "string" && brief.product.trim())
    || route?.kind === "marketing"
    || (Array.isArray(products) && products.length > 0),
  );
  if (!marketing) return undefined;
  const mode = (process.env.VM_DATA_MINING_MODE ?? "api").trim() === "spec" ? "spec" : "api";
  return {
    mode,
    ...(mode === "api"
      ? {
          // vendor 侧按 `executor(stage, plan)` 调用（stage 为 A1/A2/A3），此处收敛为宿主类型
          executor: createDataMiningExecutor({ llm, log: (line) => console.log(line) }) as unknown as (
            stage: string,
            plan: Record<string, unknown>,
          ) => Promise<Record<string, unknown> | null>,
        }
      : {}),
    refresh: (process.env.VM_DATA_MINING_REFRESH ?? "") === "1",
    storeRoot: path.join(WORK_DIR, "dossiers", workspaceId),
    staleAfterDays: Number(process.env.VM_DATA_MINING_STALE_DAYS ?? 30) || 30,
  };
}

/**
 * 运行日志 tee（2026-09-22 真机审计需求）：
 * 预生产的 vendor 环节日志此前只进服务端 stdout（TTY），run 结束即丢，事后无法逐环节审计。
 * 这里在 run 期间把 console 输出旁路落盘到 `.vm-work/logs/<projectId>.log`（原样透传，不改语义），
 * 供 `scripts/tools/pipeline-audit.mts` 逐环节核对"是否正常产出/是否流转".
 */
/**
 * C-07 修复：全局 console 劫持改为"单一包装 + 订阅者引用计数"。
 * 此前每个 run 各自捕获"当前"console 为 originals——并发两个 run 时 B 捕获的是 A 的包装器，
 * A 先结束恢复后，B 结束会把 console 永久还原成 A 的包装器（日志继续写入已结束 run 的文件，
 * 且后续 run 的恢复链彻底错位）。
 * 现在：console 只被包装一次（真正 originals 只捕获一次），各 run 以订阅者身份注册自己的
 * 日志文件，取消订阅时引用计数归零才还原 console——先后结束顺序任意都不错位。
 */
const teeSubscribers = new Map<string, (level: string, args: unknown[]) => void>();
let teeInstalled: { originals: Array<(...args: unknown[]) => void> } | null = null;

function formatTeeLine(args: unknown[]): string {
  return args
    .map((a) => (typeof a === "string" ? a : a instanceof Error ? `${a.name}: ${a.message}` : (() => {
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })()))
    .join(" ");
}

function installTee(): void {
  if (teeInstalled) return;
  const methods = ["log", "warn", "error"] as const;
  const originals = methods.map((m) => console[m] as (...args: unknown[]) => void);
  methods.forEach((m, i) => {
    (console as unknown as Record<string, unknown>)[m] = (...args: unknown[]) => {
      for (const write of teeSubscribers.values()) {
        try {
          write(m.toUpperCase(), args);
        } catch {
          /* 单个订阅者失败不影响其他订阅者与原输出 */
        }
      }
      originals[i]!.apply(console, args);
    };
  });
  teeInstalled = { originals };
}

function uninstallTeeIfIdle(): void {
  if (!teeInstalled || teeSubscribers.size > 0) return;
  const methods = ["log", "warn", "error"] as const;
  methods.forEach((m, i) => {
    (console as unknown as Record<string, unknown>)[m] = teeInstalled!.originals[i];
  });
  teeInstalled = null;
}

function teeRunLogs(projectId: string): () => void {
  const logDir = path.join(WORK_DIR, "logs");
  const logFile = path.join(logDir, `${projectId}.log`);
  try {
    mkdirSync(logDir, { recursive: true });
  } catch {
    return () => undefined;
  }
  const write = (level: string, args: unknown[]) => {
    try {
      appendFileSync(logFile, `[${new Date().toISOString()}] ${level} ${formatTeeLine(args)}\n`, "utf8");
    } catch {
      /* 日志落盘失败不影响运行 */
    }
  };
  teeSubscribers.set(projectId, write);
  installTee();
  let released = false;
  return () => {
    if (released) return; // 幂等：重复调用不破坏其他 run 的订阅
    released = true;
    teeSubscribers.delete(projectId);
    uninstallTeeIfIdle();
  };
}

/** 工作器系统身份（事件归因；网关段① human/system 无额外校验） */
const WORKER_ACTOR = { id: "video-studio", type: "system" } as const;

/**
 * 软失败原因提取（T-2026-0926-0005）：vendor 返回 `success:false` 但不抛异常时，
 * 注册表 `entry.error` 往往是空串——`?? 兜底` 会落成空消息并被分类成 BUG。
 * 取因顺序：运行器异常 → result.error/errorMessage → vendor failures/errors → 被拒确认门 → 通用兜底。
 */
export function terminalFailureMessageOf(result: unknown, entryError?: string | null): string {
  const r = (result ?? {}) as {
    error?: unknown;
    errorMessage?: unknown;
    failures?: Array<{ message?: unknown }>;
    errors?: Array<{ message?: unknown; error?: unknown }>;
    confirmations?: Record<string, unknown>;
  };
  const candidates: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === "string" && value.trim()) candidates.push(value.trim());
  };
  push(entryError);
  push(r.error);
  push(r.errorMessage);
  if (Array.isArray(r.failures)) for (const failure of r.failures) push(failure?.message);
  if (Array.isArray(r.errors)) for (const failure of r.errors) push(failure?.message ?? failure?.error);
  for (const confirmation of Object.values(r.confirmations ?? {})) {
    if (confirmation && typeof confirmation === "object") {
      const verdict = confirmation as { approved?: unknown; reason?: unknown };
      if (verdict.approved === false) push(verdict.reason);
    }
  }
  return (candidates[0] ?? "vendor 返回 success:false").slice(0, 500);
}

/* ================= run 注册表 ================= */

export type RunStatus = "running" | "awaiting_approval" | "finished" | "failed";

export interface RunEntry {
  runId: string;
  projectId: string;
  workspaceId: string;
  status: RunStatus;
  /** 当前待审批门（无待审批为 null） */
  currentGate: GateKey | null;
  /** 当前待审批单号（G8 队列可直查） */
  pendingApprovalId: string | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  resultSummary: Record<string, unknown> | null;
  /** shouldAbort 位：置 true 后轮询下一拍中断（见文件头说明） */
  aborted: boolean;
}

const runs = new Map<string, RunEntry>();

/** run 投影（studio.status 数据源；L7.1：跨工作区查询返回 null） */
export function getRun(runId: string, workspaceId: string): RunEntry | null {
  const entry = runs.get(runId);
  if (!entry || entry.workspaceId !== workspaceId) return null;
  return entry;
}

/** 工作区 run 聚合（studio.active 数据源：只读内存投影，不改变任何运行语义） */
export interface WorkspaceRunSummary {
  /** 正在执行的 run 数 */
  running: number;
  /** 停在人审门上的 run 数 */
  awaitingApproval: number;
  /** 最近失败（窗口内）的 run 数 */
  failedRecent: number;
  /** 活跃 run 的编号（running + awaitingApproval，供 UI 深链） */
  activeRunIds: string[];
}

/**
 * 汇总本工作区 run 状态（供「织伴」全局状态球与运维面板使用）。
 * 语义边界：run 注册表是**进程内**投影（服务重启即清空），这里只做只读汇总，
 * 不写库、不改变 run 生命周期；失败窗口默认 15 分钟（够一次 10s/20s 轮询看见）。
 */
export function summarizeWorkspaceRuns(
  workspaceId: string,
  options: { now?: number; failedWindowMs?: number } = {},
): WorkspaceRunSummary {
  const now = options.now ?? Date.now();
  const failedWindowMs = options.failedWindowMs ?? 15 * 60_000;
  const summary: WorkspaceRunSummary = { running: 0, awaitingApproval: 0, failedRecent: 0, activeRunIds: [] };
  for (const entry of runs.values()) {
    if (entry.workspaceId !== workspaceId) continue;
    if (entry.status === "running") {
      summary.running += 1;
      summary.activeRunIds.push(entry.runId);
    } else if (entry.status === "awaiting_approval") {
      summary.awaitingApproval += 1;
      summary.activeRunIds.push(entry.runId);
    } else if (entry.status === "failed" && entry.finishedAt) {
      const finishedAt = Date.parse(entry.finishedAt);
      if (!Number.isNaN(finishedAt) && now - finishedAt <= failedWindowMs) summary.failedRecent += 1;
    }
  }
  summary.activeRunIds.sort();
  return summary;
}

export class StudioWorkerError extends Error {
  constructor(
    public readonly code: "LLM_MISSING" | "ARCHIVE_REQUIRED" | "IDENTITY_ASSET_REQUIRED" | "METADATA_RESERVED" | "DELEGATION_REQUIRED",
    message: string,
  ) {
    super(message);
    this.name = "StudioWorkerError";
  }
}

export const RESERVED_STUDIO_METADATA_ERROR = "METADATA_RESERVED：客户 metadata 不能提供内部图片字段或本机参考图路径，请使用已登记素材 ID";

/** 普通metadata只承载客户意图，不能进入服务端已解析的本机图片通道。 */
export function isPublicStudioMetadata(metadata?: Record<string, unknown> | null): boolean {
  // 与实际定妆配置共用解析器，字符串和所有产品参考图字段别名都在任何 SQL/租约之前关闭。
  return !metadata || (!Object.hasOwn(metadata, "directorIdentityImages") && collectReferenceImages(metadata).length === 0);
}

function assertPublicStudioMetadata(metadata?: Record<string, unknown> | null): void {
  if (!isPublicStudioMetadata(metadata)) throw new StudioWorkerError("METADATA_RESERVED", RESERVED_STUDIO_METADATA_ERROR);
}

/* ================= 门对象映射（§3 审批点矩阵逐字口径） ================= */

function gateObjectOf(gate: GateKey, vendorType: string): { type: string; action: string } {
  switch (gate) {
    case "G1_DOSSIER": return { type: "dossier", action: "dossier.confirm" };
    case "G2_THEME": return { type: "theme", action: "theme.confirm" };
    case "G3_INSIGHT": return { type: "insight", action: "insight.confirm" };
    case "G4_PRD": return { type: "prd", action: "prd.confirm" };
    case "G5_PORTRAIT": return { type: "portrait_set", action: "portrait.confirm" };
    case "G6_PROMPT": return { type: "prompt_package", action: "prompt.confirm" };
    case "G7_FINAL": return { type: "project", action: "preproduction.finalize" };
    default: return { type: vendorType || "gate", action: `${vendorType || "gate"}.confirm` };
  }
}

/* ================= 审批轮询 ================= */

interface ApprovalPollRow {
  status: string;
  gesture: { reason_enum?: string; reason_text?: string; edited_after?: unknown } | null;
}

async function readApproval(
  scope: { tenantId: string; workspaceId: string },
  approvalId: string,
): Promise<ApprovalPollRow | null> {
  const client = await getAppPool().connect();
  try {
    // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    const r = await client.query<ApprovalPollRow>(
      `SELECT status, gesture FROM approvals WHERE approval_id=$1 AND workspace_id=$2`,
      [approvalId, scope.workspaceId],
    );
    await client.query("COMMIT");
    return r.rows[0] ?? null;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询审批状态 → GateVerdict（尊重 entry.aborted；超时 fatal='timeout'） */
async function pollApproval(
  entry: RunEntry,
  scope: { tenantId: string; workspaceId: string },
  approvalId: string,
): Promise<GateVerdict> {
  const deadline = Date.now() + APPROVAL_TIMEOUT_MS;
  for (;;) {
    if (entry.aborted) return { approved: false, reason: "run-aborted", fatal: "abort" };
    if (Date.now() >= deadline) {
      // C-05 修复：超时出口把审批行置 expired——否则审批中心仍显示可办，
      // 人后来批准了也没有任何消费者（僵尸审批；与 expireSweep 口径一致）
      try {
        const client = await getAppPool().connect();
        try {
          await client.query("BEGIN");
          await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
          await client.query(
            `UPDATE approvals SET status='expired' WHERE approval_id=$1 AND workspace_id=$2 AND status='pending'`,
            [approvalId, scope.workspaceId],
          );
          await client.query("COMMIT");
        } catch (inner) {
          // 事务不得带着未决状态归还连接池（否则后续借用者接手一个已中止事务）
          await client.query("ROLLBACK").catch(() => undefined);
          throw inner;
        } finally {
          client.release();
        }
      } catch (err) {
        console.warn(`[studio-worker] 审批超时置 expired 失败（${approvalId}）：`, err instanceof Error ? err.message : err);
      }
      return { approved: false, reason: "approval-timeout", fatal: "timeout" };
    }
    const row = await readApproval(scope, approvalId);
    if (row && row.status !== "pending") {
      if (row.status === "approved") return { approved: true };
      if (row.status === "edited") {
        // 编辑后采纳：edited_after 文本作为 suggestions 回传引擎（F5.2 手势语义）
        const edited = row.gesture?.edited_after;
        const text = typeof edited === "string" ? edited : edited !== undefined ? JSON.stringify(edited) : "";
        return { approved: true, suggestions: text ? [text] : [] };
      }
      if (row.status === "rejected") {
        return { approved: false, reason: row.gesture?.reason_text ?? row.gesture?.reason_enum ?? "rejected" };
      }
      // expired 等其余终态按驳回处理（L5.4：不存在超时自动放行）
      return { approved: false, reason: `approval-${row.status}` };
    }
    await sleep(APPROVAL_POLL_MS);
  }
}

/* ================= 启动入口 ================= */

interface Scope { tenantId: string; workspaceId: string }

/**
 * 从 brief 的 metadata 收集真实参考图（产品所有者给到的实拍图）。
 * 支持两种登记口径：字符串路径，或情报档案对象 `{ localPath | path | url }`；
 * 只接受本地可读路径（远端 URL 需先落地，避免出图阶段访问不到）。
 */
function collectReferenceImages(metadata?: Record<string, unknown>): string[] {
  const products = Array.isArray(metadata?.products) ? (metadata!.products as Array<Record<string, unknown>>) : [];
  const out: string[] = [];
  for (const product of products) {
    const manifest = (product?.referenceManifest ?? product?.reference_manifest) as
      | Record<string, unknown>
      | undefined;
    const images = (manifest?.reference_images ?? manifest?.referenceImages) as unknown;
    if (!Array.isArray(images)) continue;
    for (const image of images) {
      if (typeof image === "string" && image.trim()) {
        out.push(image.trim());
        continue;
      }
      if (image && typeof image === "object") {
        const record = image as Record<string, unknown>;
        const local = record.localPath ?? record.path ?? (typeof record.url === "string" && !/^https?:/i.test(record.url) ? record.url : null);
        if (typeof local === "string" && local.trim()) out.push(local.trim());
      }
    }
  }
  return Array.from(new Set(out));
}

/** 定妆照出图配置（缺密钥则显式关闭：保持 vendor 规格包口径，不假装出图） */
function portraitConfig(metadata?: Record<string, unknown>, directorIdentityImages: string[] = []): StudioPortraitConfig {
  const apiKey = (process.env.VOLCENGINE_ARK_API_KEY ?? process.env.ARK_API_KEY ?? "").trim();
  const model = (process.env.ARK_IMAGE_MODEL ?? process.env.SEEDREAM_MODEL ?? "").trim();
  const enabled = (process.env.HR_PORTRAIT_ENABLED ?? "1") !== "0";
  if (!enabled || !apiKey || !model) {
    return { enabled: false };
  }
  // Only the private input carries images resolved and hashed by the scoped director asset library.
  const resolvedAnchors = directorIdentityImages.filter((value): value is string => typeof value === "string" && path.isAbsolute(value));
  const anchors = resolvedAnchors.length ? resolvedAnchors : (process.env.HR_PORTRAIT_ANCHORS ?? "")
    .split(",").map((value) => value.trim()).filter(Boolean);
  return {
    enabled: true,
    apiKey,
    model,
    baseUrl: process.env.ARK_BASE_URL?.trim(),
    size: process.env.ARK_IMAGE_SIZE?.trim(),
    timeoutMs: Number(process.env.HR_PORTRAIT_TIMEOUT_MS ?? 240_000),
    maxReferenceImages: 4,
    /** 参考图相对仓库根解析（brief 里登记的是 var/media/... 相对路径） */
    referenceImages: collectReferenceImages(metadata).map((image) =>
      path.isAbsolute(image) ? image : path.join(REPO_ROOT, image)),
    characterAnchorImages: anchors.map((image) => (path.isAbsolute(image) ? image : path.join(REPO_ROOT, image))),
    /**
     * 生产链路 fail-closed：角色定妆照必须带"角色档案"描述。
     * 真机事故 2026-09-23：描述为空时模型自由发挥，要求"三十岁上下女性"却出了男性模特，
     * 直接污染真人出镜链路。（vendor 直跑保持默认 false，不影响其它产品。）
     */
    requireCharacterDescription: true,
  };
}

/**
 * 异步启动一条预生产流水线（不阻塞 tRPC 响应；失败只反映在注册表投影）
 * @throws StudioWorkerError LLM_MISSING —— LLM_* 四环境变量未配齐（禁止静默降级）
 */
type StudioRunInput = RunInput & {
  /** 原始客户需求；pipelineIntent 可能清理过路由语句并追加了系统口径。 */
  rawIntent?: string;
  /** 同一入口已经做过选型时复用其受控结果，避免二次选型改写取证依据。 */
  selectedScenePolicy?: ReturnType<typeof resolveScenePolicyForIntent>;
  /** 同一入口已经做过平台识别时复用其受控结果。 */
  selectedPlatform?: ReturnType<typeof resolvePlatformForIntent>;
  creativeDelegation?: CreativeDelegation;
  deliveryTargetPlan?: DeliveryTargetPlan;
  allocatedRunId?: string;
  /** 服务端导演工位先按工作区、本人授权与字节哈希解析；不得来自客户metadata。 */
  directorIdentityImages?: string[];
};

export function startRun(scope: Scope, input: StudioRunInput): string {
  assertPublicStudioMetadata(input.metadata);
  const directorMode=Boolean(input.creativeDelegation);
  if (input.directorIdentityImages !== undefined && !directorMode) {
    throw new StudioWorkerError("DELEGATION_REQUIRED", "内部图片参数必须绑定当前项目真实导演委托");
  }
  const effectiveProducerMode:ProducerMode=directorMode?"review":PRODUCER_MODE;
  const directorProfile=directorMode?buildDirectorDefaults({intent:input.rawIntent??input.intent,
    identityAssets:input.creativeDelegation!.identityAssetRefs,
    history:Array.isArray(input.metadata?.directorPreferences)?input.metadata!.directorPreferences as Array<Record<string,unknown>>:[],
    projectConstraints:{presentation:input.metadata?.presentation??{}}}):null;
  const deliveryTargetPlan=input.deliveryTargetPlan??(directorMode?resolveDeliveryTargets(input.rawIntent??input.intent):null);
  if(directorProfile?.requiredInputs.length) throw new StudioWorkerError("IDENTITY_ASSET_REQUIRED","本人出镜需要已有本人素材；添加一次后可复用。");
  // 补跑/恢复同样经过选型；歧义或知识库损坏在任何供应商调用之前同步失败。
  const selectedScenePolicy = input.selectedScenePolicy
    ?? resolveScenePolicyForIntent(input.rawIntent ?? input.intent, input.metadata);
  /**
   * 平台识别同样在任何供应商调用之前完成：未识别到平台时按默认口径（抖音）落地，
   * 并把画幅/语速/钩子窗口口径写进需求正文——此前只在 CLI 传 --platform 时生效。
   */
  const selectedPlatform = input.selectedPlatform
    ?? resolvePlatformForIntent(input.rawIntent ?? input.intent, input.metadata);
  const resolvedMetadata: Record<string, unknown> = {
    ...(input.metadata ?? {}),
    platform: selectedPlatform.decision.id,
    scenePolicySelection: selectedScenePolicy.decision,
    platformSelection: selectedPlatform.decision,
    ...(selectedScenePolicy.policy ? { scenePolicy: selectedScenePolicy.metadata.scenePolicy } : {}),
    ...(directorMode?{creativeMode:"director_auto",directorProfile,deliveryTargetPlan}:{}),
  };
  const runInput: RunInput = {
    projectId: input.projectId,
    intent: appendPlatformGuidance(appendScenePolicyGuidance(input.intent, selectedScenePolicy.policy), selectedPlatform.decision)
      +(directorProfile?directorGuidance(directorProfile):""),
    metadata: resolvedMetadata,
    isMarketing: input.isMarketing,
  };
  if ((process.env.ARCHIVE_ENABLED ?? "1") === "0") {
    throw new StudioWorkerError("ARCHIVE_REQUIRED", "生产预生产必须启用档案与运行租约，拒绝 ARCHIVE_ENABLED=0");
  }
  const llm = WorkloomLLMEngine.fromEnv();
  if (!llm) {
    throw new StudioWorkerError(
      "LLM_MISSING",
      "LLM 引擎未配置（需 LLM_BASE_URL/LLM_API_KEY/LLM_MODEL），拒绝启动预生产（vendor 纪律：禁止静默降级）",
    );
  }
  // v3.0 收口：注入路由配置——预生产全部 LLM 调用经 routeSmart
  // （preproduction 场景 × 降级链 × 真实计量 × model.call 事件留痕，fastModel 快速调用强制 L1）
  const studioRouter={
    providers: poolFromEnv(),
    sink: new GatewayEventSink(getGatewayPool(), scope, { id: "video-studio" }),
    policy: modelPolicyFor("ai-video"),
    scene: "preproduction",
  };
  if(directorMode)llm.attachConfiguredRouter(studioRouter);else llm.attachRouter(studioRouter);

  /**
   * vendor 自建 LLMEngine 也要接到宿主模型路由（2026-09-21 真机修复）：
   * 剧本引擎/需求洞察等子引擎会自己 new 一个引擎读 vendor 的环境变量与模型名，
   * 不桥接就会出现「LLM引擎返回失败: API Key 未配置」→ 预生产在 Layer 1 直接失败。
   */
  installVendorEngineBridge(llm);
  // 逐镜渲染的入参归一（空 portraits 数组会以 characterRef.split 崩溃，见 vendor-compat.ts）
  installVendorRenderCompatBridge();
  /**
   * 定妆照绑定桥：把「定妆照集」回填成渲染认得 `characterRef`（真机 2026-09-21：
   * vendor 只写 portraitBindings，渲染侧读 characterRef，中间断线 → 出了图也报
   * BINDING_MANIFEST_INVALID）。索引跑完预生产才落盘，故用惰性读取。
   */
  const runWorkDir = path.join(WORK_DIR, "workspaces", scope.workspaceId);
  const portraitIndexPath = path.join(runWorkDir, "characters", input.projectId, "portrait-index.json");
  const uninstallPortraitBinding = installVendorPortraitBindingBridge({
    resolveIndex: () => {
      try {
        if (!existsSync(portraitIndexPath)) return null;
        return JSON.parse(readFileSync(portraitIndexPath, "utf8")) as PortraitIndex;
      } catch {
        return null;
      }
    },
    maxCharactersPerShot: 1,
    log: (line) => console.log(line),
  });
  /** run 期间的全部 console 输出落盘（逐环节审计证据；run 结束摘除） */
  const restoreRunLogs = teeRunLogs(input.projectId);
  console.log(`[studio-worker] run 日志开始落盘：${path.join(WORK_DIR, "logs", `${input.projectId}.log`)}`);

  const entry: RunEntry = {
    runId: input.allocatedRunId??newId("RUN"),
    projectId: input.projectId,
    workspaceId: scope.workspaceId,
    status: "running",
    currentGate: null,
    pendingApprovalId: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    resultSummary: null,
    aborted: false,
  };
  runs.set(entry.runId, entry);

  /**
   * ================= 制片档案（T-2026-0926-0001） =================
   *
   * 认领、输入、输出及终结回执是执行前置证据；初始化失败即停止。
   * 生产入口禁止通过 ARCHIVE_ENABLED=0 关闭档案与运行租约。
   * 管线类型：营销片（含情报层）/ 叙事片，落进 manifest.pipelineKind 供跨会话承接。
   */
  const pipelineKind: PipelineKind = input.isMarketing ? "marketing" : "narrative";
  const archive = new ArchiveStore(path.resolve(WORK_DIR), scope.workspaceId, input.projectId, pipelineKind, {
    aspectRatio: runInput.metadata?.aspectRatio ?? null,
    scenePolicy: selectedScenePolicy.decision,
  });
  /** 结构化日志镜像的"当前环节"（StageRunner 在环节边界更新；与文本 tee 并行） */
  const stageRef: { name: string | null; attempt: number } = { name: null, attempt: 0 };
  const runner = new StageRunner(archive, makeLedgerWriter(scope), entry.runId, {
    onStart: (stageId, attempt) => {
      stageRef.name = stageId;
      stageRef.attempt = attempt;
    },
  });
  /** 交接包线索（来自真实事件，不猜）：门裁决 + 时长投影 */
  const decisionLog: string[] = [];
  const gateProofs = new Map<string, Record<string, unknown>>();
  let completedVendorResult: Awaited<ReturnType<VideoStudio["runPreproduction"]>> | null = null;

  const onEvent: EventSink = async (e) => {
    try {
      if (e.kind === "pipeline.duration.projected") {
        const target = (e.payload as { targetSeconds?: unknown } | undefined)?.targetSeconds;
        const source = (e.payload as { source?: unknown } | undefined)?.source;
        if (typeof target === "number" && target > 0) {
          decisionLog.push(`时长：投影目标 ${target}s${typeof source === "string" ? `（source=${source}）` : ""}`);
        }
      } else if (e.kind === "pipeline.gate.resolved") {
        const payload = (e.payload ?? {}) as { approved?: unknown; reason?: unknown };
        decisionLog.push(
          `门 ${e.gate ?? "-"}：${payload.approved ? "放行" : "打回"}${payload.reason ? `（${String(payload.reason).slice(0, 120)}）` : ""}`,
        );
      }
      if (decisionLog.length > 20) decisionLog.splice(0, decisionLog.length - 20);
    } catch (err) {
      console.error(`[archive] 交接线索采集失败（不影响运行）: ${(err as Error).message}`);
    }
    /**
     * 进度心跳（规格书 §5.2 写盘点②）：预生产单环节跑几十分钟，没有心跳就无法区分
     * 「慢」与「死」。vendor 的门请求/放行、时长投影就是真实进度信号，直接转成档案心跳
     * （文件 events.jsonl + PG last_heartbeat_at，PG 侧 5s 节流）。
     */
    if (runner && (e.kind === "pipeline.gate.requested" || e.kind === "pipeline.gate.resolved" || e.kind === "pipeline.duration.projected")) {
      const ctx = runner.currentContext();
      if (ctx) {
        void ctx.heartbeat({ event: e.kind, ...(e.gate ? { gate: e.gate } : {}) }).catch((err) => {
          console.error(`[archive] heartbeat 写入失败: ${(err as Error).message}`);
        });
      }
    }
    await gatewayAppend(getGatewayPool(), { ...scope, actor: { ...WORKER_ACTOR } }, {
      who: { ...WORKER_ACTOR },
      context: {
        tenant_id: scope.tenantId, workspace_id: scope.workspaceId,
        time: new Date().toISOString(), channel: "inapp",
      },
      object: { type: "video_project", id: e.projectId },
      decision: {
        action: e.kind,
        after: { runId: e.runId ?? entry.runId, gate: e.gate ?? null, ...(e.payload ?? {}) },
      },
      rule_impact: [],
    });
  };

  const onApproval: ApprovalCallback = async (req) => {
    // ApprovalCallback.gate 声明为 string，但适配层（studio.ts）保证已 resolveGate 过，运行时为 GateKey
    const gate = req.gate as GateKey;
    const gateObj = gateObjectOf(gate, req.vendorType);
    const objectId = gate === "G7_FINAL" ? input.projectId : `${input.projectId}:${gate.toLowerCase()}`;
    /**
     * 内部准备门：**AI 监制评审** + 留痕（不插 approvals 行）。
     * 与下面的人工门共用同一事务口径：门事件经安全网关落事件账本（过程与时间线可见），
     * 审批中心只保留真正的业务决策与花钱/对外门。
     *
     * 裁决三类：① 评审放行 → approved；② 评审打回 → approved:false（vendor 中止本 run，由发起方重跑）；
     * ③ `HR_PRODUCER=auto` → 旧的无条件放行（应急口径，事件里标注 autoApproved 以便审计）。
     */
    if (AUTO_GATES.has(gate) && effectiveProducerMode !== "human" && gate!=="G5_PORTRAIT") {
      const producerStage = GATE_PRODUCER_STAGE[gate] ?? "script";
      let producerVerdict: Awaited<ReturnType<typeof reviewStage>> | null = null;
      if (effectiveProducerMode === "review") {
        /**
         * 门内容落盘后送审（真机根因修复）：此前传的是 `${gate}:${vendorType}` 标签路径，
         * `reviewStage` 读不到文件 → 监制只看到 rubric 里的 600 字摘录 → 文档后半段
         * （需求契约/结论摘要等）等于不存在，连续三轮把 G3 判成"契约缺失"。
         */
        const artifact = writeGateArtifact(runWorkDir, path.join(input.projectId, `attempt-${stageRef.attempt}`), gate, req.contentMd ?? "");
        producerVerdict = await reviewStage({
          stage: producerStage,
          projectId: input.projectId,
          artifacts: [{ path: artifact.path, kind: "text", note: req.title }],
          deterministic: gateDeterministicChecks(gate, req.contentMd ?? ""),
          rubric: [
            ...((GATE_RUBRIC[gate] ?? []) as string[]),
            `门内容全长 ${artifact.chars} 字，已随附件送审；摘录（供定位，不是全文）：${(req.contentMd ?? "").slice(0, 600)}`
          ],
          context: { gate, vendorType: req.vendorType, runId: entry.runId, contentChars: (req.contentMd ?? "").length },
          // 内部准备门默认 fail-closed：评审模型不可用即打回，不静默放行
          allowFallbackApprove: (process.env.HR_PRODUCER_FALLBACK_APPROVE ?? "0") === "1",
          log: (line) => console.log(line)
        });
      }
      const approved = effectiveProducerMode === "auto" ? true : Boolean(producerVerdict?.approved);
      /**
       * 门外账本字段（2026-09-25）：把平台门按 **step_key** 记账，与 CLI 运行时同一套口径。
       * 能一一对应的门（G5/G6/G7）在事件 payload 里带 `stepKey` 与规范化 `gateEvent`；
       * 未知/未映射门返回 null，payload 保持原样（**不猜映射**，审计一眼能看出"这个门没有 step_key"）。
       */
      const gateRecord = buildServerGateRecord({
        gate,
        vendorType: String(req.vendorType ?? ""),
        projectId: input.projectId,
        runId: entry.runId,
        approved,
        verdict: producerVerdict,
        producerMode: effectiveProducerMode
      });
      const autoClient = await getAppPool().connect();
      try {
        await autoClient.query("BEGIN");
        await autoClient.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
        await autoClient.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
        await gatewayAppendOnClient(autoClient, { ...scope, actor: { ...WORKER_ACTOR } }, {
          who: { ...WORKER_ACTOR },
          context: {
            tenant_id: scope.tenantId, workspace_id: scope.workspaceId,
            time: new Date().toISOString(), channel: "inapp",
          },
          object: { type: gateObj.type, id: objectId },
          decision: {
            action: gateObj.action,
            after: withGateLedger({
              gate: req.gate, vendorType: req.vendorType, runId: entry.runId, title: req.title,
              producerMode: effectiveProducerMode,
              approved,
              ...(producerVerdict
                ? {
                    score: producerVerdict.score, via: producerVerdict.via, model: producerVerdict.model ?? null,
                    degraded: producerVerdict.degraded, issues: producerVerdict.issues.slice(0, 5),
                    suggestions: producerVerdict.suggestions.slice(0, 5), reason: producerVerdict.reason
                  }
                : { autoApproved: true }),
            }, gateRecord),
            basis: effectiveProducerMode === "auto"
              ? ["HR_PRODUCER=auto（应急口径）：内部准备门无条件放行，产出作为过程与时间线留痕"]
              : [`AI 监制门（${producerStage}）：确定性硬闸 + 模型评审后${approved ? "放行" : "打回重跑"}；人审只保留给花钱与对外动作`],
          },
          rule_impact: [],
        });
        await autoClient.query("COMMIT");
      } catch (err) {
        await autoClient.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        autoClient.release();
      }
      gateProofs.set(gate, { gate, approved, status: producerVerdict?.status ?? "unverified",
        via: producerVerdict?.via ?? "auto", degraded: producerVerdict?.degraded ?? true,
        model: producerVerdict?.model ?? null, evidence: producerVerdict?.evidence ?? [],
        ...(producerVerdict?.status === "not_applicable" ? { basis: producerVerdict.reason } : {}) });
      if (effectiveProducerMode === "auto") {
        return { approved: true, reason: `auto-approved(${req.gate})`, suggestions: [] };
      }
      return producerVerdict
        ? {
            approved,
            reason: producerVerdict.approved
              ? `producer-approved(${req.gate} · score=${producerVerdict.score} · via=${producerVerdict.via})`
              : `producer-rejected(${req.gate} · score=${producerVerdict.score})：${producerVerdict.reason}`,
            suggestions: producerVerdict.suggestions,
            fatal: producerVerdict.approved ? undefined : "producer_rejected"
          }
        : { approved: false, reason: `producer-unavailable(${req.gate})`, fatal: "producer_unavailable" };
    }
    /**
     * G5 定妆照：**默认人审**（T-2026-1001-0007，G5 已移出 AUTO_GATES 默认表）。
     * ① 事实核验先行：实际出图 / 必需角度 / 文件可读，不成立即 fail-closed（不占用人类时间，也不自动重出）；
     * ② 事实成立 → 把逐张文件清单写进审批内容，交给人类看过原图后放行或退回；
     * ③ 机器像不像/监制判据不参与这里的决策，也不会触发自动重做。
     */
    let humanContentMd = req.contentMd ?? "";
    let portraitFiles:Array<{file:string;sha256:string;subject:string;angle:string}>=[];
    if (gate === "G5_PORTRAIT") {
      const portrait = portraitGateEvidence({
        workDir: runWorkDir,
        projectId: input.projectId,
        stage: completedVendorResult?.stages?.portraitStudio,
        scriptReport: (completedVendorResult?.stages?.scriptEngine as { report?: unknown } | undefined)?.report,
      });
      if (portrait.notApplicable) {
        gateProofs.set("G5_PORTRAIT", { gate, approved: true, status: "not_applicable", via: "deterministic",
          degraded: false, model: null, evidence: [], basis: "no-characters-or-products" });
        return { approved: true, reason: "no-characters-or-products", suggestions: [] };
      }
      const evidenceFailed = portrait.deterministic.filter((check) => check.hard === true && check.pass === false);
      if (evidenceFailed.length > 0) {
        gateProofs.set("G5_PORTRAIT", { gate, approved: false, status: "failed", via: "deterministic",
          degraded: false, model: null, evidence: portrait.deterministic });
        return {
          approved: false,
          reason: `portrait-evidence-failed：${evidenceFailed.map((check) => check.detail).join("；")}`,
          suggestions: [],
          fatal: "portrait_evidence_missing",
        };
      }
      const manifest=portraitReviewManifest({workDir:runWorkDir,projectId:input.projectId});
      portraitFiles=manifest.files;
      humanContentMd = `${humanContentMd}\n\n${manifest.markdown}`;
      if(directorMode) {
        const delegation=await verifyDirectorGrant({...scope,projectId:input.projectId,runId:entry.runId},input.creativeDelegation);
        const artifact=writeGateArtifact(runWorkDir,path.join(input.projectId,`attempt-${stageRef.attempt}`),gate,humanContentMd);
        // Creative acceptance is explicitly delegated. Identity authorization and image facts are still mandatory.
        const evidence=[{scope:"complete-text",path:artifact.path,sha256:renderSha256(readFileSync(artifact.path))},
          ...portraitFiles.map(file=>({scope:"image",path:file.file,sha256:file.sha256,subject:file.subject,angle:file.angle}))];
        if(!evidence.some(e=>e.scope==="image")) throw new Error("PORTRAIT_EVIDENCE_REQUIRED：委托创作不能代替实际图片");
        gateProofs.set(gate,{gate,approved:true,status:"passed",via:"delegated-creative-review",degraded:false,
          model:null,evidence,delegation,profileHash:directorProfile!.profileHash});
        await gatewayAppend(getGatewayPool(),{...scope,actor:WORKER_ACTOR},{who:WORKER_ACTOR,
          context:{tenant_id:scope.tenantId,workspace_id:scope.workspaceId,time:new Date().toISOString(),channel:"inapp"},
          object:{type:"video_project",id:input.projectId},decision:{action:"video.creative.portrait.accepted",
            after:{runId:entry.runId,gate,policyHash:delegation.policyHash,grantEventId:delegation.grantEventId,
              profileHash:directorProfile!.profileHash,evidence},basis:["当前项目真实委托内的创作选择；实际图片事实已核实，机器美感分不触发付费重出"]},rule_impact:[]});
        return {approved:true,reason:"delegated-creative-review",suggestions:[]};
      }
    }
    /* HR_PRODUCER=human 或门不在 AUTO_GATES 内 → 落到下面的人工审批分支（插 approvals 行等人点） */
    // D16（#1/A）：门动作事件与 approvals 行同一事务同一 COMMIT（模仿 fence.confirmDryRun 口径）
    const client = await getAppPool().connect();
    let approvalId: string;
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
      const ev = await gatewayAppendOnClient(client, { ...scope, actor: { ...WORKER_ACTOR } }, {
        who: { ...WORKER_ACTOR },
        context: {
          tenant_id: scope.tenantId, workspace_id: scope.workspaceId,
          time: new Date().toISOString(), channel: "inapp",
        },
        object: { type: gateObj.type, id: objectId },
        decision: {
          action: gateObj.action,
          after: { gate: req.gate, vendorType: req.vendorType, runId: entry.runId, title: req.title },
          basis: [`预生产确认门 ${req.gate}（§3 门矩阵：${gateObj.action} 默认 review）`],
        },
        rule_impact: [],
      });
      approvalId = `apr-${ev.eventId.toLowerCase()}`;
      await client.query(
        `INSERT INTO approvals (approval_id, tenant_id, workspace_id, event_id, channel, status, snapshot)
         VALUES ($1,$2,$3,$4,'inapp','pending',$5)
         ON CONFLICT (event_id, channel) DO NOTHING`,
        [
          approvalId, scope.tenantId, scope.workspaceId, ev.eventId,
          /**
           * W-04 举一反三：这一支是"人工确认门"（HR_PRODUCER=human 或门不在 AUTO_GATES 内），
           * 按模块自述"人审只保留给花钱与对外动作"——必须在快照上显式声明高危，
           * 否则批量采纳入口会把"逐门确认"降级成一键放行（第三方实测同类的 l4 种子审批即被批量放行）。
           */
          // B-01 修复：G8 渲染提交/G9 发布/G10 对外评论均为花钱/对外门，快照必须显式携带高危标记——
          // 批量审批守卫与演示脚本的 lowRisk 过滤都读 high_risk，缺失即守卫空转（此前可一键批量照批对外发布）。
          // B-07 修复：补 expires_at（与 pollApproval 超时同口径）——此前快照无过期位，decide/expireSweep 永不标 expired
          JSON.stringify({
            contentMd: humanContentMd, gate: req.gate, vendorType: req.vendorType, high_risk: true,
            expires_at: new Date(Date.now() + APPROVAL_TIMEOUT_MS).toISOString(),
          }),
        ],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    entry.currentGate = gate;
    entry.pendingApprovalId = approvalId!;
    entry.status = "awaiting_approval";
    const verdict = await pollApproval(entry, scope, approvalId!);
    entry.currentGate = null;
    entry.pendingApprovalId = null;
    if (entry.status === "awaiting_approval") entry.status = "running";
    /** G5 的放行/否决来自人类验收（T-2026-1001-0007）：把人类裁决写进本次门证据，供终态完整性核对与审计 */
    if (gate === "G5_PORTRAIT") {
      gateProofs.set(gate, { gate, approved: verdict.approved, status: verdict.approved ? "passed" : "failed",
        via: "owner-acceptance", degraded: false, model: null, approvalId:approvalId!,
        evidence:portraitFiles.map(file=>({scope:"image",path:file.file,sha256:file.sha256,subject:file.subject,angle:file.angle})) });
    }
    return verdict;
  };

  let marketingDossierRoot: string | undefined;
  let marketingDossierRef: string | undefined;
  const studioConfig: StudioConfig = {
    llm,
    workDir: runWorkDir,
    onApproval,
    onEvent,
    totalDeadlineMs: TOTAL_DEADLINE_MS,
    // 片型硬闸必须在 G8 之前审完整分镜，禁止 env 让 vendor 在审计前直接渲染。
    deferRender: selectedScenePolicy.policy ? true : (process.env.HR_DEFER_RENDER ?? "1") !== "0",
    portraits: portraitConfig(runInput.metadata, directorMode ? input.directorIdentityImages : undefined),
    /** 营销路由 → 情报五站真跑（叙事路由不装配，vendor 也不会进情报层） */
    dataMining: input.isMarketing ? undefined : dataMiningConfigFor(runInput.metadata, llm, scope.workspaceId),
    log: (line) => console.log(line),
  };

  // 异步执行：不阻塞 tRPC 响应；终态只写注册表投影（生命周期事件由 onEvent 落库）
  void (async () => {
    /**
     * 项目级执行者租约（规格书 §11：同一项目同一时刻只允许一个执行者，杜绝双写与重复烧额度）。
     * 会话级 advisory lock 持有到 run 结束；进程被 kill -9 → 连接断开 → 锁自动释放。
     */
    let activeLease: Awaited<ReturnType<typeof acquireProjectLease>> = null;
    let detachStructuredLog: (() => void) | null = null;
    let projectMeta: Awaited<ReturnType<typeof readProjectMeta>> = null;
    try {
      activeLease = await acquireProjectLease(scope, input.projectId);
      if (!activeLease) {
        throw new Error(`项目 ${input.projectId} 已有执行者持有档案租约（不重复启动，避免双份烧额度）`);
      }
      projectMeta = await readProjectMeta(scope, input.projectId);
      if (!projectMeta) throw new Error(`PROJECT_NOT_FOUND: 项目 ${input.projectId} 不存在或不属于当前工作区`);
      if (projectMeta.kind !== pipelineKind) throw new Error("PIPELINE_KIND_MISMATCH：预生产管线与服务项目类型不一致");
      if(directorMode) await verifyDirectorGrant({...scope,projectId:input.projectId,runId:entry.runId},input.creativeDelegation);
      await archive.ensure({ kind: projectMeta.kind, title: projectMeta.title, createdAt: projectMeta.createdAt });
      // 既有项目补跑可能改用新的明确片型；manifest 保存当前决策，旧值留在追加事件中。
      const manifest = await archive.readManifest();
      if (!manifest) throw new Error(`项目 ${input.projectId} 制片档案 manifest 缺失`);
      if (JSON.stringify(manifest.routeMeta?.scenePolicy ?? null) !== JSON.stringify(selectedScenePolicy.decision)) {
        const previous = manifest.routeMeta?.scenePolicy ?? null;
        await archive.writeJsonAtomic("manifest.json", {
          ...manifest,
          routeMeta: { ...(manifest.routeMeta ?? {}), scenePolicy: selectedScenePolicy.decision },
          updatedAt: new Date().toISOString(),
        });
        await archive.appendJsonl("events.jsonl", {
          kind: "scene-policy.route-changed", runId: entry.runId,
          previous, current: selectedScenePolicy.decision,
        });
      }
      detachStructuredLog = attachStructuredLog(archive, {
        currentStage: () => stageRef.name,
        currentAttempt: () => stageRef.attempt,
      });
      await archive.appendJsonl("events.jsonl", {
        kind: "run.started", runId: entry.runId, pipelineKind,
        threadId: projectMeta.threadId, intent: input.intent.slice(0, 200),
        scenePolicy: selectedScenePolicy.decision,
      });
      await gatewayAppend(getGatewayPool(), { ...scope, actor: { ...WORKER_ACTOR } }, {
        who: { ...WORKER_ACTOR },
        context: {
          tenant_id: scope.tenantId, workspace_id: scope.workspaceId,
          time: new Date().toISOString(), channel: "inapp",
        },
        object: { type: "video_project", id: input.projectId },
        decision: {
          action: "video.scene_policy.selected",
          after: { runId: entry.runId, ...selectedScenePolicy.decision },
          basis: ["原始需求与已安装片型知识条目在生成前确定性匹配；未命中仍留空选择证据"],
        },
        rule_impact: [],
      });
      /**
       * AI 监制打回 → **默认打回即停，不再自动重跑**（T-2026-1001-0007）。
       *
       * 为什么改：自动重跑会把"AI 认为不合适"直接变成"再花钱重出一遍"，
       * 真机上正是"打回 → 自动重跑（含重新出图）→ 再打回"的烧钱循环。
       * 现在 AI 监制只负责**把问题提前暴露**；打回即停并如实上报，是否重做由人决定。
       * 显式设 `VM_PRODUCER_RETRY=1`（或更大）才恢复旧的有上限自动重跑口径。
       *
       * 制片档案口径（T-2026-0926-0001）：每次重跑 = 新 attempt（`claimRun` 原子递增），
       * 「第几次尝试、耗时、错误分类」全部落盘，历史不丢。
       */
      const maxAttempts = Math.max(1, Number(process.env.VM_PRODUCER_RETRY ?? 0) + 1);
      const runOnce = async (): Promise<Awaited<ReturnType<VideoStudio["runPreproduction"]>>> => {
        const runnerStore = archive;
        // 档案 output 是给索引/交接包使用的摘要，不能取代 vendor 业务结果。
        // confirmations 决定打回重试，stages.dataMining 决定商品档案投影；两者必须完整保留。
        let rawResult: Awaited<ReturnType<VideoStudio["runPreproduction"]>> | undefined;
        await runner.run(
          "preproduction",
          { intent: runInput.intent, isMarketing: input.isMarketing ?? false, pipelineKind, scenePolicy: selectedScenePolicy.decision },
          async (ctx) => {
            gateProofs.clear();
            completedVendorResult = null;
            /**
             * 断点快照（真机发现的方案缺陷修复，T-2026-0926-0001 留痕）：
             * vendor 在 Phase checkpoint 指纹不匹配时会**删除**自己的 checkpoint
             * （production-engine.js#_loadLatestCheckpoint），"曾经有断点但恢复没命中"这段证据
             * 会被重跑就地销毁。开跑前先只读快照进档案，供恢复对账与工程发现。
             */
            const preCheckpoints = await runnerStore
              .snapshotExternalDir(
                path.resolve(runWorkDir, "checkpoints", input.projectId),
                `checkpoints/attempt-${ctx.attempt}-before`,
                { filter: (name) => name.endsWith(".json") },
              )
              .catch((err) => {
                console.error(`[archive] 断点快照失败（继续执行）: ${(err as Error).message}`);
                return { files: 0, bytes: 0, skipped: [] as string[] };
              });
            let marketing: PreparedMarketingFacts | undefined;
            let g1Approved = true;
            if (input.isMarketing) {
              marketing = await prepareMarketingFacts({ scope: { ...scope, projectId: input.projectId, runId: entry.runId, attempt: ctx.attempt },
                root: archive.root, metadata: input.metadata ?? {}, intent: input.intent, llm });
              const verdict = await onApproval({ runId: entry.runId, gate: "G1_DOSSIER", vendorType: "host-source-dossier",
                title: "本次营销来源正文与逐主张事实审核", contentMd: marketing.g1Content });
              const proof = gateProofs.get("G1_DOSSIER");
              g1Approved = verdict.approved === true && proof?.status === "passed" && proof?.via === "llm" && proof?.degraded === false
                && typeof proof.model === "string" && proof.model.length > 0
                && Array.isArray(proof.evidence) && proof.evidence.some(item => item?.scope === "complete-text" && item?.sha256 === renderSha256(marketing!.g1Content));
              marketingDossierRoot = marketing.storeRoot;
              marketingDossierRef = path.posix.join("archive", scope.workspaceId, input.projectId, `${marketing.prefix}-dossier`);
            }
            const studio = new VideoStudio({ ...studioConfig, ...(marketing ? { dataMining: {
              mode: "api", storeRoot: marketing.storeRoot, refresh: true,
              verifiedRaw: { projectId: input.projectId, rawJson: canonicalRenderJson(marketing.raw), sha256: marketing.bundle.rawSha256, productQuery: marketing.bundle.productQuery },
            } } : {}) });
            /**
             * 传入 runInput（而不是 input）：它带上了本轮的片型选型结论与注入指引，
             * vendor 的提示词/分镜必须按本次选中的知识条目生成；G1 营销事实仍取自原始 input。
             */
            const r: Awaited<ReturnType<VideoStudio["runPreproduction"]>> = g1Approved ? await studio.runPreproduction(runInput) : {
              success: false, stages: {}, confirmations: { hostG1: { approved: false, reason: "producer-rejected(G1_DOSSIER)：本次来源与事实未通过真实监制" } },
            };
            completedVendorResult = r;
            if (r.success) {
              // vendor 真出图批量模式跳过的是生成前询问；服务必须在实际图片存在后完成 G5。
              const portraitVerdict = await onApproval({ runId: entry.runId, gate: "G5_PORTRAIT", vendorType: "portrait-generation",
                title: "实际定妆照完整性与视觉审核", contentMd: JSON.stringify({ portraitStudio: r.stages?.portraitStudio,
                  scriptReport: (r.stages?.scriptEngine as { report?: unknown } | undefined)?.report }) });
              r.confirmations = { ...((r.confirmations ?? {}) as Record<string, unknown>), hostPortraits: portraitVerdict };
              if (!portraitVerdict.approved) r.success = false;
            }
            if (r.success) {
              const missing = [...(input.isMarketing ? ["G1_DOSSIER"] : []), "G2_THEME", "G3_INSIGHT", "G4_PRD", "G5_PORTRAIT", "G6_PROMPT", "G7_FINAL"].filter(gate => {
                const proof = gateProofs.get(gate);
                return !(proof?.approved === true && (proof.status === "passed" && ((proof.via === "llm" && proof.degraded === false)
                  || (gate === "G5_PORTRAIT" && ["owner-acceptance","delegated-creative-review"].includes(String(proof.via)) && proof.degraded === false))
                  || gate === "G5_PORTRAIT" && proof.status === "not_applicable" && proof.basis === "no-characters-or-products"));
              });
              if (missing.length) {
                r.success = false;
                r.confirmations = { ...((r.confirmations ?? {}) as Record<string, unknown>), hostQualification: { approved: false,
                  reason: `producer-rejected：缺少服务监制裁决 ${missing.join(",")}`, fatal: "producer_rejected" } };
              }
            }
            rawResult = r;
            await ctx.heartbeat({ stages: Object.keys(r.stages ?? {}) });
            const vendorResumed = (r as unknown as { resumed?: unknown }).resumed === true;
            const vendorDegraded = (r as unknown as { degraded?: unknown }).degraded === true;
            if (preCheckpoints.files > 0) {
              await ctx.log(
                "info",
                `断点快照 ${preCheckpoints.files} 个文件 / ${preCheckpoints.bytes}B；本轮 vendor resumed=${vendorResumed}`,
                { files: preCheckpoints.files, resumed: vendorResumed, attempt: ctx.attempt },
              );
              decisionLog.push(
                `第 ${ctx.attempt} 次尝试：开跑前存在 ${preCheckpoints.files} 个 Phase checkpoint，本轮 resumed=${vendorResumed}`,
              );
            }
            /**
             * 环节自评（诚实台账）：vendor 跑完但 `success:false`（含 AI 监制打回）时，
             * 台账必须记 failed + 错误分类，否则监控器把真实失败聚类成 BUG 或完全看不见。
             */
            const rejected = isProducerRejection(r);
            /**
             * 失败原因取 vendor 的 `result.errors[]`（真实证据：哪个环节、什么错）。
             * 只写 `success:false` 会让监控把所有业务失败都聚类成 BUG（P0 误升级）。
             */
            const rawErrors = (r as unknown as { errors?: unknown }).errors;
            const vendorErrors = Array.isArray(rawErrors)
              ? (rawErrors as Array<Record<string, unknown>>).slice(0, 10)
              : [];
            const vendorFailure = vendorErrors
              .map((entry) => `${String(entry.stage ?? entry.layer ?? "unknown")}: ${String(entry.message ?? entry.error ?? "")}`.trim())
              .filter(Boolean)
              .join("；");
            const failureMessage = String(
              (r as { error?: unknown }).error
                ?? (r as { errorMessage?: unknown }).errorMessage
                ?? (vendorFailure || "预生产未成功（vendor 返回 success:false）"),
            ).slice(0, 500);
            const outcome = r.success
              ? undefined
              : {
                  status: "failed" as const,
                  errorClass: rejected ? "GATE_REJECTED" : classifyError(new Error(failureMessage)),
                  errorMsg: failureMessage,
                };
            /**
             * 营销片：收编情报档案指针（dossier 在档案夹之外，跨会话承接不断链）；
             * 字段口径对齐既有 resultSummary 摘要（studio-worker.ts resultSummary）。
             */
            const dm = (r.stages?.dataMining ?? null) as
              | { status?: string; product_id?: string; data?: { dossier?: { provenance?: unknown[] } } }
              | null;
            /**
             * 提示词包落档案（真机审计发现 D3）：预生产最有价值的产物是 6 镜 × 25/30 字段的完整提示词，
             * 但 vendor 只把它们留在内存与 console（`checkpointDir` 指向的 Phase checkpoint 在成功后
             * 会被 vendor 主动清理）。档案号称"自包含、可跨会话承接"，就必须把提示词本体落盘，
             * 否则新会话拿到档案也接不上下一步（提交渲染/交付）。
             */
            const shots = (
              (r.stages?.productionEngine as { shots?: Array<Record<string, unknown>> } | undefined)?.shots ?? []
            );
            const promptPack = shots.length
              ? {
                  stageId: "preproduction",
                  attempt: ctx.attempt,
                  pipelineKind,
                  scenePolicy: selectedScenePolicy.decision,
                  generatedAt: new Date().toISOString(),
                  shotCount: shots.length,
                  totalPromptChars: shots.reduce((sum, shot) => sum + String(shot.prompt ?? "").length, 0),
                  dossier: dm
                    ? { root: marketingDossierRef ?? `dossiers/${scope.workspaceId}`, productId: dm.product_id ?? null }
                    : null,
                  shots: shots.map((shot) => ({
                    shotId: shot.shot_id ?? shot.shotId ?? null,
                    sceneId: shot.scene_id ?? shot.sceneId ?? null,
                    sceneType: shot.scene_type ?? shot.sceneType ?? null,
                    durationSec: shot.duration ?? null,
                    degraded: shot.degraded === true,
                    promptCharCount: String(shot.prompt ?? "").length,
                    /** 提示词包内的字段序号与名称（`01.【语言约束】…` 口径），供审计核对"25/30 字段是否齐" */
                    promptFieldNames: Array.from(
                      String(shot.prompt ?? "").matchAll(/\d{1,2}\.【([^】]{1,10})】/g),
                    ).map((m) => m[1]),
                    fieldKeys: shot.fields && typeof shot.fields === "object" ? Object.keys(shot.fields as object) : [],
                    prompt: String(shot.prompt ?? "")+(directorProfile?`\n${shotPresentationGuidance(compilePersonPresentation({shot,profile:directorProfile}))}`:""),
                    fields: shot.fields ?? null,
                    ...(directorProfile?{presentationContract:compilePersonPresentation({shot,profile:directorProfile})}:{}),
                  })),
                }
              : null;
            // 可供 full-chain-film 接续的分镜草稿：只传政策身份与 vendor 原始镜头，
            // policyTags/必备画面仍须按知识条目补齐并通过全片硬闸，不能把草稿当成已放行分镜。
            const shotlistArtifact = selectedScenePolicy.policy && shots.length
              ? await ctx.writeArtifact(`stages/preproduction/attempt-${ctx.attempt}.shotlist.json`, {
                  title: projectMeta?.title ?? input.rawIntent ?? input.intent,
                  scenePolicy: {
                    id: selectedScenePolicy.policy.id,
                    version: selectedScenePolicy.policy.version,
                    sourceSha256: selectedScenePolicy.policy.sourceSha256 ?? null,
                    exceptions: (selectedScenePolicy.metadata.scenePolicy as { exceptions?: ScenePolicyException[] } | undefined)?.exceptions ?? [],
                  },
                  scenePolicySelection: selectedScenePolicy.decision,
                  draft: true,
                  shots: shots.map((shot) => ({ ...shot, shotId: shot.shotId ?? shot.shot_id ?? null })),
                })
              : null;
            const promptsArtifact = promptPack
              ? await ctx.writeArtifact(`stages/preproduction/attempt-${ctx.attempt}.prompts.json`, promptPack, {
                  // 超 4MB 时先丢 fields 明细（保留 prompt 全文与字段名），绝不丢整包
                  shrink: (data) => ({
                    ...(data as Record<string, unknown>),
                    fieldsTrimmed: true,
                    shots: (data as { shots: Array<Record<string, unknown>> }).shots.map((shot) => ({ ...shot, fields: null })),
                  }),
                })
              : null;
            const scenePolicyReport = selectedScenePolicy.policy
              ? auditScenePolicy({
                  title: input.rawIntent ?? input.intent,
                  scenePolicy: {
                    id: selectedScenePolicy.policy.id,
                    exceptions: ((selectedScenePolicy.metadata.scenePolicy as { exceptions?: ScenePolicyException[] } | undefined)?.exceptions ?? []),
                  },
                  shots: shots.map((shot): ScenePolicyShot => ({
                    ...shot,
                    shotId: typeof (shot.shotId ?? shot.shot_id) === "string" ? String(shot.shotId ?? shot.shot_id) : "",
                    duration: Number(shot.duration ?? 0),
                  })),
                }, selectedScenePolicy.policy)
              : null;
            if (scenePolicyReport) scenePolicyReport.policy.selection = selectedScenePolicy.decision.reason;
            const scenePolicyReportRef = `stages/preproduction/attempt-${ctx.attempt}.scene-policy-report.json`;
            const scenePolicyReportArtifact = scenePolicyReport
              ? await ctx.writeArtifact(scenePolicyReportRef, scenePolicyReport)
              : null;
            if (scenePolicyReport && (!scenePolicyReportArtifact || scenePolicyReportArtifact.truncated)) {
              throw new Error("片型硬闸：分镜审计报告未完整归档，拒绝继续渲染接续");
            }
            if (scenePolicyReport) {
              await gatewayAppend(getGatewayPool(), { ...scope, actor: { ...WORKER_ACTOR } }, {
                who: { ...WORKER_ACTOR },
                context: {
                  tenant_id: scope.tenantId, workspace_id: scope.workspaceId,
                  time: new Date().toISOString(), channel: "inapp",
                },
                object: { type: "video_project", id: input.projectId },
                decision: {
                  action: "video.scene_policy.audited",
                  after: {
                    runId: entry.runId, attempt: ctx.attempt,
                    policyId: selectedScenePolicy.policy!.id,
                    passed: scenePolicyReport.passed,
                    defects: scenePolicyReport.defects.slice(0, 30),
                    reportRef: scenePolicyReportRef,
                    reportSha256: scenePolicyReportArtifact!.sha256,
                  },
                  basis: ["完整镜头表按时长配比和逐镜证据执行片型硬闸；报告先落档案再裁决"],
                },
                rule_impact: [],
              });
              if (!scenePolicyReport.passed && r.success) {
                const first = scenePolicyReport.defects.slice(0, 5)
                  .map((item) => `${item.shotId ?? "全片"}[${item.rule}] ${item.detail}`).join("；");
                throw new Error(`片型硬闸打回（${scenePolicyReport.defects.length} 项）：${first}；详见 ${scenePolicyReportRef}`);
              }
            }
            if (selectedScenePolicy.policy && (!shotlistArtifact || shotlistArtifact.truncated || !promptsArtifact)) {
              throw new Error("片型硬闸打回：完整分镜草稿或提示词包未归档，拒绝继续渲染接续");
            }
            if (promptsArtifact) {
              decisionLog.push(
                `提示词包已归档：${promptPack!.shotCount} 镜 / ${promptPack!.totalPromptChars} 字符`
                + `（stages/preproduction/attempt-${ctx.attempt}.prompts.json，sha256=${promptsArtifact.sha256.slice(0, 12)}）`,
              );
            }
            const marketingFacts = marketing && r.success && promptPack ? await finalizeMarketingFacts(marketing,
              promptPack.shots.map(shot => ({ shotId: String(shot.shotId ?? ""), prompt: shot.prompt, fields: shot.fields }))) : undefined;
            if (marketing && r.success && !marketingFacts) throw new Error("MARKETING_PROMPTS_UNVERIFIED：营销预生产没有完整最终镜头事实审核");
            return {
              output: {
                success: r.success,
                ...(marketingFacts ? { marketingFactsRef: marketingFacts.ref, marketingFactsSha256: marketingFacts.sha256 } : {}),
                productionEvidence: { schemaVersion: "workloom.preproduction-authority/v1", issuer: "workloom.studio-worker",
                  tenantId: scope.tenantId, workspaceId: scope.workspaceId, projectId: input.projectId,
                  runId: entry.runId, attempt: ctx.attempt, pipelineKind, gates: [...gateProofs.values()],
                  ...(directorMode?{creativeDelegation:input.creativeDelegation,directorProfile,deliveryTargetPlan}:{} ) },
                stages: Object.keys(r.stages ?? {}),
                checkpointDir: `checkpoints/${input.projectId}`,
                ...(promptsArtifact
                  ? {
                      promptsRef: `stages/preproduction/attempt-${ctx.attempt}.prompts.json`,
                      promptsSha256: promptsArtifact.sha256,
                      promptShotCount: promptPack!.shotCount,
                    }
                  : {}),
                ...(shotlistArtifact
                  ? {
                      shotlistRef: `stages/preproduction/attempt-${ctx.attempt}.shotlist.json`,
                      shotlistSha256: shotlistArtifact.sha256,
                    }
                  : {}),
                ...(scenePolicyReportArtifact
                  ? {
                      scenePolicyReportRef,
                      scenePolicyReportSha256: scenePolicyReportArtifact.sha256,
                      scenePolicyPassed: scenePolicyReport!.passed,
                    }
                  : {}),
                ...(preCheckpoints.files > 0
                  ? {
                      preCheckpointSnapshot: {
                        dir: `checkpoints/attempt-${ctx.attempt}-before`,
                        files: preCheckpoints.files,
                        bytes: preCheckpoints.bytes,
                        resumed: vendorResumed,
                      },
                    }
                  : {}),
                resumed: vendorResumed,
                degraded: vendorDegraded,
                ...(failureMessage && !r.success ? { failureMessage } : {}),
                ...(vendorErrors.length ? { failures: vendorErrors } : {}),
                ...(dm
                  ? {
                      dossier: {
                        root: marketingDossierRef ?? `dossiers/${scope.workspaceId}`,
                        productId: dm.product_id ?? null,
                        evidenceCount: Array.isArray(dm.data?.dossier?.provenance)
                          ? dm.data!.dossier!.provenance!.length
                          : 0,
                      },
                    }
                  : {}),
              },
              ...(outcome ? { outcome } : {}),
            };
          },
        );
        if (!rawResult) throw new Error("预生产档案执行器未返回业务结果");
        return rawResult;
      };
      let result = await runOnce();
      let attempts = 1;
      while (attempts < maxAttempts && isProducerRejection(result)) {
        attempts += 1;
        console.log(`[studio-worker] AI 监制打回 → 自动重跑第 ${attempts}/${maxAttempts} 次（同一项目、同一门口径）`);
        result = await runOnce();
      }
      entry.status = result.success ? "finished" : "failed";
      entry.error = result.success ? null : terminalFailureMessageOf(result, entry.error);
      /** 情报层产出摘要（逐环节审计要看得见"档案到底有没有装订出来"） */
      const dataMiningStage = (result.stages?.dataMining ?? null) as
        | { status?: string; product_id?: string; data?: { ok?: boolean; reused?: boolean; dossier?: { gaps?: unknown[]; provenance?: unknown[] } } }
        | null;
      entry.resultSummary = {
        success: result.success,
        stages: Object.keys(result.stages ?? {}),
        producerAttempts: attempts,
        ...(directorMode?{creativeMode:"director_auto",confirmationSteps:0,deliveryTargetPlan,profileHash:directorProfile!.profileHash}:{}),
        ...(dataMiningStage
          ? {
              dataMining: {
                status: dataMiningStage.status ?? null,
                productId: dataMiningStage.product_id ?? null,
                ok: dataMiningStage.data?.ok ?? null,
                reused: dataMiningStage.data?.reused ?? null,
                evidenceCount: Array.isArray(dataMiningStage.data?.dossier?.provenance)
                  ? dataMiningStage.data!.dossier!.provenance!.length
                  : null,
                gaps: Array.isArray(dataMiningStage.data?.dossier?.gaps)
                  ? dataMiningStage.data!.dossier!.gaps!.length
                  : null,
              },
            }
          : {}),
      };

      /**
       * 媒资库自动入库（T-2026-0926-0007 规格书 §3.4）：
       * 定妆照/商品图批量入库（kind=portrait / product_image）+ 营销管线商品档案投影。
       * 旁路写：整体 try/catch，任何失败只记日志，**不改 run 终态**（素材入库不该推翻"片子跑完了"）。
       */
      if ((process.env.MEDIA_INGEST_ENABLED ?? "1") !== "0") {
        try {
          const portraits = await ingestPortraitsFromIndex(getAppPool(), getGatewayPool(), scope, {
            projectId: input.projectId,
            pipelineKind: input.isMarketing ? "marketing" : "narrative",
            indexPath: portraitIndexPath,
            by: "video-studio",
          });
          if (portraits.scanned > 0) {
            console.log(
              `[media-ingest] 定妆照/商品图入库：扫描 ${portraits.scanned}，新增 ${portraits.ingested}，`
              + `去重 ${portraits.deduped}，跳过 ${portraits.skipped}，失败 ${portraits.errors.length}`,
            );
          }
          for (const error of portraits.errors.slice(0, 5)) console.warn(`[media-ingest] 单张入库失败：${error}`);
        } catch (err) {
          console.error(`[media-ingest] 定妆照入库失败（不影响 run 终态）：${(err as Error).message}`);
        }
        const minedProductId = dataMiningStage?.product_id ?? null;
        if (input.isMarketing && minedProductId) {
          try {
            const profile = await upsertProductProfileFromDossier(getAppPool(), getGatewayPool(), scope, {
              dossierRoot: marketingDossierRoot ?? path.join(WORK_DIR, "dossiers", scope.workspaceId),
              productId: minedProductId,
              by: "video-studio",
            });
            console.log(
              `[media-ingest] 商品档案投影：${profile.profile.productName}`
              + `（sha256 ${profile.profile.dossierSha256.slice(0, 12)}…，内容变化=${profile.changed}，主图新入库=${profile.heroIngested}）`,
            );
          } catch (err) {
            console.error(`[media-ingest] 商品档案投影失败（不影响 run 终态）：${(err as Error).message}`);
          }
        }
      }
      /** 终态交接包（改动 D）：跨会话承接只凭 projectId + 档案夹即可续跑，不依赖原始上下文 */
      if (archive) {
        try {
          const producerRejected = isProducerRejection(result);
          const terminalFailureMessage = terminalFailureMessageOf(result, entry.error);
          await updateContextBundle(archive, {
            pipelineKind,
            threadId: projectMeta?.threadId ?? null,
            lastStage: "preproduction",
            ...(result.success
              ? {}
              : {
                  failedStage: "preproduction",
                  /**
                   * 软失败口径（真机审计发现 D2）：vendor 返回 `success:false` 时不一定抛异常，
                   * `entry.error` 常为空字符串——用 `??` 会落进 `new Error("")` 被判成 BUG（误升级 P0）。
                   * 这里按"异常 → result.error → vendor failures[] → 通用兜底"顺序取真实原因。
                   */
                  errorClass: producerRejected
                    ? "GATE_REJECTED"
                    : classifyError(new Error(terminalFailureMessage)),
                  errorMsg: terminalFailureMessage.slice(0, 500),
                }),
            decisions: [
              `预生产${result.success ? "完成" : "**未成功**"}（归档 attempt=${stageRef.attempt || "-"}；本次运行内重试 ${attempts} 次；内部环节 ${Object.keys(result.stages ?? {}).length} 个）`,
              ...decisionLog,
              ...(dataMiningStage
                ? [
                    `情报档案：${marketingDossierRef ?? `dossiers/${scope.workspaceId}`}（商品 ${dataMiningStage.product_id ?? "未标注"}，证据 ${
                      Array.isArray(dataMiningStage.data?.dossier?.provenance)
                        ? dataMiningStage.data!.dossier!.provenance!.length
                        : 0
                    } 条）`,
                  ]
                : []),
            ],
            ...(result.success
              ? { nextSteps: ["预生产完成 → 渲染提交（video.render.submit）或按交付包进入后期/交付段"] }
              : {}),
          });
        } catch (err) {
          console.error(`[archive] 交接包写入失败（不影响运行）: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      entry.status = "failed";
      entry.error = err instanceof Error ? err.message : String(err);
      // 元数据尚未验证时，不为不存在/越权的项目创建失败档案。
      if (projectMeta) {
        try {
          await updateContextBundle(archive, {
            pipelineKind,
            threadId: projectMeta?.threadId ?? null,
            failedStage: "preproduction",
            errorClass: classifyError(err),
            errorMsg: entry.error,
            decisions: decisionLog,
          });
        } catch (bundleErr) {
          console.error(`[archive] 失败交接包写入失败: ${(bundleErr as Error).message}`);
        }
      }
    } finally {
      // 一个清理失败不能跳过其余清理；租约解锁异常由宿主销毁连接，终态仍诚实报告失败。
      for (const cleanup of [
        () => detachStructuredLog?.(),
        () => activeLease?.release(),
        restoreRunLogs,
        uninstallPortraitBinding,
      ]) {
        try {
          await cleanup();
        } catch (cleanupError) {
          const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
          entry.status = "failed";
          entry.error = [entry.error, `运行清理失败：${message}`].filter(Boolean).join("；");
          console.error(`[studio-worker] ${entry.error}`);
        }
      }
      entry.finishedAt = new Date().toISOString();
    }
  })();

  return entry.runId;
}

/**
 * 建视频项目 + 启动标准预生产管线（唯一入口，2026-09-21）：
 *   - video.studio.start（视频页面手起）与 threads.dispatch（右栏「派」识别出视频目标）共用同一条链路，
 *     避免"内容类目标走通用 Quest 规划器、把内部流转步骤照单执行"的分叉；
 *   - 建档行与建档事件同一事务（D16 同口径）；threadId 传入时把任务线程与视频项目关联，
 *     任务详情/时间线因此能看到「已转入标准视频管线」。
 */
export interface StartVideoProjectInput {
  intent: string;
  rawIntent?: string;
  /** 分流器写入商品信息之前的客户 metadata，供片型选择只取客户来源证据。 */
  customerMetadata?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
  /** 调用方显式指定的目标平台（ID 或中文别名）；缺省由需求文本识别，仍缺省则走抖音口径。 */
  platform?: string;
  isMarketing?: boolean;
  by: { id: string; type: "human" | "system" };
  threadId?: string;
  creativeMode?: "director_auto"|"manual";
  deliveryOptions?:{platforms?:string[];versionCount?:number;includeSurprise?:boolean};
  identityAssetRefs?:string[];
}

export async function startVideoProjectRun(
  scope: { tenantId: string; workspaceId: string },
  input: StartVideoProjectInput,
): Promise<{ projectId: string; runId: string }> {
  assertPublicStudioMetadata(input.metadata);
  assertPublicStudioMetadata(input.customerMetadata);
  const directorMode=input.creativeMode!=="manual";
  if(directorMode) {
    const readiness=buildDirectorDefaults({intent:input.rawIntent??input.intent,identityAssets:input.identityAssetRefs??[]});
    if(readiness.requiredInputs.length) throw new StudioWorkerError("IDENTITY_ASSET_REQUIRED","本人出镜需要已有本人素材；添加一次后可复用。");
  }
  const allocatedRunId=newId("RUN");
  const deliveryTargetPlan=directorMode?resolveDeliveryTargets(input.rawIntent??input.intent,input.deliveryOptions??{}):undefined;
  const selectionMetadata = Object.hasOwn(input, "customerMetadata") ? input.customerMetadata ?? undefined : input.metadata;
  const selectedScenePolicy = resolveScenePolicyForIntent(input.rawIntent ?? input.intent, selectionMetadata);
  const selectedPlatform = resolvePlatformForIntent(input.rawIntent ?? input.intent, selectionMetadata, input.platform);
  // 无效片型和平台在偏好查询之前拒绝，避免为不可执行的需求开启任何数据库事务。
  const preferences=directorMode?await readExplicitDirectorPreferences(scope,input.by.id):[];
  const platformMetadata: Record<string, unknown> = {
    ...(input.metadata ?? {}),
    platform: selectedPlatform.decision.id,
    platformSelection: selectedPlatform.decision,
    ...(directorMode?{creativeMode:"director_auto",deliveryTargetPlan,directorPreferences:preferences.map(p=>({origin:"explicit",feedback:p.feedback}))}:{}),
  };
  const client = await getAppPool().connect();
  let projectId = "";
  let creativeDelegation:CreativeDelegation|undefined;
  let discard = false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    // GR-02（2026-09-29 第二次修复）：视频项目号与线程号同口径——纯 nextval 取号 + SAVEPOINT 换号重试
    const kind = input.isMarketing ? "marketing" : "narrative";
    projectId = (await insertWithReadableId(client, VIDEO_PROJECT_ID_SOURCE, async (id) => {
      await client.query(
        `INSERT INTO video_projects (id, workspace_id, title, kind, created_by)
         VALUES ($1,$2,$3,$4,$5)`,
        [id, scope.workspaceId, input.intent.slice(0, 200), kind, input.by.id],
      );
      return id;
    })).id;
    await gatewayAppendOnClient(client, {
      ...scope,
      actor: { ...input.by },
      ...(input.threadId ? { sessionId: input.threadId } : {}),
    }, {
      who: { ...input.by },
      context: {
        tenant_id: scope.tenantId, workspace_id: scope.workspaceId,
        time: new Date().toISOString(), channel: "inapp",
      },
      object: { type: "video_project", id: projectId },
      decision: {
        action: "video.project.create",
        after: {
          projectId, kind, intent: input.intent.slice(0, 500),
          scenePolicy: selectedScenePolicy.decision,
          platform: selectedPlatform.decision,
          ...(input.threadId ? { threadId: input.threadId } : {}),
        },
        basis: ["视频标准管线立项（§5：一部片子/一个营销 Campaign）"],
      },
      rule_impact: [],
    });
    if(directorMode) creativeDelegation=await createDirectorGrantOnClient(client,{...scope,projectId,runId:allocatedRunId},input.by,
      {identityAssetRefs:input.identityAssetRefs??[],maxBudgetCny:0});
    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      discard = true;
      throw new AggregateError([err, rollbackError], "video project and creative delegation rollback failed");
    }
    throw err;
  } finally {
    client.release(discard);
  }
  const runId = startRun(scope, {
    projectId,
    intent: input.intent,
    metadata: platformMetadata,
    isMarketing: input.isMarketing,
    rawIntent: input.rawIntent,
    selectedScenePolicy,
    selectedPlatform,
    ...(creativeDelegation?{creativeDelegation,allocatedRunId,deliveryTargetPlan}:{}),
  });
  return { projectId, runId };
}
