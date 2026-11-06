#!/usr/bin/env node
/** WorkLoom reviewed capabilities as MCP stdio tools. No data goes to stdout except JSON-RPC. */
import { resolve } from "node:path";
import { CapabilityError, invokeCapability, loadCatalog, mcpTools, sanitizeErrorMessage, toolName } from "./agent-capabilities.mjs";

const MAX_FRAME_BYTES = 9 * 1024 * 1024;
const SUPPORTED_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]);
const catalog = await loadCatalog(resolve(process.env.WORKLOOM_PRODUCT_ROOT ?? resolve(import.meta.dirname, "..")));
const tools = mcpTools(catalog);
const byName = new Map([...catalog.entries.values()]
  .filter((item) => item.enabled !== false).map((item) => [toolName(item), item]));

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function protocolError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

function toolError(error) {
  const code = error instanceof CapabilityError ? error.code : "INTERNAL_ERROR";
  const message = sanitizeErrorMessage(error);
  return { content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }], isError: true };
}

async function handle(request) {
  if (request?.jsonrpc !== "2.0" || typeof request.method !== "string") {
    protocolError(request?.id ?? null, -32600, "invalid request");
    return;
  }
  const { id, method, params } = request;
  if (id === undefined) return;
  switch (method) {
    case "initialize": {
      const requested = params?.protocolVersion;
      const version = SUPPORTED_VERSIONS.has(requested) ? requested : "2025-11-25";
      reply(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "workloom-agent", version: "1.0.0" },
        instructions: "GrowthTest 视频任务先调用 workloom_growth_video_workbench_guide({}) 读取完整固定指南。当前 MCP 提供已列出的只读发现与查询，不提供视频生产写工具。制作使用已授权实例的 scripts/workloom-video.mjs start/status/prompts/resume-prompts 正式 CLI；先读取固定私有 profile，运行 scripts/workloom-client-setup.mjs check 与 doctor，核对 executorCommit、实例、成员与工作区。同一 jobRoot/jobFile 持续接续，start_unknown 只对账、禁止换文件重发。GitHub 或客户端登录不能替代产品成员权限；指南读取与本地配置成功不证明接通或成片。仓库规则与完整入口见 AGENTS.md、AGENTS.repo.md、docs/AGENT-CLIENTS.md、docs/video-native-agent-entry.md。",
      });
      return;
    }
    case "ping":
      reply(id, {});
      return;
    case "tools/list":
      reply(id, { tools });
      return;
    case "tools/call": {
      const descriptor = byName.get(params?.name);
      if (!descriptor) {
        reply(id, toolError(new CapabilityError("NOT_FOUND", "MCP 工具不存在", 2)));
        return;
      }
      try {
        const output = await invokeCapability(catalog, descriptor.id, params?.arguments ?? {});
        reply(id, { content: [{ type: "text", text: JSON.stringify(output) }], isError: false });
      } catch (error) {
        reply(id, toolError(error));
      }
      return;
    }
    default:
      protocolError(id, -32601, "method not found: " + method);
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) {
    process.stderr.write("MCP 输入帧超出上限\n");
    process.exitCode = 2;
    process.stdin.pause();
    return;
  }
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    try {
      const request = JSON.parse(line);
      void handle(request).catch((error) => protocolError(request?.id ?? null, -32000,
        sanitizeErrorMessage(error)));
    } catch {
      protocolError(null, -32700, "parse error");
    }
  }
});
process.stdin.on("end", () => {
  if (buffer.trim()) protocolError(null, -32700, "incomplete JSON-RPC frame");
});
process.stderr.write("WorkLoom agent MCP 已启动（stdio）\n");
