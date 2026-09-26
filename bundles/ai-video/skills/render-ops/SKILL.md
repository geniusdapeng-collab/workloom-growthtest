---
name: render-ops
description: 渲染提交纪律官方套件（随 bundles/ai-video 分发，F8.1 官方套件级）：渲染脚本 CMS 版本链管理、三档提交（手动/批量/自动化连锁）、binding-manifest 强制、RenderPipelineGuard 渲染前检查、失败诊断与回填。安装后被渲染师调用；绑定围栏 G8，卸载即撤销（F8.2/L8.3）。
---

# 渲染提交纪律

## 适用场景
- 渲染脚本生成入 CMS 与版本管理
- Seedance 提交（手动单镜/整片批量/自动化连锁三档，G8 审批）

## 方法
1. 脚本入 CMS：MD 正文 + 25/30 字段 JSON + 字符数校验快照；每次修改产生新版本（parent_version 链），禁原地覆盖。
2. 三档提交：手动（点「渲染」单镜提交）/批量（整片提交 + render.poll 轮询回填）/自动化连锁（triggers：render.done → post.compose → publish_task → watch，默认全链 review，信任后逐环降 auto）。
3. 提交前：binding-manifest 强制绑定定妆照清单；过 RenderPipelineGuard；确认 G8 审批通过。
4. 提交后：验证并回填 render_jobs（task_id/script_version/cost/result_url）；失败先诊断再决定重提或转人工，不盲目重试。
5. 时长纪律（计划=执行）：提交时长必须来自镜头卡/渲染脚本的计划时长——脚本正文写「时长: Ns」行或 `fields.durationSec`；**禁止手填估算值**。脚本缺计划时长时先补写再提交；提交接口在严格模式（`WORKLOOM_DURATION_SUBMIT_STRICT=1`）下会对"缺失计划时长/与计划偏差 >1s"直接拒单，并在事件里记录 `duration_provenance`（来源/计划值/请求值/偏差）。

## 输出契约
- 每次提交输出：脚本版本号 + 审批卡引用 + task_id + 成本 + 结果回执。
- 版本 diff 可见，任何回滚有迹可循。
- 无工具回执的关键数字标「未核实」，不得宣称完成（L3.6/E3.7）。

## 前置校验（提交前五查，缺一不提交）

1. **脚本版本**：CMS 版本链 `parent_version` 正确，无未落盘的本地改动；重提必须基于最新版本。
2. **定妆照绑定**：`binding-manifest` 清单齐备并通过 PortraitGuard（无绑定禁止提交）。
3. **审批门**：G8 审批通过且审批卡引用在案（含逐镜 `mode=recheck` 的复核结论）。
4. **计划时长**：脚本正文写有「时长: Ns」或 `fields.durationSec`，且与镜头卡一致；严格模式（`WORKLOOM_DURATION_SUBMIT_STRICT=1`）下缺失或偏差 >1s 直接拒单。
5. **渲染前检查**：RenderPipelineGuard 通过（分辨率/画幅/首帧锚点/负面约束/素材用途 G-MAT1）。

## 失败诊断（症状 → 检测器 → 处置）

| 症状 | 检测器 | 处置 |
|---|---|---|
| 提交被拒：缺计划时长 / 与计划偏差 >1s | 严格模式校验 + `duration_provenance`（来源/计划值/请求值/偏差） | 先补写计划时长或回镜头卡修正；**禁止手填估算值**再提交 |
| 提交后长时间无回填 | `render.poll` 超时（渲染轮询器） | 标记超时并转人工；**不重复提交同一镜**（防重复计费） |
| 渲染任务失败 | `render_jobs` 状态为 failed + 错误码 | 先诊断（模型/平台/参数）再决定重提或转人工；重试上限 3 次且逐次留痕 |
| 同一镜出现多版本、产物对不上 | `parent_version` 链与 `task_id` 对账 | 停止提交并回退到正确版本；产物按版本入库，不覆盖 |
| 成本超出预算 | G11 预算围栏 | 暂停提交并上报，等待人工加预算；不得绕过围栏 |
| 绑定的定妆照与当前镜头卡不一致 | binding-manifest 与卡片比对 | 阻断提交，回 G5 确认/重绑后再提交 |
