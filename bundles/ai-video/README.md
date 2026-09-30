# ai-video 行业包 · 给 AI Agent 的安装与执行说明（runbook）

> 读者：被派来做视频的 AI Coding Agent（或交付同学）。
> 目的：**别跳步**。真机事故（2026-09-30 出镜人物 片）的根因就是"直接跑出片命令、
> 没先判视频类型、也没让分镜卡过字段规范闸"。

---

## 0. 先做一件事：判断这是哪一类视频

**不要上来就跑出片命令。** 先跑分流：

```bash
pnpm exec tsx scripts/tools/route-video.mts --title "<用户需求原文>" --llm --out work/route.json
```

它会给出 `marketing`（营销片，含商品情报档案与 G1 门）/ `narrative`（通用叙事片）/
`explainer`（口播解说片）/ `clarify`（**判不准 → 先问用户，不要替用户花钱**），
并打印对应的**建议命令**与意图清理后的文本。

> **出片入口的硬约束（T-2026-0930-0015）**：`full-chain-film.mts` 现在**要求分流结论**——
> 要么 `--route work/route.json`（上面这条命令的 `--out` 产物），要么对已确认过的补跑项目显式
> `--route-kind marketing|narrative`。两者都没有会直接 `ROUTE_PREFLIGHT_ROUTE_REQUIRED` 拒绝出片；
> 判不准（`clarify`）时也会拒绝并提示"先问用户"。营销片缺商品锚点同样 fail-closed。

- 判据与口径：`packages/video-studio/src/pipeline-router.ts`；设计说明：`docs/video-pipeline-routing-and-dossier-2026-09-25.md`
- **营销片必需商品锚点**（商品名只能来自用户显式声明 / metadata / 模型抽取，**不许猜**）；
  商品档案放在 `bundles/ai-video/library/products/<档案>/`，G-PROD1 会逐镜校验真实商品绑定。
- 服务端派活（`apps/server/src/video/router.ts`）走的是同一条分流；CLI 侧以前没有入口，
  所以本补充了 `route-video.mts`。

## 1. 安装与环境（一次）

```bash
node -v            # >= 24
pnpm install
pnpm exec tsx scripts/tools/video-doctor.mts   # 出片环境自检（缺什么一目了然）
```

`video-doctor` 会检查：Node/pnpm、ffmpeg/ffprobe（含 `~/.workloom-color/bin` 与 `WL_FFMPEG`）、
火山方舟与评审模型密钥、配音工位、**配乐曲库与路径监狱**、真人/商品/片型/封面知识库、入口与 runbook 是否齐备。
`--json` 输出给 Agent 解析；存在 FAIL 时退出码 1。

工位与密钥（**不要写进仓库/日志/提交**）：

| 依赖 | 位置 / 变量 | 说明 |
|---|---|---|
| 视频/图片生成（火山方舟） | `~/.workloom/live.env`：`VOLCENGINE_ARK_API_KEY`、`SEEDANCE_MODEL`、`SEEDREAM_MODEL` | 出片/出图必需；**欠费时提交会被 403 `AccountOverdueError` 拒绝**（先充值再跑，别反复提交） |
| 评审/仲裁模型 | `DEEPSEEK_API_KEY`（同文件） | 仅 `--review-policy advisory|blocking` 与 `route-video --llm` 用 |
| 调色/字幕/配乐工位 | `bundles/ai-video/connectors/{color,subtitle,bgm}-bridge` | 纯本地；ffmpeg 走 `~/.workloom-color/bin`（管线的 `WL_FFMPEG/WL_FFPROBE`） |
| 配音/人声核查 | `~/.workloom/voice-station`（本地 MLX 引擎，**不联网不花钱**） | `voice-bridge health` 可自检；音色档默认 `zh-xiaozhi` |
| 真人素材 | 火山方舟"私域真人人像库"的 `asset://...` | 参考图只能以 `asset://` 提交（平台禁止直传真人照片） |

自检：`bash scripts/agent-tour.sh`（能力巡游）、`pnpm exec tsx scripts/tools/route-video.mts --title test`。

## 2. 三条管线与它们的执行器

| 类型 | 执行器 | 特点 |
|---|---|---|
| 营销片 | `scripts/tools/full-chain-film.mts`（+ 商品情报档案/G1 门） | 卖货/种草/投放；需要商品锚点；逐镜生成 + 完整后期 |
| 叙事片（通用） | 同上（不需要商品情报层） | 故事/形象片；分镜卡仍须过 25 字段规范（`spec` 阶段） |
| 口播解说片 | `pnpm explainer:run -- --script <稿> --profile <音色>` | 图文成片，不跑逐镜生成 |
| 手绘白板 | `scripts/tools/whiteboard-film.mts --script <稿>` | 本地白板引擎 |

`full-chain-film.mts` 阶段顺序（**按需裁剪，但别跳"规范类"阶段**）：

