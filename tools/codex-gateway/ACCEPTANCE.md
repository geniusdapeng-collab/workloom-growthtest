# P0 验收记录 · WorkLoom × Codex 工作台

> 验收仓：`workloom-growthtest`（隔离副本，`none-in-none-out`）
> 分支：`task/T-2026-0922-0001`
> 日期：2026-09-22

## A. 自动化验证（已通过）

| 项 | 命令 | 结果 |
|---|---|---|
| 网关单测 | `node --test tools/codex-gateway/test/*.test.mjs` | 11/11 通过（含目录/HTTP+SSE/MCP/计数一致性） |
| 自检 | `node tools/codex-gateway/bin/cli.mjs doctor` | 9/9 PASS；能力目录 73 员工 / 71 技能 / 10 管线 / 77 围栏；告警 0，未解析 0 |
| MCP stdio | `printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n...' \| sh plugins/workloom-workbench/scripts/start-mcp.sh` | initialize + tools/list 握手成功，返回 5 个只读工具 |
| 插件校验 | `python3 plugin-creator/scripts/validate_plugin.py plugins/workloom-workbench` | Plugin validation passed |
| 路径穿越防护 | `node --test` 内 `静态资源路径穿越被拒绝` | 通过（403/404） |

## B. 真实模型触发验收（已通过）

用真实 Codex 模型（`codex exec`，只读沙箱）临时挂载本仓 MCP server，执行：

```bash
codex exec -C <growthtest> -s read-only --skip-git-repo-check --json \
  -c 'mcp_servers.workloom-core.command="sh"' \
  -c 'mcp_servers.workloom-core.args=["-lc","exec <repo>/plugins/workloom-workbench/scripts/start-mcp.sh"]' \
  "1) workloom_catalog_search query=GEO limit=5；2) workloom_catalog_describe pipeline:dual-content-factory；3) 中文总结能力、关键闸门、数据模式。"
```

模型实际行为（来自 JSONL 事件流）：

1. 主动读取了 `workloom-context` 技能（全局已装）；
2. 调用 `workloom_catalog_search({query:"GEO",limit:5})`，拿到 5 条能力与总览；
3. 调用 `workloom_catalog_describe({capabilityId:"pipeline:dual-content-factory"})`，拿到 10 步与 4 个闸门；
4. 额外只读复核了仓内 YAML，并输出了 G9 / G-GEO1 / G-GEO2 / G-VIS1 的闸门语义。

结论：**Codex 可以在不安装插件的情况下，通过 MCP 临时挂载发现并调用 WorkLoom 能力；模型能正确理解"闸门/风险/数据模式"三类信息。**

## C. 待后续阶段补齐

- 插件安装 + skills 隐式调用验收（`codex plugin marketplace add` + `codex plugin add`）→ P2。
- 真实 tRPC/DB 数据接入 → P3。

## D. 发现与修正

1. **目录计数假阳性**：模型自带的快速脚本用 `^(key|presetKey):` 正则，漏掉了仓内实际使用的 `preset_key:`，因此报告"72 员工 / 77 围栏"与工具返回的"73 / 76"不一致。用独立正则复核后，仓内事实是 **73 员工 / 77 围栏**，与目录生成器一致；已把该独立校验固化为单测 `目录计数与仓内文件的独立正则扫描一致`。
2. **跨 bundle 同名岗位风险合并**：`ads-optimizer` 在 ai-video 标注 `high_risk: true`（烧投流预算）、在 geo-growth 标注 `false`；目录按"取更严口径"合并为 `high`，避免低估风险。
3. **MCP 工具解析误报**：首版把 preset 的 `coverage` 条目误当 tools，产生 74 条告警；已改为块级解析，告警清零。

---

## P1 验收记录（2026-09-22，治理闭环）

### A. 自动化验证（已通过）

