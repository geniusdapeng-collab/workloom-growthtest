# 桌面 Agent 接入指南：Codex / DeepSeek Harness（T-2026-1001-0008）

> 读者：要把本仓能力接进**桌面 Agent**的人（或 Agent 自己）。目标是**5 分钟能跑通**：
> 先 `list` 看到能力 → 再 `invoke` 读一条真实状态 → 最后把 stdio MCP 挂进客户端。
> 视频链路的完整操作手册在 [`bundles/ai-video/README.md`](../bundles/ai-video/README.md)（§0–§6），本文只讲**接入**。

---

## 1. 5 分钟接入（所有客户端通用）

前置：Node.js ≥ 24（与 `package.json#engines` 一致）、已 `pnpm install`；**不需要**先起服务端也能用只读/预览能力。

```bash
# ① 看能力清单（每项含 ID / 操作类别 / 风险 / 数据模式）
node scripts/workloom-agent.mjs list

# ② 看单项契约（输入 JSON Schema、传输方式）
node scripts/workloom-agent.mjs describe growth.video.production.status

# ③ 真跑一条只读能力（读本仓产物的阶段账本）
printf '%s' '{"projectId":"VID-FF02-FULL","workDir":"work"}' \
  | node scripts/workloom-agent.mjs invoke growth.video.production.status --input-file -

# ④ MCP 冒烟（stdio JSON-RPC，两个请求：initialize + tools/list）
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}\n{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n' \
  | node scripts/workloom-agent-mcp.mjs
```

成功标志：`list` 打印**本仓清单**（本仓为 18 条，其中视频能力 6 条）；`invoke` 返回单行 JSON，形如
`{"schemaVersion":"workloom.agent-capability-result/v1","status":"succeeded",...}`；MCP 冒烟返回
`tools/list`（本仓 17 个工具，禁用项不出现在列表里）。

> 产物根：默认 = 仓库根。若你的工作目录在仓外（客户常见），用**运行者**环境变量指定：
> `WORKLOOM_VIDEO_ARTIFACT_ROOT=/abs/path/to/work`（调用方仍只能给相对路径，边界由环境变量而非请求决定）。

---

## 2. 能力边界：只读/预览 vs 执行（先看这张表再用）

| 类别 | 会不会动数据/花钱 | 出现在 MCP 菜单 | 例子 |
|---|---|---|---|
| 只读（`read`） | 否 | ✅ `readOnlyHint=true` | `core.threads.get`、`growth.video.production.status` |
| 回执（`receipt`） | 否 | ✅ | `core.threads.events`、`growth.video.delivery.inspect` |
| 预览（`preview`） | 否（本地校验/出计划） | ✅ | `growth.service.inquiry.preview`、`growth.video.production.plan` |
| 执行（`execute`） | **是**（服务端过程 + 幂等键 + 围栏/审批） | 仅在启用且过审后出现 | `growth.service.inquiry.execute`（本仓当前**禁用**） |

**视频的"执行"目前不在 MCP 里**：渲染/出片是本地长任务，走 CLI：
`scripts/tools/route-video.mts` → `scripts/tools/full-chain-film.mts`（见 `bundles/ai-video/README.md`）。
`growth.video.production.plan` 只给"建议命令 + 前置检查"，**不替你执行、不花钱**——这是产品所有者口径。

---

## 3. Codex 接入

Codex 支持本地 STDIO MCP。把下面这段加进 Codex 的 `config.toml`（`~/.codex/config.toml`），
**命令指向本仓**的 MCP 入口即可（多个仓可各配一条，用不同名字）：

```toml
[mcp_servers.workloom-growth]
command = "node"
args = ["/abs/path/to/WorkLoom-growth/scripts/workloom-agent-mcp.mjs"]
cwd = "/abs/path/to/WorkLoom-growth"
startup_timeout_sec = 60

[mcp_servers.workloom-growth.env]
WORKLOOM_PRODUCT_ROOT = "/abs/path/to/WorkLoom-growth"
# 只读能力可不配下面两项；要用服务端过程时按需配置（**不要写进仓库/日志**）
# WORKLOOM_BASE_URL = "http://127.0.0.1:4295"      # 本机回环；远程必须 HTTPS
# WORKLOOM_ACCESS_TOKEN = "<B 端成员令牌>"          # 远程地址时必须
# WORKLOOM_C_TOKEN = "<C 端令牌>"                   # 仅 C 端能力需要，与 B 端令牌不可互换
```

> **核实状态（如实标注）**：`[mcp_servers.<name>]` + `command/args/env/cwd/startup_timeout_sec`
> 的写法取自**本机正在使用的 Codex 配置实例**（本机 `~/.codex/config.toml` 中的 MCP 条目），
> 并且本文命令均已实跑。撰写本文时 `learn.chatgpt.com` / `developers.openai.com` 直连超时或 403、
> 本地代理未运行，**未能对照官方文档二次核实**；请在落地前按你当前 Codex 版本的官方文档确认键名
> （尤其是 `env` 子表与超时字段）。

