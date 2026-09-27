# 人声与音乐协同电平口径（Dialogue–Music Level Discipline）领域知识库

> **用途**：AI 视频生成/后期系统的配乐知识库核心篇。供数字员工 / Agent 在回答"人声和音乐各定多响、谁给谁让位、让多少"时检索调用。
> **主题编号**：SCORE-001　**版本**：v1.0　**更新日期**：2026-09-27
> **使用方式**：Agent 接收到涉及"配乐盖过人声、音乐听不清、声音打架、响度不达标"等问题时，检索本主题，按第六章映射表与第八章决策树把创作意图翻译成电平与让位参数。**所有数值与 `library/bgm-recipes/recipes.json` 的 targets 及各 SKILL 真实参数一一对应；如有出入，以代码/recipes 为准。**

---

## 一、核心概念

### 1.1 三种"分贝"：dBFS / LUFS / dBTP 不是一回事

混音里天天出现的"dB"其实有三把尺子，量的是不同的东西，混用必然出错：

| 尺子 | 量什么 | 用途 | 本片库的典型值 |
|---|---|---|---|
| **dBFS**（相对满刻度） | 瞬时/平均采样电平，0 dBFS 是数字天花板 | 单轨电平：人声多响、音乐床多响 | 音乐床 musicLevelDb 区间 **[-30, -16] dBFS** |
| **LUFS**（感知响度） | 按人耳等响曲线加权的整体响度（EBU R128 算法） | 整条片子的"听起来多响"，跨平台对齐 | 成片 **-14 LUFS**（±1.5），即 recipes.json `lufsIntegrated [-15, -13]` |
| **dBTP**（真峰值） | 采样点之间插值出的真实峰值，防编码溢出 | 交付安全线 | **≤ -1.0 dBTP** |

关系速记：**dBFS 管单轨的"账"，LUFS 管整片的"听感"，dBTP 管编码的"安全"**。音乐床定在 -22 dBFS（dBFS 口径），整条成片收口在 -14 LUFS / -1.0 dBTP（R128 口径），两者不矛盾——一个是原料投放量，一个是出厂检验线。

### 1.2 为什么是 -14 LUFS / -1 dBTP

这是短视频/流媒体（抖音、小红书、视频号、B站、YouTube）的通用交付口径：平台对上传内容做响度归一化，交 -14 LUFS 的母版不会被平台再压一遍产生二次动态损失；真峰值留 1 dB 的 headroom，保证经过 AAC 等有损编码后仍不削波。工程实现用 **EBU R128 两遍法 loudnorm**：第一遍测（integrated / TP / LRA / threshold），第二遍带测量值套参应用，避免单遍法的动态漂移。注意一个工程细节：loudnorm 的 TP 是"上限"而非"保证值"，代码里实际按 `TP - 0.5dB`（即 -1.5 dBTP）设置余量，再由末尾实测复检 + 闭环整体下压（只减不增）兜底交付线 ≤ -1.0 dBTP。

### 1.3 人声优先总原则

> **人声是内容，音乐是气氛。观众听不清一个字，整条片子就失败了；观众听不到音乐，只是少了点精致度。**

两条感知红线把这句话量化：

- **dialogueToMusicMarginDb ≥ 6 dB**（人声-音乐余量）：语言可懂度主要依赖 200–4000Hz 频段的信噪比。音乐在该频段与人声的能量差达到 6 dB 以上时，正常听力人群在嘈杂外放环境（地铁、餐厅、开放办公室）下仍能听清每个字；低于 3 dB 时辅音开始被"糊住"，复检直接判失败。
- **musicPresenceDb ≥ 3 dB**（配乐可闻度）：BGM 也不能轻到听不见。口径是"无对白窗口中，配乐后相对原片的响度提升 ≥ 3 dB"。不足 3 dB 意味着"配了跟没配一样"，工具判 `verify_failed`、删除产物——宁可不做，不做假配。

这两条红线互为上下限，夹出了音乐床的合法活动空间：**音乐要响到能被听见，又要轻到永远不抢话**。所有配方参数都是在这个夹缝里取的最优解。

### 1.4 两次让位：本文的核心命题

一条有配音的成片会经历**两次让位**，发生在不同工位、作用于不同对象：