| 项 | 命令 | 结果 |
|---|---|---|
| 网关单测 | `node --test tools/codex-gateway/test/*.test.mjs` | 24/24 通过（目录/HTTP+SSE/MCP/围栏/审批/账本/跨进程） |
| 自检 | `node tools/codex-gateway/bin/cli.mjs doctor` | 全部 PASS；policy-bridge 5 包 / 77 规则；ledger-chain 通过 |
| 真实围栏裁决 | 策略桥（tsx + 仓内 `fence-engine`） | `publish.execute` 日发 0 → review（G9）；日发 7 → block（G9b）；缺上下文 → fail-closed block 并留痕；`content.submit` 事实红线 → block（G-GEO2）；`script.draft` → auto（G-C01） |
| CLI 跨进程闭环 | `run start → approval decide → run status → ledger verify` | 14 条五元事件哈希链跨进程验链通过 |

### B. 真机视觉验收（已通过）

- Chrome 打开 `http://127.0.0.1:4310/stage`：深色工位大屏、73 个数字员工工位、风险徽章、能力目录（10 条管线 + 闸门）、待审批（三手势按钮）、Run 列表与取消按钮、实时事件流、`dataMode=simulated` 徽章与模拟/真实分层声明全部正确渲染。
- 有真实 Run 状态时 KPI/额度显示"暂无真实 KPI/额度（P3 接入），当前不展示模拟数值"，不再真假混层。

### C. 真实模型触发验收（已通过）

前置：`$CODEX_HOME/workloomtest.config.toml` 注册 `workloom-core` MCP；无人值守用 `codex exec --approve-for-me`（Codex 层自动审查），网关内部 G9 人审仍强制。

回合 1（只发起，不批准）：

- 模型调用 `workloom_run_start`（`employee:publish-operator` / `publish.execute` / `publish_task:codex-e2e-004` / `account_daily_published=0`）。
- 结果：`RUN-mubijb59-ca100b`，`state=waiting_approval`，`APR-mubijbap-4dda1a`，围栏 `review`（G9「公网发布必审」），4 步 `queued`，无回执。
- 模型明确声明这是高风险发布、必须由人批准，且未调用 `approval_decide`。

回合 2（人类 owner 明确授权批准）：

- `approval_decide` → approved；`run_status` → completed；`ledger_verify` → 26 条事件链完整；`receipt.synced=true`，回执 URI `workloom-sim://receipt/RUN-mubijb59-ca100b`。
- 模型明确声明：这是模拟执行，不是真实平台发布。

回合 3（修复 schema 后复测）：

- `run_start` → `RUN-mubinu24-bda8c8` / `APR-mubinu6u-3b133d`（G9 review）。
- `approval_decide` 以对象手势 `{type:"approve"}` 一次通过（无需读源码绕过）。
- `run_status` → completed，4/4 步 done，`receipt.synced=true`；`ledger_verify` → 34 条事件链完整。

### D. 真机发现并修复的问题（8 项）

1. **Codex 层写工具审批**：`codex exec` 默认审批策略 `never` 会直接拒绝 `readOnlyHint:false` 的 MCP 工具（实测 `MCP tool call requires approval, but approval policy is never`），调用根本不进网关；`default_tools_approval_mode="auto"` 在该策略下也不足以放行。**处置**：交互式保持 Codex 审批；无人值守使用官方 `--approve-for-me` 自动审查；网关内围栏/人审不降级。已写入插件 README 与计划。
2. **MCP `gesture` schema 与实现不一致**：schema 声明字符串、实现要求 `{type:...}`，真实模型首次调用被 `INVALID_GESTURE` 拒绝。**处置**：schema 改为对象（必填 `type`），后端兼容字符串归一化，新增单测；复测一次通过。
3. **跨进程可见性**：CLI 写入 JSONL 后，已运行的 stage 服务仍读内存快照，导致工作台看不到新审批。**处置**：store 读操作前按文件大小变化自动重载，新增多进程可见性单测。
4. **账本哈希跨进程失效**：`canonicalize` 把 `undefined` 字段算进哈希，JSON 落盘后丢字段导致重载验链必坏（内存内测试掩盖）。**处置**：对齐 JSON.stringify 语义（对象丢 undefined、数组转 null），新增跨进程重载验链单测。
5. **舞台相对路径 404**：`/stage` 无尾斜杠时 `./app.js`/`./styles.css` 解析到根路径，页面只有壳、无样式无数据。**处置**：资源与 API 全部改绝对路径 `/stage/...`；真机截图复核。
6. **KPI/额度真假混层**：切到 `simulated` 后仍显示夹具 KPI/额度。**处置**：有真实状态时隐藏夹具指标，显示"暂无真实 KPI/额度"。
7. **`loadFencePack` 不兼容 G*/G-GEO* 规则号**：其 zod 只接受 R 号，直接抛错。**处置**：策略桥复用 `apps/server/src/trpc/router.ts` 的裸 YAML + `fenceRulesOf` 口径，不改基座。
8. **CLI 子进程泄漏**：doctor 创建策略桥后未关闭，CLI 无法退出。**处置**：统一 `activeService` 退出清理。

