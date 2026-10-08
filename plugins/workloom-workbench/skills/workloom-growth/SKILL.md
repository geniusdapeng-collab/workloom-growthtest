---
name: workloom-growth
description: WorkLoom 增长域（growthtest 实验）工作流。用于 GEO/AI 答案可见度、双域内容工厂、选题情报融合、经营节拍、投放优化、公网发布与信源分发等增长任务。仅显式调用（$workloom-growth），避免误触发高风险动作。
---

# 增长域能力（geo-growth）

本技能描述 `workloom-growthtest` 的增长域能力。执行前先用 `workloom_catalog_search` 与 `workloom_catalog_describe` 核对实时能力目录，不要凭本文件里的静态描述直接执行。

涉及视频时先调用 `workloom_video_guide({})` 或读 `workloom://guides/video` 全文，冻结模特/商品/平台/时长/账号/声音/特殊要求。
使用本仓正式前期、渲染、后期和实际交付核验；读取指南不启动生产，不用手工流程绕过缺失入口或原声合同。

## 四条主管线

| 管线 | 能力 ID | 作用 | 关键闸门 |
|---|---|---|---|
| 选题情报双向流动 | `pipeline:intel-fusion` | 情报站统一情报卡 → 双用选题 → 清晨决策包裁决 → 双域排产 | 决策包 |
| 内容一次生产两处变现 | `pipeline:dual-content-factory` | 脚本成套 → 实拍/AI 分流 → 人审 → GEO 六段式改写 → 事实红线 → 外发双审 → 双域分发 | G9、G-GEO1、G-GEO2、G-VIS1 |
| AI 能见度监测 | `pipeline:visibility-watch` | 多平台采样 → 可见度对比 → 异常告警复核 | 告警复核 |
| 双域经营节拍 | `pipeline:ops-rhythm` | 日/周经营节拍与复盘 | 经营节拍闸门 |

## 关键纪律（来自围栏与岗位定义）

- **G9 公网发布必审**：任何社媒/信源外发都要人审；新平台首发与单账号日发布超限（≥5 条）另有加严/熔断规则。
- **G-GEO1 外发必审 + G-GEO2 事实红线**：GEO 内容与实体卡逐字一致，事实不符一票否决。
- **G12 加投必审**：预算拍板权永远在人，投放优化师只建议不执行。
- **G-VIS1 视觉素材审核**：封面/图文/信源配图的事实与价格必须与实体卡一致。
- **演示与真实分明**：模拟数据必须标注；不得伪造平台成功回执。

## 典型工作流

1. 用户说"看今天增长战况"→ `workloom_stage_snapshot`（或 `workloom_stage_url`）→ 用工作台视角汇报在岗、运行、待审批、KPI。
2. 用户说"跑能见度监测"→ 先 `workloom_catalog_describe pipeline:visibility-watch`，说明采样平台与费用/闸门，再给出执行方案。
3. 用户说"发一条内容"→ 先查 `pipeline:dual-content-factory` 的步骤与闸门，明确指出必须经 G9/G-GEO1/G-GEO2 人审；P0 阶段只给方案，不执行。
4. 用户说"加投"→ 引用 G12，说明只能由人拍板；给出数据快照与建议动作。

## P0 边界

网关当前只读：`catalog_search`、`catalog_describe`、`stage_snapshot`、`stage_url`、`health`、`video_guide`。任何"启动/发布/加投/审批"动作都还没有写权限；不要虚构执行结果。
