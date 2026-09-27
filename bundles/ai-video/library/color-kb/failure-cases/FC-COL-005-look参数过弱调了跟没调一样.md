# FC-COL-005 look 参数过弱——"调了跟没调一样"

| 字段 | 内容 |
|---|---|
| 编号 | FC-COL-005 |
| 发现日期 | 2026-09-21（SKILL.md 事故复盘记载；随 729be0a 于 2026-09-24 入库） |
| 严重度 | 高 |
| 状态 | 已修复 |

## 症状

对成片应用 profile/LUT 后交付，用户反馈"看不出任何区别"：成品与调色前平均像素差仅约 1.5%（Δ≈1.5%），调色环节形同空转但流程上"已完成"。

## 检测器

- 可见性度量（硬性判据，core.mjs:765-776 + frameDifference core.mjs:1312-1343）：平均像素差 `<2/255` 记 negligible → `verify_failed` 拒绝出片并删除产物；`2–4` 记 subtle 回执带提醒；`≥4/255` 记 visible 方可交付。
- 复现命令：`colorwrite.grade` 出片后回执读 `visibility.verdict` 与 `visibility.meanAbsDiff`；或人工用 `compareFrames` 出前后对比帧。

## 根因

早期内置 look 参数只有 ±0.04 量级（core.mjs:578-579 注释："早期版本参数过弱（Δ≈1.5% 像素差）导致'调了跟没调一样'"），低于人眼可辨阈值；且当时没有可见性校验，出片不验证"画面是否真的变了"，弱参数静默通过交付。color-grade/SKILL.md 硬红线节 2026-09-21 事故复盘同载此事。

## 处置

- 按可见性校验重标定全部内置 profile 参数（core.mjs PROFILES：clean-bright / warm-film / cool-technical / teal-orange / moody-dark / high-contrast-social / vintage-fade），量级对齐行业通行 look（intensity=1.0 的画面语言）。
- 新增 `frameDifference` 可见性度量并接入 `grade`：fail-closed——调用方要了 look 却 negligible，直接抛 `verify_failed` 并删除产物（core.mjs:769-776）。
- luts/manifest.json 为每个创意 LUT 补注："低于 0.6 强度基本看不出变化，交付前必须过可见性校验"。

## 预防措施

- 交付规范把可见性度量列为证据包必备项：visible 方可作为"已调色"交付；subtle 必须说明理由（color-delivery-spec/SKILL.md 第三章）。
- 新增/修改 profile 或 LUT 参数时，必须跑一遍 intensity=0.6/0.8 的可见性回归，禁止只改数不验证。
- 强度默认 0.8、起步区间 0.6–0.8 写入选型表，避免调用方用过低强度复现本事故。

## 关联

- 代码：`bundles/ai-video/connectors/color-bridge/core.mjs:577-606`（PROFILES 重标定注释）、`core.mjs:765-776`（可见性 fail-closed）、`core.mjs:1312-1343`（frameDifference）
- SKILL 引用：`color-grade/SKILL.md`「硬红线·必须真的看得见」；`color-delivery-spec/SKILL.md` 第三章证据包第 5 条
- 入库提交：`729be0a`
