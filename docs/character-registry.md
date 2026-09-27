# 内置角色库与默认模特 v1（2026-09-24）

> **一句话（先看这句）**：本仓**自带** 1 号模特「陈卓」（`chen-zhuo`）——角色档案、8 角度定妆照与默认选角规则
> 随仓分发（`bundles/ai-video/library/characters/`）。**镜头卡里什么都不写，出片链路就会自动用她**：
> 你不需要先建角色、准备照片，也不需要额外参数。
>
> 数据事实源：[`bundles/ai-video/library/characters/registry.json`](../bundles/ai-video/library/characters/registry.json)
> ｜ 目录内说明：[`bundles/ai-video/library/characters/README.md`](../bundles/ai-video/library/characters/README.md)

## 一、命名

- **1 号模特：陈卓（`chen-zhuo`）** — 系统默认模特。档案：`bundles/ai-video/library/characters/model-01-chen-zhuo/`
- **2 号模特：林予安（`lin-yu-an`）** — 内置**原创虚构纯 AI 角色**（`kind: generated`，非真人、非 1 号替身）。
  档案：`bundles/ai-video/library/characters/model-02-lin-yu-an/`；**只在镜头卡点名时使用**（`"character": "林予安"`），
  `defaultModel` 仍指向 1 号陈卓。8 张定妆照全部由官方 Seedream 5.0 pro **纯文本生成**（请求不含任何图片输入），
  逐角度证据见同目录 `provenance.json`：实际 `response.model`/`created`/HTTP `x-request-id`、提示词摘要与 SHA-256、
  产物 SHA-256、客户自定义 ProduceID。**该 ProduceID 是我们自定义的资源映射，不是平台 task_id；平台隐式水印未验证。**
  该套为**无 v2 收据链的历史口径**（同 1 号 v3 定妆照）：`portraitSets[0]` 不含逐角度 artifacts/angleRequests，
  因此 `loadCharacterEntry` 的核验 scope 是 `legacy-current-bytes-only`（按角度文件名 + 当前字节核验）。
- 档案正文含：外貌特征（照片提取）、服装基线、气质、授权信息、定妆照集（v3，8 角度，图生图 + 抠像友好背景硬闸）。
- **原始照片不进仓库**（仅本地保留）；仓库内只放 AI 生成的定妆照与档案正文。
- **2 号模特不是任何真人的数字化身**：生成时仅人工参考旧素材里可概括的一般五官词，未把旧图或真人原图作为图片输入；
  档案里不主张与任何真人身份等同。
- **在册资产（完整性索引）**：`registry.json`、`model-01-chen-zhuo/profile.json`、`model-01-chen-zhuo/portraits/v3/*.png`（8 张，
  合计 10 件）已登记在 `bundles/ai-video/bundle.json#provides.library`——装载时会校验 sha256，稳定包还会验 Ed25519 签名。
  因此**改动这些文件必须在同一提交里重算摘要**（`pnpm bundle:release` 或在仓内跑
  `tsx scripts/bundle-governance.mts --refresh-digests`，稳定包另需 `BUNDLE_SIGNING_PRIVATE_KEY` / `BUNDLE_SIGNING_KEY_ID`）。
  运行期账本（`gates.jsonl`、`reviews/*.json`）与目录说明 README **刻意不入册**——它们是追加写/文档，不入完整性索引。

## 二、选角规则（管线自动执行）

`bundles/ai-video/library/characters/registry.json` 是唯一事实源：

1. 项目/镜头卡**显式指定**模特 → 用指定的；
2. 镜头卡出现姓名或别名（`陈卓` / `卓卓`）→ 解析到该档案；
3. **都没指定 → 自动使用 `defaultModel`（陈卓）**，运行日志打印
   `未显式指定模特 → 使用系统默认模特：陈卓（chen-zhuo，1 号）`；
4. 仍无 → 用库里第一个，并如实记录（不静默）。

多角色项目：指定姓名的角色按姓名解析，其余未指定角色才回落到默认模特。

## 三、怎么加新模特

1. 目录：`bundles/ai-video/library/characters/model-02-<pinyin>/`（`profile.json` + `portraits/vN/`）；
2. 在 `registry.json#models` 追加一条（`ordinal` 递增、`aliases` 写中文名与常用称呼）；
3. 需要改默认模特时，把 `defaultModel` 指向新 id（一次只有一个默认）。

> 改了 `registry.json` 或档案后，出片链路**立刻生效**（`scripts/tools/full-chain-film.mts` 每轮直接读本目录）；
> 改动前请先跑 `node scripts/verify-builtin-character-assets.mjs`（校验默认模特可解析、四角度定妆照齐备、
> 默认声明在首页/文档/能力清单/目录说明四处同步）。

## 四、怎么用（三种写法）

```jsonc
// ① 最省事：什么都不写 → 自动使用陈卓（默认模特）
{ "shotId": "S01", "motion": "缓推近，保持主体完整" }

// ② 点名用她（也可写别名"卓卓"）→ 解析到同一档案
{ "shotId": "S02", "character": "陈卓", "costume": "月白色苏式改良旗袍（w1）" }

// ③ 多人出镜：写了名字的按名字解析，其余未指定角色回落到默认模特
{ "shotId": "S03", "characters": ["陈卓"], "composition": "中景偏右，留出标题安全区" }
```

命令行出片（`scripts/tools/full-chain-film.mts`）**无需额外参数**：它固定装载
`bundles/ai-video/library/characters/**`，再叠加 `--library` 指向的项目自有档案。

## 五、常见问题（新下载项目最常卡的三件事）

| 问题 | 答案 |
|---|---|
| 我拿到的项目里**有定妆照吗**？ | 有。`bundles/ai-video/library/characters/model-01-chen-zhuo/portraits/v3/` 里 8 个角度随仓分发，克隆即可用。 |
| 我要**先建角色**才能出片吗？ | 不用。不指定 `character` 时自动用默认模特；只有换人/加人时才需要建新档案。 |
| 为什么我"找不到定妆照"或生成的人不像？ | ① 别去 `var/media/characters`（那是**运行期**生成目录）；② 真人照片不能直传平台（要走 `asset://` 授权素材）；③ 参考图绑定见 `packages/video-studio/src/portrait-binding.ts`。 |
| 在哪里能看到这份声明？ | 本文件 · `bundles/ai-video/library/characters/README.md` · `bundles/ai-video/library/README.md` · `README.md`（能力速览自动生成块）· `docs/capability-map.md` · `docs/SYSTEM-OVERVIEW.md` · `.ai-prompt` · `AGENTS.repo.md`。 |

## 六、相关代码与门禁

| 关心的事 | 入口 |
|---|---|
| 档案库读写 / 选角解析 | `packages/video-studio/src/character-archive.ts` |
| 定妆照绑定与 `asset://` 授权素材透传 | `packages/video-studio/src/portrait-binding.ts` |
| 出片链路装载与默认模特日志 | `scripts/tools/full-chain-film.mts`（`loadCharacters` / `loadCharacterRegistry`） |
| 设计与数据模型 | `docs/character-archive-design.md` |
| 自检 | `node scripts/verify-builtin-character-assets.mjs`（资产 + 声明一致性，已接入 `.cnb.yml` static-gate） · `pnpm vitest run packages/video-studio` |
