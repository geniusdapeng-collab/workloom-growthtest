# 验收片：陈卓 × 获客增长系统（销售口播 · 93s · 1080×1920）

> T-2026-0926-0010 · 2026-09-27 · 输入见同目录 `script.md`（口播稿）与 `shot-plan.json`（导演分镜计划）
>
> 这条片子是「口播解说片」引擎的**真机验收样本**：从口播稿到交付成片，全程走本引擎的真实链路
> （配音工位 TTS → mlx-whisper 字级对齐 → 语义/分镜 → 工程装配 → Remotion 分段渲染 → 机器闸六条 → 两遍 loudnorm），
> 不是手工拼的演示片。

## 一、产物

| 产物 | 路径（任务目录 `var/talkcraft-jobs/chenzhuo-growth/`） |
|---|---|
| 口播稿 | `script.json` / `script.txt` |
| 配音（逐句合成 + 句间气口） | `audio/full.wav` |
| 字级时间戳 / 模板时间轴 | `audio/timestamps.json`、`remotion/src/timing.json` |
| 语义标注 / SHOTBOOK（JSON + 可读版） | `semantics.json`、`shotbook.json`、`SHOTBOOK.md` |
| 工程（受控模板 + 逐镜派生场景 + 引擎卡） | `remotion/`（`src/scenes/*`、`src/cards/*`、`props.json`、`beats.json`、`anchors.json`、`cues.json`） |
| 成片（渲染拼接 + 整条音轨混入） | `out/v1.mp4` |
| 交付片（两遍 loudnorm，I=-15/TP=-1.5/LRA=11） | `out/delivery.mp4` |
| 机器闸报告 / 评审材料 | `out/qa-report.json`、`out/qa-frames/`、`out/qa-sheets/` |
| 运行报告 | `run-report.json` |

## 二、制作参数

| 项 | 值 |
|---|---|
| 画幅 / 帧率 | 1080×1920（9:16）/ 30fps（2783 帧 · 99.91s） |
| 配音 | 本机配音工位 `chen-zhuo-film`（陈卓音色档案，零样本克隆） |
| 句间气口 | 520ms（逐句合成，让音效有落点） |
| 字数 / 句数 | 428 字 / 14 句 |
| 镜头 / 用卡 | 14 镜 / 14 张卡（split-text-stagger、lead-word-zoom-assemble、info-card-assemble、unit-grid-proportion、chart-grow、flying-words、alt-block-lines、source-converge、grid-to-hero、tracking-in、line-by-line-slide、per-character-rise、chip-grid-single-select、word-relay-filmstrip） |
| 引擎 | video-talkcraft（108 张卡，PINNED commit 见 `vendor/talkcraft/PINNED`） |
| 许可 | `noncommercial`（评估口径；商用前需作者书面授权，见 docs/talkcraft-explainer.md §2） |
| 交付文件 | `out/delivery.mp4` · 30,105,298 字节 · sha256 `2909f9a3…` · 两遍 loudnorm（I=-15/TP=-1.5/LRA=11） |

## 三、机器闸六条

| 闸 | 命令 | 结论（实测） |
|---|---|---|
| 静止/抖动 | `motion_check.py out/v1.mp4 --window <每镜两点> --anchors remotion/anchors.json` | **PASS** —— no static stretch >= 0.8s |
| 音效在场 | `sfx_check.py out/sfx-solo.wav remotion/cues.json` | **PASS** —— 中位 cue 峰值 −27.1 dBFS（参考区间 [−30,−10]） |
| 音效可听 | `sfx_check.py --mix out/v1.mp4 audio/full.wav remotion/cues.json --timestamps audio/timestamps.json` | **PASS**（14 记 cue 全部落在 ≥0.5s 气口） |
| 卡保真 | `card_lint.py remotion/src <14 张卡>` | **PASS** —— 复制件相似度 1.00（未重写任何动效） |
| 词落点 | `beat_lint.py remotion/beats.json audio/timestamps.json --shots remotion/shots.json --anchors remotion/anchors.json` | **PASS** —— 首条 t=0.480「大家」Δ+0.000s |
| 评审材料 | `qa_extract.py` + `contact_sheet.py` | **PASS** —— 123 帧 / 11 张拼图 |

