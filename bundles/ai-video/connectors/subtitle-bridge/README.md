# 标题字幕 bridge 连接器（ai-video）

把 `subtitleread.* / subtitlewrite.*` 接到工位本地 FFmpeg/libass 与随包字体。成功镜头默认采用，按声明方案完成一次文字处理并记录实际产物；默认不抽帧诊断、测可现度/墨迹/UI 密度或做候选品质票决，也不自动重渲、ASR/TTS、模型或人工评审。

## 部署与接线

工位负责真实媒体文件，宿主只传参数与路径并接收小回执。客户素材与成品只留工位/租户素材区；HTTP/Bearer 接入使用受控 token，默认监听本机地址。

```ts
import { createSubtitleBridgeExecutor } from "./bundles/ai-video/connectors/subtitle-bridge/executor.ts";
const toolExecutor = createSubtitleBridgeExecutor({
  baseUrl: process.env.WORKLOOM_SUBTITLE_BRIDGE_URL!,
  token: process.env.WORKLOOM_SUBTITLE_BRIDGE_TOKEN!,
  tenantId: "ws-video",
  timeoutMs: 900_000,
});
```

行业侧 `server-adapter.mts` 读取环境变量并注入 runtime 的 toolExecutor seam；不修改基座。`WORKLOOM_SUBTITLE_ALLOWED_ROOTS` 限制实际路径并拦截软链逃逸，原片只读，输出写新文件。

## 工具面（14 个）

| 工具 | 实际行为 |
|---|---|
| `subtitleread.health` | 引擎/libass/字体/配方存在性 |
| `subtitleread.probe` | 普通分辨率、时长、帧率、音轨与编码元数据 |
| `subtitleread.analyze` | 显式可读性诊断与样本，不作为普通后期前置条件 |
| `subtitleread.fonts` / `subtitleread.recipes` | 字体与默认版式/题材配方检索 |
| `subtitlewrite.plan` | ASS、样式、文字与时间轴；默认 `analyze=false`，不改成片 |
| `subtitlewrite.burn` / `subtitlewrite.title` | 按声明文字与样式实际编码一次，时间轴与字体解析回读 |
| `subtitlewrite.danmaku` | 滚动/固定轨，完整保留请求条数与文字；显式限制才应用并报告 |
| `subtitlewrite.sticker` | 指定落点、有限正停留时间与 200ms 入场；不按 1.5–3s/UI 阈值拒收 |
| `subtitlewrite.karaoke` | 显式逐字时间，或按字数均分并标注非真实发音对齐；支持双语 |
| `subtitlewrite.sidecar` | SRT/ASS/VTT、清单与实际时间轴回读，原片未改 |
| `subtitlewrite.softmux` | 真实视频/音频 copy、可开关字幕轨与普通流元数据回读 |
| `subtitlewrite.best` | 兼容命令执行一套声明方案；`candidates=[]`、`score=null`，不做像素选优 |

## 默认回执与技术检查

生产后期在同时请求字幕与弹幕时使用内核的单次合成路径：两类事件写入同一份 ASS，只编码一次。最终文字层 1080P 为 `libx264 medium/CRF16`，UHD 为 `medium/CRF14`；不再接受“先烧字再烧弹幕”的两代编码发布链。

**纪律**：弹幕密度与安全区不允许用参数绕过（`allow_flood` / `ignore_density` / `skip_safe_area` 被 G-SUB6 一票否决）；
卡拉OK 的均分时间轴必须标注口径，不得当真实对齐交付。

品质未测时 `qualityReviewed=false`、`qualityReview="not-reviewed"`、样本/证据帧为空、品质指标为 null。`verify=false` 或 `skip_verify` 不关闭这些实际技术检查，也不挂起普通后期。显式 analyze 报告独立保留，不能把未诊断说成合格。

软字幕记录实际 `-c:v copy`/音轨 copy 命令、源 SHA、普通音视频流元数据和新增字幕轨。默认不做 framemd5、抽样帧或全帧解码比较，报告不宣称执行了这些检查。硬字幕只写请求的新副本。

## 字体与布局

`library/font-catalog/font_db.json` 与 `library/fonts/{cn,en}/` 保存字体许可、摘要、语言、默认平台布局；字体文件、档案与 Bundle 完整性索引交叉校验。`WORKLOOM_SUBTITLE_FONTS_DIR` 可指定已有外置字体，摘要仍检查。

```
字号 = 短边 × 场景基准比 × 粗细修正 × 平台倍率
描边 = 字号 × 0.06；默认边距 = 短边 × 0.05
```

字号、安全区、18 字行宽、并发 8 条、贴纸 1.5–3s、对比度/可现度是历史设计建议，不形成默认准入、抽稀、删产物或重渲。调用方显式请求 maxChars/maxConcurrent 时才执行其限制并如实报告；用户针对布局反馈时仅修改文字层。

## 测试与运行

真实 FFmpeg 回归在既有 `test:scripts` 的 `punctuation.test.ts` 中运行：守卫禁止默认抽帧/品质滤镜，覆盖 plan、burn、title、best、danmaku、sticker、karaoke、sidecar、softmux，核对实际文件、SHA、字幕轨，并验证非法 SRT、缺字体、路径、源覆盖及编码失败。

`runtime-smoke.mts` 可在已授权数据库/工位环境验证 runtime/围栏接线；它不是默认每次后期的品质检查。许可未核验、源覆盖、非白名单字体或工位不可达仍如实挂起/失败，已成功源镜头不再因观感评审挂起。

## 原片、许可与错误

- `G-SUB2` 保持原片只读；`G-SUB1/G-SUB5` 保持真实字体许可；`G-SUB4` 保持配额。
- `G-SUB3/G-SUB6` 的旧品质/UI/密度条件不阻断默认后期。
- token 不进仓库或日志，大文件/素材不出工位；executor 不伪造缺失回执的 synced 状态。
- 真正路径、tenant、源覆盖、磁盘、字体、SRT、引擎、编码或请求产物错误仍以稳定错误码返回；不吞异常、不自动换字体、删条或重生成。
