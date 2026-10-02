# 封面平台化与封面知识库（口径文档）

> 建档：2026-09-27 · 适用：`packages/video-studio/src/cover-platforms.ts`、`packages/video-studio/src/cover-design.ts`、
> `scripts/tools/full-chain-film.mts`（cover 阶段）、`bundles/ai-video/connectors/cover-kb-bridge/**`、
> `bundles/ai-video/library/cover-kb/**`、`bundles/ai-video/library/account-profiles/**`
>
> 来源方案：《视频封面链路强化方案（对焦稿 v1）》+《AI Coding Agent 执行方案》
> （附件交付物 `cover-platforms.ts` / `cover-kb/` / `cover-kb.SKILL.md` / `account-profiles/example-chen-zhuo.yml`）。
> 落地时按仓内真实 HEAD 重锚：附件假设的 `coverDeterministicChecks(measure, platform)`、`CW/CH` 写死位置、
> `validateCoverPlan` 12 字硬编码等锚点已随 2026-09-25/26/27 的真实链路演进，本文件记录**实际口径**。

## 一、平台规格表（封面侧唯一事实源）

单一事实源：`packages/video-studio/src/cover-platforms.ts`（`COVER_PLATFORMS` + `getCoverSpec()`）。
两条链路（`cover-design.ts`、`full-chain-film.mts`）一律从这里取数，代码里不得再出现画幅/安全区字面量。

| 平台 ID | 展示名 | 画幅 | 画布 | 顶部安全区 | 底部遮挡 | 右侧栏 | 标题带 | 标题上限 | 语言 |
|---|---|---|---|---|---|---|---|---|---|
| `douyin` | 抖音 | 9:16 | 1080×1920 | 6% | **12%**（真机口径） | 11% | 6%–42% | 12 字 | zh |
| `kuaishou` | 快手 | 9:16 | 1080×1920 | 6% | 17% | 11% | 6%–42% | 12 字 | zh |
| `xiaohongshu` | 小红书 | 3:4 | 1080×1440 | 7% | 17% | 0 | 7%–45% | 14 字 | zh |
| `wechat-channels` | 微信视频号 | 9:16 | 1080×1920 | 6% | 16% | 11% | 6%–42% | 12 字 | zh |
| `bilibili` | B站 | 16:9 | 1920×1080 | 6% | 9% | 0 | 6%–55% | 16 字 | zh |
| `tiktok` | TikTok | 9:16 | 1080×1920 | 6% | 17% | 11% | 6%–42% | 5 词 | en |
| `youtube` | YouTube | 16:9 | 1920×1080 | 5% | 8% | 0 | 5%–60% | 5 词 | en |
| `instagram-reels` | Instagram Reels | 9:16 | 1080×1920 | 6% | 15% | 11% | 6%–42% | 4 词 | en |

中文别名（`抖音`/`抖音/快手`/`小红书`/`视频号`/`B站`/`哔哩哔哩`/`油管`/`ins`…）由 `PLATFORM_ALIASES` 归一；
**未知平台落 `douyin` 并 `console.warn`**（不抛错，保证旧调用零影响）。
英文平台按**词数**判定标题长度，中文平台按**视觉字数**（`headlineUnits()`）。

## 二、px → 比例换算依据（上游事实源）

上游蓝图：`vendor/supermickey/hyperreality-system/config/platform-profiles.js` 的 `safeArea`
（`rightRailPx` / `bottomPx` / `topPx`），换算公式：

```
topMinRatio        = topPx      ÷ 画布高
bottomReservedRatio = bottomPx  ÷ 画布高
rightRailRatio     = rightRailPx ÷ 画布宽
```

| 平台 | vendor px（top/bottom/rightRail） | 换算 | 本表取值 |
|---|---|---|---|
| 抖音 | 120 / 320 / 120（高 1920，宽 1080） | 6.25% / 16.67% / 11.1% | 6% / **12%（例外，见下）** / 11% |
| 快手 | 120 / 320 / 120 | 6.25% / 16.67% / 11.1% | 6% / 17% / 11% |
| 小红书 | 100 / 240 / 0（高 1440） | 6.94% / 16.67% / 0 | 7% / 17% / 0 |
| 视频号 | 120 / 300 / 120（高 1920） | 6.25% / 15.63% / 11.1% | 6% / 16% / 11% |
| B站 | 60 / 90 / 0（高 1080，宽 1920） | 5.56% / 8.33% / 0 | 6% / 9% / 0 |
| TikTok | 120 / 320 / 120 | 6.25% / 16.67% / 11.1% | 6% / 17% / 11% |
| Instagram Reels | 120 / 280 / 120 | 6.25% / 14.58% / 11.1% | 6% / 15% / 11% |
| YouTube | vendor 蓝图未收录 | — | 5% / 8% / 0（封面侧标定，见 `PLAT-006`） |

