# 一句话导演制作 V2：使用与故障恢复

读者是希望把一个想法做成多支作品的客户，以及接入 Codex、DeepSeek Harness 的开发者。
默认入口为 `/ai-video/assets?tab=studio`。输入需求后，导演负责普通创作决策；缺本人素材、费用授权或服务配置时，页面明确说明缺口。
专业旧工作台通过同页的“专业工作台”链接进入 `advanced=1`。

本文以 `T-2026-1002-0001` 的代码为依据。配方是本产品的创作选择，不是平台算法或流量承诺。

## 三个典型场景

1. 民宿负责人输入“雨后的山间民宿，克制、有电影感”。系统创作共享镜头池，分别交付抖音、小红书、视频号和导演惊喜版；不编造房价、优惠、星级。
2. 本人输入“把我拍成夜色里很有气质的主角”。系统沿用专业造型、光线、镜头和背景默认值；本人参考与授权尚未就绪时只保存方案，要求一次素材准备。
3. 客户看完成片后说“第二版音乐太热闹，安静一点”。意见归因到该版音轨，复用已有画面；要求“增加一个新场景”则先返回新画面计划和预算缺口。

## 默认交付和明确指令

未指定数量和平台时，目标为三支常规版与一支导演惊喜版。
常规版各有独立画面 EDL、声音 EDL、字幕、调色、封面和文案；惊喜版在相同事实与身份边界内另做创作。
只改变文件名、编码、音量或封面，不算作品差异。每版保存实际执行的 EDL、声音编排和源文件哈希；当前技术质检不为作品差异或审美打分，差异报告明确保留“未复核”。

明确指定平台、数量、禁用惊喜、每平台三种风格时，以目标解析器的结果为准。
数量冲突返回可读错误，不静默删版。可先运行免费本地预览：

```bash
printf '%s' '{"intent":"抖音、小红书、视频号各一版，再给导演惊喜版"}' \
  | node scripts/workloom-agent.mjs invoke growth.video.director.preview --input-file -
```

这条命令调用 `resolveDeliveryTargets` 与 `buildDirectorDefaults`，网络模型请求为 0。
人物身份档案、当次造型方案、摄影与场景配方分别保留来源；美化不能覆盖本人身份或题材约束。

## 服务 CLI：真实文字方案和制作

前置条件：本仓规定的 Node 与依赖、运行中的服务、当前工作区成员令牌，以及已配置的真实文字模型。
地址由 `WORKLOOM_BASE_URL` 提供；默认为 manifest 的本机端口。远程地址必须 HTTPS。
令牌只从运行环境 `WORKLOOM_ACCESS_TOKEN` 读取，不放输入文件、命令参数、仓库或报告。

保存 `intent.json`：

```json
{
  "intent": "雨后民宿的电影，只拍空景，不编造优惠价格",
  "idempotencyKey": "hotel-plan-20261002-0001"
}
```

```bash
# plan 会强制 mode=plan；真实文字模型完成四轮创作后保存冻结方案
node scripts/workloom-director.mjs plan --input-file intent.json

# start 默认 mode=produce；有预算、本人授权和可用供应商才会继续制作
node scripts/workloom-director.mjs start --input-file intent.json
```

`plan` 会消耗文字模型费用，不会提交图像或视频请求。模型没有就绪则失败，不用模板冒充。
CLI 返回 `schemaVersion=workloom.director-cli/v2`、命令和服务返回值。创建任务为异步，请用返回的 `id` 轮询：

```json
{"jobId":"返回的任务 id"}
```

```bash
node scripts/workloom-director.mjs job --input-file job.json
node scripts/workloom-director.mjs versions --input-file project.json
```

`project.json` 为 `{"projectId":"返回的项目 id"}`。`mediaReady=false` 表示文字方案或准备阶段，不代表已交付视频。
服务返回的阶段、缺口、必要授权、预算、版本状态和可播放地址可供页面或 Agent 展示，不返回私有工程路径或供应商凭据。

## 固定 API 契约

统一前缀 `/trpc/video.creative.`；query 使用 GET，参数为 `input` 查询字符串中的 JSON；mutation 使用 POST JSON。
身份从 Authorization Bearer 读取。读取要求 `ai-video.assets.read`，写入还要求工作区写权限；预算审批同时要求 `approval.decide`。

