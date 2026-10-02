# Jev 决策模型 · growth 影子评估（试点）

> 位置：`apps/server/src/industry/geo-growth/jev/`（行业侧，`base-sync` 排除路径，不改基座契约）
> 通道：**① TypeSafe 官方直连（默认）** `POST https://api.typesafe.ai/v1/systemone`；
> **② Vercel AI Gateway（备选）** `typesafe-ai/jev`，evaluation 协议 v4
> 状态：影子评估（shadow）——只产出报告，**不写业务库、不发外发通道、不替代任何围栏**

## 1. 为什么做、边界是什么

**做**：把 growth 里最高频的三个「判断类」环节交给决策模型（Jev）做影子对照，用真实业务样本量出
「准确率 / 校准 / 成本 / 延迟 / 可自动比例」五个数，再决定是否值得进基座或进生产链路。

| 场景 | 对应现有位点 | 说明 |
|---|---|---|
| `comment-classify` | `bundles/geo-growth/model-policy.yml` 的 `comment-classify`（L1、谷时批量） | 社媒评论/私信初筛：意图 + 是否线索 + 是否需人工 |
| `lead-qualify` | 同上的 `lead-qualify`（L2） | 线索意向强度（有序档位）+ 预算/时间/决策人三个事实问题 |
| `fact-precheck` | 围栏 `G-GEO2`（事实红线一票否决）的人工前置 | 草稿前提是否在官方口径内 / 是否编造具体信息 / 是否品牌表态 |

**不做（硬边界）**：

- `fact-precheck` 的结论**不满足**围栏 `G-GEO2` 的 `context.fact_check_passed` 条件——它只是影子预检；
- 任何真实动作（外发、回复、发布、改库）仍走「先围栏后动作」；本模块输出的 `route=auto` 只代表
  "这条在影子里可以自动"，**不是执行授权**；
- 品牌实体逐字一致性、数字/日期比较一律留在代码里（官方 jaggedness 明确模型在这些点上不可靠）；
- 客户原始数据不落库、不进仓库、不进日志：数据集必须事先脱敏，日志只打印 id/决策/置信度。

## 2. 快速开始

```bash
# ① 离线全链路（本地模拟通道，无 key、无外呼）：先确认协议与报告口径
#    模拟通道按请求路径返回对应形状：/v1/systemone（直连）或 /v4/ai/evaluation-model（网关）
pnpm tsx apps/server/src/industry/geo-growth/jev/cli.ts --scene comment-classify --exam --mock

# ② 用真实业务样本跑影子（数据集必须脱敏；JSONL：{id, text, expected?, context?, officialClaims?}）
pnpm tsx apps/server/src/industry/geo-growth/jev/cli.ts --scene comment-classify --dataset ./local-comments.jsonl

# ③ 首次接真 key：先抓原始响应，钉死解析口径（通道 2 官方直连）
TYPESAFE_API_KEY=<key> pnpm tsx apps/server/src/industry/geo-growth/jev/cli.ts \
  --scene comment-classify --dataset ./local-comments.jsonl --limit 3 --capture-raw

# ④ 通道 1（网关）仍可用：显式声明 provider，键名也换成网关的
JEV_PROVIDER=vercel-gateway AI_GATEWAY_API_KEY=<key> pnpm tsx apps/server/src/industry/geo-growth/jev/cli.ts \
  --scene comment-classify --exam
```

### 2.1 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `TYPESAFE_API_KEY` | 无 | 通道 2 必需。在 `console.typesafe.ai/keys` 创建；只进本机 `.env`/环境，绝不进仓库 |
| `AI_GATEWAY_API_KEY` | 无 | 通道 1 必需。Vercel 控制台 → AI Gateway → API Keys；同上只走环境注入 |
| `JEV_PROVIDER` | 按 key 推断 | `typesafe`（默认）｜`vercel-gateway`；显式值优先于键推断，非法值直接报错不静默回退 |
| `JEV_BASE_URL` | 按通道 | 直连 `https://api.typesafe.ai`；网关 `https://ai-gateway.vercel.sh` |
| `JEV_MODEL` | 按通道 | 直连 `jev-latest`（别名→`jev-1.13.0`）；网关 `typesafe-ai/jev` |
| `JEV_TIMEOUT_MS` | `20000` | 单次请求硬超时 |

通道判别：`--provider` > `JEV_PROVIDER` > 按键推断（有 `TYPESAFE_API_KEY` 走直连、只有网关 key 走网关）
> 默认直连。**不会**在两条通道之间静默切换：键缺失时直接报缺 key 并给出获取入口。

