# 出镜短视频片型知识库

本目录的每个 `*.json` 是一个可版本化、会被 `full-chain-film.mts` 自动装载的片型条目。`*.source.md` 保存客户提供的原始规范；运行时判据以对应 JSON 为准。条目必须登记到 `bundles/ai-video/bundle.json#workloom.provides.library` 并刷新完整性摘要，否则跨机器安装行业包时不会分发。

## 生效链路

1. 优先读取 `shotlist.scenePolicy.id` 或 brief 的 `scenePolicyId`；否则从客户原始需求（含嵌套 brief）与出镜角色线索自动选择。未知显式片型与多类歧义会阻断；无可验证命中时保留“不适用”证据，不能把它表述成某类已验收。
   多个条目同时命中时按**人物主线优先 + `priority` 最高**判优（判优结论写进 `reason` 与选型事件）；同优先级仍冲突则 fail-closed，要求显式 `scenePolicy.id`。
2. 在 `--only` 裁剪前，按完整片单和镜头时长计算比例；逐镜核对 `policyTags`、正式口播场景、服装、受限场景与不可豁免的品质底线。生成前和摄影知识库/微动作改写后各审一次。
3. 将条目里的简短场景约束注入 `scene`、`sceneDescription` 和已有的镜头提示词；关键帧与视频各自消费对应字段。提示词、关键帧、片段、母版的监制评审另读取条目视觉标准。
4. 审计报告写入运行目录 `scene-policy-report-<project>.json`，G7 包含同一政策的硬检查。片型生效时，不接受 `--accept-rejected` 或 `--accept-env-defects` 作为绕过。

客户明确要求特殊地点时，在 `shotlist.scenePolicy.exceptions[]` 逐镜登记 `rule: "restricted-location"`、`shotId`、`term`、`customerRequest` 原话与 `source`（如 `brief#scene`）。这只解除该地点的默认限制；条目里的 `qualityFloorTerms`、全片配比与视觉复核仍生效。

新增条目时按同一 schema 增加 JSON 与原始规范副本，补自动选型优先级、时长配比、取证词、必备画面和视觉复核标准，运行 `scene-policy.test.ts` 与发布门禁。片型之间的合法调性例外由各自条目定义，不能把某类明亮要求或禁词施加到所有片型。
