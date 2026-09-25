# 真实素材用途硬约束 + 字幕标点口径 + 封面设计师（2026-09-25 · T-2026-0924-0001 第三次收口）

> **口径升级（2026-09-25 第三轮，产品所有者原话）**：
> "图片只是实景素材参考，是用来构建真实视频场景的，不是简单做个运镜了事，我们做的是视频。"
> 因此素材镜的合法形态从"参考输入 + 不许静态直出"升级为 **`material-scene/v1`：素材只作实景依据，
> 成片必须是模型构建出来的完整视频场景**。落地三点：
> ① 素材以 `reference_image` 角色提交（**不再作 `first_frame`**——首帧就不该是那张照片）；
> ② 提示词换成 `buildMaterialScenePrompt`（要求自选机位/焦段、真实三维视差、环境运动、补全画面边缘）；
> ③ 新增硬闸 `scene-constructed`：把成片首帧/中段与参考素材做最佳匹配与直比，只要还能高精度对回参考图
> （首帧 ≥32dB / 直比 ≥40dB / 中段 ≥34dB）即判"参考图被推动"，一票否决（阈值在 `REFERENCE_INDEPENDENCE_POLICY`）。
> 后期数字运镜（变焦 + 换景别切）已**默认关闭**（`--material-post-camera-move` 才开），只保留速度坡道这一剪辑手法。

**范围**：产品所有者对滕王阁样片的三条点名（素材用途 / 字幕标点 / 默认封面）+ 一条现场补充
"中间几镜只有字幕、没有台词播报"。

**一句话结论**：四条都做成了**可机检的硬口径**——素材只作生成输入（G-MAT1，静态直出一票否决）、
每句台词都有人声（`voice` 阶段逐镜 ASR 核查，终审硬闸）、字幕不带标点（字幕工位入站口统一去标点）、
封面由封面设计师出设计稿再合成再机检（"只有标题"的封面会被拦下）。

## 一、素材用途：只作生成输入，严禁静态直出

产品所有者原话（2026-09-25）：**"严禁在视频中直接静态展示图片，图片是用来做渲染的真实素材。"**

| 层 | 落点 | 内容 |
|---|---|---|
| 模块 | `packages/video-studio/src/material-policy.ts` | 用途枚举（只允许 `generation-reference`）、镜头卡校验（**旧卡只写 `photo` 直接抛错**，不静默兼容）、生成提示词组装（保真/真运动/禁止静态直出三段硬约束）、静态复用度判定（后段 ≥40% 采样里 ≥2 帧最佳匹配 PSNR ≥45dB 即判直出）、生成溯源判据（任务号+模型+素材与产物指纹） |
| 管线 | `scripts/tools/full-chain-film.mts` 的 `material-gen` 阶段 | ① 素材按画幅准备（**只作生成首帧**）→ ② 组装动效提示词 → ③ G-MAT1 提交门（7 条硬判据）→ ④ 图生视频 → ⑤ 静态复用度实测（15 个候选窗口 × 3 帧）→ ⑥ 监制保真评审 → ⑦ G-MAT1 验证门 |
| 管线 | `photo-motion` 模块与阶段 | **已删除**（旧的"真实照片 → ffmpeg 推拉摇移当镜头"正是被禁止的直出路径；`photo-motion.test.ts` 一并移除） |
| 围栏 | `bundles/ai-video/fences/ai-video-material.yml` | G-MAT0 直通 / **G-MAT1 静态直出一票否决（block，审批也放不过）** / G-MAT2 生成溯源必填 / G-MAT3 地标保真复核 |
| 流程 | `bundles/ai-video/pipelines/narrative-film.yml` | 新增 `material-generate` 步（owner=render-operator，gate=G-MAT1） |
| 门账本 | `packages/video-studio/src/gate-ledger.ts` | `PIPELINE_GATE_STEP_KEYS` 增加 `material-generate`，门编号 `G-MAT1`；平台侧（`apps/server/src/video/gate-ledger-bridge.ts`）**如实登记为未映射**（平台暂无对应 vendor 门，不猜） |

**真机实测（SC-02 白天全景，2026-09-25）**：渲染任务 `cgt-20260925092334-lqr28`
（`doubao-seedance-2-5-260628`）→ 素材指纹 `b7a12d76…` ≠ 产物指纹 `7975efee…`；
静态复用度 12.5 / 12.4 / 13.9 dB（阈值 45dB，越低越说明画面是生成出来的）；监制 86 分放行，
评语点名"地标形制、匾额文字、江面与天际线关系保真，运动以整体推近为主、视差偏弱"。

