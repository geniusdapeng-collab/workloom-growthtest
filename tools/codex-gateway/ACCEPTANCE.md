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
