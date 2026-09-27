# FC-COL-004 S-Gamut3.Cine 色域矩阵缺失导致 log 素材饱和异常

| 字段 | 内容 |
|---|---|
| 编号 | FC-COL-004 |
| 发现日期 | 历史遗留（manifest.json 自注；随 729be0a 于 2026-09-24 入库） |
| 严重度 | 高 |
| 状态 | 已修复（T-21） |

## 症状

Sony S-Log3 / S-Gamut3.Cine 素材套 `slog3-to-rec709.cube` 转换后：影调正常但高饱和区域（霓虹、红唇、LED 屏、产品纯色）饱和度异常或色相偏移，极端色域素材偏色明显。

## 检测器

- `colorread.probe` 读取 `color_primaries` / `color_space`：非 bt709 且 `color_transfer` 为 log 系（或 analyze 判出 `log_or_flat` issue，core.mjs:546-556）即进入本风险区。
- 出片后用 `signalstats` 复检：`SATAVG` / `SATMAX` 与同类 Rec.709 素材基线对比异常；高饱和像素占比可用 `frameQuality` 的 `oversatPct`（sat>0.92 且 mx>60，core.mjs:990）量化。
- 工具：`colorread.analyze` 的 `log_or_flat` 判据——`color_transfer=arib-std-b67/smpte2084` 或 `YMAX-YMIN < 120`（动态范围偏平）。

## 根因

`bundles/ai-video/library/luts/manifest.json` 自注：slog3-to-rec709.cube"仅做色调曲线转换（S-Log3 码值→线性反射率→BT.709 OETF），未做 S-Gamut3.Cine→BT.709 色域矩阵；极端色域素材请先确认色域或补矩阵"（manifest.json:8）。色域比 BT.709 宽的素材只做 OETF 转换，宽色域颜色被直接映射/裁剪进 BT.709，饱和与色相失真。

## 处置

- ~~manifest 中对该 LUT 明确标注缺口与使用限制~~（T-21 已移除缺口自注）。
- **修复落地（T-21，2026-09-27）**：新增 `sgamut3cine-to-rec709.cube`（33³ conversion LUT，Sony 官方 S-Gamut3.Cine→XYZ 矩阵 × ITU-R BT.709 逆矩阵，线性光域 3×3；LUT 输入/输出为 BT.709 码值域，串接在 `slog3-to-rec709.cube` 之后，复合 = S-Log3 解码→线性→色域矩阵→BT.709 编码）。`core.mjs` 的 `resolveConversionLuts()` 在 S-Log3 + S-Gamut3.Cine（`source_transfer`/`source_gamut` 参数或元数据指示）时自动链式应用双 LUT，恒 100%、置于校正之前；色域无法确定时保持仅 OETF 转换并在 `conversion.note` / `verifyWarnings` 注明。

## 预防措施

- log 素材入场先跑 `colorread.probe` + `colorread.analyze`，`log_or_flat` 命中的素材禁止跳过转换 LUT 直接套创意 LUT（color-grade/SKILL.md 第 1 步）。
- 转换后必须复检 SATAVG/oversatPct 与人眼抽帧，发现饱和异常先确认色域元数据是否指示 S-Gamut3.Cine 并检查双 LUT 是否真链上（报告 `conversion.luts` 字段），不盲目降饱和掩盖。
- 回归防线：`luts.test.ts` 已覆盖矩阵系数（对 Sony/BT.709 公开合成值 ±2e-3）、灰轴中性（33 格点精确）、关键采样点容差与链式复合语义；`generate-luts.mjs --check` 保证磁盘产物与生成器一致。

## 关联

- 文件：`bundles/ai-video/library/luts/manifest.json:5-9`（source.note 缺口自注）、`generate-luts.mjs`
- 代码：`bundles/ai-video/connectors/color-bridge/core.mjs:546-556`（log_or_flat 检测）
- SKILL 引用：`color-grade/SKILL.md` 方法第 1 步（log 必须先转换）
- 入库提交：`729be0a`
