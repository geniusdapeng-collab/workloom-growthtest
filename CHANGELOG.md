# Changelog

## [runtime-client-repair] - 2026-10-02 · 权限、审批、影片工位与客户首启整改（T-2026-1002-0901）

- 外部写动作先检查角色、PII、围栏和绑定到实际参数的审批，再记录开始凭据并调用工具；同线程跨进程互斥，审批仅消费一次。开始后缺少最终回执的写动作停在未核实状态，普通重放不会重复发送。
- 编辑后采纳执行人实际批准的参数；缺参、相关性不足和人工审批均不能越过 block 红线。计划标记随计划持久化，取消和完成的线程不会被普通运行复活；待办队列不占运行槽位，驳回记忆按租户和工作区隔离。
- 生产匿名入口停止签发经营成员身份；客户端经隔离 preload IPC 使用本机安装凭据登录预配工作区。JWT 强制签名算法、签发方、有效期和生产密钥长度。
- 影片工位接通实际子进程与父进程组件调用，核对阶段记录、来源、选项和产物 SHA-256；超时和缺产物失败关闭。定妆照增加具名人类驳回入口，后续机器意见不覆盖人类决定。
- 修复客户载荷的环境路径、精确依赖锁、工作区模块单例和影片辅助文件闭包；首日引导后的渲染冒烟实际验证遮罩退出。织伴在窄内容区和自动公告后正确恢复收起状态；C 端投影按当前行业包和 UI 版本生成。
- 影片能力返回结构化 argv 与转义命令，交付检查核对必需文件的摘要；清理 Live2D 间接工具链公告。CNB 发布器兼容平台实际返回的完整 main/tag 引用，继续严格绑定目标提交。
- 本机回归：全场景 482/482、GEO 81/81、九条隔离真库安全断言、生产 HTTP 认证 11 条、影片公开接口成功/缺产物/硬截止、三端构建和标准套件通过。Mac arm64 新安装包完成空白客户目录首启和重启；正式签名、公证和 Windows 原生执行分别记录实证，不以本地 QA 包代替正式发行。

实施与回滚说明见 [整改记录](docs/repairs/T-2026-1002-0901.md)。

## [video-governance] - 2026-10-01 · 决策权归人类：定妆照 G5 人审 + AI 打回不再自动重跑（T-2026-1001-0007）

> 真机事故：AI 监制认为"不合适"就自动重跑（含重新出图），把客户额度烧在反复重做上；
> 定妆照"像不像"这类机器判据本身不稳定（同一批文件实测 92 / 15 / 86），不该成为放行与否决依据。
> 本版把决策权收回人类：机器只负责把问题提前暴露，重做与否由人决定。

- **服务端预生产**：`AUTO_GATES` 默认移除 `G5_PORTRAIT`——定妆照默认**人审**；人审分支先做事实核验
  （实际出图/必需角度/文件可读），通过后把**逐张定妆照清单**（路径 + sha256）写进审批内容供人类核对；
  事实不成立直接 fail-closed，不占用人类时间。
- **不再自动重跑**：`VM_PRODUCER_RETRY` 默认从 1 改为 **0**（AI 打回即停并如实上报）；显式设为 1 或更大
  才恢复旧的有上限自动重跑口径。
- **花钱动作人审**：渲染提交 `WORKLOOM_RENDER_AUTO` 默认从 1 改为 **0**（脚本须先 `cms.approveScript` 审批），
  白板片渲染同口径；显式 `WORKLOOM_RENDER_AUTO=1` 才恢复旧自动放行。
- **CLI 定妆照**：`portrait-set-from-asset.mts` 删除"机器像不像不过 → 自动回退视频路重做一次"的路径；
  机器判据默认只留证，`--require-likeness` 才整批拒绝（旧行为 opt-in）。`portrait-agent review` 改为
  **advisory**（不再写"打回"、不再 exit 4、不再阻断 G5）；`full-chain-film.mts` 的 G5 只认人类验收记录
  （`via=owner-acceptance`），旧版被机器判据带成 `approved=false` 的记录按留证处理、不再误阻断。
- **口径层同步**：`bundles/ai-video/README.md` §3/§6.1/§6.2、`docs/real-person-portrait-set.md`、
  `docs/capability-map.md`、`docs/producer-gate-design.md`、`docs/video-pipeline-routing-and-dossier-2026-09-25.md`、
  `bundles/ai-video/presets/{portrait-artist,producer}.yml`、`bundles/ai-video/skills/{portrait-studio,producer-gate-review}/SKILL.md`。
- **断言兜底**：新增 `portrait-decision`（人类验收是唯一决策来源）与 `likeness-policy`（默认不阻断、不重做）
  纯函数与单测；`gate-policy` 断言 G5 默认人审与渲染默认人审；`studio-worker` 断言默认打回即停；
  `production-router` 断言未设开关时 `render_auto=false`。

## [client-delivery] - 2026-09-28 · 右侧「织伴」对话框交付链路修复（T-2026-0928-0001）

> 客户报障「右侧 AI 对话框安排任何任务都无法交付」。沙箱真机复现 + 逐行审计后按三轮问题清单
> （GR-01..GR-14 / N-01..N-12 / N-13..N-16）成批修复，并在**干净生产态库**（54 迁移 + 全种子）
> 用平台自有模型驱动三类型任务跑通。核心改动：

- **前端展示闸门**：模型自然语言不再走系统字符串白名单（此前回答里出现 `<facts>` 一类标签即整段
  显示"应答内容暂时无法显示"）；新增 `apps/web/src/lib/clientText.ts`：剥标签、局部替换机器标识、
  纯 JSON/内部错误才兜底；任务卡显示连接器提示与失败原因，审批卡显示参数不完整警示，最终结果显示
  「真实连接器回执 / 模拟执行」标识，卡片轮询按状态降频；
- **岗位与计划**：派活按任务语义选岗（视觉/视频/发布/定价/增长五域，`runtime/dispatch-routing.ts`），
  不再只按 bundle 清单顺序取第一个 orchestrator；计划持久化（`threads.plan/plan_version`，replay 复用
  原计划）、步骤指纹绑定审批与已完成回执（审批漂移→重新裁决、done 漂移→重跑）、plan 相关性评估；
- **审批与线程生命周期**：同步骤挂起去重（不再刷屏）、兜底计划只对写步骤强制人工且跳过围栏自动判定、
  驳回联动线程 `cancelled`、agent 批准后自动续跑、agent 支持 runImmediately（返回 pending_review）；
- **执行面**：多桥执行器注册表 `WORKLOOM_TOOL_EXECUTOR_MODULES`（桌面端按载荷自动注入，token 走进程
  环境/工位本机文件），桥缓存按作用域分桶；工具异常 → 线程 failed 终态（不再僵尸 running）；
  并发口径只统计有心跳的 running；
- **本机调度器**：`runtime/scheduler.ts` 扫描 queued 线程自动执行（含 agent 接管），启动时把崩溃遗留的
  running 线程转 paused；
- **模型链路**：provider 真超时 + AbortSignal 贯通、场景化超时表、全链熔断快速失败、意图分类分场景
  （交付入口 12s）+ 问句优先规则兜底、ask 120 字硬闸 + 围栏输出闸门 + 合成/降级标识、
  geo-growth 领域事实面按行业注册（实时取数）、tRPC onError 统一日志 + 5xx 事件化、goalRef 长文档案、
  视频 clarify 带回原目标；
- **围栏词表**：三包红线动作对齐真实工具名（只增不减），无法接线的红线显式声明 `unwired_blocks`；
  装配检查单新增「围栏-工具词表交叉校验」（红线空膛＝装配失败），出题器改双视图；
- **数据与门禁**：新增迁移 0047（计划持久化/审批 superseded）、0048+0050（号源序列化 + 现存最大值下限）、
  0049（线程 cancelled）、0051（事件租户护栏：工作区有属主行时事件租户必须一致）；
- **生产态验收**：`pnpm suite` 467/467、`db:verify-chain` 六项全绿；右侧对话框三类型真机——
  ask 领域问答（T-113）、quest 生图真实交付（T-115，`receipt.mode=real`）、agent 挂起→批准→自动续跑
  →completed（T-116，任务详情页含真实回执与产物下载）。

## [loomball] - 2026-09-27 · 织球 LoomBall：AI 班组状态可视化（T-2026-0926-0019）

> 一只球把「班组此刻在干什么」变得看得见：名册 / 织伴 / 任务页三处接入，全部由**真实信号**驱动
> （事件账本最近动作、待审批单、围栏阻断、夜班窗口、run 注册表）；开关一关全体回退。