```
cine-kb → continuity → micromotion → spec（25 字段交付闸）→ plates → material-gen → videos
        → voice（逐镜人声核查/补旁白）→ compose → color → subtitle → bgm → cover → mux → master → deliver
```

> **post-only 组装自动带 `spec`**（T-2026-0930-0015）：`--assembly-mode post-only` 时管线会**自动补上**
> `spec` 阶段；此时它按"25 字段 P0 规范"判（不要求生成用提示词）。真机事故：手写组装卡的 `character`
> 只写"这位女士…"、没写主角名/ID（P0 字段），一路漏到封面才炸。

## 3. 两条已定稿的执行口径（2026-09-30，产品所有者）

1. **渲染后不做"合格/不合格"裁决**：`--review-policy off`（默认）。渲染成功就**直接走完整后期链并交付**，
   质量由客户验收。只保留**事实性硬闸**（产物存在/时长/分辨率/音轨/音画对齐/字幕文件/命名/变体差异）。
   需要时用 `--review-policy advisory`（只记录不阻断）/ `blocking`（旧口径）。
2. **渲染前一次性过关**：红线 linter（屏幕文字/证件文字/道具重复/落幅/帧率）、合同字段与参数、
   授权与素材用途、商品绑定、就绪度（风险优先渲染）——这些是 fail-closed 的**事前**闸；
   默认 `--max-attempts 1`，**禁止同提示词重试**（要重试必须先改卡）。

## 4. 踩过的坑（务必遵守）

1. **post-only 组装（复用既有成品片段）**：必须显式 `--assembly-mode post-only --assembly-reason "<≥8 字>"`；
   同时**把 `spec` 阶段带上**，让手写的组装卡也过 25 字段规范（本次事故：`character` 字段没写主角名/ID →
   封面人物卡找不到来源镜 → 封面退化 → 母版终审被上游放行闸拦下）。
2. **`character` 字段必须写主角名/ID**（如 `客户方CEO（demo-character…）`），
   否则封面"人物为主"版式、造型一致性判定都会失配。
   现在管线会在封面环节**显式报错**（`COVER_PERSON_SOURCE_MISSING`）而不是静默退化成"仅标题"。
3. **配乐**：本机没有独立音轨签发者（`WORKLOOM_AUDIO_STEM_SIGNING_SECRET` 未配置）时，
   管线自动走**声明式直混** `--declared-program-mix`：本地无版权曲库直接可用，
   回执如实标注 `sourceAuthority=declared-unverified`、`stemsVerified=false`（不冒充签章分轨）。
   接入内部签发者后自动切回签章路径。
4. **不要手工做封面 / 手工混音绕过管线**：交付清单要能核对（`delivery-manifest.json` 里有
   `reviewPolicy` / `assembly` / 封面来源 / 各变体 sha256）。
5. **账户欠费**：`AccountOverdueError` 403 会拦住提交；**先充值**，不要连点重试。
6. **服务端固定影片工位（`--worker`）第二批未接线**：CLI 侧还没有解析 `FILM_JOB_CONTEXT`
   与受限通道（llm/image/video/media/voice/review）的实现，本 CLI 会显式报
   `WORKER_MODE_NOT_WIRED`。需要"客户端 UI 派活 → 工位出片"时先完成第二批（`docs/repairs/T-2026-0927-0037.md` / `-0039.md`）。
7. **创作口径不得写成硬闸**：片型配比、运镜强弱、造型主色这类"好不好看"的问题默认只做咨询项，
   硬闸只允许事实类（产物/时长/分辨率/音轨/音画对齐/字幕/命名/授权与素材用途）。CI 会拦（`scripts/ci/verify-hard-gate-policy.mjs`）。

## 5. 交付物与验收

交付目录（`--out`）应包含：`*-<实测时长>s-final.mp4`（母版，名称与实测时长一致）、
`subtitles/`（srt/ass/vtt + 清单）、`*-softsub.mp4`、变体 3 支 + 变体封面、
`*-cover.png`、`*-delivery-manifest.json`（sha256/变体差异/审核口径/组装声明/**分流结论**/**渲染台账**）、
`*-render-ledger.md`（每一次花钱的账：提交几次、判不合格几次、平台拒收几次、canary 止损几次、后期返工几次）。
质量口径见 `docs/video-delivery-and-revision.md`；监制门设计见 `docs/producer-gate-design.md`。

## 6. 认证真人（asset://）：定妆照/角度槽位怎么落实

### 6.0 先跟客户要一样东西：**平台侧资产清单**（通用动作，别靠人肉登记）

> 真机（2026-09-30）：主档里 10 个同组素材 ID 有 8 个在控制台**查无此素材**，而管线取
> "主素材 + 前两张"作参考图 → 多参考图**静默失效**，表现只是"像不像不稳定"，日志里查不出错。
> **任何客户、任何一次建档都按下面这条走。**

