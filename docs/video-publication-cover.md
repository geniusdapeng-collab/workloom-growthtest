# 正式发布片的封面装配

创作封面必须进入正式发布片的第一帧。制作母版继续用于后期派生，发布片绑定经过验收的封面与装配回执。主标题、副标题和角标承载观众需要的内容；生成来源、风格名称和发布披露要求写入交付元数据。

## 需求与选择

本次约束是 30 秒广告片、24fps、既有字幕时间轴与既有音轨。用户选择主片或三个后期风格版本时，必须得到对应封面已经装配好的正式视频；发布方可通过 SHA256 核对封面、输入片和输出片；中途失败必须保留上一版可用交付。

| 候选 | 行为 | 成本与风险 | 选择 |
|---|---|---|---|
| 前置一段封面视频再 concat | 增加可见片头 | 增加片长，需要重算字幕、镜头和音轨时间；不满足固定 30 秒 | 不采用 |
| 用封面替换第一帧 | 第一帧是封面，从第二帧继续原片 | 视频需要重新编码；音频和软字幕可以复制，随后逐项验证 | 采用 |

选择第二项。24fps 下封面占既有的约 41.67ms，不增加帧、不延长片长，不把长片头冒充固定 30 秒成片。此机制保证文件首帧；外部平台是否选择该帧作为展示封面，需要发布适配器另行验证。

## 组件接口

`packages/video-studio/src/cover-assembly.ts` 提供两个接口，通过视频工作室包导出。

```ts
const style = buildVariantCoverFilters({
  variantId: "warm-film", accent: "#E8B44A", platform: "wechat-channels",
  width: 1080, height: 1920,
});
// style.filters / style.filter 为 ffmpeg 滤镜；不接受展示标签参数。

const receipt = await embedCoverFirstFrame({
  input: cleanStyleFilm, cover: cleanStyleCover, output: publicationFilm,
  ffmpeg: officialFfmpegPath, ffprobe: officialFfprobePath,
});
```

变体封面使用轻量调色和强调色条。色条的坐标从 `cover-platforms.ts` 读取顶部、底部和右侧安全区，整条必须在可用区内。接口拒绝未知风格、未知平台、非法尺寸和非 `#RRGGBB` 颜色，禁止把颜色参数作为滤镜注入通道。风格 ID、名称和配色继续留在回执/清单。

首帧接口仅接受一个至少两帧的视频流和一个与视频同尺寸的单帧封面。输出为独立 MP4，不能与输入/封面同路径、硬链接或符号链接。组件不自动改变封面尺寸、帧率或旋转方向，输入不合格时由正式封面阶段修复，避免装配时悄悄改变设计。

## 流程和失败路径

1. 对输入、封面和输出执行路径/文件/别名检查；为目标取得排他锁。
2. 读取输入与封面的完整 SHA256；提取帧数、时长、视频 PTS 时间线、音频包与字幕包指纹。
3. 用 FFmpeg `overlay` 的时间线表达式 `enable='eq(n,0)'` 替换第一帧，帧率使用 `passthrough`，音频与软字幕使用 stream copy。
4. 输出到同目录的唯一 pending 文件。完整读取新媒体，比较分辨率、帧率、视频帧数、视频/容器时长、音轨/字幕结构、视频 PTS、音频/字幕包及时间戳；再比较所有音轨的解码 PCM 哈希。
5. 用 PSNR 比较输出第一帧与封面（平均值至少 32dB；完全一致记为无穷值，回执的 JSON 字段为 `null`），完整解码视频以排除编码损坏；再次核对输入和封面哈希。
6. 验证通过后原子 rename 发布。失败清理 pending 文件并释放本次锁；已有目标文件保持原样。锁已被其他写入者持有时立即失败，不能删除别人的锁；异常中断留下的锁需要显式清理后重试。

错误类 `CoverAssemblyError` 的代码区分参数问题 `cover_assembly_invalid`、子进程失败 `cover_assembly_process_failed`、守恒/内容校验失败 `cover_assembly_verify_failed`、写入占用 `cover_assembly_busy`。所有错误向调用方抛出，不返回伪成功回执。

回执包含输入、封面、输出三组路径与 SHA256，`mode=replace-first-frame`、`coverFrameCount=1`，视频时长/帧数/时间线指纹/首帧 PSNR、音轨包与 PCM 指纹以及字幕包指纹。交付清单应指向 receipt.output，而制作母版与输入引用独立保存。

## 创作文案与披露边界

`cover-design.ts` 的设计提示词不再建议“AI生成”角标。主标题、副标题、角标命中已知生成来源标签或后期风格标签时，校验失败；“AI班组住进酒店”之类内容文案仍可通过。既有生成素材冒称实拍的校验保留。

来源 `generated/live-action/mixed`、风格配方以及发布披露要求应进入交付元数据。此变更没有给 `publish-rpa` 添加平台 AIGC 声明字段，也没有执行外部发布；调用方不得据此宣称已经完成平台披露。

## 验证与边界

`cover-assembly.test.ts` 使用真实 FFmpeg 构造 30 秒/720 帧/24fps 视频、AAC 音轨和两段软字幕，检查首帧是蓝色封面、第二帧恢复红色正片、PCM 逐字节一致、字幕 SRT 完全一致。另测 30fps 静音片、缺失/损坏/尺寸错误封面、输入/封面路径别名、符号/硬链接、编码失败、成功但未插入封面的伪编码器、排他锁以及八个平台安全区和滤镜注入边界。

本组件不做模型生成、不补造身份或衣着验证、不宣称画面人物连续性已合格，不自动修字幕/音轨错位，也不替代镜头、配音、混音、调色或封面设计岗位。重新编码的视频像素可能与母版略有差别；时间和音频/字幕守恒由回执验证，创作品质仍由正式监制与发布前复核判定。

FFmpeg 官方依据：[Timeline editing](https://www.ffmpeg.org/ffmpeg-filters.html#Timeline-editing)、[framesync](https://www.ffmpeg.org/ffmpeg-filters.html#Options-for-filters-with-several-inputs-_0028framesync_0029)、[Streamcopy](https://www.ffmpeg.org/ffmpeg.html#Streamcopy)、[`fps_mode`](https://www.ffmpeg.org/ffmpeg.html#Advanced-options)。
