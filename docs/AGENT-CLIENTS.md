# 从 GitHub 接入 Codex / DeepSeek Harness

从本仓源码启动的 AI 工作台可以发现能力、读取回执，并通过正式 CLI 组织视频制作。第一次接入先跑本地只读验证。要调用文字模型、图片或视频供应商，再准备独立服务环境和当前工作区授权。视频制作、交付与恢复见 [视频工作台指南](ai-video-workbench-guide.md)。

---

## 1. 克隆后验证只读接入

准备 Git、Node.js ≥ 24 和本仓锁定的 pnpm（见 [package.json](../package.json)）。在用于本作业的目录克隆并记录当前提交。将检出的仓库根目录设为 Codex、DSH 或其他工作台的项目，按根目录 `AGENTS.md` 读取本仓指引。

```bash
git clone https://github.com/geniusdapeng-collab/workloom-growthtest.git
cd workloom-growthtest
git rev-parse HEAD
node --version
pnpm --version

# 本地只读发现与预览
node scripts/workloom-agent.mjs list
node scripts/workloom-agent.mjs invoke growth.repo.status
node scripts/workloom-agent.mjs invoke growth.repo.readiness
node scripts/workloom-agent.mjs invoke growth.video.workbench.guide
printf '%s' '{"intent":"雨后民宿，只拍空景，只交付抖音一版"}' \
  | node scripts/workloom-agent.mjs invoke growth.video.director.preview --input-file -

# 本机 MCP 握手、发现工具并实际读取指南
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"workloom_growth_video_workbench_guide","arguments":{}}}' \
  | node scripts/workloom-agent-mcp.mjs
```

核对 `growth.video.workbench.guide` 的 `result.repository=geniusdapeng-collab/workloom-growthtest`、`result.markdown` 和 `result.sha256`。预览应返回目标平台和数量，MCP `tools/list` 应包含 `workloom_growth_video_workbench_guide`。`invoke` 的 `status=succeeded` 表示本次工具调用成功。请继续检查 `result` 内各项状态。`growth.repo.readiness` 的 `ready` 只检查 Node、依赖目录和 MCP 入口，缺失依赖时先读指南再按下节配置。

> 产物根：默认 = 仓库根。若你的工作目录在仓外（客户常见），用**运行者**环境变量指定：
> `WORKLOOM_VIDEO_ARTIFACT_ROOT=/abs/path/to/work`（调用方仍只能给相对路径，边界由环境变量而非请求决定）。

---

## 2. 接通视频制作环境

用户已有授权实例时，在工作台运行环境设置实际 `WORKLOOM_BASE_URL` 和该工作区的 `WORKLOOM_ACCESS_TOKEN`，然后执行下方的服务与模型目录检查。远程实例须使用 HTTPS。需要从源码启动独立本机实例时，先完成以下步骤。

### 源码启动与真实工位

