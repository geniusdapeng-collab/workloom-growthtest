# 知识注入不变量清单（验收单 · v1.0 · 2026-09-25 · T-2026-0925-KBAUDIT）

> 用途：把第四轮审计的 12 个维度写成**可当验收单用**的不变量。每次改注入规则 / KB / 关键帧提示词组装，
> 照本表逐条跑；任何一条"否"，先定位到具体镜头与具体字段，再决定改哪边。
> 可执行入口：`work/kb-matrix.mjs`（场景矩阵）、`work/kb-invariants.mjs`（A7–A12）、
> `./node_modules/.bin/vitest run bundles/ai-video/connectors/cine-kb-bridge packages/video-studio/src/plate-prompt.test.ts`。

## 分层与责任

| 层 | 代码位置 | 不变量编号 |
|---|---|---|
| 解析层 | `core.mjs` `parseTopic` / `parseApertureKnowledge` | A1(入池)、A10(可回源) |
| 决策层 | `core.mjs` `injectionContext` / `INJECTION_RULES` / `recommendAperture` | A1、A2、A3、A5、A6 |
| 落地层 | `core.mjs` `enrichShotCard` / `plate-prompt.ts` / `shot-spec.ts` | A4、A7、A8、A9 |
| 评审链 | `producer-gate.ts` `PRODUCER_RUBRICS` | A12 |
| 复跑 | 全链 | A11 |

## 不变量（逐条给判据与检查方式）

### A1 触发召回 —— 该有的知识行必须在

- **判据**：场景 → 期望命中的行（36 场景标答表）逐条一致；KB 里"点名的行"不得没有任何规则引用。
- **检查**：`audit-round4.test.ts` 的 36 场景标答 + `node work/kb-matrix.mjs`。
- **反例哨兵**：`落 f/5.6 打卡档的场景数 ≤ 4`（且必须都是已登记 KB 缺档）。
- **本轮教训**：LIGHT-003 的「车轨长曝 / 舞台追光 / 烟花夜空」、PHYS-002 的「玻璃反射」四行虽在 KB 里，
  但没有任何 `INJECTION_RULES` 引用 → 场景零注入。**新增 KB 行时必须同时问"谁引用它"。**

### A2 触发精度 —— 不该有的知识不许进

- **判据**：反例集（N1–N12）不得出现禁词：水下 / 冰面 / 白背景产品不得有"镜面倒影"；
  白天灯笼不得有"夜景 / 霓虹 / 烛火"；糖粥不得有"咖啡"；体育不得有"车轨 / 光轨"。
- **检查**：`audit-round4.test.ts` 的 N1–N12。

### A3 措辞归属 —— 这条行说的就是这个意思

- **判据**：行文本与场景名词一一对应；**禁止把"真机翻车词"写进提示词**（当前黑名单：主体悬浮感 / 主体漂浮感 / 漂浮感）。
- **检查**：`sanitizeApertureEffect()` 单测 + 夜景人像回归。
- **本轮教训**：OPTICS-001 §三「夜景人像 f/1.4–f/1.8」与 §二 档位表零重叠 → 落回 f/1.2–f/1.4 档，
  带出"主体悬浮感"。**跨档区间与档位表擦边时，务必检查兜底取到的是哪一档。**

### A4 字段落点 —— 落对字段，且真的进得了提示词

- **判据**（三层齐备才算命中）：
  1. 材质 → `costume`、道具 → `props`、光位 → `lighting`、档位 → `depth_of_field`；
  2. 该字段的值必须出现在**视频提示词**（`prepareShotPrompt`）；
  3. 影响画面的字段（`lighting / composition / color_palette / props / depth_of_field / makeup / action / scene / sceneDescription`）
     必须出现在**关键帧提示词**（`buildPlatePrompt`）。
- **检查**：`plate-prompt.test.ts` 的"景深与道具必须进关键帧"三条 + `work/kb-invariants.mjs`。
- **本轮教训**：`depth_of_field` 与 `props` 此前只到视频提示词，关键帧提示词里根本没有 ——
  而关键帧是图生视频的首帧，**首帧没有的东西后面不会长出来**。这是最贵的一类"注入失效"。

### A5 否词处理 —— 否定不得产生正向信号，限定否定不得吞中心词

- **判据**：`无光污染的星空银河` 仍判星空；`不横移不环绕` 不注入摇摄；`其他摊位` 不算人物；`避免日落` 不算黄金时刻。
- **检查**：`audit-round3.test.ts` + `audit-round4.test.ts` 的 N5/N6/N7/N12。

### A6 时段一致性 —— 同一卡内不得出现两个冲突时段词

- **判据**：注入短语与卡片时段一致：正午不得配"蓝调天光 / 午后阳光"；阴天不得配"午后斜光"；日景不得配夜景配方。
- **检查**：`audit-round4.test.ts` 的"显式光源优先于室内兜底"四条。
- **本轮教训**：室内兜底规则（钨丝灯 / 混合色温）排在窗光 / 正午 / 阴天之前，
  靠"每字段一条"的先到先得把卡片明写的光源压掉。**兜底规则必须有显式排除条件。**

### A7 模板完整性 —— 下发的不是模板原文

- **判据**：注入短语与提示词正文不得出现 `NaN` / `undefined` / `[object Object]` / `[占位符]`。
- **检查**：`audit-round4.test.ts` 的场景断言 + `work/kb-invariants.mjs`（真机 6 镜）。
- **遗留**：自由检索路径（`selectEntries` / `search` / `trace.explored`）仍会吐 `[主体] [动作]` 这类模板占位符（G15）。

### A8 语言口径 —— 与卡片【语言约束】一致