请客户提供（任选其一，能复制文本最好）：① 控制台「资产详情」列表的 **源文件名 + asset ID** 两列
（截图也可以——Agent 会把两列转成文本）；② 或直接粘贴/导出 `asset-…` 列表；③ 素材组 ID（`group-…`）；
④ 明确**哪一张是主素材**（主档 `assetId`）与**授权范围/有效期**。

```bash
pnpm video:assets list --asset <assetId>                          # 现状（含管线实取的前 3 张）
pnpm video:assets reconcile --asset <assetId> --from <清单.txt>    # dry-run：新增/删除/不变
pnpm video:assets reconcile --asset <assetId> --from <清单.txt> --primary <主素材ID> --apply
```

纪律（工具已强制）：顺序=优先级（管线取"主素材 + 前两张"，前两张必须最像本人）；
**新 ID 一律标"待客户确认"，不猜角度**；写前备份 `profile.json.bak`，写后落
`asset-list-evidence.json`（清单 sha256 + 逐条来源文件名）并自动自检（主档可装载 + 属性校验 + 打印实取参考图）。

> 抽象口径：截图/清单只是"客户输入"；对账逻辑在 `packages/video-studio/src/real-person-asset-sync.ts`
> （纯函数、无客户常量），CLI 在 `scripts/tools/real-person-assets.mts`。**不要为某个客户写死 ID。**

真人素材在本地只有主档 ID，**没有图片文件**；角色档案的角度槽位必须由"客户导出的原图"或
"以授权素材为参考的派生图"逐张落实，否则"像不像门/首镜身份锚"没有真实基准：

```bash
# 客户从平台导出原图后（保留原文件名即可）：
pnpm exec tsx scripts/tools/portrait-set-install.mts \
  --character <角色ID> --library <角色库目录> \
  --from "<导出目录>" --mapping <角度映射.json> \
  --source customer-export --activate --out report.json
```

工具会校验（缺必需角度/同图占多角度/越界/非图片一律拒绝）、不覆盖历史版本、
写 `portraits/v<N>/source-map.json` 来源证据、更新档案并**写后复核**（未过即 exit 2）。
映射里必填 `front / threeQuarter / closeup / side`；可选 `frontFull / threeQuarterLeft /
threeQuarterRight / smileCloseup / back / actionPose / emotionCloseup / handDetail`。
派生（充值后 img2img）用 `scripts/tools/portrait-agent.mts`，产物必须标注"派生·非权威原图"。

### 6.1 客户只给一张「资产详情页截图」时的通用流程（无需客户逐张导出）

认证素材在**客户账号**里，平台没有"导出资产内容"的接口（`/assets/*` 实测 404）。通用做法是**两件输入**：

| 客户给什么 | 用途 |
|---|---|
| 控制台「资产详情」页**截图** | 结构：分组名/分组 ID/授权说明、逐行**缩略图**（判角度）、资源原始文件名、状态 |
| 从该页**复制的 ID 列表文本**（`asset-…` 每行一个） | **权威 ID**（截图小字不可靠：大模型会幻觉、本机 Vision OCR 也会把 `6r` 读成 `гq`；由 **Agent 读图后转成文本**再喂给 CLI，程序不直接吃截图） |

```bash
# ① 清单对账（客户截图/导出/粘贴文本 → 主档 referenceAssets/portraitSet 对平；默认 dry-run）
pnpm exec tsx scripts/tools/real-person-assets.mts reconcile \
  --asset asset-xxxxxxxx --from <清单文件.txt|json> --apply --label "客户控制台资产详情页截图"

# ② 两段式出定妆照（第一段视频路出身份母版；第二段图生图出其余角度；逐张机器像不像校验）
pnpm exec tsx scripts/tools/portrait-set-from-asset.mts \
  --asset asset://asset-xxxxxxxx --character <角色ID> --library <角色库> \
  --out-dir <角色目录>/portraits/_derived --angles front,threeQuarter,closeup,side \
  --engine two-stage --stage-a-angles front --refs 2 \
  --verify-against <已验收成片帧.jpg> --install --activate
```

> 角度映射由 **Agent 读截图缩略图**给出（标 `angleGuess`，属"机器/Agent 判读、非客户逐张确认"）；
> 平台侧权威清单只提供 ID 与文件名，**不猜角度**——两者分工不要混。

四条硬经验（真机实测，别再踩）：
1. **图端点不吃 `asset://`**（400 `invalid url`）——asset 参考只能走**视频端点**取首帧；
2. **参考图 2 张最好**（角度对应那张 + 主素材）；4 张不同服装/光位混投会让脸跑偏；
3. **主素材可能是古装/生活照**（本例就是古装照）——提示词必须显式绑定"现代商务造型 + 禁古装/汉服/影楼"；
4. **像不像必须机器判**（对已验收成片帧），不指望客户/人工确认；判不过**整批拒绝**，不装半套。
