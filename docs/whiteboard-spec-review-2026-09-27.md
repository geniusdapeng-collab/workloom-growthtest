# 白板手绘动画接入规格 · Review 与实施期修正（2026-09-27）

> 被审对象：《SRT 白板手绘动画接入评估与实施规格 v1.0》（2026-09-27，交开发 Agent 落地）
> 落地对象：`workloom-ai/workloom-growth`（实验车道，本仓）
> 任务卡：[T-2026-0926-0020]（Issue #188）
> 结论：**方案方向正确、值得接**；但规格书有 **11 处与代码事实不符或不可实现之处**，
> 全部在本轮实施中修正。下表逐条给出「规格怎么写 → 实测是什么 → 怎么改 → 证据」。

## 一、逐条修正表（11 项）

| # | 规格书怎么写 | 实测事实（证据） | 本轮怎么改 | 级别 |
|---|---|---|---|---|
| 1 | §2.1/§2.2 新增 `packages/db/migrations/0041_whiteboard.sql` | **0041 已被占用**：`0041_media_sync_device_expiry.sql`（T-2026-0926-0016）在仓 | 迁移改号 **`0042_whiteboard.sql`**；并在文件头写明改号原因 | 阻断（迁移顺序冲突） |
| 2 | §2.2 「kind 幂等补齐（0040 已加 explainer 时跳过）」 | 0039/0040 **都没有**扩展 `video_projects_kind_check`；实际约束仍是 `('narrative','marketing','account_ops')` | 在 0042 里真正 `DROP CONSTRAINT` + 重建为含 `explainer`；同时扩展 `video_assets_pipeline_kind_check`（见 #3） | 阻断（建片即 500） |
| 3 | 规格全文未提 `video_assets.pipeline_kind` | 0039 给该列建了 `CHECK (pipeline_kind IN ('narrative','marketing') OR NULL)`；白板成片以 `explainer` 入库会**撞约束** | 0042 扩展为 `('narrative','marketing','explainer')`；TS 侧 `MediaColumnPatch.pipelineKind` 与 `render-poller#pipelineKindOf` 同步扩展（带单测） | 阻断（交付入库失败） |
| 4 | §2.2 迁移块用裸 `CREATE POLICY` | 本仓 0039 已确立「迁移幂等可复跑」口径（`db-gate` 会幂等复跑迁移），裸 `CREATE POLICY` 重跑即 `42710` | 改为 `DROP POLICY IF EXISTS` → `CREATE POLICY`，并用 `DO $$ FOREACH` 与 0038/0039 完全同构 | 阻断（门禁复跑失败） |
| 5 | §2.6 `provider.submit` 骨架直接写 `render_jobs` 行 | `render_jobs.script_id` 是 **NOT NULL + 外键指向 `render_scripts`**；骨架没建脚本行，直接 INSERT 必违约 | 改走 `gen/submit.ts#submitGenJob`（唯一写入口）：白板片挂一条 `render_scripts` 行（`shot_id=WHITEBOARD`），台账/事件/配额/降级链**零平行实现** | 阻断（骨架跑不通） |
| 6 | §2.6 poller 「读 status.json（同 talkcraft 口径）」+ 骨架 `writeState` | 本仓 poller 是 **DB 驱动**（`render_jobs` + `provider.poll`）；骨架的双写会漂移 | 明确分工：`render_jobs` + poller 是**状态权威**；job 目录 `status.json` 仅作**断点续跑凭据**（已 `rendered` 且产物仍在的幕不重渲）；`poll()` 以 `file://` 形态返回本地产物 | 严重（状态双源） |
| 7 | §2.3 链路里只写「两遍 loudnorm」 | 上游渲染器 `cv2.VideoWriter(mp4v)` + H.264 转码**全程不写音轨**，`merge_scenes.py` 也只拼视频轨 → 引擎产物是**无声片** | 新增 `whiteboard/mux.ts` 显式交付环节：两遍 loudnorm（先测量后归一化）+ `apad` + `-shortest` + 可选**软字幕轨**，输出 H.264+AAC 母版；`deliver` 登记 `video_assets(kind='final_cut')` | 阻断（交付无声片） |
| 8 | §2.5「元素 ground truth 来自线稿生成阶段（路径 A 的 elements 清单 + 大致方位）」 | 方舟 `images/generations` **只回图像 URL**，没有任何结构化 bbox/元素清单（`gen/providers.ts#ArkImageProvider` 的 payload 只有 prompt/size/seed） | 出图阶段不索取方位；改为出图后由 `scripts/whiteboard/lineart_tools.py analyze` 从**像素**反推（连通域 + 确定性层次聚合 + 阅读序），两条线稿路径共用同一套区域来源 | 阻断（需求不可实现） |
| 9 | §2.4 声称脚本「跨平台（win/mac 路径处理）」，§2.5 用 `render_annotation_preview.py` 做确认关 | `render_annotation_preview.py` **硬编码 `C:/Windows/Fonts/msyh.ttc`**；macOS/Linux 上直接 `OSError: cannot open resource`，确认关不可用 | 打补丁：跨平台字体候选表 + `WHITEBOARD_PREVIEW_FONT` 覆盖 + 位图兜底；标签框夹到画布内（详见 `vendor/srt-whiteboard/PINNED.md`） | 阻断（确认关崩溃） |
| 10 | §2.8 验证 1「官方样例直渲复现」未给性能预期；§2.9 把风险只归为「多幕串行」 | `_reveal_ink_segment` 每次落墨都新建/扫描**整幅**掩码（1080×600 ≈ 648KB），单次约 6ms，调用次数只与笔迹采样点数相关（**与 fps 无关**）→ 官方样例 8.6s 要调 9319 次，cProfile 实测 56.5s/62.2s 全耗在这里；单幕 4~7 分钟，且**降 fps 完全无效** | 打补丁收敛到「线段包围盒 + 笔宽外扩」：包围盒外掩码恒为 0 ⇒ AND 必为 False ⇒ 像素级语义不变。实测 4m02s → **44s（5.5×）**，与原实现逐帧比对 **PSNR=∞**（516/516 帧一致） | 严重（不修则单条片子要几小时） |
| 11 | §2.7 `WHITEBOARD_LINEART=seedream # seedream / sketch（cv2 素描化默认路径）` | 注释自相矛盾（值写 seedream、注释说默认走 sketch）；且 `prepare_env.py` 不判 Python 版本——3.9 会先建 venv、再在 pip 阶段失败，报错与根因不匹配 | 明确「值即默认、注释不表态」；`prepare_env.py` 增加 `>= 3.10` 版本闸与 `WHITEBOARD_PYPI_INDEX` 支持；安装器 `whiteboard-env-install.mts` 先选解释器再建 venv | 一般（可读性/可运维性） |