| 过程 / CLI | 方法 | 关键输入 | 关键返回 |
|---|---|---|---|
| `resolveTargets` / `targets` | GET | `intent`、可选 `options` | 目标数量与版本合同 |
| `start` / `plan,start` | POST | `intent` 2–10000 字符；幂等键 8–200 字符；可选 `mode,deliveryOptions,identityAssetRefs,maxBudgetCny` | 任务 id、项目 id、状态、是否复用 |
| `jobs` / `jobs` | GET | 可选 `projectId,limit`，上限 50 | 当前工作区任务列表 |
| `job` / `job` | GET | `jobId` | 阶段、冻结版本、实际交付与错误摘要 |
| `getVersions` / `versions` | GET | `projectId` | `planHash,revision,filmPlan,targetPlan,variants,mediaReady,difference` |
| `renderVariants` / `render` | POST | `projectId,expectedPlanHash,revision,idempotencyKey`；可选受管 `sourceRefs`、身份素材与预算 | 已排队任务 |
| `feedback` / `feedback` | POST | 冻结版本三字段、幂等键、`feedback`；可选 `variantId` | 修改任务及意见归因 |
| `cancel` / `cancel` | POST | `jobId` | 状态和是否改变；已派发供应商任务不自动重发 |
| `authorizeIdentity` / `authorize-identity` | POST | `assetId,selfConsent=true` | 当前本人素材授权记录 |
| `approveBudget` / `budget` | POST | `jobId,approve=true,expectedPlanHash,idempotencyKey` | 当前 G8 批次的后续任务 |
| `preferences` / `preferences` | GET | 无 | 本人明确偏好与来源 |
| `choose` / `choose` | POST | 冻结版本三字段、`variantId`；可选评分 1–5、盲选标签 A–J、意见 | 实际选择记录 id |
| `calibration` / `calibration` | GET | 无 | 当前工作区样本、评分、盲选计数 |

冻结版本三字段指 `projectId,expectedPlanHash,revision`，哈希为 64 位小写十六进制。所有公共对象拒绝额外字段。
`sourceRefs` 只接收 `shotId,assetId`，服务端验证项目、许可、媒体类型和文件哈希；调用方不能提供本机路径、关卡结论或干净音轨证明。

| 异常 | 外部错误 / 状态 | 恢复方式 |
|---|---|---|
| 无身份、无视频权限、权限被撤销 | `UNAUTHORIZED/FORBIDDEN` 或任务失败 | 重新取得当前工作区权限 |
| 非本工作区任务或素材 | `NOT_FOUND` | 核对项目和身份，不跨工作区回退 |
| 旧版本、相同幂等键不同请求、项目忙 | `CONFLICT` | 刷新当前版本；相同请求重用原任务 |
| 模型未配置、引用失效、许可或授权缺口 | `PRECONDITION_FAILED` 或带原因的失败任务 | 补足真实配置或素材，再显式继续 |
| 缺本人素材或制作预算 | `requires-generation-plan` | 补一次本人素材；按当前冻结批次授权预算 |
| 声音素材缺失、角色证据不可核实 | `partial/failed` | 补受管声音源；不把原片混合声当干净对话 |
| 无匹配且可用的授权音乐 | 该版本失败 / 包 `partial` | 增加有来源和许可记录的本地曲目；没有隐式自制配乐替代 |
| 主机中断、任务超时或客户停止 | `interrupted/failed`，保留回执 | 先核对已有媒体任务；不会盲重发付费请求 |

## 四版后期和局部修改

一次源镜头生成供多个版本复用，后期在本地完成。默认保留已完成源片的节目声；没有原音轨的镜头插入有出处的静音，不声称它是干净台词或独立拟音。显式选择配音或独立音轨时，才要求每个角色的签名源证据与来源绑定，缺口不能回退成假成功。
音乐只选登记且实际在盘的授权曲目。每版音轨按画面 EDL 重排，制作已明确请求的 impact/whoosh 后再混配乐，保留原速；字幕映射到成片时间线。
小红书封面画布与视频画幅分开处理，封面比例不改成片比例。

导演 V2 默认依据每个输入的实际显示尺寸确定视频画布，未批准降低像素时保留每个源的两个轴；明确指定小画布须通过下采样授权预检。技术处理执行实际色彩转换和保守清晰度，最终创作调色后再做当前帧实体支持。无本地实体工位或无检测支持时，回执记为跳过，不计作已应用。

交付前逐项检查封面、BGM、字幕、弹幕、转场、调色和分辨率。没有要求的文字层标明不适用；已要求的主成片、软字幕和烧录版全部进行当前文件 SHA、实际尺寸、帧率、时间轴、音轨与全解码核验。每道加工保存输入、输出和请求参数指纹，按画面 EDL → 调色 → 实体 → 节目合流 → 请求音效 → 配乐 → 最终封装核对实际消费关系。响度与真峰值默认作为报告，显式 block 模式才按声明目标阻断；它不触发付费源片重生成，也不认证人物外观或艺术质量。

文案、封面或字幕返修保留未涉及层的原字节。缓存与返修重放重新回读当前媒体；`postread.quality` 接受 `revisions/vN` 目录并只解析其所属原工程。相同幂等键也不能复用已被篡改的“通过”结果，失效的当前产物不会推进版本头。

意见例子及重算层：

| 意见 | 重算层 | 复用 |
|---|---|---|
| 音乐太热闹、旁白太响 | 声音与最终混合 | 画面剪辑、调色、源镜头 |
| 字幕大一点 | 字幕与烧录 | 干净画面、声音 |
| 封面换成克制风格 | 封面 | 成片视频与声音 |
| 开头再快一点 | 时间线及其字幕、声音映射 | 已有源镜头 |
| 新增场景、人物、台词或镜头 | 生成计划 | 现有包；新增媒体须独立预算 |

