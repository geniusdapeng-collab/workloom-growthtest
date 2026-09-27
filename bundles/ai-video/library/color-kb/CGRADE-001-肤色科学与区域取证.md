# 肤色科学与区域取证（Skin Tone Science & Regional Sampling）领域知识库

> **用途**：调色工位（color-bridge）的肤色判据知识库。供调色师 / Agent 在诊断、校正、风格化与复检中处理"有人脸"素材时检索调用。
> **主题编号**：CGRADE-001　**版本**：v1.0　**更新日期**：2026-09-27
> **使用方式**：凡输入素材含人物（口播、访谈、美妆、亲子、直播切片），先按本文第四章完成 skinPatch / neutralPatch 取证，再执行 color-grade 五步流程。**肤色是本仓库 color-recipes 的总原则"肤色优先于风格"的唯一量化落点**——风格可以错一点，肤色不能错。

---

## 一、核心概念

### 1.1 肤色在色相环上的位置：一条线，不是一个点

在 YUV 色彩空间中，人类肤色的色度分量（U/V）无论人种、明暗，都收敛在矢量示波器（vectorscope）的一条窄带上——即 **ITU 肤色线（I-line，肤色指示线）**。本仓库将其量化为：

> **肤色判据：标准 HSV 色相 ∈ [20°, 40°] 且 SATAVG ≤ 60**（`TARGET.skinHue = [20, 40]`，见 core.mjs 目标值表）
>
> **口径纪律（FC-COL-007）**：这里的"色相"是**标准 HSV 色相**，由取样区的 U/V 均值按 BT.601 反推
> （`standardHueFromUv`）。它与 `signalstats` 输出的 `HUEAVG` **不是同一把尺子**——ffmpeg 的 HUEAVG 是
> 复合色度相位角 `(180/π)·atan2(U−128, V−128)+180`（源码 `libavfilter/vf_signalstats.c`）：实测纯绿
> HUEAVG=38°、纯红 161°、真实肤色帧 135°。**直接拿 HUEAVG 套 20–40° 会把绿/青判成"健康肤色"、
> 把真肤色判成"异常"**。工具现在同时回传两个值：`skin.hue`（标准 HSV，判据用）与
> `skin.hueFfmpeg`（HUEAVG，仅作可追溯证据）。

- **为什么是 20–40°**：肤色线的生理基础是皮肤下的血红蛋白与黑色素共同作用——血红蛋白提供红橙基调，黑色素只改变亮度几乎不改变色相。因此从浅肤色到深肤色，色相只在这条线的 20–40° 区间内滑动，变化的主要是亮度（Y）与饱和度（SAT）。实拍换算校验：浅肤色 22.9°、小麦色 25.3°、深肤色 28.0°（同一口径下的 U/V 反推值）。
- **色相偏出区间的含义**：<20° 偏黄绿（病态、灰绿脸），>40° 偏橙红（疲惫、关公脸）。这两个方向正是 color-look-design 禁忌清单中"肤色被推到橙红或灰绿"的量化判据。
- **为什么限制 sat ≤ 60**：饱和度超 60 的肤色会"发蜡"、像涂了颜料。talking-head 配方直接把 SATAVG 收窄到 [40, 60]，就是为肤色留的安全带。

### 1.2 不同人种与光照下的偏移规律

| 条件 | 在判据上的表现 | 处置 |
|---|---|---|
| 浅肤色人种 | hue 偏向 30–40°（更粉），sat 偏低 | 正常，不要硬拉回 25° |
| 深肤色人种 | hue 偏向 20–30°（更黄），Y 更低，sat 偏高 | 正常；取样时注意 YAVG 低不等于欠曝 |
| 暖光（钨丝灯/夕阳） | 整体 hue 上漂，可能 >40° | **先修白平衡**（neutralPatch 取证），多数"肤色偏橙"是白平衡问题 |
| 冷光（阴天/LED 冷屏） | hue 下漂，可能 <20° | 同上；先 colortemperature，不要直接动肤色 |
| 彩光污染（霓虹/舞台） | 同一脸上明暗部 hue 分裂 | 取脸颊中间调取样，避开高光区；严重时人工接管 |

