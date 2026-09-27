# 角色档案库（人物资产）· **开箱即用的默认模特**

> 位置：`bundles/ai-video/library/characters/` ｜ 事实源：同目录 [`registry.json`](registry.json)
> **一句话：本仓自带 1 号模特「陈卓」，镜头卡里什么都不写时，视频管线会自动用它——你不需要先建角色、也不需要准备照片。**
> 另内置 **2 号模特「林予安」（`lin-yu-an`）**：原创虚构纯 AI 角色（纯文生图，非真人），**只在镜头卡点名时使用**，不改变 1 号默认绑定。

这套档案是**随仓分发**的（不是运行时才生成），克隆下来就在，`pnpm setup` 之后即可直接出片。

## 一、这里有什么

| 资产 | 说明 |
|---|---|
| [`registry.json`](registry.json) | **唯一事实源**：默认模特 `defaultModel`、姓名别名、档案路径、选角规则 |
| [`model-01-chen-zhuo/profile.json`](model-01-chen-zhuo/profile.json) | 档案正文：外貌/肤质/发型/服装基线/气质/口音/授权信息（`kind: authorized-real`） |
| `model-01-chen-zhuo/portraits/v3/*.png` | 定妆照集 **8 个角度**：front / threeQuarter / closeup / side / back / actionPose / emotionCloseup / handDetail |
| `model-01-chen-zhuo/gates.jsonl`、`reviews/*.json` | 定妆照门与监制评审留痕（**只增不改**，纠正用新记录） |
| [`model-02-lin-yu-an/profile.json`](model-02-lin-yu-an/profile.json) | **2 号模特林予安**档案正文（`kind: generated`，原创虚构 AI 角色，非真人、非 1 号替身） |
| `model-02-lin-yu-an/portraits/v1/*.jpg` | 林予安定妆照集 **8 个角度**（同上角度表，纯文生图，逐张过 `clean-background/v2` 背景闸） |
| `model-02-lin-yu-an/provenance.json` | 逐角度生成溯源：实际模型/创建时间/HTTP 请求 id、提示词摘要与 SHA-256、产物 SHA-256、自定义 ProduceID（**不是**平台 task_id；隐式水印未验证） |

> **在册资产（完整性索引）**：`registry.json` + 1 号 `profile.json` + `portraits/v3/` 的 8 张定妆照、
> 2 号 `profile.json` + `provenance.json` + `portraits/v1/` 的 8 张定妆照
> 已登记在 `bundles/ai-video/bundle.json#provides.library`，装载时校验 sha256（稳定包另验 Ed25519 签名）。
> **改动这 10 件必须在同一提交重算摘要**：`tsx scripts/bundle-governance.mts --refresh-digests`
> （稳定包另需 `BUNDLE_SIGNING_PRIVATE_KEY` / `BUNDLE_SIGNING_KEY_ID` 重签），否则行业包会装载失败。
> `gates.jsonl` / `reviews/*.json` / 本 README 刻意不入册（运行期账本与文档）。

## 二、选角规则（管线自动执行，无需配置）

1. 镜头卡/项目**显式指定**（`character` / `characters` / `portraits`）→ 用指定的；
2. 镜头卡里出现姓名或别名（`陈卓` / `卓卓`）→ 解析到本档案；
3. **都没写 → 自动使用 `registry.json#defaultModel`（陈卓）**，运行日志会打印
   `未显式指定模特 → 使用系统默认模特：陈卓（chen-zhuo，1 号）`；
4. 仍然没有 → 用库里第一个，并如实记录（不静默）。

多角色项目：写了姓名的按姓名解析，其余未指定角色才回落到默认模特。

## 三、怎么用（最省事的写法）

**镜头卡什么都不写**就已经在用陈卓；只想换造型/换人时才需要显式声明：

```json
{
  "shotId": "S01",
  "character": "陈卓",
  "costume": "月白色苏式改良旗袍（w1）",
  "composition": "竖版人物卡：陈卓中景居中偏右，头顶留白 8% 不裁发"
}
```

全链路出片工具**无需额外参数**就会装载本目录（`scripts/tools/full-chain-film.mts` 固定装载
`bundles/ai-video/library/characters/**`，再叠加 `--library` 指向的项目自有档案）：

```bash
tsx scripts/tools/full-chain-film.mts \
  --shots <镜头卡>.json --project VID-XXXX \
  --work-dir .vm-work --out outputs/VID-XXXX
```

## 四、加新模特 / 换默认模特

1. 新建 `model-02-<拼音>/`（`profile.json` + `portraits/vN/`，角度建议 ≥4：front / threeQuarter / closeup / side）；
2. 在 `registry.json#models` 追加一条（`ordinal` 递增、`aliases` 写中文名与常用称呼、`archive` 写仓库相对路径）；
3. 要改默认：把 `defaultModel` 指向新 id（**一次只有一个默认**）。

## 五、合规红线（不可绕过）

- **真人肖像只走平台授权通道**：火山方舟「私域真人人像库」→ 以 `asset://<asset ID>` 引用；
  直传真人照片会被平台隐私闸拦下（`InputImageSensitiveContentDetected.PrivacyInformation`），本仓不提供任何绕过手段。
- **原始照片不进仓库**：仓库内只放 AI 生成的定妆照与档案正文；原始素材留在本地（见 `docs/character-archive-design.md`）。
- 复用他人肖像/声音必须取得书面授权，并在 `profile.json.biography` 如实标注来源与授权范围。

## 六、相关入口

- 权威文档（规则 + 使用问答）：[`docs/character-registry.md`](../../../../docs/character-registry.md)
- 设计与数据模型：[`docs/character-archive-design.md`](../../../../docs/character-archive-design.md)
- 代码：`packages/video-studio/src/character-archive.ts`（档案库读写/选角）、`portrait-binding.ts`（参考图绑定与 `asset://` 透传）
- 自检：`node scripts/verify-builtin-character-assets.mjs`（内置角色资产与声明一致性）、`pnpm vitest run packages/video-studio`（选角/绑定单测）