- 新增 vendor 适配层 `apps/web/src/vendor/loomball/**`：上游 grok-ball（MIT）**原样**入库
  （`PINNED` 锁 commit + `LICENSE` + `NOTICE.md` 署名与去商标声明）；适配层捕获后删除上游兼容门面
  `window.GrokBall`，业务代码零上游商标字样（`provenance.test.ts` 闸门）；
- 新增组件层 `apps/web/src/components/loomball/**`：`LoomBall.tsx`（品牌皮肤/尺寸推眼倍/live 与 hover
  激活/注视跟随/`prefers-reduced-motion` 静态）、`agent-emotion.ts`（状态→表情**唯一事实源**，与文字
  chip 同源）、`useStableEmotion.ts`（1.5s 最小驻留 + 出错立即报丧并驻留 6s）、`emotions-workloom.ts`
  （自定义工作状态 `50 渲染中 / 51 待审批 / 52 夜班值守`，完整声明式配置）；
- 服务端补真实信号：`roster.list` 增 LATERAL 三投影（最近动作+时间 / 待审批数 / 近 1h 围栏阻断数）、
  新增只读聚合 `video.studio.active`（run 注册表 + approvals 表）——不新增表、不改任何写路径；
- 三处接入：名册员工卡（44px，忙碌/待审批常驻动画，其余静态 + hover 激活；状态 chip 与球同源）、
  织伴小角落态（mini 圆球 = 班组状态眼，紧凑态旁挂 40px）、任务页标题行（`pending_review`=待人审）；
- 开关与回退：`VITE_LOOMBALL=1` 默认开、`=0` 全部回退（等尺寸空盒/海报球/不渲染），零实例零监听零帧循环；
- 登记与文档：`oss-components.json`（weekly 扫描、永不自动升级）、`docs/loomball.md`（映射表/三接入面/
  防抖与性能/运维回退/真机清单）、`.env.example` 登记开关；
- 真机证据（本地 PG17 + 79 岗种子 + 真实网关事件）：名册 79 球静态渲染 3s 采样 76 帧（仅 2 球常驻动画）、
  hover 激活 `0→1`、注入真实事件后 渲染师=50 渲染中 / 情报官·采集=40 检索资料、待审批 3 单=51、
  夜班窗口 31 岗=52、任务页完成态=33；`VITE_LOOMBALL=0` 生产构建三处全回退。

## [intel-search-api] - 2026-09-25 · 情报检索通道加固：API 检索源（T-2026-0925-0003）

- 引擎链新增 `api` 通道并置顶：`TAVILY_API_KEY`（Tavily 协议）或 `WL_SEARCH_API_URL`+`WL_SEARCH_API_KEY`
  （通用 JSON 网关，Bearer 鉴权）配好即自动启用；未配置静默跳过，保留 HTML 三引擎链（baidu-m/so360/bing）；
- 结果数组/字段名多形态兼容（`results / items / data[] / data.items[]`；`snippet|content|description|summary`）；
- 限流（403/429）与 HTML 通道同口径进 15 分钟熔断冷却，缓存复用，失败按缺站（不编造）；
- 单测 +4（Tavily 解析/通用网关鉴权/限流熔断/未配置静默），`apps/server` 用例 12/12 通过。

## [video-routing-dossier] - 2026-09-25 · 视频管线自动化分流 + 商品情报档案激活（T-2026-0925-0002）

> 营销片/叙事片自动分流（不确定就问用户，不猜不提）；商品情报档案从「只出任务书」变为可用的真实档案链路；
> 真机跑批暴露并修复 7 类宿主/引擎缺陷（含"AI 监制只看到 600 字摘录"这一系统性误杀根因）。

### 自动化分流（新增）

- `packages/video-studio/src/pipeline-router.ts`：显式声明 → 规则打分 → 商品锚点 → LLM 仲裁（`pipeline-route`，L1+规则兜底）→ **不确定即澄清**；
  营销片缺商品名同样先问（情报五站以商品为锚）；`stripRoutingDirective` 清掉分流行指令、`buildPipelineIntent` 写入需求口径；
- `threads.dispatch` / `video.studio.start` 接线：澄清落 `video.route.clarify`、判定落 `video.route.standard`（含 pipeline/via/confidence/product/signals）。

### 商品情报档案激活

- 新增 `apps/server/src/video/data-mining-executor.ts`：多引擎检索（baidu-m/so360/bing）+ 限速熔断 + 磁盘缓存 +
  可预置真实来源 + **URL 白名单**（防幻觉链接）+ 相关性过滤 + 失败半量重试 → 仍失败即缺站；
- vendor 引擎修复：A4 独立来源定级（修「提及次数=来源数」的 confidence 虚高）、信封链校验、档案落盘原子化与根目录、
  A3 查询矩阵键兼容、检索词去重复品牌。

### 宿主门与创意链路修复

- 门内容落盘送审（`writeGateArtifact`）：监制不再只看到 600 字摘录；
- AI 监制打回 → **有上限自动重跑**（`VM_PRODUCER_RETRY`，默认 1 次）；
- 创意主题：营销 Brief + 情报摘要卡进生成输入、类型词表补社媒营销语汇、LLM 提取强制 JSON、Brief 口径（时长/画幅/平台）统一 + 基调护栏；
- G3 确认单补「需求契约（角色/场景/道具/动作）+ 受众/风险结论摘要」。

### 跑批工具与文档

- 新增 `scripts/tools/data-pipeline-run.mts`：不提交渲染的完整数据管线跑批（产物与 `video.studio.start` 同形，可直接接 `pipeline-audit`）；
- 新增 `docs/video-pipeline-routing-and-dossier-2026-09-25.md`：分流口径、激活链、逐环节审计证据、遗留项与回滚开关。

## [base-sync-1.12.0] - 2026-09-02 · 基座同步：技能保鲜环 P1（自动同步 + 上行回流 + 官方运营台）

> 自 workloom-im@1.12.0 同步（vendored 基座公共段一致）：skill-ops P1 完全体（autosync/reflux/console）+ 迁移 0019/0020 + SkillDistBanner 通栏 + skillOps.reflux/console 路由 + 官方端点 + suite Y 域 P1 用例与 R-26 加固 + L2 审批 tier 红线修复（l4_chairman）。
> 门禁：typecheck 全绿 · vitest skill-ops 28/28 · suite 全绿（干净库口径）。

## [base-sync-1.11.0] - 2026-09-02 · 基座同步：技能保鲜环 P0（下行分发通道）

> 自 workloom-im@1.11.0 同步（vendored 基座公共段一致）：packages/base/skill-ops 全量 + 迁移 0018 + skills.skillOps.* 路由 + suite Y 域用例。
> 门禁：typecheck 全绿 · vitest skill-ops 19/19（含 RUN_DB_TESTS=1 PG 集成）· suite 全绿。

## [3.5.0] - 2026-08-25 · Candy Design System v1.0：视觉规范标准 + 舰队术语清理 + 四仓推广

### 视觉规范标准（docs/design-system.md）

- Candy Design System v1.0 正式发布：色板（奶莓浅底四阶/珊瑚红/蓝莓/糖果语义四色/可可文字）/
  组件规范（按钮/卡片/审批卡/表单/空态/横幅/剧场）/ 深浅底对比纪律 / D33 踩坑纪律六条 / 跨项目同步纪律。
- 踩坑纪律源自实战：高光令牌浅底反转（goldhi 深珊瑚）/ Canvas 精灵纯色验证法 / 名牌白底深字 /
  语义横幅浅底深字 / 截图验收等动画终态 / 禁用隐喻黑话。

### 舰队系术语全局清理（19 文件）

- 主甲板→工作台·总览 / 任务舱→任务页 / 航道管制台→规则与权限 / 航道状态灯→围栏状态灯 /
  设定航线→一句话目标 / 舰队即刻启航→团队即刻开工 / 舷窗→平静 / 船员→成员 / 舰桥副官→AI 副官。

### 剧场浅底细节修复（D33）

- 员工 SKIN 全色系加深（idle 纯红验证法定位渲染路径）/ 名牌白底深字 / 网格线深阶 /
  请示气泡深蜜桃 / 场景信息行对比 / 片场场景名对齐星芒好物 / Bridge 品牌 WorkLoom。

### 四仓推广（PC + 移动端）