核心规律一句话：**光照造成的偏移是全局的，修白平衡；风格造成的偏移是局部的，修 look；判据失效的偏移才是肤色本身的问题。**

### 1.3 为什么肤色优先于风格

color-recipes/recipes.json 的 principle 写明："先校正后创作……**肤色优先于风格**；一个项目只用一套 look"。原因有三：

1. **观众对肤色的记忆色最敏感**：天空蓝一点绿一点没人记得，人脸偏绿 3° 所有人都会说"不舒服"。肤色是画面中唯一有"标准答案"的颜色。
2. **肤色是信任的载体**：访谈/口播（talking-head）卖的是"可信"，美妆（beauty-makeup）卖的是"真实妆效"——肤色一旦失真，内容价值直接归零。
3. **工程上可校验**：风格好坏是主观的，肤色有标准 HSV 色相 20–40° / sat ≤60 的硬判据（口径见 FC-COL-007）。把不可校验的东西让位给可校验的东西，是调色工位"无回执=未核实"纪律的自然延伸。

因此 `teal-orange` profile 的注释才专门警告"注意肤色别推到橙"——青橙的安全前提正是肤色落在橙区但**不越线**（hue ≤40°、sat ≤60）。

---

## 二、分类速查

### 2.1 肤色状态诊断表（skinPatch 取样后对照）

| 取样结果 | 诊断 | 首选修复 |
|---|---|---|
| hue 20–40° 且 sat ≤60 | healthy=true，无需处理 | 直接进 look 阶段，复检即可 |
| hue >40°（偏橙红） | 多为暖光白平衡偏移或 warm-film 超强度 | 先 colortemperature 降温 / colorbalance 减 r；look 强度降到配方建议值 |
| hue <20°（偏黄绿） | 多为冷光/荧光灯偏色，或 teal-orange 推过头 | colorbalance 加 rm/rh（红轴），检查 look 是否误用于人物题材 |
| sat >60（发蜡发橘） | 饱和度整体过高或人物镜 saturation >1.2 | eq=saturation 下调（人物镜红线 ≤1.2）；**禁止靠降饱和硬压白平衡问题** |
| hue 正常但肤色"脏" | 不是色度问题，是影调问题 | curves 提面部中间调；检查暗部裁切（YLOW 占比 >1% 报警） |
| 同帧不同区域 hue 分裂 | 混合光源（窗光+室内灯） | 以脸颊中间调为准取样；全局无法兼顾时以脸为准，背景容忍偏色 |

### 2.2 判据速记

- **肤色**：标准 HSV 色相 20–40°（`skin.hue`，由区域 UAVG/VAVG 按 BT.601 反推）、SATAVG ≤60（signalstats 输出）；`skin.hueFfmpeg` 是 HUEAVG 相位角，**不可**直接与 20–40° 比较
- **白平衡**：neutralPatch 的 R/G/B 增益离散 ≤0.06（spread > 0.06 即报 white_balance）
- **中性色度**：UAVG / VAVG ∈ [122, 134]（即 128±6）
- **整体饱和**：SATAVG ∈ [40, 80]（talking-head 收窄 [40,60]，beauty-makeup 收窄 [35,55]）
- **多镜匹配残差**：|ΔYAVG| ≤5、|ΔUAVG| / |ΔVAVG| ≤3（colorwrite.match 复检口径）

---

## 三、分场景实战

### 3.1 人物访谈 / 口播（talking-head 配方）

- profile `warm-film`，intensity 0.6，overrides：SATAVG [40,60]、**skinGuard: true**。
- 纪律：人脸是唯一主角。流程固定为 neutralPatch 修白平衡 → skinPatch 复检 hue/sat → 背景可去饱和但肤色不动。
- 禁止：肤色推向橙红（显疲惫）、对比过强（面部阴影变脏）、背景比人脸更抢眼。

