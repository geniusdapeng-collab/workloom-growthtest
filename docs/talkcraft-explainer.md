# 口播解说片（talkcraft-explainer）· 部署与运维

> T-2026-0926-0008 / -0009 / -0010 · 2026-09-26 · 对应规格书《口播解说片能力（talkcraft-explainer）· 实施规格书 v2.0》
>
> 阅读顺序：本文件（部署口径）→ `apps/server/src/video/explainer/engine.ts`（许可与就绪闸）→
> `packages/video-studio/explainer-template/README.md`（合成模板契约）→ `bundles/ai-video/skills/talkcraft-ops/SKILL.md`（制作纪律）。

## 1. 这是什么

一条独立的视频生产线：**一份口播稿 + 一条配音 → 字级对齐的图文动效解说片**。
它把 [video-talkcraft](https://github.com/Vincentwei1021/video-talkcraft) 的动效资产（108 张配方卡）
与确定性工具链，接进 Growth 既有的「提交 → 轮询 → 入库 → 制片档案 → 监制门 → 交付」链路。

链路位置（与既有两条线并列）：

| 管线 | 形态 | 入口 |
|---|---|---|
| 营销片 `marketing` | 商品情报 → PRD → 逐镜生成 → 后期 | `video.studio.start`（route=marketing） |
| 叙事片 `narrative` | 创意主题 → 剧本 → 逐镜生成 → 后期 | `video.studio.start`（route=narrative） |
| **口播解说片 `explainer`** | **口播稿 → 配音 → 字级对齐 → 配方式图文动效** | **`video.explainer.*` / `pnpm explainer:run`** |

## 2. 许可口径（先读这条，再看其他）

- 上游许可是 **PolyForm Noncommercial 1.0.0**：非商用免费；**任何商用用途都需作者书面授权**。
- 因此本仓的做法是：
  1. **引擎源码不入库**——`vendor/talkcraft/` 在 `.gitignore` 里；安装期按上游 commit 拉取受控子集；
  2. **CI 硬闸**：`scripts/ci/verify-talkcraft-license.mjs` 反向检查"上游源码没有被提交进 git"；
  3. **运行前许可闸**：`TALKCRAFT_LICENSE_SCOPE=noncommercial`（评估/内部验证）可直接跑；
     商用交付必须切到 `authorized`，并把作者书面授权放到 `<引擎目录>/LICENSE-GRANT.md`
     （含授权方/被授权方/范围/日期四要素），否则 `RemotionProvider` 拒绝渲染。
- 成片版权归创作者所有；被限制的是**工具链本身的使用与再分发**。

> 行动项（产品侧）：对外商用发布前，向作者取得书面商业授权并把 `LICENSE-GRANT.md` 放进引擎目录。
> 未取得授权前，本能力只用于评估 / 内部验证。

## 3. 部署（一台机器一次）

```bash
# ① 引擎（受控子集：scripts/ template/ references/ runtime/ + LICENSE + THIRD_PARTY_NOTICES）
pnpm talkcraft:install -- --with-runtime --with-asr

# ② 体检（安装完整性 / 运行时冒烟 / 许可口径 / 卡数 / PINNED commit）
pnpm talkcraft:check

# ③ 开关（.env）
TALKCRAFT_ENABLED=1
TALKCRAFT_LICENSE_SCOPE=noncommercial   # 商用前改 authorized + 放 LICENSE-GRANT.md
```

目录约定：

```
vendor/talkcraft/              # 引擎（不入库）：scripts/ template/ references/ runtime/ PINNED LICENSE
var/talkcraft-src/             # 上游克隆缓存（不入库）
var/talkcraft-jobs/<taskId>/   # 每个任务：audio/ remotion/ out/（唯一事实源，可断点续跑）
var/talkcraft-assets/host/     # 人物底板（定妆照 → 12s 极缓推近视频）
var/tcvenv/                    # ASR 依赖（mlx-whisper；Apple Silicon）
```

## 4. 两条使用路径

### 4.1 服务端（产品路径）

```ts
video.explainer.create       // 立项 + shotbook v1(draft)
video.explainer.shotbook     // 生成分镜（LLM 或规则兜底）→ 新版本(validated)
video.explainer.submit       // 准备段（配音/对齐/语义/装配/体检）+ G8 + submitGenJob
video.explainer.finalize     // 渲染 done 后：机器闸六条 → 两遍 loudnorm → 媒资库 final_cut
video.explainer.versions     // 版本链
video.explainer.engine       // 引擎体检（安装/许可/卡数/commit）
```

渲染提交后由既有 `render-poller` 回填（`render_jobs.provider='remotion-local'`，产物按 `clip` 入库、
`pipeline_kind='explainer'`）；`finalize` 再把交付件按 `final_cut` 入媒资库。

### 4.2 命令行（真机验收 / 运维路径）

```bash
pnpm explainer:run -- \
  --script var/scripts/<口播稿>.md \
  --task-id 验收-陈卓 \
  --profile chen-zhuo-film \
  --host-portraits bundles/ai-video/library/characters/model-01-chen-zhuo/portraits/v3 \
  --brand-product "WorkLoom 获客增长系统"
```

与服务端**共用同一条 pipeline**（`apps/server/src/video/explainer/pipeline.ts`），
差别只在装配面：CLI 直接接环境里的 LLM / 素材，不触库。产物落 `var/talkcraft-jobs/<taskId>/`
（`out/delivery.mp4` + `out/qa-report.json` + `run-report.json`）。

## 5. 环境变量

见 `.env.example` 的「口播解说片」段（`TALKCRAFT_*`）。关键三个：

| 变量 | 口径 |
|---|---|
| `TALKCRAFT_ENABLED` | 总开关；`0` 时 provider 缺位、路由退化成"无可用模型"（不静默 mock） |
| `TALKCRAFT_LICENSE_SCOPE` | `noncommercial`（评估）/ `authorized`（需 `LICENSE-GRANT.md`） |
| `TALKCRAFT_ASR_BACKEND` | `voice-station`（本机 mlx-whisper 词级）/ `vendor-whisper` / `vendor-sherpa` / `precomputed` |
| `TALKCRAFT_VOICE_MAX_CHUNK_CHARS` | TTS 分块上限（缺省 60 = 按句合成；逐句合成才能断点续跑） |
| `TALKCRAFT_VOICE_GAP_MS` | 句间气口（缺省 520ms；也是音效能被听出来的物理前提） |
| `TALKCRAFT_RENDER_WORKERS` | 渲染并行段数（低配设 1） |

### 5.1 段缓存与断点

- **段缓存**在 `<jobDir>/remotion/out/segments/<shotId>.mp4`（render_shots 的 cwd 是工程 `remotion/`，
  所以 `out/segments` 相对工程而不是任务根目录）；段指纹含素材/时序/props，改一镜只重渲该段±邻段。
- **成片**在 `<jobDir>/out/{assembled.mp4, full-mix.wav, v1.mp4, delivery.mp4}`；
  `qa-frames/`、`qa-sheets/`、`qa-report.json` 是机器闸与评审材料。
- **断点续跑**：`pnpm explainer:run -- ... --resume` 在 `out/v1.mp4` 已在盘时跳过渲染直接跑闸与交付；
  TTS 逐句缓存（工位 `deliveries/talkcraft-sNN-*.wav`），中断后重跑只补缺的句子。

## 6. 验收口径

| # | 验收项 | 通过标准 | 证据位置 |
|---|---|---|---|
| 1 | 许可合规 | 上游源码未入库；CI 闸 `--self-test` 通过；PINNED 有 commit | `scripts/ci/verify-talkcraft-license.mjs` |
| 2 | 引擎就绪 | `pnpm talkcraft:check` → `ready=true`（含冒烟渲 1 帧） | `vendor/talkcraft/.runtime-ready` |
| 3 | 端到端 | 口播稿 + 配音 → `delivery.mp4`（两遍 loudnorm） | `var/talkcraft-jobs/<taskId>/out/` |
| 4 | 字级同步 | `beat_lint` |Δ|≤0.1s（本引擎 beats 由 timing 派生） | `out/qa-report.json` |
| 5 | 卡保真 | `card_lint` 对每张用卡通过 | 同上 |
| 6 | 反 PPT | `motion_check` 静止段/抖动无 FAIL | 同上 |
| 7 | 评审材料 | `qa_extract` 抽帧 + `contact_sheet` 拼图在场 | `out/qa-frames/`、`out/qa-sheets/` |
| 8 | 零回归 | narrative/marketing 管线与全量测试套件不受影响 | CI `test-gate` |

## 7. 常见问题

- **渲染很慢**：段缓存是常态（改一镜只重渲该段±邻段）；首渲按 `TALKCRAFT_RENDER_WORKERS` 并行。
- **ASR 太慢/不可用**：`TALKCRAFT_ASR_BACKEND=vendor-whisper`（引擎自带 faster-whisper 后端）
  或 `vendor-sherpa`（需手动放 767MB FireRed 模型）。
- **许可闸拦住了渲染**：这是设计行为——评估期切 `noncommercial`，商用前取授权并放 `LICENSE-GRANT.md`。
- **跨机器续跑**：把 `var/talkcraft-jobs/<taskId>/` 整个拷过去（含 `props.json`/段缓存），
  在新机器 `pnpm talkcraft:install` 后重跑渲染即可（工程自包含）。
