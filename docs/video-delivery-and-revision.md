# 视频交付与返修机制（旁挂字幕 · 多风格变体 · 层增量重合成）

> 任务卡：`T-2026-0924-0070` ｜ 建立日期：2026-09-24 ｜ 适用包：`bundles/ai-video`
> 涉及工位：`connectors/post-bridge`（新增）、`connectors/subtitle-bridge`（扩展）、`connectors/bgm-bridge`（修复）、`connectors/color-bridge`（复用）
> 真机验证：本地 Mac + ffmpeg 6.0 + 随仓字体/曲库，数据见 §7

## 1. 需求（产品所有者原话 → 设计目标）

| 原话 | 设计目标 |
|---|---|
| "生成视频的时候，把字幕文件也一起生成；不要渲染进视频，文件单独分离" | **母版永远不烧字幕**；同一次生成就产出 `srt/ass/vtt` + 清单；要带字幕的片子走软字幕轨或另存烧字副本 |
| "有些片子需要带字幕，有些不需要" | 同一支干净母版派生"带字幕/不带字幕"两支，画面**逐帧一致**（不各烧一遍、不重剪） |
| "默认合成几个不同版本…封面设计、BGM 配乐、文案和调色…给用户几个风格有明显差别的版本让他选" | **风格变体矩阵**：五个轴（调色/BGM/转场/封面/文案）派生 2–3 个实测可辨的版本 + 交付清单 |
| "token 费用主要在素材镜头生成，后期消耗小" | 镜头**只生成一次**；变体只吃本地算力，清单里写 `tokenCostDelta: 0` |
| "不要从头再生成，时间太长也浪费资源" | 返修先做**变更影响分析**：能在本地重合成的绝不去烧渲染额度 |
| "确实需要重新生成的时候，再重新生成镜头，然后再走本地编辑" | 只有**点名到画面内容**才重生成镜头（逐镜点名 + G8 人审），之后回到本地合成 |
| "在我们系统里形成一个固定的反馈优化方案和机制" | 反馈 → 归因分诊 → 影响分析 → 层增量重合成 → 返修回执 → 经验沉淀（技能 + 围栏 + 枚举 + 管线步骤） |

## 2. 改造前的问题（读码结论，出处可查）

| 现状 | 问题 |
|---|---|
| `scripts/tools/full-chain-film.mts` 字幕阶段固定调 `subtitle-cli burn`，产出 `master-subtitled.mp4` | **不可逆**：像素被改，"不要字幕"的诉求只能重剪；字幕文件只有中间产物 `subtitle.srt` |
| 字幕工位工具面只有 `plan/burn/title/danmaku/sticker/karaoke/best` | 没有"旁挂字幕交付"与"软字幕轨"两个动作（`subtitle-bridge/README.md` v1.1 口径） |
| `scripts/tools/post-production.mts` 调 vendor `PostProductionEngine` 出 4 个"版本"（standard/clean/subtitled/raw） | 产出的是 **HTML 组合稿**（`composition.html` + `config.json`）与 `renderCommand` 文本，**没有真的渲染成 MP4**；用户拿不到"能看的几个版本" |
| 返修只能整链重跑（`--stages …` + `render-project.mts`） | 改一句字幕也要重新跑后期，改画面内容才会走渲染；缺少"改哪一层"的显式判断 |
| `bgm-bridge.mix` 的让位混音渲染 `ducked-music.wav` 用 `-stream_loop -1` + `atrim` 收口 | 侧链先 EOF 时 `sidechaincompress` 会**挂死**（真机实测 0% CPU、`-t` 也救不回来；见 §5.4） |

## 3. 目标形态：一次生成 = 一个交付包

