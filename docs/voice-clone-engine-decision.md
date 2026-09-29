# 本地声音克隆方案选型与落地决策（ai-video · 配音工位）

> 状态：已落地并真机验收（2026-09-23）｜适用仓：`WorkLoom-growthtest`（实验车道）及其隔离副本
> 关联任务卡：`T-2026-0923-0001`｜关联代码：`bundles/ai-video/connectors/voice-bridge/**`

## 0. 一句话结论

**方案 B（Fish Speech）直接出局**（仅 Linux/WSL2 + 研究许可 + 4B 参数，本机跑不了）；
**方案 A（VoiceStudio）与方案 C（GPT-SoVITS）都成立但都不该当"唯一答案"**——
在本机（MacBook Air M3 / 8GB / macOS 15.7.3）上，真正跑得动、授权干净、能落进 WorkLoom 治理链路的形态是：
**Apple 原生 MLX 本机引擎（`mlx-audio`，MIT）作为配音工位的默认后端 + OpenAI 兼容契约作为统一接口**，
VoiceStudio 与 GPT-SoVITS 作为可切换后端（同一套工具面，只改环境变量）。

## 1. 需求与约束（先摆事实，再谈选型）

| 维度 | 要求 | 来源 |
|---|---|---|
| 使用场景 ① | WorkLoom 数字员工（小织等）的 TTS 播报：中文、长文本、可重复、音色稳定 | 用户本次指令 |
| 使用场景 ② | 视频后期制作环节的配音：与成片时间轴对齐、混音让位、音画同步 | 用户本次指令 |
| 运行位置 | **必须在用户本机跑**（MacBook Air M3，8 核 / 8GB 统一内存 / macOS 15.7.3，实测磁盘可用 31–35GB） | 本机 `system_profiler` 实测 |
| 采集方式 | **必须调用本机麦克风录音**作为克隆参考 | 用户本次指令 |
| 数据边界 | 声纹与参考音频是生物特征数据，不出本机、不进仓库、不上行蜂群 | 产品不变量 6 + 用户本机约束 |
| 附加约束 | 结果要能被 WorkLoom 治理（围栏/人审/回执），不能是"一个跑得起来的脚本" | 开发协议 §1–§3 |

## 2. 三个候选方案的事实核实（附来源）

### 2.1 方案 A：VoiceStudio（`debpalash/VoiceStudio`）

| 项 | 核实结果 | 来源 |
|---|---|---|
| 真实性与热度 | 34,271 stars，活跃（最近推送 2026-09-22），非归档 | GitHub API `repos/debpalash/VoiceStudio` |
| 形态 | **Electron 桌面应用 + Python 后端**（Tauri 已归档，README 明确"Electron is the only maintained desktop app"） | README「Get started」/「Electron is the only maintained desktop app」 |
| 许可 | AGPL-3.0（模型各自许可另算） | 仓库 license 字段 + README「License & responsible use」 |
| macOS 支持 | Apple Silicon 支持（MPS 自动、MLX 引擎可用）；**Intel Mac 明确不支持本地推理** | `docs/install/macos.md` |
| 安装体积 | 官方 macOS 指南要求 ~10GB 可用磁盘（应用 + Python 环境 + 权重） | `docs/install/macos.md` |
| 能力面 | 克隆 / 配音工作区 / 听写（麦克风）/ 本地 OpenAI 兼容 API `:3900` / MCP / 模型目录 | `docs/speech-platform.md`、README |
| 显存/内存口径 | 默认引擎 OmniVoice 建议 6GB 级 VRAM；官方性能文档的实测基准机是 **16GB Apple Silicon M2**；MPS/CPU 只给 1 个并发 worker，并明确"不要在 ≤10GB 卡或 Apple Silicon 上调高并发" | `docs/engines/omnivoice.md`、`docs/performance.md` |
| 与另一方案的关系 | VoiceStudio 原生支持把 GPT-SoVITS 当外部引擎接（`OMNIVOICE_GPTSOVITS_URL`，api_v2 协议） | `docs/engines/gpt-sovits.md` |

**判断**：形态与场景最贴合（唯一同时覆盖"克隆 + 配音工作区 + 麦克风 + Agent 接口"的方案），
但两处要打折：① AGPL-3.0 与 10GB 体量；② 默认引擎在本机 8GB 上偏重（官方基准机是 16GB）。

### 2.2 方案 B：Fish Speech S2 Pro（`fishaudio/fish-speech`）

