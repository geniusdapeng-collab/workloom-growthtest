# 本地分辨率增强桥

本目录实现 ai-video 的本机图片与 CFR 视频增强。输入文件保持只读；产物、SHA-256、媒体探针结果和来源 JSON 写入调用方指定的 `outputDir`，例如交付包的 `work/enhanced`。视频逐帧流式处理，保留原音轨编码、帧数和帧率。它只提供本地核验回执；媒体库登记、额度账本和 WorkLoom 的同步回执由调用方另行完成。

## 安装与检查

运行环境为 Apple Silicon macOS，另需可执行的 `ffmpeg` 和 `ffprobe`。解析顺序是调用方显式 `bins` → `WORKLOOM_ENHANCE_*_PATH` → `WORKLOOM_POST_*_PATH` → 可执行的 `~/.workloom-color/bin/ffmpeg|ffprobe` → PATH，以兼容 GUI 启动时缺少 shell PATH 的本机工位。引擎 PIN 在 [pin.mjs](./pin.mjs)，对应 [Real-ESRGAN v0.2.5.0 发布页](https://github.com/xinntao/Real-ESRGAN/releases/tag/v0.2.5.0)。安装器核对整个 ZIP 的 SHA-256，提取指定二进制与模型文件，运行真实 GPU 冒烟，再原子替换本机忽略目录 `var/enhance-engine`。

```sh
node scripts/tools/enhance-engine-install.mjs
node scripts/tools/enhance-engine-install.mjs --check
```

已有完整发布 ZIP 时可传 `--archive /absolute/path/to/realesrgan-ncnn-vulkan-20220424-macos.zip`；自定义安装目录用 `--dest /absolute/path`，调用时传同一 `engineDir` 或设置 `WORKLOOM_ENHANCE_ENGINE_DIR`。`--check` 只读且失败时以非零状态退出。

## API

```js
import { enhanceVideo } from "./bundles/ai-video/connectors/enhance-bridge/core.mjs";

const result = await enhanceVideo({
  input: "/absolute/path/to/source.mp4",
  outputDir: "/absolute/path/to/package/work/enhanced",
  scopeId: "tenant-id/project-id",
  targetWidth: 3840,
  targetHeight: 2160,
  kind: "live-action", // 或 "animation"
});

if (!result.receipt.localVerified) throw new Error("本地增强未验证");
```

`enhanceImage` 接受同样的选项，输出 PNG；`enhanceVideo` 输出 MP4。`kind: "text"` 被拒绝，文字卡片应在目标分辨率重新排版。目标必须为至少 32 像素的偶数宽高，最大约 4K 工作档。可用 `bins: {ffmpeg, ffprobe}`、`engineDir`、`scratchRoot` 指定本地工具路径。源文件、输出目录和 scratch 目录需要由调用方授权并位于同一可信工位。

返回结构中的 `output`、`sha256`、`sourceSha256`、`key`、`reused`、`provenancePath`、`probe` 可用于工程文件和交付清单。`processingMode` 有三个值：

| 值 | 处理 | `model` / `modelScale` |
|---|---|---|
| `ai-upscale` | Real-ESRGAN 对不足目标有效画面的源超分，随后等比缩小/补黑边到精确目标尺寸 | 实际模型名 / 倍率 |
| `passthrough` | 已是目标尺寸的 PNG/MP4 直接复制并校验 | `null` / `null` |
| `native-resize` | 源有效像素已覆盖目标，或格式需要转换；用 FFmpeg 等比缩小/补黑边 | `null` / `null` |

`engine` 包含 `name`、`release`、`archiveSha256`、`binarySha256`、`modelFiles` 和 `tileSize`；AI 模式给出实际引擎与模型文件哈希，原生处理模式的 ncnn 哈希为 `null`。`receipt` 重复这些字段，并包含 `localVerified: true`、两个文件哈希、`output`、`provenancePath`。`provenancePath` JSON 还记录源/输出探针、尺寸、帧数、时长与音轨校验。调用方应根据 `processingMode` 判断低清源是否真正经过 AI，不把 `passthrough` 或 `native-resize` 记为 AI 超分。

## 明确边界

- 只接受单视频流、方形像素、无旋转元数据的 SDR 8-bit 源；HDR、透明、字幕/数据流会报错，避免静默丢失。
- 视频必须是起点接近零的 CFR；VFR、非零音轨偏移和非单调时间戳会被拒绝。输出校验帧数、帧率、目标尺寸、音轨数量/编码、时长与音轨起点。没有真实产物及校验，不写 `localVerified`。
- 默认限制 120 秒、3600 帧、2 GiB 输入、1 GiB 输出、输入超分像素 5 MP；已达目标的原生素材上限为 12 MP。超过限制抛出带 `code` 的 `EnhanceError`。
- 磁盘预检保留默认 512 MiB 空闲底线，AI 另预留 512 MiB scratch；按本任务最小输出需求准入，并把剩余可用空间设为该次写入的更小硬上限，不会因为小片未占满 1 GiB 输出配额就先要求完整 1 GiB。回执和 provenance 的 `diskPreflight` 记录输入可用空间、scratch 预算、输出上限与保留量；空间不足报 `disk_quota_exceeded`。
- `live-action` 使用 x4plus 的 4 倍模型；`animation` 按所需倍率选 animevideov3 的 2/3/4 倍模型。推理像素上限 40 MP。在本机 M3/8 GiB 处理真人视频时，先用本机实测吞吐的一半作保守下界预检；若整段预计超过一小时工作档，在调用 GPU 前以 `time_budget_exceeded` 失败。其他硬件/模型仍以首帧实测速度复核剩余工作量，避免长时间占用后才发现超时。单帧推理默认超时 5 分钟，图片使用同一限额。
- 本机 M3/8 GiB 上的 2026-09-27 冒烟：1920×1080 真人模型静图到 3840×2160，整项测试约 121 秒；此数值仅是该机器该样本的实测，不能代表完整视频吞吐。调用方必须保留失败路径与真实耗时，不把低清输入的纯 FFmpeg resize 宣称为 AI 增强。

## 验证

```sh
node --test bundles/ai-video/connectors/enhance-bridge/core.test.mjs
WORKLOOM_ENHANCE_GPU_TEST=1 node --test bundles/ai-video/connectors/enhance-bridge/core.test.mjs
WORKLOOM_ENHANCE_UHD_TEST=1 node --test bundles/ai-video/connectors/enhance-bridge/core.test.mjs
WORKLOOM_ENHANCE_PREFLIGHT_TEST=1 node --test bundles/ai-video/connectors/enhance-bridge/core.test.mjs
```

基础测试检查 VFR 拒绝、已达目标尺寸 MP4 的音轨/哈希/缓存与 FFmpeg 等比缩小；GPU 测试另覆盖两种模型和带音轨视频；UHD 测试覆盖 1080p→2160p 静图及原生 2160p 视频；预检测试在 M3 上验证 8 秒/24fps 真人片于推理前被耗时预算阻断。可用 `WORKLOOM_ENHANCE_FFMPEG_PATH`、`WORKLOOM_ENHANCE_FFPROBE_PATH` 指定二进制。
