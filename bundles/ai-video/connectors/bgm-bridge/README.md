# 成片配乐 bridge 连接器（ai-video）

把 `bgmread.* / bgmwrite.*` 工具接到 Mac 配乐工位（ffmpeg 内核 + 仓内自算作曲内核），
供配乐岗位执行已声明的曲目/配方与单次本地混音。成功镜头默认直接后期，不用音质评分作二次否决。

## 部署形态

```
WorkLoom（大脑：岗位/技能/围栏/事件账本）          Mac 配乐工位（手，独立内网）
  runtime ToolExecutor ──HTTP/Bearer──▶  bgm-bridge (127.0.0.1:9775)
                                            ├─ ffmpeg / ffprobe（kit 受控安装）
                                            ├─ 自算作曲内核 synth.mjs（WAV 合成，零第三方音源）
                                            ├─ 可选：demucs / audio-separator（深度学习分离，外部安装）
                                            ├─ 素材区（原片只读）
                                            ├─ 产物区（新文件 + 版本链）
                                            └─ 回执：真实源/产物 sha256 / 实际媒体 / 请求配方 / 未作品质审核
```

**大文件不出工位**：服务器只传路径与参数，工位本地读写素材，只回元数据、小图（波形对比）与哈希。

## 接线

```ts
import { createBgmBridgeExecutor } from "./bundles/ai-video/connectors/bgm-bridge/executor.ts";

const toolExecutor = createBgmBridgeExecutor({
  baseUrl: process.env.WORKLOOM_BGM_BRIDGE_URL!,      // 支持逗号分隔多端点
  token: process.env.WORKLOOM_BGM_BRIDGE_TOKEN!,
  tenantId: "ws-video",
  timeoutMs: 1_800_000,
});
// 注入宿主：packages/runtime/src/loop.ts 的 input.toolExecutor（部署适配器负责）
// 行业侧适配器：server-adapter.mts（读 WORKLOOM_BGM_BRIDGE_* 环境变量）
```

与调色工位同款：基座 seam 提案仍处「暂缓」（`proposals/workloom-im/0001-deployment-tool-executor-seam.md`），
因此当前生产入口是**行业侧脚本注入**（见 `runtime-smoke.mts` 与部署层 `server-adapter.mts`），不改任何基座文件。

## 工具面

| 工具 | 类型 | 用途 |
|---|---|---|
| `bgmread.health` | 读 | 工位与引擎健康（ffmpeg/ffprobe、作曲内核、分离引擎、曲库是否存在） |
| `bgmread.probe` | 读 | 音轨规格：时长/声道/采样率/编码 |
| `bgmread.analyze` | 读 | 响度（EBU R128）、人声频段活动段、静音窗口底噪、剪辑点、疑似已有配乐 |
| `bgmread.structure` | 读 | **曲目结构识别**：能量包络→intro/verse/build/drop/breakdown/outro 分段 + BPM 估计 + 高潮/铺垫候选 |
| `bgmread.recipes` | 读 | **题材×情绪配方检索**（调式/调性/BPM/和弦/配器/电平/让位/禁忌） |
| `bgmread.library` | 读 | 无版权曲库检索 + 许可判定 + TASL 署名文件 |
| `bgmwrite.compose` | 写 | **自算作曲**出 BGM（可按时长对齐片子、可按剪辑点定速） |
| `bgmwrite.mix` | 写 | 分层混音出片：原声保留策略、侧链让位、卡点对齐、淡入淡出、-14 LUFS 母版 |
| `bgmwrite.separate` | 写 | 人声分离（demucs/audio-separator → ffmpeg 中心声道近似，质量等级如实标注） |
| `bgmwrite.best` | 写 | 兼容入口执行一个已声明配方，不评分或选品质候选；只有显式 `noMusic` 才不配乐 |
| `bgmwrite.tag` | 写 | **曲库打标**：素材目录逐首实测（响度/真峰值/削波/拍速/结构/频谱/静音）→ 多维标签 + 置信度 → 写曲库索引；许可必须先声明（围栏 G-BGM8），低置信如实记录，不设成功素材品质人审（G-BGM9） |

## 随仓兜底曲库（50 首可商用纯音乐选段）

`bundles/ai-video/library/bgm-library-curated/` 是**兜底曲库**：客户没有自建曲库、在线曲源也不可用时，
配乐链路用它不断档。它由产品所有者提供的可商用纯音乐包（1200 首）经**实测打标 + 精选**生成：

