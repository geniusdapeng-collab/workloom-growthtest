# FC-COL-002 灰世界白平衡在大面积单色场景误判

| 字段 | 内容 |
|---|---|
| 编号 | FC-COL-002 |
| 发现日期 | 历史遗留（代码自注；随 729be0a 于 2026-09-24 入库） |
| 严重度 | 中 |
| 状态 | 处置中（已降级为 low confidence 并引导提供 neutral 灰区） |

## 症状

强彩光/大面积单色场景（舞台灯光、纯色背景棚拍、黄昏整片暖橙）白平衡校正方向错误：把场景真实的色彩氛围当成偏色"修掉"，画面发灰、氛围被抹平；或反向放大色偏。

## 检测器

- `colorread.analyze` 回执检查 `whiteBalance.confidence` 与 `source` 字段：`confidence: "low"` + `source: "gray-world"` 即触发本风险（core.mjs:509-515）。
- 中性色度判据：`|UAVG-128| > 6` 或 `|VAVG-128| > 6` 且画面为已知大面积单色场景时，禁止直接采信 gray-world gains。
- 复核命令：`ffmpeg -ss <t> -i <input> -frames:v 1 -vf "scale=1:1:flags=area,format=rgb24" -f rawvideo -`（即 `regionAverageRgb` 全帧取样路径），确认全帧平均色被单色主导。

## 根因

未提供 `neutralPatch` 时，`analyze`（core.mjs:506-515）退化为灰世界假设——把整帧平均色拉成中性灰。灰世界假设在"全帧平均本应接近灰色"时成立，但大面积单色场景违反该假设，于是 gains 把真实氛围色误判为偏色。代码自注："未提供 neutral 灰区，按灰世界估计，强彩光场景不可靠"（core.mjs:514）。

## 处置

- 代码层：gray-world 路径结果固定标 `confidence: "low"`、`source: "gray-world"`，与 neutral-patch 的 `confidence: "high"` 区分，白平衡问题单（`white_balance` issue）只在 high confidence 下开具（core.mjs:517-527）。
- 流程层：诊断时要求有灰卡/白墙/中性灰区必须传 `neutral_patch` 精确取样（color-grade/SKILL.md 方法第 2 步）。

## 预防措施

- 强彩光/单色场景片单在 analyze 前人工确认是否存在可信中性区；无中性区时只做保守校正，不做自动白平衡。
- 回执中 `confidence: low` 的白平衡结果不得直接进入 `auto` 校正链，必须人工确认或补取样。
- 长期：探索多帧/多区域中性候选自动探测，降低对人工 neutral_patch 的依赖。

## 关联

- 代码：`bundles/ai-video/connectors/color-bridge/core.mjs:496-527`（analyze 白平衡段）
- SKILL 引用：`color-grade/SKILL.md` 方法第 2 步（neutral_patch 精确取白平衡）、第 3 步（先校正后创作）
- 入库提交：`729be0a`
