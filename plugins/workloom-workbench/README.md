# workloom-workbench（Codex 插件 · P0 实验）

把 WorkLoom（growthtest 隔离实验仓）接入 Codex：

- 技能：`workloom`（能力总路由，可隐式触发）、`workloom-growth`（增长域，仅显式 `$workloom-growth`）。
- MCP：`workloom-core`（stdio，P0 只读 6 tools + 4 resources，包含固定视频指南）。
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
3. 安装 MCP 启动器到 PATH（真机取证：Codex 启动插件 MCP 时 cwd=项目目录且不提供 PLUGIN_ROOT，所以不能用相对路径）：

   ```bash
   sh plugins/workloom-workbench/scripts/install-launcher.sh
   ```

   它会把 `workloom-workbench-mcp` 写入 `~/.local/bin`（Codex 的 PATH 已包含），并在插件根写入 `repo-root.txt`。
4. 重启 Codex（或刷新插件），让插件 MCP server 用启动器重新拉起。
5. 第一次加载后，hooks 需要信任审查：在 CLI 用 `/hooks`，或在桌面端按提示确认。未信任前 hook 不会运行。

> 平台行为（2026-09-22 实测）：插件 MCP 启动时 `PLUGIN_ROOT`/`CLAUDE_PLUGIN_ROOT` 未设置、cwd 是项目目录；
> 相对命令会报 `No such file or directory`，`$PLUGIN_ROOT` 路径会握手失败。官方便携格式目前只支持远程 HTTPS MCP；
> 本地 stdio 需要 PATH 启动器或绝对路径（见本目录 `scripts/install-launcher.sh`）。

## 手工验证 MCP（不依赖 Codex）

```bash
sh plugins/workloom-workbench/scripts/start-mcp.sh
# 输入： {"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
# 输入： {"jsonrpc":"2.0","id":2,"method":"tools/list"}
```

## P0 边界

视频任务先调用 `workloom_video_guide({})` 或读取 `workloom://guides/video`，完整正文来自
[`docs/ai-video-workbench-guide.md`](../../docs/ai-video-workbench-guide.md)。同文 CLI 为
`node tools/codex-gateway/bin/cli.mjs video guide`；通用能力入口为
`node scripts/workloom-agent.mjs invoke growth.video.workbench.guide`。
握手提示与受信任 SessionStart context 指向同一指南，先冻结用户约束再走正式执行器；
工具只读，不启动生产或证明完成。已在运行的插件需按客户端重连后实际工具清单核对；本文件不触发重启。

只读。没有 run/approval 写工具；不会启动任务、不会审批、不会写业务数据。

## 后续阶段

P1 的派遣、审批、取消与审计写入尚未实现。只有接通围栏、审批、追加事件和真实回执，并通过单独验收后才会增加写工具。当前 manifest、hooks、技能和 MCP 统一为 P0 只读。
