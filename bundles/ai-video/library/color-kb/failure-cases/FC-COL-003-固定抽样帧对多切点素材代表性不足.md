# FC-COL-003 固定抽样帧对多切点素材代表性不足

| 字段 | 内容 |
|---|---|
| 编号 | FC-COL-003 |
| 发现日期 | 历史遗留（代码注释记载；随 729be0a 于 2026-09-24 入库） |
| 严重度 | 中 |
| 状态 | 已修复（T-02 补全：场景切分自适应抽样，2026-09-27） |

## 症状

多切点素材（混剪、快切宣传片）按 1–2 帧抽样做诊断/校正：校正参数只对抽样那一刻的画面负责，其余镜头欠曝/偏色依旧；复检指标"达标"但观众看到的成片各镜跳变明显。

## 检测器

- 检查 `grade`/`analyze` 实际使用的抽样时间戳：`verifyAt`/`at` 数组长度 < 4 且素材含多切点，即命中风险（core.mjs:715-716）。
- 判据：对成片逐镜（或按 `defaultTimestamps` 4 点）跑 `frameStats`，比较各点 YAVG/UAVG/VAVG 离散度——任一指标跨点波动超出目标值表容差（YAVG 区间 80–140、U/V ±6），说明单点抽样不代表全片。
- 多镜残差判据（match）：|ΔYAVG| ≤ 5、|ΔUAVG|/|ΔVAVG| ≤ 3（color-grade/SKILL.md 第 5 步）。

## 根因

早期实现用 1–2 帧代表整片。多切点素材不同镜头曝光/色温差异大，单点统计被当前帧主导，据此推导的自动校正参数（`autoCorrections`）对其它镜头失真。core.mjs:715 注释："校验帧：默认 4 帧（首段/前中/后中/尾段），避免用 1–2 帧代表整片（多切点素材会失真）"。

## 处置

`defaultTimestamps`（core.mjs:400-404）按时长 10% / 35% / 60% / 85% 取 4 个去重时间点作为默认抽样；`grade` 的校验帧、`analyze` 的诊断帧、`best` 的 look-dev 抽样（maxSamples=4）统一走该默认，且全部允许调用方显式传 `at`/`verifyAt`/`sampleAt` 覆盖。

## 预防措施

- 已知切点密集的素材，按切点表显式传抽样时间，不依赖默认 4 帧。
- 诊断报告保留 `perFrame` 明细（core.mjs:561），复核时不得只看 summary 均值。
- 多镜成片必须走 `colorwrite.match` 以参考镜为基准匹配并复检残差，禁止逐镜各自自动校正。

## T-02 补强（2026-09-27）

默认 4 帧仍是"均匀抽样"——切点密集时仍可能整段漏采。现在 `analyze`/`grade`/`best` 默认走
`sampling=scene`：`select='gt(scene,0.3)',showinfo` 检测切点 → 分段 → **每场取中段代表帧**
（最多 6 帧，超出时把时间轴等分、每窗取最长段）→ 指标按**场景时长加权**聚合；场景 ≤4 时
退回 10/35/60/85% 均匀四帧（历史行为可回归）。抽样元信息（切点数、代表帧、权重）随报告留痕。

## 关联

- 代码：`bundles/ai-video/connectors/color-bridge/core.mjs`（`detectSceneCuts` / `sceneSegments` / `sceneSampleTimes` / `planSampling` / `summarize(stats, weights)`）
- SKILL 引用：`color-grade/SKILL.md` 方法第 2 步（场景切分抽样）、第 5 步（残差目标）
- 入库提交：`729be0a`
