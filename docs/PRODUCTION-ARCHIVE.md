# 制片档案与运维闭环 · 运维手册

> 规格来源：《制片档案与运维闭环机制 · 实施规格书 v1.0（2026-09-26）》
> 落地任务卡：T-2026-0926-0001（档案骨架）、T-2026-0926-0002（渲染段纳管 + 恢复编排）、T-2026-0926-0003（监控闭环）
> 适用仓：WorkLoom-growth（实验车道视频域）；其它行业仓如需复用，走提案任务卡后再实现。

## 1. 一句话模型

**一部片子 = 一个自包含档案夹**（文件是本体），PostgreSQL 里的 `production_stage_runs` 是索引面，
`engineering_findings` 是第二类数据（工程发现）。任何会话/Agent 只凭 `projectId` 读档案即可续跑，
不必依赖原始对话上下文。

```
<HR_WORK_DIR>/archive/<workspaceId>/<projectId>/
├── manifest.json                    档案清单/索引（schemaVersion + pipelineKind + 环节账本，唯一权威入口）
├── stages/<stageId>/
│   ├── attempt-<n>.input.json       第 n 次尝试的输入快照
│   ├── attempt-<n>.output.json      产物/产物指针（写成功才翻状态）
│   └── attempt-<n>.meta.json        失败现场（分类 + 堆栈）
├── logs/<stageId>.jsonl             结构化环节日志（{ts,stage,attempt,level,msg,...}）
├── events.jsonl                     档案事件流（append-only；不进 biz_events）
├── context-bundle.json              交接包（跨会话承接）
└── checkpoints/attempt-<n>-before/  开跑前的 Phase checkpoint 只读快照（vendor 会删除自己的 checkpoint）
```

## 2. 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `ARCHIVE_ENABLED` | `1` | 总开关；`0` = 完全回到接入前行为（回滚开关） |
| `ARCHIVE_AUTO_RESUME` | `0` | `1` = 启动时把超时 `running` 台账归位 `interrupted` 并留 finding（不自动拉起管线） |
| `ARCHIVE_STALE_RUNNING_MIN` | `10` | 启动扫描的"遗留"阈值（分钟） |
| `ARCHIVE_HEARTBEAT_STALE_MIN` | `30` | `archive-watch` 僵死判定阈值（分钟） |
| `ARCHIVE_WATCH_COST_CAP` | `50` | 单环节成本告警阈值（元） |
| `HR_WORK_DIR` | `.vm-work` | 工作目录；相对路径按仓库根解析（旧版按进程 cwd，`archiveWorkDir()` 自动兼容） |

## 3. 日常操作

### 3.1 看档案（服务端）

档案只读视图（需登录身份；返回 manifest + 交接包 + 台账 + 最近事件 + 关联 findings）：

```bash
pnpm exec trpc video.studio.archive '{ "projectId": "VID-1004" }'
```

### 3.2 看档案（离线 CLI，夜班/无服务端场景）

```bash
pnpm exec tsx --env-file=.env scripts/tools/archive-resume.mts list
pnpm exec tsx --env-file=.env scripts/tools/archive-resume.mts show --project VID-1004
pnpm exec tsx --env-file=.env scripts/tools/archive-resume.mts mark-interrupted --project VID-1004
pnpm exec tsx --env-file=.env scripts/tools/archive-resume.mts findings --status open
pnpm exec tsx --env-file=.env scripts/tools/archive-resume.mts receipt --finding EF-xxxx --task T-2026-0926-0004 --status fixing
```

### 3.3 恢复

```bash
pnpm exec trpc video.studio.resume '{ "projectId": "VID-1004" }'
```

返回四种：

| kind | 含义 | 下一步 |
|---|---|---|
| `resumed` | 预生产断点，已走既有补跑入口 | 看 `runId`；跑完核对档案里的 `resumed` 标记 |
| `noaction` | 渲染/后期/交付段断点 | server 在跑即自动接续（轮询驱动），无需动作 |
| `awaiting_approval` | 本项目有 pending 审批门 | 去审批中心裁决，不要重跑（重跑会多出一张待批单） |
| `busy` | 已有执行者持有运行租约 | 等它跑完；确认进程已死则用启动扫描或 `mark-interrupted` 归位 |

### 3.4 巡检（建议每 15 分钟）

```bash
pnpm exec tsx --env-file=.env scripts/tools/archive-watch.mts --workspace ws-geo
```

可选：`--dry-run`（只看不落库）、`--issue`（有 `CNB_TOKEN` 时自动建任务卡）、`--json`。
检测六类：① 僵死（running 无心跳）② 失败聚类（24h 同 stage×errorClass 跨 ≥3 项目）③ 成本异常
④ interrupted 遗留 ⑤ 台账/档案漂移 ⑥ 恢复未生效（重启后全量重跑）。

## 4. 工程发现闭环

```
archive-watch 巡检 → engineering_findings（按 dedupe_key 幂等，occurrences 累加）
  → findings-issue.md +（可选）CNB 任务卡 [T-YYYY-MMDD-9xxx]
  → 修复 PR → receipt --task T-… --fix <PR> --status fixed
  → 有价值沉淀 docs/badcases/ → --status distilled --distilled-to <path>
```

状态机：`open → triaged → fixing → fixed → distilled`（另有 `wontfix`）。

## 5. 已知限制（不要误判）

1. **Phase 级零重跑在真实模型下不成立**：vendor 用 blueprint 指纹校验 checkpoint，真实 LLM 每次生成的
   scenes 不同，指纹不匹配即删除 checkpoint 并全量重跑（实测 `VID-1004` attempt=3 与全量轮耗时持平、
   `resumed=false`）。根因修复见任务卡 #160（T-2026-0926-0004）；当前缓解 = 开跑前快照 + 巡检规则⑥。
2. **resume 会真实消耗额度**：LLM/渲染都会重跑；`ARCHIVE_AUTO_RESUME` 默认关闭就是为了不让人不知情地烧钱。
3. **只覆盖制片类管线**：`narrative-film` / `marketing-film`；`account-ops` / `ads-creative-factory` /
   `settlement-recon` 不在本机制范围。
4. **台账 attempt 不等于业务重试次数**：`renderSubmit` 的 `skipped`（幂等命中）不开新 attempt，只在档案事件流留痕。

## 6. 排障速查

| 现象 | 先看 | 期望/处置 |
|---|---|---|
| 档案夹没有产物 | `show --project <id>` | 有 `attempt-N.input.json` 无 output = 该环节没跑完/失败；看 `meta.json` 与 `logs/<stage>.jsonl` |
| 巡检报"台账/档案漂移" | `echo $HR_WORK_DIR` | server 与 CLI 必须解析出同一路径（`archiveWorkDir()` 已统一；跨机巡检要给绝对路径） |
| 巡检报"恢复未生效" | 产物里的 `resumed` 与 `preCheckpointSnapshot` | `resumed=false` 即全量重跑；见限制 1 |
| 启动扫描没动 running 行 | `ARCHIVE_AUTO_RESUME` / `ARCHIVE_STALE_RUNNING_MIN` | 默认 0 不扫描；阈值默认 10 分钟 |
| `resume` 返回 busy | 是否有 run 在跑 | 进程真死了就 `mark-interrupted` 归位后再 resume |
| 渲染 job 停在 submitted/rendering | `video.render.poll` | 轮询是 PG 驱动、重启安全；确认 server 在跑且供应商密钥就绪 |
