# 认证真人 → 专业定妆照：标准操作流程（SOP）

> 适用场景：客户在**火山方舟「私域人像库」**完成真人认证，只给了 `asset://…`（素材在**客户账号**里）。
> 目标：不打扰客户、不依赖人工确认，产出**可直接用于生成锚定的多角度专业定妆照**并写进角色档案。
> 本文是标准流程（任何客户通用）；`bundles/ai-video/README.md` §6/§6.1 是速查版。

## 0. 一句话流程

```
客户给一张「资产详情页截图」
   → Agent 读图：把「资源文件名 + asset-… ID」两列贴成文本（程序不直接吃截图）
   → real-person-assets.mts reconcile    # 清单对账：ID/分组/授权写进主档（不猜角度）
   → Agent 读缩略图：给出角度映射（标 angleGuess，机器/Agent 判读、非客户确认）
   → portrait-set-from-asset.mts         # 两段式出图 + 逐张机器像不像校验
   → portrait-set-install.mts            # 写角色档案 + 写后复核（fail-closed）
```

## 1. 输入（客户只需要给两样，通常一张截图就够）

| 输入 | 来源 | 用途 |
|---|---|---|
| 资产详情页**截图** | 客户控制台「资产详情」页 | 分组名/分组 ID/授权说明、逐行缩略图（判角度）、资源文件名、状态 |
| **ID 文本清单** | 从同一页复制（或 Agent 读图后转写） | 权威 `asset-…` 列表 |

> **为什么不让程序直接识别截图**：asset ID 是等宽小字——大模型视觉判读会**幻觉**出看起来合理的 ID，
> 本机 Vision OCR 也会把 `6r` 读成 `гq`（均实测）。因此**截图只作结构与缩略图来源，ID 以文本为准**。

## 2. 清单对账（写主档）

```bash
pnpm exec tsx scripts/tools/real-person-assets.mts reconcile \
  --asset <主素材 assetId> --from <清单文件.txt|json> --apply \
  --label "客户控制台资产详情页截图 2026-10-01"
```

- 清单支持：控制台复制文本（每行"文件名 + asset-…"或只有 asset-…）、JSON 数组/对象；
- **不猜角度**：新 ID 一律写"待客户确认"，写前备份 `profile.json.bak`，写后自检 + 打印管线实取前 3 张参考图；
- 真机教训：主档里 10 个 ID 有 8 个控制台查无 → 多参考图实际未生效 → 像不像不稳。**先对账再出图**。

## 3. 角度映射（Agent 判读，标来源）

Agent 看截图缩略图，把八个角度（front / threeQuarter / threeQuarterLeft / threeQuarterRight /
side / closeup / smileCloseup / frontFull）落到具体 assetId，写入主档 `portraitSet.assets[].angleGuess`
并标 `mappingEvidence`（截图 sha256 + 判读模型）。**这是机器/Agent 判读，不是客户逐张确认**——如实标注。

## 4. 出图（两段式 + 机器像不像校验）

```bash
pnpm exec tsx scripts/tools/portrait-set-from-asset.mts \
  --asset asset://<主素材> --character <角色ID> --library <角色库> \
  --out-dir <角色目录>/portraits/_derived \
  --angles front,threeQuarter,closeup,side \
  --engine two-stage --stage-a-angles front --refs 2 \
  --verify-against <已验收成片帧.jpg>        # 事实锚：该真人已通过验收的画面
  [--reuse-masters] [--install --activate]
```

| 环节 | 口径 |
|---|---|
| 第一段（身份母版） | **视频端点**是唯一吃 `asset://` 的通道（图端点 `image: asset://…` 400）；参考取「角度对应那张 + 主素材」共 **2 张**（4 张混投会把脸带偏，实测） |
| 第二段（其余角度） | 以母版为参考走**图端点 img2img**（2K、便宜）；当天端点 ECONNRESET 时**自动回退视频路** |
| 身份绑定 | 提示词必须显式写"与参考素材同一人"（**主素材常是古装/生活照**，实测）；造型只作**软性偏好**（现代商务优先）——真人本来就会换发型、戴品牌首饰衣物，**不作为不合格理由** |
| 机器像不像 | 逐张对「已验收成片帧」判"同一人"（judge 用 `LLM_*` 配置；`DEEPSEEK_BASE_URL` 是 anthropic 端点，拼 `/chat/completions` 会 404 假失败）；阈值 **`--min-likeness 88`**（客户口径：人脸一定要真）→ **任一不过整批拒绝，不装半套** |
| 断点续跑 | `--reuse-masters`：母版是最贵的一步，网络抖动不该重复烧钱 |
| **追加模式** | 后续补角度用 `--archive-refs <角色目录>`：新角度以**档案里已发布的定妆照**为参考（保人物与已发视频一致）；旧版本保留不覆盖 |

## 5. 装档（写后复核）

```bash
pnpm exec tsx scripts/tools/portrait-set-install.mts \
  --character <角色ID> --library <角色库> --from <出图目录> --mapping <mapping.json> \
  --source asset-derived --activate --out <报告.json>
```

校验（越界/非图片/缺必需角度/同图占多角度 → 拒绝）→ 不覆盖历史版本 → 写 `portraits/v<N>/source-map.json`
来源证据 → 更新 `profile.json`（`files` 精确指向 + 保留权威 `assets`）→ `verifyPortraitSet` **写后复核**（未过 exit 2）。

**身份基准照片（`--anchor`）**：把该真人**已通过验收的成片帧**传进来，installer 会拷进角色目录 `sources/` 并登记到该版本
`anchors`；`portrait-agent review` 靠它做"同一张脸"比对（不传就是"缺证据拒绝"，真机评分 45 被拦）。
评审阈值同样提高到 **`--min-score 88`**。

## 6. 与配音/字段的关系（旁白怎么承接）

- 25 字段规范里**没有**"旁白解说"字段：旁白由 **`dialogue`(台词) + `speechMode: "voice-over"`** 承接；
  `audio`(音频) 字段承载音频纪律（镜头内只允许台词人声/旁白/环境与动作音效，禁止画外配乐）。
- **不要新增字段**：字段表是 vendor 基线（`engines/field-standardizer.js`），新增会破坏 25 字段交付闸与全部审计口径。
- 音色：用 `--narration-profile <音色档>`；克隆档由 `voice-bridge register` 从**已验收成片里该真人的真实人声**登记
  （例：`demo-character-film`），默认内置档（`zh-xiaozhi`）音色机械，交付清单会如实记录用了哪一档。

## 7. 纪律清单（四条硬经验，别再踩）

1. 图端点**不吃** `asset://`（400）——asset 参考只能走视频端点取首帧；
2. 参考**2 张最优**；把不同服装/光位的 4 张混投会让脸跑偏；
3. 主素材可能是古装/生活照——造型只作**软性偏好**（"人脸是真的"是唯一硬标准；发型/服装/品牌/背景差异**不得**判不合格）；
4. 像不像**必须机器判**（对已验收成片帧，阈值 88），不指望客户/人工确认；判不过整批拒绝；
5. **追加不重来**：补角度用 `--archive-refs` 挂在已发布定妆照上，旧版本保留——保证客户平台上先后发布的视频人物一致。