### 3.2 美妆 / 护肤（beauty-makeup 配方）

- profile `clean-bright`，intensity **≤0.5**，skinGuard: true，SATAVG [35,55]。
- 第一诉求是肤色真实：先把白平衡修到中性（neutralPatch 增益离散 ≤0.06），风格强度压到 0.5 以内。
- 禁美白式提亮（肤质失真）、禁高饱和（肤色发橘）、禁磨皮感。美妆的肤色判据是全库最严的。

### 3.3 户外 / 旅拍（outdoor-travel 配方）

- profile `teal-orange`，intensity 0.6。青橙是人物商业片的安全牌——但**前提是肤色不越线**。
- 配方 notes 明确："人脸出现在画面时按 talking-head 的肤色标准复检"——即非人物配方遇到人脸也要回落到 hue 20–40° / sat ≤60。
- 顺光人像 hue 易上漂，逆光人像面部 Y 偏低：取样避开阴影面，取受光脸颊。

### 3.4 直播 / 促销切片（festival-promo 配方）

- profile `high-contrast-social`，SATAVG 放宽到 [60,90]——**但人物镜饱和度红线仍 ≤1.2**。
- "高饱和只给画面不给文字"，同样"高饱和只给环境不给脸"：饱和推上去后必须用 skinPatch 复检，肤色 sat >60 即回退。

---

## 四、视频特有规则（区域取证的工程做法）

1. **取证先于调色**：colorread.analyze 接受 `skin_patch` / `neutral_patch` 两个坐标参数（形如 `{x, y, w, h}`，像素坐标）。有人脸的素材**优先**显式传 skinPatch（最准）；不传时工具会走 T-01 自动检测；有灰卡/白墙时必须传 neutralPatch——color-grade 五步法的 analyze 步明确要求"有人物时补一帧人脸"。
2. **取样的物理实现（regionAverageRgb）**：core.mjs 的实现是 `crop=w:h:x:y → scale=1:1:flags=area → format=rgb24`，把整个区域面积平均成一个像素读回 R/G/B，并附带 Rec.709 luma（0.2126R+0.7152G+0.0722B）。**这是 YUV 原生管线，不经 PNG 中转，避免色度转换误差**。肤色判据走另一条路：frameStats 在 crop 后接 signalstats 读出该区域的 UAVG/VAVG/SATAVG，再用 `standardHueFromUv` 换算标准 HSV 色相。
   - **自动检测（T-01，已落地 2026-09-27）**：`detectSkinRegion` 把抽样帧缩到 120 宽 → 8×8 分区算 (Y,U,V) 均值 → 按肤色带（Cb 77–127 / Cr 133–173、luma 40–240、最小色度 12）筛格 → 取最大四连通区 → 换算回原始像素坐标。命中后仍用 frameStats 复测标准 HSV 色相，落在 20–40° 才采信；面积 ≥4% 且离带边界 ≥2° 记 high 置信度，≥1.5% 记 medium。
3. **取样区域选择准则**：
   - **选脸颊或额头中间调**——这两处血管分布均匀、受光稳定，是肤色的"标准取样点"。
   - **避开高光**（鼻梁亮斑、额头油光）：高光趋近光源色，hue 会往白方向漂移，把 30° 读成 45°。
   - **避开阴影**（下颌、发际线）：阴影受环境反射光污染，hue 会被环境色（绿地、蓝墙）带偏。
   - **避开妆容干扰区**（腮红、唇彩）：这些是有意为之的"非肤色色"，会拉高 sat 误判。
   - 区域不宜太小：w/h 必须 ≥1（否则 `bad_patch`），工程上建议 ≥32×32 像素以摊平噪点。