**口径差异（两条，均已登记在代码注释与 KB 里）**

1. **抖音底部 12%（不是 vendor 的 16.67%）**：`bottomPx: 320` 是"成片安全区"口径，
   封面链路的 12% 是 2026-09-25/27 真机验证过的标题带口径（`COVER_SAFE_AREA`）。
   平台化按"抽出参数、默认值不变"处理：**抖音维持 12%**，并在 `vendorNote` 里写明差异。
2. **YouTube 不在 vendor 蓝图里**：横版缩略图规格（5% 顶带、8% 底部、右下 12%×8% 时长角标区）
   来自封面侧标定，登记在 `PLAT-006` 与 `cover-platforms.ts#youtube`。

`cover-platforms.test.ts` 会**直接读 vendor 原文**逐项比对 px 与比例的对应关系（漂移即红），
`cover-kb-bridge health` 也会把 KB §四 的数字与 `cover-platforms.ts` 原文交叉核对（漂移清单进提案池）。

## 三、回归基线（硬约束）

1. **抖音封面行为逐像素不变**：`getCoverSpec("douyin")` 与历史 `COVER_SAFE_AREA`（0.06 / 0.42 / 0.12）
   和 1080×1920 完全一致（单测锁死）；`full-chain-film.mts --cover-platform` 缺省沿用 `--platform`
   （历史默认值 `抖音/快手` → 抖音口径），因此默认出片路径的画幅、取帧、标题带、scrim、机检口径全部不变。
2. **抖音 + 无 KB + 无账号档案时提示词逐字一致**：`buildCoverDesignPrompt` 的每一行都按
   `getCoverSpec` 渲染，抖音值渲染结果与平台化之前**逐字相同**（单测断言关键行原文）。
3. **旧机检签名兼容**：`coverDeterministicChecks(measure, safeAreaObject)` 仍按抖音画幅判定
   （`COVER_LOWER_BAND_SAFE_AREA` 等旧调用零改动）。

## 四、封面知识库（cover-kb）与注入口径

- 内容库：`bundles/ai-video/library/cover-kb/`（14 篇九章式 + `_INDEX.md`；PLAT×6 / ACCT×2 / THEME×2 / HOOK×1 / CRAFT×3）。
- 检索桥：`bundles/ai-video/connectors/cover-kb-bridge/`（`core.mjs` + `cli.mjs` + `account-profile.mjs`，零依赖，确定性检索无向量库）。
- 调用技能：`bundles/ai-video/skills/cover-kb/SKILL.md`（S-B 型，过 `agent-knowhow` 审计；绑 `cover-designer` 岗位）。
- 链路注入：`full-chain-film.mts` cover 阶段默认调用 `enrichCoverHints()`，把 ≤3 条载荷传给
  `CoverDesignInput.kbHints`；trace 落 `stages.jsonl` 的 `evidence.coverKb` 与 `<work-dir>/cover-kb/<project>.json`。

注入纪律（硬约束）：

1. **≤3 条**（平台规范必有 + 题材映射/钩子 + 账号视觉锤），超出即截断；
2. **矛盾闸**：KB 与 `cover-platforms.ts` 冲突时**以代码规格为准**，差异写进 `conflicts`（进提案池，不改 KB 原文）；
3. **可溯源**：每条 hint 与 trace 一一对应（篇目编号 + 小节），无 trace 视为未注入；
4. **只增不改**：KB 内容缺口走提案评审（仿 `proposals/kb-gap-round4-*`）。

CLI：

```bash
node bundles/ai-video/connectors/cover-kb-bridge/cli.mjs health
node bundles/ai-video/connectors/cover-kb-bridge/cli.mjs profile xiaohongshu
node bundles/ai-video/connectors/cover-kb-bridge/cli.mjs recipe douyin 知识科普 知识号
node bundles/ai-video/connectors/cover-kb-bridge/cli.mjs enrich --platform bilibili --theme 测评 --account chen-zhuo
```

## 五、账号定位档案（视觉锤）

- 目录：`bundles/ai-video/library/account-profiles/`（样例 `chen-zhuo.yml` + `README.md` 字段说明）；
- 用法：`--account <账号id>`（可给路径）；档案不存在 → **直接报错**，不退回"无档案"行为；
- 校验：字体/色板偏离或命中禁区 → 默认**告警**（写进设计稿 `warnings` 与 `stages.jsonl`），
  `strict: true` → 判非法打回；`archetype_bias` 与片子版式不同只告警（版式以片子主视觉为准）；