---

## 4. DeepSeek Harness（DSH）接入

DSH 桌面端（v0.2 预览版，macOS/Windows 安装包，MIT 开源）"一切皆插件"。两条路线：

**路线 A｜用它的终端工具直接跑本仓 CLI（最省事，今天可用）**

1. 在 DSH 里把本仓目录设为工作区；
2. 让它读 `bundles/ai-video/README.md`（§0–§6 是给 Agent 的 runbook）；
3. 用它的 `bash` 工具执行同一套命令（`pnpm video:doctor` → `route-video.mts` → `full-chain-film.mts`）。

**路线 B｜把本仓 MCP 挂成 DSH 插件（能力进菜单）**

DSH 官方扩展手册明确："**MCP：每个服务器一个插件：发现工具 → `ctx.tools.register()`**"
（见 [extension-cookbook.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/extension-cookbook.zh.md)）。
桌面端插件管理页支持**按 npm 包名安装插件**，也支持在"创造模式"里对话生成插件。做法：

1. 在 DSH 插件页装一个 MCP 客户端插件（或让 DSH 现写一个），把服务器命令配成本仓入口：

   ```bash
   node /abs/path/to/WorkLoom-growth/scripts/workloom-agent-mcp.mjs
   ```

   并把 `WORKLOOM_PRODUCT_ROOT=/abs/path/to/WorkLoom-growth` 等环境变量注入插件进程；
2. 重新加载插件后，在 DSH 的工具列表里应能看到 `workloom_growth_*` 工具（本仓 17 个，视频 6 个）。

> 说明：DSH 侧"自定义 STDIO MCP"的具体配置键以**你所用 DSH 版本的官方文档/插件页为准**；
> 我们这侧只保证"标准 stdio JSON-RPC + 工具清单"这一契约（协议版本含 2024-11-05 / 2025-03-26 /
> 2025-06-18 / 2025-11-25，见 `scripts/workloom-agent-mcp.mjs`）。

---

## 5. 视频链路：6 条能力怎么配合（DSH/Codex 通用）

| 能力 | 何时用 | 备注 |
|---|---|---|
| `growth.video.route.record` | 出片前：确认本项目的分流结论 | 读 `work/route.json`；没有就让 Agent 先跑分流 |
| `growth.video.production.plan` | 出片前：拿"建议命令 + 检查清单" | **预览**：不执行、不花钱 |
| `growth.video.gen.catalog` | 选模型/看限额 | 服务端只读 |
| `growth.video.production.shots` | 看项目镜头与生产资格 | 服务端只读 |
| `growth.video.production.status` | 跑片过程中/跑完后：看卡在哪一步 | 读 `logs/<project>/stages.jsonl`，含渲染台账 |
| `growth.video.delivery.inspect` | 交付前：核验清单所列文件 | 缺件/越界会如实列出 |

典型对话（DSH 里）：

> "先 `production.plan` 看出片计划；把缺的前置补齐后按计划跑；跑完用 `production.status` 汇报，再用 `delivery.inspect` 核验交付包。"

---

## 6. 安全与排错

- **令牌三类**：`WORKLOOM_ACCESS_TOKEN`（B 端成员，远程地址必需）、`WORKLOOM_C_TOKEN`（C 端，单独）、
  本地开发可用 `auth.loginAs` 演示身份；**令牌只经环境变量**，不得写进仓库、命令行参数、日志或提示词；
- **地址**：默认 `127.0.0.1:8787+portOffset`（本仓 `product.manifest.json`）；**非回环必须 HTTPS**；
- **禁用能力**：`enabled=false` 的能力会从 MCP `tools/list` 消失，调用返回 `DISABLED` + 原因；
- **错误码**：清单/契约类错误返回 `{"error":{"code":...}}`；本地能力自身抛错会显示为 `INTERNAL_ERROR` + 可读原因
  （例如"路径监狱""超过读取上限"）；
- **路径监狱**：视频只读能力默认只允许**本仓相对路径**；仓外产物根需运行者显式设
  `WORKLOOM_VIDEO_ARTIFACT_ROOT`；绝对路径与 `../` 逃逸一律拒绝；
- **不上行**：这些能力只读本地文件或调服务端只读过程，不把客户数据发给模型供应商。

---

## 7. 本仓本次落地的内容（便于对账）

- 入口：`scripts/AGENT-CAPABILITIES.md`（基座受控资产，随 base-sync 下发）+ `scripts/workloom-agent.mjs`
  + `scripts/workloom-agent-mcp.mjs` + `scripts/agent-capabilities.{mjs,core.json,test.mjs}`；
- 视频能力模块：`bundles/geo-growthtest/capabilities/video.mjs`（只读/预览；本仓 6 条视频能力，见 §5）；
- 自检：`node --test scripts/agent-capabilities.test.mjs`（清单驱动的断言，基座与行业仓共用同一份）。
