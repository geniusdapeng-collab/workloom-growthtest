# 后期交付与返修 bridge 连接器（ai-video）

把「一支片子交给用户」这件事做成可审计的确定性流程：**母版不烧字幕 → 同一批镜头派生多个风格变体 →
交付清单 + 工程文件 → 用户反馈按层增量本地重合成（不重新生成镜头）**。

## 为什么单独做一层

镜头生成（Seedance 渲染）是链路里唯一"贵且慢"的环节，后期（剪、调、配、加字、出封面）几乎只吃本地算力。
于是有两个结论：

1. **不要替用户猜风格**：一次给 2–3 个风格明显不同的版本（封面/文案/BGM/调色/转场），让他挑；
2. **不要动不动重生成**：反馈先做变更影响分析，能在本地重合成的绝不去烧渲染额度。

## 部署形态

```
WorkLoom（大脑：岗位/技能/围栏/事件账本）         Mac 后期工位（手，独立内网）
  runtime ToolExecutor ──HTTP/Bearer──▶  post-bridge (127.0.0.1:9777)
                                            ├─ ffmpeg / ffprobe（归一化/拼接/封面/软轨）
                                            ├─ subtitle-bridge 内核（旁挂字幕 + 软字幕轨 + 标题版式）
                                            ├─ color-bridge 内核（调色，自带可见性校验）
                                            ├─ bgm-bridge 内核（选曲 + 让位混音，自带 LUFS 复检）
                                            ├─ library/style-variants（风格配方：调色/BGM/转场/封面/文案）
                                            ├─ 产物区（新文件 + 版本链 + 缓存：norm/assemble/graded/audio）
                                            └─ 回执：sha256 / 变体差异实测 / 复用证据 / 成本口径
```

**大文件不出工位**：服务器只传路径与参数，工位本地读写素材，只回元数据与小图。

## 工具面（6 个）

| 工具 | 类型 | 用途 |
|---|---|---|
| `postread.health` | 读 | 工位体检（ffmpeg / 变体包 / LUT / 曲库 / 字幕工位） |
| `postread.plan` | 读 | 交付计划：镜头清单、变体差异轴、步骤与成本口径（不动文件） |
| `postread.impact` | 读 | **变更影响分析**：patch → 重算哪些层 / 是否需重生成镜头 / 花钱闸 |
| `postwrite.package` | 写 | 出交付包：干净母版 + 旁挂字幕 + 多风格变体 + 封面/文案 + 软字幕轨 + 清单 + 工程文件 |
| `postwrite.reedit` | 写 | **本地层增量重合成**：读工程文件 + patch → 新版本目录；镜头不动、复用带哈希证据 |
| `postwrite.triage` | 写 | 反馈分诊：自由文本 → 归因码 / 受影响层 / 是否重生成点名镜头 / 给用户的话 / patch 提示 |

## 交付包结构

```
<outDir>/
  master/master-clean.mp4                     干净母版（无字幕、无变体调色；返修地基）
  subtitles/<项目>.zh.srt|.zh.ass|.vtt       旁挂字幕（母版不烧字）
  subtitles/<项目>.subtitle-manifest.json    时间轴回读 / 字体解析 / 版式体检
  variants/<变体>/<变体>.mp4                 变体成片（无字幕轨）
  variants/<变体>/<变体>.softsub.mp4         同画面 + 可开关字幕轨（逐帧零改动复检）
  variants/<变体>/cover.png                  封面（按变体版式与文案渲染）
  variants/<变体>/copy.md|copy.json          文案包（标题/钩子/正文/话题/CTA + 四条校验）
  variants/<变体>/audio.json                 曲目/许可/署名/请求电平→实际电平/LUFS 复检
  film-project.json                          工程文件（层结构 + 产物血缘）——返修入口
  delivery-manifest.json                     交付清单（全产物 sha256 + 变体差异实测 + 成本口径）
  delivery-report.md                         人看版说明（变体对照表 + 返修路径 + 未达标项）
  versions/v2/…                              返修版本目录（只增不覆盖）
```

## 命令行

```bash
post-cli health
post-cli variants
post-cli plan     --project project.json --shots a.mp4,b.mp4 [--variants warm-story,clean-tech]
post-cli deliver  --project project.json --shots a.mp4,b.mp4 --out-dir out/ \
                  [--srt subs.srt] [--srt-en subs.en.srt] [--burn-subtitles] [--no-soft-subtitles]
post-cli impact   --project out/film-project.json --patch patch.json
post-cli reedit   --project out/film-project.json --patch patch.json [--shot SC-03=/path/new.mp4]
post-cli triage   --feedback "配乐太吵，另外第 3 个镜头人物走形"
```

退出码：`0` 成功；`2` 用法错误；`3` 工具错误（code 见 `PostError`）；`4` 需要人审（镜头重生成走 G8）。

## 风格变体（`library/style-variants/`）