```
<交付目录>/
  master/master-clean.mp4                    干净母版（无字幕、无变体调色）—— 后续一切派生的地基
  subtitles/<项目>.zh.srt|.zh.ass|.vtt       旁挂字幕（母版不烧字；ASS 与烧录同源）
  subtitles/<项目>.subtitle-manifest.json    时间轴回读 / 字体解析 / 版式体检 / 母版未改动证据
  variants/<变体>/<变体>.mp4                 变体成片（无字幕轨）
  variants/<变体>/<变体>.softsub.mp4         同画面 + 可开关字幕轨（视频/音频逐帧零改动复检）
  variants/<变体>/<变体>.burned.mp4          可选：硬字幕副本（要就多出一支，母版仍干净）
  variants/<变体>/cover.png                  封面（按变体版式与文案渲染）
  variants/<变体>/copy.md|copy.json          文案包（标题/钩子/正文/话题/CTA + 四条校验）
  variants/<变体>/audio.json                 曲目/许可/署名/请求电平→实际电平/LUFS 复检
  film-project.json                          工程文件（层结构 + 产物血缘）—— 返修入口
  delivery-manifest.json                     交付清单（全产物 sha256 + 变体差异实测 + 成本口径）
  delivery-report.md                         人看版说明（变体对照表 / 返修路径 / 未达标项）
  versions/vN/…                              第 N 轮返修的新版本目录（只增不覆盖）
```

**"给谁用、解决什么问题"**：给剪辑师/交付岗（数字员工）与最终客户。解决的是"用户可能不满意 → 服务方重跑整片"
这条既贵又慢的回路：把"不满意"收敛成"从几个明显不同的版本里挑一个"或"按层改一小块"。

## 4. 五个风格轴与默认变体

| 轴 | 取值来源 | 变体差异的观感 |
|---|---|---|
| 调色 | `library/color-recipes` + `library/luts`（profile / LUT × intensity） | 冷暖、浓淡、质感 |
| BGM | `library/bgm-library*`（情绪/曲风 × 电平 × 分层策略） | 情绪与节奏 |
| 转场 | `hard` 硬切 / `fade` 慢入慢出 / `xfade` 交叉溶解 | 片子的呼吸 |
| 封面 | 抽帧时刻 × 版式 × 标题钩子 | 点击率 |
| 文案 | 标题模板 / 开场 / 收尾 / CTA / 话题 | 说什么、怎么说 |

默认三包（`library/style-variants/`）：

| 变体 | 定位 | 配方差异 |
|---|---|---|
| `warm-story` 暖调故事版 | 情感/文旅/民宿 | warm-film LUT @0.75 · fade 0.6s · acoustic-warm −23dB · 留白题签封面 · 温暖克制口吻 |
| `clean-tech` 干净科技版 | 产品/科技/知识 | cool-technical @0.7 · hard · corporate-clean −25dB · 参数卡封面 · 简洁理性口吻 |
| `bold-promo` 强推促销版 | 带货/本地生活 | high-contrast-social @0.9 · xfade 0.35s · sports-hype −21dB · 促销横幅 · 直接叫卖口吻 |

**差异必须实测**（而不是"配方不同"）：画面用平均像素差（`>=4/255` visible、`2–4` subtle、`<2` negligible）、
音轨用曲目/分层是否不同、封面两两像素差。任一对变体"画面与音轨同时测不出差别"→ **拒绝交付**（G-DLV1）。

## 5. 关键机制

### 5.1 母版不烧字 + 三条落地方式同源

字幕师先用 `subtitlewrite.sidecar` 出旁挂文件（`srt` / 带版式 `ass` / `vtt` + `subtitle-manifest.json`），
三条落地路径共用同一份 ASS 生成器与字体选型，因此观感一致：

1. **不用**：旁挂文件就留在交付包里（平台后台上传口/剪辑软件可用）；
2. **要带字幕但不改画面**：`subtitlewrite.softmux` 内嵌为**可开关字幕轨**（`-c:v copy -c:a copy`），
   复检四件：视频轨逐帧哈希一致 / 音轨一致 / 时长保持 / 字幕轨数量与语言齐备；
3. **明确要硬字幕**：`subtitlewrite.burn` 另存 `*.burned.mp4`，**母版保持干净**（围栏 G-DLV2 阻断烧母版）。

