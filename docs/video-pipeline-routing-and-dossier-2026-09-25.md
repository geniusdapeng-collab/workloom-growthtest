# 视频管线自动化分流 + 商品情报档案激活（T-2026-0925-0002）

**范围**：`WorkLoom-growth`（实验车道，ai-video 行业包）→ 定向同步 `workloom-growthtest` / `workloom-growthmatrix`
**基线**：`WorkLoom-growth@9cf18c4`（2026-09-25 云端 main）
**一句话结论**：营销片/叙事片的「自动分流 + 不确定就问」已落地；商品情报档案从「只产出任务书、无人回填」
变成「真检索 + 结构化回填 + 无源剔除 + G1 门 + Brief 摘要卡注入」的可用链路；跑批暴露的 **6 类真缺陷**
已修（含 AI 监制只看到 600 字摘录这个系统性误杀根因），仍有 3 项明确遗留（见 §6）。

---

## 1. 自动化分流（新增）

### 1.1 为什么要分流（改造前的事实）

| 事实 | 证据 |
|---|---|
| 所有视频目标被硬编码成营销片 | `apps/server/src/trpc/router.ts` 旧码 `isMarketing: true` |
| 营销片其实没跑情报 | 该路径**不传 metadata**；vendor 靠 `metadata.dataMining / metadata.brief.product` 数据驱动（`vendor/supermickey/hyperreality-system/index.js` L503）→ 两个条件都不成立，Layer -2 整层跳过 |
| `isMarketing` 不参与判定 | 只写进 `video_projects.kind`（`studio-worker.ts`），不到 vendor |

结论：改造前是「营销片 = 叙事片 + 一个营销标签」，而叙事片被贴上营销标签后还要多过 G1..G9 门。

### 1.2 判定口径（`packages/video-studio/src/pipeline-router.ts`）

优先级：**调用方显式指定 → 用户显式声明（走营销片/走叙事片）→ 规则打分 → metadata 商品锚点 → LLM 仲裁 → 澄清**

- 营销线索：营销片/带货/种草/开箱/测评/商品/品牌/转化/投放/电商平台/英雄照 等 7 组词表；
- 叙事线索：叙事片/剧情/人物/科普/动画/情绪/品牌形象/旅拍 等 7 组词表；
- 判「决定性」的门槛：最高分 ≥2 且领先 ≥1，否则视为摇摆；
- **摇摆 + 有商品锚点 → 营销片**（"要卖东西"本身是硬信号）；
- **仍然摇摆 → LLM 仲裁**（场景 `pipeline-route`，L1 档 + 规则兜底，4s 超时即降级）；
- **判不出 → `clarify`**，把选择交回用户（不建线程、不建项目、不花情报/渲染成本）；
- **判成营销片但缺商品名 → 也 `clarify`**（情报五站以商品为锚，缺锚点必问；不猜商品）。

生产接线：

- `threads.dispatch`：视频目标先分流；`clarify` 直接返回问题（含两条管线的成本差异说明），
  并落 `video.route.clarify` 事件；判定成功落 `video.route.standard` 事件（含 pipeline/via/confidence/product/signals）；
- `video.studio.start`：`route="auto"`（新增）走同一分流；补跑按项目既有 `kind` 走，缺商品锚点同样先问。

### 1.3 意图清理与需求口径（真机教训）

- `stripRoutingDirective`：把「走营销片：」这类**分流行指令**从创作意图里剔除——真机第一轮里它被原样
  喂给创意主题生成器，主题被解析成「走营销片」，质量检查 0/5 通过；
- `buildPipelineIntent`：把 `[需求口径] 时长：30秒；画幅：9:16；平台：douyin；目标：seeding` 显式写进意图，
  让生成器与 G2 监制看到同一套数字（真机第一轮：意图写 30s，生成器推导 45s → G2 以"时长自相矛盾 + 缺画幅"打回）。

---

## 2. 商品情报档案「激活」

### 2.1 激活链（数据驱动，不新增开关）

