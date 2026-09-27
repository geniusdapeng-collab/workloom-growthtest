# 音乐许可合规速查（Music License Compliance）领域知识库

> **用途**：配乐知识库。供数字员工 / Agent 在为视频选曲、入库、署名、交付时检索调用。
> **主题编号**：SCORE-005　**版本**：v1.0　**更新日期**：2026-09-27
> **使用方式**：Agent 接收到涉及"配乐、BGM、背景音乐、无版权音乐、可商用音乐、AI 生成音乐"等意图时，检索本主题，先过许可闸再谈风格。**能不能商用，取决于许可，不取决于"是不是 AI 生成的"**。许可判定以 `core.mjs#LICENSE_TABLE` 与 `connectors/bgm-bridge/sources.mjs#normalizeLicense` 为唯一实现口径。

---

## 一、核心概念

### 1.1 许可合规是什么

许可合规是**配乐链路的第一道闸**——一首曲子再贴合题材、再卡点，许可不合规就是一票否决：

> **风格决定片子好不好看，许可决定片子能不能交。选错风格是返工，选错许可是事故。**

- **白名单许可**（CC0 / CC-BY / CC-BY-SA / royalty-free / self-generated）→ 可商用，按署名义务执行
- **NC / ND 系许可** → 商用一票否决（fail-closed）
- **未标注 / 来源不明** → 按不合规处理（fail-closed），没有"先用了再说"

同一个曲源里许可混杂（如 Jamendo、Freesound 逐曲不同），**必须逐曲判定**，不能按平台整体放行。

### 1.2 三层判定模型（Agent 核心心智）

任何一首候选曲，按三层依次过闸，任何一层不过即拒用：

| 层 | 判定问题 | 不过的后果 |
|---|---|---|
| **来源层** | 来源是否合法？（公开 API / 客户自建索引 / 本仓合成；不爬取、不绕鉴权） | `G-BGM7` 一票否决，阻断留痕 |
| **许可层** | `license` 归一后是否在白名单？（`normalizeLicense` → `commercialOk`） | `G-BGM5` 硬闸阻断，`license_blocked` |
| **署名层** | 需署名的曲目是否产出 TASL 文件并随片交付？ | 补署名后再交付，署名文件属交付物 |

### 1.3 fail-closed 总原则

**宁可 `no_bgm`，也不用存疑曲目。** 许可不明时默认拒绝，而不是默认放行。无曲可用的正确处置是如实回执 `no_bgm` 并写清原因（网络/未配置/许可不合规/无匹配），或走自算作曲兜底——而不是降低许可标准。

---

## 二、分类速查

### 2.1 许可类型速查表（核心）

| 许可 | 可商用 | 署名义务 | 改编限制 | 本仓白名单状态 |
|---|---|---|---|---|
| **CC0 1.0**（`cc0-1.0`） | ✅ | ❌ 无 | 无限制，可任意改编 | ✅ 允许 |
| **CC-BY 4.0**（`cc-by-4.0`） | ✅ | ✅ 必须 TASL 署名 | 可改编，须注明修改 | ✅ 允许 |
| **CC-BY-SA 4.0**（`cc-by-sa-4.0`） | ✅ | ✅ 必须 TASL 署名 | 可改编，但衍生作品须同许可分发（**会传染**） | ✅ 允许（注意传染） |
| **CC-BY-NC 4.0**（`cc-by-nc-4.0`） | ❌ | — | 非商业用途才可用 | ❌ fail-closed |
| **CC-BY-ND 4.0**（`cc-by-nd-4.0`） | ❌ | — | **禁止改编**——卡点选段即改编，天然冲突 | ❌ fail-closed |
| **CC-BY-NC-ND 4.0** | ❌ | — | 既非商业又禁改编，双重红线 | ❌ fail-closed |
| **royalty-free**（`royalty-free`） | ✅ | ❌ 通常无 | 以平台条款为准（留存订单/授权号） | ✅ 允许 |
| **self-generated**（`workloom-self-generated`） | ✅ | ❌ 无 | 本仓自算合成，无第三方权利 | ✅ 允许（默认兜底路径） |
| **版权音乐**（榜单热单/商业录音） | ❌ | — | 全权利保留，须另行购买授权 | ❌ 不入仓不交付（见 3.4 升级口径） |
| **未标注 / 来源不明** | ❌ | — | — | ❌ fail-closed，按不合规处理 |