- 兜底稿同样遵守账号视觉锤（降级不让账号一致性漂移）。

## 六、机检与监制口径变化

| 检查项 | 平台化前 | 现在 |
|---|---|---|
| `cover-produced` | 写死 1080×1920 | `getCoverSpec(platform).canvas` |
| `safe-area` | 写死 6% / 42% / 12% | 平台安全区 + 平台标题带（person-solo 仍用下带 52%–88%，底部遮挡按平台） |
| `bottomBandInkRatio` 计算 | 写死 12% | 平台底部遮挡比例 |
| 标题长度校验 | 写死 ≤12 字 | 平台上限（中文按字数 / 英文按词数） |
| 监制 context | 只有 9:16 世界观 | 追加平台画幅/文案调性/钩子风格/标题上限 + KB 注入清单与 trace |

未做（明确留待后续，避免"看起来做了"）：

1. **封面 CTR 数据回流**（附件 S4）依赖 `GAP-0002`（仍为 PROPOSAL 状态）——本期不做；
2. **横版取帧的主体检测**：横版平台目前用"缩放铺满 + 偏上 38% 裁切"的确定性策略，
   未做主体/人脸检测驱动的智能裁剪；
3. **KB 增强机检**：拼接接缝扫描、底图 OCR/水印匹配、人脸闭眼检测、scrim 边缘梯度检测
   仍是"建议增强"（未实现，见 `CRAFT-003` 模板 A 的增强清单），实现前由监制人工拦；
4. **B 链（`bundles/geo-growth` 视觉工位）对齐**：本期只强化 A 链，B 链 `video-cover` 技能保持原状。

## 六-1、真机测试中发现并修复的问题（2026-09-27）

用真实模型（DeepSeek）+ 真实 ffmpeg 跑 cover 阶段时，暴露了 3 个方案本身没覆盖的问题，均已修复：

| # | 症状（真机证据） | 根因 | 修复 |
|---|---|---|---|
| 1 | 设计稿连打两次回：`人物卡宽度比例 0.55 越界（0.28–0.50）` → 退兜底稿 | 提示词从未写过校验区间，模型只能猜 | 提示词新增第 7 条"数值边界（越界即判非法）"：`person.widthRatio` 0.28–0.50、`headlineSizeRatio` 0.045–0.12、`sublineSizeRatio` 0.022–0.06、副标题 ≤24 字、角标 ≤10 字 |
| 2 | 监制打回："配色偏离封面知识库：THEME-001 要求 zcool-qingke + #00C2A8，实际用了 smiley-sans + #FFD166，同账号视觉锤未锁定" | 监制看不到账号视觉锤，也不知道"账号锤 > 题材建议"的优先级 | ① 账号档案存在时提示词注入 `【优先级】账号视觉锤 > 题材建议 > 平台通用建议`；② 监制 context 追加 `accountVisualHammer`（含 priority 说明） |
| 3 | 监制打回："标题带下沿（约 80.6%）可见一条硬边压暗矩形分界线横切人物胸口" | person-solo 的下带 scrim 是"上浅下深"，在画面内留下硬边；14 条薄带在 1080 高上约 31px/条，肉眼见阶梯 | 下带改**三角剖面**（两端渐隐 0、中间 0.40）并把层数加密到 28（约 15px/条）；上带维持 14 条（抖音默认路径逐像素不变） |

修复后复跑（同一份真实模型 + 真实 ffmpeg）：

- 抖音 · `person-solo` · 账号档案 · KB 注入：`ok=true`、`degraded=false`、`designVia=llm`、机检 5/5 通过、监制放行；
- 小红书：产物 1080×1440 机检通过；B站：产物 1920×1080 机检通过；`--no-cover-kb` 时 `coverKb.applied=false` 且封面照常产出。

## 七、验收与回归入口

```bash
# 平台规格 + 提示词/校验/机检（29 例）
node_modules/.bin/vitest run packages/video-studio/src/cover-platforms.test.ts packages/video-studio/src/cover-design.test.ts
# 知识库检索桥（17 例：解析/交叉核对/注入纪律/账号档案）
node_modules/.bin/vitest run bundles/ai-video/connectors/cover-kb-bridge/core.test.ts
# 能力面交叉引用 + 考试院题集（base 侧）
node_modules/.bin/vitest run packages/base/bundles/cover-capability.test.ts packages/base/bundles/agent-knowhow.test.ts
# 行业包治理（provides ↔ integrity.assets ↔ 摘要）
node_modules/.bin/tsx scripts/bundle-governance.mts
# 能力导览（README 区块 + docs/capabilities.auto.*）
pnpm capabilities && pnpm capabilities:check
```
