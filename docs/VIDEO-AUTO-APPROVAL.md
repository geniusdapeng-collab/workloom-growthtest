# GrowthTest 视频管线系统自动审批

- 任务：`T-2026-1031-9003`
- 策略：`workloom.video-auto-approval/v1`
- 默认：开启
- 回滚：`VIDEO_AUTO_APPROVAL=0`

## 产品口径

产品所有者于 2026-10-31 明确授权：GrowthTest 隔离副本的视频管线取消人类审批等待；
原有的质量审核、参数检查、内容分流、预算、授权、供应商资格和真实回执要求全部保留。

自动审批不是跳过门。它只替换“审核完成以后停下来等人点批准”的动作。

## 生效范围

| 路径 | 自动审批后的行为 | 保留的硬约束 |
|---|---|---|
| G1–G4 / G6 / G7 | AI 监制完成确定性检查和模型评审后自动批准 | 空内容、占位符、Schema、事实和模型评审失败 |
| G5 定妆照 | 本次真实图片、四角度、文件字节和项目作用域核验后自动批准 | 未出图、缺角度、空文件、跨项目、符号链接 |
| G8 渲染提交 | 质量围栏和预算/成本/资格检查后自动批准 | block 规则、模型资格、计划时长、额度、成本上限 |
| G9 公网发布 | 发布包、首发规则、日上限和登录态检查后自动批准 | G9b 熔断、登录失效、缺适配器、无真实回执 |
| G10 评论回复 | 意图分类、敏感词和危机告警分流后自动执行 | 敏感内容 block、生成失败、外发失败、无回执 |
| G11 算力超预算 | 不进入人类等待；预算事实不满足时失败关闭 | 项目/套餐/成本硬上限 |
| G12 投放加投 | 原 G12 预算与素材依据审查后自动批准 | 围栏 block 和预算事实 |
| G15 商单对外文件 | 原 G15 文件质量审查后自动批准 | 围栏 block、文档来源和真实外发回执 |

以下规则属于原质量/合规审核本身，不是“审核完成后的人类批准动作”，因此不自动跳过：
`G-DLV4..G-DLV9`、`G-BGM1..G-BGM9`、`G-SUB1..G-SUB6`、`G-VOICE0..G-VOICE6`、
`G-MAT1`。这些检查仍按各自质量、许可和权利证据执行；只在其完成后的普通审批环节适用系统裁决。

## 代码路径

- `apps/server/src/video/auto-approval.ts`：策略版本、视频作用域判定和 review→auto 转换。
- `apps/server/src/video/studio-worker.ts`：G1–G7 自动裁决，G5 真实图片事实核验。
- `apps/server/src/video/pipeline-control-plane.ts`：控制面 GateDecision 系统自动签发。
- `packages/video-studio/src/pipeline-control-plane/coordinator.ts`：质量证据齐全后直接生成 auto GateDecision。
- `packages/runtime/src/loop.ts`：通用 Quest review 的自动审批记录与一次执行授权。
- `apps/server/src/video/router.ts`：G8/G9 直连路径的系统审批与 block 保留。
- `packages/base/social-listening/comments.ts`：G10 质量分流后自动执行，敏感词仍 block。

## 审计字段

系统自动审批产生 append-only 事件，至少包含：

- `actor=video-auto-approval`
- `policyVersion=workloom.video-auto-approval/v1`
- 原围栏/质量级别与命中规则
- 质量检查依据
- 产物或发布包 SHA-256（存在时）
- 自动审批理由
- 后续执行或失败回执

自动审批生成的 `approvals` 行（如运行时需要一次性授权）状态直接为 `approved`，
`decided_by=video-auto-approval`，不会进入 `pending` 队列。

## 回滚

设置 `VIDEO_AUTO_APPROVAL=0` 并重启服务后：

1. 恢复旧的人工审批路径；
2. `block` 和所有质量/预算检查保持不变；
3. 已写入的自动审批事件和 GateDecision 保留，不做历史覆盖；
4. 新产生的审批才回到 `pending` / `pending_review`。

## 非目标

- 不删除原有质量审核规则。
- 不把 `block` 降级为 `review` 或 `auto`。
- 不把失败、超时、缺回执或未知供应商状态标成成功。
- 不改变登录态、凭据、平台风控、事实红线或用户预算上限。
