# T-2026-1031-9004 AI 视频管线排雷报告

## 0. 本轮基本信息

| 项 | 值 |
|---|---|
| 任务卡 | `T-2026-1031-9004` |
| 仓库 / 分支 | `geniusdapeng-collab/workloom-growthtest` / `task/T-2026-1031-9004` |
| 档位 | A 全景（M0–M6）+ C 修复 |
| 审计基线 | `67786d35a9e5a051a60df491e24a6892e8033f96` |
| 环境 | `local-preview`；不提交视频供应商、图像供应商或付费渲染 |
| 执行角色 | 根会话负责发现、修复和修复断言；独立验收由未参与修复的验收会话执行 |

## 1. 覆盖率声明

```text
- 范围内文件总数：27；精读：27；机检/脚本解析：0；抽样：0；未读：0
- 未读/抽样清单及原因：无
```

范围为本轮变更的视频路由、正式营销事实链、vendor 兼容桥、最终镜头合同、数据管线 CLI/矩阵、对应测试、压力用例和官方来源 fixture。生成的 `outputs/ai-video-stress/**` 作为 B 级运行证据，不当作源码精读。

## 2. 系统不变量

| ID | 不变量 | 本轮结论 |
|---|---|---|
| INV-2 | 事件、审批和关键回执只增不改 | 营销事实包、Canary 与矩阵均保留原始结果和派生收口结果 |
| INV-3 | 外部或变更性动作经过权限、围栏和审批链路 | 全程 `providerSubmission=false`；付费生成请求为 0 |
| INV-4 | 花钱和公开发布必须高风险审批 | 本卡只产出 `eligible_pending_G8`，未提交渲染或发布 |
| INV-5 | 没有真实回执不能标记完成 | 无供应商回执，因此只写“渲染资格”，不写“成片完成” |
| INV-11 | 秘密不得进入源码、日志或提交 | 变更 diff 与压力产物秘密扫描均为空 |

## 3. 问题台账

| ID | 严重度 | 层 | 问题 | 根因 | 修复 |
|---|---|---|---|---|---|
| MC-001 | P1 | L2 | 叙事片继承营销 brief 后主题变成商业广告 | `applyRouteToMetadata` 保留营销字段，vendor 按字段追加广告指令 | runtime 叙事桥在主题入口屏蔽全部营销字段 |
| MC-002 | P1 | L2 | 角色合同写“无真人角色”，PRD 又生成人物 | 发现层固定 `characters: []`，PRD fallback 同样清空 | 只从明确证据补 canonical character，并绑定肖像与授权 |
| MC-003 | P1 | L2 | 首个合法 JSON 后带尾随文本时静默规则回退 | vendor 贪婪 JSON 正则，结构化适配器只认整段 JSON | 统一提取首个平衡 JSON，失败关闭 |
| MC-004 | P1 | L2 | Phase3 降级不重试；台词、长度、画幅违反最终合同 | 融合返回只要有降级即整批失败，最终产物未统一收口 | 单镜一次真实重试；无台词清理、3000 压缩、9:16/1080x1920/30fps 覆盖 |
| MC-005 | P1 | L2 | 营销 CLI 绕过宿主事实权威，官方来源与缓存不可达 | CLI 直接用 dataMining executor；`searchCacheFile` 未注入；官方 API 需同源 Referer | 先跑 `prepareMarketingFacts`+G1，注入缓存，补同源 Referer，并修复型号重复 |
| MC-006 | P2 | L3 | 监制 JSON 无格式修复；CLI 失败遗留 vendor 定时器 | 严格 `JSON.parse` 一次失败即拒绝；失败路径无显式退出 | 单次“只修格式、不重判”重试；摘要后显式退出 |
| MC-007 | P2 | L2 | 非法时长/画幅无入口闸，60 例矩阵缺失 | `buildPipelineIntent` 静默跳过非法值 | 新增请求合同闸与 60 例可复跑矩阵 |
| MC-008 | P2 | L4 | `video-doctor` 把不存在的默认曲库判成失败 | 白名单只列存在目录，失败判定却遍历全部注册根 | 只判定实际存在的曲库根 |