```
voice 工位（先）：配音/旁白混入时 → 原声（对白/现场声）让位一次
                                          │
                                          ▼ 产出已含"人声+让位后原声"的成片
bgm 工位（后）：BGM 混入时 → BGM 对人声频段做 sidechain ducking 再让位一次
```

**关键认知：两次让位不叠加在同一信号上。** 第一次压的是原声，第二次压的是音乐。人声本身从头到尾不被压缩——它是两次让位共同的"侧链键"。理解了这一点，"叠加过度"的真正风险才看得清楚（见第四章第 2 条）。

---

## 二、分类速查

### 2.1 四分层策略的电平含义

| policy | 声音床 | 音乐电平修正 | 让位深度修正 | 适用 | 纪律 |
|---|---|---|---|---|---|
| `keep-dialogue`（默认） | 原声全保留 | 按配方值（如 -26 dBFS） | 按配方值（8–14 dB） | 口播/访谈/带货 | 旁白与原声间另做 8–12 dB 让位（voice 工位） |
| `keep-all` | 原声全保留，含环境声 | **配方值再降 3 dB** | **× 0.6**（更浅） | 纪录片/现场感强的片子 | voice 工位对原声只做 3–6 dB 浅让位 |
| `replace-bed` | 原声丢弃，仅留人声（分离） | **配方值上调 2 dB** | 按配方值 | 外语配音/原声脏穿帮 | 单声道素材做不了近似分离，需显式声明 |
| `music-only` | 无声音床（静音） | 按配方值 | 无侧链（没有人声可让） | 纯卡点片、无人声素材 | **有人声时禁止**；必须 `allow_discard_original=true` |

（电平/让位修正系数来自 `bgm-bridge/core.mjs` 混音主流程的实测实现：`keep-all` 音乐电平 -3 dB、`replace-bed` +2 dB、`keep-all` 让位深度 ×0.6。）

### 2.2 分场景电平速查（与 recipes.json 实测值一致）

| 内容类型 | 配方 id | musicLevelDb (dBFS) | duckingDb (dB) | 备注 |
|---|---|---|---|---|
| 口播 / 访谈 | `interview` | **-26** | **14** | ducking 深度取上限，句间不抢气口 |
| 纪录片 / 科普 | `documentary` | -27 | 14 | 全库最轻的音乐床 |
| 高端品牌 | `premium-brand` | -26 | 13 | 留白就是质感 |
| 美妆 / 护肤 | `beauty` | -26 | 13 | 高频点缀，低频只留薄垫 |
| 房产 / 空间 | `realestate` | -25 | 13 | 讲解贯穿全片 |
| 叙事剧情片 | `drama-story` | -25 | 13 | 铺垫段只留 pad |
| 科技 / SaaS | `tech` | -25 | 12 | 屏幕演示段留白优先 |
| 悬疑 / 紧张 | `suspense` | -24 | 12 | 揭示前半拍静默比加音量有效 |
| 夜景 / 都市 | `night-city` | -24 | 12 | 有人声旁白必须 duck 到听清每个字 |
| 亲子 / 家庭 | `family` | -23 | 12 | 主体段 pluck 再降 2 dB |
| 产品广告 | `product-ad` | **-22** | **12** | 卖点靠口播，配乐只做精致度背书 |
| 美食 / 餐饮 | `food` | -22 | 12 | 锅气/咀嚼是内容声 |
| 喜剧 / 轻综艺 | `comedy-light` | -22 | 11 | 笑点前后各留 0.5 拍 |
| 户外 / 旅拍 | `travel` | -21 | 11 | 空镜允许 BGM 站前台 |
| 汽车 / 出行 | `auto` | -20 | 10 | 引擎是内容声，低频 60Hz 以下留给车 |
| 节日促销 | `festival-promo` | -19 | 10 | 全库最响的音乐床，报价处必留 ducking 窗口 |

分档规律（与 bgm-audio-layering SKILL 目标表一致）：

| 档位 | 让位深度 | BGM 平均电平 | 对应配方 |
|---|---|---|---|
| 口播 / 访谈 / 纪录 | 13–14 dB | -26 ~ -27 dBFS | interview / documentary / premium-brand / beauty / realestate / drama-story |
| 广告 / 旅拍 / 夜景 | 11–12 dB | -21 ~ -24 dBFS | product-ad / food / tech / travel / night-city / family / comedy-light / suspense |
| 促销 / 汽车 | 10 dB | -19 ~ -20 dBFS | festival-promo / auto |

