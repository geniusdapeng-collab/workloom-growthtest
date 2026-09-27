# vendor/srt-whiteboard · 上游引脚（PINNED）

| 项 | 值 |
|---|---|
| 上游仓库 | https://github.com/geeklee/srt-whiteboard-animation |
| 引脚 commit | `696a7243c0e6ffb6827676e539c2ca5ebae2bf6b`（`main`，2026-07-28 "feat: initial release of srt-whiteboard-animation skill"） |
| 拉取日期 | 2026-09-27（Asia/Shanghai） |
| 许可证 | MIT（`LICENSE`，Copyright (c) 2026 江哥是老登啊）——保留原样，未改动 |
| 拉取方式 | `git clone https://github.com/geeklee/srt-whiteboard-animation.git` → 复制 `README.md / SKILL.md / LICENSE / agents/ / assets/ / examples/ / scripts/`，未含 `.git` |
| 本地改动 | 5 处补丁落在 3 个文件上（见下），其余文件与上游逐字节一致 |

## 本地补丁清单

| 文件 | 补丁 | 原因 | 证据 |
|---|---|---|---|
| `scripts/render_annotation_preview.py` | 字体从硬编码 `C:/Windows/Fonts/msyh.ttc` 改为跨平台探测（macOS PingFang/STHeiti、Linux Noto/WQY/DejaVu、Windows msyh/simhei）+ `WHITEBOARD_PREVIEW_FONT` 覆盖 + 位图兜底；标签框夹到画布内 | 上游只在 Windows 可用：macOS/Linux 上 `ImageFont.truetype` 抛 `OSError: cannot open resource`，标注确认关（SKILL.md 第 4 步）直接不可用 | `WHITEBOARD_PREVIEW_FONT` 未设时在 macOS 实测通过（见 `docs/whiteboard-engine.md` 验证记录） |
| `scripts/prepare_env.py` | 增加解释器版本闸（>= 3.10）+ `WHITEBOARD_PYPI_INDEX` 支持 + `--check` 报版本 | 上游不判版本：3.9 及以下会先建好 venv、再在 pip 阶段失败，报错与根因不匹配（PyAV / numpy 2.x 无 cp39 macOS arm64 wheel） | 本机 `/usr/bin/python3`（3.9.6）触发时给出明确修复建议 |
| `scripts/render_stream_whiteboard.py` | `_reveal_ink_segment`：从"每次调用新建并扫描**整幅** HxW 掩码"改为"只处理线段包围盒 + 笔宽外扩" | **性能缺陷**：该函数每落墨一小段就分配并清空整幅数组（1080×600 ≈ 648KB）再做全幅布尔运算，单次约 6ms；调用次数只与笔迹采样点数相关（**与 fps 无关**），官方样例 8.6s 就要调用 9319 次 → cProfile 实测 56.5s/62.2s 全耗在这里，单幕渲染 4~7 分钟。"降 fps" 因此完全无效（真机踩到） | **语义等价 + 提速 5.5×**：修复后 1080p/60fps 同一素材 4m02s → 44s；`monkey.mp4` 与 `monkey-fixed.mp4` 逐帧比对 **PSNR=∞**（516/516 帧完全一致）。收敛到包围盒的数学依据：包围盒外掩码恒为 0 → AND 结果必为 False → 赋值不改任何像素 |
| `scripts/render_stream_whiteboard.py` | 补丁④：`render_to()` 中"区域网格路径为空"分支的 `_lay_ink(...)` 调用去掉多余实参 | **崩溃缺陷**：该分支多传一个 `None`（旧签名 `_lay_ink(writer, frames, samples, pen_lifts, sample_cell, allowed)` 的残留），当前签名只有 5 参 → `TypeError: _lay_ink() takes 6 positional arguments but 7 were given`，**整幕渲染直接崩**。触发条件很常见：某个元素的区域被后续元素的区域完全盖住（allowed 掩码为空）——本仓 11 幕真机出片时第 8 幕就是死在这里 | 修复后同一条标注可正常渲出：该段只推进笔尖、不落墨（与"区域无墨"语义一致）。同时本仓 `annotate.ts` 增加了"区域可见面积"校验与去重叠预处理，从源头减少空掩码区域 |
| `scripts/render_stream_whiteboard.py` | 补丁⑤：仅当 `cap_long_edge=3840` 且输入线稿被放大时，`cv2.resize` 用 `INTER_CUBIC`；HD 与缩小路径仍用 `INTER_AREA` | [OpenCV 官方 `resize` 文档](https://docs.opencv.org/5.0/main_modules/imgproc_transform.html)建议缩小用 `INTER_AREA`、放大用 `INTER_CUBIC` 或 `INTER_LINEAR`；三次插值只平滑既有轮廓，不凭空创造源图细节 | 代码分支已检查；同素材 4K 画面对比待独立渲染环境就绪后补入 `docs/whiteboard-engine.md` |

## 未改动但值得记录的上游事实（接入方须知）

1. **渲染产物没有音轨**：`render_stream_whiteboard.py` 用 `cv2.VideoWriter(mp4v)` 再转 H.264，
   全程不写音频轨；`merge_scenes.py --inputs ... ` 也是 `-c copy` 视频轨拼接。
   → 接入方必须自己把配音轨混流进成片（Growth 侧：`apps/server/src/video/whiteboard/mux.ts`）。
2. **`render_stream_whiteboard.py` 只处理"一张图 + 标注"**：分幕、字幕解析、线稿生成、语义标注
   都是上游 SKILL.md 交给 Agent 做的活，仓库内没有实现（`parse_srt.py` 只做 SRT→分幕建议）。
3. **`--pause` 在逐区域画法下几乎无效**：上游注释自述"预留，逐区域画法下影响较弱"。
4. **网格模式要求图像边长是 `grid_edge` 的整数倍**：`stream_render.py#_to_grid_blocks` 会直接抛错；
   `render_stream_whiteboard.py` 已在输出侧对齐（`align = grid_edge`），输入图尺寸不受限。
5. **`assets/drawing-hand.png` 笔杆带上游作者标识**（"江哥是老登啊"）。
   本仓产品化时**不使用**该素材做对外成片，改用仓库自有中性笔手素材
   （`assets/whiteboard/drawing-hand-workloom.png`），上游素材仅留作官方样例复现。
6. **渲染产物是 CPU 逐帧生成的确定性输出**：同参数同输入必得同字节（可用于回归比对）；
   代价是耗时随「帧数 × 分辨率 × 笔迹长度」增长，因此本仓暴露 `--fps` / `--cap-long-edge`
   两个档位（默认 1280/30fps，真机约 0.4× 实时）。

## 升级流程

1. 拉取上游新 commit，先跑 `examples/` 官方样例复现（画面/时长/首帧纸底）；
2. 重新套用上表五处补丁（上游若已修，删除对应补丁并更新本文件）；
3. 更新本文件引脚 + `packages/base/bundles/whiteboard-capability.test.ts` 的版本断言；
4. 全链路真机出片一次（`scripts/tools/whiteboard-film.mts`），确认成片与字幕对齐无回归。
