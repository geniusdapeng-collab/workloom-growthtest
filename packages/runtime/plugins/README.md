# packages/runtime/plugins · dsh 挂载点（D12）

> 双轨纪律：六插件核心逻辑在 `packages/base/`（自研护城河、纯服务层、可单测）；
> 本目录只放 dsh 插件适配器（Cordis 生命周期薄壳），把自研服务挂进 dsh 的 seam/事件。

| 文件 | dsh 挂载点 | 对接的自研服务 |
|---|---|---|
| `workloom-fence.plugin.js` | `tools/pre-execute` 瀑布 | 认证规则投影的保守工具级约束；业务条件仍由服务端 fence-engine 求值 |

## 实证路径（B0 已验证的挂载方式）

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- insert:
    - id: workloom-fence
      name: '<本文件绝对路径或 npm 包内路径>'
      config:
        rulesUrl: 'http://localhost:8787/trpc/fence.activeRules'
        tokenEnv: WORKLOOM_TOKEN
        requireAuth: true
        timeoutMs: 5000
```

令牌由启动环境注入，配置文件只存变量名。规则地址支持 HTTPS，以及本机回环地址的 HTTP；不接受 URL 内凭据、查询参数或重定向。生产挂载需开启 `requireAuth`，每个插件实例使用与所属工作区相符的认证身份。

插件每次调用都读取当前规则，不复用上一轮的允许结果。缺地址、缺必需身份、网络/解析错误、超时、空规则、未知级别、重复规则、未命中动作一律拒绝；调用取消会停止读取且不派发工具。响应正文上限 512 KiB、规则最多 2000 条，超时默认 5 秒且最多 30 秒。日志只记录工具名和级别，不记录令牌、工具参数、规则正文或地址。

规则可为原始数组，也可为 `fence.activeRules` 的 `{ result: { data: [...] } }` 响应。`auto` 仅匹配完整工具名或明确的 `.*` 子树；例如 `video.read` 不授权 `video.render.submit`。`block > review > auto`，限制规则保留按点分隔的首级命名空间保守拦截。`review` 返回 Harness 的 `ask`，不等于服务已批准生成。

这个适配器不能独立求值业务 DSL、对象类型或身份约束。潜在匹配规则含条件、对象范围或未知约束时，返回 `RULES_REQUIRE_SERVICE_EVALUATION`，应通过系统已注册的服务工具完成业务判断。不要为了让原生 shell 通过而加入宽泛 `auto: '*'`；工具名许可不表示 shell 参数或子进程已取得视频生产资格。正式视频调用仍须经过服务的预生产、围栏与签名生成资格，同一操作系统用户可直接运行的命令也不受此插件隔离。

挂载合同核对基于 [DeepSeek Harness dsh-v0.1.6-alpha.2 tools/pre-execute](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.2/packages/core/tools/src/index.ts)：`next()` 继续瀑布；`deny` 拒绝；`ask` 请求审批；`cancel` 取消；异步处理观察 `exec.signal`。本批通过真实 HTTP 规则源驱动实际插件 hook 的测试；没有把它表述为完整 Harness 进程实测。

## 后续挂载点（dsh-integration.md §3 映射表）

| 插件适配器（待落） | seam | 自研侧 |
|---|---|---|
| session-persistence-pg | `ctx.sessionPersistence` | workdata 事件桥（五元投影+哈希链 G8） |
| llm-workloom-router | `ctx.llm`（registerAdapter） | model-router（B7 分级/峰谷/降级链/计量） |
| review-console | `ctx.approval` / `ctx.userQuestions` | review-console（B6 三手势域） |
| night-shift | `ctx.jobs` + `ctx.commands` | night-shift（B9 状态机） |
| credentials-pg | `ctx.credentials` | credentials 表（引用 ID 口径 L7.3） |
| G8 不变量 | `ctx.invariants` | 「模型可见即已记录」校验 |
