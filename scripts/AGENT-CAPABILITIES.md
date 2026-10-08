# WorkLoom Agent 能力入口 v1

此入口供 Codex、DeepSeek Harness 等桌面 Agent 使用。仓库内的能力清单是唯一可发现集合：公共只读能力在
`scripts/agent-capabilities.core.json`，行业能力在
`bundles/<defaultBundle>/agent-capabilities.json`。已有 PC/B/C UI 与 CLI/MCP 调用同一服务端过程；
CLI 和 MCP 不直接写数据库，也不能绕过服务端的成员/住客范围、围栏、审批、事件与回执链。

## 本机使用

视频任务先读 `node scripts/workloom-agent.mjs invoke growth.video.workbench.guide`：返回
`result.markdown` 全文、仓库/产品身份、版本及实际 SHA-256。对应 MCP 工具为
`workloom_growth_video_workbench_guide`，空参数 `{}`，只读固定本仓文档。
完整调用纪律见 [AI 工作台视频指南](../docs/ai-video-workbench-guide.md)；`production.plan.usageGuide`
指向同一文件。Growthtest 插件的独立 P0 网关使用 `workloom_video_guide` 与
`workloom://guides/video`，不会因为读取指南而具备生产写权限。

要求 Node.js 24（与仓库 `package.json#engines` 一致）。从仓库根执行：

```sh
node scripts/workloom-agent.mjs list
node scripts/workloom-agent.mjs describe core.threads.get
printf '%s\n' '{"threadId":"T-101"}' | node scripts/workloom-agent.mjs invoke core.threads.get --input-file -
node scripts/workloom-agent-mcp.mjs
```

`list` 和 `describe` 无网络调用。默认服务地址从
`product.manifest.json#desktop.portOffset` 计算为本机 `127.0.0.1:8787+offset`；
可通过 `WORKLOOM_BASE_URL` 或 `--base-url` 覆盖。非回环地址必须使用 HTTPS。
开发源码服务若直接运行在 8787，应显式设 `WORKLOOM_BASE_URL=http://127.0.0.1:8787`。
一个 CLI 可以用 `--root <产品仓路径>` 读取另一仓的产品清单；MCP 用
`WORKLOOM_PRODUCT_ROOT` 指定产品仓。公共能力清单始终随 CLI 版本提供，
行业清单由目标仓提供。

本机开发态在未提供 `WORKLOOM_ACCESS_TOKEN` 时，CLI 使用
`product.manifest.json#demoWorkspaceSlug/demoMemberNo` 请求现有 `auth.loginAs`
得到当前工作区成员会话；可用 `WORKLOOM_WORKSPACE_SLUG`、
`WORKLOOM_MEMBER_NO` 指定另一种子成员，用 `WORKLOOM_DEV_AUTO_LOGIN=0` 禁用。
远程地址必须预先提供 `WORKLOOM_ACCESS_TOKEN`。C 端能力单独要求
`WORKLOOM_C_TOKEN`；它与 B 端成员令牌不能互换。令牌只读环境变量，
不得放进命令参数、仓库文件或日志。

## 能力与完成判定

每项清单提供稳定 ID、版本、输入 JSON Schema、操作类别、风险、数据模式和受控传输。
传输只允许服务端 tRPC、同源 `/c/` 路径以及行业目录下的本地只读预览函数。
禁用项会在 CLI 清单中显示原因，不进入 MCP `tools/list`，调用时失败关闭。
执行类能力强制 `idempotencyKey`，但幂等、授权与审批最终由服务端实施。

成功调用返回单行 JSON，格式为
`{schemaVersion, capabilityId, operation, status, dataMode, result, receipt?}`。
`status=pending` 表示动作已提交但交付尚未核实；`receipt.synced` 只从服务端
可验证回执得出。提供的外部快照用 `provided-unverified`，演示工单用
`simulated`，不能被客户端提升为真实外部完成。错误只写 stderr 并返回非零退出码。

MCP 以 stdio JSON-RPC 暴露同一清单，每项能力一个工具；其
`readOnlyHint/destructiveHint/idempotentHint` 是客户端提示，不是授权边界。
Codex 配置本地 STDIO MCP 与 DeepSeek Harness 自定义 STDIO MCP 时，
命令均指向本仓 `node scripts/workloom-agent-mcp.mjs`；具体配置键以各客户端
当前官方文档为准。

## 开发与发布

行业清单留在行业 bundle，不把行业语义写进基座。服务端新增路由必须复用
该仓已验证的权限/租户/围栏/事件路径，并有独立回执查询；不能仅在清单里
登记一个脚本或将 mock 结果标作真实交付。修改后运行：

```sh
node --test scripts/agent-capabilities.test.mjs
node scripts/workloom-agent.mjs list
node scripts/workloom-agent-mcp.mjs
```

然后按仓库 `AGENTS.repo.md` 与 `docs/release-checklist.md` 运行相关类型、
测试、secret scan、发布门禁及真实客户端验收；未全部通过不得发布可执行制品。

## 视频能力的输入、计划和核验

`growth.video.production.plan` 仍是只读能力。它读取分流记录与镜头卡，检查镜头 ID/时长结构、
已声明 fps 是否一致、当前可精确提交的整数 4–12 秒镜长，以及每镜同源原声合同。
`ready=true` 只表示这些已读输入和本地配置检查通过；余额、模型权限、完整镜头规范、
人物身份与授权仍须由执行器实际检查。失败项会进入 `checklist`，同时
`recommendedCommand=null`、`argv=[]`，避免执行一个已知有问题的计划。

计划提供 `executable`、完整 `argv` 和执行工作目录 `workDir`。调用方应直接用进程 API 传递
参数数组，`recommendedCommand` 只是用 POSIX 单引号逐参数引用的人工查看版本。
镜头卡、分流、生产目录与输出目录均解析为产物根内的绝对路径；在仓外存放素材时由运行者设置
`WORKLOOM_VIDEO_ARTIFACT_ROOT`，请求本身只能给相对路径。父目录软链即使指向尚不存在的文件，
也会进行真实路径复核。输入 `workDir` 选择阶段产物目录，返回的 `artifactWorkDir` 是其绝对路径。

`unifiedNarration=true` 和关闭原生音频均阻断计划；画外音与环境声也只能来自同文件原片。
返回 `audioSourcePolicy=render-native`。标准生产不以本地配音或 ASR 为前置；计划没有语音识别、台词正确性或口型认证。

`growth.video.delivery.inspect` 对 `entries`、`assets` 和旧清单指针逐文件计算实际 SHA-256，
将同一路径的声明合并比较。`integrity=sha256-verified` 表示每个列出的文件都有一致的声明哈希；
哈希缺失时保持 `unverified`，缺件、哈希/字节数不符、冲突声明或越界时为 `incomplete`。
标准后期 `workloom.standard-post-delivery/v1` 的 `outputs` 也逐版本核验，主版必需、版本 ID 唯一；
封面路径必须与首帧回执声明一致，并重新计算实际封面摘要。它不把哈希一致升级为内容质量、口型或授权通过。

`growth.video.production.status` 与出片 CLI 共用 `scripts/tools/film-render-ledger.mjs`：
只有带有效平台 `taskId` 的任务计入受理数，同一任务的 GET 接续、重复或缓存观察不重复计数，
最新结果覆盖之前的失败记录。无有效 ID 的调用列入 `unacceptedRenderRecords`，受理状态未知；
平台拒收与 canary 中止单列。台账不估算金额，也不把轮询/下载失败当作新的付费提交。