```bash
# ① 素材包打标（一次跑完，索引落盘；许可必须先声明）
bgm-cli tag --in ~/Downloads/1200可商用纯音乐 --out ~/.workloom-bgm/library \
            --license royalty-free --license-note "所有者声明可商用" --concurrency 6
# ② 精选 N 首进仓（质量分 + 风格族轮转 → 选段 → 线性增益到 -14 LUFS → AAC 112k）
node scripts/bgm-curate-library.mjs --index ~/.workloom-bgm/library \
     --out bundles/ai-video/library/bgm-library-curated --count 50 --seconds 60
```

每首 60s 选段（优先取能量最饱满的 drop 段中心）、**线性增益到 -14 LUFS**（峰值贴顶的选段按**峰值保护优先**，宁可低于 -14 也不压动态/不冒削波风险——偏低多少用 `excerpt.loudnessDeltaDb` 与 `peakProtected` 如实登记）；真峰值目标 ≤-1 dBTP，AAC 交调过冲实测最差 -0.33；索引里带
风格族/题材/情绪/BPM 档/能量档/配器/使用场景/循环友好度与**逐条置信度**，每个数字都能回溯到
`curation-report.json` 与工位曲库的 `tag-evidence.json`；许可按所有者声明登记为 `royalty-free`
（来源目录写在 `licenseSource`，上游逐首许可未随包提供——再分发前请复核）。

## 素材搬家与自动关联（客户单独下载文件夹也能接上）

曲库索引里的路径分两种模式，对应两条完全不同的使用路径：

| 模式 | 谁生成 | 适合什么场景 | 搬走素材后 |
|---|---|---|---|
| `absolute`（默认） | `bgm-cli tag` 就地打标（不搬文件） | 工位本机使用，素材原地不动 | 路径会失效 → 用 `rebind` 重绑 |
| `relative` | `bgm-cli library --pack` 打进素材目录 | **随文件夹分发**：用户下载/解压到任意位置 | 跟着文件夹走，永远有效 |

```bash
# ① 打标（工位本机索引，绝对路径）
bgm-cli tag --in ~/Downloads/1200可商用纯音乐 --out ~/.workloom-bgm/library --license royalty-free

# ② 把索引"打进"素材目录，变成相对路径索引 → 整个文件夹可以压缩分发
bgm-cli library --pack --library ~/.workloom-bgm/library --out ~/Downloads/1200可商用纯音乐

# ③ 素材被挪到别处（索引还在工位）→ 重新绑定
bgm-cli library --rebind ~/Documents/新位置 --library ~/.workloom-bgm/library --allow-overwrite
bgm-cli library --rebind <新位置> --verify sha256 --library <索引目录> --allow-overwrite   # 严格模式（按内容哈希核验）

# ④ 看本机有哪些可用曲库（自动发现：Downloads / Documents / Desktop / 外接盘，默认深度 2）
bgm-cli library --scan
```

配套的运行时行为：

- **自动发现**：`libraryRoots()` 除三个显式根（客户自建 / 随仓兜底 / 工位本地）外，会自动扫描
  `~/Downloads`、`~/Documents`、`~/Desktop` 与 `/Volumes/*` 下带 `tracks.json` 的目录，**抽样核验**音频在位后
  以 `local-discovered` 身份加入（显式配置永远优先，同 id 先到先得）；`WORKLOOM_BGM_SCAN_ROOTS` 可改扫描根，
  `WORKLOOM_BGM_DISCOVER=0` 可整体关掉。实测一次扫描约 **80ms**，不会拖慢工位；
- **失效自查**：索引里抽到的文件全不在位时，`inspectLibraryDir` 会给出 `needsRebind` 提示与"疑似被移动"的说明，
  不装作还能用；
- **rebind 口径**：按**文件名**匹配，同名多候选时用文件大小（默认 `--verify size`）或 `sha256`（严格模式）定夺，
  结果如实分三类回报：`matched` / `missing` / `ambiguous`。

## 目录预设（catalog）：欧美流行 / 中国古典 / 影视配乐

```bash
bgm-cli fetch --prompt "国风古筝，中国古典" --catalog chinese-classical
bgm-cli fetch --prompt "欧美流行风格，快节奏" --catalog western-pop
bgm-cli best  --in clip.mp4 --out scored.mp4 --audio-stems pinned-audio-reference.json --prompt "..." --catalog cinematic-score
```

