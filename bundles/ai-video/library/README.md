# 视频经理 · 技能内容库（SuperMickey 复刻资料）

> **出片前先知道这一条：本仓自带默认模特「陈卓」**（角色档案 + 8 角度定妆照随仓分发）。
> 镜头卡里**不写 `character` 时，视频管线会自动用她**——不需要先建角色、也不需要准备照片。
> 入口：[`characters/README.md`](characters/README.md) ｜ 规则与问答：[`docs/character-registry.md`](../../../docs/character-registry.md)

> 来源：`super-mickey`（master，v2.12.1）。本目录为**资料库**，不逐个登记进 bundle.json skills（官方技能套件见 `skills/` 8 件）；
> 供数码员工 prompt 引用与组织记忆 RAG 检索（拆解台账 §6）。

## 目录清单

| 目录 | 来源 | 文件数 | 说明 |
|---|---|---|---|
| `characters/` | 本仓自研（T-2026-0924-0001 角色库落地） | **15** | **内置角色档案库**：1 号模特「陈卓」+ 8 角度定妆照 + 默认选角规则（`registry.json`）——**出片开箱即用**，详见 [characters/README.md](characters/README.md)；其中 10 件（`registry.json` + `profile.json` + v3 定妆照）已入册 `bundle.json#provides.library` 完整性索引 |
| `hollywood-factory/` | `hyperreality-system/skills/好莱坞工业电影技能工厂` | **203** 个 .md | 好莱坞工业电影技能工厂：10 题材 × 9 导演 + 微表情系列 ~30 + 孤独系列等镜头级专项技能 |
| `social-marketing/` | `hyperreality-system/skills/social-marketing/skills` | **20** 个 .md | 营销技能：钩子 4 式 / 种草 3 / 演示 3 / 剪辑 3 / UGC 3 / 收尾 4 |
| `templates/` | `templates` | **5** 个模板 | scene-card / shot-card-v4 / prompt-v4 / director-review-form / project-config |
| `seedance-references/` | `seedance-shot-design/references` | **6** 份知识库 | cinematography / audio-tags / director-styles / quality-anchors / scenarios / seedance-specs |

合计 **249** 个文件（其余为 bgm / 字体 / 调色 / 摄影知识库等运行资产，见各目录内说明）。

> 说明：`characters/` 与上述"资料库"不同——它是**运行资产**（出片链路直接装载 `bundles/ai-video/library/characters/**`），
> 因此改动它等于改动出片结果：档案与定妆照只增不改，纠正走新版本 `portraits/vN/`。

## 工位 know-how 知识库（运行资产）

- `color-kb/`：**调色工位 know-how**（v1.0，8 主题 CGRADE-001~008 + `failure-cases/` 失败案例 6 个 FC-COL-001~006），
  供 `skills/color-grade` / `color-look-design` / `color-shot-matching` / `color-delivery-spec` 与 `connectors/color-bridge` 检索调用；
  判据与阈值以 `color-recipes/recipes.json` 为准，知识库只解释"为什么"和"怎么判"，检索入口 `color-kb/_INDEX.md`。
- `bgm-kb/`：**配乐工位 know-how**（v1.0，8 主题 SCORE-001~008 + `failure-cases/` 失败案例 6 个 FC-BGM-001~006），
  供 `skills/bgm-score-design` / `bgm-audio-layering` / `bgm-vocal-separation` / `bgm-library-license` / `bgm-delivery-spec` 与 `connectors/bgm-bridge` 检索调用；
  判据与阈值以 `bgm-recipes/recipes.json` 为准，检索入口 `bgm-kb/_INDEX.md`。

两个知识库与 `characters/` 同属运行资产：内容更新随版本整目录替换，不做目录内局部手改；判据改动必须与对应 recipes/连接器实现同步。

## 使用约束
- 资料为只读参考，规范字面值（字段数/字数/语速等）仍以 vendor 真源为准（设计红线 2）。
- 内容更新随 SuperMickey 版本升级整目录替换，不做目录内局部手改。
