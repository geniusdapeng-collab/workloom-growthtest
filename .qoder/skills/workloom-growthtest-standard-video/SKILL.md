---
name: workloom-growthtest-standard-video
description: 将 GrowthTest 自然语言视频或提示词任务接到本仓正式 CLI，并以原工作单接续。适用于 Qoder 中实际制作、查状态和恢复已有任务。
---

# GrowthTest 标准制片

这是 Qoder 的薄发现入口，正式流程统一位于 [接入指引](../../../docs/AGENT-CLIENTS.md)、[正式视频入口](../../../docs/video-native-agent-entry.md) 和 [工作台指南](../../../docs/ai-video-workbench-guide.md)。先定位准确的 `geniusdapeng-collab/workloom-growthtest` 仓库根目录，读取 `AGENTS.md`、`AGENTS.repo.md`，再完整读这三份指南。

重开聊天先找 `WORKLOOM_GROWTHTEST_PROFILE` 指定的绝对路径，或默认 `~/.workloom/growthtest/client-profile.json`，由 Agent 使用 profile 中的准确 Node/仓库执行 `scripts/workloom-client-setup.mjs check` 与 `doctor`。check 仅核验本地；doctor 只读固定 `jobFile` 并核对当次服务、原 `executorCommit`、实例和 tenant/workspace/member。保留正常 trust、项目 MCP 授权和工具权限；同名技能在 Qoder CLI/IDE 的优先级分别核验，不依赖覆盖规则。

先用 `video -- status` 查询固定 `jobRoot`/`jobFile`，不猜最新项目。已有任务保留原项目、成员、用途与来源提交，`start_unknown` 只对账，禁止换文件重发或改回执。新任务沿正式 `video -- start` 传用户原话、明确秒数及已知事实；提示词任务保持 `purpose: prompt-review`，用同一工作单 `prompts`/`resume-prompts` 接续，提示词资格不等于渲染授权。

MCP 只负责实际已列出的只读发现/查询，生产写操作使用正式 CLI；Qoder 登录、GitHub 身份与产品成员权限不能互相替代。素材、预算、正式渲染、标准后期和交付核验全部遵循统一指南；文件存在、配置生成、方案或运行排队不能冒充接通或成片。