> 注意：全库 musicLevelDb [-19, -27] 均落在 targets `musicLevelDbRange [-30, -16]` 内，duckingDb [10, 14] 均落在 `duckingDepthDb [8, 14]` 内。任何 Agent 自定义取值不得越出 targets 区间。

---

## 三、分场景实战

### 3.1 口播 / 访谈（人声绝对优先）

- 配方 `interview`：musicLevelDb **-26**、duckingDb **14**（让位深度上限）。
- 配音流程：voice 工位先对原声做 8–12 dB 让位把旁白垫上去，bgm 工位再让 BGM 对人声让 14 dB。
- 配器纪律：避开打击乐与高频铃音（易抢字）；句与句之间不要人为把音乐推起来——让位由侧链自动完成，**不补音量**。
- 听感验收：外放小音量下逐字可辨；无对白窗口音乐仍能听出存在（≥3 dB 可闻度）。

### 3.2 产品广告（卖点口播 + 精致感）

- 配方 `product-ad`：musicLevelDb **-22**、duckingDb **12**。
- 主体段可给 pluck 推进感，但价格/卖点口播处必须完整 duck 出来；落版前留 1 拍空。
- 常见翻车：低频轰鸣压住男声基频——广告男声基频低，BGM 的 bass 层要克制。

### 3.3 情绪片 / 剧情 / 高端品牌（浅让位、慢呼吸）

- 配方 `drama-story`（-25/13）、`premium-brand`（-26/13）：台词段让位照做，但**无台词的情绪段允许音乐站到前景**——这正是 `musicPresenceDb ≥ 3` 的设计场景。
- 让位本身也是情绪工具：长 release（400ms）让音乐在人声结束后"缓缓浮起来"，这个浮沉节奏就是情绪片的呼吸感。不要为了"稳"去缩短 release。
- 悬疑片（`suspense` -24/12）：揭示前留半拍静默，比把音乐推上去更有张力。

### 3.4 促销 / 汽车（音乐最响的两档）

- `festival-promo`（-19/10）、`auto`（-20/10）：音乐床最响、让位最浅，但报价/期限口播两处仍必须留出完整 ducking 窗口——"高能量但口播优先"。
- 汽车片特别注意：引擎/排气是内容声，与 BGM 低频会打架，配方要求 60Hz 以下留给车。

### 3.5 纪录片 / 现场感（keep-all 的用武之地）

- `documentary`（-27/14）+ `keep-all` 策略：原声（现场同期声、环境）全保留，音乐电平在配方值上再降 3 dB、让位 ×0.6（约 8 dB）。
- 此时人声-音乐余量天然富余，复检重点反而转向另一端：**配乐可闻度 ≥ 3 dB**——轻到这个份上最容易"配了跟没配一样"。

---

## 四、视频特有规则

1. **先配音、后配乐，顺序不可颠倒**。配乐要按人声让位，人声轨必须先定型（电平、时窗、让位后的原声都已确定），bgm 工位才能量到真实的 `speechLevelDb` 去换算 ducking 阈值。管线位置：`narrative-film` 的 `voice` 步在调色之后、配乐之前。
2. **两次让位作用于不同对象，不会线性叠加，但会叠加出"抽吸感"（pumping）**。voice 工位压的是原声，bgm 工位压的是 BGM，人声不被压缩——所以没有"音乐被压两次"的问题。真正的风险是：原声已被 voice 工位压低过一次后，如果 bgm 工位的音乐床又定得偏响、让位又深，观众会同时听到"原声在起伏 + 音乐在起伏"，两层增益骑在人声上互相追逐，产生明显的抽吸。规避方法：**先定人声电平 → 再定音乐床电平 → 最后才定 ducking 深度**（电平预算分配顺序，见下），让音乐床本身就够轻，ducking 只做"精细修边"而不是"主力压电平"。深度 8–14 dB 是上限区间，不是起步价。
3. **电平预算分配顺序（核心纪律）**：
   - ① 定人声：实测人声窗（取 ≥0.6s 的最长 4 段，各测 2s 内 200–4000Hz 带内平均电平）得 `speechLevelDb`；
   - ② 定音乐床：按配方 `musicLevelDb`（或底噪估算 `roomTone + 10`，钳制在 [-30, -16]，无实测时回退 -24）；
   - ③ 定 ducking 深度：按配方 `duckingDb`，换算阈值 `threshold = speechLevel − depth / (1 − 1/ratio)`（ratio 固定 8，即除数为 0.875；阈值钳制在 [-60, -6] dB）；
   - ④ 收口：amix 合流（`normalize=0`，不做自动归一）→ loudnorm 两遍法到 -14 LUFS / -1.0 dBTP。