## 二、每句台词都要有人声（`voice` 阶段）

事故：中间四镜（真实素材段）**只有字幕、没有旁白**——画面在动、字在跳，却没有人声。

`voice` 阶段（step_key `voice`，`scripts/tools/full-chain-film.mts`）：

| 步骤 | 做法 | 判据 |
|---|---|---|
| 逐镜人声核查 | `voice-cli verify`（本地 Whisper ASR + 语音频段活动度） | **双条件**：`active_ratio ≥ 0.25`（真有人声）且 `match_ratio ≥ 0.6`（说的就是这句台词） |
| 缺人声补旁白 | `voice-cli dub`（时窗对齐 + 原声让位 + 视频轨 copy，音色 `zh-xiaozhi`） | 原片只读：产出 `<shot>.voiced.mp4`，合成时优先取配音版 |
| 补完复核 | 再跑一次核查 | 仍不通过 → 该镜标 `degraded`，终审 `narration-coverage` 硬闸拦下 |

为什么必须有"语音频段活动度"这一条：真机实测 Whisper 对**纯环境音**会"编"出一句套话
（SC-02/04/05 转写成"请不吝点赞 订阅 转发 打赏支持明镜与点点栏目"）——只看 ASR 文本会误判"有人声"。
实测数值：有人声的 SC-01 `active=0.538 / match=1.0`、SC-06 `active=0.421 / match=0.889`；
无旁白的素材镜 `active=0.000 / match≈0`。

附带修掉一个基础设施缺陷：ASR 对 mp4 直传会 **HTTP 500**（引擎侧 launchd 进程没有 ffmpeg PATH，
且桥把 mp4 字节标成 `audio/wav`）→ 现在桥先用工位自己的 ffmpeg 转 16kHz 单声道 WAV 再上传。

## 三、字幕不带标点

口径：**正规字幕不打标点**（标点是朗读停顿记号，落在屏上是阅读噪声）。

实现放在**入站口**（`bundles/ai-video/connectors/subtitle-bridge/core.mjs#parseSrt`），
因此旁挂 srt/ass/vtt、烧录、软字幕轨四条出口自动一致；`cuesToSrt` / `cuesToVtt` / ASS 事件生成处再兜一层
（防止"程序化直接传 cues"绕过）。三条不许误伤的细则（均有单测）：

1. **数字里的分隔符保留**：`3.5 字/秒`、`9:16`、`2026-09-25`、`50-80 元` 原样；
2. **纯西文字幕不强制**（英文句读是阅读标准）；
3. **整行只剩标点时退回原文**，绝不产出空字幕。

体检落在**落盘文件**上：旁挂清单新增 `no_punctuation`（残留标点计数 + 样例），
串口打印 `标点体检 ok/fail`，终审 `subtitle-punctuation` 硬闸读清单判定。

## 四、封面设计师真正参与（设计稿 → 合成 → 机检 → 监制）

事故：默认封面 = "抽一帧 + 烧一行标题"，产品所有者点名**封面设计师没有发挥作用**。

| 段 | 落点 | 内容 |
|---|---|---|
| 设计稿 | `packages/video-studio/src/cover-design.ts` + 岗位 `presets/cover-designer.yml` + 套件 `skills/cover-design/SKILL.md` | 设计师（LLM）出结构化设计稿：主标题/副标题/角标、主视觉取哪一镜哪一秒、人物带高度、字级配色、版式；越界/超长/缺字库即判非法（**自修复一轮**，仍不合法才退兜底稿）；定妆照路径由管线注入，不让模型编造 |
| 合成 | 管线 `cover` 阶段（ffmpeg，确定性） | 干净母版取帧 → 调色/暗角/标题带压暗 → **人物带**（片子自己的镜头帧，顶部柔化过渡）→ 大字排版 + 强调色装饰条 + 副标题 + 角标 |
| 机检 | `coverDeterministicChecks` | `cover-produced`（1080×1920，>120KB）/ `title-rendered`（标题带与无字版 PSNR < 45dB）/ `person-layer`（人物框与无人物版 PSNR < 45dB）/ `clean-source`（底图取自未烧字母版）/ `safe-area`（标题带 6%–42%、底部 12% 遮挡区墨迹 ≤2%） |
| 监制 | `COVER_REVIEW_RUBRIC` | 一眼看懂地点与内容、主角人物与片中造型一致、主标题完整可读、无 UI 残留/字幕条/水印、调性一致 |

机检的**关键作用**：把"只有标题"这件事变成红灯——上一版封面在 `person-layer` 一项必挂。
