# Growth 能力审计 · 缺口台账（活台账）

> **唯一事实源**：本文件记录「视频管线与数字员工能力审计」的缺口、处置与证据；随修复更新，不回改历史。
> **口径**：严重度 P0（阻断/红线）> P1（影响质量或成本）> P2（卫生/债务）；状态 `OPEN` / `IN_PROGRESS` / `FIXED` / `WONTFIX` / `PROPOSAL`。
> **边界**：只优化业务逻辑与行业 Know-How，不改输入输出与字段数据结构（对象字段、五元事件、管线拓扑、围栏级别、DB、API）。
> **基线**：`WorkLoom-growth@f2ac5dec`（2026-09-26）。机检清单见《Growth 审计范围基线 v1.0》。

| ID | 批次 | 单元 | 类型 | 严重度 | 现象 | 根因（文件:行/函数） | 处置 | 回归用例 | 状态 | 证据等级 |
|---|---|---|---|---|---|---|---|---|---|---|
| GAP-0001 | B2 | 营销片 `truth-check` | T1 纸门 | P0 | 事实红线闸在管线里声明「ProductTruthChecker 一票否决」，但全仓机检无任何 require/调用点 | `vendor/.../agents/product-truth-checker.js:117`（仅自引用） | **FIXED（T-2026-0926-0103）**：新增纯函数桥 `engines/truth-check-bridge.js`（档案→带信源 researchNotes→verify）+ 引擎方法 `HyperrealitySystem._runProductTruthCheckGate()`，在**创意主题确认之后、需求洞察之前**执行；命中冲突即 `blocking` 打回创意并落 fatal 错误；`factRedLines` 写回 `metadata._factRedLines` 并注入 PRD「制作约束」；无证据时 `degraded=no-evidence` 显式落账不误阻断 | `packages/base/bundles/truth-check-bridge.test.ts`（6 项）+ `scripts/tools/verify-truth-check-gate.mts`（真实类实例 3/3） | FIXED | A（接线精读）+ A（类级真实运行） |
| GAP-0002 | B3 | 投流素材工厂 | T1 纸门 | P1 | `hook-performance-store.js` 零引用，钩子表现回填无实现 | `vendor/.../agents/hook-performance-store.js` | 登记；评估接线或降级声明 | — | OPEN | B |
| GAP-0003 | B2 | 营销片时长约束 | T1 纸门 | P1 | `marketing-duration-bridge.js` 零引用，营销片时长约束是否落到共享段未经证明 | `vendor/.../agents/marketing-duration-bridge.js` | 与 GAP-0001 同批核验；无消费方则降级声明 | — | OPEN | B |
| GAP-0004 | B1 | 多风格交付 | T1 纸门 | P1 | `platform-variant-fanner.js` 零引用，平台变体是否由别的实现承担未证明 | `vendor/.../agents/platform-variant-fanner.js` | 核验 `deliver.ts` 是否覆盖其职责；否则登记 | — | OPEN | B |
| GAP-0005 | B1/B2 | 全部门（G1–G9/G-MAT1/G-DLV） | T7 孤儿产出 | P1 | 门事件按 step_key 落 `stages.jsonl`，但平台侧执行器未读该账本（CLI 侧已读） | `apps/server/src/video/studio-worker.ts`（走 `onApproval`）；`packages/video-studio/src/gate-ledger.ts#readGateEvents` 仅测试与 CLI 使用 | 设计只读消费点（审计视图/前置校验），不改契约 | — | OPEN | B + 现状文档 |
| GAP-0006 | B1–B5 | 91 个包内技能 | T9 资产深度 | P1 | 绝大多数技能只有「适用场景/方法/输出契约」，缺决策原则/阈值来源/失败模式 | `bundles/*/skills/*/SKILL.md` | 按 S-A/S-B/S-C 分型逐批补强；新增只读审计器量化 | `packages/base/bundles/agent-knowhow.test.ts` | IN_PROGRESS | B（结构机检） |
| GAP-0007 | B2 | 营销前置两站（`jenny-loom-research` / `marketing-brief-parser`） | T9 资产深度 | P1 | 两技能各 21 行，只有流程摘要：无决策原则、无阈值来源、无失败模式，真机遇偏倚样本/冲突价格/缺要素时只能靠模型自由发挥 | `bundles/ai-video/skills/jenny-loom-research/SKILL.md`、`.../marketing-brief-parser/SKILL.md` | **FIXED（T-2026-0926-0101）**：补齐决策原则（无源不入库/置信度三级/域名去重/冲突不仲裁/卖点 ≤3/用户共识优先）、四种场景打法、五步 SOP（触发/回执/失败）、指标护栏表（含来源）与失败模式表 | `agent-knowhow.test.ts`（24 项全绿）；`scripts/tools/agent-knowhow-audit.mts` | FIXED | A（精读+回归） |
| GAP-0008 | B1/B2 | 事实红线评审（`director-review`） | T9 资产深度 | P1 | 21 行摘要未写清硬阻断优先级、五维不过线判定、事实红线以 confirmed 字段为准、评审输入必须含正文（真机曾因只送路径被打回 58 分） | `bundles/ai-video/skills/director-review/SKILL.md` | **FIXED（T-2026-0926-0101）**：补齐 7 条决策原则、四种评审形态打法、五步 SOP、6 项指标与 6 条失败模式（含"无正文可核验""朝向误判""平均分掩盖短板"） | 同 GAP-0007 | FIXED | A |
| GAP-0009 | B2 | 视频域考题覆盖 | T2 无证据 | P1 | `bundles/ai-video` 无 `eval/`，27 名环节员工零考题覆盖（仅 geo-growth 有 30 题） | `bundles/ai-video/` 缺 `eval/questions.json` | 按 `eval-core` schema 建最小题集（不改表结构） | — | OPEN | B |
| GAP-0010 | B5 | hotel 技能资产 | T7 孤儿 | P2 | 10 个技能无任何 preset 绑定（`ai-live-assistant`/`content-marketing`/`fast-scan`/`inspection-suite`/`ota-operations`/`overbooking-parity-guard`/`pricing-matrix`/`review-asset-mining`/`safety-compliance`/`staff-scheduler`） | `bundles/hotel/presets/*.yml` 的 `skills` 字段 | 裁定：补绑定（走提案）或登记为可装配能力 | — | OPEN | B |
| GAP-0011 | B1–B3 | vendor 阶段兜底 | T5 静默降级 | P0/P1 | 既有审计器可扫出 `FIELD_GUARD` 默认模板覆盖、子 Agent 全失败退规则兜底等"看起来成功"的路径；尚未逐条裁定 | `scripts/tools/pipeline-agent-audit.mts` 输出；`vendor/.../field-guard.js` 等 | 逐条判定是否已显式记 `degraded`，未记的按 P0 处置 | — | OPEN | B（待 A 级确认） |
| GAP-0012 | B1 | 提示词工艺（`shot-prompt-craft`） | T9 资产深度 | P1 | 29 行摘要只有方法叙述，没有 25/30 字段判据表、字符口径边界与失败模式；真机曾因占位符/缺号/字数不足反复打回 | `bundles/ai-video/skills/shot-prompt-craft/SKILL.md` | **FIXED（T-2026-0926-0102）**：补 11 行工艺判据表（含来源）、5 条参数边界、8 条失败模式 | `agent-knowhow.test.ts`（39 项全绿） | FIXED | A |
| GAP-0013 | B1 | 定妆照纪律（`portrait-studio`） | T9 资产深度 | P1 | 28 行摘要只写了背景干净度结论，没写 clean-background/v1 阈值、角度档位判据与失败处置 | `bundles/ai-video/skills/portrait-studio/SKILL.md` | **FIXED（T-2026-0926-0102）**：补 8 行工艺判据表（含阈值与来源）、5 条参数边界、6 条失败模式 | 同 GAP-0012 | FIXED | A |
| GAP-0014 | B2 | 发布纪律（`publish-ops`） | T9 资产深度 | P1 | 22 行摘要只写"按平台蓝图过检"，六个平台的文案/话题/定时规格与失败处置不在技能内 | `bundles/ai-video/skills/publish-ops/SKILL.md` | **FIXED（T-2026-0926-0102）**：补六平台规格表（来源：`publish-rpa/adapters/*.ts`）、5 条前置校验、7 条失败诊断、3 条证据口径 | 同 GAP-0012 | FIXED | A |
| GAP-0015 | B2 | 营销片真机全链 | T2 无证据 | P1 | 事实红线闸的接线已在类级与单测级验证，但**尚未**在真实检索通道 + 真实模型下跑完整营销片链路（需要 `TAVILY_API_KEY`/`WL_SEARCH_API_URL` 或 HTML 检索通道可用 + LLM key），因此"真实档案 → 真实冲突命中"尚无真机证据 | `apps/server/src/video/data-mining-executor.ts`（需真实检索）；本机无 key | 待真机轮：用真实商品跑一次营销片（情报五站 → truth-check → PRD），核验 `stages.truthCheck` 与 PRD 制作约束 | — | OPEN | D（未验证，已声明） |
| GAP-0016 | B1/B2 | 后期链四工位 | T9 资产深度 | P1 | 调色选型/配乐定调/字幕版式/音色档案四个技能「判据齐、失败模式缺」：真机翻车（风格跳变、配乐盖人声、字幕压 UI、换引擎变声）没有可判定的检测器与处置 | `bundles/ai-video/skills/{color-look-design,bgm-score-design,subtitle-layout-design,voice-profile-craft}/SKILL.md` | **FIXED（T-2026-0926-0104）**：各补 6–8 行失败模式表（症状 → 检测器 → 处置），判据全部取自该技能既有阈值与围栏（G-COL/G-BGM/G-SUB/G-VOICE） | `agent-knowhow.test.ts`（59 项，覆盖 12 个技能） | FIXED | A |
| GAP-0017 | B1 | 审计器口径 | T2 工具口径 | P2 | 首版 `agent-knowhow-audit.mts` 只认固定章节名，把本仓「一、二、三」编号标题与「目标值表/禁忌/常见翻车」等写法误判为缺失 | `scripts/tools/agent-knowhow-audit.mts` | **FIXED（T-2026-0926-0104）**：改为语义区块 + 全文量化阈值行 + 红线表述的混合口径（结构等价判定），并同步回归测试；视频域达标率由 7/32 修正为 15/32（真实值） | 同 GAP-0016 | FIXED | A/B |
| GAP-0018 | B1/B2 | S-C 工具/纪律型四技能 | T9 资产深度 | P1 | 渲染提交（G8）、评论外发（G10）、监制门（G1–G7）、字幕烧录四个纪律型技能缺「前置校验 / 失败诊断 / 证据口径」：提交被拒、误分流、无正文可核验、字体回落系统字体这些真机翻车没有判定与处置 | `bundles/ai-video/skills/{render-ops,comment-ops,producer-gate-review,caption-burnin-ops}/SKILL.md` | **FIXED（T-2026-0926-0107）**：前置校验 3–5 条、失败诊断表 6–7 行（含检测器与处置）、证据口径 3–4 条；判据取自 G8 严格模式/`duration_provenance`、G10 分流与关键词必审、监制门正文预算与 fail-closed、libass fontselect 回落判失败 | `agent-knowhow.test.ts`（S-C 7/7）、504 项回归 | FIXED | A |
| GAP-0019 | B1 | 交付/返修技能口径 | T2 工具口径 | P2 | `delivery-package-ops` / `delivery-revision-ops` 内容完整（不达标处置、不可修复情形、返修回执俱全），但章节名为「不达标怎么办 / 不可修复情形 / 返修回执」，被首版审计器误判为缺失 | `scripts/tools/agent-knowhow-audit.mts` | **FIXED（T-2026-0926-0107）**：S-C 判定加入「不达标/回退/不可修复/处置」等价域与「红线/必须」前置校验口径；两技能判定为达标（未改内容） | 同 GAP-0018 | FIXED | A/B |

