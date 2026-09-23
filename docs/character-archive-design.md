# 人物档案（角色资产）设计与调用链路 v1

> 状态：设计稿（2026-09-23）· 适用范围：AI 视频/漫剧出镜人物（1–10 人/项目）
> 定位：**人物档案是客户的核心资产**——一次建档、跨项目复用；生成链路自动解析、自动调用、可版本化、可审计。

## 〇、为什么需要它（现状问题）

- 现状只有"项目级定妆照索引"（`.vm-work/characters/<projectId>/portrait-index.json`），字段仅 `kind/id/name/dir/files`：
  **没有档案正文（外貌/性格/生平）、没有版本、没有授权信息、没有跨项目复用**。
- 真机事故（2026-09-23）暴露的两类问题都与此有关：① 定妆照"无档案描述"→ 生成出与设定无关的人；
  ② 渲染时"人物参考没被带上"→ 主角由文字瞎编。
- 客户会有 1–10 个出镜人物，必须做到：**建档一次 → 自动调用 → 改名/换造型可追溯 → 出片留痕**。

## 一、行业参考

| 来源 | 关键做法（可借鉴） | 证据等级 |
|---|---|---|
| 动画/漫剧工业的**角色设定集（character model sheet / character bible）** | 三视图 turnaround（正/侧/背/45°）、表情集（情绪九宫格）、姿态集、色卡与配色规范、身高比例图、服装与道具变体、面部特写、文字档案（性格/口音/习惯动作/关系） | B（行业通用做法；本机检索未取到权威中文漫剧专文，见"未核实声明"） |
| 火山方舟**私域真人人像库 / 虚拟人像库**（平台侧资产模型） | 素材（asset）+ 素材资产组（Asset Group）+ **授权与有效期**（接收/拒绝）+ 每次上传**一致性校验** + 生成时以 `asset://<assetId>` 引用；真人直传被拦，平台信任"同账号 30 天内模型产物" | A（官方文档原文） |
| 我们自己的 vendor 角度目录 | 角色按档位：**主角 8 角度 / 配角 4 / 客串 2**；商品 5 视角；渲染核心必需 4 角度 `front/threeQuarter/closeup/side` | A（`vendor/.../portrait-studio/angle-catalog.js`） |

> 未核实声明：中文"漫剧/AI 短剧"公开方法论（知乎/公众号等）本轮**未检索到可引用来源**（Bing 结果被无关站点污染）。
> 若需要，可另行离线收集；不影响本设计的骨架（它同时覆盖了动画工业与平台资产两侧的必备项）。

## 二、数据模型（v1）

### 2.1 角色档案 `profile.json`

```jsonc
{
  "schemaVersion": "workloom.character-profile/v1",
  "id": "pingjiang-presenter",          // 稳定标识（文件/索引/镜头卡都用它）
  "name": "平江路讲述人",                // 展示名（镜头卡可写中文名）
  "kind": "generated | authorized-real | virtual-preset",
  "identity":   { "gender": "female", "age": "三十岁上下", "height": "165cm", "occupation": "文化讲述人" },
  "appearance": { "face": "鹅蛋脸、眼神温和", "skin": "自然肤质、可见毛孔", "eyes": "深棕、有眼神光",
                  "hair": "齐肩微卷深棕", "features": ["左眉尾小痣"], "bodyType": "匀称" },
  "wardrobe":   [{ "id": "w1", "name": "黑色缎面吊带长裙", "detail": "珍珠细肩带", "scene": "日景/夜景通用" }],
  "persona":    { "tone": "松弛亲切", "speechRate": "3.5 字/秒", "accent": "普通话（可夹吴语腔）" },
  "biography":  ["1990 年代生于苏州…", "…"],          // 生平/小传（合成角色标注为虚构）
  "relations":  [{ "characterId": "nanyuan-manager", "relation": "同事" }],
  "voice":      { "ref": "voice://profile/xxx", "note": "配音工位音色档案（可选）" },
  "generation": { "stylePrompt": "专业人像摄影…", "negativePrompt": "CG/3D 渲染/卡通…", "model": "doubao-seedream-5-0-pro", "seed": 20260924 },
  "authorization": { "status": "synthetic-no-real-person | real-authorized",
                     "evidence": "assetGroupId / 承诺函编号", "expiresAt": "2027-03-01" },
  "portraitSets": [ { "version": 2, "dir": "portraits/v2", "angles": ["front","threeQuarter","closeup","side"],
                      "source": "pure-t2i | img2img | real-authorized", "createdAt": "…", "active": true } ],
  "tags": ["苏州", "旅游"], "createdAt": "…", "updatedAt": "…"
}
```

### 2.2 定妆照集 `portrait-sets/<version>.json`

一个角色可有多个定妆照集（v1 无角色档案的旧图 / v2 写实版 / 授权真人版…），字段：`version / angles / source / model / seed / prompt / assetsSha256 / createdAt / active`。
**只增不改**：换造型 = 新增 version；`portraitSets[].active` 决定默认调用哪一版。

### 2.3 项目绑定（复用而非拷贝）

项目侧只保存**引用**：`.vm-work/characters/<projectId>/portrait-index.json`
```jsonc
{ "characters": { "pingjiang-presenter": { "id": "pingjiang-presenter", "name": "平江路讲述人",
    "libraryRef": "var/media/characters/pingjiang-presenter", "pinnedVersion": 2,   // 缺省=跟随 active
    "files": { "front": "…/portraits/v2/pingjiang-presenter-front.png", "…": "…" } } } }
```