1. 安装锁定依赖。在仓库根运行 `pnpm install --frozen-lockfile`。锁定的私有 UI 制品若返回 401、403 或 404，使用 [受控安装入口](../scripts/ci/install-private-ui.mjs)，通过运行环境注入有权读取该制品的 `WORKLOOM_UI_RELEASE_READ_TOKEN`。普通 GitHub 克隆权限与私有 UI 制品权限分开。

   ```bash
   ui_setup_dir=$(mktemp -d)
   node scripts/ci/install-private-ui.mjs --repo . \
     --store-dir "$ui_setup_dir/store" --staging-root "$ui_setup_dir" \
     --archive "$ui_setup_dir/workloom-ui.tgz" --report "$ui_setup_dir/ui-install.json"
   export npm_config_store_dir="$ui_setup_dir/store"
   ```

   看到 `frozenInstallPassed=true` 后继续。后续使用同一 pnpm store，缓存和原始私有制品保留在仓外受限目录。Store 配置见 [pnpm 10 文档](https://pnpm.io/10.x/settings#storedir)。

2. 准备专用 PostgreSQL 和 pgvector。只在空白测试实例上使用仓库的 [Compose 配置](../docker-compose.yml) 与 [本地环境模板](../.env.example)。已有数据库时使用专用库，核对 owner、app、gateway 三条连接串和两个角色密码都属于该实例。以下命令会初始化演示数据，执行前先核对库名及端口。

   ```bash
   test -f .env || cp .env.example .env
   # 使用仓库 Compose 时，先启动并等 postgres 变为 healthy
   docker compose up -d postgres
   docker compose ps postgres
   pnpm db:migrate
   pnpm db:seed
   ```

3. 先用模拟文字模型验证本地安装。下例只用于专用本机实例，保持供应商凭据未注入。已连接的生产实例跳过此步骤。

   ```bash
   WORKLOOM_PRODUCT_ID=workloom-ai-growth SERVER_HOST=127.0.0.1 SERVER_PORT=8787 \
     LLM_PROVIDER=mock pnpm -C apps/server start
   ```

4. 准备真实制作时，按 [环境模板](../.env.example) 和部署方配置，将文字模型供应商、模型 ID、基址和密钥，及图片/视频供应商密钥和模型/端点 ID 注入服务进程。为新作业设置独立的 `HR_WORK_DIR` 和 `WORKLOOM_MEDIA_DIR`，准备可用 FFmpeg/FFprobe、实际字体和有使用权的本地曲库。模型、端点和配额以本次实例与供应商账户为准。停止刚才启动的模拟服务后，再选择下面的独立源码会话或已授权服务入口。

   | 运行环境 | 需要核对的配置 |
   |---|---|
   | 真实文字方案 | 服务进程的 `LLM_PROVIDER`、`LLM_MODEL`、`LLM_BASE_URL`、`LLM_API_KEY` 使用当前授权路由。模板默认 `mock`，制作前切换并核对实际响应模型 |
   | 方舟媒体服务 | `VOLCENGINE_ARK_API_KEY`；需要覆盖模型时分别使用 `SEEDREAM_MODEL`、`SEEDANCE_MODEL`；自定义 API 基址看 `SEEDREAM_ENDPOINT`、`SEEDANCE_ENDPOINT` |
   | 本地正式制片 CLI | 按本次运行的 `--keys-file` 和进程环境提供已授权的供应商配置；`pnpm video:doctor` 检查选中的本地媒体工具和配置存在性 |

### 独立本机源码会话

仅在自己管理、初始化了本节演示数据且确实授权使用该种子成员的新实例上使用下列命令。服务只绑定 `127.0.0.1`。在同一终端会话内设置实例身份并启动服务。示例假设 8787 空闲，真实模型和媒体凭据已由授权环境注入。选择其它空闲端口时同步修改 `SERVER_PORT` 和 `WORKLOOM_BASE_URL`。

```bash
export NODE_ENV=production SERVER_HOST=127.0.0.1 SERVER_PORT=8787
export WORKLOOM_BASE_URL=http://127.0.0.1:8787 WORKLOOM_PRODUCT_ID=workloom-ai-growth
export WORKLOOM_DEV_AUTO_LOGIN=0 WORKLOOM_SCHEDULER_MS=0
export WORKLOOM_DESKTOP_WORKSPACE=geo-growth WORKLOOM_DESKTOP_MEMBER=MEM-G01
export WORKLOOM_SOURCE_TENANT_ID=tenant-demo WORKLOOM_SOURCE_WORKSPACE_ID=ws-geo
export HR_WORK_DIR="$PWD/.vm-work-source" WORKLOOM_MEDIA_DIR="$PWD/.vm-work-source/media"
export WORKLOOM_DESKTOP_INSTANCE_ID="$(node -p 'crypto.randomUUID()')"
export WORKLOOM_DESKTOP_LOGIN_KEY="$(openssl rand -hex 32)"
export JWT_SECRET="$(openssl rand -hex 32)"
pnpm -C apps/server start &
workloom_source_pid=$!
```

等下方 `/health` 返回正确产品和实例身份再继续。用同一会话运行以下只读命令。源码会话入口使用正式本机登录校验产品、实例、成员及其工作区，仅向选中的 CLI 子进程传递成员令牌。普通已授权实例跳过本节，通过部署方正常流程取得自己的 `WORKLOOM_ACCESS_TOKEN`。

```bash
printf '%s' '{"kind":"video"}' | node scripts/workloom-source-session.mjs agent -- \
  invoke growth.video.gen.catalog --input-file -
```

后面的 `node scripts/workloom-agent.mjs …`（需认证时）和 `node scripts/workloom-director.mjs …`，在此独立源码会话中分别改为 `node scripts/workloom-source-session.mjs agent -- …` 和 `node scripts/workloom-source-session.mjs director -- …`。使用服务项目渲染 CLI 时，对应子命令为 `render`。结束时在原终端用 `jobs -l` 找到 `workloom_source_pid` 对应作业，将其调回前台并按 Ctrl-C，再退出该终端。续跑时保留作业目录、数据库与原受理回执，通过已授权身份重新连接。临时凭据留在该会话环境。

标准制作的固定子命令为 `node scripts/workloom-source-session.mjs studio -- start --work-root <本次作业目录> --input-file -`。按[一句话启动标准制片](ai-video-workbench-guide.md#一句话启动标准制片)送入用户原话和明确的目标秒数。它通过同一实例自动分流，将启动回执保存在该作业目录。

### 核对已连接的实例

```bash
# 此值仅用于实际在该端口运行的本机源码服务；授权实例用其实际地址
export WORKLOOM_BASE_URL=http://127.0.0.1:8787
curl --fail --silent --show-error "$WORKLOOM_BASE_URL/health"
# 独立源码会话按上节替换入口；其他实例由受控运行环境注入成员令牌
printf '%s' '{"kind":"image"}' \
  | node scripts/workloom-agent.mjs invoke growth.video.gen.catalog --input-file -
printf '%s' '{"kind":"video"}' \
  | node scripts/workloom-agent.mjs invoke growth.video.gen.catalog --input-file -
pnpm video:doctor
```

核对 `/health` 的 `ok`、`productId` 和实际源码实例 ID，检查实际模型、生成方式与时长是否列在目录。必要时在目录输入中加 `"includeUnavailable":true` 查原因。目录只检查运行时接线与配置，余额、权限、资格和实际响应分别核对。只有命中正确实例和工作区、素材用途与预算均获授权时，才继续 [视频工作台指南的制作步骤](ai-video-workbench-guide.md#3-选择正式入口分清方案前期和渲染)。

运行 [RDAS 生产验收](../scripts/acceptance/README.md) 时，为每个被测提交指定独立的 `--evidence-root`，并把 `--out` 放在该根目录内。已受理或状态未知的生成任务按原项目、原目录和任务号续查。提交更新或另建验收证据目录时仍须保留原回执。

| 调用方式 | 作用 | 前置 |
|---|---|---|
| 通用 stdio MCP 或 `workloom-agent.mjs` | 读指南、能力、项目状态和回执，运行免费导演预览 | 本机 Node。服务端只读项目能力还需成员授权 |
| `workloom-director.mjs plan` | 在当前项目范围发起真实文字导演方案 | 运行中的服务、成员令牌、真实文字模型，可能产生文字模型费用 |
| 服务 CLI、视频工作台或正式制片 CLI | 按当前正式方案和授权生成媒体、制作与交付 | 当前项目、正式镜头与资格、素材使用权、图片/视频供应商、预算及后期环境 |

通过 MCP 读状态和回执，通过正式制作入口执行。一句话导演使用 `scripts/workloom-director.mjs plan|job|versions|render|feedback`。专业流程使用正式前期档案、`scripts/tools/route-video.mts` 和 `scripts/tools/full-chain-film.mts`，具体见 [导演 V2 手册](director-studio-v2.md)和[视频工作台指南](ai-video-workbench-guide.md)。

---

## 3. Codex 接入

直接在仓库根打开 Codex 就可用终端调用上述 CLI。需要让工具出现在客户端工具列表时，选择配置本地 STDIO MCP。用户配置放在 `~/.codex/config.toml`，受信任的项目也可以用项目级 `.codex/config.toml`。用本机实际绝对路径替换示例，重新打开会话并核对工具回执。配置字段见 [OpenAI 官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp)。

```toml
[mcp_servers.workloom_growthtest]
command = "/abs/path/to/node"
args = ["/abs/path/to/workloom-growthtest/scripts/workloom-agent-mcp.mjs"]
cwd = "/abs/path/to/workloom-growthtest"
startup_timeout_sec = 60
# 仅需读取服务项目时启用，值由 Codex 启动环境注入
# env_vars = ["WORKLOOM_BASE_URL", "WORKLOOM_ACCESS_TOKEN"]
```

本地目录的静态工具通常无需额外环境变量。源码和打包服务的端口可以不同，服务调用要显式使用实际 `WORKLOOM_BASE_URL`。真实成员令牌只注入运行环境。`env_vars` 只写变量名。仅提供托管远程工具的 AI 工作台需要该平台明确配置的服务连接，不能直接访问用户机器的 stdio 进程。配置与启动排查以 [OpenAI 官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp) 为准。

只接只读工具时，也可以选择用 Codex CLI 注册；命令同样要使用本机绝对路径。若已用上面的配置注册同名服务器，只需执行 `codex mcp list`。

```bash
codex mcp add workloom_growthtest -- /abs/path/to/node /abs/path/to/workloom-growthtest/scripts/workloom-agent-mcp.mjs
codex mcp list
```

接入后，在当前 Growthtest 仓库会话只需描述作业，例如“用 Growthtest 制作 18 秒雨后山间民宿短片，只拍空景”。根级指引会引导工作台检查实例、授权与素材，再使用[原生制作入口](ai-video-workbench-guide.md#一句话启动标准制片)。只要方案时明确说“先给方案”。

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

1. 在 DSH 里把本仓目录设为工作区。
2. 让它读根目录 `AGENTS.md` 指向的规则及 [视频工作台指南](ai-video-workbench-guide.md)。
3. 在有真实文字模型权限的实例，用 `node scripts/workloom-director.mjs plan --input-file intent.json` 创建方案。独立源码会话使用第 2 节的成员校验入口。

### 4.2 桌面端接入 · 路线 B（把本仓 MCP 挂成 DSH 插件，能力进菜单）

使用官方 `@deepseek-ai/dsh-mcp-client`，每个服务器配置一条插件。配置字段来自
[官方 MCP 客户端手册](https://github.com/deepseek-ai/deepseek-harness/blob/HEAD/packages/mcp/mcp-client/README.md)：

```yaml
- id: mcp-workloom
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: workloom_growthtest
    transport: stdio
    command: /absolute/path/to/node
    args: ['/abs/path/to/workloom-growthtest/scripts/workloom-agent-mcp.mjs']
    cwd: /abs/path/to/workloom-growthtest
    failOnStartupError: true
    toolCallTimeoutMs: 60000
```

将 Node 和仓库路径替换成实际绝对路径。SDK 会协商本仓支持的协议版本；工具名按
`mcp__<serverName>__<工具名>` 暴露。2026-10-02 用官方插件、Cordis 与实际工具注册器发现 **26 个工具**，
并完成导演预览与仓库状态两次 `tools/call`，模型请求为 0。该测试覆盖插件执行链；DSH 原生桌面 GUI 未在本机验证。

---

## 5. 视频与仓库能力速查

### 导演 V2

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

### 5.0 视频链路

| 能力 | 何时用 | 备注 |
|---|---|---|
| `growth.video.workbench.guide` | 开工前读取本仓完整制作指南 | 返回正文、仓库身份和摘要 |
| `growth.video.route.record` | 出片前：确认本项目的分流结论 | 读 `work/route.json`；没有就让 Agent 先跑分流 |
| `growth.video.production.plan` | 出片前：拿"建议命令 + 检查清单" | **预览**：不执行、不花钱 |
| `growth.video.gen.catalog` | 选模型/看限额 | 服务端只读 |
| `growth.video.production.shots` | 看项目镜头与生产资格 | 服务端只读 |
| `growth.video.production.status` | 跑片过程中/跑完后：看卡在哪一步 | 读 `logs/<project>/stages.jsonl`，含渲染台账 |
| `growth.video.delivery.inspect` | 交付前：核验清单所列文件 | 缺件/越界会如实列出 |
| `growth.video.post.quality` | 交付前：读取请求层及当前媒体的技术证据 | `complete` 和艺术质量分开 |

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

- **令牌**：视频服务 CLI 使用当前工作区 `WORKLOOM_ACCESS_TOKEN`。C 端的 `WORKLOOM_C_TOKEN` 有独立用途；演示身份只用于本机开发。运行时注入秘密，避免写进仓库、参数、日志或提示词。
- **地址**：未显式配置时，CLI 会按 `product.manifest.json` 的桌面偏移推算本机地址。源码服务按 `SERVER_PORT` 启动，连接时以实际服务地址为准。非回环地址必须 HTTPS。
- **禁用能力**：`enabled=false` 的能力会从 MCP `tools/list` 消失，调用返回 `DISABLED` + 原因；
- **错误码**：清单/契约类错误返回 `{"error":{"code":...}}`；本地能力自身抛错会显示为 `INTERNAL_ERROR` + 可读原因
  （例如"路径监狱""超过读取上限"）；
- **路径监狱**：视频只读能力默认只允许**本仓相对路径**；仓外产物根需运行者显式设
  `WORKLOOM_VIDEO_ARTIFACT_ROOT`；绝对路径与 `../` 逃逸一律拒绝；
- **网络范围**：本节的只读能力读取本地文件或当前实例。文字方案和媒体生成会将已授权的相应输入发送给所选供应商。

---

## 7. 本仓本次落地的内容（便于对账）

- 入口：`scripts/AGENT-CAPABILITIES.md`（基座受控资产，随 base-sync 下发）+ `scripts/workloom-agent.mjs`
  + `scripts/workloom-agent-mcp.mjs` + `scripts/agent-capabilities.{mjs,core.json,test.mjs}`；
- 仓库通用只读模块：`bundles/geo-growth/capabilities/repo.mjs`（4 条：`repo.status` / `repo.docs` / `bundle.summary` / `repo.readiness`，只读/预览；路径监狱 + 8MB/2 万行上限，不回显密钥值）；
- 视频能力清单：`bundles/geo-growth/agent-capabilities.json`，在 `list` 中读取当前登记条目；
- 导演预览模块：`bundles/geo-growth/capabilities/director.mjs`，其余四条导演只读能力调用固定服务端过程；
- 认证执行 CLI：`scripts/workloom-director.mjs`，令牌只放 Authorization 头，`plan` 强制文字方案，输入与地址均校验；
- 自检：`node --test scripts/agent-capabilities.test.mjs`（清单驱动的断言，基座与行业仓共用同一份）。
- **内置 DSH 组件升级到 `0.2.0-rc.2`**：`packages/runtime/dsh-gate/**` 与 `scripts/dsh-gate.sh` 同步自基座
  （`vendor/dsh` 审计基线一并同步）；真机跑过 `bash scripts/dsh-gate.sh`（24 条哈希链 + `kill -9` 后 18 条链 + 重放零重复）。