| 项 | 核实结果 | 来源 |
|---|---|---|
| 真实性与热度 | 32,779 stars，最近推送 2026-09-16；最新发布 `v2.0.0-beta`（2026-03-10，prerelease） | GitHub API / releases |
| 许可 | **FISH AUDIO RESEARCH LICENSE**（README 原文：代码与权重同此许可，"We will take action against any violation"），商用需向 Fish Audio 单独授权 | README「License Notice」 |
| 规模 | S2-Pro **4B 参数**，10M+ 小时训练数据，80+ 语言 | README「Fish Audio S2 Pro」 |
| 平台 | 官方安装指引面向 Linux / WSL2（Docker 与 SGLang/vLLM 部署为主线） | README「Quick Start」 |
| 生态事实 | VoiceStudio 的引擎清单里**没有** fish-speech 条目 | `docs/engines/README.md` |

**判断（本机与产品双重出局）**：
① 本机 macOS 原生跑不起来（无 CUDA、无官方 macOS 路径）；
② 4B 参数对 8GB 统一内存不现实；
③ 研究许可与"产品能力"定位冲突——附件里"质量优先选它"的结论只在"Linux + 24GB 显存 + 非商用"三个条件下成立。

### 2.3 方案 C：GPT-SoVITS（`RVC-Boss/GPT-SoVITS`）

| 项 | 核实结果 | 来源 |
|---|---|---|
| 真实性与热度 | 62,043 stars，许可 **MIT**，最近推送 2026-08-18 | GitHub API |
| macOS 支持 | 官方「Tested Environments」表内**明确列出 Apple Silicon**（Python 3.9 + PyTorch 2.5.1、Python 3.11 + PyTorch 2.7.0），安装脚本支持 `--device MPS|CPU` | README「Installation / Tested Environments / macOS」 |
| 速度 | 官方 RTF：4090 0.014、4060Ti 0.028、**M4 CPU 0.526**（即 M4 上约 2 倍实时） | README「RTF of GPT-SoVITS v2 ProPlus」 |
| 能力 | 5 秒零样本 / 1 分钟少样本微调；中英日韩粤；api_v2 服务（`/tts`，VoiceStudio 亦可直连） | README + VoiceStudio `docs/engines/gpt-sovits.md` |
| 本机可行性 | 需 conda/venv + PyTorch + 3–5GB 模型；本机未安装（本轮把磁盘/内存预算给了默认引擎） | 本机实测 |

**判断**：MIT + 中文克隆第一梯队 + 官方 Apple Silicon 支持，是最稳的"高质量中文备选"；
代价是一整套 Python 重依赖（conda/PyTorch/模型 3–5GB），对 8GB 机器是一次重投入。

### 2.4 本机现实解：Apple 原生 MLX 引擎（`Blaizzy/mlx-audio`，MIT）

| 项 | 核实结果 | 来源 |
|---|---|---|
| 许可与形态 | **MIT**；Apple MLX 原生；提供 OpenAI 兼容 REST API（`/v1/audio/speech`、`/v1/audio/transcriptions`、`/v1/models`） | GitHub API + README「Web Interface & API Server」 |
| 支持模型 | Kokoro / Qwen3-TTS / Chatterbox / CSM / OmniVoice / MeloTTS / Spark 等 20+ | README「Supported Models」 |
| 克隆能力 | 本项目选用 `mlx-community/OmniVoice-bf16`（零样本克隆，`ref_audio` + `ref_text`，646+ 语言，1.64GB） | README「OmniVoice」+ HF API |
| 与方案 A 的关系 | **VoiceStudio 的 MLX-Audio 引擎就是它**（`docs/engines/mlx-audio.md`）——所以选它并不与方案 A 冲突，日后可无缝切到 GUI 工位 | VoiceStudio `docs/engines/mlx-audio.md` |

## 3. 本机真机实测（2026-09-23，M3 / 8GB）