```
分流判定 marketing
  → applyRouteToMetadata()：写 metadata.dataMining（name/brand/category/model/price_band/卖点候选）+ brief.product/brand/category
  → studio-worker#dataMiningConfigFor()：装配 api 模式 + 真实检索执行器 + 按工作区隔离的档案根（<workDir>/dossiers/<ws>）
  → vendor Layer -2：JennyLoomEngine.plan() → executor(A1/A2/A3) → assemble() → 五站闸机 + 信封链
  → 确认单 → G1 门（内部门：AI 监制；HR_AUTO_GATES 可调）→ 通过则 metadata._dataDossier + Brief 自动回填
```

叙事路由：`applyRouteToMetadata` **显式清掉** `dataMining / brief.product`，情报层不会被误触发；
`studio-worker` 也不装配执行器。

### 2.2 真实检索执行器（`apps/server/src/video/data-mining-executor.ts`）

- 多引擎检索链：`baidu-m`（移动百度）/ `so360`（360）/ `bing`（RSS），逐引擎降级、限速（默认 1.2s/引擎）、
  命中人机校验页即**熔断冷却 15 分钟**（不重试、不轰击）；
- 磁盘缓存（`searchCacheFile`，默认 12h TTL）：同 query×引擎复用，跨站/重跑零请求；
- **预置通道**（`primeSearchCache` / `--prime-search`）：平台检索或人工回填的真实结果可作为等价来源注入，
  与线上结果同权（同样过 URL 白名单与相关性过滤）；
- **相关性过滤**：标题/摘要必须包含商品词，否则丢弃——Bing 对中文长尾商品词会退化成"只搜第一个词"，
  返回百科/品牌首页这类"有来源但没情报"的结果（实测已拦截）；
- **URL 白名单**：回填里出现的每个 URL 必须是本次真实检索命中过的，否则整条剔除（防模型编造"很像的官网链接"）；
- 回填失败策略：首次失败 → **半量命中重试 + token 上限翻倍** → 仍失败即**缺站**（不编造、不静默降级）。

### 2.3 引擎侧修复（`vendor/.../data-mining-engine/`）

| 缺陷 | 影响 | 修复 |
|---|---|---|
| A4 `refs.some(() => false)` 恒 false 桩 + `Math.max(refs.length, mentions)` | **把"提及次数"当独立来源数**，单源复读即升 `confirmed`，违背铁律二 | 改为查证据账本：官方级来源判定 + **host 去重**的独立来源计数；提及次数只进报告不作为定级依据 |
| 信封 `prev_checksum` 只写不验 | 「链式锁定/防跳站」只在文档里 | 新增 `verifyChain()`：逐环校验摘要、链连续性与阶段顺序；装订前先核链（链断**不落盘**）、装订后全长链终检 |
| `DossierStore` 默认根少一层 `..` | 运行期档案写进 `vendor/` 受管目录 | 默认根改为 `<repo>/data/dossiers`，宿主显式传工作区目录 |
| `save()` 非原子、索引损坏静默清空 | 中断/并发会丢档案或抹索引 | 临时文件 + rename 原子写；损坏索引改名留证后重建 |
| A3 只暴露 `discovery_queries` | 执行器统一读 `queries` → **竞品站永远缺站** | A3 同时给出 `queries` 别名；执行器两者都认（双保险） |
| A1/A2 检索词重复拼品牌 | 「米家 米家空气净化器 4 Lite」拉低召回 | 品名已含品牌则不再重复拼 |

---

## 3. 宿主侧修复（真机暴露）

