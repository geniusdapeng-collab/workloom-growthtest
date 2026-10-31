---
name: color-shot-matching
description: 多镜色彩匹配官方套件：显式参考镜与目标列表、输入统计计算请求的校正、单次真实编码、参考/目标/产物摘要及错误回执。输入统计仅用于变换，不作成品残差/直方图品质闸或自动重渲；围栏由 colorist 岗位绑定 G-COL0..G-COL4，技能本身不单独授予。
---

# 多镜色彩匹配

## 什么时候执行

只有调用方明确请求镜间匹配时使用 `colorwrite.match`。普通 grade/best 不自动逐镜诊断。参考镜由明确请求或已声明编辑方案指定，不设“合格参考镜”品质准入。

```bash
color-cli match --ref hero.mp4 --in a.mp4 --in b.mp4 --out-dir matched/
```

## 实际处理

1. 验证参考、目标路径与实际视频元数据，记录源 SHA。
2. 读取有限输入统计以计算参考→目标的曝光、饱和与色度校正；该测量标注 `requested-color-match-transform`。
3. 每个目标执行一次 grade，记录校正参数、实际滤镜和产物 SHA。
4. 再次核对参考与目标源字节未改变；成品不抽帧做残差或直方图品质票决。

`after/residual=null`、`qualityReviewPerformed=false`。历史 histogramCheck warn/fail/off 字段可记录为请求信息，不再据此删成品或自动迭代。历史 ΔY≤5、ΔU/V≤3、肤色区间只是设计参考。

## 回执与失败

每镜记录 target、reference 源摘要、变换用输入统计、校正参数、输出路径/摘要、真实处理结果。不存在源、路径越界、LUT/磁盘/ffmpeg 错误明确失败；不把坏文件当完成、不吞异常、不用缺陷评分要求上游重渲。

用户明确反馈匹配效果时调整参考或参数，修改对应后期层；成功镜头继续默认采用，新增生成仍需授权和预算。历史方法与案例可参考 `library/color-kb/`，不覆盖这里的默认执行口径。