修改提交包含当前冻结哈希与版本。例如 `feedback.json`：

```json
{
  "projectId": "当前项目 id",
  "expectedPlanHash": "从 versions 复制的实际 64 位哈希",
  "revision": 2,
  "variantId": "douyin-impact",
  "feedback": "音乐安静一点，画面保持",
  "idempotencyKey": "audio-revision-20261002-0001"
}
```

```bash
node scripts/workloom-director.mjs feedback --input-file feedback.json
```

示例版本和 variantId 必须用当前返回值替换。修改使用项目租约、CAS、不可变快照和幂等日志。
并发请求只允许一个写入者；缓存会核验产物哈希，篡改产物不能作为成功缓存复用。

## 数据、授权与恢复边界

迁移 `0054_video_director_v2.sql` 新增六张表：创作委托、冻结计划、任务、明确偏好、独立声音来源和版本选择。
本人素材授权沿用受作用域约束的资产和事件账本，绑定实际素材字节、本人和工作区，不另造身份表。
表强制租户及工作区 RLS，保留项目归属、事件、请求哈希和不可变版本。
创作委托只免普通创意确认，不能替代本人授权、预算 G8、正式请求审查、发布批准或其它生产门。
预算审批与继续任务在一个事务中提交；幂等重放不再次追加审批事件。
进程持有 PostgreSQL 项目租约。死租约被回读发现后只标中断，不据此重新派发供应商任务。

版本选择与明确意见保存来源。盲选、评分样本不足时页面或 API 标明不足；不把偏好计数当作外貌质量提升。
当前人物外观字段为 `not-reviewed`，没有把技术解码、实体支持或合成媒体测试当作真人身份与美观证明。

## 客户端装配与本次验证边界

Electron 的 Mac/Windows 客户端共用 bootstrap。包内 Node、PostgreSQL、NATS 和物理内部包用于首启；
运行时导入、行业装配、前端构建产物、受管资源、媒体工具在启动数据库之前检查，失败给出阶段和诊断。
媒体运行时按平台与架构下载锁定文件，验证 SHA256，检查实际 FFmpeg/FFprobe 能力；不能执行其它平台缓存。
客户不需要系统 Node。Mac 原生首启已在中文空格路径和最小 PATH 实跑，Windows 原生安装本次未运行。

本仓的本地 FFmpeg 回归覆盖独立 EDL、字幕、声音、缓存、局部返工与当前文件负例；实际通过用例和执行日志以任务验收报告为准。技术质检与人物身份、作品差异、审美复核分别留存状态。
测试严格禁用图像和视频 API。完整 paid 生产链、真人审美对照、Windows 原生启动、DSH 原生 GUI、正式签名公证和独立 M6 不由这些测试推导为通过。

可在仓库根目录重跑本地合成集成回归。三个路径参数必须显式提供；媒体二进制应先由本仓媒体运行时安装器完成锁定文件与能力校验。
测试目录使用独立临时目录；脚本生成合成镜头、声音和带明确测试来源的音轨回执，不接供应商。

```bash
node scripts/test-director-local-media.mjs \
  --work-dir "$DIRECTOR_TEST_DIR" \
  --ffmpeg "$VERIFIED_FFMPEG" \
  --ffprobe "$VERIFIED_FFPROBE"
```

结果写入该目录的 `verification.json`。正常四版、音乐/封面/时间线修改、幂等重放、旧版本冲突、并发写入排斥、文件篡改与缺失授权音乐都必须通过。
缺失音乐应让对应版本失败并保留其它三版；测试不允许隐式生成替代配乐。

## 功能优先级与必要性

| 优先级 | 行为 | 不提供会怎样 |
|---|---|---|
| P0 | 一句话默认导演、明确数量/否定、四版独立 EDL、真实声音来源、资格/预算、首启预检 | 客户需要反复选择，拿到同片改皮；客户端可能装后即失败 |
| P1 | 意见归因、按层复用、项目租约/CAS、ROI 和时间序列证据 | 小修改重新生成付费镜头，重复请求造成重复作业，失败位置无法定位 |
| P2 | 明确偏好、盲选与评分来源、样本不足提示 | 只能凭印象调整配方，或者把偶然选择误当用户偏好 |

本流程不自动发布、不生成虚构经营事实、不把没有授权的真人变成本人、不把未测供应商计费/成片质量写成通过。
独立生产验收与真人盲测留给有额度和真实素材的后续验收，不能从文字方案与合成片外推。

代码入口：`library/director-system/core.mjs`、`recipes.json`、`post-bridge/director-delivery.mjs`、
`director-planner.ts`、服务 `director-{router,worker,jobs,store,sources}.ts`、`DirectorStudio.tsx`。
Agent 配置、实际协议验证边界见 [Codex / DSH 接入指南](AGENT-CLIENTS.md)。
