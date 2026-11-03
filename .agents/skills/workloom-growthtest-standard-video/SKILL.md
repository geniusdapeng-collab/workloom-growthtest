---
name: workloom-growthtest-standard-video
description: 在 workloom-growthtest 仓库中把“用 Growthtest 制作 X 秒某主题视频”等自然语言请求送入原生 Studio，并按项目回执继续正式渲染与后期。适用于实际制作和已有项目的接续。
---

# Growthtest 标准制片

1. 核对当前 GitHub 检出是 `geniusdapeng-collab/workloom-growthtest`，按[本仓接入指引](../../../docs/AGENT-CLIENTS.md#独立本机源码会话)核对独立实例、成员权限、素材授权和预算。
2. 实际制作走[原生 Studio 自动分流](../../../docs/ai-video-workbench-guide.md#一句话启动标准制片)。使用 `node scripts/workloom-source-session.mjs studio -- start --work-root <本次作业目录> --input-file -`，把用户原话和明确的目标秒数传为 `intent` 与 `durationSec`。镜头数量和时长分配由当前管线决定。明确只要方案时使用指南里的只读预览或经授权的文字方案。
3. 保存作业目录、项目号和运行号。等待审批时继续原审批。启动或派发结果未知时查同一实例的项目、档案及供应商任务；禁止换目录重复提交。
4. 按[正式渲染与后期要求](../../../docs/ai-video-workbench-guide.md#3-选择正式入口分清方案前期和渲染)选择当前项目正式路径。正式原稿和 G8 可核实时走固定 Film 工位，以实际签发的原片清单接续标准后期。服务渲染摘要缺少 Film 签发凭据时，保留回执并说明阻断。交付前核验当前成片、摘要和播放；禁止手工补镜头、伪造凭据或用临时拼接替代官方后期。
