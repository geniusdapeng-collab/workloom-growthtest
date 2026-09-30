# CLI 化缺口盘点：服务端有、命令行没有（2026-09-30）

> 触发：2026-09-30 真机事故复盘发现"视频管线分流只接在服务端派活（`pipeline-router.ts`），
> CLI 侧没有入口"，导致 AI Agent 直接跑出片命令时跳过"先判类型"。本文盘点**同类缺口**：
> 还有哪些能力只存在于服务端/UI，Agent（Codex、交付同学）从命令行走不通。
>
> 方法：`apps/server/src/**` 与 `packages/base/**` 逐模块 → 在 `scripts/**` 里搜 CLI 入口/引用（rg 全量机检，B 级）；
> 关键模块逐行精读（A 级）。**未跑真机**，结论是"入口是否可达"，不是"功能是否可用"。

## 一、结论速览

| 能力 | 服务端 | CLI 入口 | 影响 |
|---|---|---|---|
| 视频类型分流（营销/叙事/口播/澄清） | ✅ `apps/server/src/video/{router,platform-routing}.ts` | ✅ **本轮补**：`scripts/tools/route-video.mts` | 已闭环；出片入口另有 fail-closed 前置 |
| 出片主链（生成/后期/交付包） | 经工位/CLI | ✅ `scripts/tools/full-chain-film.mts` | 已闭环（本轮加：分流前置、spec 自动、渲染台账） |
| 固定影片工位通道（服务端 → 工位子进程） | ✅ `film-worker.ts` + `film-worker-channel.ts`（服务端底座，T-2026-0927-0039） | ❌ **CLI 侧未接线**（`full-chain-film.mts` 无 `--worker`/`FILM_JOB_CONTEXT`/受限通道实现） | **UI 派活 → 工位出片走不通**；本轮 CLI 已加 `WORKER_MODE_NOT_WIRED` 显式报错 |
| 交付信任 / 发布（交付发布、渲染轮询、档案宿主） | ✅ `delivery-trust.ts`、`render-poller.ts`、`archive-host.ts` | ❌ 无 CLI | Agent 无法在 CLI 完成"发布/交付信任"环节 |
| 成本/额度记账 | ✅ `apps/server/src/video/accounting.ts` + `packages/base/cost-ledger` | ❌ 无 CLI、无报表 | **"这次花了多少额度"只能数次数**（本轮加渲染台账：次数+原因，金额仍未登记） |
| 市场事实 / 生产资格（G-PROD1 上游） | ✅ `marketing-facts.ts`、`marketing-source-fetcher.ts`、`marketing-authority.ts`、`production-authority.ts` | ❌ 无 CLI（CLI 侧只有 `verify-truth-check-gate.mts` / `verify-dossier-evidence.mts` 的部分校验） | 营销片"事实红线"由服务端把关，CLI 交付时只能看档案证据 |
| 场景主题路由 / 渲染门 | ✅ `scene-policy-routing.ts`、`scene-policy-render-gate.ts` | ⚠️ 仅作为 `full-chain-film.mts` 内部逻辑存在；无独立 CLI | Agent 无法单独查询"这条需求该用哪个片型" |
| 商单 / 报价 / 账期（deal-flow） | ✅ `deal.ts` + `packages/base/deal-flow` | ❌ 无 CLI | 属经营动作，保留 UI 审批（合理） |
| 人工审批台（三手势批准/修改/驳回） | ✅ `packages/base/review-console` | ❌ 无 CLI | **高风险审批只能走 UI/API**；Agent 无法自行批准（安全上合理，但客户流程要知晓） |
| 平台发布 RPA（全平台发布） | ✅ `packages/base/publish-rpa` | ❌ 无 CLI | 交付后的发布仍要 UI |
| 夜间班 / 技能保鲜 / 巡检 | ✅ `night-shift`、`skill-ops`、`inspection` | ⚠️ 无专用 CLI（有 suite/验收脚本，不是入口） | 日常可由服务端跑，Agent 不能手动触发 |
| 商品情报五站（data-mining） | ✅ `data-mining-executor.ts` | ✅ `scripts/tools/data-pipeline-run.mts` | 已闭环 |
| 商品档案 / 素材台账 / 归档 / 门账本 | ✅ 服务端模块 | ✅ `product-archive.mts`、`material-ledger.mts`、`media-*.mts`、`archive-*.mts`、`gate-ledger-report.mts` | 已闭环 |
| 环境自检 | — | ✅ **本轮补**：`video-doctor.mts` | 新增 |
| 定妆照入库（客户导出原图 → 多角度） | — | ⏳ 由另一会话推进（本轮不落地，避免撞车） | 见 §二.6 |

## 二、优先修复建议

1. **P0｜固定影片工位第二批接线**（`film-worker-channel` → `full-chain-film.mts --worker`）：
   解析 `FILM_JOB_CONTEXT`（冻结阶段/选项/inputRef）、按 `FilmWorkerChannel` 把
   llm/image/video/media/voice/review 六类调用转成受限通道请求、把结果写回作业目录。
   缺口证据：`docs/repairs/T-2026-0927-0039.md` 第 57 行明示"full-chain-film.mts 未改动……待第二批"；
   `rg -n "FILM_JOB_CONTEXT|FilmWorkerChannel" scripts/` 无生产引用，只有测试。
2. **P1｜成本/额度报表 CLI**：`video-cost-report.mts`（按项目/镜头/环节汇总渲染次数、平台拒收、
   canary 止损、估算金额）。本轮已把"次数+原因"写进交付清单（`*-render-ledger.md`），金额需要接 `cost-ledger`。
3. **P1｜交付/发布 CLI**：给 `delivery-trust` + `publish-rpa` 提供只读清单 + 显式发布入口
   （发布属高风险动作，需保留人审：CLI 只做"准备/查询"，发布仍走审批）。
4. **P2｜片型查询 CLI**：`route-video.mts` 目前只判"营销/叙事/口播"；可扩 `--scene` 输出
   `scene-policy` 命中的片型条目与配比要求（今天只能从管线日志里看）。
5. **P2｜Agent 侧审批说明**：在 `bundles/ai-video/README.md` 注明"哪些动作必须回到 UI/审批台"
   （人工批准、发布、商单），避免 Agent 反复尝试不可达路径。
6. **P2｜定妆照入库**（客户导出原图 → 多角度槽位 + 来源证据）：由另一会话推进，本仓不在本轮落地，
   避免与那条改动撞车；接入时注意 `activatePortraitVersion` 要求**目录名 == profile.id**，
   而内置模特目录名（`model-01-chen-zhuo`）与 id（`chen-zhuo`）不同。

## 三、纪律（本轮落进 CI）

- **创作口径不得写成硬闸**：`scripts/ci/verify-hard-gate-policy.mjs`（本轮新增，静态门禁接入 `.cnb.yml`）。
- **出片必须先分流**：`full-chain-film.mts` 的 `--route` / `--route-kind` fail-closed（本轮新增）。
- **不确定就澄清**：分流器返回 `clarify` 时 CLI 直接拒绝，提示先问用户（沿用产品口径）。