旁挂交付会同时验证"源母版未被改动"（大小 + mtime + sha256 三验），把"只写文件"这件事也变成可核实的回执。

### 5.2 多风格变体：一次跑完、逐项记账

`postwrite.package` 的顺序：归一化（一次，全变体共用）→ 按变体拼接（转场差异）→ 按变体调色（可见性校验）
→ 按变体选曲混音（LUFS/人声余量/可闻度复检）→ 封面 → 文案 → 软字幕轨 → 清单 + 工程文件。

每一层都有**按内容哈希的缓存**（`work/norm`、`work/assemble`、`work/graded`、`work/audio`），
这让"不重算"在体系上成立（而不是靠"记得别重跑"）：内容没变 → 键不变 → 直接复用。

成本口径写进清单：`shotGeneration: reused`、`tokenCostDelta: 0`。

### 5.3 返修：先影响分析，再层增量重合成

```bash
post-cli triage  --feedback "配乐太吵，另外第 3 个镜头人物走形" --project <交付包>/film-project.json
post-cli impact  --project <交付包>/film-project.json --patch patch.json
post-cli reedit  --project <交付包>/film-project.json --patch patch.json
```

| patch 命中 | 重算的层 | 是否重生成镜头 |
|---|---|---|
| `subtitles.*` | `text` | 否 |
| `bgm.*` | `audio` | 否 |
| `color.*` | `color` → `audio`（调色会重编码音频轨，母版必须同源） | 否 |
| `transitions.*` | `assemble → color → audio → text` | 否 |
| `cover.*` / `copy.*` | `cover` / `copy` | 否 |
| `shots.regenerate: [SC-03]` | `shots → assemble → color → audio → text` | **是**（逐镜点名 + G8 人审） |

纪律：

- **未知 patch 键直接报错**（不静默忽略）；
- patch 里的镜头 id 必须存在于工程文件（点名不存在的镜头 → 报错）；
- 点名到画面内容时 `reedit` **拒绝执行**并返回计划（退出码 4）：先过闸 + `render-project.mts --only SC-03`，
  再带 `--shot SC-03=<新文件>` 回到本地合成；
- 复用要带证据（sha256 + "未被重算"说明），镜头层与工程文件逐镜比对，被外部改动过就如实标注（G-DLV7）；
- 连续返修（v2 → v3）不受影响：每轮工程文件的路径都按自己的目录重写。

### 5.4 反馈分诊：确定性规则表

`postwrite.triage` 把自由文本映射到归因码与受影响层（`REVISION_RULES`，不依赖 LLM，可复算可考试）：
`rev.text.track` / `rev.audio.mix` / `rev.color.look` / `rev.edit.pacing` / `rev.cover.layout` / `rev.copy.tone` /
`rev.shot.content`（需要重生成，走 G8）。识别不了就返回 `unclear` 并列出可选轴，**不猜**。
镜头点名支持 `SC-03`、"镜头3"、"第 3 个镜头"、"shot 3"。

### 5.5 顺手修掉的两个上游问题（真机暴露，非本任务引入）

| 问题 | 现象 | 处置 |
|---|---|---|
| `bgm-bridge.mix` 让位混音挂死 | 音乐输入 `-stream_loop -1` 永不 EOF，侧链（原片音轨）先 EOF 时 `sidechaincompress` 等一个不来的帧：实测 0% CPU 挂 14 分钟（`-t` 无效，因为滤镜图不再产帧） | 侧链加 `apad`（两端都无限）+ 输出 `-t <片长>`；修复后同一片子混音从"挂死"变为秒级完成 |
| `bgm-capability.test.ts` / `acquisition-loop.test.ts` 既有红灯 | 随仓兜底曲库（2026-09-23）与"制片人"岗位（2026-09-24）入库后，测试里写死的"单库假设"和"76 岗"未同步 | 断言收敛为可核实事实（自定义根 present=false、兜底库在位；组合编制 77 岗） |