- workloom-im @ ce5280f（suite 445/445 ✅）
- workloom-hotel @ 3d37ce3（434/436，2 个既有 onboarding 遗留建议专项回灌）
- hyperreality-system @ 4d0a50f（suite 445/445 ✅；硬化适配同步补齐：0017 吊销函数通道/scheduler 竞态/B-20/B-28/H-33/R-11/R-16）
- 每仓均含 docs/design-system.md；demo HTML 全量糖果化；地板主题按行业分色。

### 验证

- 主仓 suite 445/445 · suite:geo 77/77 · suite:hotel 43/43 · release:gate 15/15 · typecheck 0 error（四仓）

## [3.4.0] - 2026-08-25 · 更名「WorkLoom AI 获客系统」+ 糖果色视觉 + 饱满获客运行态

## [3.4.0] - 2026-08-25 · 更名「WorkLoom AI 获客系统」+ 糖果色视觉 + 饱满获客运行态

### 更名与定位

- 项目正式更名 **WorkLoom AI 获客系统**：README 按 AI 获客实际内容重构（先算三笔账/获客视角的一天/获客五环主线）；package.json → workloom-ai-acquisition；演示页品牌统一。

### 视觉改造（深空蓝 → 小红书式糖果色）

- 设计令牌（apps/web + apps/webc）：奶莓浅底四阶 / 珊瑚红主色 #ff2442→#ff7a9e / 蓝莓信息色 / 糖果语义四色（薄荷绿/蜜桃橙/草莓红/葡萄紫）/ 可可文字三级 / goldhi 深珊瑚 #d4002a
- Bridge 舰桥框架糖果化（云白渐变/糖果晕染/珊瑚星点）；P0 剧场（奶莓底/珊瑚星点/三 Bundle 地板主题：酒店蜜桃·片场薰衣草·GEO 天空蓝）
- 对比修复：SimBanner/P0 头部/信息行/Floor 网格与气泡/gamification 光辉
- 8 个演示 HTML 全量糖果化（hotel-guest/owner、geo-customer-app、hyperreality-pc/mobile、service-front×3）

### 饱满获客运行态（获客丰厚酒店全流程模拟）

- 种子获客剧本事件 12→30 条：市场动态扫描 → 周策略备忘 → 人群三细分圈选 → AI 视频（脚本/导演评审/渲染）→ 社媒营销（抖音爆款 86.2w/小红书种草/直播 GMV ¥18,400）→ GEO（六段式收录/能见度 34% 区域第一）→ 线索（周末批量 47 条/B 级培育转化）→ 成交（会议团 ¥17,520/月归因 ¥128,600/佣金节省 ¥14,900）→ 复购（转介绍 11.5× ROI/OTA 评分 4.6→4.8/六级漏斗 ROI 13.7×）
- 档案 acquisition 字段组扩充：market_scan/audience_segments/strategy_weekly/funnel_targets 丰厚口径
- 店长驾驶舱 demo 丰厚化：北极星 ¥128,600/六级漏斗 620w 曝光链/市场+策略+人群三卡/本周内容实绩卡

### 测试修复（D32）

- R-11/R-16 队列隔离：历史用例遗留 l2_captain 待批被节拍分批消化（escalate 发事件不计 decided）造成计数假失败——测试前快照暂拒、finally 恢复
- suite-hotel E-07 批量留资事件脱敏校验口径；套件获客事件期望 12→30

### 验证

- suite 445/445 · suite:geo 77/77 · suite:hotel 43/43 · typecheck 0 error

## [3.3.0] - 2026-08-25 · 酒店垂直经营系统：社媒营销 × GEO × 获客 × 运营一体

## [3.3.0] - 2026-08-25 · 酒店垂直经营系统：社媒营销 × GEO × 获客 × 运营一体

### P0 酒店垂直资产迁移（自 workloom-hotel v2.3.1，原仓库不变）

- bundles/hotel 全量替换：围栏 v3 R1-R20 + 三客群 patch + segment-defaults 客群默认安装清单 + 25 官方技能 + 11 员工 + 20 对象 + floor-scene
- seed 垂直化：14 个经营字段组（business/channels/price_calendar/operations/staffing/suppliers/goals/approval_matrix/compensation_policy/linen/incident_profile/faq_kb/live_rules/segment+pms_vendor）+ 行业触发器 ×4 + 围栏版本化装载（旧版本滚动 rolled_back）
- 销售资产：docs/sales 一页纸×3 + methodology 落地三技能体系 + 用户指南×4

### P1 获客域落地（获客五环并入单 Bundle）

- **对象 20→28 类**：+intent_signal/lead/coupon_sku/booking_order/poi_store/conversion/live_campaign/content
- **员工 11→16 员**：+AI接待员（四路承接 7×24）/团购运营/住客运营/渠道哨兵（意图雷达）/公司CEO（漏斗复盘指挥）
- **围栏 v3→v4（R1-R26）**：+R21 AI 接待报价承诺必审 / R22 券库存熔断 / R23 线索数据出域必审 / R24 客资隐私红线 / R25 获客内容口径校验 / R26 券定价红线
- **技能 25→29**：+lead-concierge/coupon-ops/hotel-geo-content/intent-radar
- **管线**：hotel-acquisition-loop 九步五环主链路（雷达→排期→发布→承接→分级→转化→归因→复购→复盘）
- **连接器清单 ×4**：PMS/抖音本地生活/OTA/企微（mock 先行，bundles/hotel/connectors/connectors.json）
- **三客群分型并入获客组**：民宿获客技能紧随 content-marketing 前置（种草是命脉）
- **种子获客化**：12 条获客剧本事件（意图雷达→26s 首响 A 级留资→券成交→归因含 OTA 佣金节省对照→住客关怀）+ 档案 acquisition 字段组 + 获客触发器 ×2

### 演示系统更新

- 新增 docs/demo/hotel-guest-app.html：C 端住客小程序原型（首页种草/抢券/AI 前台/订单/会员 5 屏，含 R21 报价人审演示）
- 新增 docs/demo/hotel-owner-app.html：B 端店长驾驶舱原型（战报+六级漏斗+归因成交额+佣金节省/线索/审批/16 员工/我的 5 屏）

### 测试资产

- scripts/suite-hotel.ts 43 用例（pnpm suite:hotel）：Bundle 完整性 / R21-R26 正反例 / 种子运行态 / 管线与客群分型 / 获客事件留痕
- 发布门禁登记 suite:hotel（skills/official/release-gate + docs/release-checklist.md）

### 验证

- suite 445/445 · suite:geo 77/77 · suite:hotel 43/43 · release:gate 15/15 · 验链 0 异常

## [2.0.5] - 2026-08-24 · 发布门禁技能化（D31）：跨仓库底座同步 + workloom-release-gate 技能

本文件记录 WorkLoom IM 底座的变更历史。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/)。

## [2.0.5] - 2026-08-24 · 发布门禁技能化（D31）：跨仓库底座同步 + workloom-release-gate 技能

### 新增

- **`skills/official/release-gate/SKILL.md`**：发布上线前三链路校验技能（触发即执行：识别 WorkLoom 底座仓库的发布意图 → 强制 suite + release:gate 全绿才放行）；含标准流程/环境适配/红线/缺陷档案/跨产品同步纪律。
- **门禁工作区自适应**：release-gate 自动探测演示工作区（hyperreality 单区 / WorkLoom GEO 双区直接复用），探测为空判死。
- **组织记忆升级**：mem-release-gate-* 三工作区 SOP 记忆同步技能锚点。

### 跨仓库同步（hyperreality-system @ 9fc3b59）

- 底座修复全量回灌：迁移 0015/0016 号源函数、fence DSL 扩展、装配器属地查验、内容域 QUEST 拆解+工具、17 员工围栏绑定、archive schema、夜班 ID 前缀、P3 审批卡、web 工作区可配置、release-gate 门禁与政策文档。
- mock 测试补号源函数匹配 ×6（两库同步）。

### 验证

- hyperreality：suite 445/445（独立库）· base 单测 415 全绿 · typecheck 全绿 · release:gate 9/9 ✅
- workloom：release:gate 12/12 ✅ · base 单测 415 全绿 ✅

## [2.0.4] - 2026-08-24 · 发布门禁（D30）：三链路校验清单固化 + 首跑即擒 4 个主链路缺陷

### 新增（发布红线制度化）

- **`scripts/release-gate.ts` + `pnpm release:gate`**：发布前核心链路校验门禁（12 项）——ASK ×4（双工作区真实场景问答）/ QUEST ×2（目标拆解≥2步+事件留痕）/ 编排 ×3（触发器在位/节拍回调落账/全库验链）；任一失败 exit 1 = 禁止发布；启动打印环境口径（沙箱 mock / 线上真实端点）。
- **`docs/release-checklist.md`**：校验清单政策文档（三链路要点/环境适配/红线/缺陷档案）。
- **组织记忆固化**：`mem-release-gate-*` SOP 记忆写入三工作区（org_memory，confidence 0.95）。

