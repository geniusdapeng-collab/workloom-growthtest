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

## 随仓兜底曲库（50 首可商用纯音乐选段）

`bundles/ai-video/library/bgm-library-curated/` 是**兜底曲库**：客户没有自建曲库（`WORKLOOM_BGM_LIBRARY_DIR`）、
在线曲源也不可用时，配乐链路用它不断档。

- **来源与许可**：由产品所有者提供的可商用纯音乐包经**实测打标 + 精选**生成（打标/精选流水线在主仓
  `WorkLoom-growth` 的 `bgmwrite.tag` / `scripts/bgm-curate-library.mjs`；本仓只做分发与检索）。
  许可登记为 `royalty-free`，来源目录写在每条索引的 `licenseSource` 里——上游逐首许可未随包提供，**再分发前请复核**；
- **形态**：每首 60s 选段（优先取能量最饱满的 drop 段中心），线性增益到 -14 LUFS；峰值贴顶的选段按**峰值保护优先**，
  实际响度与偏差逐首登记在 `excerpt.loudnessDeltaDb` / `excerpt.peakProtected`；AAC 112kbps 44.1kHz 立体声；
- **检索**：`tracks.json` 是运行时契约（风格族/题材/情绪/BPM 档/能量档/配器/使用场景/结构/响度/许可/置信度），
  工位用 `bgmread.library` 检索、`bgmwrite.best` 择优；选谁/为何/取了哪一段见 `curation-report.json`；
- **分布**：11 个风格族各 4-5 首（electronic-pulse / lo-fi-chill / cinematic-build / tension-dark / modern-pop /
  festive-bright / acoustic-warm / ambient-calm / documentary-bed / corporate-clean / sports-hype）。

## 选段（外部曲目只取"最合适的那一段"）

外部曲目通常 2–3 分钟、片子只有几十秒，所以"裁哪一段"与"配什么曲子"同等重要：

```bash
bgm-cli structure --in track.wav                       # 看结构：分段 + BPM + 高潮候选
bgm-cli mix --in clip.mp4 --out scored.mp4 --bgm track.wav --section auto
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
| `keep-dialogue`（默认） | 原声全保留，BGM 让位 | 口播/访谈/带货 | 人声-音乐余量 ≥6dB，让位 8–14dB |
| `keep-all` | 原声全保留，BGM 更轻 | 纪录片/现场感 | 配乐电平再降 3dB，让位更浅 |
| `replace-bed` | 仅人声（中心声道近似分离） | 环境声脏、要换氛围 | 单声道素材直接拒绝（`separation_unavailable`） |
| `music-only` | 静音（原声全丢） | 纯音乐卡点片 | 必须显式 `allow_discard_original=true`，且 G-BGM3 在有人声时阻断 |

## 安装与自检（工位一次性）

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
| 响度交付口径 | 两遍法 `loudnorm`：-14 LUFS / -1 dBTP，复检超差记 `loudness_ok=false` |
| 卡点对齐 | 剪辑点（scene 检测）→ 节拍网格偏移搜索；平均/达标率与阈值写进回执 |
| 选段可解释 | `bgmread.structure` 的段表 + `chooseSection` 的决策理由 + `section-picked.png` 证据；无高潮点如实写 `skipped` |
| 原片只读 | `assertOutputWritable` 同款检查 + 围栏 G-BGM2 |
| 无回执不算完成 | 指标复检 + sha256 回执 + 围栏 G-BGM3；outage 场景负例 |
| 许可干净 | 曲库白名单 + G-BGM1/G-BGM5；自算作曲为默认路径 |
