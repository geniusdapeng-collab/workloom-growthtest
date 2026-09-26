---
name: compositor-designer
version: 1.0.0
description: 视觉素材生产工艺（Mac 视觉工位官方套件）：设计配方→Compositor 工程(.comp)→多规格 PNG/JPEG→回执校验。绑定 G-VIS1..G-VIS4；卸载即撤销。
---

# 视觉素材生产工艺（Compositor 视觉工位）

## 适用场景

- 短视频封面/首图、图文平台多规格构图（同一文案不同版式与尺寸）
- 投流图文变体（换背景/换配色/换主体位置，不改事实）
- GEO 信源配图（参数对比图、实体锚点图、清单图）
- 品牌素材复用（品牌色板、LOGO 安全区、版式配方沉淀为一客一档资产）

## 分工（先分清谁做什么）

| 环节 | 谁做 | 说明 |
|---|---|---|
| 版式/文案/规格决策 | 本岗位（视觉设计师） | 读品牌实体卡与脚本成套包，产出设计配方 `design_recipe` |
| 文案与标题排版 | 上游文字预渲染（`visualwrite.text`） | Compositor 无文字层（上游 issue #1），文字先渲染为透明 PNG 再作为图层合成 |
| 图像精修/合成/蒙版/去背 | Compositor 视觉工位（`visualwrite.compose`） | 复用上游 `ProjectStore`/`ImageExporter`/`LayerRenderer` 渲染内核 |
| 成品校验 | `visualread.verify` | 尺寸、字节数、SHA-256 逐项核对 |
| 外发 | 发布岗位 | 走 G9 / G-GEO1 必审，本岗位不直接外发 |

## 步骤

1. **读输入**：脚本成套包（标题/卖点/实体锚点）+ 品牌实体卡（confirmed 字段）+ 平台规格；
2. **出配方**：`design_recipe` 固定字段——画布尺寸、图层清单（底图/主体/文字 PNG/装饰）、每层位置尺寸与混合模式、蒙版来源、导出规格；配方入 `render_job` 事件；
3. **配文字**：标题、价格、CTA、免责声明分别调用 `visualwrite.text` 生成透明 PNG；文案与实体卡逐字一致，禁止改写事实；
4. **合成渲染**：`visualwrite.compose` 输出 `.comp` 工程 + PNG/JPEG 成品；工程文件与成品一并归档（工程是可复现的事实源）；
5. **校验**：`visualread.verify` 核对尺寸/哈希；无回执标「未核实」，不得宣称完成；
6. **回写**：成品与配方写入一客一档 `content_assets.visual_assets[]`，附审批引用。

## 输出契约

每张成品必须附：

```json
{
  "asset_uri": "file:///…/cover-3x4.png",
  "sha256": "…",
  "width": 1242, "height": 1660,
  "platform": "xiaohongshu-cover",
  "recipe_id": "recipe-…",
  "project_uri": "file:///…/cover-3x4.comp",
  "source_assets": ["…"],
  "qc": { "dimensions": true, "alpha": true, "brand_color": true },
  "receipt": { "synced": true, "verified_at": "…", "snapshot_uri": "…" }
}
```

## 边界（什么不做）

- 不用 Compositor 做文字排版源（它没有文字层）；文字必须预渲染成 PNG；
- 不导出 PSD/SVG/CMYK 场景（上游不支持）；交付格式仅 PNG/JPEG、sRGB；
- 不跨越画布上限（单边 30000px、总量 1 亿像素）；
- 不改写事实性文案；极限词/未确认参数命中 G-VIS2 即阻断；
- 未过 G-VIS1 合规审的含人像/第三方素材不得进入生产渲染；
- 无回执不得进入发布队列（G-VIS5）。

## 依赖与权限声明

