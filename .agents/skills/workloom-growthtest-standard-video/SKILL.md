---
name: workloom-growthtest-standard-video
description: 在 workloom-growthtest 仓库中把“用 Growthtest 制作 X 秒某主题视频”等自然语言请求送入原生 Studio，并按项目回执继续正式渲染与后期。适用于实际制作和已有项目的接续。
---

# GrowthTest 标准制片

1. 核对 GitHub 官方仓库及默认分支，按 [接入指引](../../../docs/AGENT-CLIENTS.md) 核对独立实例、成员权限、素材授权和预算。
2. 正式制作使用 [原话入口](../../../docs/video-native-agent-entry.md) 的 `video start`。把用户原话、明确时长和已知业务事实作为输入，镜头数和时长由 Studio 分流及当前管线决定。已有 `studio` 回执的作业保留原项目号。
3. 用同一工作单的 `video status` 读前期。遇到审批处理原审批；结果未知就核对原项目和供应商记录。
4. 按同一指南用 `video-deliver` 绑定正式资格、供应商任务、已入库原片和标准后期。参考素材未绑定时先停在付费前。只有回读当前交付文件及其摘要通过才交付。
