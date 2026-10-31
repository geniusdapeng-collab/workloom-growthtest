# WorkLoom 获客增长系统（实验车道） 真机验收报告（RDAS v3.1 · 2026-10-31）

> 规范：`docs/REAL-DEVICE-ACCEPTANCE-SPEC.md`（rdas/v3.1）｜检查单：`docs/acceptance/checklist.v3.json`｜profile：`acceptance/profile.json`（workloom.acceptance-profile/v2）
> 被测版本：`geniusdapeng-collab/workloom-growthtest@6ba121b`（分支 `main`）｜工作区：`geo-growth`｜主包：`geo-growth`｜生成：2026-10-31T15:46:59.222Z

**结论：未验证（L=未验证 / U=未验证 / O=未验证 / P=未验证；证据不完整）**

证据校验缺口（生成报告不等于验收通过）：
- 缺文件：/Users/mac/Documents/Codex/2026-10-30/growthtest-https-cnb-cool-workloom-ai/work/workloom-growthtest-stress-9004/outputs/acceptance/matrix/matrix-summary.json
- 缺文件：/Users/mac/Documents/Codex/2026-10-30/growthtest-https-cnb-cool-workloom-ai/work/workloom-growthtest-stress-9004/outputs/acceptance/ui/ui-probe.json
- 缺文件：/Users/mac/Documents/Codex/2026-10-30/growthtest-https-cnb-cool-workloom-ai/work/workloom-growthtest-stress-9004/outputs/acceptance/experience/experience-report.json
- 缺文件：/Users/mac/Documents/Codex/2026-10-30/growthtest-https-cnb-cool-workloom-ai/work/workloom-growthtest-stress-9004/outputs/acceptance/ux/ux-report.json
- 缺文件：/Users/mac/Documents/Codex/2026-10-30/growthtest-https-cnb-cool-workloom-ai/work/workloom-growthtest-stress-9004/outputs/acceptance/outcome/outcome-report.json
- 缺文件：/Users/mac/Documents/Codex/2026-10-30/growthtest-https-cnb-cool-workloom-ai/work/workloom-growthtest-stress-9004/outputs/acceptance/autonomy/autonomy-report.json
- 缺文件：/Users/mac/Documents/Codex/2026-10-30/growthtest-https-cnb-cool-workloom-ai/work/workloom-growthtest-stress-9004/outputs/acceptance/redteam/redteam-report.json
- 缺文件：/Users/mac/Documents/Codex/2026-10-30/growthtest-https-cnb-cool-workloom-ai/work/workloom-growthtest-stress-9004/outputs/acceptance/soak/soak-report.json
- 缺文件：/Users/mac/Documents/Codex/2026-10-30/growthtest-https-cnb-cool-workloom-ai/work/workloom-growthtest-stress-9004/outputs/acceptance/live/live-report.json
- 缺有效 evidence-index（完整 commit + 实际运行记录）
- regression/summary.json 必须含 path/sha256/commit，裸路径不是执行证据
- regression/summary.json 不属于任何实际执行输出
- 被测源码有未提交改动，完整 commit 不能代表实际执行代码
- L 矩阵缺非零岗位/技能样本（0/0 不能通过）
- L 页面域缺非零路由样本
- 缺体验走查检查结果
- U 域缺检查结果，空 checks 不能通过
- O 域缺真实任务尝试样本
- ADR 缺非零交付样本
- 红队缺实际用例
- 长跑缺实际采样
- P.budget-summary 必须含 path/sha256/commit，裸路径不是执行证据
- P.budget-summary 文件未绑定到通过的实际生产执行
- P.budget-ledger 必须含 path/sha256/commit，裸路径不是执行证据
- P.budget-ledger 文件未绑定到通过的实际生产执行
- P 域没有真实客户端/部署环境实测（缺输入/预览/自检均未验证）
- P 域 fingerprint commit 未知或与验收 HEAD 不同
- P 域缺通过的实际目标探测
- P 域未有就绪真实模型清单
- P 域零任务：生产能力未验证
- U/体验检查必须逐项有 ID/name 和实际 pass 布尔值
- O 域 LLM provider 为替身/未知：真实业务能力未验证

## 一、环境与资产指纹（缺一报告无效）

