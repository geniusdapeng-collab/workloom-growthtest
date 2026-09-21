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
import { gatewayAppend, gatewayAppendOnClient } from "@workloom/base/workdata";
import { makeReadableId, newId } from "@workloom/shared";
import {
  VideoStudio,
  WorkloomLLMEngine,
  installVendorEngineBridge,
  installVendorPortraitBindingBridge,
  installVendorRenderCompatBridge,
  type ApprovalCallback,
  type EventSink,
  type GateKey,
  type GateVerdict,
  type PortraitIndex,
  type RunInput,
  type StudioPortraitConfig,
} from "@hyperreality/video-studio";

/* ================= 可配项（环境变量） ================= */

/** 审批等待上限（默认 2 小时；超时 → { approved:false, fatal:'timeout' }） */
const APPROVAL_TIMEOUT_MS = Number(process.env.HR_APPROVAL_TIMEOUT_MS ?? 7_200_000);
/** 审批状态轮询间隔（默认 2s） */
const APPROVAL_POLL_MS = Number(process.env.HR_APPROVAL_POLL_MS ?? 2_000);
/** 流水线总截止（透传 vendor STORMAXE_TOTAL_DEADLINE_MS 口径，默认 1 小时） */
const TOTAL_DEADLINE_MS = Number(process.env.VM_TOTAL_DEADLINE_MS ?? 3_600_000);

/**
 * 自动放行的「内部准备门」（2026-09-21 产品所有者口径：数字员工之间的日常协作不设人审）。
 *
 * 人审只留给两类事：① **业务决策**（主题 G2 / 需求对齐清单 G4 / 镜头提示词 G6 —— 决定"对外说什么、
 * 长什么样"）；② **花钱或对外**（G8 渲染提交烧额度、G9 公网发布、G10 对外评论回复）。
 * 情报档案 G1 / 需求整理 G3 / 定妆照 G5 / 预生产收口 G7 属内部准备：直接放行，但**照样写事件**，
 * 作为过程与时间线留痕（不插 approvals 行，审批中心不再出现内部协作项）。
 * 可用 HR_AUTO_GATES 覆盖（逗号分隔；设为空字符串即恢复全部人审）。
 */
const AUTO_GATES = new Set(
  (process.env.HR_AUTO_GATES
    ?? "G1_DOSSIER,G2_THEME,G3_INSIGHT,G4_PRD,G5_PORTRAIT,G6_PROMPT,G7_FINAL")
    .split(",").map((value) => value.trim()).filter(Boolean),
);

const here = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根（apps/server/src/video → 上溯四级）：参考图相对路径按此解析 */
const REPO_ROOT = path.resolve(here, "../../../..");
/** 运行产物根（checkpoints/characters/confirmations）：默认仓库根 .vm-work/ */
const WORK_DIR = process.env.HR_WORK_DIR ?? path.resolve(here, "../../../..", ".vm-work");

/**
 * 运行日志 tee（2026-09-22 真机审计需求）：
 * 预生产的 vendor 环节日志此前只进服务端 stdout（TTY），run 结束即丢，事后无法逐环节审计。
 * 这里在 run 期间把 console 输出旁路落盘到 `.vm-work/logs/<projectId>.log`（原样透传，不改语义），
 * 供 `scripts/tools/pipeline-audit.mts` 逐环节核对"是否正常产出/是否流转".
 */
function teeRunLogs(projectId: string): () => void {
  const logDir = path.join(WORK_DIR, "logs");
  const logFile = path.join(logDir, `${projectId}.log`);
  try {
    mkdirSync(logDir, { recursive: true });
  } catch {
    return () => undefined;
  }
  const methods = ["log", "warn", "error"] as const;
  const originals = methods.map((m) => console[m]);
  const write = (level: string, args: unknown[]) => {
    const line = args
      .map((a) => (typeof a === "string" ? a : a instanceof Error ? `${a.name}: ${a.message}` : (() => {
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })()))
      .join(" ");
    try {
      appendFileSync(logFile, `[${new Date().toISOString()}] ${level} ${line}\n`, "utf8");
    } catch {
      /* 日志落盘失败不影响运行 */
    }
  };
  methods.forEach((m, i) => {
    (console as unknown as Record<string, unknown>)[m] = (...args: unknown[]) => {
      write(m.toUpperCase(), args);
      (originals[i] as (...a: unknown[]) => void).apply(console, args);
    };
  });
  return () => {
    methods.forEach((m, i) => {
      (console as unknown as Record<string, unknown>)[m] = originals[i];
    });
  };
}

/** 工作器系统身份（事件归因；网关段① human/system 无额外校验） */
const WORKER_ACTOR = { id: "video-studio", type: "system" } as const;

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

