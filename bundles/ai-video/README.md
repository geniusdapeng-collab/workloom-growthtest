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

- 判据与口径：`packages/video-studio/src/pipeline-router.ts`；设计说明：`docs/video-pipeline-routing-and-dossier-2026-09-25.md`
- **营销片必需商品锚点**（商品名只能来自用户显式声明 / metadata / 模型抽取，**不许猜**）；
  商品档案放在 `bundles/ai-video/library/products/<档案>/`，G-PROD1 会逐镜校验真实商品绑定。
- 服务端派活（`apps/server/src/video/router.ts`）走的是同一条分流；CLI 侧以前没有入口，
  所以本补充了 `route-video.mts`。

## 1. 安装与环境（一次）

```bash
node -v            # >= 24
pnpm install
```

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
3. **配乐**：本机没有独立音轨签发者（`WORKLOOM_AUDIO_STEM_SIGNING_SECRET` 未配置）时，
   管线自动走**声明式直混** `--declared-program-mix`：本地无版权曲库直接可用，
   回执如实标注 `sourceAuthority=declared-unverified`、`stemsVerified=false`（不冒充签章分轨）。
   接入内部签发者后自动切回签章路径。
4. **不要手工做封面 / 手工混音绕过管线**：交付清单要能核对（`delivery-manifest.json` 里有
   `reviewPolicy` / `assembly` / 封面来源 / 各变体 sha256）。
5. **账户欠费**：`AccountOverdueError` 403 会拦住提交；**先充值**，不要连点重试。

## 5. 交付物与验收

交付目录（`--out`）应包含：`*-<实测时长>s-final.mp4`（母版，名称与实测时长一致）、
`subtitles/`（srt/ass/vtt + 清单）、`*-softsub.mp4`、变体 3 支 + 变体封面、
`*-cover.png`、`*-delivery-manifest.json`（sha256/变体差异/审核口径/组装声明）。
质量口径见 `docs/video-delivery-and-revision.md`；监制门设计见 `docs/producer-gate-design.md`。
