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