| 项 | 实测值 | 说明 |
|---|---|---|
| 麦克风可用性 | `ffmpeg -f avfoundation -i ":0"` 可采；设备「MacBook Air麦克风」；12s 环境底噪 mean −44.9 dB | 权限已通（系统设置 → 隐私与安全性 → 麦克风） |
| 声学回路录音 | 系统朗读 10.9s → 扬声器 → 麦克风录音，语音段 −24~−32 dB，活动占比 **0.954**，真峰值 −8.15 dBTP，质量门通过 | 代替"人对着麦念稿"完成链路验证；真人录音同一条路径 |
| 参考音频转写（ASR） | whisper-large-v3-turbo（1.61GB）10.9s 音频转写 **23s**，中文可读（个别同音字误识，如"小织→小枝"） | 参考稿仍以人工确认为准（见交付规范） |
| 中文合成（本机引擎冷启） | 19s 音频 / 23.3s 渲染（RTF **1.24**，含首启权重加载 38.3s） | 空载直调；`num_steps=16` |
| 零样本克隆 | 6.4s 音频 / 18.6s 渲染（RTF **2.92**，含参考音频编码） | 参考音频 10.9s |
| 播报成品（工位全链路） | 9.92s，LUFS **−14.49**（目标 −16 闭环后），真峰值 **−2.09 dBTP**，sha256 回执 | 含分句 → 合成 → 拼接 → 两遍法 loudnorm → 复检 |
| 视频配音（工位全链路） | 2 段时窗 4.0s / 6.0s；成片与原片时长漂移见回执；视频轨 `copy` | 见 §5 验收记录 |
| 8GB 内存的真实代价 | 另一 Codex 会话满载 + swap 11.7GB/13.3GB 时，单段合成可慢到 RTF 19–28；单请求超过 5 分钟会被 undici 的 300s 默认 bodyTimeout 掐断 | 前者是环境，后者是代码缺陷，**已修**（改用 node 内置 http 直连，见 §4.3） |

## 4. 落地架构（已在仓内实现）

### 4.1 分层

```
WorkLoom（大脑：岗位/技能/围栏/事件账本）
  runtime ToolExecutor ──HTTP/Bearer──▶  voice-bridge（127.0.0.1:9776）
                                            ├─ 本机引擎 sidecar（launchd 托管，127.0.0.1:8099）
                                            │    mlx-audio（MIT）：/v1/audio/speech + /v1/audio/transcriptions
                                            ├─ ffmpeg/ffprobe（录音/裁剪/拼接/混音/核验）
                                            ├─ 音色档案区（reference.wav + profile.json + consent.json）
                                            ├─ 产物区（新文件 + sha256 回执）
                                            └─ 任务台账（jobs/YYYY-MM-DD.jsonl）
```

### 4.2 工具面（10 个）与围栏（7 条）

- 读：`voiceread.health` / `devices` / `voices` / `probe`
- 写：`voicewrite.consent` / `record` / `register` / `speak` / `dub` / `verify`
- 围栏：`G-VOICE0` 常规直通、`G-VOICE1` 克隆授权必审、`G-VOICE2` 覆盖原片禁止、
  `G-VOICE3` 必须可核验、`G-VOICE4` 日配额、`G-VOICE5` 声纹不出域、`G-VOICE6` 对外发布必审

### 4.3 真机踩出来的四个坑（都已在代码里修掉并留注释）

1. **`nohup` 起的引擎会随会话退出被杀** → 改用 macOS **launchd（LaunchAgent）** 托管，`kit/station.sh stop|start|status` 管理；
2. **undici（Node 全局 fetch）默认 300s bodyTimeout**：多段合成第 2 段起必然 `terminated`，而服务端日志显示它其实返回 200 → 引擎调用改 **node 内置 http** 直连（绝对超时 + `connection: close` + 连接层错误重试一次）；
3. **mlx-community 的 Whisper 权重仓不含 processor**：`/v1/audio/transcriptions` 直接 500（`Processor not found`）→ 安装脚本从 `openai/whisper-large-v3-turbo` 补齐 8 个处理器文件（约 4MB）；
4. **ffmpeg 滤镜输出标签不能复用**：`[voice]` 同时给侧链与混音用会报 `Invalid stream specifier` → 先 `asplit=2`。

另有两条与机器相关的经验：8GB 机器上 **ASR 用完即卸载**（默认 `auto`：≤16GB 卸载），播报/配音前先清场 ASR 权重；
以及**响度必须闭环复检**（两遍法 loudnorm 后仍可能偏 1.5dB，需按实测差值再校正一次）。

## 5. 验收记录（真机）

