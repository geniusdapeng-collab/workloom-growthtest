# 已有素材的本地剪辑交付

入口为 `scripts/tools/full-chain-film.mts --existing-render-edit <plan.json>`。它适用于已下载的视频、既有画外音和本地音乐，需要重剪并下载成片的任务。它在工位 IPC、镜头清单、密钥和生成初始化之前进入，不调用供应商、视觉评审、TTS 或 ASR。

此入口交付本地派生剪辑。供应商原始请求、真人身份及服饰认证仍属于正常生成流程；文件哈希、音频相关性和本地剪辑回执不会被升级为这些认证。

## 场景与选择

1. 已经付费生成了六个镜头，原生出镜对白却被后配覆盖。编辑计划选回原片的同一画面、同一原音轨与同一起点；不选择配音副本，就不会再把后配当作原声。
2. 某人物镜头服饰错误，用户要求使用现有材料完成交付。计划明确禁止该源的所有画面，保留其已存在的对白作为商品镜头画外音，并记录这次呈现方式变化。
3. 同一条片要有主片、可关闭字幕版与三种后期风格。它们共用被冻结的七段时间轴，每个风格版实际调色、选取已有音乐、绘制自己的封面，再核验时长、帧数和当前来源。

两个候选方案：仅用独立 FFmpeg 命令快速拼片，或增加显式本地入口并复用正式后期工位。前者代码少，但会复制合成、字幕、混音与封面验收逻辑，无法继承真实音画与版式复检。选后者：取段适配器只负责源文件与独立图声映射，后续直接调用现有 compose、color、subtitle、bgm 和封面装配组件。它不增加服务、数据库表或依赖。

## 完整输入契约

JSON 的 `schemaVersion` 必须为 `workloom.existing-render-edit/v1`。不认识的字段拒绝，不能在本地模式中夹带 `speed`、生成选项或评审关闭开关。

| 字段 | 要求 | 缺失或违反的结果 |
|---|---|---|
| `projectId` | 1–128 个字母、数字、点、下划线或短横线，不含 `..` | 拒绝目录穿越与产物名冲突 |
| `allowedRoots` | 1–16 个绝对本地目录，实际解析 realpath | 根目录缺失、源软链越界时拒绝 |
| `outputDir` | 新的绝对目录；不可包含逗号，不覆盖已存在目录 | 并发锁或已存在输出时拒绝 |
| `width / height` | 160–4096 的偶数整数 | 不接受不可编码画幅 |
| `fps` | 1–60 的整数；所有源画面须具有同一帧率 | 不隐式改速或合成帧 |
| `durationSec` | 0.25–600 秒，按帧对齐，等于所有段之和 | 时间轴不相等时拒绝 |
| `sources` | 1–100 个来源文件，每个有唯一 `id`、绝对 `path`、完整 `sha256`、正整数 `bytes`、`role`、`origin` | 当前字节、文件大小或媒体探测不符时拒绝 |
| `role` | `original-render / existing-voice / existing-music` | 音乐不可冒充对白，配音副本不可作原始画面 |
| `forbiddenVideoSourceIds` | 明确禁止入画的源 ID 列表 | 按源 SHA 同时禁止其他别名及封面引用 |
| `segments` | 1–100 段，完整图声范围和呈现模式 | 重复 ID、越界、空段、隐藏速度选项拒绝 |
| `subtitles` | 1–1000 句，含 `startSec / endSec / text` | 空白、重叠、越界或 ASS 控制文本拒绝 |
| `subtitleFontsRoot` | 当前完整字体库的绝对目录 | 所有登记字体须通过实际摘要核验 |
| `cover` | 已许可源 `sourceId / atSec`、明确 `title / subtitle?`、`platform`、固定 `fontFile / fontSha256 / fontId?` | 字体漂移、缺字、越界或不可见文字拒绝 |
| `versions` | 主版 `master`，可加 `warm-film / cool-tech / punchy-social` | 重复版本或缺主版拒绝 |

每段字段为 `id / videoSourceId / audioSourceId / videoInSec / audioInSec / durationSec / speechMode / pictureUse / presentationChange?`。画面起点按帧对齐，音频起点按 48kHz 样点对齐，均以 1 倍速度取段。

`on-camera-native` 要求画面与声音来自同一原片、同一字节和同一起点，且 `pictureUse=person`。`voice-over-existing` 可使用其他已存在声音。原生对白搬到不同画面时，必须有 `presentationChange`，不能把新的画外音关系伪装成原来的出镜口播。

版本字段为 `id / profile / intensity / musicSourceId? / musicLevelDb? / duckingDb? / musicBpm?`。调色 profile 只接受 `natural / warm-film / cool-technical / high-contrast-social`，强度 0.1–1。主版可明确采用 `profile=none, intensity=0` 保留源画面，其回执写 `graded=false`；风格变体不可用此通路冒充调色。

音乐只取冻结的 `existing-music` 来源。电平 −40 至 −12dB，ducking 4–40dB，BPM 20–300；这些是本仓接口范围，实际混音仍必须通过既有响度、峰值、让位和可闻度验收。

## 处理和失败路径

