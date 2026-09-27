# SCORE-008 配乐链路常见事故案例库

> 配乐（BGM）链路历史事故的结构化失败案例库：每个真实事故一份案例文件（`failure-cases/FC-BGM-*.md`），
> 本文件是总览——机制说明、分类速查、实战用法、决策树与模板。
> 素材全部来自真实来源：git 历史（729be0a / 5288456 / 2e00caa）、代码注释（full-chain-film.mts / brief.mjs / core.mjs）、
> SKILL 文档（bgm-score-design / bgm-library-license / bgm-audio-layering）、curated 库 README。

## 一、核心概念

**失败案例库机制**：事故复盘 → 结构化入库 → SKILL 失败模式表引用编号，三段闭环。

1. **事故复盘**：真机事故发生后，先修代码/流程，再把"症状、检测器、根因、处置、预防"五要素复盘清楚。复盘素材只认一手来源——git 提交（`git show <hash>`）、代码注释（事故日期与真机参数）、SKILL 文档失败模式表、库 README 风险标注。查不到的日期不编造，写"历史遗留"。
2. **结构化入库**：每个事故一份案例文件，放 `bundles/ai-video/library/bgm-kb/failure-cases/`，命名 `FC-BGM-{三位序号}-{简述}.md`，统一模板（见第七章）。编号永不复用，修复后案例保留作回归依据。
3. **引用回链**：SKILL 失败模式表、审计器判据、roadmap 任务用 `FC-BGM-xxx` 编号引用案例；案例的"关联"节反向挂提交 hash、SKILL 章节、任务号（如 T-05、T-2026-0924-0001）。双向可追。

**配乐链路的四类事故源头**（本库案例全覆盖）：

| 源头 | 含义 | 代表案例 |
|---|---|---|
| 打分/择优失真 | 自动选曲维度权重设计缺陷，错配曲目胜出 | FC-BGM-001 |
| 信号处理事故 | 对齐/混音算法副作用破坏听感 | FC-BGM-002、FC-BGM-006 |
| 许可合规敞口 | 三层许可混同、证据缺失 | FC-BGM-003、FC-BGM-004 |
| 兜底路径失控 | 降级产物质次、静默降级 | FC-BGM-005 |

## 二、分类速查

按**症状第一眼特征**分四类，进决策树（第八章）前先在这里定位：

| 分类 | 第一眼症状 | 案例 |
|---|---|---|
| 选曲错配 | 曲风与片子题材/情绪明显不符 | FC-BGM-001 |
| 听不见/听不清 | 前段无音乐、配了跟没配一样、音乐盖人声 | FC-BGM-002、FC-BGM-006 |
| 许可风险 | 曲目许可说不清、AI 生成来源不明、署名缺失 | FC-BGM-003、FC-BGM-004 |
| 兜底异常 | 阶段记录出现 compose 路径、环节静默降级、产物质量骤降 | FC-BGM-005 |

## 三、分场景实战

**场景 1：自动选曲结果存疑（曲风不对）**
→ 查 evidence 回执 `match.reasons`，出现"题材未命中"且仍被选中 = FC-BGM-001。处置：**T-05 已落地（2026-09-27）**——题材未命中 −30 分、`genre_mismatch_policy=veto` 可直接出局；仍可 `-bgm-track <曲库 id>` 人工点名重跑（跳过自动择优，仍走混音/让位/响度/选段全套复检）。

**场景 2：成片前段听不到音乐**
→ `silencedetect`/astats 实测前 5s 电平；前段数字静音 = FC-BGM-002。已修复：确认走的是 `preroll-loop` 模式（回执 `section.preroll`），老产物用修复后版本重跑 bgm 段。

**场景 3：要用 AI 生成音乐或新曲源**
→ 先过 FC-BGM-003 三层许可核查（代码/权重/输出物）；NC/ND 一票否决（G-BGM5）；CC BY 系出 TASL 署名随片交付。

**场景 4：客户交付引用随仓兜底曲库（curated 50 首）**
→ 先查 FC-BGM-004：该批曲目按所有者声明登记 royalty-free、无逐首上游许可文件，属处置中敞口。交付前确认曲目是否在敞口清单，必要时换本地已核验曲目。

**场景 5：best 判 no_bgm_needed 但产品要配乐轨**
→ 走 FC-BGM-005 的曲库音乐床路径（`pickGridCompatibleBed`：BPM 60/120/240 ±5 硬过滤 + 纯器乐 + -28dB/16dB 让位）；禁止默认自算作曲；曲库无相容曲目则环节判失败并打标新曲。