### 5.6 选择结果回流偏好池（2026-09-24 补：闭环另一半）

交付包界面上的"选这个版本"不只是记录一次点击，而是**组织口味的一次采样**：

```
用户点选 → delivery.variant.selected 事件（五元账本，同一事务）
        → org_memory(kind='preference', scope='workspace') 写入
           内容：【交付口味】<项目> 选择了「暖调故事版」｜定位：情感/文旅｜
                风格：调色 warm-film@0.75 · 配乐 温暖自在 · 转场 fade 0.6s · 文案口吻 温暖克制
                后续同类题材出片时，把该风格作为变体集合的首选与默认
           memory_id：mem-pref-delivery-<工作区>-<变体>（反复选择是**更新同一条**，不堆新行）
           confidence：0.5 起、每次选择 +0.05、上限 0.9（只升不降，留人审上调空间）
        → packages/runtime/src/loop.ts / ask.ts 执行前注入（loadActivePreferences + buildPreferenceBlock）
        → 下一轮出片的提案与变体默认值自动贴合这口味（不重训任何模型）
```

纪律：

- **与事件同一 COMMIT**（D16）：动作与偏好要么都留下，要么都不留；
- **行业措辞写在行业层**（`apps/server/src/video/delivery.ts#buildVariantPreferenceContent`），
  基座 `evolve` 只提供通用的偏好检索/注入与 `upsertMemoryInTx` 写入原语——底座行业零残留（D18）；
- **偏好不是围栏**：口味类信号只进偏好池（主观通道），永远不编码进围栏 DSL；
- 内容经 workdata `maskText` 脱敏后落库（与董事长反馈同一条路径）。

## 6. 接口与数据模型

### 6.1 工具面（工位 `127.0.0.1:9777`）

| 工具 | 类型 | 说明 |
|---|---|---|
| `postread.health` | 读 | ffmpeg / 变体包 / LUT / 曲库 / 字幕工位体检 |
| `postread.plan` | 读 | 交付计划（镜头清单、变体各轴取值、步骤、成本口径） |
| `postread.impact` | 读 | 变更影响分析（重算层 / 是否重生成 / 花钱闸 / 理由） |
| `postwrite.package` | 写 | 出交付包 |
| `postwrite.reedit` | 写 | 本地层增量重合成 |
| `postwrite.triage` | 写 | 反馈分诊 |

字幕工位新增两个工具：`subtitlewrite.sidecar`、`subtitlewrite.softmux`（工具面 12 → 14）。

### 6.2 工程文件（`film-project.json`，schema `workloom.film-project/v1`）

```jsonc
{
  "projectId": "VID-…", "version": 1, "resolution": [1080, 1920], "fps": 30,
  "layers": {
    "shots": [{ "shotId": "SC-01", "source": "…", "normalised": "work/norm/…", "sha256": "…" }],
    "transitions": { "mode": "fade", "fadeSec": 0.4 },
    "text": { "sidecarDir": "subtitles", "files": [{ "lang": "chi", "format": "srt", "sha256": "…" }], "burnedInMaster": false },
    "variants": [{
      "id": "warm-story",
      "assembly": { "path": "work/assemble/…mp4", "reused": false },
      "color":    { "path": "work/graded/…mp4", "profile": "warm-film", "lut": "look-warm-film.cube", "intensity": 0.75 },
      "bgm":      { "trackId": "acoustic-warm-…", "policy": "keep-dialogue" },
      "artifacts": { "video": { "path": "…", "sha256": "…" }, "softsub": { … }, "cover": { … }, "copy": { … } }
    }],
    "copy": { "title": "…", "hook": "…", "hashtags": ["…"], "cta": "…" }
  },
  "cache": { "workDir": "work", "packageKey": "…" },
  "history": [{ "kind": "initial-delivery" }, { "kind": "revision", "localOnly": true }]
}
```

路径一律**相对工程文件所在目录**（整包可搬走；返修多轮也不会指错）。绝对路径仍兼容解析。

