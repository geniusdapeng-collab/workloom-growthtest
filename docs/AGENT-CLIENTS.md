# 桌面 Agent 接入指南：Codex / DeepSeek Harness

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

成功标志：`list` 打印**本仓清单**（本仓为 27 条：核心 8 + 服务 4 + 视频 6 + 导演 5 + 仓库通用只读 4）；`invoke` 返回单行 JSON，形如
`{"schemaVersion":"workloom.agent-capability-result/v1","status":"succeeded",...}`；MCP 冒烟返回
`tools/list`（本仓 26 个工具，禁用项不出现在列表里）。数量以本仓清单和实际 `tools/list` 为准。

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

**视频的执行不在只读 MCP 里**。一句话导演任务使用固定、认证的服务 CLI：
`scripts/workloom-director.mjs plan|start|job|versions|feedback`，详见 [导演 V2 手册](director-studio-v2.md)。
`plan` 强制 `mode=plan`，只调用真实文字模型；`start` 的默认制作模式仍受本人素材、预算和正式脚本资格约束。
专业旧流程继续走 `scripts/tools/route-video.mts` → `scripts/tools/full-chain-film.mts`。
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

配置依据 [Codex 官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp)。2026-10-02 已用实际 Codex CLI 的临时配置发现工具并调用
`growth.video.director.preview`；没有修改用户全局配置。桌面应用与 CLI 共用 MCP 配置，桌面聊天 UI 本次未另行操作。

---

## 4. DeepSeek Harness（DSH）接入

### 4.0 先分清：本仓有**两个**"DeepSeek Harness"，别混