**场景 6：回执出现可闻度不达标**
→ 分两种（FC-BGM-006）：`presenceBasis=none` 是"测不到"——调电平无用，改带人声间隙的素材或指定 section 复检；实测偏低才调电平/加深让位重跑。

## 四、视频特有规则

1. **成片必须带配乐轨是产品口径**，与工具质量口径（"人声太满可不配"）冲突时，由监制显式接管（--bgm-track 或曲库音乐床），并在阶段记录写明"监制决定"，不是工具自动结论。
2. **剪辑网格是配乐的事实依据**：卡点/BPM 反推必须用与 compose 同源的剪辑点（`--bpm-strategy cut-driven` + `--cut-times`），不允许从音轨起音猜切点——真机教训：网格被整片缩放时卡点命中 4/15；切点给对后误差 116ms → 0ms。
3. **任何对齐不得以前段留空为代价**：延后只能旋转循环（preroll），禁止 adelay 裸延后（FC-BGM-002）。
4. **口播片配乐三纪律**：默认不进打击乐（kick/hat 压句读）；音乐电平 -26dB 起、让位 13–16dB、人声余量 ≥6dB；音乐高潮不得对在台词最响处（高潮判据排除对白峰值）。
5. **指标空值不参与比较**：`null` 不进入"实测 vs 阈值"句式；测不到按「未核实」fail-closed 拒绝出片（FC-BGM-006）。
6. **许可先于下载**：不可商用一律拒收，绝不"先下后审"；署名文件（TASL）属交付物一部分。

## 五、常见误区

| 误区 | 正解 |
|---|---|
| "题材 0 分而已，总分高就行" | 题材必须负分降权（T-05 已落地：未命中 −30 / veto 出局）；"0 分不否决"正是 FC-BGM-001 的根因 |
| "把音乐床往后 delay 就能对齐高潮" | 前段数字静音（FC-BGM-002）；只能旋转预卷循环铺满 |
| "AI 生成的音乐没有版权问题" | 代码/权重/输出物三层许可独立（FC-BGM-003），MusicGen 权重 CC-BY-NC 禁商用 |
| "所有者说可商用就能随仓分发" | "使用"≠"再分发"；royalty-free 须留存订单/授权号（FC-BGM-004） |
| "没曲可用就现场合成一首" | 自算作曲默认禁用（FC-BGM-005）；降门槛也要从曲库选，否则环节判失败 |
| "可闻度不达标就降电平重试" | 先分"测得偏低"与"测不到"（presenceBasis），测不到调电平是白跑（FC-BGM-006） |

## 六、案例速查表

| 案例编号 | 症状关键词 | 检测器 | 处置 |
|---|---|---|---|
| FC-BGM-001 | 题材未命中仍被选中；运动曲配口播 | 回执 `match.reasons` 含"题材未命中"；修复前 brief.mjs 零分不否决 | 已修复（T-05）：未命中 −30、同族 +15、`veto` 可出局；仍可 `--bgm-track` 人工点名 |
| FC-BGM-002 | 前 25.7s 无音乐；数字静音 | preroll.test.ts；structure.test.ts 前 3s 残差 RMS > -40dBFS；回执 `section.preroll` | 已修复（729be0a）：相位预卷旋转循环，老产物重跑 bgm 段 |
| FC-BGM-003 | AI 生成音乐直接商用 | 三层许可核查表；G-BGM5 白名单（NC/ND 一票否决） | 已修复（制度）：默认自算合成+白名单 fail-closed；CC BY 出 TASL |
| FC-BGM-004 | royalty-free 仅有所有者声明 | `curation-report.json` 的 sourceIndex/sourceFile 回溯；无订单/授权号 | 处置中：待所有者确认再分发条款，否则改私有/只留索引 |
| FC-BGM-005 | 兜底自算作曲产出垃圾曲 | 阶段记录 `bgmVia=producer-compose+mix`；BPM 网格族硬过滤 | 已修复（5288456）：删默认自算作曲，改曲库音乐床；无相容曲判失败 |
| FC-BGM-006 | "nulldB < 3dB" 假比较；白跑重试 | 回执 `presenceBasis=none`；verify-message.test.ts | 已修复（2e00caa）：如实报无法测量 + retryable:false |

## 七、模板