| catalog | 含义 | 曲源参数（Jamendo 标签 / Freesound 检索词） |
|---|---|---|
| `western-pop` | 欧美流行**风格**（现代流行/电子/舞曲） | pop/dance/electronic · "pop music loop upbeat" |
| `chinese-classical` | 中国古典/国风（古筝·二胡·琵琶·笛箫） | traditional/chinese/world · "guzheng erhu pipa dizi chinese traditional" |
| `cinematic-score` | 影视配乐（管弦/氛围/推进） | soundtrack/classical/cinematic · "cinematic orchestral score" |

**版权红线（产品侧已明确记录在 `bgm-library-license` 技能里）**：当下榜单的商业热单、以及任何来源不明的录音，
都**不能**抓取、不能随开源仓分发、不能直接用于客户商用交付 —— 要么走已授权的商业曲库（自建索引 `generic-http`
或把已购曲目放进 `WORKLOOM_BGM_LIBRARY_DIR`），要么用同风格的 CC0/CC BY/免版税曲目。中国古典同理：
曲谱多属公有领域，**录音**仍有表演者权。

## 选段（外部曲目只取"最合适的那一段"）

外部曲目通常 2–3 分钟、片子只有几十秒，所以"裁哪一段"与"配什么曲子"同等重要：

```bash
bgm-cli structure --in track.wav                       # 看结构：分段 + BPM + 高潮候选
bgm-cli mix --in clip.mp4 --out scored.mp4 --bgm track.wav --audio-stems pinned-audio-reference.json --section auto
bgm-cli mix ... --section climax                       # 强制取高潮段
bgm-cli mix ... --section calm                         # 强制取铺垫段
bgm-cli mix ... --section-start 62 --section-end 78    # 人工指定（秒）
```

默认写路径不进行片子/曲目能量、对白或剪辑点审查，也不自动挑选高潮段。`section-start/section-end` 明确请求时才取该段，否则消费声明曲目；结果写明实际选段、源摘要和实际播放摘要。显式 `bgmread.structure/analyze` 仍可用于独立诊断，不能变成成功素材的默认验收门。

## 原声音轨与显式独立来源

默认 `mix/best` 消费原片已有节目混音，无需 `--audio-stems` 或签发秘密。无声源按处理需要补静音轨。`sourceAuthority=native-source`、`stemsVerified=false`、`retainedMusicExcluded=false` 如实说明它不是分离的干净对白。

| policy | 行为 | 来源与授权边界 |
|---|---|---|
| `keep-dialogue`（默认） | 保留原节目，以节目频段作近似侧链，单次混入请求音乐 | 不声称干净独立对白；无品质余量测量 |
| `keep-all` | 保留原节目并直接混入请求音乐 | 不自动降电平重试 |
| `replace-bed` | 消费调用者明确提供的独立节目来源 | 缺独立来源拒绝，不从原混音推断旧音乐 |
| `music-only` | 按显式许可丢弃原声 | 必须 `allowDiscardOriginal=true`；已签章对白仍须保留 |

显式 `--audio-stems` 仍指向 `{dir,manifestSha256,recipeSha256,scope}`，其签章、作用域和真实字节在消费前后核对；签发秘密不会用默认值补造。显式独立来源错误不能回退原声。原片、音乐和节目采用实际快照，执行一个声明电平/淡入淡出/侧链/响度滤镜，循环音乐输入本身有有限时长以保证 FFmpeg 正常结束。

回执 `metrics=null`、`score=null`、`qualityReviewPerformed=false`、`qualityRetries=0`；LUFS、真峰值、人声余量、让位深度、配乐可闻度和自动卡点未测，不能说成通过。静音、黑帧、高峰值或不可测声音不构成品质否决。实际文件/输入改变、来源无效、处理退出失败或输出时间线/画布不符仍明确失败，不降音量重试、不静默交付原声。

输出路径必须为新文件。相同 HTTP 请求仅在途共用作业；已完成请求重交会返回
`idempotency_revalidation_required`，同键不同参数为 `idempotency_conflict`。旧回执不作为新一次成功依据。

## 安装与自检（工位一次性）

真实 FFmpeg、默认原声、显式签章来源及 CLI/HTTP 的当前行为由 `declared-program-mix.test.mjs`、`audio-stems-mix.test.mjs` 和 `delivery-integration.test.ts` 覆盖。显式诊断/旧演示脚本输出的测量不代表普通混音自动执行了品质验收。

