# Growthtest 视频调用指南：AI 工作台先读，再制作

> guideVersion: 2026-11-03.2
> 适用仓库：`geniusdapeng-collab/workloom-growthtest`（隔离副本）。
> 读者：Codex、DeepSeek Harness 桌面端及其它可调用本仓 CLI / stdio MCP 的 AI 工作台。

目标是把用户原话变成符合约束的作品：人、商品、平台、时长、账号调性、声音和特殊要求始终有依据。工作台负责组织调用与解释回执；剧本、提示词、渲染和后期使用本仓正式执行器。已交付作品的经验应进入本指南和生产机制，不能依赖某次对话记忆。

**成功渲染镜头默认直接进入正式后期。**供应商成功并取得当前项目、任务和原始字节的真实回执后，不再做身份、服装、动作、台词、口型、黑帧、原片精确规格或主观质量复审；不运行 canary、模型评审或人工验收，也不因此重渲、ASR 或 TTS。普通路径保留供应商原声，原片无声则由媒体处理补静音轨。缺文件、损坏容器、任务或字节绑定不实、实际处理失败和请求导出未完成仍明确报错。结果写 `qualityReviewPerformed=false`、`score=null`，不能表述为“品质审核通过”。渲染前的需求、授权、资格、预算和供应商真实失败继续生效。

## 1. 每次接手视频任务，先读本指南全文

第一次使用先按 [GitHub 克隆、安装和服务接入](AGENT-CLIENTS.md) 设置工作区。已经配置过的项目也要核对本次检出、服务地址与成员身份。只读发现无需服务。在当前仓库根执行：

```bash
node scripts/workloom-agent.mjs list
node scripts/workloom-agent.mjs invoke growth.repo.readiness
node scripts/workloom-agent.mjs describe growth.video.workbench.guide
node scripts/workloom-agent.mjs invoke growth.video.workbench.guide
```

最后一条的 `result.markdown` 是完整正文，另有 `repository/productId/guideVersion/path/sha256/bytes/limitations`。读取固定本仓文档，不需要模型、供应商密钥或服务端，不创建任务、不渲染、不收费。通用 MCP 客户端先 `tools/list`，再调用 `workloom_growth_video_workbench_guide`，参数 `{}`。

Growthtest 实际 Codex 插件还有自己的网关，入口与通用能力适配器不同：

```bash
node tools/codex-gateway/bin/cli.mjs video guide
node tools/codex-gateway/bin/cli.mjs video guide --json
```

插件 MCP 调用 `workloom_video_guide({})`，或读取资源 `workloom://guides/video`。握手 `instructions`、SessionStart `context` 和仓内技能均指向本指南。插件网关的目录/模拟工作台仍只读；增加指南不会让它具备启动、批准或发布视频的权限。