| 变体 | 定位 | 差异轴（实测） |
|---|---|---|
| `warm-story` | 情感/文旅/民宿 | warm-film LUT 0.75 · fade 0.6s · acoustic-warm -23dB · 留白题签 · 温暖克制口吻 |
| `clean-tech` | 产品/科技/知识 | cool-technical 0.7 · hard · corporate-clean -25dB · 参数卡封面 · 简洁理性口吻 |
| `bold-promo` | 带货/本地生活 | high-contrast-social 0.9 · xfade 0.35s · sports-hype -21dB · 促销横幅 · 直接叫卖口吻 |

真机实测（3 镜 / 27s / 3 变体）：两两画面平均像素差 16.7 / 19.9 / 9.8（均判 `visible`），音轨曲目两两不同，
封面两两像素差 25–35（`visible`）。**变体雷同一律拒绝交付**（围栏 G-DLV1）。

## 复检口径（不达标不交付）

| 复检 | 口径 | 失败处置 |
|---|---|---|
| 母版零烧字 | 母版与软字幕轨版画面逐帧哈希一致；旁挂字幕文件存在且时间轴可回读 | 拒绝（G-DLV2/G-DLV3） |
| 变体可辨 | 每对变体至少一个轴 measured visible（画面像素差或音轨不同） | 拒绝（G-DLV1） |
| 封面可辨 | 两两封面像素差不为 negligible；标题墨迹必须真的检出 | 拒绝 |
| 时长一致 | 按各变体转场口径算期望时长（xfade 会因重叠变短）±0.4s | 拒绝 |
| 音频规格 | 母版 −14 LUFS ±1.5、真峰值 ≤ −1dBTP、人声-音乐余量 ≥ 3dB、配乐可闻度 ≥ 3dB | ① 自动降 3dB 重试一次并记账；② 仍不过则**该变体按原声降级交付**并如实标注 |
| 复用证据 | 复用的层给出 sha256 与"未被重算"的说明；镜头层与工程文件逐镜比对 | 拒绝（G-DLV7） |

## 真机验证数据（2026-09-24，本地 Mac + ffmpeg 6.0）

| 场景 | 结果 |
|---|---|
| 首次交付（3 镜 / 27s / 3 变体 / 中文字幕） | 约 68 秒；8 项交付检查全绿；9 个 MP4/PNG + 6 个元数据文件 |
| 只改字幕的返修 | **2.4 秒**；`text` 层重算，`shots/assemble/color/audio/cover` 全部复用；三个变体成片与上一版**逐字节一致** |
| 只改某变体配乐电平的返修 | 4.5 秒；命中混音缓存（未重跑混音），软字幕轨重出 |
| 点名镜头重生成 | `reedit` 拒绝执行并返回计划（exit 4）：先过 G8 人审 + `render-project.mts --only SC-03`，再带 `--shot SC-03=…` 回到本地合成 |
| 分诊 | "配乐太吵，另外第 3 个镜头人物走形，换个封面" → `rev.audio.mix` + `rev.shot.content` + `rev.cover.layout`；点名 SC-03；标注需人审 |

## 接线

```ts
import { createPostBridgeExecutor } from "./bundles/ai-video/connectors/post-bridge/executor.ts";

const toolExecutor = createPostBridgeExecutor({
  baseUrl: process.env.WORKLOOM_POST_BRIDGE_URL!,   // 支持逗号分隔多端点
  token: process.env.WORKLOOM_POST_BRIDGE_TOKEN!,
  tenantId: "ws-video",
  timeoutMs: 3_600_000,                            // 一次交付含归一化/拼接/调色/混音/封面/软轨
});
```

环境变量：`WORKLOOM_POST_BRIDGE_PORT`（默认 9777）、`WORKLOOM_POST_ALLOWED_ROOTS`（路径监狱，冒号分隔）、
`WORKLOOM_POST_WORK_DIR`（缓存与工作目录，默认 `~/.workloom-post`）、`WORKLOOM_POST_FFMPEG_PATH` / `WORKLOOM_POST_FFPROBE_PATH`。

## 与其它工位的关系

- **字幕工位**：旁挂字幕文件与软字幕轨由它产出（`subtitlewrite.sidecar` / `subtitlewrite.softmux`），本工位负责编排与复检；
- **调色/配乐工位**：变体的调色与混音直接调用其内核（含可见性、LUFS、人声余量等红线复检），本工位不重复实现；
- **渲染链路**：画面内容问题退回渲染侧（点名镜头 + G8 人审），本工位只做"重生成之后的本地合成"。

## 纪律

- 原片只读，版本只增不覆盖（`v1 → v2 → v3`）；任何写入都落到新文件；
- 无回执=未核实：产物带 sha256，"复用"必须带"未被重算"的证据；
- 不猜：未知 patch 键、缺字体、曲库无匹配一律抛稳定 code 的错误，不静默兜底；
- 不烧钱：需要重生成镜头时只出计划 + 审批闸，不擅自执行。
