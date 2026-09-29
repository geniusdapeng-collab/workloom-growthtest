# 真实商品档案（product-archive）

> 任务卡：`T-2026-0929-0004`（档案机制）/ `T-2026-0929-0005`（多商品方案 PPT 导入）｜ 建立日期：2026-09-29 ｜ 适用包：`bundles/ai-video`
> 事实源：`packages/video-studio/src/product-archive.ts`（档案格式/优先级/校验/提示词口径）
> 执行器：`scripts/tools/product-archive.mts`（search / build / verify / list）
> 消费方：`scripts/tools/full-chain-film.mts`（镜头 `product` 绑定 + `g-product-ref` 门）

## 1. 需求（产品所有者原话 → 设计目标）

| 原话 | 设计目标 |
|---|---|
| "这是一个销售产品视频，里面的产品一定是要真实的产品" | 涉及具体公司/品牌的片子，产品镜**必须**绑定真实产品图；没有档案就**先检索建档**，不允许 AI 编产品 |
| "如果系统中有具体的商品档案就用商品档案里面的，或用户上传的商品图" | 档案库 `bundles/ai-video/library/products/`；客户上传档案 `priority=10` |
| "没有就自己加一道流程，通过搜索获得真实的商品图和商品档案信息…打上一个标记…优先级低于用户上传的" | `product-archive.mts search` 自动检索 + 抓图 + 建档，标记 `source.kind=system-generated`、`priority=1`、`reviewStatus=pending-owner-review` |
| "附件 PPT 是这家公司对外官方合作方案…是一个完整的多商品的系统性方案" | 档案子系统升级为**三层**：`company`（公司与品牌）/ `solution`（方案与套装）/ `product`（单个商品，可按型号点单）；官方 PPT 用 `import-pptx` 一次性拆成三层档案，并把每张图、每条参数的**幻灯片来源**登记进证据 |

## 2. 档案格式（`workloom.product-archive/v1`）

```jsonc
{
  "schemaVersion": "workloom.product-archive/v1",
  "id": "archive-id（=目录名，稳定身份）",
  "displayName": "商品名",
  "type": "product | solution | company",   // 三层档案；缺省 product
  "model": "DEMO-02",                        // 商品档案：型号，可用型号点单
  "variants": [{ "name": "立式机", "model": "DEMO-02" }],
  "relations": {
    "companyId": "示例企业",
    "products": ["demo-frontdesk", "demo-02"],       // company 档案用
    "includes": [{ "id": "demo-frontdesk", "role": "自助入住终端" }]  // solution 档案用
  },
  "company": "示例企业",
  "brand": "示例品牌",
  "aliases": ["别名、英文名、常用叫法"],
  "source": {
    "kind": "user-upload | system-generated",
    "priority": 10,
    "generatedAt": "2026-09-29T…Z",
    "generator": "scripts/tools/product-archive.mts@build",
    "reviewStatus": "owner-confirmed | pending-owner-review",
    "providedBy": "示例品牌智慧酒店生态产品解决方案.pptx（客户提供的对外合作方案 PPT）",
    "extraction": { "method": "pptx-slide-keyword-mapping", "verified": false, "note": "机器判定，请客户抽查" },
    "searchedQueries": ["系统档案必填：实际用过的检索词"],
    "evidence": [
      { "query": "…", "url": "来源页面", "title": "…", "site": "host" },
      { "query": "客户方案 PPT 第 3 页", "url": "pptx://方案.pptx#slide=3", "slide": 3, "slideTitle": "示例品牌 - 自助机产品介绍", "deckSha256": "…", "quote": "原文摘录" }
    ],
    "disclaimer": "系统档案必填：来自公开网页、授权与参数未核实"
  },
  "photos": [
    { "id": "hero", "file": "photos/01-front.jpg", "role": "hero", "sha256": "…", "bytes": 812345, "width": 1600, "height": 2400 }
  ],
  "specs": {
    "appearance": "只写能核实的可见外观",
    "features": ["可见结构"],
    "parameters": [{ "name": "型号", "value": "DEMO-02", "source": "slide 3" }],
    "notes": ["未核实参数不登记"]
  }
}
```

## 2.1 三层档案的分工（多商品方案）

| 层 | 档案 `type` | 装什么 | 图片策略 |
|---|---|---|---|
| 公司/品牌 | `company` | 品牌与别名、成员商品/方案索引、官方原件摘要（文件名 + sha256，原件不入仓） | 不强制图片 |
| 方案/套装 | `solution` | 方案定位、`relations.includes`（成员商品 + 角色）、整方案逐页证据 | 多商品页的素材（不硬塞给单个商品） |
| 商品 | `product` | 型号、参数（带 slide 来源）、可见外观、真实产品图 | **必须有图**（hero 主图必需），否则该商品档案不可用于出片 |

