# FC-BGM-004 curated 兜底曲库逐首上游许可缺失——"所有者声明"的合规敞口

| 字段 | 内容 |
|---|---|
| 编号 | FC-BGM-004 |
| 发现日期 | 历史遗留（bgm-library-curated/README.md 标注"待产品所有者确认"） |
| 严重度 | 中 |
| 状态 | 处置中（待产品所有者确认再分发条款） |

## 症状

随仓兜底曲库（50 首，bundles/ai-video/library/bgm-library-curated/）登记许可为 `royalty-free`，依据仅为"产品所有者声明可直接商用"——**素材包内未见逐首上游许可文件**。若这批曲目的授权条款只允许"使用"而不允许"随仓再分发"，当前随开源仓分发 60s 选段的行为存在合规敞口；客户商用交付引用这批曲目时也无法逐首自证。

## 检测器

- 逐首回溯：`curation-report.json` 的 `sourceIndex` 与 `sourceFile` 字段（每首可回溯到原始文件）；对照原始素材包 `~/Downloads/1200可商用纯音乐` 检查是否存在逐首许可文件。
- 入库判据：`tracks.json` 中 `license=royalty-free` 且 `licenseSource` 仅为所有者声明、无上游许可文件路径的曲目即属敞口清单。
- 白名单口径（bgm-library-license/SKILL.md 第二节）：`royalty-free` 可商用但"以平台条款为准（留存订单/授权号）"——无订单/授权号即证据缺口。

## 根因

- `bundles/ai-video/library/bgm-library-curated/README.md:13`：许可行明确写"产品所有者提供的可商用纯音乐包（1200可商用纯音乐）：所有者声明可直接商用；**包内未见逐首上游许可文件，按所有者声明登记为 royalty-free**"。
- 同文件 README.md:50-52："待产品所有者确认的一点：素材包内没有逐首上游许可文件……若这批曲目的授权条款不允许再分发（例如仅允许'使用'而不允许随仓分发），请把本目录改为私有存放或只保留索引。"
- 制度上 `royalty-free` 的放行条件是"以平台条款为准（留存订单/授权号）"，而本批曲目没有订单/授权号可留存——声明替代了证据。

## 处置

- 当前处置：README 显著标注风险与回溯路径；每首选段保留 `sourceIndex`/`sourceFile` 可追溯；选曲口径、增益、结构证据全部落在 `curation-report.json` 可复核。
- 待办（处置中）：产品所有者确认授权条款是否允许再分发——允许则补登记授权依据；不允许则本目录改私有存放或只保留索引（音频文件出仓）。

## 预防措施

- 曲库打标纪律（bgm-library-license/SKILL.md 一·四）：许可必须先声明且落在白名单，来源不明不许入册（围栏 G-BGM8）；`royalty-free` 入库须附订单号/授权号，不接受"口头声明"单独放行。
- 随仓分发前做逐首许可盘点：上游许可文件、平台条款截图、订单记录至少留一样进证据链。
- 交付侧回答"留证三问"（许可文件在哪/署名是否随片/谁何时核验），curated 库曲目用于客户交付时同步检查该曲是否仍在敞口清单。

## 关联

- 文档：`bundles/ai-video/library/bgm-library-curated/README.md:13, 50-52`（风险标注与待确认项）；`curation-report.json`（逐首回溯字段）
- 工具：`scripts/bgm-curate-library.mjs`（精选生成）、`bgm-cli tag`（打标入库，--license-note）
- SKILL 引用：`bgm-library-license/SKILL.md` 一·四（打标纪律）、第二节（royalty-free 口径）、第七节（留证）、第八节失败模式表"许可未标注/来源不明仍被使用"
- 围栏：G-BGM8（来源不明不许入册）、G-BGM1（新曲库首次入片人审）
