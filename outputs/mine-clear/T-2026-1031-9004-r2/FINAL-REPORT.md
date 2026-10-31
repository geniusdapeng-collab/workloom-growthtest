# T-2026-1031-9004 二次独立验收修复报告

## 覆盖率声明

- 范围内非产物改动文件总数：21；完整精读：18；按 diff/目标段精读：3（`CHANGELOG.md`、`bundles/ai-video/bundle.json`、`apps/server/src/video/whiteboard/whiteboard.test.ts`）；未读：0。
- 同时精读关键直接依赖的作用域段：agents/workspaces 数据模型、render_jobs/budget_ledger/video 项目迁移、AI 视频与 GEO 围栏、preset 工具面、组合岗位权威归属、runtime autoReview 状态机、控制面 GateDecision 状态机。
- 产物目录中的 60 场景、营销/叙事 canary、MCD 运行证据由脚本解析与回读，不冒充源码精读。

## 证据分级

- **A**：自动审批作用域、G11 预算计算、G10 认领与生成失败分支、explainer 回滚、控制面门证据校验均由核心代码与对应测试精读确认。
- **B**：server/base/video-studio 全量测试、TypeScript、bundle governance、产品内容检查、MCD 卡执行、GitHub CI 与事件 run 回读。
- **C**：无。
- **D**：三端客户端 UI、U 域体验、真实供应商付费渲染和 P 域生产实测。本轮按产品所有者 2026-11-01 Codex/CLI 验收口径不在放行范围。

## 修复结论

- MC-011 P0：视频自动审批改为 `sourceBundleId=ai-video` + 实际 tool + 显式视频门三重绑定；GEO 发布、评论、加投均为 `not_applicable`。
- MC-012 P1：G11 从项目 `render_jobs` 聚合非 mock 的 `actual_seconds`（缺失回落 `est_seconds`）；标准渲染、白板和解说片三个 `render.submit` 入口均在超预算时确定性停止。
- MC-013 P1：G10 接入生产 `video.comments.process`；基础包默认不自动审批，生成失败不外发；并发重复派遣原子认领一次；manual 草稿保留在待处理查询。
- MC-014 P1：`VIDEO_AUTO_APPROVAL=0` 时 explainer draft 不再冒充人工批准，新增 `video.explainer.approveScript` 显式人工入口。
- MC-015 P2：控制面自动门必须同时绑定当前阶段声明的门、当前 facts snapshot、门对应产物 role 和 schema；证据不足写 `unverified`。

## 验证

| 验证 | 结果 |
|---|---|
| `apps/server` 全量 | 63 files / 1,169 passed；13 files / 210 skipped |
| `packages/video-studio` 全量 | 101 files / 1,812 passed |
| `packages/base` 全量 | 80 files / 1,278 passed；3 files / 125 skipped |
| TypeScript | server / base / video-studio 通过 |
| G11 真实规则 replay | `used=999, cap=1` 命中 G11 review |
| Bundle / capabilities / product content | 全部通过 |
| MCD | MC-011..MC-015 独立 acceptance 运行通过；`gate` 通过，5 verified，open P0/P1=0 |
| GitHub CI | 精确 head 的 `gate` 与 `ui-contract` 均为 success |

## 边界

- 控制面仍为影子模式，没有接管真实出片。
- 本轮没有提交付费供应商任务；`providerSubmission=false` 边界保持。
- 三端客户端 UI 与生产环境 P 域实测未纳入本轮；不得据此声称项目客户端或生产实测通过。
- 本地单独运行 `release-gate` 时服务未启动，仅 3/11 前置检查可执行；最终放行使用精确 head 的 GitHub CI 真实数据库与服务链路结果。

## 收尾报告

- 已完成：P0/P1 修复、正向/负向/并发断言、全量相关测试、类型检查、控制面证据门、独立 MCD acceptance、PR 精确 head CI。
- 未完成/未覆盖：三端 UI、U 域、真实付费生成、P 域生产实测；按本轮范围明确排除。
- 自主追加事项及理由：统一白板/解说片 G11 入口并增加评论原子认领，避免只修主路由留下同类旁路并发发送。
- 采用的假设：产品所有者授权仅覆盖 AI 视频域；GEO、酒店等原审批边界不变。
- 置信度：高。P0 越域、G11、G10、回滚和控制面证据均有实际运行断言。
- 建议复核：自动审批来源包绑定、G11 三入口统一预算、评论认领与 manual 可见性。

## 自检表

- [是] 覆盖了任务全部范围，而非挑了容易的部分？
- [是] 没有把可自主完成的事项推给用户，没有以不必要的问句收尾？
- [是] 每个结论/每段代码有依据、可验证、证据等级标注准确？
- [是] 经得起资深工程师逐行审查？
