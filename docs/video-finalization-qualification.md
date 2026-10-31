# 视频预生产最终化资格

`scripts/tools/data-pipeline-finalize.mts` 在真实模型预生产结果之后、G8 渲染提交之前生成
`workloom.video-render-qualification/v1`。本工具不调用模型、图片供应商或视频供应商，也不会提交渲染。

## 通过条件

以下检查必须同时成立：

1. 最终 prompt 非空、无对象/undefined 占位符、未超长度上限，镜头时长有效。
2. `RenderPipelineGuard` 通过，镜头没有降级结果；无台词口径下不得残留台词。
3. 每个声明了人物的镜头都绑定当前注册角色的活动定妆照文件，文件位于人物库内且不是占位路径。
4. 人物 ID 可解析；真实人物授权有效；PRD `characterSystem` 含同一角色和有效肖像路径。
5. `characterRef` 不是 `PENDING_GENERATION`，镜头人物约束不能同时要求空镜/无人。
6. 存在人物时 G5 不得因 `auto(G5_PORTRAIT)` 等非“无角色/商品”原因跳过。

只有全部通过时才写 `status=eligible_pending_G8` 并以 exit 0 返回。失败写 `status=blocked` 并以 exit 4 返回。
`providerSubmission=false` 与 `renderSubmitted=false` 始终写入产物。

## 产物

```text
finalized-shots.json
prompts.json
pipeline-guard.json
pipeline-guard-log.json
final-shot-contract.json
qualification.json
```

`qualification.json#characterQualification` 逐镜记录人物、肖像引用和处理结果；问题码包括
`CHARACTER_ID_UNREGISTERED`、`PORTRAIT_BINDING_REQUIRED`、`PORTRAIT_REFERENCE_INVALID`、
`CHARACTER_AUTHORIZATION_INVALID`、`CHARACTER_ASSERTION_CONFLICT`、`CHARACTER_SYSTEM_MISMATCH`、
`PORTRAIT_STAGE_SKIPPED` 与 `PORTRAIT_SOURCE_TEXT_ONLY`。

## 不做的事

最终化不会把文字描述自动当成已授权肖像，不会给未登记人物补位，不会修改 PRD 来通过校验，也不会替代
G8 预算、模型资格、登录态、实际供应商回执或发布门。
