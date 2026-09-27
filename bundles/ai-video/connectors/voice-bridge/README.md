# 成片配音 / 本地声音克隆 bridge 连接器（ai-video）

把 `voiceread.* / voicewrite.*` 工具接到**本机配音工位**（本机 TTS/ASR 引擎 + ffmpeg 内核），
供「配音师」数字员工完成 **采参考音 → 建音色档案 → 播报/视频配音 → 复检出证** 全链路。

## 部署形态

```
WorkLoom（大脑：岗位/技能/围栏/事件账本）        Mac 配音工位（手，声纹不出本机）
  runtime ToolExecutor ──HTTP/Bearer──▶  voice-bridge (127.0.0.1:9776)
                                            ├─ 本机引擎 sidecar（launchd 托管，127.0.0.1:8099）
                                            │    mlx-audio（MIT）：/v1/audio/speech + /v1/audio/transcriptions
                                            ├─ ffmpeg / ffprobe（录音 / 裁剪 / 拼接 / 混音 / 核验）
                                            ├─ 音色档案区  profiles/<id>/{reference.wav,profile.json,consent.json}
                                            ├─ 产物区      deliveries/（新文件 + sha256 回执）
                                            └─ 任务台账    jobs/YYYY-MM-DD.jsonl
```

**声纹不出工位**：服务器只传路径与参数，工位本地读写素材；参考音频、音色档案与授权回执只落本机，
只回元数据与哈希。围栏 G-VOICE5 对任何"上传声纹 / 导出档案 / 非本机引擎"的调用一票否决。

## 安装与自检（工位一次性）

```bash
# 1) 安装引擎与模型（macOS Apple Silicon；建 venv + 装 mlx-audio[server] + 下模型 + 补 ASR 处理器）
bash kit/install.sh                 # 首次约 3.3GB 下载；可用 HTTPS_PROXY 走本机代理

# 2) 起常驻引擎（launchd 托管，关终端也不掉）
bash kit/station.sh start           # stop | status | logs | fg

# 3) 真机自检（健康 → 麦克风 → 录音 → 建档 → 播报 → 核验）
bash kit/selftest.sh                # 已有参考音频可加 --ref/--ref-text 跳过录音
```

### 图形界面：双击即用（不需要打命令）

给不习惯命令行的人准备了一个 macOS 应用：**「小织声音工坊」**，三个动作全是对话框。

```bash
bash kit/install-apps.sh            # 装到 ~/Applications，并在桌面放一个快捷方式
```

| 动作 | 用户看到什么 | 背后做什么 |
|---|---|---|
| ① 克隆我的声音（录 12 秒） | 弹窗给出朗读稿 → 「开始录音」→ 进度窗 → 结果窗并**自动播放**克隆试听 | `record`（裁剪/归一/质量门）→ `consent`（本人、内部用途）→ `register`（自动转写逐字稿）→ `speak` |
| ② 文字转语音（播报试听） | 输入文字 → 「生成并试听」 | `speak`（分句合成 + 响度归一 + 复检）→ 自动播放 |
| ③ 给视频配音 | 选视频 → 输入文案 → 「开始配音」 | `dub`（时窗对齐 + 原声让位 + 视频轨 copy）→ 在访达里选中成片 |
| ④ 打开声音文件夹 | 打开 `~/.workloom/voice-station` | — |

细节与口径：

- 首次录音时 macOS 会询问麦克风权限（应用已声明用途说明），点「允许」即可；
- **提词器常驻**：点「开始录音」后，朗读稿会**留在屏幕正中的独立窗口**里直到录完
  （早期版本把提词稿放在确认框里，用户一点按钮文字就消失、"不知道该念什么"——现已改为独立的
  `teleprompter.applescript`，先起录再弹窗，念完自动关闭；多录的空白由裁剪步骤去掉）；
- 没检测到人声时**如实报**「没通过质量检查（没有检测到说话声）」，不会假装成功，可直接重试；
- 引擎没起会自动拉起（launchd 常驻）；整套只有对话框，不需要用户知道服务、端口、路径；
- 卸载：删掉 `~/Applications/小织声音工坊.app`（声音档案仍在 `~/.workloom/voice-station`，需要一并删除时手动删该目录）；
- 命令行等价物：`bash kit/gui-voice.sh doctor|record|speak|dub`（应用只是它的壳）。

