# 提案 · vendor SocialPack 三个未接线模块（T-2026-0926-0112）

> **状态**：待产品所有者裁决（本仓不在审计轮内接线）
> **发现**：三包能力审计（`docs/audit/GAP-LEDGER.md` GAP-0002/0003/0004）机检到三个 vendor 模块**全仓零引用**：
> `engines/production-engine/agents/{marketing-duration-bridge,platform-variant-fanner,hook-performance-store}.js`
> **边界原因**：接线它们需要新增数据面（见下），违反本轮"只优化业务逻辑、不改输入输出"的约束，故走提案而非直接实施。

## 一、三个模块是什么（读码结论 · A 级）

| 模块 | 行数 | 职责 | 期望输入 | 现状 |
|---|---:|---|---|---|
| `marketing-duration-bridge.js` | 180 | 营销镜头时长按「职能 → 角色基线 + 重要性 + 节奏曲线」分配，并用平台蓝图时长带收敛；含"禁止全部同长"纪律校验 | `shots[{shotId, fn(hook/demo/ugc/seeding/editing/cta/opening), lineChars}]`、`totalDuration`、`platform` | 未接线；`production-engine._allocateDuration()` 走内联启发式且 **`preserved: true`（不改时长）** |
| `platform-variant-fanner.js` | 121 | 一次 Brief 扇出 N 个平台变体：时长重排、钩子策略（可接数据回流）、画幅约束、字幕语言、CTA 与文案风格 | 骨架镜头 `{shotId, fn, duration, dialogueBlocks, lines{platform}}`、`brief`、`platforms[]` | 未接线；当前平台差异在发布侧（`publish-rpa` 适配器）与交付侧（风格变体）分别处理 |
| `hook-performance-store.js` | 117 | 投放回流数据存储与钩子推荐：得分 = 0.6×完播 + 0.3×点击 + 0.1×转化；无数据回退平台默认（绝不虚构） | 本地 JSON `{records: {platform: {hookStyle: {...}}}}` + 投放后指标 | 未接线；`social-listening` 只做账号/评论指标，无钩子维度回流 |

## 二、为什么不能直接接线（边界判定）

1. **职能标签 `fn` 不存在**：镜头卡与对象注册表（`bundles/ai-video/schemas/objects.json`）没有 hook/demo/cta 职能字段；分配桥与扇出器都依赖它。新增该字段属于**数据结构变更**。
2. **台词分平台映射 `lines{platform}` 不存在**：扇出器要求骨架自带多语言台词映射；当前本地化在发布侧处理。新增属于**数据结构变更**。
3. **投放回流数据没有落点**：`hook-performance-store` 需要"平台 × 钩子风格"的完播/点击/转化记录；当前 `account_metric` 只有账号/视频级指标，缺钩子维度与本地存储约定。新增记录形态属于**数据面扩展**。
4. **时长重分配会改变节奏行为**：`production-engine` 目前显式 `preserved: true`（v1.2.5 起使用剧本引擎已归一化时长，不再重排）。改走分配桥会**改变成片节奏**，需真机 A/B 验证（当前无渲染额度与真机窗口）。

## 三、建议的接线方案（分三步，需产品决策）

| 步骤 | 内容 | 影响面 | 前置条件 |
|---|---|---|---|
| S1 | 在 **marketing 运行**内派生 `fn`（首镜=hook、末镜=cta、最长台词镜=demo、其余=seeding）——不落库、只作运行时派生，零 schema 变更 | `production-engine._allocateDuration()` + `index.js` 传 `{marketing, totalDuration, platform}` | 一次真机 A/B：同 brief 对比"保留原时长 vs 节奏曲线分配" |
| S2 | 用 `platform-variant-fanner` 产**发布前平台变体清单**（画幅/节奏/CTA），替代/补充当前发布侧逐平台处理 | `deliver` 步骤 + `publish-rpa` 预检 | S1 落地；平台画幅与时长带以 `platform-profiles` 为唯一事实源 |
| S3 | 打通钩子回流：`social-listening` 增钩子维度指标 → `hook-performance-store` 落本地 JSON → 扇出器按数据选钩子 | 指标采集 + 本地存储约定 | 需明确"钩子风格"的枚举与采集口径（当前不存在） |

> 风险提示：S1 会改变现有"时长=剧本引擎已归一化值"的行为；S3 涉及投放数据回流，需同时确认数据边界（客户数据不上行）与隐私口径。

## 四、本轮的处置

- 三个模块**保持不接线**（不改 vendor 行为、不改数据面）；
- 能力状态已登记到 `docs/audit/GAP-LEDGER.md`（GAP-0002/0003/0004 → PROPOSAL）；
- 若产品所有者确认 S1，可在下一轮以"实测 A/B + 回滚开关"的方式落地（本仓已具备 `duration-rules.ts` 单一口径与 G7/G8 门可作护栏）。