1. 校验 JSON、当前源字节、媒体轨道和所有取段范围。源探测和取段输入显式限制本地 `file,pipe` 协议，以及直接容器 `mov,matroska,avi,mpegts,wav,mp3,aac,flac,ogg,aiff`；HLS、concat 及播放列表不能通过冻结一个文本文件引用未冻结的另一份媒体。解析本地 FFmpeg/FFprobe 的真实绝对可执行路径，记录实际摘要；CLI 的默认 macOS 工位路径继续使用现有 pin 校验。
2. 独占新输出目录的锁，在同卷唯一暂存目录复制被消费的当前源文件。复制摘要必须等于计划；整个流程不覆盖输入及历史成片。
3. 分别按视频帧和音频样点裁切，输出带 PCM 音轨的 MOV。准备段与原始取段的 48kHz/16bit/双声道 PCM 必须逐字节相等。
4. 调用正式 `compose-film.mts`，明确 `fps`、`fade=0`、`color=none`，不传 retime 或漂移豁免。继承其 AV-sync 报告，并另测被冻结的准备段与拼接音轨：每段相关性 ≥0.98，偏移 ≤10ms。
5. 调用字幕工位的同一选型、版式与 ASS 生成器，导出 SRT/ASS/VTT。原作者台词与句级时间保留在输入计划；正式字幕按现有工位去标点，不加入从片名推断的标题。
6. 调色使用正式 `grade`，变化不足、色彩元数据或工位复检失败时拒绝。调色后重新接回拼接版的原音轨，避免调色阶段多一次无必要音频压缩。
7. 需要音乐时调用正式 `bgm.mix`，显式 `declaredProgramMix=true`。源节目混音可能按现有工位进行动态响度处理，回执如实保留 `sourcePreparation`；`sourceAuthority=declared-unverified / stemsVerified=false`，不能称为干净签章分轨。此入口用于私人本地派生交付，混音回执及总清单写 `licenseReviewed=false / commercialUse=false`；既有曲库的可商用声明不升级为逐首上游许可核验。
8. 字幕烧录、确定性本地封面和正式首帧装配依次完成。封面只替换首帧，装配核对帧数、时间戳、时长、音频包和解码 PCM。软字幕从干净带封面视频派生，图声 copy，用户可关闭字幕轨。
9. 全解码实际文件，核对帧数、画幅、帧率和时长。结束时重新核对全部原文件、计划、字体、二进制，以及开始时观察到的源码提交、工作树与消费代码摘要；漂移即失败。工位 JSON 中的暂存路径迁移到最终目录。
10. 所有复检通过才把暂存目录原子移动为新交付目录。失败保留暂存目录与 `failed.json`，释放自己的锁，不把部分文件标为正式交付。

错误码包括 `EXISTING_EDIT_PLAN_INVALID`、`EXISTING_EDIT_WORKER_FORBIDDEN`、`EXISTING_EDIT_BINARY_INVALID`、`EXISTING_EDIT_SOURCE_CHANGED`、`EXISTING_EDIT_SOURCE_OUTSIDE_ROOTS`、`EXISTING_EDIT_VIDEO_RANGE_INVALID`、`EXISTING_EDIT_AUDIO_RANGE_INVALID`、`EXISTING_EDIT_NATIVE_AUDIO_CHANGED`、`EXISTING_EDIT_SOURCE_SPEECH_UNVERIFIED`、`EXISTING_EDIT_FONT_CHANGED`、`EXISTING_EDIT_CODE_CHANGED`、`EXISTING_EDIT_OUTPUT_EXISTS`、`EXISTING_EDIT_BUSY` 与具体后期工位错误。没有忽略这些错误的开关。

## 功能级别与边界

| 优先级 | 可验证行为 | 用户不用它会怎样 |
|---|---|---|
| P0 | 冻结源字节、范围、原画原声配对和禁用画面 | 后配或错误人物画面可重新混入交付 |
| P0 | 正式合成、源音轨实测、字幕、封面首帧与全解码 | 文件存在但画音、字和时长仍可能不合格 |
| P0 | 新目录、独占锁、失败留痕和末尾源码/源字节回查 | 并发或中途改源会覆盖历史、产生陈旧“成功” |
| P1 | 可关闭字幕版、已有音乐和三个实际风格变体 | 用户只能使用同一画面、同一字幕与同一配乐版本 |
| P1 | 完整 JSON 证据、当前源与后期处理披露 | 用户不能复核声音从哪来、原生对白如何搬到商品画面 |
| P2 | 自动打包、多项目队列、GUI 选择既有源 | 当前使用显式 CLI 和外部交付包流程；此批不实现新界面 |

不做新图片、视频、配音、音乐或模型生成，不联网获取素材，不调用新 ASR，不自动发布视频到社交账号，不猜测原供应商请求，不把已生成的人脸当身份基准。声音来源及时间测量不是台词文字、音素口型或人物身份认证。已存在音乐来源及许可声明继续保留为原记录，来源目录名字不能证明许可。

## 验证口径

`scripts/tools/film-existing-render-edit.test.ts` 包含入口前置、完整计划拒绝矩阵、真实本地视频探测、篡改和越界、特殊文件名、源 PCM 与准备段守恒测试。独立验收另执行真实本地后期全链、全帧与完整音轨验证。自合成测试视频明确为夹具，不算用户付费生成，也不认证真实人物。

FFmpeg 的本地 trim、时间轴和 overlay 语义参考[官方过滤器文档 n6.0](https://raw.githubusercontent.com/FFmpeg/FFmpeg/n6.0/doc/filters.texi)，输入限制参考[官方 format_whitelist 文档](https://raw.githubusercontent.com/FFmpeg/FFmpeg/n6.0/doc/formats.texi)与[官方 protocol_whitelist 文档](https://raw.githubusercontent.com/FFmpeg/FFmpeg/n6.0/doc/protocols.texi)。具体参数和阈值以当前源代码与实际工位报告为准。
