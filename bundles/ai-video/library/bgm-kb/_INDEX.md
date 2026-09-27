# 配乐知识库 · 总索引

> **用途**：本目录是「AI 视频后期 · 配乐工位」的行业 know-how 知识库，供数字员工 / Agent 检索调用，与 `skills/bgm-*` 五技能、`connectors/bgm-bridge`、`library/bgm-recipes`、`library/bgm-library*` 配套使用。
> **版本**：v1.0　**更新日期**：2026-09-27　**主题数**：8（另含 failure-cases/ 失败案例 6 个）
> **统一结构**：每个主题均为九章式——核心概念 → 分类速查 → 分场景实战 → 视频特有规则 → 常见误区 → **意图→参数映射表（核心调用区）** → 模板 → 决策树 → 关联知识。（SCORE-008 为案例库篇，第六章为案例速查表）
> **检索总则**：所有判据与阈值必须与 `bgm-recipes/recipes.json` 的 targets、`bgm-bridge` 的实现一致；知识库只解释"为什么"和"怎么判"，执行一律走 `bgmread.*` / `bgmwrite.*` 工具。允许的结论包含「这片子不需要配乐」。

## 一、电平与混音（SCORE-001 / 007）

| 编号 | 主题 | 一句话用途 | 触发检索的用户意图关键词 |
|---|---|---|---|
| SCORE-001 | 人声与音乐协同电平口径 | voice 让位与 bgm ducking 两次让位如何叠加 | 人声听不清、音乐太响、ducking、让位、电平、抽吸感、-14LUFS、余量 6dB |
| SCORE-007 | 混音复检六线 | 六项复检指标的判读与超标处置 | 复检、响度不达标、真峰值、可闻度、verify_failed、削波、回读 |

## 二、创意决策（SCORE-002 / 003 / 006）

| 编号 | 主题 | 一句话用途 | 触发检索的用户意图关键词 |
|---|---|---|---|
| SCORE-002 | 题材风格适配决策树 | 题材→风格→配器→BPM 完整决策路径 | 选曲、风格、题材、配器、BPM、调式、情绪、配方、brief |
| SCORE-003 | 卡点与音乐结构 | 剪辑点反推速度、结构选段与落拍对齐 | 卡点、对不上拍、BPM、高潮、选段、intro、drop、±80ms、落拍 |
| SCORE-006 | 允许不配乐 | 什么时候不配更好、不配时做什么 | 不配乐、留白、环境声、真实感、no_bgm、静音 |

## 三、交付与合规（SCORE-004 / 005）

| 编号 | 主题 | 一句话用途 | 触发检索的用户意图关键词 |
|---|---|---|---|
| SCORE-004 | 平台响度与交付差异 | 四大平台响度口径与变体派生纪律 | 平台、响度、LUFS、AAC、48k、变体、重混、外放、抖音、B站 |
| SCORE-005 | 音乐许可合规速查 | 许可白名单、TASL 署名与 AI 音乐陷阱 | 许可、版权、CC0、CC-BY、NC、署名、TASL、MusicGen、royalty-free |

## 四、事故档案（SCORE-008）

| 编号 | 主题 | 一句话用途 | 触发检索的用户意图关键词 |
|---|---|---|---|
| SCORE-008 | 常见事故案例库 | 配乐历史事故的速查与复盘入口 | 配错曲、风格违和、前段静音、许可风险、事故、错配 |

**失败案例清单**（`failure-cases/`）：

| 案例编号 | 一句话症状 | 状态 |
|---|---|---|
| FC-BGM-001 | 题材未命中 0 分不否决，运动曲错配江南口播 | 已修复（T-05：未命中 −30 / veto 出局 / 正反例词） |
| FC-BGM-002 | 峰值对齐致前段 25.7s 静音（preroll 旋转修复） | 已修复 |
| FC-BGM-003 | MusicGen 权重 CC-BY-NC 许可陷阱 | 已 fail-closed 拦截 |
| FC-BGM-004 | curated 兜底曲库逐首上游许可缺失 | 处置中（所有者声明登记，建议升级客户授权库） |
| FC-BGM-005 | 自算作曲兜底产出垃圾曲被禁用 | 已禁用（full-chain 改曲库音乐床兜底） |
| FC-BGM-006 | 可闻度测不到写成 null dB 假比较 | 已修复（presenceMeasured fail-closed） |

## 关联资产

- 配方库：`library/bgm-recipes/recipes.json`（16 条，T-15 扩至 30+）
- 曲库：`library/bgm-library-curated/`（50 首实测精选）、`library/bgm-library/`（客户库契约）
- 技能：`skills/bgm-score-design`、`bgm-audio-layering`、`bgm-vocal-separation`、`bgm-library-license`、`bgm-delivery-spec`
- 执行器：`connectors/bgm-bridge`（工具 `bgmread.*` / `bgmwrite.*`）
- 姊妹库：`library/color-kb/`（调色）、`library/cinematography-kb/`（前期镜头语言）