| # | 验收项 | 结果 |
|---|---|---|
| 1 | 工位健康（引擎/ ffmpeg / 麦克风 / 档案） | ✅ `voiceread.health` 全绿（engine reachable=true，mic=MacBook Air麦克风） |
| 2 | 本机麦克风录音 + 质量门 | ✅ 10.9s，活动占比 0.954，真峰值 −8.15 dBTP，gate.ok=true |
| 3 | 参考音频自动转写（ASR） | ✅ 中文可读（人工复核逐字稿后入库） |
| 4 | 建音色档案（含授权回执） | ✅ `profiles/zh-xiaozhi/{reference.wav,profile.json,consent.json}`，reference sha256 入回执 |
| 5 | 中文播报（长文本分句 + 响度归一 + 复检） | ✅ 9.92s，LUFS −14.49，真峰值 −2.09 dBTP，sha256 回执 |
| 6 | 视频配音（时窗对齐 + 原声让位 + 视频轨 copy） | ✅ 2 段，成片可播放，时长漂移在容差内（见回执） |
| 7 | 断服务容错 | ✅ 引擎不可达时返回 `network_error` 软失败 + 复检指引，不伪造完成 |
| 8 | 围栏语义（授权/覆盖/关校验/配额/出域/发布） | ✅ 单测覆盖（`voice-capability.test.ts`） |

## 6. 选型结论与切换方式

| 场景 | 用哪个引擎 | 怎么切 |
|---|---|---|
| **默认（本机 8GB Mac，当前）** | `mlx` + `mlx-community/OmniVoice-bf16` | `WORKLOOM_VOICE_ENGINE=mlx` |
| 要 GUI / 配音工作区 / 听写 / 批量任务 | VoiceStudio（AGPL-3.0，~10GB） | `WORKLOOM_VOICE_ENGINE=openai WORKLOOM_VOICE_ENGINE_URL=http://127.0.0.1:3900`，音色用档案 `engine_voice_id` |
| 中文高保真 / 少样本微调（MIT） | GPT-SoVITS api_v2 | 同上，URL 指向 `http://127.0.0.1:9880` |
| 只求最轻（无克隆需求） | Kokoro-82M 等小模型 | 同 mlx 通道，换 `WORKLOOM_VOICE_TTS_MODEL` |

**不选 Fish Speech 的理由**（再说一遍，避免日后反复）：平台不匹配（Linux/WSL2）、参数规模不匹配（4B）、许可不匹配（研究用途）。

## 7. 边界：这套方案不解决什么

1. **不做实时流式克隆对话**（8GB 机器上 RTF > 1，播报是"预渲染后播放"，不是边说边译）；
2. **不做音色微调训练**（零样本克隆；需要 1 分钟数据微调的走 GPT-SoVITS）；
3. **不替使用者判断"像不像"**：客观指标（响度/真峰值/时长/可懂度回读）能自动核验，音色相似度最终要人听；
4. **不做音源分离**：要"保留现场声只换人声"的场景，先跑 `bgmwrite.separate`；
5. **不做跨机推理**：声纹不出域是硬红线（G-VOICE5），远程后端需显式人审与专线。

## 8. 许可与合规清单

| 组件 | 许可 | 用途边界 |
|---|---|---|
| `mlx-audio` | MIT | 可商用；本机引擎 |
| `mlx-community/OmniVoice-bf16` | 见模型卡（与 k2-fsa/OmniVoice 同源） | 内部播报/配音；商用前按模型卡复核 |
| `mlx-community/whisper-large-v3-turbo` + `openai/whisper-large-v3-turbo` processor | MIT（Whisper 权重） | 参考音频转写 + 可懂度回读 |
| VoiceStudio | AGPL-3.0 | 仅作为可选本机工位使用；不得据此闭源分发 |
| GPT-SoVITS | MIT | 可选后端 |
| Fish Speech S2 | FISH AUDIO RESEARCH LICENSE | **不纳入**（研究许可） |

## 9. 参考来源

- VoiceStudio：<https://github.com/debpalash/VoiceStudio>（README、`docs/install/macos.md`、`docs/engines/README.md`、`docs/engines/omnivoice.md`、`docs/engines/mlx-audio.md`、`docs/engines/gpt-sovits.md`、`docs/performance.md`、`docs/speech-platform.md`）
- Fish Speech：<https://github.com/fishaudio/fish-speech>（README 的 License Notice 与 S2 Pro 章节）
- GPT-SoVITS：<https://github.com/RVC-Boss/GPT-SoVITS>（README 的 Tested Environments / macOS / RTF）
- mlx-audio：<https://github.com/Blaizzy/mlx-audio>（README 的 Supported Models / API Server / 各模型示例）
- 仓内既有契约：`docs/voice-and-avatar-delivery-contract.md`（语音与数字员工交付契约）