---

## P2 验收记录（React 工作台页，2026-09-22）

- 新增 `apps/web/src/pages/codex-workbench/CodexWorkbench.tsx`，并在受管 `App.tsx` 注册路由 `/codex-workbench`（实验副本内允许；不回流基座）。
- 页面内容：真实数据模式徽章、73 员工/在岗/待输入/阻塞/待审批/Run 计数、内嵌 `http://127.0.0.1:4310/stage` 数字人工作台；网关未启动时显示明确错误与启动命令。
- 验证：`pnpm -C apps/web typecheck` 通过；Vite dev（WEB_PORT=3620，proxy→SERVER_PORT=9397）真机打开 `/codex-workbench`，Chrome 无障碍树确认：外层页面计数 73/25/1/0/2/2，内嵌舞台 `dataMode=real`、真实 ticker（visibility-watcher / company-ceo / review-analyst 等）、theater 待决 captain 1 / chairman 2。
- 边界：该页只读；写操作仍由 Codex 或数字人工作台经能力网关发起（先围栏、后人审、五元事件、回执）。

## P3 验收记录（真实数据接入，2026-09-22）

- **独立业务库**：在本地 Postgres 55432 实例上创建 `workloom_growthtest`（与同实例的 growth 库隔离）；`.env` 本地生成（gitignored，复用本机凭据，改库名与端口 SERVER_PORT=9397 / WEB_PORT=3620，不打印任何密钥）。
- **迁移与种子**：`pnpm db:migrate` 应用 38 个迁移文件；`pnpm db:seed` 灌入 27 名数字员工（组合上岗 73 岗）、77 条围栏、77 个技能、60 条五元事件（哈希链）、3 项待批请示、14 个触发器、夜班班次与双域演示数据。
- **真实 tRPC**：growthtest server 运行在 127.0.0.1:9397；`auth.loginAs`（geo-growth / MEM-G01）→ `roster.list` 返回 73 名真实员工（online/status/stats/fenceBindings）→ `captain.theater` 返回 14 条真实 ticker、`mode=trial`、`pendingByTier={l2_captain:1,l4_chairman:2}`。
- **网关投影**：`WORKLOOM_TRPC_URL=http://127.0.0.1:9397/trpc`；`/stage/snapshot` 返回 `dataMode=real`，`sources={roster:real,theater:real,runs:simulated,approvals:simulated}`，73 员工 / 25 在岗 / 46 离线；真实 ticker 渲染到工作台。
- **计数口径分离**：网关审批（P1 store，2 项）与业务待决（真实 tRPC，3 项）是两套来源，已在 `counts.pendingApprovalsSource` / `counts.theaterPendingSource` 与工作台统计卡（“网关审批”/“业务待决（真实）”）显式分列，禁止混用。
- **真实模型触发验收**：`codex exec` 只读调用一次 `workloom_stage_snapshot`；模型报告 `dataMode=real`、73 员工、25 在岗、2 网关待审批、`theater.mode=trial`、`pendingByTier l2=1/l4=2`，并主动指出两套审批计数不同源——该问题已按上一条修复。
- **未覆盖（P4 继续）**：真实平台连接器（发布/投放/渲染仍为显式模拟）、写路径落业务库（P1 写网关 append-only JSONL；接 workdata/RLS 为 P4）、多租户与生产部署。

## P4 验收记录（真实业务库五元事件镜像，2026-09-22）