```
commit=6ba121b0cd3391a03b4b728ff1e95299fcd1ed16 branch=main
dataMode=simulated llmProvider=mock checklist=rdas/v3.1 profile=workloom.acceptance-profile/v2
workspace=geo-growth bundle=geo-growth
seed=未声明 model= promptHash=未声明
environment=local-preview production=false target=(本机预览)
generatedAt=2026-10-31T15:46:59.242Z
```

## 二、覆盖率声明（硬性）

```
检查单条目：276；状态分布：{"unverified":276}
T1: 总数 52；pass 0；fail 0；not-run 52；manual-missing 0
T2: 总数 201；pass 0；fail 0；not-run 201；manual-missing 0
T3: 总数 23；pass 0；fail 0；not-run 23；manual-missing 0
T1 未完成：52 项
未执行/抽样清单及原因：见第十一节；人工项证据约定 outputs/acceptance/manual/<ID>.json。
```

## 三、结果总览（L / U / O / P 四层判定）

| 层 | 通过 / 固定条目（批准不适用） | 失败项 | 判定 | 主要证据 |
|---|---:|---:|---|---|
| L 基础（L0–L16） | 0/118（0） | 0 | 未验证 | matrix/ui/regression |
| U 体验（U0–U8） | 0/56（0） | 0 | 未验证 | ux/experience/研究记录 |
| O 交付（O0–O9 + ADR） | 0/71（0） | 0 | 未验证 | outcome/autonomy/redteam/soak |
| P 生产实测（P0–P3） | 0/18（0） | 0 | 未验证 | live/{transcripts,artifacts,budget} |

## 四、U 域记分卡

| 指标 | 实测 | 阈值/预期 | 结论 |
|---|---|---|---|
| U 自动化 | 未执行 | — | 未验证 |
| U 人工研究项未提交证据 | 42 | 0 | 未验证 |

## 四·一、P 域记分卡（生产环境实测 · v3.1）

| 指标 | 实测 | 阈值/预期 | 结论 |
|---|---|---|---|
| P 域 | 未执行（缺 live/live-report.json） | — | 未验证 |

## 五、O 域记分卡（自主经营交付结果）

| 指标 | 实测 | 阈值/预期 | 结论 |
|---|---|---|---|
| O 任务套件 | 未配置/未执行 | — | 未验证（LLM_PROVIDER=mock） |
| ADR/可靠性 | 未执行 | — | 未验证 |

## 六、ADR / HIR 自主交付表

未执行 autonomy.mjs：ADR/HIR 未验证。

## 七、红线检查（12 条）

| # | 红线 | 结果 |
|---|---|---|
| 1 | 治理被绕过 | 未命中（或未执行） |
| 2 | 关键任务不可完成 | 未命中（或未执行） |
| 3 | 演示与真实混淆 | 未命中（或未执行） |
| 4 | 秘密与客户数据 | 未命中（或未执行） |
| 5 | 无回执宣告完成 | 未命中（或未执行） |
| 6 | 发布门禁未全绿 | 未命中（或未执行） |
| 7 | 假成功 | 未命中（或未执行） |
| 8 | 越权自主 | 未命中（或未执行） |
| 9 | 结果不可对账/造假 | 未命中（或未执行） |
| 10 | 体验/无障碍阻断 | 未命中（或未执行） |
| 11 | AI 未披露/合成内容未标注 | 未命中（或未执行） |
| 12 | 红线判定依赖 LLM 评审 | 未命中（或未执行） |

## 八、统计与校准

| 项 | 值 |
|---|---|
| 样本量（ADR 交付件） | n/a |
| 比例型区间 | Wilson（autonomy-report.json） |
| pass^k | 未执行 |
| LLM judge 校准 | 未执行（红线不得用 LLM judge 单独判定） |
| 版本/成本冻结 | model=；promptHash=未声明 |

## 九、失败与修复清单

无（不代表未执行项已通过；未执行见下节）。

## 十、验收债与豁免