## 四、诚实边界（这条片子**不是**什么）

- 人物是**定妆照驱动的循环底板**（12s 极缓推近），不是唇形同步的说话人素材；
  因此 `preflight --host` 的"素材时长=配音时长"断言不适用（已在本引擎里显式跳过并说明）。
- 卡片文案改写走 `consts`/`replaces` 两条数据通道，**没有重写任何卡的动效实现**（card_lint 保真核验）。
- 音效只用了引擎采样库里的 14 记边界音；未铺 BGM（BGM 属后期链路，本片未启用）。
- 评审（关卡 2）由本机代理按 rubric 复核拼图与 QA 报告，非人类评审；结论见 `qa-report.json` 与本文第五节。

## 五、联调中发现并修掉的问题（都在本 PR 里）

| # | 现象 | 根因 | 处置 |
|---|---|---|---|
| 1 | 工位拒收：`path_not_allowed out` | 工位只允许写自己的目录与用户目录 | 产物落工位 `deliveries/` 再拷进工程 |
| 2 | `fetch failed`，一次失败 = 整篇重合成 | 工位单进程整篇合成 14 句要 20 分钟以上，高负载下桥挂起 | 改为**逐句合成** + 句产物缓存（断点只补缺句） |
| 3 | `render_shots` 断言"拼装总帧数 2763 != 2783" | 首镜从首字（0.68s）开始，0–0.68s 无段覆盖 | 分镜时间首尾相接：首镜从 0 起、末镜补到配音总长 |
| 4 | CLI 干等 60 分钟报"渲染超时" | `poll(taskId)` 按 `jobsDir/<taskId>` 找状态文件，而工程目录名不同 | taskId→jobDir 指针落盘 + 状态文件长期缺失即快速失败 |
| 5 | `card_lint`：工程里没有 `src/cards/*.tsx` | 复制复跑时只登记"新复制的卡"，清单为空 | 用卡清单无条件登记 |
| 6 | `beat_lint` IndexError | `beats.sentence` 写成 1 基句号，脚本按列表下标取 | 改 0 基（与引擎契约一致） |
| 7 | 帧 410 崩：`mixHex(undefined)` | 对象型内容槽被整体覆盖，时序/几何键丢失 | 对象槽浅合并；解析不成对象即拒绝补丁 |
| 8 | 抖动闸 `crop=1200:...` 崩 | 引擎默认裁剪带是横屏版面口径 | 按画幅给合法裁剪带 + 每镜两点采样窗 |
| 9 | 静止 ≥0.8s ×9（反 PPT 闸 FAIL） | 相机 1.005→1.035（约 0.5%/s）在帧差阈值下看不见 | 相机改 1.01→1.05/1.09/1.13（仍只做 scale） |
| 10 | `sfx_check --mix` MASKED 71% | cue 落在语音里（14 处 ≥0.5s 气口命中 0 处）；且 `end-0.35` 用了**未接缝**的镜尾 | 句间气口 520ms + cue 锚点改用接缝后的镜尾 |
| 11 | solo 轨闸读旧产物报 −140dBFS | solo 轨复用条件只看"文件在不在" | props 比 solo 新即重渲 |
| 12 | 单卡文案溢出（s11 三行被截） | 卡版面按 ≤10 字/行设计，我们的句子过长 | 缩短文案后**只重渲 s11**（`--render-scope only:s11`）→ 复跑闸与交付 |

## 六、耗时（本机实测 · 8GB Apple Silicon · 期间机器负载较高）

| 阶段 | 耗时 |
|---|---|
| TTS（15 句逐句合成，首次） | ≈35 min（逐句 1–4 min；缓存后重跑 0s） |
| 字级对齐（mlx-whisper） | ≈50 s |
| 工程装配 + 素材体检 | ≈20 s |
| Remotion 分段渲染（14 段 · 2 并行 · 含整条音轨） | 407–646 s |
| 机器闸六条 + 交付（两遍 loudnorm） | ≈4 min |
| 单镜返修（s11 重渲 + 复跑闸 + 交付） | ≈6 min |