### 修复（门禁首跑擒获，皆为「ASK 故障历史教训」同族）

- **线程/项目号跨工作区撞库（P0）**：T-###/VID-### 按本区最大值分配但主键全库唯一 + 正则 `\d` 不被 PG 支持（号段过滤恒空）——任一工作区第二次派遣即 duplicate key。迁移 0016 号源函数（threads_max_t_no/video_projects_max_vid_no，SECURITY DEFINER 全库最大值）+ `\d`→`[0-9]`。
- **线程号 bigint 拼接爆炸（P0）**：pg 驱动 bigint 返回 string，`"133"+1` 字符串拼接 → T-133111111111111111（20 位溢出 bigint）。三处调用点 Number() 转换。
- **内容域 QUEST 只拆 1 步（P1）**：planQuest 模板仅酒店域三场景——补内容生产链五步拆解（情报→脚本→人审→分发→回收，与 README §三承诺同口径）+ dispatch 注入 llmCall（线上真实模型规划）。
- **内容域工具未注册（P1）**：演示面工具表仅酒店域——注册 intel.collect/script.draft/content.submit/publish.execute/metrics.collect 五个 L3 确定性剧本工具。

### 回归

- release:gate 12/12 ✅（QUEST 拆解 5 步→执行 3 步→G9 必审门正确挂起 pending_review）· suite 445/445 ✅（全新库）· suite:geo 77/77 ✅

## [2.0.3] - 2026-08-24 · 号源根因终修（D29）：RLS 遮蔽的全租户事件号分配 + service-c 合并树全绿

### 背景

合并 service-c（f460718：AI 服务前台四包 + apps/webc 第三端 + 迁移 0012-0014）后，套件在全新库上确定性失败（R-05~R-21 captain 节拍事件全灭）。三连排查定位真根因。

### 修复（P0·数据底座）

- **事件号源被 RLS 遮蔽（真根因）**：D28 的号源修复（max(event_id) 单调分配）在 RLS 上下文内执行，只能看到当前工作区事件——各工作区"各自为政"分配，ws-yunqi 计数器冲进 ws-geo 种子号段（9901-9960）时 **60 条事件被 ON CONFLICT 幂等静默吞掉**（captain 节拍/审批/探针事件连环失踪）。
- 落地：迁移 0015 新增 `biz_events_max_event_no(tenant_id)`（SECURITY DEFINER，属主身份绕 RLS 读全租户号尾，只暴露一个数字）；appendEventInTx 改调该函数。分配与约束（UNIQUE tenant+event_id）终同域。
- 验证：全新库三连跑 445/445 ✅（此前首跑必挂 R 域），号源单调推进无吞事件。

### 修复（合并树整合）

- **P-15 前后端契约对账**：套件此前只解析 video 子路由，service-c 的 serviceRouter（kb/tickets/stats）被误判"悬空调用"——契约检查扩展 service 子模块解析。

### 回归（合并树最终态）

- suite 445/445 ×3 连跑 ✅ · suite:geo 77/77 ✅ · typecheck 全绿 ✅ · 验链 3897 事件一致 ✅

## [2.0.2] - 2026-08-24 · 三端走查（D28）：C 端前台建成 + 事件号源缺陷修复 + 数据饱满度升级

### 修复（A 级·演示根基）

- **事件号源缺陷（P0）**：appendEventInTx 按 max(seq)+1 分配事件号，与种子人工号段（6600/8800/9900）碰撞——新事件被幂等静默吞掉、审批键连环撞车（套件一度 105 失败）。号源改为全库事件号最大值单调分配（events.ts）。
- **夜班班次 ID 跨工作区撞库（P1）**：hotel 种子占 nr-<date> 主键致 video 夜班被吞（P3 空态）。改 nr-video-<date>。
- **装配校验三面红旗（P1）**：ai-video 补 archive.schema.json；阶段枚举口径并入 account_stages；装配器探针/围栏查验切换到 Bundle 属地工作区（RLS 纪律内）；17 员工补齐 fence_bindings。三 Bundle 校验全绿。

### 新增

- **C 端 AI 服务前台原型** `docs/demo/geo-customer-app.html`：战报/审批/询盘/能见度/我的 5 屏，微信小程序形态，全交互，#tab 直达。
- 走查报告 `docs/ux-audit-2026-08-24.md`。

### 优化（买单人视角数据饱满度）

- seed-geo：英文真实采购评论 / 4 个真人询盘样本（入口/阶段/来源路径）/ 指标周末波峰+确定性抖动 / 能见分平台明细+竞对基准+7 日趋势 / 夜班战报三栏口径。
- P3 审批卡补标题+CEO 意见+命中门号（兼容 summary/title 双快照口径）。

### 回归

- suite 445/445 ✅ · suite:geo 77/77 ✅ · 验链 3732 事件一致 ✅

## [2.0.1] - 2026-08-23 · 深度压测（D27）：全系统摸排 727 用例全绿 + 9 项缺陷修复

### 压测口径

- 底座场景套件 445/445 ✅ · 单元测试 205/205 ✅ · 新建 GEO 双域套件 77/77 ✅（`pnpm suite:geo`）· 哈希链 260 事件逐条重算一致 ✅
- 新建 268 条用例目录 `docs/test-catalog-geo.md`（77 已自动化 / 191 排产）；审查总报告 `docs/review-2026-08-23.md`

### 修复（底座级 ×3）

- **围栏 DSL 能力陷阱（P0）**：`in [...]`/`contains_any()` 不支持 + 路径缺失即熔断，导致 G10 评论四档分流、G15、G-GEO2/3、G16、G17、G20 实战全部「宁可错杀 block」（ai-video Bundle 同病）。expr.ts 扩展列表字面量/in/contains/contains_any；缺失路径在比较语境宽容为不命中，算术与大小比较保持严格。
- **事件 ID 段撞车（P1）**：seed-geo 误用 8800 段与 hotel 冲突（同租户 UNIQUE），种子验收失败。改 9900 段并立段分配纪律。
- **agents/triggers 跨工作区撞库（P1）**：裸 id 主键与 seed-video 撞库，ws-geo 丢 4 员工 + 6 触发器（CEO 节拍错指 ws-video）。id 全部加工作区前缀。

### 修复（GEO 集成 ×6）

- floor-scene 补 ceoDesk/lounge/entrance 三要素（双域作战室此前兜底为通用办公区，已截图实证上墙）
- 私域承接专员补绑 G10a-d（评论四档分流此前无人负责）
- 询盘打标 `i%2` 逻辑恒单入口修复（90 天硬指标「双入口验证」险假死）
- 种子审批幂等（ON CONFLICT 改 approval_id）/ 能见度监测官补夜班 / 新增 G-GEO4 信源日发熔断（围栏 16→17 条，对称 G9b）

### 新增

- `scripts/suite-geo.ts`：GEO 双域 77 条（Bundle 完整性/围栏正反例/种子运行态/管线节拍/事件留痕）
- `apps/web` 工作区可配置（VITE_WS_SLUG/VITE_MEMBER_NO，多工作区过渡方案）
- 对象模型 +query_item/deal_order/workspace（31 类）

## [2.0.0] - 2026-08-23 · WorkLoom GEO：社媒短视频营销 × GEO 双域融合经营系统

### 新增（geo-growth Bundle，底座零改动，一切能力经 Bundle 注入）