- **判据**：默认注入短语全中文；英文关键词只进 trace（`englishGloss: true` 才附英文）。
- **检查**：`audit-round4.test.ts` 的场景断言（拉丁词扫描，白名单 HDR/ISO/Vlog/LED/FPV/BGM/MP4）+
  `work/kb-invariants.mjs` A8（真机 6 镜全中文）。

### A9 长度与去重 —— 不撑爆、不重复

- **判据**：字段级一条；全局 ≤5 条；单字段 ≤320 字；同主题 ≤2 条；同一行不落多字段。
- **检查**：`work/kb-invariants.mjs` A9（真机 6 镜：字段重复 0 / 超长 0 / 同主题超限 0 / 注入 5 条）。

### A10 可溯源 —— 每条注入都能回到 KB 原文

- **判据**：`trace.picks` 的 `intent` 必须与该篇 `entries` 里的条目标签一致；
  `zh` 必须能在 KB 原文（去加粗记号后）逐字找到；`matchedBy` 要能区分兜底路径
  （`scene-table` / `decision-tree` / `special-intent` / `subject-fallback` / `person-fallback` / `fallback-default`）。
- **检查**：`work/kb-invariants.mjs` A10 + `audit-round4.test.ts` 的 `matchedBy` 断言。

### A11 幂等与可复跑 —— 同输入同输出

- **判据**：同卡片两次 `enrichShotCard`，除 `trace.at` 时间戳外逐字节一致。
- **检查**：`work/kb-invariants.mjs` A11。

### A12 与评审链一致 —— 提示词侧与评审侧的类目对齐

- **判据**：提示词里写死的每一条约束，评审侧都有同名类目；反之亦然。当前 8 个类目：
  结构完整性 / 透视一致 / 光影一致 / 人物与定妆照同一张脸 / 桥类硬约束 / 道具与镜头卡一致 / 景深档位 / 纯写实影像。
- **检查**：`work/kb-invariants.mjs` 的 A12 对照表（读 `plate-prompt.ts` 常量 vs `producer-gate.ts` 的 keyframe rubric）——
  **注意这是文本级机检（B 级）**，类目语义是否等价仍需人判一次。
- **本轮教训**：把景深裁决写进提示词后，评审侧没有对应类目 → 等于新增了一条无人监督的约束；
  已在 `PRODUCER_RUBRICS.keyframe` 补一条。

### A13 字段预算与回执一致 —— 记了"注入"就必须真写进去（第五轮新增）

- **判据**：注入正文**不得**因为字段超预算而被截断/丢弃却仍记在 `trace.applied` 里；
  卡片作者原文不得被注入层改写（截断）。
  记法约定：`writtenChars` = 实际写入字数；放不下时 `dropped:"field-over-budget"` + `originalChars`。
- **检查**：`audit-round5.test.ts` › "字段预算（不许静默吃注入，也不许改作者原文）"两条。
- **本轮教训**：旧实现把截断施加在"原文 + 注入"的合并串上，`camera_movement` 原文 342 字时注入整段消失，
  而 trace 照样写着 `added:"手持镜头…"`。**审计看到的注入条数必须等于实际写进提示词的条数。**

### A14 天气时序与动作一致性 —— 注入不得断言卡片没有的状态（第五轮新增）

- **判据**：① 正在下 vs 已经停：`rainNow` / `snowNow` 未命中时，不得注入"雨丝/雪花飘落"类动态天气；
  ② 动作断言：注入短语里出现的动作（行走/回头/环绕…）必须在卡片里成立（`lookBack` 必须 `&& walking`）。
- **检查**：`audit-round5.test.ts` 的"天气时序"四条 + "回头类动作必须真在走动"。
- **本轮教训**："雨后的古镇石板路"被注入"细密雨丝如雾般飘落"、"雪后"被注入"雪花缓缓飘落"、
  静止回眸被注入"行走中回头"——三者都是**注入断言了不存在的状态**，与 playbook §一 事故 2/5 同类。

### A15 规则可达性与引用完整性 —— 不许有静默失效（第五轮新增）

- **判据**：① 每条 `INJECTION_RULES` 引用的 `(topic, row)` 都必须能在 KB 里解析到；
  ② 不得存在**条件自相矛盾**因而永不命中的规则；③ 光圈意图加词的 `prefer` 标签必须能匹配到真实场景行；
  ④ 确定性规则引用到的唯一 KB 行数不得低于下限（当前 48，下限 45）。
- **检查**：`audit-round5.test.ts` › "规则卫生（防止再次静默失效）"四条。
- **本轮教训**：`pickRow()` 失败是静默 `continue`，KB 改行名就会悄悄少注入；
  七条 `framing` 规则因 `when` 要求"已知景别"、守卫要求"未知景别"而**从未生效过**。

### A16 否定语境不得进入任何打分路径（第五轮新增）

- **判据**：条目打分、风格冲突白名单、情绪派发文本三处都必须用剥离否定后的文本。
- **检查**：`audit-round5.test.ts` › "否定语境不得参与条目打分"（含肯定表述对照组）。
- **本轮教训**：上下文侧剥了否定，打分侧没剥 → 卡里写"避免赛博朋克全息广告"，
  赛博条目反而以 10.8 分进候选池。

## 变更时的最小验收流程

1. 改注入规则 → 跑 `audit-round4.test.ts`（36 场景 + 12 反例 + 解析层断言）；
2. 改 KB 解析 → 跑 `work/kb-parse-coverage.mjs`，确认"原文行 → 解析"总账仍对得上；
3. 改提示词组装（plate / shot-spec）→ 跑 `plate-prompt.test.ts` + `work/kb-invariants.mjs`（真机 6 镜）；
4. 改评审 rubric → 跑 `work/kb-invariants.mjs` 的 A12 对照；
5. 任何一步新增/关闭缺口 → 回写 `docs/kb-injection-audit-playbook.md` §七 台账。