### 2.2 为什么 NC 和 ND 必须 fail-closed（逐条讲透）

- **NC（非商业）与增长业务天然冲突**：本仓服务的是增长业务——广告、带货、品牌片、客户交付，全是商用场景。NC 许可在检索阶段就被过滤（只取 `commercialOk=true`），"个人用着玩没事"不是本仓场景。
- **ND（禁改编）与视频配乐的工作方式天然冲突**：配乐进片几乎必然涉及改编——**卡点选段是改编、循环铺满（`-stream_loop`）是改编、裁剪 60s 选段是改编、与画面混音对齐也是改编**。ND 曲目只要不原样完整播放就违约，视频配乐场景下等于不可用。
- **NC-ND 双重叠加**：既挡商用又挡改编，是 CC 系里最严格的许可，直接拒。
- **"未标注"视同不合规**：`normalizeLicense` 归一失败返回 `unknown`，`commercialOk` 对未知一律 `false`——与围栏 `G-BGM5` 同口径，绝不"先下后审"。

---

## 三、分场景实战

### 3.1 三级曲库的许可口径差异

| 级别 | 来源 | 许可口径 | 责任边界 |
|---|---|---|---|
| **在线源**（优先） | Jamendo / Freesound / Mubert / generic-http | 逐曲判定：`license_ccurl` / `license` 字段归一后过白名单；Mubert 整源按 royalty-free + 合同登记 | 工位只检索/许可闸/下载缓存，下载前先判许可 |
| **客户库** | `WORKLOOM_BGM_LIBRARY_DIR` 指向的客户目录 + `tracks.json` | 客户登记、客户担责；工位只读已授权本地文件，**不下载、不转存** | 工位负责校验白名单与署名，许可真实性由客户保证 |
| **curated 库**（随仓兜底 50 首） | `owner-provided-pack:~/Downloads/1200可商用纯音乐` | 所有者声明可商用，登记为 `royalty-free`；**包内未见逐首上游许可文件** | 现存风险见 3.3 缓解措施 |

### 3.2 在线源各自特点（已核验口径）

- **Jamendo**（API v3.0，需 `JAMENDO_CLIENT_ID`）：官方区分 Non-Commercial / Commercial 两种计划，曲库内 CC 许可混杂；只接 Commercial 计划，许可取 `license_ccurl`，`audiodownload_allowed=true` 才可下载。
- **Freesound**（API v2，需 `FREESOUND_API_TOKEN`）：逐曲 `license` 字段，NC/ND 混杂必须自动过滤；拿到的是 previews（mp3 试听）。
- **Mubert**（商业 API v3，需 `MUBERT_CUSTOMER_ID` + `MUBERT_ACCESS_TOKEN`）：官方称生成音轨免版税可商用，整源登记 `royalty-free`；**必须留存合同/订单号作为授权证据**。
- **generic-http**（`WORKLOOM_BGM_ONLINE_ENDPOINT`）：客户自建索引契约，用于接已授权的商业曲库/CDN；许可由索引逐曲给出，工位归一判定。

### 3.3 curated 库的现存风险与缓解

- **风险**：所有者声明可商用，但**逐首上游许可缺失**——若授权条款不允许"再分发"（仅允许使用），随仓分发本身可能越界。
- **缓解**：每首 `licenseSource` 字段可回溯原始文件；`curation-report.json` 记录 `sourceIndex`/`sourceFile`；商用客户优先升级自带授权曲库（见 3.4）；若所有者确认不允许再分发，本目录改私有存放或只保留索引。

### 3.4 商用客户的加固口径（何时必须升级）

以下情形**必须**建议客户接入自带授权曲库（客户库或 generic-http 接已订阅商业库），不得依赖在线 CC 源或 curated 兜底：