- **`bundles/geo-growth/` 双域差异资产包**（依《社媒短视频营销×GEO 融合经营系统落地执行方案 v1.0》全量落地）：
  - **16 个数码员工 preset**：情报组（调研员/引用源分析师）+ 内容组（脚本师/生产编排员/GEO 内容策划/实体一致性管理员）+ 分发组（发布专员/信源分发专员/投放优化师）+ 数据组（数据看板官/AI 能见度监测官/复盘分析师）+ 经营组（客户成功专员/私域承接专员）+ 指挥层（公司CEO captain/集团CEO fleet）；
  - **双域基线围栏 17 条**（`fences/geo-growth-baseline.yml`，全部 is_baseline 只可加严）：社媒域 G9/G9a/G9b/G10a-d/G12/G15/G16 + GEO 域 G-GEO1（外发必审）/G-GEO2（事实红线一票否决）/G-GEO3（灰帽熔断）/G-GEO4（信源日发熔断）+ 双域 G17（只紧不松）/G18（熔断通知+快照）/G20（涉人设品牌表态强制 L4）；
  - **4 条 Quest 主干管线**：intel-fusion（选题情报双向流动）/ dual-content-factory（一次生产两处变现）/ visibility-watch（AI 能见度监测）/ ops-rhythm（日/周/月经营节拍+询盘双入口）；
  - **双域对象模型 31 类 + 阶段枚举**（schemas/）：query 集/能见度快照/引用源/品牌实体卡/一客一档 v2/双入口询盘/全网存在感战报/回测账本/影子模式对照报告等；账号成长六阶段机 + A/B/C 三层客户画像 + 三条交付线；
  - **一客一档 v2 Schema**（七模块：企业品牌/产品实体卡/目标市场/内容资产/运营资产/GEO 资产/转化资产 + 数据边界声明）；
  - **6 个 GEO 官方技能套件**：geo-query-craft（query 集四词类×双语）/ ai-answer-rewrite（六段式 AI 答案版改写）/ visibility-monitor（能见度监测+截图存证）/ citation-reverse（引用源逆向分析）/ entity-consistency-check（口径巡检）/ dual-entry-inquiry（询盘双入口归因）；
  - 双域作战室经营剧场场景（floor-scene）+ 工作台 UI 用例（ui/cases）。
- **`scripts/seed-geo.ts` + `pnpm db:seed:geo`**：双域演示种子（ws-geo 工作区）——16 员工装载、17 条围栏激活、一客一档 v2 建档（佛山锐科机械演示客户）、14 个自动化触发器（情报站 07:00/清晨决策包 08:30/能见度日频+周频/周一经营会/月度回测/夜班巡检/CEO Loop）、五元事件链 60 条（双域场景）、待批请示 ×3（G-GEO1 外发/G12 加投/G20 品牌表态）。
- **配置层**：`.env.example` 新增双域段（能见度监测平台/采集节奏/信源分发渠道/数据边界红线开关）；根 package.json 更名 workloom-geo 并注册 `db:seed:geo`。
- **文档**：`docs/geo-fusion-plan.md`（落地执行方案全量 Markdown 版：90 天逐周排产/定价模型/五大协同/北极星指标）；README 新增「五·六、双域融合」章节，快速开始改指 workloom 仓库。

### 纪律锚点

- 数据归属红线：客户业务数据（客资/WhatsApp 聊天/线索）留客户系统，事件链只记经营动作留痕；
- GEO 灰帽零容忍（G-GEO3 熔断）：承诺「可测量可追溯」，不承诺「保证上榜」；
- 北极星指标唯一：双入口有效询盘数（月）。

## [1.10.0] - 2026-08-31 · 自我进化飞轮 P0（D24）：反馈 → 记忆 → 行为校准

> 立项依据：《WorkLoom 自我进化方案 v0.1》+ 双行业（酒店 / AI 短视频营销）反向验证 v0.2——
> 「留痕完备、消费稀疏」：五元事件库已忠实记录全部反馈信号，本版本把它们接到能改变系统行为的消费端。

### 新增

- **M3 偏好注入主链路（`packages/base/evolve/preference-inject`）**：ask / agent / quest 三环执行前检索本工作区 active 的 preference / forbidden 组织记忆（forbidden 优先、confidence 降序、上限 `MEMORY_INJECT_LIMIT=5`；workspace 级 + subjectId 细分），以 `<org_preferences>` 数据块注入模型上下文（注入防护与 facts 块同构）；引用必留痕——产出事件同事务写 `memory_usage` + `decision.memory_refs`（F1.4 归因闭环，「哪条记忆影响了哪次产出」可反查）。
- **M2 记忆提炼器（`packages/base/evolve/memory-miner`）**：夜班节拍（advisory 锁防双写，与回测节拍同构）——① 驳回按 reason_enum 聚类 ≥3 次/30 天 → 强化 `mem-reject-<enum>` 偏好记忆（confidence 随次数封顶 0.9）；② edit 手势按被审动作聚类 ≥3 次 → 产出 `mem-pat-edit-<action>` pattern 记忆（纠错/口味按 editKind 分列）。**每次提炼发 `memory.calibrate` 五元事件——做实 B6 起在 workdata/memory.ts 注释中预留的机制位（G3）**。统计闸（修订 7）：窗口手势样本 <20 条只观察不提炼。
- **M2 记忆生命周期与人工治理（`packages/base/evolve/memory-lifecycle`）**：衰减扫描（90 天零引用 ×0.9，地板 0.1，不自动回收）· 来源人一键清算（成员离任作废其手势沉淀的偏好，防口味过拟合，修订 2）· 人类编辑（禁明文 PII，F1.8）· 人类禁用（回收区口径 F1.11）。四条路径全部写 `memory.calibrate` 事件。
- **M1 反馈枚举表（`packages/base/evolve/feedback-enums` + Bundle 第⑧装配槽）**：`bundles/<industry>/feedback-enums.yml`——行业受控驳回原因词表（底座零预置，D17/D18 红线）；已装配工作区的 reject 手势必须命中枚举（未装配放行，向后兼容）；edit 手势强制 `editKind` 二分（correction 纠错→缺陷池 / preference 口味→偏好池，修订 3 归因歧义）。server 启动 bootstrap 全量装载 + `activateBundle` 即时注册 + `bundles/hotel/feedback-enums.yml` 实物 11 条。
- **M5 进化积分卡（`packages/base/evolve/scorecard`）**：北极星=审批一次通过率（approved/已裁决）、人类修改率、近 8 周通过率趋势（飞轮看斜率）、驳回原因分布、记忆引用量与 `memory.calibrate` 活动量——全部从 approvals/org_memory/memory_usage/biz_events 投影，零新数据源。
- **tRPC**：`memory.*`（list/sources/update/disable/recallBySource/mineNow/decayNow/feedbackEnums）+ `evolution.scorecard`。
- **Web**：**P23 组织记忆中心**（/p23，导航「系统」组）——积分卡四卡 + 周趋势 + 驳回分布 + 记忆列表（编辑/禁用/归因反查/来源人清算/手动提炼）；**RejectDialog 驳回弹窗**（P0/P2/P3/P4/P21 五页接线）——枚举来自本工作区第⑧槽词表，未装配回落中性「其他」。

### 修复（顺带）

- **Web 端驳回链路全线失效（P0 级存量 bug）**：P0/P21 驳回不带任何原因、P2/P3/P4 仅带 reasonText 不带 reasonEnum——全部撞服务端 L5.2 EMPTY_REASON 拒绝。本次统一为 RejectDialog 受控枚举提交后修复。

### 门禁验证

- ✅ typecheck 全绿 · vitest 522（base 含 RUN_DB_TESTS=1 全量，新增 evolve 15 例）· suite 445/445 · verify-chain 一致
- ✅ 浏览器实拍闭环：P4 审批卡 → 驳回弹窗加载酒店 11 条枚举 → 选「回复语气不符」提交 → approvals rejected + `mem-reject-reply.tone` 偏好记忆落库 → P23 积分卡/驳回分布实时呈现

## [1.9.3] - 2026-08-23 · 融合审计（D26）：大版本耦合面深测与修复

### 修复（审计实证）

- **floor blocked 派生认不出真实熔断（P1）**：原查询依赖不存在的事件形态（action 后缀 `.blocked` / `decision.ruleResult.level`），真实裁决写在 `rule_impact[].result='blocked'`——修复后夜班 R2 熔断等真实拦截在职场显示踱步员工（浏览器实拍验证）。
- **floor celebrating 监听不存在的 action（P1）**：`quest.completed/night.package_generated` 无生产者——改为双通道：近窗 `threads.closed_at`（agent_id 归属）+ 真实事件（`night.package.deliver/ceo.board_pack/task.complete`）。
- **宪章并发读改写竞争（P2）**：grant/transit 的 load→transition→save 无锁互踩会留下 from/to 失真留痕——加进程内串行锁 withCharterLock。
- **Floor.tsx 点击遮挡与运行时泄漏（P2×2）**：hitbox 改逆序命中（上层优先）；员工离场（汰换）即清理动画运行时。
- **chairmanQueue 截断口径**：队列 LIMIT 20，互洽断言按 min(count,20) 校准；LLM 装配进程级全局补部署口径注释（一进程一工作区）。

### 新增（W 域融合回归 ×9，suite 436→445）