新案例入库复制以下模板（存为 `failure-cases/FC-BGM-{序号}-{简述}.md`）：

```markdown
# FC-BGM-xxx <标题>

| 字段 | 内容 |
|---|---|
| 编号 | FC-BGM-xxx |
| 发现日期 | （git 提交日期，查不到就写"历史遗留"） |
| 严重度 | 高/中/低 |
| 状态 | 已修复 / 已列入 roadmap（任务号）/ 处置中 |

## 症状
## 检测器
（可执行的检查命令、工具名或判据——必须具体）
## 根因
（引用具体文件与代码位置）
## 处置
## 预防措施
## 关联
（提交 hash、SKILL.md 章节、roadmap 任务号）
```

入库纪律：素材只认一手来源（git 提交/代码注释/SKILL 文档/库 README）；检测器必须可执行或可判读；日期查不到写"历史遗留"，不编造。

## 八、决策树

```
发现配乐异常
│
├─ 听感异常
│   ├─ 前段/全程听不到音乐 ────────→ FC-BGM-002（查 preroll 回执；老产物重跑）
│   ├─ 配了跟没配一样/可闻度不达标 ─→ FC-BGM-006（看 presenceBasis：none→改素材；偏低→调电平）
│   └─ 音乐盖人声/听字不清 ────────→ SKILL 失败模式表：人声余量 ≥6dB、加深让位重跑
│
├─ 选曲异常
│   ├─ 曲风与题材明显不符 ─────────→ FC-BGM-001（回执查"题材未命中"；--bgm-track 点名重跑）
│   ├─ 卡点全乱/越听越漂 ──────────→ 检查 --bpm-strategy cut-driven 与 --cut-times 是否同源
│   └─ best 判 no_bgm_needed ──────→ FC-BGM-005（曲库音乐床；禁止默认自算作曲）
│
├─ 合规异常
│   ├─ AI 生成/新曲源要进交付 ─────→ FC-BGM-003（三层许可核查；G-BGM5 白名单；TASL 署名）
│   └─ curated 库曲目进客户交付 ───→ FC-BGM-004（查敞口清单；待所有者确认前优先换已核验曲）
│
└─ 流程异常
    ├─ 阶段记录出现 compose 路径 ──→ FC-BGM-005（确认显式 --allow-synth-bgm 且记录"监制决定"）
    └─ 环节静默降级/无失败原因 ────→ 改判失败 + 回执 attempts 写清每步原因
│
▼
查到案例 → 按案例"处置"节执行 → 修复后把新症状/新判据回写案例（或建新编号）
查不到案例 → 按第七章模板新入库 → SKILL 失败模式表引用新编号
```

## 九、关联知识

- **案例文件**：`bundles/ai-video/library/bgm-kb/failure-cases/FC-BGM-001..006-*.md`
- **SKILL 文档**：
  - `bundles/ai-video/skills/bgm-score-design/SKILL.md`——定调四问、选段决策链、失败模式表（8 条）
  - `bundles/ai-video/skills/bgm-library-license/SKILL.md`——许可白名单、AI 生成许可陷阱、留证纪律、失败模式表（8 条）
  - `bundles/ai-video/skills/bgm-audio-layering/SKILL.md`——可闻度 ≥3dB 硬闸（verify_failed 删产物）
- **关键代码**：
  - `bundles/ai-video/connectors/bgm-bridge/brief.mjs`（scoreTrackAgainstBrief 打分，:215-238）
  - `bundles/ai-video/connectors/bgm-bridge/core.mjs`（prerollPhaseSec :1203、旋转预卷 :1510-1540、explainMusicAudibility）
  - `bundles/ai-video/connectors/bgm-bridge/preroll.test.ts`、`verify-message.test.ts`、`structure.test.ts`（回归）
  - `scripts/tools/full-chain-film.mts`（--bgm-track :3341-3348、曲库音乐床 :145-160 & :3393-3444）
- **关键提交**：`729be0a`（前段静音修复）、`5288456`（去自算作曲）、`2e00caa`（可闻度假比较修复）
- **已落地修复**：T-05（题材未命中负分降权 + veto 策略 + 正反例词，2026-09-27）；关联任务：T-2026-0924-0001、T-2026-0924-0084
- **同类案例库**：`bundles/ai-video/library/color-kb/CGRADE-008-常见事故案例库.md` 与 `color-kb/failure-cases/FC-COL-*.md`（调色域同机制）