| # | 现象（真机） | 根因 | 修复 |
|---|---|---|---|
| 1 | G2 以「时长自相矛盾 + 缺画幅」打回 | 生成器按类型推导时长（22/45s），确认单无画幅字段 | vendor `_applyBriefProfile()`：Brief 为权威源统一时长/画幅/平台并在确认单标注口径来源；`generateConfirmationSummary` 补画幅/平台/口径行 |
| 2 | 主题被解析成「走营销片」，质量 0/5 | 分流行指令进了创作意图 | `stripRoutingDirective` + `buildPipelineIntent` |
| 3 | 类型判成「旅游推广」（家电种草片） | ①营销 Brief/情报**没进**生成器；②`商业广告` 词表缺 种草/带货/开箱/测评/商品/电商 | `_buildThemeInput()`：Brief + theme_card（卖点/人群/差异化空位/吐槽/场景）进创意输入并声明类型要求；`商业广告` 词表补齐社媒营销语汇 |
| 4 | 创意主题 LLM 提取连续两轮「未找到 JSON」→ 规则兜底 | `temperature=1` 且未开 `response_format` | `_extractFieldsWithLLM`：`forceJson` + 低温度 + 失败按「只输出 JSON」重试一次 |
| 5 | 基调反复判成「史诗悲壮」，G2 以"基调与内容冲突"打回 | 生成器自由发挥 | 输入侧声明可选基调并禁用宏大/惊悚项；`_applyBriefProfile` 加**基调护栏**（按品类落 温暖治愈/冷酷精密/轻快明朗，标注覆盖原因） |
| 6 | G3 连续三轮「四类契约缺失」 | ①确认单**根本没有契约区**；②监制只看得到门内容**前 600 字摘录**（服务端把 `GATE:vendorType` 当路径传给评审，读文件失败 → 文档后半段等于不存在） | ①`_renderRequirementContract()` 输出角色/场景/道具/动作 + 受众/风险结论摘要（结构化资料优先、噪声过滤、角色从场景文本兜底）；②`writeGateArtifact()` 把门内容落盘成真实文件再送审（生产与审计工具同一口径） |
| 7 | 内部门打回即整条停线 | 门语义是"打回重跑"，宿主没有重跑循环 | `isProducerRejection()` + 宿主**有上限自动重跑**（`VM_PRODUCER_RETRY` 默认 1 次；审计工具 `--producer-retry`） |

---

## 4. 真机跑批与逐环节审计

**跑批工具**：`scripts/tools/data-pipeline-run.mts`（新增）——不提交任何渲染作业（`deferRender` 恒开），
产物目录与 `video.studio.start` 运行目录同形（`result.json` / `shots.json` / `meta.json` / `route.json` /
`gates.jsonl` / `events.jsonl`），可直接接 `pipeline-audit.mts`、`pipeline-agent-audit.mts`。

**跑批记录**（同一意图、同一商品，逐轮修复后重跑）：

| 轮次 | 到达环节 | 结果 | 抓出的问题 |
|---|---|---|---|
| M1 | 情报层（spec 后无档案）+ G2 | 停线 | A1 回填空、无档案证据 |
| M2 | 情报层（20 证据/2 图/2 竞品）→ G2 | 停线（38 分） | 类型=旅游推广、时长 22→30 被覆盖、契约区缺失 |
| M3 | 情报**复用**（37ms）→ G2(80) → G3 | 停线（32 分） | 契约区渲染出「场景：给米家」噪声 |
| M4 | G2(82) → G3 | 停线（32 分） | 契约噪声 + 监制仍判缺失 |
| M5 | G2 | 停线（62 分） | 基调「史诗悲壮」 |
| M6 | G2 → G3 | 停线（40 分） | 定位到**监制只看 600 字摘录**的根因 |
| M7 | G2 | 停线（58 分） | 监制看得见全文后开始判**内容质量**（锚点过载/场景锁定矛盾） |
| M8 | G2(通过) → G3 | 3 次尝试后停线（61 分） | 受众画像泛化（"通用/情感共鸣"）、角色表与场景矛盾（场景有妈妈/宝宝，角色表为空） |

**关键正面证据（M2/M3/M8）**：

- 情报档案真装订：`档案编号 4LIT-M3V1VP` / `商品图 2 张（英雄照 4LIT-HERO-001）` /
  `情报来源 20 条已登记证据` / `链=true` / `竞品 2 个`；
- Brief 回填生效：`📥 Brief 已由情报档案自动回填: competitor / productHero.heroImageId`；
- 复用生效：第二轮起 `✅ 商品情报档案已确认 (37ms) [复用]`；
- 门在真实工作：G2 从 38/62 分打回到 80/82 分放行，判词逐条可核（时长/画幅/基调/类型）。