4. **无 patch 输入（T-01 起不再失效）**：优先级是"显式 patch > 自动检测 > 未命中"。
   - 自动检测命中：`skin = { source: "auto-skin-band", patch, confidence, areaShare, hue, ... }`，坐标/面积/置信度随证据包留痕；
   - 自动检测未命中（无人脸、肤色区 <1.5% 面积、或候选区色相不在 20–40°）：`skin.detected=false`，并产生 `skin_check_skipped` 上报（**不静默跳过**）；
   - neutralPatch 缺失时白平衡退回 gray-world 估计，回执带 `confidence: "low"` 与"强彩光场景不可靠"警告，此时肤色结论只能作参考。
5. **多帧取证（T-02 起按场景）**：analyze 默认走 `sampling=scene`——先检测切点，场景数 >4 时每场取中段代表帧（最多 6 帧，超出时把时间轴等分、每窗取最长段），场景 ≤4 退回 10%/35%/60%/85% 均匀四帧；指标按场景时长**加权聚合**。肤色 patch 在各帧复用，人脸运动幅度大时仍建议用 `at_seconds` 点名稳定帧。
6. **LUT 顺序影响肤色**：滤镜链固定为 normalize → colortemperature → colorbalance → curves → eq → lut3d（lut3d 恒在最后）。log/HLG 素材（`color_transfer=arib-std-b67` 或动态范围偏平）必须先套转换 LUT（slog3-to-rec709）再谈肤色——在 log 上读出的色相是失真的，判据不适用。

---

## 五、常见误区

| 误区 | 纠正 |
|---|---|
| "肤色偏色就降饱和度" | 色相（hue）问题降饱和只会得到"灰色的错肤色"。先修白平衡（neutralPatch 反推 gains），再谈饱和。红线原文："肤色跑偏先修白平衡，不要靠降饱和硬压" |
| "青橙色调里肤色越橙越电影感" | hue >40° 即越线，是"疲惫橙"不是"电影橙"。teal-orange 用于人物时必须 skinPatch 复检 |
| "没有 patch 也能自动判肤色" | T-01 起**可以**自动检测（分区肤色带 + 最大连通区），但它是兜底不是首选：自动区可能命中木质/沙色等近似色，面积 <1.5% 或色相越带即判未命中并上报 `skin_check_skipped`。人物镜仍应显式传 skinPatch |
| "signalstats 的 HUEAVG 就是色相，直接套 20–40°" | **错**（FC-COL-007）：HUEAVG 是复合色度相位角，实测纯绿 38°、真肤色 135°。判据必须用 `standardHueFromUv(UAVG, VAVG)` 换算出的标准 HSV 色相；`hueFfmpeg` 只作证据 |
| "取样取脸上最亮的地方最准" | 高光趋近光源色，会把 hue 读漂。取脸颊中间调，避开高光与阴影 |
| "美妆片提亮=变白=好看" | beauty-makeup 强度 ≤0.5，禁美白式提亮。提亮过界肤质失真、信任崩塌 |
| "深肤色人脸 YAVG 低=欠曝" | 肤色深本身 Y 就低，判欠曝要看全帧 YAVG 与暗部裁切（YLOW 占比），不能拿肤色区域亮度套 [80,140] |
| "一套 look 调完，肤色回检交给眼睛" | 眼睛对记忆色的判断会漂移，必须用标准 HSV 色相（由 UAVG/VAVG 换算）+ SATAVG 复检并写进回执 |
| "风格强度不够就加到 1.0" | 有人物时强度受肤色约束：talking-head 0.6、beauty-makeup 0.5 是上限不是建议 |

---

## 六、意图 → 参数映射表（Agent 核心调用区）

> 规则：所有肤色相关操作必须落到 colorread.* / colorwrite.* 工具参数或 ffmpeg 滤镜参数，禁止输出"调自然一点"这类不可执行描述。

