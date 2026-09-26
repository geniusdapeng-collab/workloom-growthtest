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
| 7 | 确认关 | 三处确认点可呈现可跳过（自动模式），跳过有留痕 | ⚠️ 部分：`preview` 出编号检查图 + `updateAnnotation` 单幕返修已落地；**跳过动作未写专门留痕字段**（自动模式直接不进 preview），已在收尾报告列为未完成项 |
| 8 | 零回归 | 既有管线全绿；`WHITEBOARD_ENABLED=0` 回退 | ✅ 见 §五 回归记录 |

## 五、真机记录（本机 macOS / Node 24 / Python 3.12）

### 5.1 官方样例复现（验收 3）

（由 `video.whiteboard.verifyExample` 产出，产物入库为 `video/<ws>/<sha>.mp4`）

### 5.2 销售解说片全链路（验收 2）

口播稿：`docs/examples/whiteboard-growth-sales-script.md`（六幕，取自销售演示 PPT，未新增任何数字）
配音：本机配音工位音色档案 `chen-zhuo-film`（陈卓）
线稿：`seedream`（方舟 `doubao-seedream-5-0-pro`）+ 风格机检三道

### 5.3 断点续跑实录（验收 6）

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
