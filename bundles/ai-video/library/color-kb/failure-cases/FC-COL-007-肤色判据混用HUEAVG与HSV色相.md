# FC-COL-007 肤色判据混用 HUEAVG 与 HSV 色相（绿/青被当健康肤色）

| 字段 | 内容 |
|---|---|
| 编号 | FC-COL-007 |
| 发现日期 | 2026-09-27（调色配乐链路强化集成评审，真实素材实测） |
| 严重度 | 高 |
| 状态 | 已修复（T-01） |

## 症状

有人脸的画面被判"肤色异常"、而绿色/青色画面被判"肤色健康"——判据方向整体反了：

- 真实肤色帧（U=97,V=160）读出 HUEAVG=135°，落在"目标 20–40°"之外 → 报 `skin_tone` 告警；
- 纯绿帧读出 HUEAVG=38°，正好落在 20–40° 内 → 判 healthy。

自动肤色检测上线后问题被放大：检测器（按肤色带找区）明明找到了人肤色区，判定环节却把它否掉，同时绿幕/草地会被当成肤色区。

## 检测器

```bash
# 一帧纯绿与一帧真实肤色，分别读 signalstats 的 HUEAVG 与标准 HSV 换算值
ffmpeg -v error -f lavfi -i "color=c=0x8DD27C:s=64x64:d=0.5:r=5" -c:v libx264 -f mp4 green.mp4
ffmpeg -v error -f lavfi -i "color=c=0xE0B090:s=64x64:d=0.5:r=5" -c:v libx264 -f mp4 skin.mp4
ffmpeg -v info -i green.mp4 -vf "crop=64:64:0:0,signalstats,metadata=print" -f null - | grep HUEAVG
ffmpeg -v info -i skin.mp4  -vf "crop=64:64:0:0,signalstats,metadata=print" -f null - | grep HUEAVG
```

判据：若"绿色帧 HUEAVG ∈ [20,40]"或"肤色帧 HUEAVG ∉ [20,40]"，即命中本案例。

## 根因

两把尺子混用：`TARGET.skinHue = [20, 40]` 来自**标准 HSV 色相**（人眼/设计语境下肤色的常识区间），
而实现直接拿 ffmpeg `signalstats` 的 `HUEAVG` 去比。`HUEAVG` 是**复合色度相位角**：

```
HUEAVG = (180/π)·atan2(U−128, V−128) + 180   （mod 360；FFmpeg libavfilter/vf_signalstats.c:485）
```

两者在色相环上差一个近似"180° 镜像 + 色轴旋转"的映射：实测红 0°(HSV)↔161°、黄 60°↔99°、
绿 120°↔38°、青 180°↔341°、蓝 240°↔279°。因此用 HUEAVG 套 HSV 区间，等价于把判据区间错位到
绿色/青色附近。

## 处置

- 新增 `standardHueFromUv(u, v)`（`color-bridge/core.mjs`）：BT.601 YCbCr → RGB 差量 → 标准 HSV 色相；
- 肤色判定改用它（`skin.hue`），并把原始 `HUEAVG` 以 `skin.hueFfmpeg` 保留为证据；
- 实拍校验（同口径换算）：浅肤色 22.9°、小麦 25.3°、深肤色 28.0°，全部落在 20–40°；纯绿 108–120°，中性灰返回 null；
- 回归用例：`core-bridge/core.test.ts` 的「T-01 口径修复（FC-COL-007）」与「T-01 自动肤色检测」两条。

## 预防措施

- **凡是外部工具的"色相/色温/相位"类指标，必须先确认它的数学口径再与目标区间比较**——名称相同不代表定义相同；把口径写进代码注释与知识库（本篇）。
- 判据类改动必须配"正例命中 + 负例不误报"两条回归用例（本案例补的是绿块负例）。
- 证据里同时保留"判据值 + 原始工具值"，便于事后复核判据是否被误用。

## 关联

- 代码：`bundles/ai-video/connectors/color-bridge/core.mjs`（`standardHueFromUv` / `TARGET.skinHue` / `analyze()` 的 `verdictOf`）
- SKILL 引用：`color-grade/SKILL.md` 目标值表 + 第 2 步肤色取证；`color-look-design`（人物饱和度红线）
- 测试：`bundles/ai-video/connectors/color-bridge/core.test.ts`（T-01 口径修复 / 自动检测正负例）
- 任务号：T-01（2026-09-27）
