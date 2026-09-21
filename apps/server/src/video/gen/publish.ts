/**
 * video/gen/publish.ts —— 发布链（T-2026-0921-0002）
 *
 * 链路：成片入库 → 发布任务入队（G9 预检；公网发布必审基线，任务落 pending）→
 *      执行器复核 G9（review → pending_review 挂起，适配器不执行）→ 人审放行后由桌面端
 *      Playwright 驱动真实上传（本进程以 dry-run 驱动验证机制；**不冒充真实发布**）。
 *
 * 演示与真实分明（不变量 9）：
 *   · dry-run 回执固定 `synced:false` + `mode:"dry-run"`；
 *   · 事件 after 带 `driver:"dry-run"`；
 *   · 测试专用 `PUBLISH_TEST_FENCE_OVERRIDE=1` 仅当驱动为 dry-run 且非 production 时生效，
 *     用于把"执行机制"跑通；事件标注 `override:true`，生产环境忽略该开关。
 */
import type { getAppPool, getGatewayPool } from "@workloom/db";
import { gatewayAppendOnClient } from "@workloom/base/workdata";
import {
  createBilibiliAdapter, createDouyinAdapter, createShipinhaoAdapter, createTiktokAdapter,
  createXiaohongshuAdapter, createYoutubeAdapter, runPublishTask,
  type BrowserDriver, type Platform, type PublishAdapter, type PublishRunResult,
} from "@workloom/base/publish-rpa";
import type { JudgeInput, JudgeVerdict } from "@workloom/base/fence-engine";
import { newId } from "@workloom/shared";
import type { Scope } from "./db.js";

/** 六平台适配器装配（参考实现；tiktok/shipinhao 为占位壳，未登录一律转人工） */
export function buildPublishAdapters(): Partial<Record<Platform, PublishAdapter>> {
  return {
    douyin: createDouyinAdapter(),
    xiaohongshu: createXiaohongshuAdapter(),
    bilibili: createBilibiliAdapter(),
    youtube: createYoutubeAdapter(),
    tiktok: createTiktokAdapter(),
    shipinhao: createShipinhaoAdapter(),
  };
}

/** dry-run 浏览器驱动：不触网、不打字、不上传；只记录调用痕迹（用于机制验证） */
export function createDryRunDriver(): { driver: BrowserDriver; calls: string[] } {
  const calls: string[] = [];
  const driver: BrowserDriver = {
    async goto(url) { calls.push(`goto:${url}`); },
    async isLoggedIn(pageUrl) { calls.push(`loginCheck:${pageUrl}`); return true; },
    async uploadFile(selector, path) { calls.push(`upload:${selector}:${path}`); },
    async typeText(selector, text) { calls.push(`type:${selector}:${text.length}字`); },
    async click(selector) { calls.push(`click:${selector}`); },
    async waitForSelector(selector) { calls.push(`waitFor:${selector}`); return true; },
    async wait(ms) { calls.push(`wait:${ms}ms`); },
  };
  return { driver, calls };
}

/** 测试开关：仅 dry-run + 非 production 时允许把 G9 的 review 放行为 auto（事件留痕 override） */
export function fenceOverrideEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PUBLISH_TEST_FENCE_OVERRIDE === "1" && env.NODE_ENV !== "production";
}

export interface PublishRunDeps {
  fencePrecheck: (input: JudgeInput) => JudgeVerdict;
  dailyLimit?: number;
  driverKind?: "dry-run" | "desktop";
}

export interface PublishRunOutcome extends PublishRunResult {
  driver: "dry-run" | "desktop";
  calls?: string[];
}

/**
 * dry-run 回执修正（不变量 9：演示与真实分明）
 * 执行器在"成功上传"路径会写 synced:true——那是真实驱动语义；dry-run 必须改写为
 * synced:false + mode/driver 标记，并追加更正事件（只增不改：原事件保留，本事件说明修正）。
 */
