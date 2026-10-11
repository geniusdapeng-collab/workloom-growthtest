# 真实商品档案库（products/）

> 一句话：**涉及具体公司名或品牌名的片子，必须用这家公司/品牌的真实产品**；
> 客户上传的商品档案优先（`priority=10`），系统检索生成的档案次之（`priority=1`，带检索证据且标记"未经客户确认"）。

## 目录结构

```
bundles/ai-video/library/products/
  <archive-id>/
    profile.json          # 档案本体（schema: workloom.product-archive/v1）
    photos/               # 真实产品图（hero + 细节；禁止占位图）
    sources.json          # 系统检索档案的原始检索结果与抓图尝试记录（客户上传档案可无）
```

## 机动车 / 大件商品：多角度 + 真实尺寸（T-2026-1011-0001 硬要求）

真机事故（2026-10-11，张雪机车 820RR-RC 30s 品牌片）：只登记**一张侧前 45° 图**、且**没有任何真实尺寸**，
成片把重型机车渲染成"到人物腰部的玩具比例"，且全片缺少机车最标志性的**骑手与全盔**——
根因就是档案没给比例锚与使用规则。因此：

- `profile.json` 顶层必须写 `"category": "vehicle"`（机动车/大件载具）；
- `photos[]` 必须 **≥2 个不同角度**，逐张登记 `angle`：`front | three-quarter | side | rear | detail | action | top`；
  收集口径：**优先官网与主流媒体（含厂商新闻稿/官图）的多角度高清大图**，逐张记录来源页；
- `specs.dimensions` 至少登记 2 项真实尺寸：`lengthMm / widthMm / heightMm / seatHeightMm / wheelbaseMm / curbWeightKg`；
- 校验器对 `category=vehicle` **硬拦**缺角度或缺尺寸的档案（fail-closed，进不了出片链路）；
- 提示词侧自动带出：真实尺寸（比例锚）+ 已登记角度 + "行驶镜必须有骑手与全盔、禁止无人自行行驶"的使用规则。

## 两种来源

| 来源 | 生成方式 | priority | 必备字段 | 语义 |
|---|---|---|---|---|
| `user-upload` | 客户提供照片/资料后 `product-archive.mts build` | **10** | 照片 ≥1 张（hero 必需） | 已由客户确认，可直接用于投放 |
| `system-generated` | `product-archive.mts search`（检索公开网页自动建档） | **1** | 照片 ≥1 张 + `searchedQueries` + `evidence[].url` + `disclaimer` + `reviewStatus=pending-owner-review` | **未经客户确认**：外观、参数与素材授权都必须在投放前由客户核对 |

同名/同商品两份档案同时存在时，**客户上传优先**；同优先级命中多档会判歧义并列出候选（要求显式 id）。

## 出片时怎么用

镜头卡声明商品（id / 商品名 / 别名 / 公司 / 品牌任一即可）：

```jsonc
{ "shotId": "SC-02", "duration": 5, "product": "示例品牌 酒店自助入住机", "materialUsage": "generation-reference", "focus": { "x": 0.5, "y": 0.5 } }
```

- 该镜没有 `photo` 时，管线**自动绑定档案主图**（`role=hero`）并把它当**生成输入**（素材镜，G-MAT1 把关）；
- 管线同时把"外观以参考照片为准、不得改机身结构/按键布局/品牌标识"写进道具口径；
- 公司/品牌/商品在档案库中**查不到**时，管线 **fail-closed**，提示先建档——**不允许用 AI 编产品外观**。

## 常用命令

```bash
# 系统检索建档（免 API key，Bing HTML 检索 + 页面商品图抓取）
node_modules/.bin/tsx scripts/tools/product-archive.mts search --name "某品牌" --root bundles/ai-video/library/products

# 客户上传建档（优先档；客户给了照片就用这条）
node_modules/.bin/tsx scripts/tools/product-archive.mts build --name "某品牌 自助入住机" \
  --photo ~/Downloads/kiosk-front.jpg --photo ~/Downloads/kiosk-panel.jpg \
  --company "某公司" --brand "某品牌" --aliases "别名1,别名2" --specs specs.json

# 校验 / 列表
node_modules/.bin/tsx scripts/tools/product-archive.mts verify --root bundles/ai-video/library/products
node_modules/.bin/tsx scripts/tools/product-archive.mts list   --root bundles/ai-video/library/products
```

规则细节见 [`docs/product-archive.md`](../../../docs/product-archive.md)；
出片链路绑定逻辑见 `scripts/tools/full-chain-film.mts`（`g-product-ref` 门）与
`packages/video-studio/src/product-archive.ts`（唯一事实源）。