- 服务层：theater×floor 一致性（场景包命中/全员覆盖）· 请示全链（举手→裁决→回位→留痕）· 熔断/庆祝真实形态（审计修复的回归锚）
- HTTP E2E：LLM stub 装配后 runBeat via=llm · **开箱运行态断言**（卫星≥5/实况≥10/前厅场景/开箱即举手/人人有工位有状态语/横幅数据源）· activateRealMode 融合 · P21 三端点互洽 · LLM 降级链（死端拒绝→mock 兜底不断链）

### 门禁验证

- ✅ suite 445/445 · demo 44/44 · typecheck 全绿 · vitest 150 · verify-chain 一致 · 浏览器四视图走查（职场/舞台/P21 触发晨报联动剧场语音气泡/落地向导）

## [1.9.2] - 2026-08-23 · 数字职场（D25-α）：等距 2.5D 办公区

### 新增

- **数字职场视图（P0 双视图，默认职场）**：等距 2.5D 办公区 Canvas 渲染（零素材程序化绘制）——员工五态实时动画：working=工位打字（屏幕字符滚动）/ blocked=遇阻踱步+「!」气泡 / asking=**走到 CEO 指挥台举手+聚光灯，点开原地三手势（批准/驳回后走回工位）** / celebrating=跳跃+彩带粒子 / idle=休息角待命；disabled 工位清空名牌变灰。顶栏 [职场|舞台] 切换（localStorage 记忆），舞台=保留 D23 全息卫星群（升旗仪式），职场=日常巡逻。
- **`packages/base/captain/floor`**：员工状态派生（全部只读 SQL 实时派生，动作即数据；优先级 asking>blocked>celebrating>working>idle）+ 场景包体系（声明式 JSON：地板/工位锚点/道具/CEO 指挥台/休息角/入口/主题色；`registerFloorSceneProvider()` 行业挂钩 + `bundles/<industry>/floor-scene.json` 磁盘约定 + 通用办公室兜底）。
- **行业场景包**：`bundles/hotel/floor-scene.json`（酒店前厅：前台柜台/房态看板/行李车/大堂吧）；片场包随 hyper 仓推广落地。
- **theater 端点扩展** `floor` 段（场景+员工态一次给齐；独立聚合故障不阻塞剧场主数据；行业值读取并入 RLS 事务，修复无 GUC 直查恒空）。

### 门禁验证

- ✅ suite 436/436（新增 V 域 8 条：场景兜底/注册优先/五态派生逐态/优先级/工位映射不越界，专属探针员工隔离近窗污染）· demo 44/44 · typecheck 全绿 · verify-chain 一致 · 浏览器实拍：职场五态同框 + 请示举手→原地批准→走回工位完整闭环

## [1.9.1] - 2026-08-22 · 落地向导（D24）：模拟运行态 → 真实经营

### 新增

- **模拟数据常显横幅（SimBanner）**：P0 经营剧场与舰桥全页面顶部常显——数据为演示种子或模型为内置 mock 时提示「当前为全模拟运行态」，按钮直达 `/onboarding`；事实源为新端点 `onboarding.status`（dataMode + LLM 装配 + 工作区规模），两者皆真实时自动熄灭。
- **落地向导四步（/onboarding）**：① 环境自检（自动：DB/事件库/团队/模型/数据模式）→ ② 真实大模型（DeepSeek/Kimi/智谱/OpenAI/自定义预设一键填；`onboarding.testLlm` 真实 round-trip 试调，`saveLlmConfig` **试调通过才落盘** .env 四变量 + process.env + 清装配缓存，全链即时真实化免重启）→ ③ 经营主体（写一店一档 `archive.business`）→ ④ 启用真实模式（`activateRealMode` 翻转 `profiles.archive.dataMode`，横幅熄灭）。全程五元事件留痕（`onboarding.llm_configured` / `workspace_profile` / `real_mode_activated`），API Key 只记掩码后 4 位。
- **ask 联网实时检索事实面**：`ASK_WEB_SEARCH=1` 开启，Bing 公开 RSS（keyless 零依赖）取实时网页结果与库内事实合并供模型合成；检索源标注入 `basis`，失败静默降级。
- **种子标记**：种子库写入 `dataMode=simulated`（横幅事实源；历史库缺省按模拟态处理，宁多提示不漏提示）。

### 修复

- `OpenAiCompatibleProvider` 支持免 key 网关/本地代理（apiKey 可空，自动省略 authorization 头）。
- `scripts/reset.sh`：有 docker 守护进程但无 `workloom-im-pg` 容器时误走 `docker exec` 导致重置失败——改为容器真实存在才走 docker 通道，否则回退本机 psql。

### 门禁验证

- ✅ suite 428/428（新增 5 条 D24 E2E：模拟态事实源 / stub 实证 saveLlmConfig→via=llm 真实推理 / mock 还原 / 主体写入+真实模式切换+复位）· demo 44/44 · typecheck 全绿 · verify-chain 全库一致 · 全新克隆首次安装验证（install→migrate→seed→dev 开箱运行态 + 横幅 + 向导浏览器四步点击流全通）

## [1.5.0] - 2026-08-21 · 行业落地向导批次

### 新增

- **`packages/base/wizard`（行业落地向导）**：首次装机的产品化引导状态机（welcome→industry_select→research→design→delivery→activated→handover，paused 断点续跑），编排"技能一（竞品调研）/技能二（一线调研）→技能三（落地方案）→技能四（交付配置）"Quest 序列；行业内容零预置（D18）；激活门禁与装配检查单同口径；能力裁剪激活（community 版向导全程可跑，超版本能力"已配置·待升级解锁"）；反哺上报四红线校验（D19）。17 条纯函数单测全绿。
- **`skills/official/` 官方套件（D19）**：`industry-entry/` 落地四技能（industry-benchmark-research v1.2 / industry-frontline-research v1.2 / workloom-industry-landing-design v1.3 / delivery-config v1.0）+ 快速上线骨架模板；`product-feedback/feedback-insight` 反哺信息每日聚类分析技能。配套磁盘加载器 `packages/base/skills/official.ts`（frontmatter 解析 + 扫描入库，bundle=null）。
- **文档**：`docs/04-行业落地向导-用户版.md`、`docs/methodology/01-行业落地三技能体系.md`（协作关系与调用契约）；`docs/DECISIONS.md` 新增 D17（官方套件顶层目录）/D18（向导行业无关+能力裁剪激活）/D19（反哺隐私红线）。

### 纪律

- 向导只编排任务与依赖，不含任何工期/时间点（排期禁令）；底座代码零行业词汇。

## [1.4.1] - 2026-08-21 · 深度安全修复（审计第 11 轮）

### 安全修复

- **#42 skill_publish_reviews 跨工作区越权（P1）**：0006 新表漏 RLS——任何工作区可读写他区上架审核单（实测篡改成功）。0008 迁移 ENABLE+FORCE RLS 双口径收口。
- **#43 审批同事件跨通道幂等**：inapp/dingtalk 双通道审批行此前可各批一次（一动作双批）。decide 锁同事件全部审批行，他行已终态按重复回调处理。

### 门禁验证

- ✅ base 174/174 · runtime 12/12 · suite 392/392 · typecheck 全绿 · 干净库 8 迁移 + verify-chain 100/100 · E6 dsh-gate 全绿

## [1.4.0] - 2026-08-21 · 双池事务一致性（D16，审计第 10 轮）

### 架构修复

- **#1/A 双池事务一致性（SECURITY DEFINER 方案，D16 ADR）**：业务状态写与事件写从此同一事务同一 COMMIT——`append_event_insert()` 特权函数（gateway 权限执行，app 角色仍无直接 INSERT，铁律 1 不破）；DB 层新增上下文一致性（防伪造）与链式接龙（断链拒写）双校验。30 处「业务+事件」调用点全部事务内化（decide/expireSweep/install/uninstall/publish/ingestInbound/派单/夜班/触发器/Quest 循环/setPlan/dispatch/proposeRule/forge/activateBundle）。
- **原子性回归**：atomicity.test.ts（同事务双生 / 崩溃注入无孤儿 / 断链拒写 / 防伪造 / A3 不变）。

### 门禁验证

- ✅ base 157/157 · runtime 12/12 · suite 390/390 · typecheck 全绿 · 干净库 7 迁移 + verify-chain 100/100 · 安全门禁 7/7

## [1.3.0] - 2026-08-21 · industry 上架门禁五机制（审计第 9 轮）

### 新特性

