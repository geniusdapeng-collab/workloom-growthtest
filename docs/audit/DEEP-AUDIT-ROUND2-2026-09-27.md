# 深度审计 · 第 2 轮（围栏覆盖矩阵 / 门三联一致性）· 2026-09-27

> **范围**：三个行业包的 `presets/*.yml#tools`、`fences/*.yml`、`pipelines/*.yml`，
> 以及 `packages/video-studio` 的门账本与 `apps/server` 的门桥。
> **方法**：新增只读审计器 `scripts/tools/audit-fence-coverage.mts`，动作匹配**直接复用围栏引擎的
> `actionMatches()`**（HP-02 DSL 三档：精确 / 动词段 / 命名空间后缀），不再用启发式前缀判断。
> **证据等级**：B（全量机检）+ A（围栏引擎与种子/套件读码）。
> **复现**：`pnpm exec tsx scripts/tools/audit-fence-coverage.mts [--json|--strict|--out <path>]`

## 一、门三联一致性（管线门 × 围栏 × 门账本）

| 发现 | 证据 | 处置 |
|---|---|---|
| **F1（P0）：门账本白名单只有叙事片 7 个 step_key**——`marketing-film` 的 `g1-dossier-confirm`/`g2-theme-confirm`/`g3-insight-confirm`/`g4-prd-confirm`/`g9-publish-confirm`、`account-ops` 的 `g10-dispatch`、`ads-creative-factory` 的 `g12-boost-confirm`、`settlement-recon` 的 `g13-diff-alert` 都不在白名单 → **平台与 CLI 两侧都不会按 step_key 记账**（营销片关键门在账本里查不到） | 读码 `gate-ledger.ts`（7 个 key）+ 机检 8 处不一致 | **FIXED（T-2026-0926-0117）**：白名单扩到 15 个 step_key、门号 union 扩到 G1–G13；`apps/server` 门桥补 G1–G4 映射（营销片前置门现在会落账）；新增回归 `gate-ledger-marketing.test.ts`（4 例）并把旧测试的"G2 未映射"预期更新为"G1–G4 已映射、未知门仍返回 null" |
| **F2（P2）：管线写 `gate: G10`，围栏是 G10a–G10d 四条细分** | 机检：`account-ops` gate=G10 无同号规则 | **已缓解**：门账本按总号 `G10` 记账（映射层解决）；围栏保持细分（取严并集）。建议在 yml 注释里注明"总号对应 a–d 并集"（提案，不改拓扑） |

## 二、写动作 × 围栏覆盖矩阵（声明面口径）

| 包 | 声明写动作 | 规则命中 | 完全无规则 | 未命中兜底 |
|---|---:|---:|---:|---|
| ai-video | 80 | 32（宽口径 0） | 48 | `review` |
| geo-growth | 67 | 13（宽口径 2） | 54 | `review` |
| hotel | 28 | 6 | 22 | `review` / 只读体检补丁 `block` |

**口径澄清（A 级，避免误读）**：

1. **未命中 ≠ 绕过**：围栏引擎对"写类动作无规则命中"按包级 `default_level` 处理（ai-video / geo-growth 全为 `review`），
   属于 fail-closed 的保守挂起；hotel 的 `audit-only-patch` 更是 `block`（体检期写动作一律拒）。
2. **preset 的 `tools` 是"岗位能力声明"，不是运行时动作字面值**：例如卡片写 `ads.boost.request`，
   而运行时/种子/套件用的 canonical 动作是 `ads.boost`（`scripts/seed-video.ts`、`scripts/seed-geo.ts`、`scripts/suite-geo.ts` 均为 `ads.boost`，与 G12 规则一致）。
   因此矩阵度量的是**声明一致性**，不是"规则是否失效"。
3. **宽口径命中是可用的**：geo-growth 的 `shootlist.emit` 由规则动词段 `emit` 命中
   （HP-02 DSL ②：单段动作词按动词段匹配），属有意的域级覆盖；审计器已把这类单独列出，不与精确命中混算。

**建议（提案，不改契约）**：把 3 处与 canonical 动作漂移的声明对齐——`ads.boost.request → ads.boost`、
`archive.write_back → archive`、`shootlist.emit → shootlist|emit`（后两者已由宽口径覆盖，可选），
以消除"看声明以为没规则、看规则以为没调用"的双向困惑。

## 三、本轮未覆盖

- vendor 内部兜底（`FIELD_GUARD` 默认模板、子 Agent 全失败退规则）逐条裁定 → 仍为 GAP-0011b 提案；
- 运行时动作字面值的全量取证（本轮只核验了 3 个 canonical 动作样例）；
- 真机全链（缺 key 与渲染额度）。