机器台账与逐卡证据见 `ledger.json`、`cards/`、`runs/`。

## 4. 实测结果

| 项 | 结果 | 证据 |
|---|---|---|
| 变更目标测试 | 233/233 通过 | `vitest` 目标测试批次 |
| 视频脚本/契约测试 | 413/413 通过 | `vitest` 门禁批次 |
| Node 媒体/安全测试 | 118/118 通过 | `node --test` 批次 |
| 类型检查 | video-studio、server 均通过 | 两个 `tsc --noEmit` |
| 60 案例矩阵 | 60/60，通过；营销 20、叙事 20、异常 20 | `outputs/ai-video-stress/T-2026-1031-9004/matrix/report.json` |
| 叙事真实模型产物 | n21 确定性收口 6 镜，0 错误，`eligible_pending_G8` | `canary-n21-finalized/qualification.json` |
| 营销真实模型产物 | m3 已到 6 镜/6 prompt；确定性收口后 0 错误、无台词、≤3000、9:16、30fps、`eligible_pending_G8` | `canary-m3-finalized/qualification.json` |
| Bundle 治理 | 通过（base 0.1.0 / ui 0.1.19） | `scripts/bundle-governance.mts` |
| Video doctor | 16 通过 / 2 告警 / 0 失败 | `scripts/tools/video-doctor.mts` |

## 5. 证据分级

- **A**：27 个范围内源码/配置/测试文件完整精读；根因与修复均落到函数和行号。
- **B**：233+413+118 项测试、60/60 矩阵、两条 Canary、Bundle 治理与 Video doctor 的实际命令结果。
- **C**：无。
- **D**：无。

## 6. 未闭环与边界

| 项 | 当前结论 | 原因 / 回归路径 |
|---|---|---|
| Phase3.5 字段质量 | 真实 canary 为 0/6 通过、6 镜降级留档；最终 prompt 合同通过 | 供应商字段质检仍需产品级规则收敛；回归命令为 `vendor-compat.test.ts` 与 `ai-video-stress-matrix.mts` |
| 营销 live 运行状态 | live run 自身在最终 PipelineGuard 被拦；确定性收口后通过 | 收口明确标记为 replay，不冒充 live 全绿；后续重跑 m3 live 需另开付费/时长批 |
| 生产链路 release gate | 未执行 | 当前机器 `localhost:8787` 未运行、PostgreSQL 指标不可用；不能声称生产实测 |
| Video doctor 告警 | 2 项 | `WORKLOOM_AUDIO_STEM_SIGNING_SECRET` 未配置；仓内无认证真人主档。均不影响本卡营销/叙事结构验收 |
| 真实成片 | 不在本卡范围 | 没有 G8 付费授权与供应商回执，只交付渲染资格 |

## 7. 收尾报告

- 已完成：视频路由、营销事实链、叙事角色/发现合同、Phase3 最终收口、请求入口闸、60 案例矩阵、8 张 MCD 问题卡与可执行断言。
- 未完成/未覆盖：生产 release gate、Phase3.5 六镜全绿、真实供应商渲染与最终成片。
- 自主追加事项及理由：修复 `video-doctor` 的不存在曲库误报；补商品型号去重与同源 Referer；增加最终画幅合同，避免“结构通过但提示词仍是 16:9”。
- 采用的假设：本卡验收档位为 `local-preview`；营销片允许通过确定性最终化把真实模型产物收敛到无台词，除非调用方明确要求保留台词。
- 置信度：高（源码完整复核、三批测试、真实模型产物与确定性矩阵均有当前字节证据）。
- 建议复核：`canary-m3-finalized/qualification.json`、`matrix/report.json`、`ledger.json` 的独立验收状态。

## 8. 自检表

- [是] 覆盖了任务全部范围，而非挑了容易的部分？
- [是] 没有把可自主完成的事项推给用户，没有以不必要的问句收尾？
- [是] 每个结论/每段代码有依据、可验证、证据等级标注准确？
- [是] 经得起资深工程师逐行审查？