出片时镜头可以按 **id / 商品名 / 别名 / 公司 / 品牌 / 型号** 任一方式点单：
`{ "shotId": "SC-02", "product": "DEMO-02" }` 或 `{ "product": "示例品牌 AI 智慧前台（自助机 + 小程序）" }`。

## 3. 硬纪律（与产品不变量的关系）

1. **客户上传 > 系统检索**：`PRODUCT_ARCHIVE_SOURCE_PRIORITY = { "user-upload": 10, "system-generated": 1 }`（唯一事实源）。
   同名命中两份时必须按优先级取高；同优先级多档命中判**歧义**并要求显式 id——不猜、不覆盖客户档案。
2. **系统档案必须留痕**：缺 `searchedQueries` / `evidence[].url` / `disclaimer` / `reviewStatus=pending-owner-review` 任一，档案 **hard 不可用**（出片环节 fail-closed）。
3. **图片是事实**：必须真实存在、sha256 与登记一致、≥50KB、可解析宽高（<600px 长边给软提醒）；缺 hero 主图不可用；路径必须收在档案目录内（拒绝逃逸）。
4. **不做"忠实映射"以外的加工**：读不到的字段留空；检索页的宣传语不得当"已核实参数"写进档案。
5. **授权是客户的事**：系统档案的免责声明写明"版权/商用授权/参数准确性未经确认"；投放前必须由客户核对（与"高风险动作人审"同源）。
6. **没有档案不硬拍**：公司/品牌/商品在库里查不到 → 管线报错并给出建档命令；**不允许生成"长得像"的替代产品**。

## 4. 出片链路怎么绑定

```
shotlist.json ──(company/brand/products/shot.product)──▶ 档案解析（优先级）
      │                                                      │
      │ 未命中 → fail-closed（附建档命令）                     │ 命中
      ▼                                                      ▼
报错停止                                            绑定 hero 主图 → 该镜成为素材镜
                                                     （photo + materialUsage=generation-reference + focus）
                                                            │
                                   g-product-ref 门（step_key）记录：档案 id / 来源 / 优先级 / 主图 sha256
                                                            │
                                    material-gen 阶段：真实产品图作生成输入（G-MAT1 把关）
```

镜头卡写法：

```jsonc
{ "shotId": "SC-02", "product": "某品牌 自助入住机" }        // 自动绑定主图（无需手写 photo）
{ "shotId": "SC-03", "product": "某品牌 自助入住机", "photo": "./自有素材/正面.jpg", "materialUsage": "generation-reference" }
// ↑ 自带素材时不覆盖（bound=false），但仍受 g-product-ref 记账与 G-MAT1 判据约束
```

## 5. 真机证据（2026-09-29）

| 场景 | 命令 | 结果 |
|---|---|---|
| 检索相关性硬闸（**反例**） | `product-archive.mts search --name "示例品牌"` | 24 条结果全部与品牌无关 → **不建档**、退出码 2，提示改用客户照片（不拿别家产品冒充） |
| 检索到公开产品图 | `product-archive.mts search --name "携住科技"` | 命中官网 + 案例页，收 4 张真实产品图，生成 `system-generated` 档案（含来源页面与检索词），`verify` 无 hard 问题 |
| 客户上传优先 | `product-archive.mts build …` | 生成 `user-upload`（priority=10）档案；同名解析取客户档案 |
| **客户方案 PPT 导入** | `product-archive.mts import-pptx --file 示例品牌智慧酒店生态产品解决方案.pptx --company 示例企业 --brand 示例品牌` | 拆成 1 份公司档案 + 1 份方案档案 + 12 份商品档案；AI 前台 5 张真实产品图（来自 PPT 第 2/3 页）、桌型机 4 张、门锁/寄存柜/运营页各若干；每条参数与图片都带 `slide N` 来源；归属标记 `extraction.verified=false` |
| 出片绑定（真机） | `full-chain-film.mts … --stages cine-kb,micromotion,spec,material-gen,videos`（镜头写 `product`） | `G-PROD1 g-product-ref` 门通过（客户上传 priority=10），镜头自动变素材镜、绑定 hero 主图，`G-MAT1` 提交门通过；**渲染因平台账号欠费（403 AccountOverdueError）未出片**，充值后可直接续跑（产物与门记录都在 work-dir） |

## 6. 不做 / 留待后续

- **不做**：把检索图当"已授权素材"；用 AI 生成"同款产品"；在没有产品图时用占位图蒙混过关。
- **留待**：商详页结构化参数抓取（当前只登记可见外观与来源页）；1688/京东等平台的图文详情解析（需登录或反爬策略）；档案与媒资库 `media_product_profiles` 的双向同步（当前档案库是文件形态，服务端投影是发现面）。
- **边界**：中文 B2B 品牌大量没有公开官网（例如只在企查查/1688/展会页留痕），系统检索可能**抓不到可用产品图**——此时必须由客户提供照片；这条路径已在真机复现并如实失败。
