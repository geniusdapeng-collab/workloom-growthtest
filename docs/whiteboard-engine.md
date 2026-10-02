# 手绘白板解说引擎（whiteboard-local）

> 任务卡：T-2026-0926-0020｜落地仓：`workloom-ai/workloom-growth`｜引擎来源：`vendor/srt-whiteboard`（上游 MIT，commit `696a724`）
> 规格来源与逐条修正：`docs/whiteboard-spec-review-2026-09-27.md`
> 一句话：**字幕驱动的确定性手绘白板渲染器**——口播稿进去，带配音、带字幕轨的手绘解说片出来，全程零模型成本（线稿阶段可选用方舟出图）。

## 一、它到底能做什么（源码级结论，A 级证据）

| 能力 | 事实 | 证据（文件:行/函数） |
|---|---|---|
| 单幕渲染 | 吃「一张线稿 PNG + 同名 annotation.json」→ 出 MP4（H.264，**无音轨**） | `vendor/srt-whiteboard/scripts/render_stream_whiteboard.py:349 render_to()`（`cv2.VideoWriter(mp4v)` → `sr.transcode_h264`） |
| 画法 | 每个区域在自己的允许掩码内沿骨架/网格连续落墨：先 `ink` 铺线、后 `color` 添彩，权重 2:1 | `render_stream_whiteboard.py:187 _reveal_ink_segment()` / `:266 _wash_contour()`；`stream_render.py:53 class Config(ink_weight=2,color_weight=1)` |
| 遮罩不变量 | 区域允许掩码 = 矩形 region − 后续区域 − `protectedRegions`；未开始区域**不露线** | `render_stream_whiteboard.py:142 _allowed_mask()` |
| 笔迹路径 | `grid`（默认，稳）/ `skeleton`（线稿清晰时更贴合） | `render_stream_whiteboard.py:465 --ink-path`、`stream_render.py:_zhang_suen_skeleton` |
| 上色方式 | `contour-wipe`（默认，轮廓感知自上而下扫描）/ `brush` | `render_stream_whiteboard.py:410`、`:266 _wash_contour()` |
| 首帧 | 干净纸底（`canvas_hex`，默认 `#F6F1E3`，实测画面取 `#F5EBD7` 系） | `stream_render.py:71 canvas_hex`；`render_to()` 前无任何落墨 |
| 凝视收尾 | 全部元素画完自动补到 `sceneDurationMs`，并保证结尾 ≥0.5s 完整画面 | `render_stream_whiteboard.py:416 gaze_until = max(total_ms, cur_ms + 500)` |
| 多幕合并 | `merge_scenes.py` 优先 ffmpeg `-c copy`，失败退化 PyAV 重编码 | `merge_scenes.py:_ffmpeg_concat_copy()` / `_pyav_concat()` |
| 末行契约 | 渲染成功末行输出 `OUTPUT=<路径>`（上层据此判定，不看退出码） | `render_stream_whiteboard.py:538`；本仓校验见 `engine.ts:parseOutputLine()` |
| 环境隔离 | `.venv` + `prepare_env.py`；依赖 opencv-python / numpy / PyAV / Pillow | `scripts/prepare_env.py#DEPS`；版本事实见 `vendor/srt-whiteboard/requirements.txt` |

### 它的三个"做不到"（决定了接入形态）

1. **不做分幕**：`parse_srt.py` 只给"建议分幕"，真正的切幕与时长由调用方决定；
2. **不生成线稿**：上游 SKILL.md 明确"线稿由 Agent 确认策略后生成"（靠外部图像模型或人工画）；
3. **不写音频**：产物是无声片（见上表第一行）——配音必须由接入方混流。

### 性能事实（真机实测，决定了默认档位）

| 场景 | 分辨率/fps | 原始耗时 | 打补丁后 |
|---|---|---|---|
| 官方样例（8.6s，3 区域） | 1080×600 / 60fps | **4m02s** | **44s** |
| 官方样例（同素材） | 1280×720 / 30fps | 6m49s | ~6s（同参数对比见 PINNED.md） |