### 6.3 patch 契约（`postwrite.reedit` 输入）

```jsonc
{
  "subtitles": { "zhText": "…或 zhPath", "enPath": "…", "style": {}, "burn": false },
  "bgm":       { "variantId": "clean-tech", "trackId": "…", "mood": "…", "policy": "keep-dialogue", "musicLevelDb": -27, "enabled": true },
  "color":     { "variantId": "…", "profile": "warm-film", "lut": "look-warm-film.cube", "intensity": 0.8 },
  "transitions": { "variantId": "…", "mode": "xfade", "fadeSec": 0.35 },
  "cover":     { "variantId": "…", "at": 0.35, "alignment": 2, "subtitle": "副标题" },
  "copy":      { "variantId": "…", "titleTemplate": "…", "cta": "…", "hashtags": [] },
  "variants":  { "add": [], "remove": [] },
  "shots":     { "replace": [{ "shotId": "SC-03", "path": "…" }], "regenerate": ["SC-03"] }
}
```

### 6.4 回执（`revision.json`，schema `workloom.delivery-revision/v1`）

`version` / `patch` / `impact` / `rebuilt[]` / `reused[]`（含 sha256 证据）/ `outDir`。
交付时对用户说清三件事：**改了什么 / 没动什么 / 花了什么**（本地算力 or 渲染额度）。

## 7. 真机验证（2026-09-24，本地 Mac）

素材：3 镜 × 9s（1280×720 → 归一化 1080×1920@30fps），带房间底噪 + 人声频段脉冲（让配乐工位能实测人声余量）。

| 场景 | 实测结果 |
|---|---|
| 交付包（3 变体 + 中文字幕） | 68 秒；9 项检查全绿（母版零烧字 / 旁挂字幕 / 变体差异 / 封面差异 / 配乐层 / 软轨画面零改动 / 时长一致 / 变体数量 / **计划-实际时长一致**）※ 第 9 项 `duration_plan_consistent` 需调用方传入计划总时长（`project.targetDurationSec`）；未提供时该项标记"未校验"而非静默通过 |
| 变体差异 | 两两画面平均像素差 **16.71 / 19.95 / 9.81**（均 `visible`）；音轨曲目两两不同；封面两两像素差 25–35 |
| 配乐复检 | `bold-promo` 首档 −21dB 越过人声余量红线 → 自动降 3dB 到 −24dB 后通过，`audio.json` 记录 `requestedMusicLevelDb → appliedMusicLevelDb` |
| 软字幕轨独立复核 | 三个变体的 `-softsub.mp4` 与无字幕成片在 0.5s / 13s / 26s 处的**帧哈希完全一致**（外部复算，非工具自证） |
| 只改字幕的返修 | **2.4 秒**完成；重算层 `text`，复用层 `shots/assemble/color/audio/cover`；三个变体成片与上一版**逐字节一致**（sha256 相同），仅字幕文件与软轨变化 |
| 只改某变体配乐电平 | 4.5 秒；命中混音缓存（未重跑混音），软字幕轨重出 |
| 点名镜头重生成 | `reedit` 拒绝执行（退出码 4）并给出"先 G8 人审 + `render-project.mts --only SC-03`"的两步计划 |
| 反馈分诊 | "配乐太吵，另外第 3 个镜头人物走形，换个封面" → `rev.audio.mix` + `rev.shot.content` + `rev.cover.layout`，点名 `SC-03`，标注需人审 |
| 单元/回归 | `pnpm -C packages/base test`：66 文件 / 934 用例全绿（含新增 25 条交付与返修用例）；`packages/base typecheck` 通过；`pnpm bundle:governance` 通过 |

## 8. 边界：这套机制**不解决**什么

1. **不替用户定风格**：变体只负责"给出明显不同的选择"，选哪个是用户的决定（选择事件回流是下一步）；
2. **不做可视化剪辑界面**：本轮的"本地编辑器"是工位 + 工程文件 + 命令行（`cli.mjs`），
   在应用里点选变体/提返修的界面属于下一步（见 §10）；