## 二、规格书未覆盖、但实施中必须补的 6 件事

| # | 缺口 | 为什么必须有 | 本仓落地 |
|---|---|---|---|
| A | **配音环节没有落点** | 规格 §2.3 从「口播稿」直接跳到「SRT」，而 SRT 只能从配音时长派生；不定义配音就没有时间轴 | `whiteboard/narration.ts`：口播稿 → 逐句合成（本机配音工位）→ **逐句真实时长** → SRT；分句/分幕全确定性 |
| B | **配音是长任务，同步 mutation 撑不住** | 本机克隆音色引擎单句 **80–220s**，49 句要一小时；同步 HTTP 会撞 undici 的 300s 头超时（真机 `fetch failed`，服务端其实还在跑） | `narrate` 改为**异步投递** + `narrateStatus` 进度面；进度写 `whiteboard_films.narration_done/total/note`；逐句音频落盘可**断点续跑** |
| C | **配音工位有"路径监狱"** | `voice-bridge/core.mjs#assertPathAllowed` 只允许写工位目录 / `~/Movies` / `~/Desktop` / `os.tmpdir()`；任务目录在仓库内 → `path_not_allowed` | 不为一个调用方放宽**全局安全边界**：改为先写 `os.tmpdir()` 暂存、再复制进任务目录（最小权限） |
| D | **幕长与音频总长必须精确相等** | 幕长 = 首句起 → 末句止时，视频比配音短，末尾半句会被截 | `srt.ts#tileScenes`：每幕结束推到**下一幕首句起点**，末幕推到音频总长 ⇒ Σ 幕长 == 音频时长；逐句 SRT 仍保留真实发声区间（不被拉长） |
| E | **元素数 = 句数 会太"空"** | 一句口播常讲三件事；一屏只画两笔时动感与信息密度明显不足 | `annotate.ts#planElements`：按句长把每句拆成 1–3 个画面元素（约每 22 字一笔，整幕上限 8）；**字幕本身不拆**（不把完整句子腰斩） |
| F | **上游执笔手素材带第三方渠道标识** | `assets/drawing-hand.png` 笔杆印着上游作者标识（"江哥是老登啊"），出现在 WorkLoom 对外销售片里不合适 | 本仓自有中性素材 `assets/whiteboard/drawing-hand-workloom.png`（`lineart_tools.py hand` 可重生成，可审计）；上游素材仅保留用于官方样例复现 |