4. **侧链键必须是人声频段（200–4000Hz 带通）**，不是全频段原声。低频鼓点、高频风声不该触发让位——只有"人声出现"才是让位的合法理由。工程实现：`highpass=f=200, lowpass=f=4000` 后作 sidechaincompress 的 key。
5. **attack 20ms / release 400ms / link=maximum 是防抽吸三件套**：快落（20ms 内让出人声字头）、慢起（400ms 音乐才浮回来，避免句间"喘气"）、立体声联动最大通道（避免声像左右跳）。这三个参数全库统一，不随配方变化。
6. **平台变体（9:16/时长裁剪）从已配乐母版派生，不重新混音**。重新混音意味着电平账重算一遍，母版复检结论全部作废——这是"同一个项目只用一套配乐语言"的工程含义。
7. **视频轨零重编码**（`-c:v copy`），音频链路的任何调整都不许碰画面。

---

## 五、常见误区

| 误区 | 纠正 |
|---|---|
| "两次让位会叠加，音乐被压了 14+12=26 dB" | 错在对象。voice 工位压的是原声，bgm 工位压的是 BGM，人声是共同的侧链键、本身不被压。两次让位在同一时刻作用于两条不同的轨 |
| "让位越深越保险" | 让位深度是上限不是目标。过深的 ducking（尤其音乐床本身定得偏响时）会让音乐的起伏被听出来——抽吸感。正确顺序是先把音乐床电平定低，ducking 只做修边 |
| "人声停了就把音乐推回去（手动补音量）" | 句间不抢：release 400ms 已经让音乐自然浮回，人为在句间推音量会造成"追人声"的呼吸噪声感 |
| "侧链直接用全频段原声" | 必须用 200–4000Hz 带通。否则鼓点、关门声、低频轰鸣都会误触发让位，音乐无故下压 |
| "响度不够就把总输出推大" | 成片响度由 loudnorm 两遍法统一收口 -14 LUFS。单轨推大会吃掉人声-音乐余量（≥6 dB 红线）和真峰值余量（≤-1.0 dBTP） |
| "音乐越轻越安全，干脆听不见也行" | 有 musicPresenceDb ≥ 3 dB 的下限：无对白窗口提升不足 3 dB 判 `verify_failed`、删除产物。配乐要有存在感 |
| "keep-all 就是 keep-dialogue 的近义词" | keep-all 有明确的电平含义：音乐电平再降 3 dB、让位 ×0.6、voice 工位对原声只做 3–6 dB 浅让位。现场感是用电平预算换的 |
| "平台变体重新混一版更精细" | 平台变体从母版派生，不重新混音。重混会使母版复检结论作废 |

---

## 六、意图→参数映射表

> 规则：Agent 收到模糊创作意图时，按本表直接翻译成 recipes.json 参数或 SKILL 参数，不要自行发明数值。

