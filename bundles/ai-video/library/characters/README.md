# 角色档案库（人物资产）· **开箱即用的默认模特**

> 位置：`bundles/ai-video/library/characters/` ｜ 事实源：同目录 [`registry.json`](registry.json)
> **一句话：本仓自带 1 号模特「陈卓」，镜头卡里什么都不写时，视频管线会自动用它——你不需要先建角色、也不需要准备照片。**
> 另内置 **2 号模特「林予安」（`lin-yu-an`）**：原创虚构纯 AI 角色（纯文生图，非真人），**只在镜头卡点名时使用**，不改变 1 号默认绑定。

这套档案是**随仓分发**的（不是运行时才生成），克隆下来就在，`pnpm setup` 之后即可直接出片。

**定妆照已由前置流程处理，当前在用版本默认可直接复用**（产品所有者 2026-10-07 明确口径）。人物发布合同优先使用
对应授权角色的已登记在用定妆照作为比对基准，出镜人物 无需再次提供真人原图；实际字节摘要、角色主档、版本和角度
一并留痕，来源标为 `registered-character-portrait`。这份来源代表已处理定妆照，不冒称平台认证原图；主素材授权、
角色对应关系与文件边界照常核验，本次视频生成首帧或任意临时图片不能代替已登记参考。外部客户没有对应定妆照时，
仍可选择其真人主档已登记的 `anchorPhoto`。

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
| [`model-03-demo-character/profile.json`](model-03-demo-character/profile.json) | **3 号「客户方CEO」**档案正文（`kind: authorized-real`，客户方 CEO；形象来自火山方舟私域真人人像库认证素材 `asset://asset-20260101000000-demo` 的**派生定妆照**） |
| `model-03-demo-character/portraits/v1/*.jpg` | 该角色定妆照集：**已验收 8 张**（front / threeQuarter / closeup / side ＋ frontFull / threeQuarterLeft / threeQuarterRight / smileCloseup） |
| `model-03-demo-character/reviews/*.json`、`gates.jsonl` | 评审与门留痕：**客户验收放行**（`via=owner-acceptance`）＋ 机器监制记录（只留证、不裁决） |
| `model-03-demo-character/provenance.json`、`portraits/v1/source-map.json` | 生成方式与逐角度溯源（含未生成角度的如实登记） |

> **3 号的待补角度（如实登记，不冒充齐备）**：标准 8 角度里的 `back / actionPose / emotionCloseup / handDetail`
> 尚未生成——2026-10-01 平台账户欠费（403 AccountOverdueError），充值后用
> `scripts/tools/portrait-set-from-asset.mts`（默认就是标准 8 角度）补出并装新版本即可。
>
> **在册资产（完整性索引）**：`registry.json` + 1 号 `profile.json` + `portraits/v3/` 的 8 张定妆照、
> 2 号 `profile.json` + `provenance.json` + `portraits/v1/` 的 8 张定妆照、
> 3 号 `profile.json` + `provenance.json` + `portraits/v1/source-map.json` + `portraits/v1/` 的 8 张定妆照
> 已登记在 `bundles/ai-video/bundle.json#provides.library`，装载时校验 sha256（稳定包另验 Ed25519 签名）。
> **改动这些在册文件必须在同一提交重算摘要**：`tsx scripts/bundle-governance.mts --refresh-digests`
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

## 四·一、认证真人「一次性出满 8 张定妆照」（客户零操作，2026-10-01 定为系统方案）

客户侧只有平台认证素材（`asset://<asset ID>`，本地没有原图、平台也没有下载接口）时，用**同一条命令**出满标准 8 角度：

```bash
tsx scripts/tools/portrait-set-from-asset.mts \
  --asset asset://asset-20260101000000-demo \
  --character <角色目录名> --library <角色库目录> \
  --out-dir <产物目录> --install --activate      # 去掉 --install 只出图；--dry-run 先看不花钱
```

**固定的四件事**：

1. **默认就是标准 8 角度**（front / threeQuarter / closeup / side / back / actionPose / emotionCloseup / handDetail）——
   出满即可直接入库（`builtin-character-library.test.ts` 会逐角度校验）；备选角度 `frontFull / threeQuarterLeft /
   threeQuarterRight / smileCloseup` 用 `--angles` 追加；
2. **整批只提交一次**：任一角度失败即整体失败（不装半套），账户欠费（403 `AccountOverdueError`）立即停并如实报告；
3. **装档走复核**：`portrait-set-install.mts` 写 `portraits/v<N>/` + `source-map.json`（逐角度 sha256 与来源），
   缺必需角度 / 同一张图指到多个角度 / 覆盖旧版本一律拒绝；
4. **评审决策交给人类**（产品所有者 2026-10-01 口径）：机器像不像判据**只留证、不参与放行**——它本身不稳定
   （同一批文件实测同一张图出现 92 / 15 / 86 三种结论）。验收用
   `portrait-agent.mts accept --character <id> --by <验收人> --note <依据>`，落账 `g5-portrait-confirm` 且
   `via=owner-acceptance`（**不写成监制通过**）；需要留机器证据时加 `--with-likeness`（仅记录）。

> 本仓 3 号「客户方CEO」就是这条路的产物：客户 2026-10-01 验收通过了 8 张（见该目录 `reviews/`）；
> 标准 8 角度里的 4 个（back / actionPose / emotionCloseup / handDetail）因平台欠费待补。

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
