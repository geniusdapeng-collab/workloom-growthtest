---
name: producer-gate-review
description: 预生产内部门（G1–G7）的 AI 监制评审纪律：确定性硬闸前置、逐环节评审要点、放行/打回裁决口径与留痕要求。绑定制片人岗位与 G1–G7；卸载即撤销（内部门回到人审）。
---

# 监制门评审（Producer Gate Review）

## 适用场景
- 预生产内部准备门（G1 情报 / G2 主题 / G3 对齐 / G4 PRD / G5 定妆照 / G6 提示词 / G7 预生产收口）
- 全链路出片（`scripts/tools/full-chain-film.mts`）里的关键帧、镜头、调色、字幕、弹幕、配乐、封面、母版评审

## 方法
1. **先硬闸后模型**：空内容、`undefined`/`[object Object]` 占位、内容过短、定妆照 `completedPortraits=0`、
   分辨率/时长/音轨不符 —— 命中即打回，不调用模型（省额度、结论可复算）。
2. **再按环节要点评审**：用 `packages/video-studio/src/producer-gate.ts#PRODUCER_RUBRICS` 的标准；
   图像类评审必须把**待评审产物**与**基准图**一起给模型看（产物优先占配额，基准图最多 2 张）。
   2026-09-27 起 `keyframe`/`shot`/`master` 三个环节各多两条**必判**类目：
   - **环境真实性**：空间是可指认的真实场所（不是平均样板间）——材质带工艺与使用状态、灯光含场景内实用光源、
     画面留有使用痕迹；判红"无痕样板间 / 一眼影棚 / 材质只写一级名词 / 空间空旷到与人物活动不符"（与
     `scene-bible.ts#environmentDefects` 同源，见 `docs/environment-realism.md`）；
   - **道具-人体交互逻辑**：被手持/被操作的器物必须有成立的物理关系——**屏幕朝向它的使用者**
     （观众只见机身背面或侧缘，不出现屏幕内容正对镜头）、有承重接触、手指正常；
     `shot` 环节额外判"这一关系在整镜时间轴上保持不变"（关键帧对、镜内翻转同样要打回）。
     出处：真机 badcase「手机屏幕朝观众」（`docs/badcases/BADCASE-2026-0927-phone-screen-toward-audience.md`）。
   - **设备口径**：画面里的电子设备（笔记本/台式机/手机/平板/显示器/耳机/键鼠）全部是 **2024 年后世代的 Apple 在售机型**，
     且与镜头卡 `devices[]` 声明的机型一致（机身比例/材质/颜色/接口可辨）；`shot`/`master` 额外判"跨帧跨镜同一台设备外观一致"。
     允许清单见 `device-policy.ts#DEVICE_ALLOWLIST`、口径见 `docs/device-standard.md`。
3. **裁决三类**：放行（approved）/ 打回重跑（rerun）/ 需介入（模型不可用或超预算）。
4. **打回必须可执行**：写清"改什么、改成什么、为什么"——例如"用 img2img 挂 4 张授权真人照片重跑，锁面孔"。
5. **留痕**：每次裁决写 `gate`、`score`、`via`（deterministic/llm/fallback）、`model`、`issues`、`suggestions`，
   落五元事件账本；`degraded=true` 表示"模型不可用但硬闸全过"，必须显式可见。

## 输出契约
- 每次评审：`{approved, score, hardFailures, issues, suggestions, rerun, via, model, ms, reason}`
- 全链路运行：`<work-dir>/logs/stages.jsonl`（逐环节）+ `stage-summary.json`（汇总，含未调用/降级/复用计数）

## 边界
- 不替代花钱门（G8 渲染提交）与对外门（G9 发布 / G10 评论回复）的人审。
- 不静默放行：模型不可用时默认拒绝，除非显式配置 `HR_PRODUCER_FALLBACK_APPROVE=1`（会标 `degraded`）。
- 不做"AI 自评自过"：定妆照与关键帧这类视觉产物必须带基准图比对；没有基准图时只能判画质与纪律，结论里要写明。

## 失败诊断（症状 → 检测器 → 处置）

| 症状 | 检测器 | 处置 |
|---|---|---|
| 监制只收到路径清单 → 判"无正文可核验" | 评审输入检查：正文预算（单文件 ≤1600 字、总量 ≤12000 字） | 按预算补送正文后重评；**不得凭路径清单出"通过"结论** |
| 模型不可用却给出"通过" | `via` 标记 + `degraded` 检查 | fail-closed 默认拒绝；仅显式 `HR_PRODUCER_FALLBACK_APPROVE=1` 时可放行且必须标 `degraded` |
| 硬闸被跳过、直接进模型评审 | 硬闸前置检查（空内容/占位符/过短/`completedPortraits=0`/分辨率时长音轨） | 判流程缺陷：回退重评并登记；硬闸结论必须可复算 |
| 视觉产物无基准图却下"像/不像"结论 | 基准图在场检查（产物优先占配额，基准图 ≤2 张） | 只能判画质与纪律并写明；需要一致性结论时先补基准图 |
| 打回无定位，创作者反复试错 | 打回可执行性检查 | 退回评审，补齐"改什么 / 改成什么 / 为什么" |
| 裁决没有落账 | `stages.jsonl` 门事件（gate/score/via/model/issues/suggestions） | 视为未评审：重跑该门并补落账 |
| 超预算仍在评审 | 预算检查 | 转"需介入"，不烧额度继续评审 |
| 画面"符合镜头卡"但一眼不像实拍 | `env-realism` 机检（渲染前）+ 环境真实性 rubric | 判**卡片空词**（不是模型问题）：补 `sceneBible` 后重渲，并登记环境 badcase |
| 屏幕内容正对镜头 / 道具漂浮穿模 | 道具-人体交互 rubric（keyframe/shot） | 打回并要求补 `propInteraction`（朝向/操作者/承重/遮挡） |
| 出现杂牌设备 / 旧世代机型 / 非 Apple 标识 | 设备口径 rubric（keyframe/shot/master）+ `device-*` 机检 | 打回并要求按 `docs/device-standard.md` 补/改 `devices[]` 与场景描述 |
