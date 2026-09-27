# FC-COL-006 只有统计目标没有画质目标，把已调好的成片调坏

| 字段 | 内容 |
|---|---|
| 编号 | FC-COL-006 |
| 发现日期 | 2026-09-21（SKILL.md 事故复盘记载；随 729be0a 于 2026-09-24 入库） |
| 严重度 | 高 |
| 状态 | 已修复 |

## 症状

对一支已经调好的成片自动调色，输出亮度 +33.6、饱和 +46%、高光裁切 1.6%——指标"更贴近目标区间"但画面明显劣化，用户原话"还没有原片好"。

## 检测器

- 画质分（scoreQuality，core.mjs:1053-1098）：基准 100=原片，候选分 <100 即劣化；`colorwrite.best` 最高分未超阈值（默认 +2）时 verdict=`no_change_needed`，不产出文件。
- 关键罚项判据：对比度/清晰度下降（detailRatio<1 重罚）、裁切增加（clipDelta 每 +1pct 扣 2.5）、亮度漂移（每级 0.15 分）、原片曝光健康（YAVG 80–140）却被拉出区间（brokeExposure 再扣 10）。
- 复检：grade 回执 `delta`（YAVG/UAVG/VAVG/SATAVG 前后差）出现单项剧烈跳变（如 YAVG +30 以上）必须人工复核。

## 根因

早期自动调色只把"统计量塞进目标值表区间"（YAVG 80–140、SATAVG 40–80 等），没有画质目标：不考虑原片是否本来健康、不考虑对比度/清晰度/裁切是否受损。color-grade/SKILL.md:45 复盘原文："根因是没有画质目标，只有统计目标"。

## 处置

- 引入 `frameQuality`（rmsContrast/tonalRange/satMean/oversatPct/colorfulness/sharpness/裁切占比，core.mjs:976-1031）与 `scoreQuality` 打分：对比度/清晰度下降重罚、裁切零容忍、亮度漂移受罚，"朝健康区间移动"才有有限奖励（core.mjs:1067-1084）。
- `colorwrite.best` 成为默认入口：候选池含"原片不动"，最高分不过阈值即判"无需调色"、不写任何文件（do no harm，core.mjs:1256-1270）。

## 预防措施

- 任何自动调色路径必须先过 `best` 择优，禁止跳过打分直接 grade（color-grade/SKILL.md 第 0 步）。
- 目标值表只作校正参考，不作"强行对齐"依据；原片已在健康区间的素材默认不动。
- 打分权重表（对比度/清晰度/裁切/过饱和/亮度漂移）评审后变更，随 SKILL.md「画质分怎么算」节同步。

## 关联

- SKILL 引用：`color-grade/SKILL.md` 第 0 步择优 + 2026-09-21 事故复盘段
- 代码：`bundles/ai-video/connectors/color-bridge/core.mjs:1033-1098`（scoreQuality）、`core.mjs:1161-1170`（best 流程注释）
- 入库提交：`729be0a`
