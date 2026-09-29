---
name: material-scout
version: 1.0.0
description: 素材寻源工艺：客户没有图时，从全球免费/开源图库检索合规素材（免 key 通道优先），核对授权与署名、下载入库并产出候选清单。
---

# 素材寻源（Material Scout）

## 触发
- brief 里 `assets_available` 为空或不足（客户无实拍图、只有文字）；
- 需要背景/场景/纹理/历史影像/插画等非产品素材；
- 需要为同一版式准备 3 个候选方向时。

## 图库策略（详见 `compositor-kit/templates/stock-sources.json`）

| 优先级 | 来源 | 授权 | 检索方式 |
|---|---|---|---|
| 1 | 客户实拍/视频抽帧 | 客户授权 | 本地素材库 |
| 2 | Wikimedia Commons / Openverse / The Met | CC0/PD 无义务；CC-BY 需署名 | **免 key API**（`visualread.search_stock`） |
| 3 | Unsplash / Pexels | 免费商用、无需署名 | CDN 已知 ID 直连；官方 API 可选 key |
| 4 | Pixabay / Smithsonian / NYPL / Europeana / Flickr Commons | 免费商用/公共领域（逐图核对） | 需免费 key；配置后可用 |
| 5 | StockSnap / Burst / Kaboompics / Rawpixel / unDraw / Openclipart | CC0 / 免费商用 | 站点检索（curated），人工挑选后 `fetch_stock` |

## 方法
1. **先搜后挑**：`visualread.search_stock` 用英文关键词（如 `pour over coffee barista`），`limit 8-12`，记录每个候选的 `license/attribution/source_page/尺寸`；
2. **筛选标准**：长边 ≥1600px、无平台水印、无文字水印、无未授权可识别人像、风格匹配 art-direction；
3. **授权核对**：CC0/PD 直接可用；CC-BY/CC-BY-SA 必须在成品或档案保留署名与来源页；
4. **入库**：`visualwrite.fetch_stock` 下载到租户 `assets/`，自动生成 `.license.json`（含 sha256、来源、授权、署名）；
5. **候选清单**：输出 `{candidates:[{id,url,license,attribution,score,notes}]}`，供设计岗位/客户选择；每次至少 3 个候选、2 个可用。

## 输出契约
- 候选清单 JSON + 已入库素材 + license sidecar；被拒候选写明原因（分辨率/水印/风格/授权）。

## 边界
- 不抓取禁止爬取的站点；不绕过反爬；不下载来源不明的图片；
- 不伪造来源、不删水印、不把 CC-BY 素材当 CC0 用；
- 图库解决"通用场景"，**产品本体仍应由客户实拍**——涉及产品细节时先向客户要图。

## 工艺判据（条件 → 做法 → 判据 → 来源）

| 条件 | 做法 | 判据 | 来源 |
|---|---|---|---|
| brief 缺素材 | 按图库优先级检索（客户实拍 > Wikimedia/Openverse/Met 免 key > Unsplash/Pexels > 需 key 源 > curated 站点） | 越级使用需写明理由 | KB:本套件 §图库策略 |
| 检索 | 英文关键词 + `limit 8–12`，逐条记录 `license/attribution/source_page/尺寸` | 记录不全的候选不得进入候选清单 | KB:本套件 §方法 1 |
| 筛选 | 长边 ≥1600px、无水印、无可识别人像、风格匹配 art-direction | 四项任一不满足即剔除 | KB:本套件 §方法 2 |
| 授权核对 | CC0/PD 直接可用；CC-BY/CC-BY-SA 必须保留署名与来源页 | 缺署名的候选不得交付 | KB:本套件 §方法 3 |
| 入库 | `visualwrite.fetch_stock` + 自动生成 `.license.json`（含 sha256/来源/授权/署名） | 无 sidecar 不得进配方 | KB:本套件 §方法 4 |
| 候选数量 | 每次至少 3 个候选、2 个可用 | 不足即继续检索或如实报缺口 | KB:本套件 §方法 5 |
| 产品本体 | 必须客户实拍 | 涉及产品细节用图库图 → 判不合格 | KB:本套件 §边界 |

## 参数边界

1. 候选素材长边 **≥1600px**；低于此值不得作为主视觉候选。
2. 每次交付 **≥3 个候选、≥2 个可用**；被拒候选必须写明原因（分辨率/水印/风格/授权）。
3. CC-BY/CC-BY-SA 素材**必须随成品保留署名与来源页**；不得当 CC0 用。
4. **产品本体不使用图库素材**（必须客户实拍）；图库只解决通用场景。
5. 不抓取禁爬站点、不绕过反爬、不删水印、不伪造来源；违规即整批作废。

## 失败模式（症状 → 检测器 → 处置）

| 症状 | 检测器 | 处置 |
|---|---|---|
| 候选没凑够 3 个就交付 | 候选数量检查 | 继续检索或如实报"素材缺口"，不得凑数 |
| 下载了带水印/长边不足的图 | 尺寸与水印检查 | 剔除并重搜；不得裁掉水印充当无水印 |
| 用了 CC-BY 却未署名 | license sidecar 与交付物对照 | 补署名/来源页后再交付 |
| 产品细节用图库图冒充 | 素材用途检查（产品本体） | 改为客户实拍；无实拍则挂起等素材 |
| 来源不明图片进库 | `.license.json` 必填校验 | 删除该素材并记事故，禁止入库 |
| 检索不到合适素材却硬凑 | 候选可用性检查（<2 可用） | 如实报缺口，交 art-direction 改方向 |
