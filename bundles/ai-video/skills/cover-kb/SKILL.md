---
name: cover-kb
description: 封面设计知识库（cover-kb）调用技能。为封面设计师岗位提供「平台规范 / 账号定位 / 题材映射 / 钩子公式 / 构图工艺」的结构化检索与注入纪律（14 篇九章式，确定性检索，无向量库）。绑定围栏 G-SUB2/G-SUB3/G-MAT1；卸载即撤销封面 know-how 注入能力。
---

# cover-kb：封面设计知识库调用技能

## 一、适用场景

封面设计师（cover-designer）出设计稿之前，调用本技能检索行业 know-how，把「平台差异、账号定位、内容主题」三维知识注入设计稿 prompt。知识库实体在 `bundles/ai-video/library/cover-kb/`（14 篇 + `_INDEX.md`），检索桥在 `bundles/ai-video/connectors/cover-kb-bridge/`。

## 二、调用方法

```bash
node bundles/ai-video/connectors/cover-kb-bridge/cli.mjs health                       # KB 完整性自检
node bundles/ai-video/connectors/cover-kb-bridge/cli.mjs index                        # 篇目索引
node bundles/ai-video/connectors/cover-kb-bridge/cli.mjs profile xiaohongshu          # 平台规范直取（§四 参数速查）
node bundles/ai-video/connectors/cover-kb-bridge/cli.mjs recipe douyin 知识科普 知识号  # 组合配方
node bundles/ai-video/connectors/cover-kb-bridge/cli.mjs enrich --platform X --theme Y [--account Z]  # 注入载荷
```

链路内调用（`scripts/tools/full-chain-film.mts`，cover 阶段默认开启）：平台规格由 `getCoverSpec()`
（`packages/video-studio/src/cover-platforms.ts`）作为**代码事实**传入，KB 作为经验与判据；两者冲突时以代码规格为准。
关闭注入：`--no-cover-kb`。账号档案：`--account <账号id>`（读 `bundles/ai-video/library/account-profiles/<id>.yml`）。

## 三、注入纪律（硬约束）

| # | 纪律 | 判据 | 来源 |
|---|---|---|---|
| 1 | 每张封面注入 KB 条目 **≤3 条**：平台规范（必有）+ 题材映射 + 钩子/账号（按需） | 超出即截断，宁缺毋滥——prompt 里知识多于 3 条会稀释设计纪律 | cine-kb 注入范式 |
| 2 | **矛盾闸**：KB 与 `cover-platforms.ts` 规格冲突时，以代码规格为准（KB 是经验，规格是口径） | 安全区/画幅/字级数字只信 `getCoverSpec()` | cover-platforms.ts |
| 3 | **可溯源**：每条注入的 KB 条目必须带 trace（篇目编号 + 小节号），落 `stages.jsonl` | 无 trace 的注入视为未注入 | G-MAT1 |
| 4 | **只增不改**：KB 内容缺口走提案评审（仿 proposals/kb-gap-round4 格式），禁止在链路里临时改 KB 原文 | KB 变更必有提案编号 | KB 治理口径 |
| 5 | **语言随平台**：英文平台（tiktok / youtube / instagram-reels）注入的标题纪律按**词数**（≤5/≤5/≤4 词） | 中文按视觉字数（抖音 12 / 小红书 14 / B站 16） | PLAT-006 + cover-platforms.ts |

## 四、工艺判据（条件 → 做法 → 判据 → 来源）

| 条件 | 做法 | 判据 | 来源 |
|---|---|---|---|
| 出任何平台封面 | 先 `profile <平台>` 取参数速查 | 设计稿画幅/安全区/标题带与规格表一致 | PLAT-001~006 |
| 指定题材 | `recipe` 取题材映射 | archetype 选择符合 THEME-001 映射表 | THEME-001 |
| 有账号档案 | enrich 带 `--account` | 设计稿字体/色板不偏离 visual_hammer（偏离 warn） | ACCT-001 |
| 写封面标题 | 查 HOOK-001 + CRAFT-002 | 命中至少一个钩子公式且不踩误区清单 | HOOK-001 |
| 英文平台 | profile 取 tiktok/youtube 篇 | 标题为英文且 ≤ 词数上限 | PLAT-006 |
| 系列/连载 | ACCT-002 取模板复用纪律 | 同系列字体/色板/角标零改动，单图独立成立 | ACCT-002 |
| 封面被打回后重出 | CRAFT-003 查案例编号 | 修复动作与案例的"正确做法"一致 | CRAFT-003 |

## 五、参数边界

| 参数 | 边界 | 越界处置 |
|---|---|---|
| 注入条数 | 1–3 条 | 截断到 3 条 |
| search 关键词 | ≤20 字 | 截断 |
| 平台 ID | COVER_PLATFORM_IDS 之一 | 落 douyin 并 warn |
| 单条摘录长度 | ≤600 字 | 截断并标注"…（详见篇目）" |
| 账号档案 hook_bias | 1–7 个 HOOK-001 公式 ID | 未收录 ID 忽略并记 warning |
| 账号档案 fontId | COVER_FONTS 白名单四选一 | 不在白名单则忽略该约束并记 warning |

## 六、失败模式

| 症状 | 检测器 | 处置 |
|---|---|---|
| KB 目录缺篇目/索引 | `health` 非零退出 | 阻断封面链路，报"知识库不完整" |
| 注入条目无 trace | stages.jsonl 缺 kbTrace 字段 | 判封面证据链不完整（G-MAT1） |
| KB 数字与规格表冲突 | 设计稿校验期比对 getCoverSpec | 以规格表为准，冲突记入提案池 |
| 检索零命中仍强行注入 | enrich 返回空 | 允许无 KB 出稿（退化为现有行为），记 fallback 日志 |
| KB 数字与代码规格漂移 | `health` 的平台交叉核对（KB §四 vs cover-platforms.ts 原文） | 以代码为准，漂移进提案池，不改 KB 原文 |

## 七、输出契约

`enrich` 返回：

```json
{
  "hints": ["【封面知识库·PLAT-003§4】小红书 3:4 画幅…", "…"],
  "trace": [{ "kbId": "PLAT-003", "section": "§4", "reason": "platform=xiaohongshu" }],
  "fallback": false
}
```

`hints` 即 `CoverDesignInput.kbHints` 的来源；`trace` 落 stages.jsonl。

## 八、证据口径

| 证据 | 落点 | 判据 |
|---|---|---|
| 注入载荷与 trace | `stages.jsonl` 的 `stage:"cover"` 记录 `evidence.coverKb` | 有 hints 必有 trace；无 trace 判证据链不完整 |
| KB 完整性 | `health` 退出码（缺篇/索引不齐非零） | 非零时阻断封面链路，不得静默降级 |
| 平台规格一致性 | `health` 的「KB §四 ↔ cover-platforms.ts」交叉核对 | 数字不一致时打印漂移清单（不改 KB 原文） |
| 落盘 trace 文件 | `<work-dir>/cover-kb/<project>.json` | 与设计稿同目录留档，供监制复核 |