- **实现**：策略桥新增 `appendEvent`，调用真实 `getGatewayPool()` + `gatewayAppend()`（权限校验 → PII 脱敏 → 高风险授权 → 同一 RLS 事务落库）；网关把每次 Run 的本地账本事件镜像进 `biz_events`，本地 event_id 与 DB event_id 的映射 append 到 `data/codex-gateway/mirror.jsonl`，失败不静默（`dbMirror.failed` 与 mirror.jsonl 均留痕）。
- **CLI 真机验收**：`WORKLOOM_DB_MIRROR=1` 下跑 G9 全闭环；`run.started/approval.asked` 2/2、批准后累计 14/14 事件镜像成功（DB E-9100…E-9113），`biz_events` 60→74；`pnpm db:verify-chain`：2 个 workspace 段 / 205 条事件、六项检查全绿。
- **真实模型终验**：`codex exec -p workloomtest --approve-for-me` 执行 `run_start → approval_decide → run_status`；Run `RUN-mubj6tmi-f6dac3` completed、`receipt.synced=true`、`dbMirror={ok:true,total:8,mirrored:8,failed:0}`，DB 事件 E-9114…E-9121；`biz_events` 74→82，`db:verify-chain` 213 条事件全绿。模型明确声明本次为模拟执行（`workloom-sim://`），不是真实小红书发布。
- **P4 真机发现并修复**：首次镜像 0/14，原因是策略桥客户端未暴露 `appendEvent`（`policy.appendEvent is not a function`）；失败被如实写入 mirror.jsonl，未伪装成功。补齐客户端方法后复测 14/14、8/8 通过。
- **P4 剩余（未覆盖）**：
  - 真实平台连接器（发布/投放/渲染仍是显式模拟执行，等待连接器与考试院）；
  - 审批写回业务库 `approvals` 表（当前人审在网关 store；DB 侧仅镜像事件）；
  - MCP 工具 allow/deny 策略、hooks 信任审查与插件 marketplace 安装的真机验收；
  - 多租户/多工作区切换、生产部署与发布门禁。

## P4 插件打包与安装验收（2026-09-22）

- **marketplace / 插件安装**：`codex plugin marketplace add /Users/mac/WorkLoom-fleet/workloom-growthtest` 成功；`codex plugin add workloom-workbench@workloom-growthtest` 成功，安装缓存 `~/.codex/plugins/cache/workloom-growthtest/workloom-workbench/0.1.2+codex.*`；插件列表中为 installed/enabled。
- **真机发现的平台行为**（JSONL 警告 + 环境取证脚本）：
  1. Codex 启动插件 stdio MCP 时 **cwd = 项目目录**（不是插件根），`PLUGIN_ROOT` / `CLAUDE_PLUGIN_ROOT` **均未设置**；
  2. `.mcp.json` 的相对命令 `./scripts/start-mcp.sh` → `No such file or directory`；
  3. `$PLUGIN_ROOT/scripts/start-mcp.sh` 形态 → `MCP server startup failed ... initialize response: connection closed`（脚本分支直接退出）；
  4. 绝对命令路径可以正常握手，证明启动环境本身可用。
- **处置**：新增 `scripts/install-launcher.sh`，把 `workloom-workbench-mcp` 启动器安装到 `~/.local/bin`（Codex 的 PATH 已包含该目录），并在插件根写入 `repo-root.txt`（已加入 `.gitignore`，不入库）；`.mcp.json` 改为 `"command": "workloom-workbench-mcp"`。官方便携格式目前只支持远程 HTTPS MCP，本地 stdio 属于兼容/本地测试用法，公开分发应改为远程 HTTPS。
- **终验**：不加载任何临时 profile，直接 `codex exec`；真实模型自动发现插件技能与 `workloom-core` MCP 工具，调用 `workloom_health` 一次成功，返回 `ok=true`、`counts.employees=73`、`counts.pipelines=10`、`warnings=[]`。
- **仍未覆盖**：MCP 工具 allow/deny 与 hooks 信任审查的端到端配置（hooks 已提供 `hooks/hooks.json`，首次启用需用户在 `/hooks` 或桌面端信任）；多工作区切换与生产分发。