客户端能运行本机终端就可直接走 CLI。希望通过工具菜单读状态时，按 [Codex / DSH 的 stdio MCP 配置](AGENT-CLIENTS.md#3-codex-接入) 接入。两种方式使用同一仓库和指南。源服务的端口从实际启动配置取得，成员令牌只由运行环境提供；运行服务的供应商凭据不传给只读客户端。

读取失败先保留错误，停止依赖该指南的生产动作；不借用 Growth/Matrix 的路径、静态参数或另一份指南。核对返回的 `repository`，三个同源仓是不同产品实例。源码会话先按根 `AGENTS.md` 读取 `AGENTS.repo.md`；Codex 并不自动读取任意名称的 Markdown。相关说明：[Agent 能力协议](../scripts/AGENT-CAPABILITIES.md)、[插件接入](../plugins/workloom-workbench/README.md)。

## 2. 先保留原话，冻结作业约束

**按每条短片重新规划，不把成功样片变成固定模板。**总时长遵循用户明确要求；用户未指定时，由视频管线结合目标平台、内容和预算提出方案，并标明这是系统规划。镜头数、逐镜时长和镜头编排由正式视频管线按叙事、商品展示、台词、节奏、可用素材及当前生成能力自主拆分；只有用户明确指定的项才作为作业固定项。工作台不得沿用上次的「6 镜」「每镜 5 秒」或镜头顺序替管线做决定。版本数按本次需求和所选正式交付入口核对。

在当前作业资料中保留用户原话 `rawIntent`，记录下表的来源和验收条件。已有明确答案直接采用；可自行查到的资料自己取；只在无法取得必需信息或要求有硬冲突时补问。禁止把模型推断记成用户要求。

| 约束 | 制作前必须有的事实 | 缺失或冲突的处理 |
|---|---|---|
| 指定模特/真人 | 角色 ID、当前定妆照版本或适用的平台素材 ID、人物属性、授权范围与有效期、哪些镜头出镜 | 有指定角色时按档案绑定。缺授权或供应商不接收所需素材类型时停在付费前 |
| 指定商品 | 商品档案、真实图片、名称/参数/价格/卖点的来源和禁止改写项 | 营销片缺商品锚点停止，不编造品牌、规格或优惠 |
| 平台与画幅 | 目标平台、比例、分辨率、字幕呈现、封面画布 | 用户明确项优先，不把默认抖音或封面比例套给其它平台 |
| 时长 | 总秒数、误差边界、各镜时长之和、帧率 | 不以文件名证明时长，不用变速/补静音凑长度；当前普通生成每镜整数 4–12 秒 |
| 账号调性 | 已批准账号资料、受众、语气、开场、视觉和 CTA | 不能用通用爆款话术覆盖指定调性 |
| 原声/台词 | 对白原文、声音来源、是否保留完整原声、允许的 BGM | 普通原声生产图声同源；画外音也来自原渲染文件，禁止另配音、改词或换声线兜底 |
| 特殊要求 | 必须/禁止出现的内容、顺序、商品露出、参考用途、版本数和验收条件 | 执行器不支持则报告具体缺口，不悄悄删要求或改流程 |
| 生成范围/恢复 | 已有项目、原稿、任务 ID、原片和回执；本次允许新增什么 | 先复用和查状态，成功素材默认采用；旧品质失败行与组件升级不触发再次付费 |

这张表是工作台的作业纪律，不代表系统已自动识别并硬验证所有自然语言要求。新渲染前仍核对授权、资格和固定要求；成功后的默认采用不是人物认证或对旧品质结论的改写。

## 3. 选择正式入口，分清方案、前期和渲染

用户说「用 GrowthTest 做一条视频」时，先用 [正式视频入口](video-native-agent-entry.md) 把原话交给 Studio，再用同一作业续跑。只有明确要求文字方案、预览或已有镜头稿制作时，才选择下面相应的专项入口。

```mermaid
flowchart LR
  A[用户原话和素材] --> B[固定约束与能力预检]
  B --> C[系统分流和正式前期]
  C --> D[检查镜头和提示词资格]
  D --> E[渲染与原片回执]
  E --> F[官方后期]
  F --> G[核验与本地交付]
```

1. **能力与环境。**读取 `growth.repo.readiness`，回读实际服务的 `/health` 和有权限的 `growth.video.gen.catalog`，再运行 `pnpm video:doctor`。本地只读、服务探活、运行时模型可用、账户权限/余额和本次付费资格分别记录。按本次需要核对可用的图生图、文生图或参考图/视频生成模式，以及实际后期二进制、字体和授权音乐。已有可用原片的标准后期不需要生成供应商。
2. **分流。**视频工位的 `video.studio.start` 进入系统营销/叙事/解释片分流。专业 CLI 使用 `route-video.mts` 保存分流记录；营销片必须有商品锚点。`clarify` 或类型不符时停，解释片走其专用入口，不硬塞进逐镜片管线。
3. **文字导演方案。**用户只要求方案时使用 `scripts/workloom-director.mjs plan`；它会调用真实文字模型，强制 `mode=plan`，不提交图像/视频。`growth.video.director.preview` 是免费的确定性预览，不能当作真实文字方案。`plan` 返回导演方案，不等于已具备正式完整渲染提示词或完成媒体。
4. **正式提示词与资格。**专业 Studio 前期通过 `startVideoProjectRun`、`VideoStudio.runPreproduction` 和实际制作引擎生成并归档前期素材。读取 `growth.video.production.shots` 和项目实际前期记录，对照冻结约束逐镜核验。归档草案镜头卡、纯文字导演方案、`ready:true` 本地计划都不能冒充正式渲染放行包。缺正式前期或资格时停止，不写临时镜头卡绕过系统；用户明确提供的镜头稿仍须走正式规范检查。
   完整视频默认在定妆照和媒体生成前执行提示词 preflight；营销片先做逐镜事实预检，再执行最终 G6。拒绝会转换成结构化 finding，系统只修复受影响镜头并在默认两轮内复验。修复阶段不提交图片、视频、发布或外呼，也不改变原有 25 字段、片头 5 字段和 3000 字符合同。`PROMPT_PREFLIGHT_REQUIRED`、`PROMPT_FACT_PREFLIGHT`、`PROMPT_REPAIR_ENABLED` 分别提供回滚开关；详见 [有界局部修复](prompt-repair-controlled-loop.md)。
5. **计划后执行。**`growth.video.production.plan` 只读已有镜头卡、分流、fps、原声合同和本地配置，返回 `checklist` 与 `execution.command/args/cwd`。`readyScope=authored-input-and-local-configuration`。逐项核对后以实际参数数组启动官方 `full-chain-film.mts`，将用户文本作为数据传入。失败时 `argv=[]`、`execution=null`，回到出错工位。服务项目逐镜提交使用同一服务的 `video.production.qualifyShot` 与渲染 API；[服务项目 CLI](../scripts/tools/render-project.mts) 可按真实项目 ID、模型 ID、批准范围和估算上限调用。
6. **付费渲染。**正常生成先冻结原稿，逐镜核对 ID、请求参数、原生音轨选择及授权，保留实际供应商任务、下载与签发事实。保持已有项目/输入/目录，优先接续已受理任务；不清缓存、不自动重发付费 POST。真人档案在提交前核对；成功后不再跑 canary 或身份比对。普通导演保留原片音轨，只有用户明确授权 `audioMode=dubbing` 才进入真实配音处理。
7. **官方后期与交付。**成功原片默认直接进入 compose/color/subtitle/BGM/cover/mux/master 单母版链，或用下一节完整原片标准后期；显式请求多风格时再加入 deliver。执行单次声明的调色和混音配方，实际编解码、字幕、封面、导出和摘要失败留痕；不做品质打分、候选择优、自动降音量重试或无声替代配乐。核对实际请求版本与文件清单后交付；平台外发另需授权与真实回执。

默认导演四作品允许不同 EDL 的创作路径与完整原片原声五呈现版是两个交付合同。用户明确“全部原镜、原顺序、完整原声、只改后期”时，采用完整原片标准后期；不能用导演默认的独立重剪覆盖该要求。系统前期确实不能承载某固定项时，报告缺口，不能让工作台自行另造流程。

普通全链原声阶段不使用后配音或 ASR 替换声音；拒绝 `--narration-unified`、关闭原生音频及 `normalizeToSeconds` 变速。事实性技术闸仍生效。一般审美由客户验收，不能为了风格模板偷偷删除镜头。

一句话导演的真实调用示例，先把下面内容保存为 `intent.json`；已知人物、商品和账号要求应写进 `intent` 并在作业约束资料中保留来源，不能给严格 API 添加自造字段：

```json
{
  "intent": "拍一条三十秒的雨后山间民宿电影，只拍空景，只交付抖音一版，不编价格优惠",
  "idempotencyKey": "hotel-text-plan-unique-request",
  "deliveryOptions": {"platforms": ["douyin"], "versionCount": 1, "includeSurprise": false}
}
```

```bash
node scripts/workloom-director.mjs plan --input-file intent.json
node scripts/workloom-director.mjs job --input-file job.json
node scripts/workloom-director.mjs versions --input-file project.json
```

`job.json` 使用实际返回的 `{"jobId":"实际任务ID"}`，`project.json` 使用 `{"projectId":"实际项目ID"}`。`queued/running` 时继续查同一任务；`job` 读取 `filmPlan`、`planHash`、`planRevision`、`textCalls` 和 `mediaReady`，`versions` 读取当前 `filmPlan`、`planHash` 和 `revision`。不要假设两个响应字段完全相同或都有顶层内部调用回执。文字方案包含场景、动作、摄影、声音及叙事方案，尚没有完整生产 `prompt`；计划完成仍可为 `mediaReady=false`。四个逻辑岗位会重试和修复，不能承诺固定四次模型调用；总时长和镜头数按实际产物核对，不能把“30 秒六镜”当成 planner 的硬保证。

需要按导演合同继续同一项目时，在已授权的身份和制作预算内调用 `node scripts/workloom-director.mjs render --input-file render.json`。输入必须来自当前返回值：`projectId`、64 位 `expectedPlanHash`、正整数 `revision`，再加本次新的 `idempotencyKey` 和已授权的 `maxBudgetCny`；实际要求的身份素材/来源也须满足。再次 `start` 会新建项目，不能用于续接。`render` 可能触发真实媒体和预算流程，不能为了读指南或检查接通而调用。

将 `render` 返回的真实任务 ID 写入新的 `job.json`，继续用 `job` 轮询、用 `versions` 查看当前版本。遇到预算或身份阶段，按任务回执和 [导演授权流程](director-studio-v2.md#固定-api-契约) 在原工作区完成，不新增第二个项目。回执中的可播放地址如有有效期，交付前从同一版本刷新并实际打开。

通用 MCP 当前登记的是导演 `preview/job/versions/preferences/calibration` 读取能力，尚无导演 `plan/start/render` 执行工具；这些写动作使用现有服务 CLI/API，不发明 MCP 工具名。免费 `preview` 的选项字段是 `options`，真实 `plan/start` 是 `deliveryOptions`；CLI 只接受 `--input-file`，没有 `--intent/--mode/--plan-only` 等参数。专业 Studio 路径另走其正式前期与 `production.shots/qualifyShot` 来源资格，不能把导演方案转换成工作台手写卡冒充它的产物。

## 4. 已有原片：完整原片标准后期

先核对同项目规范 `original-render-manifest.json`、生成前冻结原稿、逐镜首次签发事实、全部来源与当前字节。普通 CLI 自动按真实已受理任务、原始文件摘要和当前冻结输入采用历史成功素材；旧身份或画质失败行保持原字节，另记 `render-adopted`，不能把旧行改成绿灯。缺失、篡改或无法绑定任务的原片明确失败，不自动重新付费。标准入口只消费其唯一完整时间线，不接收调用方的自由剪辑计划。

```bash
pnpm exec tsx scripts/tools/full-chain-film.mts \
  --standard-post /absolute/production/logs/PROJECT/original-render-manifest.json \
  --post-settings /absolute/post-settings.json \
  --out /absolute/new-delivery
```

只接受这三对参数各一次；不能混入生成、工位、变速、裁镜或替声参数。新目录独占，出错保留失败证据，成功后原子发布。本入口无供应商/模型/TTS/ASR 请求。

设置只允许已有音乐、句级字幕、字体、来源镜封面和明确的版本调色/BGM参数。完整 schema、范围、样例规则和错误码见 [标准后期说明](video-standard-post.md)。全部原镜按提交顺序采用，原片字节保持不变；媒体处理按已提交输出时钟与画布归一化实际原片，允许原片帧率、画幅、时长与请求有差异或没有音轨。封面占第一帧，普通音轨来自原片；没有调用方自由删换重排、变速或替声字段。

交付为主版、软字幕版和 `warm-film/cool-tech/punchy-social` 三个风格版，另有四封面和 SRT/ASS/VTT。三个风格的实际调色档、实际消费音乐字节和封面必须不同；换音乐 ID/文件名或只改音量不算不同。全关音乐必须按现有规则明确全关。母版和软字幕版是便利呈现，不能拿来凑三种风格。

## 5. 调用、恢复与失败

专业 CLI 先保存实际作业的分流结果。示例只做本地分流，不生成素材。把目录和文案换成当前作业值，源 brief 如已存在可通过 `--brief` 读取。

```bash
mkdir -p work/film
pnpm exec tsx scripts/tools/route-video.mts \
  --title "雨后山间民宿，只拍空景" --explicit narrative --platform 抖音 --out work/film/route.json
```

上例的 `--explicit narrative` 用于已明确选定叙事片的作业。未明确片型时省略，按真实 `decision.route` 继续。营销片需由正式前期绑定真实商品档案。说明图仅可用在已授权的参考或生成用途。先 `describe` 核对当前 schema。专业计划示例只承载支持字段，`shotlistPath` 使用当前正式前期产物，完整作业合同另存生产资料。

```json
{
  "title": "已冻结的用户原话摘要",
  "projectId": "VID-CUSTOMER-01",
  "platform": "抖音",
  "shotlistPath": "work/film/shotlist.json",
  "routePath": "work/film/route.json",
  "workDir": "work/production",
  "outDir": "work/out-VID-CUSTOMER-01",
  "unifiedNarration": false
}
```

```bash
node scripts/workloom-agent.mjs invoke growth.video.production.plan --input-file work/plan-input.json
node scripts/workloom-agent.mjs invoke growth.video.production.status --input-file work/status-input.json
node scripts/workloom-agent.mjs invoke growth.video.delivery.inspect --input-file work/delivery-input.json
node scripts/workloom-agent.mjs invoke growth.video.post.quality --input-file work/delivery-input.json
```

状态输入示例为 `{"projectId":"VID-CUSTOMER-01","workDir":"work/production"}`。清单和技术核验输入可用 `{"projectId":"VID-CUSTOMER-01","outDir":"work/out-VID-CUSTOMER-01"}`。使用实际项目和目录。仓外产物由运行者设置 `WORKLOOM_VIDEO_ARTIFACT_ROOT`，请求仍只接相对路径；文档指南读取始终固定代码根。

| 失败/状态 | 必须做什么 | 禁止的补救 |
|---|---|---|
| 无身份/权限，非本工作区项目 | 获取正确身份/项目，再读真实结果 | 借另一工作区或直接写 DB |
| 前期缺项、时长/人物/商品冲突 | 保留失败项，回到正式前期解决 | 手写可跑卡或删除固定要求 |
| 欠费/配额错误、账户权限 | 解决真实账户状态后续取原任务 | 重复点生成或换另一账户规避 |
| 本地参考图类型不支持或平台拒绝人像 | 按正式档案核对原图字节和用途；对平台隐私拒绝走该供应商的已授权人像入口 | 改扩展名、重编码、换链接来规避素材限制 |
| 已有 taskId，轮询/下载失败 | 查同一任务、保留原输入和接受记录，按恢复入口接续 | 把 GET 失败当成需要再付费 POST |
| 标准后期忙、目录已存在 | 查询正在运行的任务，换明确的新输出目录 | 强删锁、覆盖旧成片 |
| 原稿/原片/代码/字体哈希变更 | 原目录保留失败回执，查出实际变更 | 改哈希或把不存在的旧素材当成功恢复 |
| 成片不合意 | 按反馈归因到字幕/封面/音乐等层复用原片；新镜须新增范围与预算 | 未授权变速、替声、改剧情、重渲 |

`integrity=sha256-verified` 仅证明列出文件的实际字节与清单一致；`unverified/incomplete` 保持原结论。哈希、声学相关性、`ready` 和 `mediaReady` 分别有自己的范围，不证明真人身份、台词准确、口型、主观听感或音乐商业许可。

使用 `full-chain-film.mts` 的作业，保留原项目、输入和工作目录，以现有任务日志恢复。已核实的外部已受理任务可以通过 `--resume-tasks <文件>` 提供镜头 ID 到供应商 task ID 的 JSON 对象。只有任务 ID、请求输入、已签发事实和原片字节可以相互核对时，才记录可正式采用。请求结果未知时先查供应商，勿将未收到响应判成未受理。

- 已成功但旧品质失败的原片保留原记录，真实来源/当前字节通过后直接正式后期；新生成只限缺失或用户明确授权改变的点名镜。
- 镜头级清晰度/去雾在共享归一化层执行：默认 `--clarity auto`，只有黑位与细节共同支持“发灰/发糊”时才进入 `light/medium/strong`；2026-10-18 起强档半径收到 7×7、CAS 0.25，变体最终 look 不再叠加旧的固定 `conservative` 锐化。逐镜计划写入交付清单，显式 `--clarity off|light|medium|strong` 可覆盖自动判定。
- 同时请求字幕与弹幕时，两者合并进同一份 ASS、只编码一次，输出 `*.burned.danmaku.mp4`；字幕与弹幕 proof 绑定同一输出 SHA。1080P 文字层使用 `libx264 medium/CRF16`，UHD 使用 `medium/CRF14`。
- `edit:fastlane` 默认只执行各变体自己的调色；`--segment-color` 改为显式请求，避免“共享分段 LUT + 变体 look”两层创作调色叠加。
- 原节目音频默认保留，静音/黑帧/低分辨率/不同帧率源片不被品质阈值拒绝；工具实际解码、拼接、混音或导出失败必须返回错误。
- 显式提供音轨/分轨必须真实四角色、来源和签章授权齐备；null/false/空或非法结构不能静默当成省略。返修同理。
- 字幕默认完整文本与条目，弹幕没有默认 20 字/8 并发抽稀；有效限制只在用户明确请求时生效并如实报告。
- Color 的 best/match 和封面按明确方案一次本地执行；调色批次完整回传每项，有失败时 CLI 非零退出。没有默认残差、像素差、身份或整图模型品质裁决。
- 后期包与 HTTP 技术凭据只核对真实加工、来源/权限、版本和请求导出。历史签章保持可验证兼容，不要求重新补画面/声音质量证据。

## 6. 典型作业与交付回执

| 用户场景 | 正确步骤 | 不遵循会发生什么 |
|---|---|---|
| 指定 CEO、商品、抖音、30 秒和账号语气 | 冻结完整约束→正式营销前期→逐镜核对人物/商品/台词/秒数→原声生成→完整后期→清单核验 | 错人、漏商品、声线变化或付费后才发现时长不符 |
| 使用随仓注册的内置角色展示一件真实商品 | 按当前角色库选中指定角色和在用定妆照，记录角度、字节摘要、使用权与引用用途；独立核对商品事实、图片权利及供应商模式 | 参考图已存在也可能不适用于本次供应商或商用场景 |
| 已有全部成功原片，只做五版本 | 读原片任务与实际字节→默认采用→标准后期→核对声明配方、消费音乐和真实导出清单 | 旧品质门引起重复付费，或文件清单与实际结果不符 |
| 中断后继续，用户仅要求字幕更大 | 先查已受理任务与产物→复用画面/音轨→正式局部后期→新目录/新清单 | 重复花钱，旧绿回执误绑定本次改动或原片被覆盖 |

交付回复按实际完成的层级报告。

| 状态 | 最少要给用户的证据 |
|---|---|
| 已接入或已有方案 | 仓库提交、实际服务目标、项目/任务 ID；如已生成文字方案，附冻结版本、`planHash`、`mediaReady` 和可继续的缺口 |
| 已提交或已取得原片 | 实际受理与成功镜头数、任务 ID、来源或输入摘要、下载/签发与当前原片字节的绑定，另列复用次数和仍在运行的任务 |
| 成片已交付 | 可播放作品、封面、字幕和当前清单位置；实际时长/画幅和请求版本；最新 `delivery.inspect`、`post.quality` 及播放检查 |
| 受阻 | 实际阶段、缺失或错误项、供应商是否已受理、保留的回执及续跑入口；没有可播放文件时明确写明 |

同时注明哪些用户固定项有证据、实际耗时、失败与恢复，以及身份、口型、审美或素材许可等独立结论。按 [角色库](character-registry.md) 和 [认证真人档案](real-person-asset.md) 区分在册定妆照与平台授权人像。识别 PNG、JPEG、WebP 的本地参考图时读取实际文件签名，保留原字节。上传许可、供应商对人像的准入与授权素材引用需另行核对。

## 7. 正常耗时与提速

下面的「30 秒、6 镜、五呈现版」仅是本次历史样本的计时条件，不是生产默认参数或通用交付数量，也不参与拆镜决策。新作业按管线实际镜头数、逐镜时长、生成类型和所需版本重新估时；17–30 分钟及 25 分钟不作为全局超时或验收闸。

以 30 秒、6 镜、1080p/24fps、五呈现版为例，素材和授权齐备、环境已启动、单轮通过、无欠费/人等待/返修时，正常全程可先按 **17–30 分钟**规划，排期预留约 **25 分钟**。这是 D 级估算，不是本仓正常全链实测或 SLA。

| 阶段 | 排期估算（D） |
|---|---:|
| 需求/资料、正式前期与提示词 | 2–5 分钟 |
| 六镜逐镜供应商生成 | 8–10 分钟 |
| 取片和任务/字节绑定 | 0.5–2 分钟 |
| 完整五版标准后期 | 5–8 分钟 |
| 导出回读、清单和打包 | 1–3 分钟 |

参考本批历史实际供应商成功回执（B），单任务 66–82 秒，六任务累计 435 秒；只有两任务重叠，活动区间并集 391 秒，不能拿含数小时任务间空档的跨度当正常速度。最终原片原声后期 31 步累计 285.697 秒（4 分 45.697 秒，B）；缺独立后期开始/完成墙钟，不能当端到端交付时间。正常需求分析和纯下载没有独立计时。已有原片只做完整后期与交付可先估 **6–12 分钟（D）**。

按项目分别记录指令/素材冻结、正式提示词就绪、实际渲染受理/成功、下载开始/完成、后期开始/完成、核验交付时间。总耗时用墙钟差；阶段 `ms` 累计另列；人等待、欠费、调试、缓存/返修样本单列，缺时点写“未测”。

当前默认采用机制移除了成功后的二次品质复审与补生成；尚未测得这次机制改变后的正常全链墙钟，不能宣传提速幅度。后续再测有界并发和本地编码瓶颈，不设置首镜 canary。原稿、授权、实际字节和导出回执继续核对，历史耗时保持原证据和原计时条件。

## 8. 维护、优先级和边界

| 优先级 | 本指南要求的具体行为 | 缺少会怎样 |
|---|---|---|
| P0 | CLI/MCP/插件/会话先读同一正文；核对本仓身份 | 工作台用错仓库能力或不知道官方入口 |
| P0 | 冻结用户固定项，区分草案/前期/渲染/交付 | 擅自改人物、剧情、声音或拿计划冒充完成 |
| P0 | 失败停止依赖动作，先续取真实任务 | 重复付费或用手工流程掩盖失败 |
| P1 | 桌面载荷保留固定指南；核对实际字节 | 源码可读但安装后指南丢失 |
| P1 | 完整时间点与按层复用反馈 | 无法判断正常速度，字幕小改重做整片 |
| P2 | 后续测量并发与编码优化 | 只能用估算排期；本次不改队列或生产并发 |

本次指南与只读发现入口没有新增生产服务、数据库表、写工具或模型调用；不新增媒体、不自动发布、不把 Growthtest 机制移植或回流其它仓。具体生产保护以本仓实际实现为准，指南不能约束一个故意绕过系统的任意外部程序。

更改生产入口时，同步本文件、能力 schema/plan 索引、插件提示及固定载荷测试。回归从原测试入口执行，覆盖同文读取、目录发现、异 cwd、路径/缺件/版本/产品不符失败及载荷 SHA-256：

```bash
node --test scripts/agent-capabilities.test.mjs scripts/video-capabilities.test.mjs scripts/product-runtime-assets.test.mjs
node --test tools/codex-gateway/test/*.test.mjs
node scripts/workloom-agent.mjs invoke growth.video.workbench.guide
node tools/codex-gateway/bin/cli.mjs video guide --json
pnpm capabilities
pnpm capabilities:check
git diff --check
```

官方客户端依据：[Codex AGENTS.md 发现规则](https://learn.chatgpt.com/docs/agent-configuration/agents-md)。stdio 客户端通过实际握手和工具读取验证；本地协议回归不等于 Codex/DSH 原生 GUI、付费生成或真人质量验收。

## AI 生成普通全链的默认单母版（2026-10-18）

普通 `full-chain-film.mts` 默认只交付一支母版：保留渲染素材的创作色彩，`color` 阶段记为 `preserve`；字幕默认烧录，封面默认烧进片头，BGM 默认混入。弹幕只有显式提供条目或传 `--auto-danmaku` 时执行。`deliver` 不进入缺省阶段，因此不会隐式生成调色变体或多版本。

需要多风格版本时，调用方必须在 `--stages` 中显式加入 `deliver`：

| 顺序 / ID | 实际处理 | 用途 |
|---|---|---|
| 1 / `original` | 从未做创作调色的共同源直接复制，调色次数为 0；后续按请求封装声音和字幕 | 保留渲染时已经形成的颜色 |
| 2 / `warm-story` | `warm-film`，`intensity=0.3`，关闭自动调整，不叠第二层暖 LUT | 收敛后的轻暖调 |
| 3 / `content-auto` | 依据分镜声明的题材、光线、人物等属性及镜头时长选择一个克制的全片配方 | 给出可以复核依据的内容调色版本 |

这三个显式变体分别从同一份未调色、未混配乐的共同源派生；不从暖调母版继续叠加滤镜。`content-auto` 在商品颜色准确性、夜景、人像、美食、风光、运动及混合题材之间选择，并在 `colorDecision` 留下属性、时长权重、原因和局限；缺属性时保守处理并明确未判定。它没有像素分析、实体分割或艺术评分，也不保证每个镜头的观感都是最优。

显式母版调色需同时设置 `--color-mode grade` 与 `--color-profile` / `--color-intensity`；保留原有显式 `best` 请求。母版的选择不会改变三个变体的共同源。默认不沿用旧的已调色缓存；策略、参数和源摘要均参与恢复核验。显式 `--variants` 仍支持旧 ID `cool-tech,warm-film,punchy-social`，未知或重复 ID 明确失败。

交付清单记录 `colorPolicy`、共同源 SHA-256、每个版本的 profile / LUT / intensity 和自动方案依据；技术验收追踪实际加工链，原色版须为 0 次调色，其它两版各 1 次，且输入绑定共同源。渲染片段及旧账本保持只读。

素材剪辑 `edit-post.mts` / package 的既有首推 `warm-story` 仍采用同一套 D 配方。Growthtest 中显式 `--standard-post` 的版本清单与一句话导演的独立作品合同继续服从各自已提交设置；本节描述普通生成全链，多版本只按显式请求执行，不把不同入口的交付数量混为一谈。

## 所有 AI 工作台共用的交付技术检查（2026-10-14）

当前正式 package/reedit 与本仓已接通的生成后期出口，在实际加工后检查当前媒体与真实加工链。七环节为 cover / bgm / subtitles / danmaku / transitions / color / resolution；明确未请求的环节记录 not_applicable 和具体理由。硬切也是剪辑选择。默认按源片实测显示宽高保持原生画布，旋转先解释；明确降采样或换画幅须有对应策略。

后期质检员 `post-quality-inspector` 使用 `postread.quality`（`delivery_dir` 为当前后期包）；也可使用 `node bundles/ai-video/connectors/post-bridge/cli.mjs quality --delivery-dir <目录>`。外部工作台统一调用 `growth.video.post.quality`：输入 `projectId`、产物根内相对 `outDir`、`kind=auto|post|generation`；CLI `node scripts/workloom-agent.mjs invoke growth.video.post.quality --input-file quality-input.json`，MCP 工具为 `workloom_growth_video_post_quality`。对生成 HD 的 `outDir` 或 UHD 的 `outDir/uhd` 自动读取不可变 release 的 `current.json`；返回 `complete=true` 只表示本次当前文件技术验收，`artisticQuality=unverified`。

`growth.video.delivery.inspect` 保留字节清单检查，不能单独证明完整后期。实际解码、原生画布、请求层或凭证失败须本地返修；删除文件、改字节、传 skip_verify 或旧 passed 均不能代替检查。音频默认 report 记录实际响度/真峰值，明确 block 合同按其目标阻断。主机本地加工凭证不是防任意文件系统写权限攻击的加密签章。

快剪先声明实际源区间、保护台词/动作和快段、hold/breath，再按 1x 截取；不加速口播凑节奏。impact/whoosh 按声明做本地声音加工，BPM 标签不等于实测节拍。新生成的电影摄影契约先冻结目的、景别、空间层次、光线、动作、动机机位、艺术与声音连续性；已成功素材不因新字段重复付费。详见 [节奏与电影摄影](video-rhythm-cinematic.md)、[实体调色](ai-video-entity-color.md)、[后期质检技能](../bundles/ai-video/skills/post-quality-inspection/SKILL.md)。