- 依赖：Compositor（MIT，pin 版本，见 `docs/visual-workstation.md`）+ Mac 视觉工位 bridge（`visualread.*` / `visualwrite.*` 工具面）；
- 工具白名单：`visualread.health`、`visualread.inspect`、`visualread.verify`、`visualwrite.compose`、`visualwrite.render`、`visualwrite.text`；
- 出站域：无（工位内网；客户素材不出租户域）；
- 建议围栏参数：`dailyRenderCap=50`、`portraitRequiresApproval=true`、`thirdPartyAssetRequiresApproval=true`、`forbiddenClaimAction=block`、`noReceiptNoPublish=true`。

## 工艺判据（条件 → 做法 → 判据 → 来源）

| 条件 | 做法 | 判据 | 来源 |
|---|---|---|---|
| 干净配方 + 本地可逆渲染 | `visualwrite.compose/render/text` 直通 | G-VIS0 = auto（不需要人审） | KB:`fences/geo-growth-visual.yml#G-VIS0` |
| 含真人肖像或客户未授权第三方素材 | 先走合规审再渲染 | G-VIS1 = review；证据随配方归档 | KB:`#G-VIS1` |
| 文字含极限词/医疗金融承诺 | 文字预渲染前拦截 | G-VIS2 = **block**（国家级/世界级/第一品牌/100%/永久/根治/治愈） | KB:`#G-VIS2` |
| 单租户当日渲染量 | 达 50 张即熔断 | G-VIS3 = **block**（`context.daily_rendered >= 50`） | KB:`#G-VIS3` |
| 首次使用或变更后的版式配方 | 先人审再批量 | G-VIS4 = review（`recipe_status != 'approved'` 不得批量渲染） | KB:`#G-VIS4` |
| 成品外发 | 必须带渲染回执 | G-VIS5 = **block**（`visual_receipt_synced != true` 不进发布队列） | KB:`#G-VIS5` |
| AI 生图提示词含 真人/肖像/明星/代言/模特/商标/LOGO | 转人审 | G-VIS6 = review | KB:`#G-VIS6` |
| 画布与导出 | 单边 ≤30000px、总量 ≤1 亿像素；仅 PNG/JPEG + sRGB | 越界即拒绝导出 | KB:本套件 §边界 |

## 参数边界

1. 文字必须**预渲染为透明 PNG** 再合成：本工位没有文字层（上游 issue #1），把文字直接交给 Compositor 判交付失败。
2. 交付格式仅 PNG/JPEG + sRGB；PSD/SVG/CMYK 一律不支持，遇到即如实报"超出交付口径"。
3. 画布上限：单边 30000px、总量 1 亿像素；超限拒绝导出。
4. 单租户日渲染上限 50 张（G-VIS3），超限熔断并告警，上调须人审。
5. 未过 G-VIS1 的含人像/第三方素材**不得进入生产渲染**；未过 G-VIS4 的配方不得批量渲染。
6. 无回执（sha256/尺寸/时间戳）不得进入发布队列（G-VIS5）。

## 失败模式（症状 → 检测器 → 处置）

| 症状 | 检测器 | 处置 |
|---|---|---|
| 文字没渲染上/糊成一块 | `visualread.verify` 尺寸与图层核对 + 文字 PNG 在位检查 | 回 `visualwrite.text` 重出透明 PNG 再合成 |
| 导出尺寸与平台规格不符 | `visualread.verify` 宽高比对 `platform-specs.json` | 按规格重出；未核对条目只能内部预览 |
| 成品无回执就进了发布队列 | G-VIS5（`visual_receipt_synced`） | 阻断外发，补回执（含 sha256）后再提交 |
| 未审配方被批量使用 | G-VIS4（`recipe_status`） | 阻断批量渲染，走人审置 `approved` |
| 含肖像/第三方素材未过审 | G-VIS1（`has_portrait`/`has_third_party_asset`） | 阻断并补授权证据，再渲染 |
| 达到日配额仍继续渲染 | G-VIS3（`daily_rendered`） | 熔断并告警，转次日或申请上调 |