引擎口径固定在 `kit/engine-pin.json`（引擎与模型、许可、为什么选它；Fish Speech 仅登记事实、不提供安装路径）。
切到别的后端不必改代码，只改环境变量：

```bash
# 默认：Apple 原生 MLX（MIT）
export WORKLOOM_VOICE_ENGINE=mlx WORKLOOM_VOICE_ENGINE_URL=http://127.0.0.1:8099
# 可选：VoiceStudio 桌面工位（AGPL-3.0，OpenAI 兼容 :3900，带 GUI/配音工作区/听写）
export WORKLOOM_VOICE_ENGINE=openai WORKLOOM_VOICE_ENGINE_URL=http://127.0.0.1:3900
# 可选：GPT-SoVITS api_v2（MIT，中文/粤语/日韩克隆第一梯队）
export WORKLOOM_VOICE_ENGINE=openai WORKLOOM_VOICE_ENGINE_URL=http://127.0.0.1:9880
```

## 接线

```ts
import { createVoiceBridgeExecutor } from "./bundles/ai-video/connectors/voice-bridge/executor.ts";

const toolExecutor = createVoiceBridgeExecutor({
  baseUrl: process.env.WORKLOOM_VOICE_BRIDGE_URL!,      // 支持逗号分隔多端点
  token: process.env.WORKLOOM_VOICE_BRIDGE_TOKEN!,
  tenantId: "ws-video",
  timeoutMs: 1_800_000,                                 // 克隆+配音含模型推理与多遍 ffmpeg
});
```

与调色/配乐工位同款：基座 seam 提案仍处「暂缓」，当前生产入口是**行业侧脚本注入**，不改任何基座文件。

## 工具面（10 个）

| 工具 | 类型 | 用途 |
|---|---|---|
| `voiceread.health` | 读 | 工位与引擎健康（引擎可达性/模型、ffmpeg、麦克风、音色档案数、许可口径） |
| `voiceread.devices` | 读 | 本机音频输入设备清单与默认麦克风（macOS AVFoundation） |
| `voiceread.voices` | 读 | 已登记音色档案（含授权状态与到期日） |
| `voiceread.probe` | 读 | 音/视频规格探测（时长/声道/采样率/编码/有无音轨） |
| `voicewrite.consent` | 写 | **声音授权声明**落盘（克隆的前置条件，围栏 G-VOICE1 的判据） |
| `voicewrite.record` | 写 | **本机麦克风录音** → 静音裁剪 + 参考电平归一 + 质量门（时长/活动占比/真峰值） |
| `voicewrite.register` | 写 | 建/更新音色档案（参考音频入库 + 逐字转写（可自动 ASR）+ 质量与授权校验） |
| `voicewrite.speak` | 写 | 播报：长文本分句 → 逐句合成 → 拼接（段间气口）→ 响度归一 → 复检回执 |
| `voicewrite.dub` | 写 | 视频配音：逐段合成 → 时窗适配（atempo ≤1.25×）→ 按策略混音 → 视频轨 copy 出片 |
| `voicewrite.verify` | 写 | 产物核验：响度/真峰值/时长/活动占比 + 台词顺序回读；缺测为未核实，明确无台词才不适用 |

### 台词核验合同

有台词时传 `expect_text`，工具必须取得有效 ASR 转写才判定文本是否匹配。匹配值为标准化 Unicode 码点序列的
最长公共子序列长度除以较长文本长度（NFKC、忽略大小写、空白、标点与格式控制符），保留词序与重复次数；
默认门槛 `min_match_ratio=0.6`。错序、漏句或多念均会降低匹配值。非相同长文本最多计算 1600 万个 DP 单元，
越界显式拒绝并要求按段核验，不退回忽略词序的算法。

- `result.status` 为 `passed` / `failed` / `unverified`；只有 `passed` 才有 `result.ok=true`、`receipt.synced=true`。
- `checked.text_match_status` 独立记录 `passed` / `failed` / `unverified` / `not_applicable`。声音削波可能使总状态
  `failed`，同时文本仍为 `passed`；调用方不得把整体失败一律解释成“没有人声”并追加配音。