3. **不做跨租户素材搬移**：素材路径受工位路径监狱约束（`WORKLOOM_POST_ALLOWED_ROOTS`）；
4. **不解决"素材本身不行"**：画面抖动/过曝/已带硬字幕一律退回上游，不靠后期掩盖；
5. **不自动烧钱**：需要重生成镜头时只出计划 + 审批闸，不擅自执行；
6. **vendor `PostProductionEngine` 的 HTML 版本仍未渲染成 MP4**：本机制用它产出的"干净母版 + 变体"取代了
   "HTML 组合稿"这条死路（用户拿到的是能播的 MP4），但 vendor 侧那四个 HTML 版本没有清理，属遗留。

## 9. 运维

```bash
# 起工位（本机）
WORKLOOM_POST_BRIDGE_TOKEN=<token> node bundles/ai-video/connectors/post-bridge/server.mjs   # 127.0.0.1:9777

# 常用命令
post-cli health | variants
post-cli plan     --project project.json --shots a.mp4,b.mp4
post-cli deliver  --project project.json --shots a.mp4,b.mp4 --out-dir out/ --srt subs.srt
post-cli impact   --project out/film-project.json --patch patch.json
post-cli reedit   --project out/film-project.json --patch patch.json
post-cli triage   --feedback "…"

# 全链路出片（母版默认不烧字）
tsx scripts/tools/full-chain-film.mts --shots shotlist.json --project VID-1 --out 交付目录 --subtitle-mode sidecar
```

环境变量：`WORKLOOM_POST_BRIDGE_PORT`（9777）、`WORKLOOM_POST_ALLOWED_ROOTS`（路径监狱）、
`WORKLOOM_POST_WORK_DIR`（缓存，默认 `~/.workloom-post`）、`WORKLOOM_POST_FFMPEG_PATH` / `WORKLOOM_POST_FFPROBE_PATH`。

围栏：`bundles/ai-video/fences/ai-video-delivery.yml`（G-DLV0…G-DLV7）；字幕侧同步扩到
`ai-video-subtitle/v3`（旁挂与软轨纳入 G-SUB0/2/3/5，不计入 G-SUB4 渲染配额）。

## 10. 已交付与下一步

已交付（原 P1 清单，2026-09-24 收口）：

| 事项 | 落地位置 |
|---|---|
| 应用内"交付包"视图：变体对照（封面/文案/BGM/调色）+ 点选 + `delivery.variant.selected` 事件 | `apps/web/src/extensions/ai-video/pages/Delivery.tsx`（`?tab=delivery`） |
| 应用内返修入口：自然语言 → `postwrite.triage` → patch → `postwrite.reedit`，进度与回执上屏 | 同页返修区 + `video.delivery.{triage,startRevision,job}` |
| 偏好回流：选择结果写入 `org_memory(kind='preference')`，经执行前注入影响下一轮出片 | §5.6；`buildVariantPreferenceContent` / `deliveryPreferenceMemoryId` / `deliveryPreferenceConfidence` |

下一步（尚未交付）：

| 优先级 | 事项 | 价值 |
|---|---|---|
| P1 | 返修归因接入考试院错题本（目前只进偏好池与账本） | 反复被打回的层沉淀成考题与技能迭代依据 |
| P1 | 变体默认集合按偏好自动重排（当前偏好已注入上下文，但变体顺序仍固定） | 让"选过一次"直接改变下一轮的默认顺序 |
| P2 | 变体差异阈值按题材校准（目前统一 4/255 visible） | 美食/纪实等"本就低对比"的题材减少误判 |
| P2 | 音频层与调色层解耦（调色时音频流 copy），省掉"改调色必重算混音" | 少一次混音（约数秒到数十秒） |
| P2 | 清理 vendor `PostProductionEngine` 的 HTML 版本路径 | 去掉与交付包重复的旧通路 |