```bash
bash kit/install.sh            # 受控下载 ffmpeg/ffprobe（pin 版本 + sha256 校验 + 必需滤镜检查）
bash kit/selftest.sh           # 自造片子 → 诊断 → 作曲 → 混音 → 指标核验
```

## 真机演示与产物导出（不依赖数据库）

```bash
node bundles/ai-video/connectors/bgm-bridge/demo-artifacts.mjs --out /tmp/bgm-demo --recipe food
```

产出 `original.mp4`（自造原始成片：4 段硬切 + 3 句对白 + 环境声）、`bgm-track.wav`（自算 BGM）、
`bgm-mixed.mp4`（配乐成片）、`vocals.wav`/`instrumental.wav`（分离演示）、
`waveform-before-after.png`（波形对比）、`bgm-report.json`（实际回执；显式诊断另记，不伪造默认指标）、`README.md`（交付说明）。

## 运行时端到端（真实 PG + 真实围栏 + 真实 bridge + 真实 ffmpeg）

```bash
set -a; source .env; set +a
node_modules/.bin/tsx bundles/ai-video/connectors/bgm-bridge/runtime-smoke.mts
```

五个场景（脚本自动起停 bridge）：

| 场景 | 期望 |
|---|---|
| clean：常规配乐 | `completed`，产出成片，回执 sha256 与磁盘文件一致（G-BGM0 auto 直通） |
| review：曲库首次入片（许可未核验） | `pending_review` + 审批号（G-BGM1 review） |
| blocked：覆盖原片 | `paused`，`blockedBy=覆盖原片禁止`（G-BGM2 block） |
| blocked-license：NC 曲目商用 | `paused`，`blockedBy=版权不合规`（G-BGM5 block） |
| outage：工位不可达 | `failed` + 步骤标未核实（软失败不伪造回执） |

## 安全

- token 只从受控秘密存储或工位本机文件读取，不进仓库、不进日志；
- bridge 默认只监听 `127.0.0.1`，跨机置于内网反代 + mTLS 之后；
- **路径监狱**：`WORKLOOM_BGM_ALLOWED_ROOTS`（冒号分隔）之外一律拒绝，软链逃逸同样拦；
- **原片只读**：输出路径等于输入路径直接拒绝（`overwrite_source_forbidden`），并由围栏 G-BGM2 一票否决；
- 客户素材与成品只落工位/租户素材区，不上行蜂群；曲库凭据留在客户侧；
- 无回执 = 未核实：executor 不会为缺失的 receipt 伪造 `synced`。

## 错误码

可重试：`network_error` / `timeout` / `ffmpeg_failed` / `decode_failed` / `engine_failed` / `bad_response`

不可重试：`path_not_allowed` / `tenant_mismatch` / `overwrite_source_forbidden` / `disk_quota_exceeded` /
`ffmpeg_not_installed` / `bad_media` / `bad_recipe` / `bad_track` / `license_blocked` /
`separation_unavailable` / `verify_failed` / `not_found` / `not_provided` / `not_configured`

## 许可与作曲口径

- **自算作曲**（`synth.mjs`）：音频由本仓代码合成，不含任何第三方样本/LUT/曲目，
  同一配方 + 同一种子 → 同一份 PCM → 同一 sha256；商用交付无第三方权利尾巴。
- **外部曲库**：只接"已登记许可"的曲目，逐曲判定可否商用、是否需署名（见 `library/bgm-library/README.md`）。
- **深度学习分离引擎**（demucs / audio-separator）为**外部安装**，不随仓分发；仓内固定记录
  仓库、许可与降级路径（`kit/ffmpeg-pin.json#optionalEngines`）。

## 当前交付纪律

- 成功镜头直接正式后期；默认保留真实原声音轨，无声源不补配音。
- 请求曲目/配方执行一次；缺少所请求曲库或实际处理失败明确报错，不用另一曲、作曲或无乐版本静默兜底。
- 原片与音乐只读，快照和最终输入摘要核对；实际输出规格和当前摘要写入回执。
- 不做源或输出品质评分、候选评选、ASR、TTS 或因质量重渲；独立诊断工具只有明确调用才执行。
- 许可、作用域和覆盖源的前置保护仍按真实围栏与来源事实执行；本地处理回执不认证音乐商用许可或主观听感。