export class StudioWorkerError extends Error {
  constructor(
    public readonly code: "LLM_MISSING",
    message: string,
  ) {
    super(message);
    this.name = "StudioWorkerError";
  }
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
    if (Date.now() >= deadline) return { approved: false, reason: "approval-timeout", fatal: "timeout" };
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
function portraitConfig(metadata?: Record<string, unknown>): StudioPortraitConfig {
  const apiKey = (process.env.VOLCENGINE_ARK_API_KEY ?? process.env.ARK_API_KEY ?? "").trim();
  const model = (process.env.ARK_IMAGE_MODEL ?? process.env.SEEDREAM_MODEL ?? "").trim();
  const enabled = (process.env.HR_PORTRAIT_ENABLED ?? "1") !== "0";
  if (!enabled || !apiKey || !model) {
    return { enabled: false };
  }
  const anchors = (process.env.HR_PORTRAIT_ANCHORS ?? "")
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
  };
}

/**
 * 异步启动一条预生产流水线（不阻塞 tRPC 响应；失败只反映在注册表投影）
 * @throws StudioWorkerError LLM_MISSING —— LLM_* 四环境变量未配齐（禁止静默降级）
 */
export function startRun(scope: Scope, input: RunInput): string {
  const llm = WorkloomLLMEngine.fromEnv();
  if (!llm) {
    throw new StudioWorkerError(
      "LLM_MISSING",
      "LLM 引擎未配置（需 LLM_BASE_URL/LLM_API_KEY/LLM_MODEL），拒绝启动预生产（vendor 纪律：禁止静默降级）",
    );
  }
  // v3.0 收口：注入路由配置——预生产全部 LLM 调用经 routeSmart
  // （preproduction 场景 × 降级链 × 真实计量 × model.call 事件留痕，fastModel 快速调用强制 L1）
  llm.attachRouter({
    providers: poolFromEnv(),
    sink: new GatewayEventSink(getGatewayPool(), scope, { id: "video-studio" }),
    policy: modelPolicyFor("ai-video"),
    scene: "preproduction",
  });

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
  const portraitIndexPath = path.join(WORK_DIR, "characters", input.projectId, "portrait-index.json");
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
    runId: newId("RUN"),
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

  const onEvent: EventSink = async (e) => {
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
     * 内部准备门：自动放行 + 留痕（不插 approvals 行）。
     * 与下面的人工门共用同一事务口径：门事件经安全网关落事件账本（过程与时间线可见），
     * 审批中心只保留真正的业务决策与花钱/对外门。
     */
    if (AUTO_GATES.has(gate)) {
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
            after: {
              gate: req.gate, vendorType: req.vendorType, runId: entry.runId, title: req.title,
              autoApproved: true,
            },
            basis: ["员工日常协作不设人审（2026-09-21 口径）：内部准备门自动放行，产出作为过程与时间线留痕"],
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
      return { approved: true, reason: `auto-approved(${req.gate})`, suggestions: [] };
    }
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
          JSON.stringify({ contentMd: req.contentMd, gate: req.gate, vendorType: req.vendorType }),
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
    return verdict;
  };

  const studio = new VideoStudio({
    llm,
    workDir: WORK_DIR,
    onApproval,
    onEvent,
    totalDeadlineMs: TOTAL_DEADLINE_MS,
    deferRender: (process.env.HR_DEFER_RENDER ?? "1") !== "0",
    portraits: portraitConfig(input.metadata),
    log: (line) => console.log(line),
  });

  // 异步执行：不阻塞 tRPC 响应；终态只写注册表投影（生命周期事件由 onEvent 落库）
  void (async () => {
    try {
      const result = await studio.runPreproduction(input);
      entry.status = "finished";
      entry.resultSummary = {
        success: result.success,
        stages: Object.keys(result.stages ?? {}),
      };
    } catch (err) {
      entry.status = "failed";
      entry.error = err instanceof Error ? err.message : String(err);
    } finally {
      restoreRunLogs();
      uninstallPortraitBinding();
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
  metadata?: Record<string, unknown>;
  isMarketing?: boolean;
  by: { id: string; type: "human" | "system" };
  threadId?: string;
}

export async function startVideoProjectRun(
  scope: { tenantId: string; workspaceId: string },
  input: StartVideoProjectInput,
): Promise<{ projectId: string; runId: string }> {
  const client = await getAppPool().connect();
  let projectId = "";
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const max = await client.query<{ n: number }>(`SELECT public.video_projects_max_vid_no() AS n`);
    projectId = makeReadableId("VID", Number(max.rows[0]?.n ?? 0) + 1);
    const kind = input.isMarketing ? "marketing" : "narrative";
    await client.query(
      `INSERT INTO video_projects (id, workspace_id, title, kind, created_by)
       VALUES ($1,$2,$3,$4,$5)`,
      [projectId, scope.workspaceId, input.intent.slice(0, 200), kind, input.by.id],
    );
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
          ...(input.threadId ? { threadId: input.threadId } : {}),
        },
        basis: ["视频标准管线立项（§5：一部片子/一个营销 Campaign）"],
      },
      rule_impact: [],
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  const runId = startRun(scope, {
    projectId,
    intent: input.intent,
    metadata: input.metadata,
    isMarketing: input.isMarketing,
  });
  return { projectId, runId };
}
