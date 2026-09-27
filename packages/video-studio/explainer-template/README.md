# explainer-template —— 口播解说片「我方受控合成模板」

> T-2026-0926-0008 · 规格书《口播解说片能力（talkcraft-explainer）· 实施规格书 v2.0》§5.2
>
> 这个目录里的全部代码是**我们自己的**（WorkLoom 视频产品组），静态可审、可回归。
> talkcraft 引擎（108 张配方卡 + 确定性脚本）在**装配期**被复制进任务工程目录，不随本仓分发
> ——原因见 `apps/server/src/video/explainer/engine.ts` 顶部的许可说明（PolyForm Noncommercial）。

## 它解决什么问题

talkcraft 的原生模式是"agent 现场写 Remotion 工程代码"：每支片子都要写场景、接相机、接字幕。
我们把**共性的那一半**固化成这个模板，于是"一部片子"的差异只剩数据：

```
shotbook.json（分镜数据） + timing.json（字级时间戳） + public/（素材）
        │
        ▼  装配期：复制模板 → 复制选中的卡 → 逐镜派生 scenes/<shotId>.tsx → 写 props.json
  var/talkcraft-jobs/<taskId>/remotion/
        │
        ▼  render_shots.mjs（引擎脚本，段缓存 + 帧数断言）
  out/v1.mp4 → 机器闸六条 → loudnorm → delivery.mp4
```

## 输出档位与合成口径

`quality` 省略时为 `hd`。`project-builder.ts` 将档位写入 `props.json` 与 `job.json`：

| 画幅 | HD | UHD |
|---|---:|---:|
| 竖屏 9:16 | 1080×1920 | 2160×3840 |
| 横屏 16:9 | 1920×1080 | 3840×2160 |

卡、人物窗与字幕仍用 HD 设计坐标排版；`Main.tsx` 在原生 UHD Composition 内把舞台整体放大 2 倍，音轨维持同一时间轴。UHD 的段渲染 worker 和 Remotion 帧并发都限制为 1，避免 8 GiB 工位同时持有多张 4K 帧。渲染完成后 provider 用 `ffprobe` 核对实际视频流尺寸；尺寸不符不会报成功。

## 画面层（模板内建，不需要每片重写）

| 层 | 文件 | 纪律 |
|---|---|---|
| 全局背板 | `src/Backdrop.tsx` | 深底渐变 + 极缓漂移，全片一个风格档（G0 palette.base） |
| 卡面板 | `src/CardStage.tsx` | 960×540 卡舞台按画幅缩放、装框；`hostForm=短离场` 时放大居中 |
| 人物窗 | `src/HostWindow.tsx` | 主角「陈卓」等人物素材，按 `rhythmTable.hostForm` 切换形态（半身/角标左下/分屏格/短离场），带极缓推近 |
| 字幕 | `src/Subtitles.tsx` | **素排、整句硬现硬走、无标点**（design-language §5 铁律），竖屏安全区 |
| 相机 | `src/ShotCamera.tsx` | 每镜一条极缓推进（1.005→1.035），不做位移/旋转/模糊（运动做减法） |
| 转场 | `src/ShotStage.tsx` | 相邻镜 12 帧交叠 + 淡入淡出（`FADE_FRAMES`），一个边界只用一式 |
| 音效 | `src/SfxTrack.tsx` | 由 props.cues 驱动（绝对秒），同帧最多一记、音量 ≤0.35 |

## 装配契约（`project-builder.ts` 负责，改这里前先改它）

1. 本目录整体复制到 `<jobDir>/remotion/`；
2. 引擎卡 `<engine>/template/cards/<slug>.tsx` 原样复制到 `src/cards/<slug>.tsx`（`card_lint.py` 的保真对象）；
3. 逐镜派生 `src/scenes/<shotId>.tsx`（= 卡源码 + 内容槽补丁，补丁只来自 shotbook 的 `content`/`replace`）；
4. 生成 `src/scenes/index.ts` 桶文件（`SCENES: Record<shotId, Component>`）覆盖模板里的空桶；
5. 写 `props.json`（`--props @props.json`）：shotbook + sentences + host 素材路径 + cues + theme；
6. `node_modules` 软链到引擎 `runtime/node_modules`（**不在工程里 npm install**）；
7. `remotion/overrides.json` 写 `{}`（工作台写盘预留，agent 不改）。

## 不在模板里的部分（明确边界）

- **不写卡**：动效实现以引擎 `template/cards/<slug>.tsx` 为准，模板只负责摆放与派生；
- **不做工作台**：剪映式工作台（`workbench/`）后续单独接（本模板已按契约留 `overrides.json` / `scenes/` 结构）；
- **不做发布**：发布走 Growth 既有 `publish` 链（本模板只到 `delivery.mp4`）。