## 三、规格书中「确认无误」的部分（照做）

- §1.1 引擎事实：CLI 末行 `OUTPUT=`、`--ink-path grid|skeleton`、`--color-fill contour-wipe|brush`、
  `--pause` 在逐区域画法下几乎无效（上游注释自述"预留"）——**核对一致**；
- §1.1 依赖闭包（opencv-python / numpy / PyAV / Pillow，无需系统 ffmpeg）——**核对一致**（`prepare_env.py` 的 pip 依赖清单）；
- §1.1 许可证 MIT、可商用——**核对一致**（`vendor/srt-whiteboard/LICENSE` 原文保留）；
- §1.2 与 talkcraft 的互补关系、§1.3 定位为 `kind='explainer'`——**照做**（0042 扩展 kind，白板引擎与未来的动效引擎共享同一片型）；
- §2.3 的 8 个环节顺序——**照做**（新增 `narrate`/`deliver` 两个显式落点，其余环节一一对应）；
- §2.4 统一出图视觉规范（纸底 `#F5EBD7`、深灰线条、禁止文字/写实/3D）——**照做**，提示词逐条固化在 `lineart.ts#LINEART_STYLE_PROMPT`；
- §2.4 机检三道（背景主色 / 大面积深色块 / 连通域数）+ 重出 ≤3 次——**照做**，且把上一轮机检失败读数**写回提示词**（不是换 seed 重采样）；
- §2.10 验收表 8 项——**全部落地**（证据见 `docs/whiteboard-engine.md` §验收对照）。

## 四、有意不做的两件事（边界声明，不是遗漏）

1. **不新增白板专属围栏包**（如 `fences/ai-video-whiteboard.yml`）。
   理由：白板渲染走的是既有 `render.submit` 动作，G8 前置门（`loadActiveRulesInTx` + `judge`）已覆盖
   "烧算力要过闸"这条语义；新增围栏包要连带改 `bundle.json` 的 provides/签名与门禁清单，
   属于产品化任务（对应规格 §2.8 的 T-2026-0927-0002 P2），不在本轮接入范围。
   **当前后果**：白板片不参与"其他片型专属红线"（例如营销片的事实红线闸）——这是刻意的：
   白板片是**纯本地零成本渲染**，不触外部账号、不发布、不涉钱。
2. **不实现上游 `assets/preview.html` 的浏览器预览台自动化**。
   理由：上游预览台依赖 File System Access API 与用户手势，无法在服务端无人值守流程里驱动；
   本仓把它的**等价能力**做成 `whiteboard.preview`（出编号检查图）+ `whiteboard.updateAnnotation`（改标注后只重渲该幕），
   覆盖了同一确认关语义。预览台文件仍随 vendor 分发，人工细调时可直接打开。

## 五、结论

规格书的方向、定位与验收表可以直接照用；但**照抄 DDL 与 provider 骨架会跑不通**（迁移号冲突、
kind 约束未扩展、`render_jobs` 外键、无声片、不可得的元素方位、确认关崩溃、渲染慢 5.5 倍）。
上述 11 项修正 + 6 项补齐已全部实施并有证据（`docs/whiteboard-engine.md`）。
