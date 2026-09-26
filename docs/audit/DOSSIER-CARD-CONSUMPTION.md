# 情报摘要卡 · 消费矩阵（T-2026-0926-0115）

> 用途：回答"情报五站产出的六张摘要卡，到底有没有人消费"。
> 证据等级：**A（读码）** + **A（真实类实例验证）**；机检口径见 `agent-knowhow-audit` 与 `dossier-evidence.test.ts`。
> 结论一句话：**六张卡中 4 张此前没有真实消费者**；本轮把最影响成片的 2 张（insight_card / prd_card）接进下游输入，另 2 张按事实登记。

| # | 摘要卡 | 设计消费者（SKILL 契约） | 接线前实际状态（读码） | 本轮处置 | 证据 |
|---:|---|---|---|---|---|
| 1 | `brief_card` | MarketingBriefParser | ✔ 已消费（`index.js` 情报段 `applyBriefCard` 回填 brief） | 保持 | `index.js` 情报段（`metadata.brief = enriched.raw`） |
| 2 | `theme_card` | CreativeThemeGenerator | ✔ 已消费（`_buildThemeInput()` 拼进创意输入） | 保持 | `index.js#_buildThemeInput` |
| 3 | `insight_card` | RequirementDiscoveryEngine | ✗ **未接线**（全仓无消费点） | **FIXED**：压成有界证据块（≤600 字）注入 `_creativeTheme.description`，需求洞察与 PRD 都能读到 | `card-consumers.js#buildInsightEvidence`；`verify-dossier-evidence.mts` ① |
| 4 | `prd_card` | PRDGenerator | ✗ **未接线** | **FIXED**：同上（演示场景/卖点证据/合规红线/钩子候选） | `#buildPrdEvidence`；`verify-dossier-evidence.mts` ① |
| 5 | `portrait_manifest` | ProductPortraitBranch | ~ **部分**：`portrait-studio/index.js` 引用了 product-branch，但平台链路未把 manifest 显式传入 | 登记待接线（下一轮：把 manifest 传进定妆照分支，做"免重复检索"） | `engines/portrait-studio/product-branch.js` |
| 6 | `router_material` | MarketingSkillRouter | ✗ **未接线**（该路由器本身未被任何模块 require） | **PROPOSAL**：接线需先确定"技能路由"在产品层的定位（与现有 `pipeline-router` 的关系） | `skills/social-marketing/marketing-skill-router.js`（零引用） |

## 注入纪律（本轮实现）

1. **只搬运卡片字段**：不新增事实、不推断、不润色；空卡不产出（`no-dossier` / `no-consumable-cards`）。
2. **有界**：单卡默认 ≤600 字（含标记），超出按字段截断。
3. **幂等**：文本带固定标记 `【情报证据】`，重复注入被识别为 `already-present`。
4. **可审计**：每次运行落 `result.stages.dossierEvidence = {injected, cards, chars}`；失败记 `degraded` 不阻断主链。
5. **不改字段结构**：写入的是既有文本字段 `description`，未新增对象字段、未改事件结构。

## 复现命令

```bash
pnpm exec tsx scripts/tools/verify-dossier-evidence.mts        # 真实类实例 3/3
pnpm exec vitest run packages/base/bundles/dossier-evidence.test.ts   # 证据块 6 项
```