## 三、目录布局（P0：文件系统即库）

```
var/media/characters/<characterId>/           # 档案库（跨项目、长期资产）
  profile.json                                # 档案正文（含生平/授权/版本索引）
  portraits/v1/<name>-front.png …             # 定妆照集（多版本并存）
  portraits/v2/<name>-front-v2.png …
  portrait-sets/v1.json / v2.json             # 定妆照集元数据（模型/seed/提示词/sha256）
  portrait-index.json                          # 兼容现有工具：指向 active 版本
.vm-work/characters/<projectId>/portrait-index.json   # 项目绑定（引用 + pin 版本）
```

## 四、生成链路（五段）

```
①建档 → ②选角 → ③出镜 → ④更新 → ⑤治理
```

| 段 | 触发 | 动作 | 产物/留痕 |
|---|---|---|---|
| ① 建档 | 运营/客户录入或"建档任务" | 写 `stylePrompt`（写实口径）→ Seedream **文生图**逐角度出图（同 seed 保脸）→ 一致性复核 → 落 `portraits/v1` + `portrait-sets/v1.json` | 档案 + 定妆照集 + 生成参数 |
| ② 选角 | 剧本/镜头卡生成时 | 解析出场角色（`character` / `characters` / 台词 speaker）→ 映射 `characterId` → 绑定 `pinnedVersion`（默认 active） | 项目绑定 + 选角清单 |
| ③ 出镜 | 逐镜渲染前 | 按配额挑参考图（见 §5）→ 组装 content（人物 + 场景）→ 提交 → 记录"角色×版本×图 sha256" | `render_jobs.reference_images` 留痕 |
| ④ 更新 | 改档案/换造型/换授权 | 新增 `version+1`（旧版保留）→ **影响面分析**（哪些项目 pin 了旧版）→ 选择性重渲（`--only S1,S4`） | 版本 diff + 重渲清单 |
| ⑤ 治理 | 出片前/审计时 | 校验：授权有效期、来源（合成/真人）、`asset://` 是否有效；导出"人物使用清单" | 审计导出（谁、哪版、用在哪几支片） |

## 五、参考图配额与优先级（Seedance 单次上限 4 张）

| 场景 | 分配 |
|---|---|
| 单人出镜（对白/口播） | 主角 1 + 场景 3 |
| 双人对话 | 2 人各 1 + 场景 2 |
| 3 人及以上 | 出场顺序 × 台词权重取前 3 人各 1 + 场景 0–1 |
| 群像/远景 | 主角 1 + 场景 3（其余人物走文字描述） |
| 超过 3 人且需同框清晰 | 降级方案：Seedream 合成"同框定妆照"1 张占 1 个名额 |

优先级 = 主角 > 有台词 > 出场时长 > 是否近景。所有取舍**必须打印**（`🎭 S2 参考图：人物 2（张三/李四）+ 场景 2`），不静默。

## 六、工具面（P0 CLI / P1 tRPC）

```bash
# P0（本仓脚本）
node scripts/tools/character-archive.mts list
node scripts/tools/character-archive.mts show <characterId>
node scripts/tools/character-archive.mts bind --project VID-1023 --character pingjiang-presenter --pin 2
node scripts/tools/character-archive.mts impact --character pingjiang-presenter --from 1
# P1（服务端）：video.characters.list / .show / .create / .addPortraits / .update / .bind / .impact
```

## 七、与现有代码的衔接

| 现有件 | 改动 |
|---|---|
| `packages/video-studio/src/portrait-binding.ts` | 单角色 → **多角色**解析 + 配额分配（本 PR 已加 `allocateReferenceSlots`） |
| `packages/video-studio/src/portrait-runtime.ts` | 建档出图的执行器（要求角色档案；锚定可选） |
| `packages/video-studio/src/character-archive.ts`（新） | 档案库读写、版本管理、选角解析、影响面分析 |
| `scripts/tools/render-project.mts` | 调 `character-archive` 解析角色 → 逐镜打印实际下发的人物与版本 |
| `apps/server/src/video/studio-worker.ts` | 项目绑定的默认来源（库优先，`.vm-work` 兜底） |
| CMS 镜头卡 | `character`（单人）/`characters[]`（多人）都可；`presenterScript` 的 speaker 参与选角 |

## 八、分阶段落地

- **P0（本次落地）**：档案库文件结构 + `profile.json` v1 + 多角色解析 + 配额分配 + CLI（list/show/bind/impact）+ 留痕字段。
- **P1**：tRPC 工具面 + 建档 UI（三视图/表情集向导）+ 人脸一致性自动复核 + 版本影响面自动重渲。
- **P2**：真人授权素材（`asset://`）与合成角色统一抽象 + 跨项目复用统计 + 审计导出（人物使用清单）。

## 九、边界（本设计**不做**什么）

1. 不做人脸识别/身份比对（P0），不做跨租户共享；
2. 真人肖像只走平台授权通道（`asset://`），**不提供任何绕过审核的手段**；
3. 合成角色一律标注 `synthetic-no-real-person`，其"生平"标注为虚构；
4. 不做自动美颜（保持"未修图/自然肤质"口径，避免"一眼 AI"）。