## 变更记录

| 日期 | 批次 | 变更 |
|---|---|---|
| 2026-09-26 | T-2026-0926-0101 | 建账（GAP-0001…0011）；完成 GAP-0007/0008 两项 Know-How 强化并锁回归；新增只读审计器 `scripts/tools/agent-knowhow-audit.mts` |
| 2026-09-26 | T-2026-0926-0102 | 完成 GAP-0012/0013/0014（提示词工艺 / 定妆照纪律 / 发布纪律）Know-How 强化；回归扩到 S-A/S-B/S-C 三型（39 项） |
| 2026-09-26 | T-2026-0926-0103 | 完成 GAP-0001：营销片事实红线闸接线（桥 + 引擎方法 + PRD 红线继承 + 类级验证 3/3）；新登记 GAP-0015（真机全链待验） |
| 2026-09-26 | T-2026-0926-0104 | 完成 GAP-0016（后期链四工位失败模式）与 GAP-0017（审计器结构等价口径）；视频域 Know-How 达标 15/32，回归 214 项全绿 |
| 2026-09-27 | T-2026-0926-0107 | 完成 GAP-0018/0019：S-C 纪律型四技能强化 + 审计器等价域补全；视频域 Know-How 达标 **21/32**（S-A 3/3、S-B 11/22、S-C 7/7），回归 504 项全绿 |
