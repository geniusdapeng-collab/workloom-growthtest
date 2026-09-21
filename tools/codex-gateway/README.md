# tools/codex-gateway · WorkLoom × Codex 能力网关（P0）

> 实验说明：本目录是 `workloom-growthtest` 隔离副本上的 Codex 工作台实验（P0）。
> 内容**不回流基座**、不参与 base-sync；实验成功后的公共能力必须先走提案任务卡按 L2→L1→L0 重做。
> 完整计划与边界见 [`docs/CODEX-WORKBENCH-PLAN.md`](../../docs/CODEX-WORKBENCH-PLAN.md)。

## 这是什么

把 WorkLoom 的能力以 **MCP + HTTP/SSE + CLI** 三种面暴露给 Codex：

- **能力目录**：从 `bundles/*/bundle.json`、`presets/*.yml`、`skills/*/SKILL.md`、`fences/*.yml`、`pipelines/*.yml` 自动生成，不手写第二份清单。
- **数字人工作台投影**：`TeamProjection` 快照 + SSE 事件流；P0 的员工/能力来自代码事实，运行态/审批/KPI/额度来自 `fixtures/mock-state.json`（`dataMode=mock`）。
- **只读 MCP server**：`workloom_catalog_search` / `workloom_catalog_describe` / `workloom_stage_snapshot` / `workloom_stage_url` / `workloom_health`。
- **CLI**：`catalog` / `stage` / `doctor` / `context` / `mcp`。

## 运行（Node ≥ 24）

本仓未在系统 PATH 放 Node 时，用 Codex 捆绑运行时：

```bash
NODE="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"

# 能力目录
"$NODE" tools/codex-gateway/bin/cli.mjs catalog list --limit 30
"$NODE" tools/codex-gateway/bin/cli.mjs catalog describe pipeline:dual-content-factory

# 自检
"$NODE" tools/codex-gateway/bin/cli.mjs doctor

# 启动工作台（默认 127.0.0.1:4310）
"$NODE" tools/codex-gateway/bin/cli.mjs stage serve
# 浏览器打开 http://127.0.0.1:4310/stage

# MCP stdio（供 Codex 调用）
"$NODE" tools/codex-gateway/bin/mcp.mjs

# 测试
"$NODE" --test tools/codex-gateway/test/
```

## 端口与安全

- 默认只绑定 `127.0.0.1`，端口 `WORKLOOM_GATEWAY_PORT`（默认 4310）。
- 只读：不连数据库、不写业务数据、不读密钥；CORS 只放行 localhost 来源。
- P0 **不暴露任何写工具**。审批/派遣/启动 Run 等写操作必须等 P1 接通围栏 → 审批 → 五元事件 → 回执后再开放。