- **D15 五机制落地**：industry 技能上架门禁——①上架脱敏扫描（PII+敏感词强制检测）②审核流水线（双人复核/禁止自批/全程留痕）③供应链注入评估（四类注入模式拦截）④全局吊销 kill switch（安装与装配双点排除）⑤版本通道（安装版本快照+更新提示）。配套 0006 迁移（skill_publish_reviews / skill_revocations / skill_installs.installed_version）。
- **industry 白名单开口**：desensitized 的 industry 技能可安装（D15 前置机制就位后的既定动作）。

### 测试

- suite 371→390：H 域 D15 回归 16 条 + expire 并发边界 2 条 + 前后端契约对账 1 条（实测零悬空）。

### 门禁验证

- ✅ suite 390/390 ×2 连跑 · base 152/152 · typecheck 全绿 · 干净库 6 迁移 + seed + verify-chain 100/100

## [1.2.1] - 2026-08-21 · 文档同步与 industry 层安全评估（审计第 8 轮）

### 文档

- **README_EN.md 与中文版全量对齐**（60 秒 AI 助手速览英文版 / 快速开始 / badge / 链接 / 路线图）。
- **D15 ADR**：技能市场 industry 层开放前置门禁——结论「暂不开放」，先建五项机制位（上架脱敏扫描 / 审核流水线留痕 / 供应链注入评估 / 全局吊销 kill switch / 版本通道升级提示）。
- apps/site 官网核对：无过时数据，无需修改。

## [1.2.0] - 2026-08-21 · 质量基线版（审计第 7 轮；tag 版本线与项目历史对齐，前序 0.1.x 为审计批次号）

### 文档与开源化

- **README 重写**：新增「给 AI 助手的 60 秒速览」（定位/仓库地图/最小跑通路径/适用与不适用/事实源索引/修改纪律）；开发者快速开始修正（migrate 自动建双角色，从零实测验证）；测试数更正（168 vitest + 371 suite）；dsh 链接修正。
- **docs/SUITE.md**：371 条全场景用例清单入库（运行时导出）。
- **docs/DECISIONS.md**：D1–D14 历史 ADR 回收（有出处者登记，无出处如实标注）。

### 门禁验证

- ✅ suite 371/371 · base 152/152 · runtime 12/12 · shared 4/4 · typecheck 全绿 · verify-chain 100/100 · 干净库全流程

## [0.1.7] - 2026-08-21 · 用例集扩充批次（审计第 6 轮）

### 安全修复

- **#41 审批手势类型白名单（P1）**：非法手势（bogus）此前穿透校验被静默当作「驳回」写库（绕过 L5.2 原因必填）。validateGesture 入口白名单，非法类型抛 INVALID_GESTURE。

### 测试基建

- **suite 326→371 用例**：新增 O 店长日常场景（16）/ P 系统层（14）/ Q 异常压测（15）三域；suite 命令加 TOOL_UNVERIFIED_RATE=0 确定性执行。

### 门禁验证

- ✅ suite 371/371 ×2 连跑 · base 152/152 · runtime 12/12 · typecheck 全绿

## [0.1.6] - 2026-08-21 · CI 门禁 + 决策记录批次（审计第 5 轮）

### 基建

- **CI 质量门禁**（.github/workflows/ci.yml）：push/PR to main 触发——PG17+pgvector service、迁移种子幂等双跑、verify-chain、typecheck、三包测试（DB 集成全开）、suite 326 用例、web build、dsh-gate E6。GitHub 实测 success。
- **docs/DECISIONS.md 补建**：ADR 从此入库；D13 登记事件编号锁与哈希链粒度决策（tenant 锁 + workspace 链为有意设计，附三方案否决论证）。

### 修复

- **#40** uninstallSkill 撤销清单读安装时快照（与 #17 口径对齐，作者改绑定后留痕不再失真）。

### 门禁验证

- ✅ CI ci-gate success ×3（GitHub 实测）· base 152/152 · runtime 12/12 · suite 326/326 · typecheck 全绿

## [0.1.5] - 2026-08-21 · 全场景测试套件批次（审计第 4 轮）

### 测试基建

- **`pnpm suite` 全场景套件**（scripts/suite.ts）：14 域 326 条场景用例逐条执行——三模式意图路由/网关瀑布/围栏判定/事件检索/审批流/IM 通道/夜班/技能/记忆/巡检/模型路由/desktop 高危与多模态/注入边界/并发压测 + HTTP E2E 权限矩阵（spawn 真实 server）。用例前缀隔离、可重跑、失败汇总报告。

### 套件暴露修复

- **#36** 检索时间白名单补 `+`（东八区 ISO 格式此前被误拒）。
- **#37** 意图路由疑问词增强（句中/句尾疑问词 + 动作词优先——「房价是多少」不再误判 quest）。
- **#38** 巡检派单事件挂 sessionId=threadId（P2 线程事件流完整）。
- **#39** recall NL 用例时间窗解耦（跨天运行假红消除）。

### 门禁验证

- ✅ suite 326/326（复跑稳定）· base 152/152 · runtime 12/12 · shared 4/4 · typecheck 全绿 · web build 绿 · verify-chain 100/100

## [0.1.4] - 2026-08-20 · 深度对抗测试批次（审计第 3 轮）

### 安全修复

- **#32 种子哈希链与生产口径不一致（P1）**：seed 用 JSON.stringify 键序算哈希 vs 生产 canonicalJson——种子 100 条用生产口径重算全部不符（同链两种算法混杂）。seed 统一导入 eventHash（zod parse 后对象），新增 `pnpm db:verify-chain` 全库链验证工具。
- **#33 写操作统一角色守卫（P1）**：readonly 实测可派遣 Quest 等 14 个写操作无服务端校验（前端隐藏未配服务端强制）。新增 writeProcedure / capabilityWriteProcedure 统一接入。
- **#35 网关 actor/who 身份一致性**：分叉伪造归因留痕无机制兜底，段①新增一致性校验。

### 功能正确性修复

- **#34 Quest 挂起审批通过后可恢复执行（P1）**：此前审批通过线程永卡 pending_review（replay 死循环）。runQuest 加载已批准挂起步骤映射，批准即带 approvalRef 执行（basis 留痕「经审批 \<id\> 批准执行」），Quest 生命周期闭环。

### 门禁验证

- ✅ base 152/152 · runtime 12/12 · shared 4/4 · typecheck 全绿 · web build 绿 · E6 dsh-gate 全绿
- ✅ verify-chain 100/100 一致 · 权限实测 readonly 全 403 / manager 正常 · PII/DSL 对抗 20 项全过

## [0.1.3] - 2026-08-20 · dsh rc.8 升级 + 安全加固批次（审计第 2 轮）

### 变更

- **dsh 升级 0.1.0-rc.6 → 0.1.0-rc.8**：vendor/dsh 全量替换（integrity 与 registry 逐字符一致）；dsh-gate pin rc.8 + node-pty rebuild。rc.8 新能力：Codex / Claude Code 作为按需安装的 subagent Profile Bundle（web profile 已装 `@deepseek-ai/dsh-subagent-claude-code` / `@deepseek-ai/dsh-subagent-codex`）；SQLite 新存储格式不向下兼容（升级前备份 DSH_HOME 数据目录）。**升级策略变更（项目所有者 2026-08-20 决策）：官方任何新版本（含 rc/beta/alpha）即升，不再等稳定版。**

### 安全加固

- **#30 biz_events TRUNCATE 触发器**（0004 迁移）：行级触发器不拦 TRUNCATE，表 owner 此前可清空事件库；语句级触发器对全角色生效，清库只能 DROP+重迁移。
- **#31 fence_rules 全局基线写入收口**（0005 迁移）：app/gateway 角色禁写 `workspace_id='*'` 行（原 RLS WITH CHECK 放行，任何工作区上下文可污染全租户基线），仅 owner 可写。

### 门禁验证

- ✅ base 150/150 · runtime 11/11 · shared 4/4 · typecheck 全绿 · web build 绿 · E6 dsh-gate 全绿（rc.8）
- ✅ 安全门禁 7/7（新增 TRUNCATE 拒 / fence `*` 写拒）· 迁移 0001–0005 + seed 幂等复跑

## [0.1.2] - 2026-08-20 · 审计修复批次（首轮独立审计，详见 docs/AUDIT.md）

### 安全修复

