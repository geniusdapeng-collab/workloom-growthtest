# 成片配乐 bridge 连接器（ai-video）

把 `bgmread.* / bgmwrite.*` 工具接到 Mac 配乐工位（ffmpeg 内核 + 仓内自算作曲内核），
供「BGM 配乐师」数字员工在后期环节对成片做**定调 → 分层 → 铺设 → 复检**。

## 部署形态

```
WorkLoom（大脑：岗位/技能/围栏/事件账本）          Mac 配乐工位（手，独立内网）
  runtime ToolExecutor ──HTTP/Bearer──▶  bgm-bridge (127.0.0.1:9775)
                                            ├─ ffmpeg / ffprobe（kit 受控安装）
                                            ├─ 自算作曲内核 synth.mjs（WAV 合成，零第三方音源）
                                            ├─ 可选：demucs / audio-separator（深度学习分离，外部安装）
                                            ├─ 素材区（原片只读）
                                            ├─ 产物区（新文件 + 版本链）
                                            └─ 回执：sha256 / 响度 / 让位深度 / 人声余量 / 配乐可闻度
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

## 工具面（10 个）

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
| `bgmwrite.best` | 写 | 择优配乐：候选池打分；**允许结论是"这片子不需要配乐"**（不产出文件） |
| `bgmwrite.tag` | 写 | **曲库打标**：素材目录逐首实测（响度/真峰值/削波/拍速/结构/频谱/静音）→ 多维标签 + 置信度 → 写曲库索引；许可必须先声明（围栏 G-BGM8），低置信交人审（G-BGM9） |

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

`section=auto` 的决策链（每一步都写进回执 `report.section`）：

1. 先定**片子的高潮时刻**，依据按优先级：剪辑密度成簇（±2s 内 ≥2 剪辑点）→ 非对白段能量峰（比非对白中位数高 ≥3dB）→ 音频总能量峰（且对白占比 <35%）；
2. 找得到 → 取曲子的 `drop` 段，把它内部的能量峰值**对齐到片子高潮时刻**（片子高潮更早则向前裁片头）；
3. 找不到（口播/访谈这类无画面高潮的片子）→ **不做峰值对齐**，取曲子最有代表性的一段从片头铺，回执写明原因；
4. 选出的段比片子还长 → 段内**滑窗**（以能量最高处为中心取 片长×40%）；曲子平坦则从曲头取。

边界纪律：片段边界优先吸结构边界、其次吸节拍（BPM 置信度 low 时不吸）；两端各 120ms 微淡防爆音；选段后**重新量片段电平**再定增益。
证据：`section-picked.png`（上=曲目波形+选中片段红框，下=片子波形+高潮时刻红框）。

## 四种分层策略（回答"声音全去掉？直接盖？还是先分离人声？"）

| policy | 声音床 | 适用 | 纪律 |
|---|---|---|---|
| `keep-dialogue`（默认） | 独立对白 + 环境 + 拟音 | 口播/访谈/带货 | 只由独立对白驱动侧链；对白-音乐余量 ≥3dB，3–6dB 告警 |
| `keep-all` | 同一独立节目轨，BGM 更轻 | 纪录片/现场感 | 配乐电平再降 3dB，旧音乐不进入节目轨 |
| `replace-bed` | 经签章的独立对白 | 环境声脏、要换氛围 | 不做中心声道近似分离；独立对白缺失拒绝 |
| `music-only` | 静音节目床 | 无对白纯音乐片 | 显式 `allow_discard_original=true` 且对白须有权威不适用回执 |

## 正常混音的独立来源要求

`mix`/`best` 的 CLI 参数 `--audio-stems` 指向固定引用 JSON：`{dir,manifestSha256,recipeSha256,scope}`；
工具参数名为 `audio_stems`。来源由本工位自持的 `audio-stems.mjs` 生成/校验（后期工位同源引用），四角色与签章合同见
[`post-bridge/README.md`](../post-bridge/README.md#独立音轨来源合同t-2026-0927-0037)。工位使用
`WORKLOOM_AUDIO_STEM_SIGNING_SECRET` / `WORKLOOM_AUDIO_STEM_SIGNING_KEY_ID` 验证，未配置时拒绝。
本连接器只含验证器，尚未实现生产签发者。分离工具的输出不是生产独立来源资格。

混音前后均重验当前签章、作用域、源/角色/节目字节及配方重放。画面、音乐、节目与对白从校验后的
FD 快照读取，画面内嵌音频不参与混音。对白活动、侧链和人声余量均来自独立对白轨。最终对白/音乐/
节目测量使用同一线性主增益，保留处理后轨道与哈希，不以不同响度归一化的文件比较余量。
增益受真峰值余量限制；无法同时满足响度和峰值时失败，不使用未记录的动态限制器。
合法无对白决定显示 `applicability=not_applicable`；其人声余量与让位数值为 null，未获得不适用签章的
缺失测量仍失败。音频/视频时间线差超过 40ms 拒绝。

输出路径必须为新文件。相同 HTTP 请求仅在途共用作业；已完成请求重交会返回
`idempotency_revalidation_required`，同键不同参数为 `idempotency_conflict`。旧回执不作为新一次成功依据。

## 安装与自检（工位一次性）

下列旧 selftest/demo/runtime-smoke 脚本尚未接入独立来源签发合同，其混音步骤会按缺少签章拒绝；
当前合同的真实 FFmpeg、CLI/HTTP 与总装测试由 `audio-stems*.test.mjs`、`audio-stems-mix.test.mjs` 和
`delivery-integration.test.ts` 覆盖。不得把旧脚本执行失败解释为需要放宽来源校验。

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
`waveform-before-after.png`（波形对比）、`bgm-report.json`（全量指标）、`README.md`（交付说明）。

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

## 与配乐纪律的对应

| 纪律 | 落点 |
|---|---|
| 保留人声、BGM 让位 | `sidechaincompress` 侧链由人声频段驱动；`duckingDepthDb` / `speechToMusicMarginDb` 实测 |
| 配了不能像没配 | `musicPresenceDb` <3dB 直接 `verify_failed` 并删除产物（do-no-harm） |
| 不压住人声 | 人声-音乐余量 <3dB 直接 `verify_failed`；3–6dB 记告警 |
| 响度交付口径 | 由实测节目响度/真峰值求同一线性增益；-14 LUFS / -1 dBTP，超差拒绝发布 |
| 卡点对齐 | 剪辑点（scene 检测）→ 节拍网格偏移搜索；平均/达标率与阈值写进回执 |
| 选段可解释 | `bgmread.structure` 的段表 + `chooseSection` 的决策理由 + `section-picked.png` 证据；无高潮点如实写 `skipped` |
| 原片只读 | `assertOutputWritable` 同款检查 + 围栏 G-BGM2 |
| 无回执不算完成 | 指标复检 + sha256 回执 + 围栏 G-BGM3；outage 场景负例 |
| 许可干净 | 曲库白名单 + G-BGM1/G-BGM5；自算作曲为默认路径 |