| 创作意图 | 中文写法 | 英文关键词/参数 |
|---|---|---|
| 肤色诊断取证 | 对人物帧做肤色区域取样 | `colorread.analyze` + `skin_patch={x,y,w,h}`（脸颊/额头中间调） |
| 白平衡精确校正 | 用灰卡/白墙取样反推增益 | `colorread.analyze` + `neutral_patch`，gains 离散 ≤0.06 |
| 肤色偏橙修复 | 降色温 + 减红轴中间调 | `colortemperature=temperature=更低值`；`colorbalance=rm=-0.03:rh=-0.03` |
| 肤色偏绿/黄修复 | 加红轴或减蓝轴中间调 | `colorbalance=rm=0.03:rh=0.03` 或 `bm=-0.03:bh=-0.03` |
| 肤色发蜡降饱和 | 人物镜饱和压回安全带 | `eq=saturation=≤1.2`（人物镜红线），复检 skinPatch sat ≤60 |
| 口播访谈标准流程 | warm-film 低强度 + 肤色守卫 | `colorwrite.best --recipe talking-head`（warm-film @0.6，skinGuard） |
| 美妆真实妆效 | clean-bright 半强度 | `colorwrite.best --recipe beauty-makeup`（intensity ≤0.5，SATAVG [35,55]） |
| 青橙人物保护 | teal-orange 后肤色复检 | `teal-orange` profile + skinPatch 复测 hue ≤40° |
| 多镜肤色一致 | 以参考镜肤色为基准匹配 | `colorwrite.match`，残差 \|ΔUAVG\|/\|ΔVAVG\| ≤3、\|ΔYAVG\| ≤5 |
| 示波器读肤色线 | 出矢量示波器图核对 I-line | `colorread.scope` kinds=["vectorscope"]（`vectorscope=mode=color`） |
| 校正后风格化 | 两段式：校正 100% + look 按强度 | `colorwrite.grade` corrections（恒生效）+ profile + `intensity=0.5–0.8` |
| 肤色问题归因白平衡 | U/V 偏移超 ±6 先修中性 | `colorbalance` 按 UAVG/VAVG 反向微调（bm/bh、rm/rh，幅度 ±0.06 内） |

---

## 七、模板

### 模板 A：口播片标准肤色流程（talking-head）

```
1. colorread.probe      → 确认色彩空间，排除 log（log 先套 slog3-to-rec709）
2. colorread.analyze    → neutral_patch={灰卡/白墙坐标} + skin_patch={脸颊中间调 ≥32×32}
3. 读回执：whiteBalance.gains 离散 ≤0.06？skin.hue ∈ [20,40] 且 sat ≤60？
4. 白平衡越线 → colorwrite.grade corrections={colorBalance: 按 gains 反推}（校正恒 100% 生效）
5. colorwrite.best --recipe talking-head → warm-film @0.6，候选池 ±0.2 择优
6. 复检：analyze(skin_patch 同坐标) → hue/sat 仍在区间内；scope 出 vectorscope 核对肤色线
7. 归档：profile=intensity=前后指标=sha256 全部进回执
```

### 模板 B：肤色偏橙修复（无 look，纯校正）

```
症状：skinPatch 标准 HSV 色相=43°（越上限；同帧 HUEAVG 相位角会读成另一段数值，勿混用），neutralPatch gains 离散 0.09（偏暖）
判定：白平衡问题，不是风格问题
处置：
  corrections = {
    colorTemperature: <降至中性>,              // 按 gains 反推
    colorBalance: { rm: -0.04, rh: -0.04 }     // 减红轴，幅度 ∈ ±0.06
  }
  colorwrite.grade(corrections, 不带 profile/LUT)   // 只做校正段
复检：analyze → hue 回到 20–40°，UAVG/VAVG 回到 [122,134]
禁止：eq=saturation 下压（那是掩盖不是修复）
```

### 模板 C：青橙风格人物镜（teal-orange + 肤色守卫）