**缺站/缺口（诚实记录）**：价格带未采集、评价样本 2 条（<10 门槛）、未提炼使用场景、竞品仅 2 个。
原因：公开检索通道当天被第三方反爬限流（Bing 中文长尾词退化、360/百度弹验证码、搜狗前端渲染），
本轮机检用「平台检索 + 直连垂直站」预置真实来源（苏宁自营商品页与商品图、ZOL 参数价格榜、B站实测视频），
仍不足以撑起 ≥10 条评价样本 —— 引擎按纪律记 gap，没有编数。

---

## 5. 测试与门禁

- `packages/video-studio`：`pipeline-router.test.ts`（21 例，含分流矩阵/澄清/意图清理/口径块）+ `data-mining-engine.test.ts`（5 例：A4 独立来源、信封链、落盘原子性、索引恢复）；
- `apps/server`：`data-mining-executor.test.ts`（8 例：URL 白名单/形状校验/缺站纪律/幻觉剔除）；
- 全量：`packages/video-studio` 19 文件 168 用例通过；`apps/server` 303 通过 / 122 跳过（真库用例需 Postgres）；
- 门禁脚本：`bundle-governance`（含资产摘要刷新）、`product:verify` 通过；
- 真机跑批：见 §4（本地 `deepseek-flash` + Seedream 定妆照配置就绪，但本轮均未走到定妆照环节）。

---

## 6. 未修复 / 遗留（明确列出）

1. ~~**公开检索通道不稳定**（生产风险）~~ → **已补 API 通道（T-2026-0925-0003）**：
   引擎链新增 `api` 通道并置于首位，配置 `TAVILY_API_KEY`（Tavily 协议）或
   `WL_SEARCH_API_URL` + `WL_SEARCH_API_KEY`（通用 JSON 网关，Bearer 鉴权；
   结果数组兼容 `results / items / data[] / data.items[]`，字段兼容 `snippet|content|description|summary`）
   即自动启用；未配置时静默跳过，仍走 HTML 三引擎链。
   限流（403/429）同样进入 15 分钟熔断冷却；失败仍按**缺站**处理（不编造）。
   生产建议：`TAVILY_API_KEY` 或自建网关 + `WL_SEARCH_PROVIDERS=api,so360,baidu-m,bing`。
2. **G3 受众画像泛化**：`AudienceProfiler` 在情报薄（无评价样本/无场景）时输出"通用/情感共鸣"套话，
   监制持续打回。建议：把情报 `insight_card.audience_profile` 作为该 Agent 的强上下文；情报薄时先补采再进 G3。
3. **AI 监制返工预算**：已实现"打回→自动重跑（默认 1 次）"，但重跑不携带监制意见（每次都是新生成）。
   建议后续把 `suggestions` 回灌到下一次生成（有界提示词注入），提高一次通过率。
4. **服务端门内容落盘体积**：门内容按 run 落盘到 `<workDir>/gates/<projectId>/`，暂无清理策略（TTL 清理属现有运维面）。
5. **`_convertDiscoveryToRequirementList` 不搬角色表**：本次在确认单侧做了兜底（从场景文本抽角色），
   根因仍在转换函数（未搬运 `audienceProfile`/`characters` 结构化字段），建议下一轮在转换层修。

---

## 7. 回滚

- 单提交回滚：`git revert <commit>`（分流与情报激活均在同一提交；`isMarketing` 旧字段与 `route="auto"` 默认值保持向后兼容）；
- 应急开关：
  - `VM_DATA_MINING=0` → 关闭情报层装配（回到无档案运行）；
  - `VM_DATA_MINING_MODE=spec` → 只出采集任务书（旧口径）；
  - `HR_AUTO_GATES=`（空）→ 内部门恢复人审；
  - `VM_PRODUCER_RETRY=0` → 打回即停（旧行为）；
  - `WL_SEARCH_PROVIDERS=...` / `--prime-search` → 切换检索通道。