1. 客户明确要求**特定商业热单/版权音乐**——唯一合法路径是客户购买授权后入库；
2. 品牌方/投放平台要求**提供完整授权链证据**（订单号、授权书）——CC 曲与所有者声明不满足审计要求；
3. 交付物面向**大规模付费投放或转授权**场景——需要无传染、无再分发疑义的合同级授权；
4. 客户所在行业有**合规审计**要求（金融、医疗、上市品牌）。

---

## 四、视频特有规则

1. **卡点选段 = 改编**：视频配乐几乎必然裁剪、循环、混音，ND 许可一票否决不是保守，是工作方式决定的（见 2.2）。
2. **署名文件随片走**：TASL 署名文件是交付物的一部分，随成片/发布文案一起交付，不能只留在工位。漏署名 = 许可违约，等同未授权使用。
3. **CC-BY-SA 的传染性要在交付前讲清**：衍生作品须同许可分发。客户不接受成片音乐部分被 SA 传染时，换 CC0 / CC-BY / royalty-free。
4. **多段拼接多首曲时逐首署名**：每条曲目独立过许可闸，署名文件逐条登记，不能只署"最后一首"。
5. **中国古典曲目：曲谱公有领域 ≠ 录音可用**：《春江花月夜》这类曲谱虽属公有领域，但录音带表演者与录音制作者权——必须走 CC0/CC-BY 或已授权曲源，不随手抓录音。

---

## 五、常见误区

| 误区 | 纠正 |
|---|---|
| "AI 生成的音乐没有版权风险" | 错。**模型可商用 ≠ 权重可商用 ≠ 输出可商用**，三层分开核查。MusicGen 代码 MIT 但权重 CC-BY-NC 4.0，商用交付不采用 |
| "网上能搜到 = 能免费用" | 能检索到只说明可访问，不说明可商用。许可逐曲判定，平台整体放行不成立 |
| "注明出处就能随便用" | 署名只是 CC-BY 系的义务之一，不替代许可本身。NC/ND 曲目署了名也不能商用 |
| "客户给的素材包默认都能用" | 客户给≠客户有权。`license` 必填且落在白名单才可入册，来源不明拒收（`G-BGM8`） |
| "曲子只用了 10 秒，算合理使用" | 本仓不做"合理使用"抗辩。商用交付一律走白名单，不留灰色地带 |
| "先发布，收到投诉再换曲" | 没有"先用了再说"。许可不明不得进商用交付，宁可 `no_bgm`（fail-closed） |
| "CC-BY-SA 和 CC-BY 一样" | 不一样。SA 要求衍生作品同许可分发，会传染到成片音乐部分，交付前必须告知客户 |
| "凭据写进配置文件方便复用" | 平台凭据只从环境变量/受控秘密存储读，不进文件、不进日志、不进事件，不回显 |

---

## 六、意图→参数映射表

> 规则：把用户的选曲意图翻译成**许可安全的检索参数**，先定许可通道，再定风格参数。

| 创作意图/场景 | 中文写法 | 英文关键词/参数 |
|---|---|---|
| 要欧美流行感（非热单） | 欧美流行风格的 CC 曲目，不是榜单热单 | `catalog=western-pop`（Jamendo tags: pop/dance/electronic） |
| 要中国古典/国风 | 古筝二胡琵琶笛箫，走 CC 或已授权录音 | `catalog=chinese-classical`（guzheng erhu pipa dizi） |
| 要影视配乐感 | 管弦/氛围/推进的影视配乐 | `catalog=cinematic-score`（soundtrack/classical/cinematic） |
| 指定要某首商业热单 | 必须客户自带授权，接已授权商业曲库 | `generic-http` 指客户自建索引 / `WORKLOOM_BGM_LIBRARY_DIR` |
| 不想联网、要可商用兜底 | 用随仓兜底曲库，所有者声明 royalty-free | `bgmread.library` → curated 库（licenseSource 可回溯） |
| 要绝对无第三方权利 | 自算作曲，无署名义务 | `bgmwrite.compose`（`workloom-self-generated`） |
| 用了 CC-BY 曲目 | 出 TASL 署名文件随片交付 | `bgmwrite.mix attribution_out=CREDITS.md` |
| 许可不明的候选曲 | 拒用，如实回执无配乐 | `no_bgm` + `license_blocked`（fail-closed） |
| 素材包要入册打标 | 许可先声明，低置信要人审 | `bgm-cli tag --license <白名单值>`（`G-BGM8`/`G-BGM9`） |
| 曲库文件夹搬了家 | 重新绑定，三态如实回报 | `bgm-cli library --pack` → rebind `verify=size/sha256` |

