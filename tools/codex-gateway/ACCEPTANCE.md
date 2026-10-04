# P0 恢复验收 · WorkLoom × Codex 工作台

> 任务：T-2026-1002-9001；仓库：workloom-growthtest；恢复版本：0.1.3。
> 本页的历史真实模型记录来自 2026-09-22；本轮重新测得的入口、计数、安全与页面结果如下。数据目录由当前仓文件生成，工作台运行态明确为 mock。

| 项 | 入口 / 前置条件 | 本轮结果 |
|---|---|---|
| 永久测试 | Node 24，`node --test tools/codex-gateway/test/*.test.mjs` | 17 tests，17 pass，0 fail，0 skipped；含旧目录/HTTP+SSE/MCP 与恢复新增安全负例 |
| CLI 自检 | `node tools/codex-gateway/bin/cli.mjs doctor` | 9/9 PASS；81 员工、94 技能、11 管线、121 围栏；告警 0、未解析 0 |
| 只读协议 | stdio initialize + tools/list + resources/list | 五个只读工具，三个 JSON 资源；工具与资源无 P1 写权限 |
| 路径与启动 | 真实含空格和单引号路径、显式错误 Node/仓库路径 | 正确路径可启动；错误显式配置拒绝，不悄悄改用其它仓库或 Node；Node 主版本至少 24 |
| HTTP 安全 | loopback host/port、恶意 Host/Origin、静态路径与坏 URL 编码 | 外域/越界拒绝；坏编码返回 400 后服务仍可用；`/stage` 重定向到 `/stage/`，JS/CSS 可加载 |
| 桌面页面 | 隔离 Chrome，1440×960 | 81 员工、SSE 已连接、mock 标记可见、审批按钮禁用、无页面错误或横向溢出 |
| 移动页面 | 同一临时服务，390×844 | mock 标记与禁用状态可见、无页面错误或横向溢出；截图人工自查已完成 |

本轮只证明 P0 目录发现、只读投影与网关可运行。真实 tRPC/DB、执行任务、写审批和产品业务结果仍须完成 P1 接线与独立行业验收；不能由模拟工作台结果推出已接通。

安装实例通过插件自己的 `repo-root.txt` 指向长期主工作目录，实例文件不提交到仓库。`start-mcp.sh` 与 SessionStart 使用同一入口定位。用户正在运行的 Codex 会话不会被强行重启，新的工具注册以工具重连后的实际清单为准。

---

# 历史记录（2026-09-22，不作为本轮运行证据）

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

- 工作台页面真机截图（Chrome/Codex 内置浏览器视觉核对）→ P0 收尾/P1。
- 插件安装 + skills 隐式调用验收（`codex plugin marketplace add` + `codex plugin add`）→ P0 收尾。
- 写路径（run_start / approval_decide）与围栏/审批/账本/回执闭环 → P1。
- 真实 tRPC/DB 数据接入 → P1/P3。

## D. 发现与修正

1. **目录计数假阳性**：模型自带的快速脚本用 `^(key|presetKey):` 正则，漏掉了仓内实际使用的 `preset_key:`，因此报告"72 员工 / 77 围栏"与工具返回的"73 / 76"不一致。用独立正则复核后，仓内事实是 **73 员工 / 77 围栏**，与目录生成器一致；已把该独立校验固化为单测 `目录计数与仓内文件的独立正则扫描一致`。
2. **跨 bundle 同名岗位风险合并**：`ads-optimizer` 在 ai-video 标注 `high_risk: true`（烧投流预算）、在 geo-growth 标注 `false`；目录按"取更严口径"合并为 `high`，避免低估风险。
3. **MCP 工具解析误报**：首版把 preset 的 `coverage` 条目误当 tools，产生 74 条告警；已改为块级解析，告警清零。