| | **内置 DSH 组件**（本仓自带，产品自己在用） | **DSH 桌面端**（DeepSeek 官方客户端，人用） |
|---|---|---|
| 是什么 | 运行时 Agent 底座：`vendor/dsh`（审计基线）+ `packages/runtime` 的 **dsh seam**（意图路由 / Ask·Agent·Quest 循环 / 装配 / 工具 / 剧本）+ 围栏插件 + 事件桥 | DeepSeek 官方客户端，具体安装平台以 [官方仓库](https://github.com/deepseek-ai/deepseek-harness) 为准 |
| 谁在用 | **产品自己**：服务端派活、通用任务循环、夜班 | **人**：资深用户 / 内部同事的工作台 |
| 版本 | **`0.2.0-rc.2`**：`packages/runtime/dsh-gate/package.json` 的 pin；`vendor/dsh` 审计基线同为该版本 | 本次实测 npm [`@deepseek-ai/dsh@0.2.0-rc.2`](https://www.npmjs.com/package/@deepseek-ai/dsh/v/0.2.0-rc.2)，不据此承诺未来最新版 |
| 怎么验收 | `bash scripts/dsh-gate.sh`：headless → 工具调用过围栏瀑布 → 事件落哈希链 → `kill -9` 重放零重复 | 客户端侧：`tools/list` 能看到本仓工具（见 §4.2） |
| 怎么"接本仓能力" | **不需要 MCP**：它就在进程内，走服务端过程 + 围栏 + 事件账本（与 `scripts/AGENT-CAPABILITIES.md` 同一批过程） | 需要接入：§4.1 用 `bash` 跑 CLI；§4.2 用 MCP 插件挂 `workloom-agent-mcp.mjs` |

> 一句话：**内置组件 = 我们的执行底座；桌面端 = 给人用的工作台。**
> 本节 4.1 / 4.2 讲桌面端怎么接进来；内置组件不需要"接入"，只需按 `dsh-gate` 验版本与门禁。

### 4.1 桌面端接入 · 路线 A（用它的终端工具直接跑本仓 CLI，最省事）

按 [DSH 官方扩展手册](https://github.com/deepseek-ai/deepseek-harness/blob/HEAD/docs/cookbook/extension-cookbook.zh.md) 配置工作区和工具插件：

1. 在 DSH 里把本仓目录设为工作区；
2. 让它读 `bundles/ai-video/README.md`（§0–§6 是给 Agent 的 runbook）；
3. 一句话导演用固定 CLI `node scripts/workloom-director.mjs plan --input-file intent.json`；需要专业旧流程时再用 `route-video.mts` 与 `full-chain-film.mts`。

### 4.2 桌面端接入 · 路线 B（把本仓 MCP 挂成 DSH 插件，能力进菜单）

使用官方 `@deepseek-ai/dsh-mcp-client`，每个服务器配置一条插件。配置字段来自
[官方 MCP 客户端手册](https://github.com/deepseek-ai/deepseek-harness/blob/HEAD/packages/mcp/mcp-client/README.md)：

```yaml
- id: mcp-workloom
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: workloom-growth
    transport: stdio
    command: /absolute/path/to/node
    args: ['/abs/path/to/WorkLoom-growth/scripts/workloom-agent-mcp.mjs']
    cwd: /abs/path/to/WorkLoom-growth
    env:
      WORKLOOM_PRODUCT_ROOT: /abs/path/to/WorkLoom-growth
    failOnStartupError: true
    toolCallTimeoutMs: 60000
```

将 Node 和仓库路径替换成实际绝对路径。SDK 会协商本仓支持的协议版本；工具名按
`mcp__<serverName>__<工具名>` 暴露。2026-10-02 用官方插件、Cordis 与实际工具注册器发现 **26 个工具**，
并完成导演预览与仓库状态两次 `tools/call`，模型请求为 0。该测试覆盖插件执行链；DSH 原生桌面 GUI 未在本机验证。

---

## 5. 能力速查：视频 6 条 + 仓库通用 4 条（DSH/Codex 通用）

### 导演 V2（新增 5 条）

| 能力 | 用途 | 数据模式 |
|---|---|---|
| `growth.video.director.preview` | 解析明确数量、平台、否定和专业默认值 | 纯本地预览；文字/图像/视频请求均为 0 |
| `growth.video.director.job` | 读取当前工作区导演任务、阶段和必要授权 | 服务端只读 |
| `growth.video.director.versions` | 读取冻结方案与四版实际交付状态 | 服务端只读；`mediaReady=false` 表示尚无成片 |
| `growth.video.director.preferences` | 读取客户明确表达的偏好 | 服务端只读；不从选择行为臆造偏好 |
| `growth.video.director.calibration` | 读取当前工作区版本评分和盲选计数 | 服务端只读；不能当作颜值提升证明 |

```bash
printf '%s' '{"intent":"雨后民宿，抖音、小红书、视频号各一版，再给导演惊喜版"}' \
  | node scripts/workloom-agent.mjs invoke growth.video.director.preview --input-file -
```

### 5.0 视频链路（6 条）

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

### 5.1 仓库通用只读（4 条，与行业仓同一份模板）

| 能力 | 何时用 | 备注 |
|---|---|---|
| `growth.repo.status` | 接手本仓第一件事：看清产品标识/默认行业包/文档与脚本规模 | 读 `product.manifest.json` + 目录计数 |
| `growth.repo.docs` | 找 runbook／规范：列出 `docs/*.md` 与一级标题 | 可传 `limit`（1–60），默认 60 |
| `growth.bundle.summary` | 看行业包家底：skills / fences / pipelines / presets / library 计数 + 围栏规则样例 | 围栏样例最多 12 条 |
| `growth.repo.readiness` | 上手前自检：Node / 依赖 / 运行时资产 / 密钥是否存在 / MCP 入口 / 内置 DSH pin | **预览**：只读本地文件，不联网 |

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
- 仓库通用只读模块：`bundles/geo-growth/capabilities/repo.mjs`（4 条：`repo.status` / `repo.docs` / `bundle.summary` / `repo.readiness`，只读/预览；路径监狱 + 8MB/2 万行上限，不回显密钥值）；
- 视频能力模块：`bundles/geo-growth/capabilities/video.mjs`（只读/预览；本仓 6 条视频能力，见 §5）；
- 导演预览模块：`bundles/geo-growth/capabilities/director.mjs`，其余四条导演只读能力调用固定服务端过程；
- 认证执行 CLI：`scripts/workloom-director.mjs`，令牌只放 Authorization 头，`plan` 强制文字方案，输入与地址均校验；
- 自检：`node --test scripts/agent-capabilities.test.mjs`（清单驱动的断言，基座与行业仓共用同一份）。
- **内置 DSH 组件升级到 `0.2.0-rc.2`**：`packages/runtime/dsh-gate/**` 与 `scripts/dsh-gate.sh` 同步自基座
  （`vendor/dsh` 审计基线一并同步）；真机跑过 `bash scripts/dsh-gate.sh`（24 条哈希链 + `kill -9` 后 18 条链 + 重放零重复）。