| 创作意图 | 中文写法 | 英文关键词/参数 |
|---|---|---|
| 口播字字清楚（访谈/带货） | 音乐床 -26 dBFS，让位 14 dB，句间不抢 | `interview`, musicLevelDb=-26, duckingDb=14 |
| 广告口播清楚又有精致感 | 音乐床 -22 dBFS，让位 12 dB，落版前留 1 拍 | `product-ad`, musicLevelDb=-22, duckingDb=12 |
| 纪录片现场感、音乐几乎隐形 | keep-all：音乐再降 3 dB，让位 ×0.6，原声浅让 3–6 dB | `keep-all`, `documentary`, musicLevelDb=-27, duckingDb=14×0.6 |
| 情绪片音乐要能"托起来" | 音乐床 -25 dBFS，让位 13 dB，无台词段音乐站前景 | `drama-story`, musicLevelDb=-25, duckingDb=13 |
| 促销热闹但报价必须听清 | 音乐床 -19 dBFS，让位 10 dB，报价处留 ducking 窗口 | `festival-promo`, musicLevelDb=-19, duckingDb=10 |
| 旅拍空镜音乐站前台、有人声就让 | 音乐床 -21 dBFS，让位 11 dB，同期声一出现即让位 | `travel`, musicLevelDb=-21, duckingDb=11 |
| 高端克制、留白即质感 | 音乐床 -26 dBFS，让位 13 dB，尾奏自然收 | `premium-brand`, musicLevelDb=-26, duckingDb=13 |
| 人声被音乐压住（修复） | 检查人声-音乐余量 ≥6 dB；下调 music_level_db 或加深 ducking | dialogueToMusicMarginDb ≥ 6, lower musicLevelDb |
| 配了乐但听不出（修复） | 无对白窗口提升须 ≥3 dB；不足判 verify_failed | musicPresenceDb ≥ 3, `verify_failed` |
| 音乐随人声一抽一抽（修复） | 音乐床先降电平；确认 release=400ms、attack=20ms、ratio=8、link=maximum | anti-pumping: attack 20ms / release 400ms / ratio 8 / link=maximum |
| 配音盖过原声（voice 工位） | keep-dialogue：原声侧链让位 8–12 dB，attack 20ms / release 400ms | voice keep-dialogue ducking 8–12 dB |
| 成片响度交付 | loudnorm 两遍法：-14 LUFS（±1.5）/ 真峰值 ≤ -1.0 dBTP | EBU R128 two-pass loudnorm, I=-14, TP≤-1.0 |
| 纯卡点片不要原声 | music-only，须显式声明允许丢弃原声 | `music-only`, allow_discard_original=true |

---

## 七、模板

### 模板 A：电平预算表（配乐开工前必填）

```
项目：<项目名>　配方：<recipe-id>
① 人声电平 speechLevelDb = <实测值> dBFS（200–4000Hz 带内，≥0.6s 最长 4 窗各测 2s 取平均）
② 音乐床 musicLevelDb = <配方值> dBFS（keep-all 再 -3；replace-bed +2；区间 [-30,-16]）
③ 让位深度 duckingDb = <配方值> dB（keep-all ×0.6；区间 [8,14]）
   侧链阈值 threshold = speechLevelDb − duckingDb / 0.875（钳制 [-60,-6] dB，ratio=8）
④ 分层策略 policy = <keep-dialogue / keep-all / replace-bed / music-only>
⑤ 收口 loudnorm 两遍法：I=-14 LUFS，TP=-1.5（留 0.5dB 余量），LRA=11
```

### 模板 B：口播片参数单（interview 为例）

```
policy=keep-dialogue
musicLevelDb=-26, duckingDb=14
sidechain: highpass=200 + lowpass=4000 → sidechaincompress
  ratio=8, attack=20ms, release=400ms, link=maximum, makeup=1
voice 工位（前置）：旁白 vs 原声让位 8–12 dB，attack 20ms / release 400ms
母版：loudnorm 两遍法 → -14 LUFS（±1.5）/ ≤-1.0 dBTP
```

### 模板 C：复检回执骨架（无回执不算完成）

```
① 响度 Integrated = <实测> LUFS（目标 -14 ±1.5）→ loudness_ok=<true/false>
② 真峰值 True Peak = <实测> dBTP（目标 ≤ -1.0）→ <pass/fail>
③ 人声-音乐余量 = <实测> dB（目标 ≥6，<3 直接失败）→ <pass/fail>
④ 配乐可闻度（无对白窗口提升）= <实测> dB（目标 ≥3，不足 verify_failed）→ <pass/fail>
⑤ 让位深度（对照法：无侧链对照 − 让位后，同人声窗比较）= <实测> dB（目标 ≤ -6）→ <pass/fail>
⑥ 卡点达标率 = <实测>%（目标 ≥60%，±80ms 记落拍）→ <pass/fail>
```