```
1. colorwrite.best --recipe outdoor-travel    // teal-orange @0.6
2. 成片复测 analyze(skin_patch) → hue ∈ [20,40]？sat ≤60？
   ├─ 越线 → 降 intensity 至 0.5 重渲染，仍越线 → 换 warm-film 并留痕
   └─ 达标 → 交付
3. vectorscope 图归档：肤色取样点应压在 I-line 附近，不得甩向橙轴
```

---

## 八、决策树（有人脸素材的处理链）

```
输入素材含人物？
  │
  ├─ 否 → 走常规 analyze（本主题不适用）
  │
  └─ 是
      ├─ 有 skinPatch 坐标？
      │    ├─ 否 → 肤色判据失效：人工指定坐标后再 analyze
      │    │         （T-01：显式 patch > 自动检测 > 未命中须上报 skin_check_skipped）
      │    └─ 是 → analyze(skin_patch, neutral_patch?)
      │              │
      │              ├─ log/HLG/PQ？→ 是：先转换 LUT，再重新取样
      │              │
      │              ├─ hue ∈ [20,40] 且 sat ≤60？
      │              │    ├─ 是 → healthy → 进 look 阶段（按配方强度）
      │              │    │         look 后同坐标复检 → 仍 healthy → 交付
      │              │    │
      │              │    └─ 否 → 归因：
      │              │         ├─ neutralPatch gains 离散 >0.06 或 U/V 偏移 >6
      │              │         │    → 白平衡问题 → colortemperature/colorbalance 修复
      │              │         │    → 修完重新取样（校正 100% 生效，一次只改一个变量）
      │              │         ├─ sat >60 但 hue 正常
      │              │         │    → 饱和问题 → eq=saturation ≤1.2（人物红线）
      │              │         ├─ 同脸 hue 分裂（高光/阴影不一致）
      │              │         │    → 混合光源 → 以脸颊中间调为准，容忍背景
      │              │         └─ 白平衡正常仍偏 → 才是肤色本身 → 局部 colorbalance 微调
      │              │
      │              └─ 人物题材配方强度上限：
      │                   talking-head 0.6 / beauty-makeup 0.5 / 人物镜 saturation ≤1.2
      │
      └─ 复检三件套（缺一不得宣称完成）：
           skinPatch hue/sat 在区间 + vectorscope 肤色线核对 + 前后指标差值进回执
```

---

## 九、关联知识

- **CGRADE-002 色彩空间与转换**：log/HLG/PQ 的识别与 slog3-to-rec709 转换——肤色判据只在 Rec.709 域成立，log 上读出的色相不可信。
- **CGRADE-005 示波器读法**：vectorscope 的 I-line 判读、waveform 的面部影调定位（脸颊中间调通常落在 45–65 IRE），是本文取样准则的图形化对照。
- **CGRADE-004 题材调色美学**：肤色约束下的风格空间——为什么青橙安全而墨绿暗黑不适合人物特写。
- **color-grade 技能**：五步流程（probe→analyze→correct→look→match & verify）与目标值表（YMIN 0–16 / YAVG 80–140 / SATAVG 40–80 / 肤色 hue 20–40° sat≤60）。
- **color-look-design 技能**：禁忌清单"肤色被推到橙红或灰绿"与失败模式表（美妆/访谈强度上限）——本文判据的岗位侧表述。
- **color-recipes 配方**：`talking-head`（warm-film @0.6，SATAVG [40,60]，skinGuard）、`beauty-makeup`（clean-bright @0.5，SATAVG [35,55]，skinGuard）、`outdoor-travel`（人脸回落 talking-head 标准复检）、`festival-promo`（SATAVG [60,90] 但人物红线 ≤1.2）。总原则见 recipes.json `principle`：先校正后创作，肤色优先于风格。

> 肤色是本仓库调色体系里唯一有硬判据的"记忆色"。处理人物素材时，本文应与 CGRADE-005（示波器）联合检索；涉及题材选型时与 CGRADE-004 及 color-recipes 配方库联合检索。
