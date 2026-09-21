/**
 * WorkLoom Codex 网关 MCP server（P0，只读）。
 *
 * 传输：stdio，按行 JSON-RPC 2.0（与仓内 packages/base/computer-use/mcp.ts 同风格）。
 * 工具：catalog_search / catalog_describe / stage_snapshot / stage_url / health
 * 资源：workloom://catalog / workloom://stage/snapshot / workloom://health
 *
 * 纪律：P0 只暴露只读工具；写工具（run_start/approval_decide）必须等 P1 接通
 * 围栏 → 审批 → 五元事件 → 回执后再上线，禁止先给 Codex 写权限。
 */
import { createInterface } from "node:readline";
import { resolveRepoRoot } from "./paths.mjs";
import { generateCatalog, findCapability, searchCapabilities } from "./catalog.mjs";
import { DEFAULT_STAGE_PORT, buildSnapshot } from "./snapshot.mjs";
import { createRunService } from "./runs.mjs";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "workloom-codex-gateway", version: "0.1.0" };

const TOOLS = [
  {
    name: "workloom_catalog_search",
    description: "搜索 WorkLoom 能力目录（数字员工/技能/管线/围栏）。当用户问“我们有哪些能力”“怎么做某件事”时先调用本工具，再决定是否执行。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "关键词，例如 GEO、投放、发布、夜审" },
        domain: { type: "string", description: "能力域/行业包，例如 geo-growth、hotel、ai-video" },
        kind: { type: "string", enum: ["employee", "skill", "pipeline", "fence"], description: "能力类型" },
        limit: { type: "number", description: "返回条数上限（默认 20）" },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "workloom_catalog_describe",
    description: "读取单个 WorkLoom 能力的完整定义：工具、围栏绑定、风险等级、来源文件。用于在执行前确认边界。",
    inputSchema: {
      type: "object",
      properties: { capabilityId: { type: "string", description: "能力 ID，例如 employee:ads-optimizer 或 pipeline:dual-content-factory" } },
      required: ["capabilityId"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "workloom_stage_snapshot",
    description: "读取数字人团队工作台快照：在岗状态、运行中的 Run、待审批、KPI、额度。P0 为 mock 数据，返回值会明确标注 dataMode。",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "workloom_stage_url",
    description: "返回本地数字人工作台的 URL，可在 Codex 内置浏览器中打开（本地回环，只读）。",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "workloom_health",
    description: "网关健康检查：仓库、能力统计、解析告警数量。",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "workloom_run_start",
    description:
      "发起一次 WorkLoom 能力执行（P1 治理闭环）。网关会先做真实围栏判定：auto 直接执行；review 生成审批卡并挂起等待人在 Codex/工作台三手势；block 直接熔断。P1 执行器为显式模拟（dataMode=simulated，回执为 workloom-sim://），不得当作真实平台成功。高风险/涉钱动作必须由人明确批准。",
    inputSchema: {
      type: "object",
      properties: {
        capabilityId: { type: "string", description: "能力 ID，例如 pipeline:dual-content-factory 或 employee:publish-operator" },
        params: { type: "object", description: "动作参数（参与围栏 when 求值）" },
        action: { type: "string", description: "可选：覆盖默认动作名（用于命中具体围栏，如 publish.execute / ads.boost / content.submit）" },
        objectType: { type: "string", description: "可选：覆盖对象类型（如 publish_task / content / ads_campaign）" },
        objectId: { type: "string", description: "可选：业务对象 ID" },
        effect: { type: "string", enum: ["read", "write"], description: "可选：读/写效应；缺省按写 fail-closed" },
        context: { type: "object", description: "围栏上下文（如 account_daily_published、fact_check_passed、platform_first_use）；缺失会导致规则求值异常并 fail-closed" },
        idempotencyKey: { type: "string", description: "幂等键；重复调用返回同一 Run" },
        actor: { type: "object", description: "可选：{type:human|agent|system, id, version}" },
      },
      required: ["capabilityId"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "workloom_run_status",
    description: "读取 Run 状态：步骤、进度、风险判定、审批、产物、回执。无回执时不得宣称完成。",
    inputSchema: { type: "object", properties: { runId: { type: "string" } }, required: ["runId"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "workloom_run_tail",
    description: "读取某个 Run 的五元事件轨迹（最近 N 条），用于解释每一步为何执行/挂起/熔断。",
    inputSchema: { type: "object", properties: { runId: { type: "string" }, limit: { type: "number" } }, required: ["runId"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "workloom_run_cancel",
    description: "取消一个未终结的 Run。取消会写五元事件留痕；已终结的 Run 幂等返回。",
    inputSchema: { type: "object", properties: { runId: { type: "string" }, reason: { type: "string" } }, required: ["runId"] },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  },
  {
    name: "workloom_approval_list",
    description: "列出待审批/已审批队列（含 gate、风险、过期时间、请求人）。",
    inputSchema: { type: "object", properties: { status: { type: "string", enum: ["pending", "approved", "rejected", "expired"] } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "workloom_approval_decide",
    description:
      "对待审批项做三手势裁决：approve（批准）/ edit（修改后批准，必须带 editedAfter）/ reject（驳回，必须带 reasonEnum）。只有人在明确指令下才能替用户做批准动作；拒绝必须给原因枚举。过期/非法手势一律拒绝（fail-closed）。",
    inputSchema: {
      type: "object",
      properties: {
        approvalId: { type: "string" },
        gesture: {
          type: "object",
          description: "三手势对象：{type:approve|edit|reject, reasonEnum?, reasonText?, editedAfter?}",
          properties: {
            type: { type: "string", enum: ["approve", "edit", "reject"] },
            reasonEnum: { type: "string", description: "reject 必填：驳回原因枚举" },
            reasonText: { type: "string", description: "可选：驳回自由文本 ≤200 字" },
            editedAfter: { description: "edit 必填：修改后的新值" },
          },
          required: ["type"],
        },
        role: { type: "string", enum: ["owner", "admin", "member", "readonly"], description: "审批人角色；readonly 会被拒绝" },
        actor: { type: "object", description: "可选：{type:human, id}" },
      },
      required: ["approvalId", "gesture"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  },
  {
    name: "workloom_ledger_verify",
    description: "校验五元事件账本哈希链完整性（只读）。",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
];

function toolText(payload, isError = false) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

export function createMcpHandler({ repoRoot = resolveRepoRoot(), catalog = generateCatalog({ repoRoot }), env = process.env, runService = null } = {}) {
  const port = Number(env.WORKLOOM_GATEWAY_PORT ?? DEFAULT_STAGE_PORT);
  const stageUrl = `http://127.0.0.1:${port}/stage`;
  const service = runService ?? createRunService({ repoRoot, catalog });

  async function callTool(name, args = {}) {
    switch (name) {
      case "workloom_catalog_search": {
        const capabilities = searchCapabilities(catalog, args);
        return toolText({ dataMode: "generated", summary: catalog.summary, count: capabilities.length, capabilities });
      }
      case "workloom_catalog_describe": {
        const capability = findCapability(catalog, args.capabilityId);
        if (!capability) return toolText({ error: "CAPABILITY_NOT_FOUND", capabilityId: args.capabilityId, hint: "先用 workloom_catalog_search 搜索" }, true);
        return toolText(capability);
      }
      case "workloom_stage_snapshot":
        return toolText(buildSnapshot({ repoRoot, catalog, store: service.store }));
      case "workloom_stage_url":
        return toolText({ url: stageUrl, openIn: "Codex 内置浏览器（Cmd+Shift+B）", dataMode: "mock", note: "P0 工作台为只读投影；写操作在 P1 经网关围栏与审批后开放。" });
      case "workloom_health":
        return toolText({ ok: catalog.warnings.length === 0, repo: catalog.repo, counts: catalog.summary, warnings: catalog.warnings });
      case "workloom_run_start":
        return toolText(await service.startRun(args));
      case "workloom_run_status": {
        const run = service.getRun(args.runId);
        return run ? toolText(run) : toolText({ error: "RUN_NOT_FOUND", runId: args.runId }, true);
      }
      case "workloom_run_tail":
        return toolText({ runId: args.runId, events: service.tailRun(args.runId, Number(args.limit ?? 20)) });
      case "workloom_run_cancel":
        return toolText(service.cancelRun(args));
      case "workloom_approval_list":
        return toolText({ approvals: service.listApprovals({ status: args.status }) });
      case "workloom_approval_decide":
        return toolText(await service.decideApproval(args));
      case "workloom_ledger_verify":
        return toolText(service.verifyLedger());
      default:
        return toolText({ error: "UNKNOWN_TOOL", name }, true);
    }
  }

  async function handle(message) {
    const { id, method, params } = message ?? {};
    if (method === "initialize") {
      return { jsonrpc: "2.0", id, result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {}, resources: {} }, serverInfo: SERVER_INFO } };
    }
    if (method === "notifications/initialized" || method === "initialized") return null;
    if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
    if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    if (method === "tools/call") return { jsonrpc: "2.0", id, result: await callTool(String(params?.name ?? ""), params?.arguments ?? {}) };
    if (method === "resources/list") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          resources: [
            { uri: "workloom://health", name: "WorkLoom 网关健康", mimeType: "application/json" },
            { uri: "workloom://catalog", name: "WorkLoom 能力目录", mimeType: "application/json" },
            { uri: "workloom://stage/snapshot", name: "数字人工作台快照（mock）", mimeType: "application/json" },
          ],
        },
      };
    }
    if (method === "resources/read") {
      const uri = String(params?.uri ?? "");
      const payload = uri === "workloom://health"
        ? { ok: catalog.warnings.length === 0, repo: catalog.repo, counts: catalog.summary, warnings: catalog.warnings }
        : uri === "workloom://catalog"
          ? catalog
          : uri === "workloom://stage/snapshot"
            ? buildSnapshot({ repoRoot, catalog, store: service.store })
            : null;
      if (!payload) return { jsonrpc: "2.0", id, error: { code: -32602, message: `未知资源：${uri}` } };
      return { jsonrpc: "2.0", id, result: { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(payload, null, 2) }] } };
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } };
  }

  return { handle, catalog, repoRoot, tools: TOOLS };
}

export function runMcpStdio({ repoRoot = resolveRepoRoot() } = {}) {
  const handler = createMcpHandler({ repoRoot });
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (message?.id === undefined) {
      void handler.handle(message);
      return;
    }
    void handler
      .handle(message)
      .then((reply) => {
        if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`);
      })
      .catch((error) => {
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } })}\n`);
      });
  });
  process.stderr.write(`workloom-codex-gateway MCP server 已启动（stdio，仓库：${repoRoot}）\n`);
}
