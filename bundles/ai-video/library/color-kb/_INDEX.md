# 调色知识库 · 总索引

> **用途**：本目录是「AI 视频后期 · 调色工位」的行业 know-how 知识库，供数字员工 / Agent 检索调用，与 `skills/color-*` 四技能、`connectors/color-bridge`、`library/color-recipes`、`library/luts` 配套使用。
> **版本**：v1.0　**更新日期**：2026-09-27　**主题数**：8（另含 failure-cases/ 失败案例 6 个）
> **统一结构**：每个主题均为九章式——核心概念 → 分类速查 → 分场景实战 → 视频特有规则 → 常见误区 → **意图→参数映射表（核心调用区）** → 模板 → 决策树 → 关联知识。（CGRADE-008 为案例库篇，第六章为案例速查表）
> **检索总则**：所有判据与阈值必须与 `color-recipes/recipes.json` 的 targets、`color-bridge/core.mjs` 的实现一致；知识库只解释"为什么"和"怎么判"，执行一律走 `colorread.*` / `colorwrite.*` 工具。

## 一、色彩科学与取证（CGRADE-001 / 002 / 006）

| 编号 | 主题 | 一句话用途 | 触发检索的用户意图关键词 |
|---|---|---|---|
| CGRADE-001 | 肤色科学与区域取证 | 肤色判据为什么优先、怎么取样实测 | 肤色偏黄、肤色蜡黄、人脸发灰、skinPatch、肤色线、hue 20-40 |
| CGRADE-002 | 色彩空间与色域转换 | log/HLG 素材进 Rec.709 的正确路径 | S-Log3、HLG、log 还原、发灰、色域、LUT、bt709、slog3-to-rec709 |
| CGRADE-006 | 白平衡与灰世界边界 | 自动白平衡何时可信、何时必须人工接管 | 白平衡、色偏、偏蓝、偏黄、灰世界、neutralPatch、色温 |

## 二、美学与平台（CGRADE-003 / 004）

| 编号 | 主题 | 一句话用途 | 触发检索的用户意图关键词 |
|---|---|---|---|
| CGRADE-003 | 平台画质特性 | 四大平台二压特性与调色预补偿 | 抖音、小红书、视频号、B站、压缩、变体、平台适配、发虚 |
| CGRADE-004 | 题材调色美学 | 13+ 配方的美学依据与新题材设计 | 配方、题材、影调、情绪、profile、intensity、青橙、胶片感 |

## 三、判读与匹配（CGRADE-005 / 007）

| 编号 | 主题 | 一句话用途 | 触发检索的用户意图关键词 |
|---|---|---|---|
| CGRADE-005 | 示波器与数值判读 | signalstats 六指标与 scope 三图怎么读 | waveform、vectorscope、YAVG、SATAVG、裁切、死黑、过曝、rmsContrast |
| CGRADE-007 | 镜间匹配方法论 | 多镜头批次怎么调到一个观感 | 镜间匹配、跳变、参考镜、ΔYAVG、批次、接戏、多机位 |

## 四、事故档案（CGRADE-008）

| 编号 | 主题 | 一句话用途 | 触发检索的用户意图关键词 |
|---|---|---|---|
| CGRADE-008 | 常见事故案例库 | 调色历史事故的速查与复盘入口 | 调了没效果、强度失效、白平衡误判、log 饱和异常、画质劣化、事故 |

**失败案例清单**（`failure-cases/`）：

| 案例编号 | 一句话症状 | 状态 |
|---|---|---|
| FC-COL-001 | blend 权重方向错误致 look 强度失效 | 已修复 |
| FC-COL-002 | 灰世界白平衡在大面积单色场景误判 | 处置中（已降级 low confidence，引导提供 neutralPatch） |
| FC-COL-003 | 早期 1–2 帧抽样对多切点素材代表性不足 | 已修复（T-02：场景切分自适应抽样，按时长加权） |
| FC-COL-004 | S-Gamut3.Cine 色域矩阵缺失致 log 素材饱和异常 | 已修复（T-21：`sgamut3cine-to-rec709.cube` 落地） |
| FC-COL-005 | look 参数过弱，调了跟没调一样 | 已修复（可见性红线 <2/255 拒绝出片） |
| FC-COL-006 | 只有统计目标没有画质目标致成片劣化 | 已修复（scoreQuality 健康区间） |
| FC-COL-007 | 肤色判据混用 HUEAVG 与标准 HSV 色相（绿/青被判健康肤色） | 已修复（T-01：`standardHueFromUv`） |
| FC-COL-008 | 不可修复缺陷（失焦/噪点/色带）无检测器，诚实上报形同虚设 | 已修复（T-03：blurdetect + 噪点差分 + 色带空洞判据） |

## 关联资产

- 配方库：`library/color-recipes/recipes.json`（13 条，T-14 扩至 25+）
- LUT 库：`library/luts/`（转换 33³ / 创意 17³，`generate-luts.mjs --check` 校验）
- 技能：`skills/color-grade`、`color-look-design`、`color-shot-matching`、`color-delivery-spec`
- 执行器：`connectors/color-bridge`（工具 `colorread.*` / `colorwrite.*`）
- 姊妹库：`library/bgm-kb/`（配乐）、`library/cinematography-kb/`（前期镜头语言）
