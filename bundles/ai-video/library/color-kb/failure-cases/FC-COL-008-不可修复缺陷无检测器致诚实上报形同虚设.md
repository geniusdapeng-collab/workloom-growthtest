# FC-COL-008 不可修复缺陷无检测器，诚实上报形同虚设

| 字段 | 内容 |
|---|---|
| 编号 | FC-COL-008 |
| 发现日期 | 2026-09-27（调色配乐链路强化集成评审：T-03 缺口盘点） |
| 严重度 | 中 |
| 状态 | 已修复（T-03） |

## 症状

`color-delivery-spec` 第六节明文要求"严重噪点色块 / 压缩伪影色带 / 焦点运动模糊"必须如实标注
**不可修复**并退回上游；但这三条长期**没有任何检测器**——报告里只可能出现裁切类指标，
失焦与色带只能靠人眼在连播时偶然发现。结果有两种：

1. 有缺陷的素材被"调过了"交付出去（风格化掩盖了问题）；
2. 反之，把正常的浅景深/颗粒质感误判成缺陷后返工——因为判据从未被量化。

## 检测器

```bash
# 失焦：blur（≥15 不可修复档、8–15 告警档）
ffmpeg -v info -i clip.mp4 -frames:v 1 -vf "blurdetect=block_pct=80,metadata=print" -f null - | grep lavfi.blur
# 噪点：原帧与 gblur 帧的差分 YAVG（≥9 明显、5–9 可降噪）
# 色带：160 宽 Y 直方图空洞比 + 行剖面平台结构（holeRatio≥0.25 且平台≥3 且单调）
```

判据：报告里出现"不可修复"结论但**没有任何实测值/检测器名**，即命中本案例。

## 根因

条款写了"必须诚实上报"，但没有把"什么算失焦/噪点/色带"变成可执行检测：
阈值缺失 → 判据不可复现 → 只能靠人眼；而人眼在连播时对"糊"和"颗粒"的容忍度随内容漂移。

## 处置

- `detectBlurLevel`（ffmpeg blurdetect）：合成标定 干净 ≈4.5 / sigma1.5 ≈7.8 / sigma3 ≈12.3 / sigma6 ≈18.5 / sigma8 ≈21–23，取 8/15 两档；
- `estimateNoise` 差分口径分级：<5 干净、5–9 可降噪（`denoise` 保守档）、≥9 明显噪点；
- `detectBanding`：8-bit 平滑渐变被量化成台阶后直方图出现空洞，判据 = holeRatio ≥0.25 + 平台电平 ≥3 + 跳变单调 ≥80% + 梯度 ≤3（排除纹理/双色图形）；
- `analyze`/`grade` 默认输出 `defects` 证据与 `verifyWarnings`；交付硬闸传 `on_unfixable=block`（删产物 + `verify_failed`）；
- 检测器**读不到**时标注"未核实"，不得当"通过"（比如 blurdetect 不可用）。

## 预防措施

- 交付条款里每出现一个"必须核实"，都要能指向一个检测器名 + 阈值（本篇的四个检测器即 T-03 落地）；
- 检测器阈值必须用合成正例/负例标定并把数值写进注释与知识库，避免"拍脑袋阈值"；
- 明确"创作意图"通道：浅景深/柔焦/颗粒属创作选择时由人工确认放行（`needsHumanReview=true`），机器不越权删产物。

## 关联

- 代码：`bundles/ai-video/connectors/color-bridge/core.mjs`（`detectBlurLevel` / `detectBanding` / `detectDefects` / `BLUR_THRESHOLDS` / `BANDING_THRESHOLDS`）
- SKILL 引用：`color-delivery-spec/SKILL.md` 第五节返工判定表 + 第六节不可修复清单
- 测试：`bundles/ai-video/connectors/color-bridge/core.test.ts`（T-03 色带纯函数正负例 / 失焦命中与清晰不误报 / block 闸）
- 任务号：T-03（2026-09-27）