CLI 参数：`--scene` `--provider` `--dataset` `--exam` `--out` `--limit` `--concurrency` `--max-cost-usd`
`--mock` `--capture-raw` `--model` `--base-url` `--timeout-ms`（`--help` 查看全部）。

### 2.2 两条通道的请求/响应差异（同一解析层兼容）

| 项 | 通道 2 · 官方直连（默认） | 通道 1 · Vercel 网关 |
|---|---|---|
| 路径 | `POST {base}/v1/systemone` | `POST {base}/v4/ai/evaluation-model` |
| 鉴权 | `Authorization: Bearer $TYPESAFE_API_KEY` | `Authorization: Bearer $AI_GATEWAY_API_KEY` + 3 个协议头 |
| 请求体 | `{state, model, questions}`（`model` 必填） | `{state, questions}`（模型走 `ai-model-id` 头） |
| 问题类型名 | 官方原语 `noul` / `choice` / `score`（本地 `boolean` 出站前映射为 `noul`） | evaluation v4 类型名（`boolean` / `choice` / `score`） |
| Noul 回答 | `{"type":"noul","noul":0.95}`，**无置信度字段** → 本模块派生置信度并强制保守分流 | `{"type":"boolean","probability":…}` + `providerMetadata.typesafe.confidence` |
| usage | `{input_tokens, output_tokens}` | `{inputTokens, outputTokens}` |

`report.json` 的 `provider` 字段记录本次跑的是哪条通道，`model` 记录**请求用的 id（可能是别名）**，
`responseModels` 记录**模型自报的版本化 id**（响应里 `model` 字段，去重排序）——
两者不一致即说明别名已漂移，是阈值失效的第一信号。**跨通道对比必须同数据集、同模型别名、同口径**。

## 3. 输出与判读

输出目录（默认 `data/jev-shadow/<scene>-<时间戳>/`——`data/` 是本仓已 gitignore 的本地证据目录，评估产物不进仓库）：

| 文件 | 内容 |
|---|---|
| `report.json` | 汇总：`provider` / `model`（请求 id）/ `responseModels`（响应自报版本）/ `accuracy` / `macroF1` / `ece` + `eceBins` / `costUsd` / `latency{p50,p95,max}` / `routes{auto,review,human}` / `autoRate` / `errors` |
| `outcomes.jsonl` | 每行：决策、置信度、路由、依据、token、延迟、是否正确 |
| `raw.json`（`--capture-raw`） | 原始响应，用于钉解析口径与排查 |

判读纪律：

1. **先看校准再看准确率**：`report.ece` 与 `eceBins` 决定自动档阈值。第三方早期实测显示高置信桶
   （≥0.9）与中低置信桶（0.3–0.7）差距极大，**不要用单一准确率数字决定全量自动**。
2. **派生置信度不得自动**：网关未回传 confidence 时，本模块派生并标记，`gating.ts` 会强制降级到人审。
3. **成本口径**：$0.042/1M 输入 token、输出免费；`--max-cost-usd` 是熔断线，不是预算建议。
4. **对照才有意义**：与既有 L1 档模型在**同一数据集**上的结果对照；只跑 Jev 单边不构成结论。

## 4. 试点→生产的分层路径（协议 §1.4：合并在人）

```
① 影子评估（本模块，现在）        → 产出五项指标 + exam 卷面成绩
② 灰度（需人审）                  → 只对 comment-classify 开一条影子账本通道，人审率不降不得扩大
③ 基座提案（L2→L1→L0）            → 若值得，向 workloom-im 提「DecisionProvider」提案：
                                     model-router 新增决策模型档位 + 出站脱敏网关直连 + 考试院卷面
```

**为什么现在不进 model-router**：基座提供方契约是 OpenAI 兼容 chat（`messages → text`），而 Jev 是
evaluation 协议（`state + typed questions → typed answers`，官方明确不支持 OpenAI 兼容端点）。
硬塞会破坏"出站必经脱敏网关"的既有语义，因此先行业侧验证，再走提案。

## 5. 合规与安全

- **数据出站**：官方声明「Jev 不用客户请求/响应做训练」（`docs.typesafe.ai/models` § Data handling），
  企业版可另行签署零数据留存（ZDR）；通道 1 的网关目录同样标注 `zdr: all` + `no_training: all`。
  即便如此，**接入前仍必须按 WorkLoom 不变量走脱敏与出站声明**：出站的 state 只放判断必需字段。