async function correctDryRunReceipt(
  app: ReturnType<typeof getAppPool>,
  gateway: ReturnType<typeof getGatewayPool>,
  scope: Scope,
  taskId: string,
  by: string,
): Promise<void> {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    await client.query(
      `UPDATE publish_tasks
          SET receipt = (COALESCE(receipt, '{}'::jsonb)
                         || jsonb_build_object('synced', false, 'mode', 'dry-run', 'driver', 'dry-run'))
        WHERE workspace_id=$1 AND id=$2`,
      [scope.workspaceId, taskId],
    );
    await gatewayAppendOnClient(client, { ...scope, actor: { id: by, type: "system" } }, {
      who: { type: "system", id: by },
      context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
      object: { type: "publish_task", id: taskId },
      decision: {
        action: "publish.dryrun_receipt_corrected",
        after: { taskId, synced: false, mode: "dry-run", driver: "dry-run" },
        basis: [
          "dry-run 驱动不得声称真实发布（不变量 9 演示与真实分明）：回执改标 synced=false + mode=dry-run",
          "真实发布需桌面端 Playwright 驱动 + 用户本人登录态，执行后回执由平台页面证据给出",
        ],
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
}

/** 执行一个 pending 发布任务（G9 复核 → 日上限 → 适配器） */
export async function executePublishTask(
  app: ReturnType<typeof getAppPool>,
  gateway: ReturnType<typeof getGatewayPool>,
  scope: Scope,
  taskId: string,
  deps: PublishRunDeps,
): Promise<PublishRunOutcome> {
  const driverKind = deps.driverKind ?? (process.env.PUBLISH_DRIVER === "desktop" ? "desktop" : "dry-run");
  if (driverKind === "desktop") {
    throw new Error("桌面驱动未在本进程装配：真实平台上传请在桌面端（Playwright 驱动）执行；服务端只做入队与复核");
  }
  const { driver, calls } = createDryRunDriver();
  const result = await runPublishTask(app, gateway, scope, taskId, {
    adapters: buildPublishAdapters(),
    driver,
    fencePrecheck: deps.fencePrecheck,
    dailyLimit: deps.dailyLimit,
  });
  if (driverKind === "dry-run" && result.kind === "executed") {
    await correctDryRunReceipt(app, gateway, scope, taskId, "publish-rpa");
    return {
      ...result,
      receipt: { ...(result.receipt ?? {}), synced: false, mode: "dry-run", driver: "dry-run" } as typeof result.receipt,
      driver: driverKind,
      calls,
    };
  }
  return { ...result, driver: driverKind, calls };
}

export interface CreatePublishTaskInput {
  platform: Platform;
  accountId: string;
  assetId?: string | null;
  videoPath: string;
  coverPath?: string | null;
  caption?: string;
  tags?: string[];
  scheduleAt?: string | null;
  /** 入队来源：人工（studio 工作台）/ 渲染完成自动连锁 */
  origin?: "manual" | "render.auto";
  renderJobId?: string | null;
  by: string;
}

/** 发布任务入队（唯一写入点：router.createTask 与渲染完成自动连锁都走这里） */
export async function createPublishTask(
  app: ReturnType<typeof getAppPool>,
  gateway: ReturnType<typeof getGatewayPool>,
  scope: Scope,
  input: CreatePublishTaskInput,
): Promise<{ taskId: string }> {
  const taskId = newId("PT");
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    await client.query(
      `INSERT INTO publish_tasks
         (id, workspace_id, platform, account_id, asset_id, video_path, cover_path, caption, tags, schedule_at, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,'pending',$11)`,
      [
        taskId, scope.workspaceId, input.platform, input.accountId, input.assetId ?? null,
        input.videoPath, input.coverPath ?? null, input.caption ?? "",
        JSON.stringify(input.tags ?? []), input.scheduleAt ?? null, input.by,
      ],
    );
    await gatewayAppendOnClient(client, { ...scope, actor: { id: input.by, type: input.origin === "render.auto" ? "system" : "human" } }, {
      who: { type: input.origin === "render.auto" ? "system" : "human", id: input.by },
      context: {
        tenant_id: scope.tenantId, workspace_id: scope.workspaceId,
        time: new Date().toISOString(), channel: "inapp",
      },
      object: { type: "publish_task", id: taskId },
      decision: {
        action: "publish.task.create",
        after: {
          taskId, platform: input.platform, accountId: input.accountId,
          assetId: input.assetId ?? null, origin: input.origin ?? "manual",
          renderJobId: input.renderJobId ?? null, scheduleAt: input.scheduleAt ?? null,
        },
        basis: [`发布任务入队（§7；G9 公网发布必审基线，执行时 runner 复核）· 来源=${input.origin ?? "manual"}`],
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
  return { taskId };
}
