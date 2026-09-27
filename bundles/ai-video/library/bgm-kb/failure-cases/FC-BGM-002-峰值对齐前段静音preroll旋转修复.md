# FC-BGM-002 峰值对齐把整条音乐床延后——前 25.7s 数字静音

| 字段 | 内容 |
|---|---|
| 编号 | FC-BGM-002 |
| 发现日期 | 2026-09-24（提交 729be0a） |
| 严重度 | 高 |
| 状态 | 已修复 |

## 症状

30s 成片里 0–25s 完全没有音乐，只有最后 4.3s 有声。产品所有者反馈"听不到你新合成的 BGM"。实测 `ducked-music.wav`：0–25s = -120dBFS（数字静音），仅 25–30s 有 -21.7dBFS。监制此前无法从指标察觉——`musicPresenceDb` 只与"环境底噪"比较，前段静音不触发任何告警。

## 检测器

- 结果级回归（structure.test.ts）：断言"混音 − 原片"前 3s 残差 RMS > -40dBFS——旧实现≈静音必然失败。
- 单元回归（`bundles/ai-video/connectors/bgm-bridge/preroll.test.ts`）：`prerollPhaseSec` 相位落点/区间/非法参数三组用例，直接复现真机参数（选段 9.5s、段内峰值 1.5s、片子高点 27.233s → 相位 2.767s）。
- 实测命令：`ffmpeg -i ducked-music.wav -af astats=metadata=1` 或 `silencedetect` 检查前段电平；0–5s 应为有声（修复后全程 -25.7…-23.4dBFS）。
- 回执审计：`section.preroll`（相位/时长/理由/旧缺陷说明）与 `filmPeakAlign.mode=preroll-loop`、`peakLandedAtSec`——"是否发生过静音"可审计。

## 根因

`--section auto` 的高潮对齐早先通过**整条音乐床 adelay 25.733s** 实现：为了让 drop 峰值落在片子高点 27.233s，把整条选段往后延迟，段前没有任何音乐填充。峰值"对齐"了，代价是前 85% 片长静默。修复后改为**相位预卷**：`prerollPhaseSec()`（core.mjs:1203）计算 `phase = ((anchor − filmPeak) mod L + L) mod L`，需要"整段延后"才能对齐时，改为旋转选段生成 `section-prerolled.wav` 后从 0s 循环铺满（core.mjs:1510-1540），`sectionPlaceOffsetSec` 归零，峰值仍落在片子高点。

## 处置

- 提交 `729be0a`（2026-09-24）：core.mjs 新增 `prerollPhaseSec()` 与旋转预卷逻辑；回执新增 `section.preroll`；`filmPeakAlign.mode` 记为 `preroll-loop`。
- 验证：修复后音乐干声全程 -25.7…-23.4dBFS（0–5s 起即有声），人声余量 11.8dB、让位 -8.97dB、母版 -14.1 LUFS / -1.4 dBTP，监制配乐环节 86 分、终审 92 分放行；交付物视频流逐比特一致（md5 b1328292…，只换音轨）。
- 测试：新增 preroll.test.ts（3 用例）；structure.test.ts 改为结果级回归；bgm-bridge 25/25 通过。

## 预防措施

- 任何"对齐"类操作禁止以"前段留空"为代价：延后只能旋转循环，不能 adelay 裸延后。
- 回执必须带可审计的预卷证据（`section.preroll`），监制复核时先看"0s 起是否有声"。
- 指标口径补齐：`musicPresenceDb` 只对比底噪不足以发现前段静音，辅以"混音−原片残差"结果级断言。

## 关联

- 提交：`729be0a` fix(video): 配乐峰值对齐改为相位预卷——修复"前 25.7s 无音乐"导致听不到 BGM [T-2026-0924-0001]
- 代码：`bundles/ai-video/connectors/bgm-bridge/core.mjs:1203`（prerollPhaseSec）、`core.mjs:1510-1540`（旋转预卷与回执）、`preroll.test.ts`（事故注释与回归）
- SKILL 引用：`bgm-score-design/SKILL.md` 三·二节"选段"决策链（高潮对齐纪律）