---

## 七、模板

### 7.1 TASL 署名文件模板（`CREDITS.md`，随片交付）

```markdown
# 音乐署名（Music Credits）

本交付物使用了以下需署名音乐曲目，按 Creative Commons 许可要求署名（TASL 格式）。

## 曲目清单

1. "曲名（Title）" — 作者（Author） · 来源链接（Source） · 许可（License）
   "Kingdom of Dreams_Looping" — Eric Matyas · https://example.org/track/183 · CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)

2. "曲名（Title）" — 作者（Author） · 来源链接（Source） · 许可（License）

## 核验记录

- 许可核验人 / 日期：<姓名 / YYYY-MM-DD>
- 授权证据（royalty-free 曲目填订单/授权号）：<订单号或"CC 许可无需订单">
- 署名文件生成方式：bgmwrite.mix attribution_out=CREDITS.md（或 bgmread.library --attribution-out）
```

### 7.2 许可合规回执要点模板（写进 `bgm_report`）

```
license: <归一后的白名单 key>
licenseSource: <来源标识，如 owner-provided-pack:... 或 jamendo>
attribution: <CREDITS.md 路径或 null>
attempts: [在线→本地→自算作曲每一步的结果与失败原因]
```

---

## 八、决策树

```
拿到一首候选曲
  │
  ├─ 来源合法？（公开 API / 客户自建索引 / 本仓合成）
  │     └─ 否（爬取/绕鉴权）→ G-BGM7 一票否决，阻断留痕
  │
  ├─ license 归一（normalizeLicense）
  │     ├─ unknown / 未标注 → fail-closed 拒收（license_blocked）
  │     ├─ NC / ND / NC-ND → fail-closed 拒收
  │     └─ 白名单（cc0 / cc-by / cc-by-sa / royalty-free / self-generated）
  │
  ├─ 需署名？（cc-by / cc-by-sa）
  │     ├─ 是 → 出 TASL 署名文件（attribution_out=CREDITS.md），随片交付
  │     │        └─ SA 附加：告知客户衍生作品同许可分发义务
  │     └─ 否 → 留授权证据（royalty-free 留存订单号；self-generated 无需）
  │
  ├─ 入库 / 交付
  │     ├─ licenseSource 字段随曲目登记（打标/搬家/rebind 不丢）
  │     ├─ 新曲库首次入片 → G-BGM1 人审
  │     └─ 低置信（confidence.style=low）→ G-BGM9 人耳复核后交付
  │
  └─ 任何一步不过 → 拒用；无替代曲目时回执 no_bgm（绝不降标准）
```

---

## 九、关联知识

- **SCORE-002 风格决策**：先过本文许可闸，再按 SCORE-002 定风格——许可决定能不能用，风格决定好不好用，顺序不能反。
- **SCORE-008 事故案例库**：MusicGen 权重 CC-BY-NC 商用事故案例——"AI 生成"不等于无版权风险，三层核查的失败实录。
- **bgm-library-license SKILL**（`bundles/ai-video/skills/bgm-library-license/SKILL.md`）：本文的执行层——白名单口径、围栏 G-BGM0..G-BGM9、打标/搬家/rebind 纪律、catalog 三预设均以该 SKILL 与 `connectors/bgm-bridge/sources.mjs` 为唯一实现。

> 许可合规与选曲风格联合检索；涉及商用客户交付时，本文 3.4 加固口径优先于一切风格偏好。