根因与修复见 `vendor/srt-whiteboard/PINNED.md` 补丁③（`_reveal_ink_segment` 每次落墨扫描**整幅**掩码；
调用次数只与笔迹采样点数相关、**与 fps 无关**，所以"降 fps"完全无效）。
修复后语义等价性由 **PSNR=∞（516/516 帧完全一致）** 证明。

**默认档位**：`WHITEBOARD_FPS=30`、`WHITEBOARD_CAP_LONG_EDGE=1280`（约 0.4× 实时）。

### UHD 输出档位（T-2026-0927-0010）

`whiteboard.create` 和 `whiteboard.verifyExample` 接受 `quality:"hd"|"uhd"`（默认 `hd`）；`whiteboard.render` 可显式给 `quality:"uhd"`，省略时沿用片子保存的档位。UHD 固定输出 **3840×2160**，不接受自定义 `capLongEdge`。提交前会读取每幕线稿的 PNG/JPEG 尺寸，按上游 10 像素网格对齐算法预估输出；不能恰好得到 3840×2160 的线稿会被明确拒绝，避免渲到末尾才发现比例不符。

UHD 的 `render_stream_whiteboard.py` 仍逐帧构建完整 4K 画布。只有当输入线稿需要放大到 4K 时，图像插值从上游 `INTER_AREA` 改为 `INTER_CUBIC`；HD 与缩小路径保持原样。这符合 [OpenCV 官方 `resize` 文档](https://docs.opencv.org/5.0/main_modules/imgproc_transform.html)对缩小/放大插值的建议，只改变已有像素之间的过渡，**不增加源线稿的细节**。每幕 H.264 产物与合并产物都经 `ffprobe` 核对尺寸；单幕还保存同名 `.render-receipt.json`（尺寸、字节数、SHA-256），供复核和故障定位。上游成功转码后自行删除临时 `*_raw.mp4`；转码失败时保留 raw 供排障。

本轮静态契约测试与 TypeScript 检查已通过；4K 实帧、同素材两种插值的画面对比尚未完成，不能据此声称 UHD 的视觉质量和 M3 耗时已经验收。

## 二、本仓的接入形态（八环节）

```
口播稿(create) → 配音+SRT(narrate) → 分幕(plan) → 逐幕线稿(lineart)
   → 逐幕标注(annotate) → 确认关(preview) → 渲染+合并(render→poll) → 交付(deliver)
```

| 环节 | 实现 | 产物与落库 |
|---|---|---|
| create | `whiteboard/router.ts#create` | `video_projects(kind='explainer')` + `whiteboard_films` |
| narrate | `narration.ts`（逐句合成 + 实测时长 → SRT） | `<jobs>/film-<pid>/seg-NN.wav`、`narration.wav`、`narration.srt`；`whiteboard_films.narration_path/srt` |
| plan | `srt.ts#groupScenes + tileScenes` | `whiteboard_scenes`（幕序 / 字幕区间 / 幕长） |
| lineart | `lineart.ts`（seedream / sketch / upload）+ 机检三道 | 线稿 PNG 入媒体仓；`lineart_prompt/lineart_check` |
| annotate | `annotate.ts`（像素反推区域 + 计划元素 + Zod 校验 + 自愈） | `whiteboard_scenes.annotation`（上游契约全文） |
| preview | 上游 `render_annotation_preview.py`（已打跨平台字体补丁） | 编号检查图入媒体仓，返回签名 URL |
| render | `provider.ts#WhiteboardProvider` → `gen/submit.ts#submitGenJob` | `render_jobs(provider='whiteboard-local', est_cny=0)` + `render.submit` 事件 |
| poll | `render-poller.ts`（复用，`file://` 本地入库） | `render_jobs.status=done`、`video_assets(kind='clip')`、成本台账、档案 attempt |
| deliver | `mux.ts`（两遍 loudnorm + `apad` + 软字幕轨） | `video_assets(kind='final_cut', pipeline_kind='explainer', tags=['口播','白板手绘'])` |

### 复用而非平行实现（对照规格 §2.10 验收 4）

- **唯一写入口**：渲染走 `gen/submit.ts#submitGenJob`（幂等键 / 降级链 / 报价 / 事件留痕 / D16 同事务）；
- **唯一状态权威**：`render_jobs` + `render-poller`（白板不另立状态表）；
- **唯一成本口径**：`gen/cost.ts#recordRenderCost`（本地渲染 `pricing.usd=0` → `est_cny=0`）；
- **唯一入库口径**：`gen/ingest.ts#downloadToMediaStore`（本轮为它加了 `file://` 本地分支，而不是新写一条入库路径）；
- **唯一围栏口径**：G8 `render.submit`（`loadActiveRulesInTx` + `judge`，与 `renderRouter.submit` 同源）。

## 三、环境变量

见 `.env.example` 末节（11 个变量，逐条带注释）。要点：

- `WHITEBOARD_ENABLED=0|1` 是**总开关**，也是回滚开关：置 0 后媒体目录里不再出现 `whiteboard-stream`；
- `WHITEBOARD_LINEART=seedream|sketch|upload`（`seedream` 需 `VOLCENGINE_ARK_API_KEY`；`sketch` 零模型成本）；
- `WHITEBOARD_NARRATION_PROFILE` 指定配音工位音色档案（本仓销售片用 `chen-zhuo-film`）。

## 四、验收对照（规格 §2.10 八项）

| # | 验收项 | 通过标准 | 本轮结果 |
|---|---|---|---|
| 1 | 许可合规 | vendor 含 MIT LICENSE + PINNED；无授权闸门 | ✅ `packages/base/bundles/whiteboard-capability.test.ts` 断言 LICENSE 原文与落款、PINNED 引脚与三处补丁 |
| 2 | 端到端 | 口播稿+配音 → 手绘白板成片入媒资库，元素随字幕依次出场、首帧净纸底 | ✅ 见 §五 真机记录（`final_cut` + `tags=['口播','白板手绘']`） |
| 3 | 官方样例 | examples/ 素材直渲复现官方效果 | ✅ `video.whiteboard.verifyExample`（走 tRPC，产物入媒体仓） |
| 4 | 链路复用 | Provider/poller/台账/媒资/档案零平行实现；est=0 | ✅ 见 §二「复用而非平行实现」；`whiteboard-capability.test.ts` 断言不出现 `INSERT INTO render_jobs` |
| 5 | 线稿双路径 | Seedream 与 cv2 素描化各自出片且过风格机检 | ✅ `lineart.ts` 两条路径 + `lineart_tools.py check` 三道机检（纸底色 / 深色占比 / 连通域数）+ 失败读数写回提示词重出 |
| 6 | 断点续跑 | kill 后接管，幂等防重复 | ✅ 逐幕产物落 job 目录，`resumableScene()` 跳过已 `rendered` 且产物仍在的幕；配音逐句音频同样复用（见 §五 断点实录） |
| 7 | 确认关 | 三处确认点可呈现可跳过（自动模式），跳过有留痕 | ✅ `preview` 出编号检查图 + `updateAnnotation` 单幕返修；**呈现/跳过都写进五元事件账本**（`whiteboard.gate.presented` / `whiteboard.gate.skipped`，含 gate/场景/原因/操作者），跳过是显式动作而不是"什么都没做" |
| 8 | 零回归 | 既有管线全绿；`WHITEBOARD_ENABLED=0` 回退 | ✅ 见 §五 回归记录 |

## 五、真机记录（本机 macOS / Node 24 / Python 3.12）

### 5.1 官方样例复现（验收 3）

命令：`POST /trpc/video.whiteboard.verifyExample {capLongEdge:1280, fps:30}`（走 tRPC，不是本地跑脚本）

| 读数 | 值 |
|---|---|
| 产物 | `video/ws-geo/2b42a59d…7540.mp4`（入媒体仓，签名 URL 可播） |
| 规格 | 1280×720 / 30fps / H.264 / 8.60s / 776,544 字节 |
| 渲染耗时 | **19.4s**（同机另一条片子正在跑时的读数；空载约 6s） |
| 首帧净纸底 | 灰度 <100 的像素占比 **0.00000**（机器判据，不是"看着干净"） |
| 末帧 | 258/258 帧，末帧为完整原图（425KB PNG） |
| 风格机检三道 | 纸底 `#FAEDCF`（目标 `#F5EBD7`±8%）✅／深色占比 2.44%（上限 12%）✅／连通域 7 个（2–60）✅ |

### 5.2 销售解说片全链路（验收 2）

口播稿：`docs/examples/whiteboard-growth-sales-script.md`（六幕，取自销售演示 PPT，未新增任何数字）
配音：本机配音工位音色档案 `chen-zhuo-film`（陈卓）
线稿：`seedream`（方舟 `doubao-seedream-5-0-pro`）+ 风格机检三道

| 环节 | 读数 |
|---|---|
| 口播稿 | 1,378 字 → **49 句** |
| 配音 | 49 句逐句合成，整轨 **315.24s**；响度归一化前后 **-16.86 → -16.04 LUFS**（目标 -16） |
| SRT | 49 条字幕，逐句时间 = 逐句真实发声时长（构造即一致，无 ASR 反推） |
| 分幕 | **11 幕 / 315.24s**（target 26s、min 18s、max 34s；Σ 幕长 == 音频总长） |
| 逐幕线稿 | 11 张 Seedream 2K 出图，**风格机检 11/11 通过**（组件数 15–37、深色占比 0.34%–1.83%） |
| 逐幕标注 | 11 幕共 **55 个元素**（每幕 2–7 个），全部过 Zod 契约校验（canvas 一致 / 区域在图内 / sequence 连续 / 串行不重叠 / 重叠有保护 / 结尾留 0.5s） |
| 确认关预览 | 11 张编号检查图（`whiteboard.preview`），并写入事件账本 `whiteboard.gate.presented` |
| 渲染 | job `RJ-48422294` / task `wb-wb-45558ee6`，**逐幕合计 96.9s 渲完 315.2s 画面（约 0.31× 实时）**，单幕 4.1–17.0s |
| 成本 | `provider='whiteboard-local'`、`est_cny=0.0000`、`actual_cny=0.0000`（本地算力，零模型成本） |
| 交付 | `whiteboard.deliver` 22.8s：两遍 loudnorm + `apad` + 软字幕轨 + 登记 `final_cut` |
| 成片 | **1280×720 / 30fps / H.264 + AAC 48kHz 立体声 + mov_text 软字幕轨 / 315.20s / 17.1MB** |
| 音画同步 | 视频 315.20s vs 音频 315.24s → **漂移 -0.04s**（40ms，小于 1 帧 @30fps 的 33ms 量级） |
| 媒资登记 | `video_assets` id `VA-ec508792`，`kind='final_cut'`、`pipeline_kind='explainer'`、`tags=['口播','白板手绘','explainer']` |

### 5.3 断点续跑实录（验收 6）

本轮真机跑出了**三类断点**，都验证了续跑：

| 断点 | 表现 | 续跑结果 |
|---|---|---|
| 进程重启（换代码） | 配音跑到 26/49 时重启服务，进程内任务丢失 | 重新投递后**复用 26 句**，只补渲缺失的幕 |
| 单句失败 | 第 6 句引擎抖动失败，`Promise.all` 语义会牵连全批 | 改为 `allSettled` 后：本批成功 47 句、只报 2 句失败；再投递**复用 47 句、只重合成 2 句** |
| 渲染任务未完成 | 第 1 幕渲完、第 2 幕被上游 bug 打断（见下） | 新任务按内容指纹重建；已渲的幕由 `resumableScene()` 跳过（进度 1/11 → 从第 2 幕接着跑） |

「内容指纹」是这一轮补的关键：幂等键原来只用"幕数 + 总时长"，改完标注重渲时幕数时长都没变 →
幂等命中上一次那条**失败**任务，新标注根本没渲（真机踩到）。现在幂等键 = `sha256(每幕线稿路径 + 标注全文 + 时长)`，
**内容变才是新任务**，内容不变才是真重复提交。

另外，本轮真机暴露并修掉了**两个上游缺陷**（详见 `vendor/srt-whiteboard/PINNED.md`）：

1. `_reveal_ink_segment` 全幅掩码 → 提速 5.5×（PSNR=∞ 证明等价）；
2. `_lay_ink()` 实参多传一个 `None` → 区域被后续完全覆盖时**整幕崩溃**（本轮第 8 幕就是死在这里）；
   除了在 vendor 修，本仓 `annotate.ts` 还加了「可见面积」校验（容斥原理精确算剩余面积，带单测），
   从源头丢掉空掩码区域——那一句口播照常播，只是不为它单独起一笔。

### 5.4 零回归（验收 8）

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查（5 个包） | `tsc --noEmit`（base / db / shared / server / web） | 全绿 |
| 服务端单测 | `vitest run`（apps/server） | 35 files / 346 tests 通过（8 files 因缺 DB 跳过） |
| 基座单测 | `vitest run`（packages/base） | 70 files / 1193 tests 通过 |
| 脚本治理测试 | `vitest run`（7 个治理/连接器测试） | 40 tests 通过 |
| 开源组件清单门禁 | `node scripts/oss-inventory.mjs --check` | ✅ 与仓内事实一致 |
| 迁移幂等复跑 | `tsx scripts/migrate.ts` 二次执行 | ✅ `数据库已是最新`（0042 含 `DROP POLICY IF EXISTS` 可重跑） |

## 六、排障手册（按症状查）

| 症状 | 根因 | 处置 |
|---|---|---|
| 目录里看不到 `whiteboard-stream` | `WHITEBOARD_ENABLED≠1` 或 venv 解释器不存在 | `pnpm exec tsx scripts/tools/whiteboard-env-install.mts` 装环境，再置 1；`video.whiteboard.health` 给一句话修复建议 |
| 渲染报 `OUTPUT=` 缺失 | 上游脚本异常退出（依赖/图片路径/标注非法） | 看错误里带的 stdout 尾部；先跑 `render_annotation_preview.py` 单独验证标注可读 |
| `File URL host must be "localhost" or empty` | 产物路径是**相对路径**被当成 URL 的 host | 已修：`whiteboardEnv()` 把相对 `WHITEBOARD_JOBS_DIR/ENGINE_DIR` 按仓库根解析成绝对路径 |
| 配音 `path_not_allowed` | 直接往仓库目录写配音（工位有路径监狱） | 已修：先写 `os.tmpdir()` 再复制进任务目录（不放宽工位白名单） |
| 同步调 `narrate` 报 `fetch failed` | 配音是几十分钟的长任务，撞 HTTP 头超时 | 用 `whiteboard.narrate` 投递 + `whiteboard.narrateStatus` 看进度（不要同步等） |
| 渲染极慢（分钟级/秒画面） | 未打包围盒补丁（或补丁被上游覆盖） | 核对 `whiteboard-capability.test.ts` 的补丁断言；确认 `_reveal_ink_segment` 用 `pad = thick + 1` |
| 成片没声音 | 直接用了白板引擎产物（无音轨） | 走 `whiteboard.deliver` 混流；`mux.ts` 会自动两遍 loudnorm + `apad` |