- 缺少有效原稿、ASR 未启用、`round_trip=false`、空转写、超时、断网或非有效 JSON 响应均不能通过；
  引擎异常在 `checked.asr_error={code,message,retryable}` 中保留，正常时该字段为 `null`。
- 只有明确传 `speech_expected=false`（CLI：`--no-speech-expected`）才把台词项记为 `not_applicable`。
  此声明与非空原稿冲突时拒绝；物理测量仍需有效且通过。
- 默认严格模式未通过就抛稳定错误。`strict=false`（CLI：`--no-strict`）只使测量报告可读取，
  不会把失败或缺测变成通过。CLI 的退出码 0 仅表示报告成功输出，放行须检查报告与回执。

ASR 临时 WAV 在成功、HTTP 错误、网络异常和超时路径均清理。仓内 `verify.test.ts` 使用真实 FFmpeg/FFprobe
测量与明确标识的替身 ASR；默认 `runtime-smoke.mts` 的 mock 引擎不具备 ASR，核验应为未核实。
这些测试不代表真实模型可懂度或声音质量验收。

`voicewrite.verify` 每次重新测量，不读写桥的幂等结果缓存，确保 ASR 恢复或同路径媒体返修后能得到当前证据。
合成、配音等产物动作继续使用原有幂等缓存。

## 四种原声策略（`voicewrite.dub`）

| policy | 声音床 | 适用 | 纪律 |
|---|---|---|---|
| `keep-dialogue`（默认） | 原声全保留，配音侧链让位 | 口播/访谈/带货加解说 | 让位 8–12dB；人声-配音余量 ≥6dB |
| `keep-all` | 原声全保留，让位更浅 | 纪录片/现场感 | 让位 3–6dB |
| `replace-bed` | 原声丢弃，只留配音 | 外语配音/原声脏 | 需声明；要保现场声先跑 `bgmwrite.separate` |
| `music-only` | 原声全丢 | 纯音乐卡点片 | 必须显式 `allow_discard_original=true`，否则工具与围栏都拒绝 |

## 交付口径

| 项 | 播报 | 成片配音 |
|---|---|---|
| 响度 | -16 LUFS（±1.0，闭环校正） | -14 LUFS（±1.5，超差自动重挂音轨） |
| 真峰值 | ≤ -1.5 dBTP | ≤ -1.0 dBTP |
| 视频轨 | — | **copy**（不重编码画面） |
| 回执 | sha256 + 时长 + LUFS + dBTP + RTF + 分段数 | 另附逐段时窗表、总时长漂移、让位深度 |

## 真机实测（MacBook Air M3 / 8GB / macOS 15.7.3，2026-09-23）

| 项 | 实测 |
|---|---|
| 麦克风 | 「MacBook Air麦克风」可采；12s 底噪 mean -44.9 dB（先给运行本工位的程序授权麦克风） |
| 参考音频质量门 | 10.9s / 活动占比 0.954 / 真峰值 -8.15 dBTP → `gate.ok=true` |
| ASR 转写 | whisper-large-v3-turbo：10.9s → 23s；中文可读，逐字稿仍建议人工确认 |
| 中文合成 | 空载 19s 音频 23.3s 渲染（RTF 1.24，16 步）；克隆 6.4s 音频 18.6s（RTF 2.92） |
| 播报成品 | 9.92s，LUFS -14.49 → 闭环后达标，真峰值 -2.09 dBTP，sha256 回执 |
| 视频配音 | 12s 成片 2 段配音，时长漂移 **0.000s**，真峰值 -3.12 dBTP，视频轨 copy |
| 8GB 注意 | ASR 用完即卸载（默认 ≤16GB 机器 `auto`）；多段合成期间别并行跑别的重负载 |

## 安全