- **#22 RLS 事务级上下文失效（P0）**：#2/#20 把 `set_config(...,false)` 改事务级 `true`，但 15 个文件 40+ 封装无显式事务，autocommit 下设置语句结束即失效 → RLS 恒 NULL → 登录/审批/夜班/巡检/技能/召回 fail-closed 全不可用（此前 DB 集成测试全部 skip 未暴露，实测 37/144 红）。统一改为 BEGIN→set_config→fn→COMMIT/ROLLBACK；decide() 重构消除事务嵌套；测试断言池直查统一事务封装（原断言恒 0 行假绿/假红）。
- **#23 team 技能跨工作区互覆盖（P1）**：skills 全局表无 RLS，teamSkillId 仅名称派生，同名技能 ON CONFLICT 互覆盖。ID 内嵌 workspaceId（`skill-t-<ws>-<slug>`）；listSkills 按 scope 隔离；installSkill 追加本工作区归属校验（他区按 NOT_SIGNED 拦截留痕）。

### 功能正确性修复

- **#24 技能围栏绑定运行时不生效（P1）**：resolveAgentFenceBindings 无消费点，装配只读 preset 声明。assemblePreset 同事务并入 skill_installs 安装时快照（安装即生效、卸载即收缩）。
- **#26 appendEvent 幂等丢弃返回错误 hash/seq**：#4 只修了 appendEventIdempotent，主路径同根残留；去重时同事务回读 DB 真实值。
- **#27 routeIntent 超时未取消 LLM 调用**：classify 签名无 signal，AbortController 只赢 race；signal 接线到分类器（#7 名不副实补正）。
- **#28 冲突审批 approval_id 同毫秒碰撞**：makeReadableId("AP", Date.now()%100000) 熵不足，改事件派生 apr-e-\<eventId\>（同 loop.ts 口径）。
- **#29 IM 入站并发重推双写（TOCTOU）**：查重与写事件非原子；新增 im_inbound_dedupe 幂等键表（0003 迁移）原子占位，事件写失败补偿删占位。
- **顺带**：withObjectLock 的 SET LOCAL statement_timeout 挪到 BEGIN 后（事务外无效果，锁等待无超时兜底）；dispatch 并发上限检查移入事务（原池直查 fail-open 恒 0 行）。

### 测试健壮性

- **#25 runtime 全流程测试 flaky（~27% 失败率）**：静态 import 使 TOOL_UNVERIFIED_RATE=0 设置被击穿（模块级常量提前定型）；loop.js 改动态 import。H-15 测试 hotel 资产路径改 import.meta.url 定位（原 cwd 敏感）+ finally 还原 industry（防污染残留）。
- security-audit 增 #22 回归用例（autocommit 反例 fail-closed + 池连接卫生）。

### 数据库迁移

- 新增 `packages/db/migrations/0003_im_inbound_dedupe.sql`：`im_inbound_dedupe` 幂等键表（PK(workspace_id,channel,channel_msg_id)，RLS 同口径）。

### 门禁验证

- ✅ typecheck 全绿（6 个项目）
- ✅ shared 4/4 · **base 148/148（含 54 个原 skip 的 DB 集成测试，×3 连跑）** · runtime 11/11（×5 连跑）
- ✅ 安全门禁 6/6（append-only 双保险 / 旁路直写防控 / RLS 隔离）· seed 幂等复跑
- ✅ server `/health` + `/trpc/system.health` 200（db:up）· web build 绿 · 端到端 loginAs→members/threads/approvals 实测通过

## [0.1.1] - 2026-08-20 · Bug 修复批次

### 安全修复

- **#9 提示词注入防护**：`routeIntent` 的 LLM 分类器 prompt 用 `<user_input>` 结构化分隔符隔离用户输入，声明分隔符内为数据非指令，防止用户输入劫持分类结果绕过审批路由（F3.2）。
- **#2/#20/N RLS 配置统一**：全部非测试代码的 `set_config('app.workspace_id', ..., false)` 改为 `true`（事务级），消除会话级 RLS 变量泄漏到连接池的跨租户数据泄漏风险（F7.1/L7.1）。
- **#17 技能 fence_bindings 安装时快照**：`skill_installs` 表新增 `fence_bindings_snapshot` 列，安装时快照绑定；运行时 `resolveAgentFenceBindings` 读快照而非 `skills.fence_bindings` 实时值，防止技能作者更新绑定绕过 E8.1 冲突检测。
- **#16 isSignedSource DB 约束**：`skills` 表新增 CHECK 约束 `skills_team_id_format`，强制 `level='team'` 的技能 ID 必须以 `skill-t-` 开头，与 `isSignedSource` 逻辑一致，DB 层防伪造签名。

### 数据一致性修复

- **#10 expireSweep 写事件**：过期审批状态变更现在经网关写 `approval.expired` 事件，不再只改表不写事件，符合铁律 1（一切写入必经网关，F5.7/E5.3）。
- **#11 runQuest 重放跳过被阻塞步骤**：`existingStepIds` 只收录真正执行完成（auto）的步骤，排除 block/review 事件（按 `basis` 前缀「熔断：」「越围栏挂起：」识别），避免重放时跳过从未执行的步骤（E3.3/H-5）。
- **#4 appendEventIdempotent 去重返回正确 hash**：去重时从 DB 取回已存在事件的真实 `hash`/`seq` 返回，避免调用方拿到错误 hash 断链（L1.4）。

### 功能正确性修复

- **#12 模型路由熔断不丢弃回答**：熔断时 `RouteResult` 新增 `budgetExceeded` 标志并仍返回 `text`，避免白烧 token（F6.5/L6.4）。
- **#13 resumeNight 区分夜班暂停与手动暂停**：`threads` 表新增 `paused_by` 列；`pauseAll` 标记 `paused_by='night-shift'`；`resumeNight` 只恢复该标记的线程，不覆盖用户手动暂停（F4.3/E4.2）。
- **#5 isWriteAction 与围栏规则同步**：网关新增 `registerWriteActions` 运行时注册接口，行业 Bundle 新增写类动作后可注册到网关，避免硬编码前缀未覆盖而放行未声明 fence_bindings 的 Agent 写动作（F2.10）。
- **#6 confirmNight 围栏快照严谨化**：围栏版本快照查询限定 `is_baseline=true` + `ORDER BY version DESC` 确定性排序，避免取到非基线规则或随机版本（F2.6）。
- **#19 currentWindow 支持非跨午夜窗口**：峰谷窗口判定支持跨午夜（`start > end`，如 22:00-08:00）和非跨午夜（`start < end`，如 09:00-17:00）两种配置（F6.3）。
- **#21 回执失败不传播**：`handleGestureCallback` 的 `driver.sendText` 失败时只记录日志，不让成功的审批操作「看起来失败」（F5.5）。
- **#18 P1 dispatchState 卡 typing**：`dispatch` 的 `finally` 块用 `text.trim()` 判断而非闭包旧值 `draft`，避免成功派遣后 DispatchBar 卡在 typing 态。

### 设计改进

- **#8 PII 银行卡加 Luhn 校验**：`BANKCARD` 规则新增 `verify` 二次校验，用 Luhn 算法过滤订单号/时间戳等非卡数字，避免误脱敏破坏业务语义（F1.10）。
- **#7 routeIntent 超时取消 LLM 调用**：超时后调用 `AbortController.abort()` 真正取消底层 LLM 请求，避免 token 浪费（F3.2）。
- **#14/#15 withObjectLock 改用阻塞锁 + 64位 key**：改用 `pg_advisory_xact_lock`（阻塞版，内核管理等待队列）+ md5 前 16 位转 bigint 的 64 位 hash key，避免轮询占用 gateway 连接 5 秒和 `hashtext` 32 位碰撞（E2.5）。

### 架构优化

- **K mock 工具随机返回 synced:false**：demo 工具通过 `TOOL_UNVERIFIED_RATE` 环境变量控制（默认 10%）随机返回 `synced:false`，让 E3.7 回执校验路径在开发阶段就被走到。
- **L 连接池扩容**：`app` 池 10→30，`gateway` 池 4→20，`owner` 池 2→5，避免并发请求耗尽连接。

### 数据库迁移

- 新增 `packages/db/migrations/0002_bugfix.sql`：
  - `threads` 表新增 `paused_by` 列 + 索引（#13）
  - `skill_installs` 表新增 `fence_bindings_snapshot` 列（#17）
  - `skills` 表新增 CHECK 约束 `skills_team_id_format`（#16）

### 门禁验证

- ✅ typecheck 全绿（13 个项目）
- ✅ shared 包测试 4/4 绿
- ✅ base 包测试 90 passed（54 skipped 为 DB 集成测试）
- ✅ runtime 包测试 5 passed（4 skipped 为 DB 集成测试）

### 未纳入本批次

- **#1/A 双池事务一致性（Outbox 方案）**：架构性大改造，影响面贯穿全栈，需单独评估，留待下个版本。