- **秘密管理**：key 只从环境变量读取；`client.ts` 的错误消息只包含状态码与主机名，测试覆盖"key 不出现在错误里"。
- **失败语义**：4xx 中 401/403 立即失败（非重试）；429/5xx/超时按退避重试（只读调用，安全）；
  非法回答（未知选项、越界分数、概率异常）整体拒绝，**绝不猜测**。
- **预算熔断**：单次运行 `--max-cost-usd` 达到即停止调度新行，剩余行标记预算超限（不静默跳过）。

### 5.1 生产运行建议（影子期）

```bash
# 每日谷时跑一轮（示例：每周一 09:10，与 visibility-watch 周频采集同窗）
10 9 * * 1  cd <repo> && TYPESAFE_API_KEY=<key> pnpm tsx \
  apps/server/src/industry/geo-growth/jev/cli.ts \
  --scene comment-classify --dataset data/jev-shadow/input/comments.jsonl \
  --concurrency 2 --max-cost-usd 1 \
  --out data/jev-shadow/runs/$(date +\%Y\%m\%d)
```

- **监控口径**：`report.json` 的 `failed`（通道不可用）、`routes.auto/human`（分流漂移）、`costUsd`（预算）、`ece`（校准恶化）、`accuracy`（若带标签）。
- **告警阈值（建议起步值）**：`failed > 5%` 或 `ece > 0.15` 或 `accuracy` 环比下降 `>5pp` 即暂停自动档并回退全人审。
- **回退**：删掉定时任务即可；本模块只写 `data/**`，无业务副作用。
- **升级到灰度**：连续 2 周满足「准确率不低于现行 L1 档、`ece ≤ 0.12`、自动档样本 ≥500 条」后，再按第 4 节走基座提案。

## 6. 已知不确定性与首次接真 key 的必做动作

1. **响应形状**：解析层同时兼容官方直连（`answers[id].type=noul`、`usage.input_tokens`）与网关
   （`type=boolean`、`providerMetadata.typesafe.confidence`、`usage.inputTokens`）。首次接真 key 请务必
   `--capture-raw --limit 3`，确认形状后如与解析不一致，改 `protocol.ts` 并补测试（**不要**先跑全量）。
2. **中文准确率**：官方明确英文最佳、CJK "handled but not equally well"。本模块 instructions 全英文、
   state 为中文原文；**必须用考卷 + 真实样本实测**后才能定自动档阈值。
3. **限流与上下文**：官方限流动态调整（当前 250k tok/s、1200 RPM，超限返回 429 并带 `retry-after`），
   单请求上下文 64k token（state 与最长问题占 32k）；批量跑请从 `--concurrency 2` 起，观察 429 比例。
4. **别名会漂移**：`jev-latest` 当前指向 `jev-1.13.0`；阈值一旦按版本调好，应把 `JEV_MODEL` 钉到
   版本化 id，避免上游换版本时静默改变分流口径（`report.json.responseModels` 记录实际回答的版本）。

## 7. 测试

> 附：**NanoJev 评估结论（2026-09-19，暂不采用）**——社区开源平替
> [NanoJev](https://github.com/TianyuCodings/NanoJev)（MIT，Qwen3-0.6B + 决策头，契约与我们同构）曾在
> PR #57 接入本地通道，因其推理代码**硬依赖 CUDA**（`predict_toy_decisions.py` 显式检查 `torch.cuda`）、
> 且权重面向迷宫/贪吃蛇等游戏任务（非通用 Jev），在无 CUDA 的机器上不具可用性 → **已于 PR #58 完整回滚**。
> 将来若具备 CUDA 环境且需要"零调用成本的本地决策模型"，可重新评估（含其训练管线与 HF 数据集），
> 但须先用自己的标注数据微调并过考卷，再考虑进入判断链路。

```bash
# 本模块 49 个离线用例（双通道请求形状/协议解析/重试/超时/密钥安全/分流/指标/端到端）
node_modules/.bin/vitest run apps/server/src/industry/geo-growth/jev

# 类型检查（仓库 strict + noUncheckedIndexedAccess 口径）
node_modules/.bin/tsc --noEmit --strict --noUncheckedIndexedAccess --target ES2022 --module ESNext \
  --moduleResolution Bundler --lib ES2022 --types node --skipLibCheck --esModuleInterop \
  apps/server/src/industry/geo-growth/jev/*.ts
```

测试全部离线（本地模拟网关 `127.0.0.1`），不需要 key、不产生外呼。