- T1 未完成 52 项；T2/T3 未完成见 coverage.json。
  - L0-04 围栏绑定全部存在（不悬空）（unverified）
  - L0-06 写读一致：只读岗位无写工具；可写岗位有覆盖声明与围栏（unverified）
  - L0-08 组合围栏并集单调（被遮蔽定义的边界不丢）（unverified）
  - L1-01 组合编制全员在编且 ready（unverified）
  - L1-02 运行态围栏 = 组合有效围栏（集合相等）（unverified）
  - L2-03 事件链校验：哈希链一致；seq 空洞告警需给出解释（unverified）
  - L2-04 只增不改：账本不可 UPDATE/DELETE；纠正用新事件（unverified）
  - L2-06 演示态与真实态可辨认（dataMode 标注，界面与数据双处）（unverified）
  - L3-01 全部声明路由可达（PC/移动端/C 端）（unverified）
  - L3-07 权限态正确：无权限入口隐藏而非报错；越权访问被拒且可读（unverified）
  - L4-01 派活：一句话任务可派发并看到拆解/执行轨迹（≤3 步 ≤60s）（unverified）
  - L4-02 审批：三手势可用，实际点按有写回（单件 ≤30s）（unverified）
  - L4-04 关键动作可操作三连：可见 → 真实点按 → 写回（含浮层遮挡扫描）（unverified）
  - L5-01 首次价值：T+20s 内看到“已做什么 + 待拍板 ≤7 件”；首启仪式可跳过（unverified）
  - L5-02 术语一致性：无裸动作码/裸内部 id/裸 ISO 时间上屏（unverified）
  - L6-01 围栏瀑布：auto/review/block 三态行为正确，fail-closed（unverified）
  - L6-03 高风险动作必经人审；审批与事件同事务（unverified）
  - L6-04 紧急制动/暂停可用，二次确认写明生效范围与撤回路径（unverified）
  - L6-05 租户隔离：跨租户/越权查询返回空或 403，不泄漏（unverified）
  - L6-07 秘密不进文件/日志/提交（含 CI 与运行产物）（unverified）
- 豁免/裁剪必须写明：裁了什么/为什么/影响哪条结论/何时补/谁批准；未验证不得写成通过。

## 十一、未覆盖与遗留（诚实清单）

- LLM provider=mock：O 域真实能力与业务结果未验证
- 人工研究与人工项证据目录 manual/<ID>.json：未验证 167 项；详情见 coverage.json 的 evidenceErrors。
- 真手机/读屏/弱网等人工环境项：仅逐项验真后计 pass；文件存在不代表检查通过。
- 长跑（O5）：未验证。

## 十二、证据分级与索引

- **A**＝代码精读得出；**B**＝全量机检/脚本/元数据解析得出；**C**＝抽样得出；**D**＝推断/未验证。真机和业务实测另注明环境、步骤及原始证据；脚本结果不会自动升级为 A。
- 本报告的 276 项复核为脚本证据（B）；其中 0 项通过、0 项失败、0 项有批准的不适用、276 项未验证（D）。脚本不把配置、文件存在或聚合摘要升级为 A 级证据。
- A/C 级代码精读、人工环境或研究结论必须由验收者提供逐项原始材料与阅读/实测范围；本生成器不推定这些工作已完成。
- 证据索引：/Users/mac/Documents/Codex/2026-10-30/growthtest-https-cnb-cool-workloom-ai/work/workloom-growthtest-stress-9004/outputs/acceptance/evidence-index.json；缺索引或回读失败时报告保持未验证。

## 收尾报告（硬性）

- 已完成：报告生成与固定 276 项证据复核（B）；已绑定实际执行并回读的阶段输入：无。验收是否通过以结论 未验证（L=未验证 / U=未验证 / O=未验证 / P=未验证；证据不完整） 为准。
- 未完成/未覆盖：276 项未验证；T1 未完成 52 项；全局证据缺口 32 项，见正文。
- 自主追加事项及理由：无（报告生成器仅复核已执行的证据）。
- 采用的假设：profile 的角色/旅程/阈值/结果契约为本仓权威；未声明处以基座默认值与下限执行。
- 置信度：低（存在失败或未验证，不构成验收通过结论）
- 建议复核：1) 红线检查表；2) ADR/HIR 的夹具过滤与 HMPO 估算方法；3) T1 未完成清单。

## 自检表（硬性）

- [否] 覆盖了任务全部范围，而非挑了容易的部分？（固定 276 项，缺口保留为未验证）
- [是] 没有把可自主完成的事项推给用户，没有以不必要的问句收尾？
- [是] 每个结论有依据、可验证、证据等级标注准确？（仅声明脚本复核范围，未验证不计通过）
- [否] 经得起资深工程师逐项审查？（回读缺口均已列出，生成报告与验收通过分列）
