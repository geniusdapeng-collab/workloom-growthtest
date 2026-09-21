# workloom-workbench（Codex 插件 · P0 实验）

把 WorkLoom（growthtest 隔离实验仓）接入 Codex：

- 技能：`workloom`（能力总路由，可隐式触发）、`workloom-growth`（增长域，仅显式 `$workloom-growth`）。
- MCP：`workloom-core`（stdio，P0 只读 5 tools + 3 resources）。
- Hooks：SessionStart 注入工作区/在岗/待审批摘要（P0）；写操作审计在 P1 接入。

## 为什么在仓内

growthtest 是 `none-in-none-out` 隔离副本：基座内容不下发、本仓改动不回流。
插件与网关随实验仓一起版本化，等实验成功后再走提案任务卡公共化。

## 安装（实验机）

1. 在 Codex 中加入仓内 marketplace（非默认 personal marketplace，需要显式添加）：

   ```bash
   codex plugin marketplace add /Users/mac/WorkLoom-fleet/workloom-growthtest
   ```

2. 在 Codex 插件页安装 `workloom-workbench`；或直接用本仓 `plugins/workloom-workbench/.codex-plugin/plugin.json` 做本地开发验证。
3. 第一次加载后，hooks 需要信任审查：在 CLI 用 `/hooks`，或在桌面端按提示确认。未信任前 hook 不会运行。

## 手工验证 MCP（不依赖 Codex）

```bash
sh plugins/workloom-workbench/scripts/start-mcp.sh
# 输入： {"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
# 输入： {"jsonrpc":"2.0","id":2,"method":"tools/list"}
```

## P0 边界

只读。没有 run/approval 写工具；不会启动任务、不会审批、不会写业务数据。
