---
name: workloom-growthtest-standard-video
description: 在 workloom-growthtest 仓库中把“用 Growthtest 制作 X 秒某主题视频”等自然语言请求送入原生 Studio，并按项目回执继续正式渲染与后期。适用于实际制作和已有项目的接续。
---

# GrowthTest 标准制片

1. 定位准确的 `geniusdapeng-collab/workloom-growthtest` 检出，完整读根级 `AGENTS.md`、`AGENTS.repo.md`、[接入指引](../../../docs/AGENT-CLIENTS.md)、[正式入口](../../../docs/video-native-agent-entry.md) 和 [工作台指南](../../../docs/ai-video-workbench-guide.md)。仓库在工作区子目录时也显式定位根目录。
2. 重开聊天从 `WORKLOOM_GROWTHTEST_PROFILE` 指定的绝对路径，或默认 `~/.workloom/growthtest/client-profile.json` 找到既有无秘密 profile。由 Agent 用其准确 Node 和仓库入口执行 `workloom-client-setup.mjs check`；`doctor` 回读固定 `jobFile`，才证明当次连接。保留正常目录信任与调用权限，不让用户重复手填环境；缺少必需授权会话时如实报告。
3. 先查 profile 固定 `jobRoot`/`jobFile` 的 `video -- status`，禁止猜最新项目。已有工作单沿用原项目、用途和 `executorCommit`，`start_unknown` 只对账，不换文件重发、不篡改回执来源。新任务才按正式 `video -- start` 传用户原话、明确时长和已知业务事实；提示词任务保留 `purpose: prompt-review`，按同一工作单 `prompts`/`resume-prompts` 接续，禁止把提示词资格当成渲染授权。
4. MCP 仅按实际已列出的只读工具发现与查询，生产写操作走正式 CLI。客户端、GitHub 和产品成员是独立身份；每次执行核对服务 sourceCommit、实例、tenant/workspace/member 和权限。独立实例、素材授权与预算沿用统一指南。
5. 按正式入口绑定渲染资格、供应商任务、已入库原片和标准后期；参考素材未绑定时停在付费前。只有回读当前交付文件及其摘要通过才交付。