- token 只从受控秘密存储或工位本机文件读取，不进仓库、不进日志；
- bridge 默认只监听 `127.0.0.1`，跨机置于内网反代 + mTLS 之后；
- **路径监狱**：`WORKLOOM_VOICE_ALLOWED_ROOTS`（冒号分隔）之外一律拒绝，软链逃逸同样拦；
- **原片与参考音频只读**：输出路径等于输入路径直接拒绝（`overwrite_source_forbidden`），并由 G-VOICE2 一票否决；
- **声纹不出域**：G-VOICE5 对上传/导出/共享/非本机引擎一票否决；
- 无回执 = 未核实：executor 不会为缺失的 receipt 伪造 `synced`。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `WORKLOOM_VOICE_STATION_DIR` | `~/.workloom/voice-station` | 工位根目录（档案/产物/台账/日志） |
| `WORKLOOM_VOICE_ENGINE` | `mlx` | `mlx` / `openai` / `mock` |
| `WORKLOOM_VOICE_ENGINE_URL` | `http://127.0.0.1:8099`（mlx）/ `:3900`（openai） | 引擎地址（仅本机或可信内网） |
| `WORKLOOM_VOICE_TTS_MODEL` | `mlx-community/OmniVoice-bf16` | TTS/克隆模型 |
| `WORKLOOM_VOICE_ASR_MODEL` | `mlx-community/whisper-large-v3-turbo` | 转写模型（参考稿 + 可懂度回读） |
| `WORKLOOM_VOICE_UNLOAD_ASR` | `auto` | `auto`（≤16GB 卸载）/ `always` / `never` |
| `WORKLOOM_VOICE_ALLOWED_ROOTS` | 工位目录 + Movies + Desktop | 额外素材白名单（冒号分隔） |
| `WORKLOOM_VOICE_MIC_DEVICE` | 系统默认输入 | 指定麦克风名或索引 |
| `WORKLOOM_VOICE_BRIDGE_TOKEN` | 无（未设则拒绝一切调用） | 工位 token |
| `WORKLOOM_VOICE_BRIDGE_TENANT` | 无 | 绑定租户后校验 `params.tenant_id` |
| `WORKLOOM_VOICE_IDEMPOTENCY_TTL_MS` | 600000 | 幂等缓存 TTL |

## 错误码

可重试：`network_error` / `timeout` / `ffmpeg_failed` / `decode_failed` / `engine_failed` / `bad_response` / `engine_busy`

不可重试：`bad_request` / `bad_media` / `bad_reference` / `ref_text_required` / `mic_not_found` /
`mic_permission_denied` / `platform_unsupported` / `consent_required` / `voiceprint_export_forbidden` /
`overwrite_source_forbidden` / `verify_failed` / `segment_overflow` / `no_speech` / `path_not_allowed` /
`tenant_mismatch` / `quota_exceeded` / `not_configured` / `license_blocked`

## 常见问题

| 现象 | 原因 | 处置 |
|---|---|---|
| `mic_permission_denied` | 没给麦克风权限 | 系统设置 → 隐私与安全性 → 麦克风，授权运行工位的程序（终端/Codex/宿主） |
| `ref_text_required` | 引擎不支持 ASR 且没给逐字稿 | 显式传 `ref_text`（或用 `WORKLOOM_VOICE_ENGINE=mlx` 让工位自动转写） |
| `bad_reference` | 参考音频太短/太长/几乎没人声/削波 | 看回执里的 `gate.reasons`，按 `voice-reference-craft` 重录 |
| `segment_overflow` | 该段文案放不进时窗（>1.25×） | 改文案或允许溢出，别硬拉语速 |
| 引擎可达但转写 500（`Processor not found`） | mlx-community 的 Whisper 权重仓缺 processor | 重跑 `kit/install.sh`（会自动补齐 8 个处理器文件），或手动补 `openai/whisper-large-v3-turbo` 的 tokenizer/preprocessor |
| 多段合成第 2 段起失败（旧版报 `terminated`） | Node 全局 fetch 的 300s bodyTimeout | 已修：引擎调用走 node 内置 http（绝对超时 + 独立连接 + 连接层重试） |

## 许可

工位默认引擎 `mlx-audio`（MIT）与 Whisper（MIT）；
可选后端 VoiceStudio（AGPL-3.0）、GPT-SoVITS（MIT）；
Fish Speech 为 Fish Audio Research License，仅登记不纳入。选型依据与实测见 `docs/voice-clone-engine-decision.md`。