---

## 八、决策树

```
给定：片子类型 + 配音状态
│
├─ 片子有没有人声（口播/旁白/对白/同期声）？
│    │
│    ├─ 没有，纯卡点片
│    │    → policy = music-only（须 allow_discard_original=true）
│    │    → 电平预算：无 speechLevel，音乐床按配方值，无 ducking
│    │    → 收口：loudnorm → -14 LUFS / -1.0 dBTP
│    │
│    └─ 有 → 分层策略四选一
│         │
│         ├─ 配音片（成片加旁白/多语种）
│         │    ├─ 原声可用 → keep-dialogue
│         │    │    voice 工位：原声让位 8–12 dB（attack 20/release 400）
│         │    │    bgm 工位：见下方"电平预算 → ducking"
│         │    ├─ 现场感优先（纪录片）→ keep-all
│         │    │    voice 工位：原声浅让 3–6 dB
│         │    │    bgm 工位：musicLevelDb −3，duckingDb ×0.6
│         │    └─ 原声脏/外语配音 → replace-bed（立体声才可近似分离）
│         │         bgm 工位：musicLevelDb +2，duckingDb 按配方
│         │
│         └─ 电平预算（严格按序）
│              ① 定人声：实测 speechLevelDb（200–4000Hz 带内）
│              ② 定音乐床：按题材查配方 musicLevelDb
│              │    口播/访谈 -26 ｜ 纪录 -27 ｜ 广告/美食 -22 ｜ 科技/剧情 -25
│              │    旅拍 -21 ｜ 夜景/悬疑 -24 ｜ 汽车 -20 ｜ 促销 -19
│              ③ 定 ducking：按配方 duckingDb
│              │    口播/纪录 14 ｜ 品牌/房产/剧情/美妆 13 ｜ 广告/夜景/科技 12
│              │    旅拍/喜剧 11 ｜ 汽车/促销 10
│              │    阈值 = speechLevel − depth/0.875，ratio=8
│              │    attack=20ms，release=400ms，link=maximum
│              ④ 收口：amix(normalize=0) → loudnorm 两遍法
│                   → -14 LUFS（±1.5）/ ≤-1.0 dBTP
│
└─ 复检六线全部通过才允许交付；任一不达标 → 按第五章对应行处置，不得宣称达标
```

---

## 九、关联知识

- **SCORE-003 卡点结构**：剪辑点检测、±80ms 落拍口径、卡点达标率 ≥60%（复检线⑥的展开）；选段/峰值对齐与电平重测的关系（选段后须重新量片段电平再定增益，避免"-22 dB 口径"因换段失真）。
- **SCORE-004 平台响度**：各平台归一化行为的差异与变体派生纪律（平台变体从母版派生、不重新混音）。
- **SCORE-007 复检六线**：六条线的测量方法学——尤其让位深度的"无侧链对照法"（同链渲一版不挂侧链的对照，同人声窗比较，避免把曲子自身起伏误判为让位深度）。
- **SKILL `bgm-audio-layering`**：四分层策略定义、ducking 参数换算、EBU R128 两遍法、复检线与失败纪律的工位级原文。
- **SKILL `voice-delivery-spec`**：voice 工位交付口径（成片配音 -14 LUFS ±1.5 / ≤-1.0 dBTP；播报 -16 LUFS ±1.0 / ≤-1.5 dBTP）、可懂度抽检（ASR match_ratio ≥0.6）。
- **SKILL `voice-dubbing-sync`**：原声保留四策略在 voice 工位的让位深度口径（keep-dialogue 8–12 dB、keep-all 3–6 dB）、"先配音后配乐"的管线顺序、音画同步三条线。
- **代码事实源**：`library/bgm-recipes/recipes.json`（targets 与 16 套配方实测值）、`connectors/bgm-bridge/core.mjs`（`deriveDuckParams` 阈值换算、`VOICE_BAND` 200–4000Hz、sidechaincompress 滤镜链、loudnorm 两遍法与真峰值闭环）。

> 本篇是配乐知识库的入口篇：凡涉及"电平、响度、让位、谁压谁"的问题，先检索 SCORE-001 定口径，再按需联合检索 SCORE-003（时间轴对齐）与 SCORE-004（平台交付）。
