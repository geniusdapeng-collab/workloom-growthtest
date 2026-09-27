# 白平衡校正与自动方法的失效边界（White Balance & Gray-World Limits）

> **用途**：成片调色的校正阶段知识库。供调色师 / Agent 在执行 color-grade 五步法第 3 步（correct）时检索调用。
> **主题编号**：CGRADE-006　**版本**：v1.0　**更新日期**：2026-09-27
> **使用方式**：Agent 在调用 `colorread.analyze` / `colorwrite.grade` 处理"画面偏色、偏蓝偏黄、白不白"类诉求时，检索本主题决定**用哪种白平衡取证策略**（灰世界 / neutralPatch / 肤色交叉 / 人工接管），并把结论落到 `colortemperature` 与 `colorbalance` 参数。**注意：白平衡是校正不是风格——它恒 100% 生效，调错方向没有任何强度旋钮可以稀释**（见第七章）。

---

## 一、核心概念

### 1.1 白平衡是什么

白平衡（White Balance）是**让画面中的"白"重新读作白**的校正操作。人眼有色彩恒常性（白纸在钨丝灯下依然觉得白），传感器没有——它如实记录光源的偏色，于是钨丝灯下的白纸拍出来是橙的，阴天下的白纸是蓝的。

白平衡有两根独立的轴，缺一不可：

- **色温（Color Temperature，开尔文 K）**：蓝↔黄轴。数值低 = 暖（钨丝灯约 2800K、日落约 3200K），数值高 = 冷（阴天约 6500–7500K、蓝天阴影可达 10000K+）。
- **色调（Tint）**：绿↔品红轴。荧光灯、LED 的绿偏、某些夜景的品红偏都走这根轴，色温管不到。

只调色温不调 tint，荧光灯素材永远带着一层洗不掉的绿。

### 1.2 U/V 通道与中性判据（本仓的落地口径）

本仓诊断管线走 YUV 原生路径（`frameStats` 用 ffmpeg `signalstats`，不做 PNG 中转以避免色度转换误差），白平衡状态由两个指标直接读出：

| 指标 | 含义 | 中性值 | 本仓判据 |
|---|---|---|---|
| **UAVG** | 蓝-黄色度轴均值 | 128 | `UAVG ∈ [122, 134]`（= 128±6）为中性；>134 偏蓝、<122 偏黄 |
| **VAVG** | 红-绿色度轴均值 | 128 | `VAVG ∈ [122, 134]` 为中性；>134 偏红、<122 偏绿 |

判据出处：`recipes.json` 的 `targets.UAVG/VAVG: [122, 134]`，`core.mjs` 的 `TARGET.uvAvg: [122, 134]` 与 `analyze()` 中的 `color_cast` 检测（|ΔU| 或 |ΔV| > 6 即报"中性色度偏移"，并给出"偏蓝/偏黄/偏红/偏绿"方向描述）。U 轴对应色温轴（蓝-黄），V 轴恰好覆盖 tint 的绿-品红方向——**两个通道一起读，才能区分"色温问题"还是"tint 问题"**。

### 1.3 灰世界假设（Gray World Assumption）

灰世界是最经典的自动白平衡算法，原理一句话：

> **假设自然画面的所有颜色平均起来是中性灰**——那么把全画面 R/G/B 平均值拉到相等（各自除以均值、乘回公共亮度），就得到白平衡增益。

本仓 `analyze()` 的实现正是如此（`regionAverageRgb` 把全帧缩到 1×1 取平均，gains = target/channel）。但代码对这个结果自注了 **`confidence: "low"`**，并附言：

> "未提供 neutral 灰区，按灰世界估计，**强彩光场景不可靠**"

为什么低置信？因为灰世界假设的前提是"画面颜色足够杂、平均后自然抵消"。现实素材大量违反这个前提（见第三章）：画面被一种大面积颜色主导时，算法会把那种主导色误当成"光源偏色"去抵消——**蓝天素材被调黄、绿野素材被调品红、暖灯夜景被调蓝**。灰世界给出的 gains 方向可能完全错误，而它是全自动链路，没有人工复核环节——这就是 `confidence:low` 的工程含义：**此结果只能作为线索，不能作为校正依据直接落链**。

---

## 二、分类速查

### 2.1 偏色诊断速查（UAVG/VAVG → 方向 → 校正轴）

| UAVG / VAVG 读数 | 偏色方向 | 主要问题轴 | 首选校正工具 |
|---|---|---|---|
| UAVG > 134，VAVG 正常 | 偏蓝 | 色温轴（太冷） | `colortemperature` 降 K 值 |
| UAVG < 122，VAVG 正常 | 偏黄 | 色温轴（太暖） | `colortemperature` 升 K 值 |
| UAVG 正常，VAVG > 134 | 偏红/品红 | tint 轴 | `colorbalance` 的 r/g 参数微调 |
| UAVG 正常，VAVG < 122 | 偏绿 | tint 轴 | `colorbalance` 的 g 参数微调（荧光灯常见） |
| U、V 同时越界 | 复合偏色 | 两轴都有 | 先 `colortemperature` 归色温，再 `colorbalance` 修残余 |
| 均在 [122,134] 但画面仍觉偏色 | 局部偏色（阴影蓝/高光暖） | 分区问题 | `colorbalance` 的 rs/rm/rh 分区参数 |

### 2.2 取证策略分级（置信度从高到低）

| 策略 | 本仓实现 | 置信度 | 适用前提 |
|---|---|---|---|
| **neutralPatch 中性参照** | `analyze({ neutralPatch })` → `regionAverageRgb` 对指定区域取 1×1 平均 | `high`（代码明示） | 画面中存在确知为白/灰的物体 |
| **肤色交叉校验** | `analyze({ skinPatch })` → HUEAVG ∈ [20,40]°、SATAVG ≤ 60 | 中高（有人脸时） | 有人物且肤色应自然 |
| **多帧抽样交叉** | `defaultTimestamps` 抽 4 帧（10%/35%/60%/85%），U/V 方向一致才可信 | 中 | 全片光照条件统一 |
| **灰世界全帧平均** | 未提供 patch 时的默认兜底 | `low`（代码明示） | 色彩构成杂、无主导色 |
| **人工接管** | 上报 + 留痕，不硬调 | —— | 上述全部不可靠时（见 4.x 与第八章） |

---

## 三、分场景实战（灰世界失效的典型场景）

> 本章是本文核心：以下场景中**禁止直接采纳灰世界结果**，必须升级取证策略。

### 3.1 大面积单色主导

| 场景 | 灰世界的误判 | 后果 | 正确做法 |
|---|---|---|---|
| **蓝天 / 海景** | 蓝色主导被当成"冷光源偏色" | 增益把蓝压掉 → 天空发灰发黄、海水变浑 | 找白云/浪花/船体白色做 neutralPatch；找不到就人工给定色温 |
| **绿野 / 森林 / 草坪** | 绿色主导被当成"绿偏" | 补品红 → 草地发紫、树叶发灰 | 找马路/岩石/树干做 neutralPatch |
| **红墙 / 沙漠 / 秋色林** | 红橙主导被当成"暖光源" | 补青 → 红墙褪色、沙漠发灰 | 优先肤色交叉（若有人）或人工指定 |
| **夜景暖灯（钨丝灯街道、灯笼、篝火）** | 满屏暖橙被当成"严重偏暖" | 大幅补蓝 → 夜景氛围全毁、暖灯变冷白 | **这是 intentional cast，原则上不动**（见 3.3） |

### 3.2 舞台灯光与霓虹夜景

舞台/演出现场的"色偏"绝大多数是**灯光师的设计**：追光品红、侧光青蓝、LED 染色墙。霓虹夜景同理——画面平均色品红偏紫不是白平衡错误，是场景本身的颜色。此时：

- UAVG/VAVG 越界是**真实记录**，不是缺陷；`color_cast` 报警应标注"场景固有，留痕不校正"。
- 若甲方坚持"看起来正常一点"，只做**半量校正**（色温往中性方向走一半），且必须留痕"客户要求偏离中性"。
- 灰世界在这种素材上会把每个镜头调成不同的"错误中性"，镜头间反而更不匹配——**比不调更糟**。

### 3.3 Intentional Color Cast（刻意色偏被"校正"掉）

创作者刻意保留的色偏是风格的一部分：复古胶片的暖黄（`vintage-fade` profile 自带暖调）、日落的金橙、蓝调时刻的青蓝。校正阶段的纪律（`recipes.json` principle："先校正后创作"）是指**修掉非故意的偏色**，不是把一切偏离中性的画面拉回 128。

**判据：偏色是否服务于叙事/情绪？是 → 不动或半量；否 → 校正。** 无法判断时按第四章人工接管，不得默认全量校正。

### 3.4 人像特写肤色主导

面部大特写时，画面平均色≈肤色（暖橙），灰世界会判定"严重偏暖"并补蓝——结果人脸发青。反过来看，这给了另一条路：**肤色本身就是最好的中性参照物之一**。本仓 `skinPatch` 判据（HUEAVG ∈ [20,40]°、SATAVG ≤ 60，`TARGET.skinHue: [20, 40]`）与白平衡互为校验：

- 白平衡正确时肤色 hue 应落在 20–40°；
- 若肤色 hue < 20°（偏红）或 > 40°（偏黄绿），多半白平衡没修对，**先修白平衡再动饱和**（`analyze()` 的 skin_tone 建议原文）。

### 3.5 更可靠的替代取证：neutralPatch 怎么用

`neutralPatch` 的机制（`regionAverageRgb` + `patchToCrop`）：调用方给出画面矩形 `{x, y, w, h}`（像素坐标），工具裁出该区域缩放到 1×1 取 R/G/B 平均，以此反推 gains 并标注 `confidence: "high"`、`source: "neutral-patch"`。

参照物取舍优先级：

1. **白墙 / 白纸 / 灰卡**：首选。注意避开高光溢出区（裁切后的"白"三色通道都顶死，gains 无意义）与阴影里的"白"（照明不均，不具代表性）。
2. **马路沥青 / 水泥地**：户外可靠备选，灰色且通常受全光谱照明。
3. **牙齿 / 眼白**：**谨慎使用**。牙齿天然偏黄、眼白偏粉青且面积小易受噪点污染，只能作为"没有更好参照时的交叉验证"，不能单独作为 neutralPatch。
4. **白衬衫 / 白盘白瓷**：可用但警惕——很多"白"衣物含荧光增白剂（偏蓝紫），白瓷盘可能本身带暖釉。

多帧交叉：neutralPatch 在 4 个抽样时间点上分别取样，gains 方向一致才可落链；方向漂移说明该"参照物"在不同镜头里受光不同，不可信。

---

## 四、视频特有规则

1. **校正恒 100% 生效，没有稀释旋钮**：`buildChain()` 两段式纪律——correctionParts（normalize→colortemperature→colorbalance→curves→eq）直接拼接进链，**不经过 blend**；只有 profile/LUT 走 `split→look→blend(all_opacity=intensity)`。原因写在代码注释里："把校正也一起按 0.8 稀释，会让'欠曝修一半'"。推论：**白平衡参数写错就是全量错**，所以取证必须高置信，宁可用保守量也不可用激进量（`autoCorrections` 对 colorbalance 的 shift 钳制在 ±0.06 正是这一纪律的体现）。
2. **逐镜一致性**：视频是多镜头序列，白平衡取证必须覆盖多个抽样帧（`defaultTimestamps` 的 10%/35%/60%/85% 四帧）。单帧 neutralPatch 正确不代表全片正确——同一场景镜头间色温漂移要用 `colorwrite.match` 以参考镜为基准对齐（残差目标 |ΔUAVG|/|ΔVAVG| ≤ 3）。
3. **log/HLG 素材先转换再谈白平衡**：`analyze()` 检出 `color_transfer=arib-std-b67/smpte2084` 或动态范围偏平（YMAX−YMIN<120）即报 `log_or_flat`。log 画面天然发灰发平，U/V 读数不可直接解读，必须先套 `slog3-to-rec709` 转换 LUT，**禁止在 log 上直接做白平衡结论**。
4. **运动镜头的中性参照会跑出 patch**：neutralPatch 坐标是固定像素矩形，镜头运动后参照物可能移出框。取 patch 时选参照物在画面中停留最久的时刻，或对该镜单独定 `at_seconds`。
5. **校正顺序不可乱**：滤镜链纪律 `normalize → colortemperature → colorbalance → curves → eq → lut3d`。色温先归位，colorbalance 再修分区残余；顺序反了，colorbalance 修的是"错误基础上的偏色"，curves 和 eq 会继承错误并放大。

---

## 五、常见误区

| 误区 | 纠正 |
|---|---|
| "UAVG/VAVG 不在 [122,134] 就是白平衡坏了" | 夜景暖灯、霓虹、单色场景的越界是真实记录。越界只说明"画面不中性"，不说明"应该中性" |
| "灰世界全自动省事，直接采纳" | 代码已自注 `confidence:low` + "强彩光场景不可靠"。灰世界结果只能当线索，落链前必须升级取证 |
| "白平衡 = 调色温就够了" | tint 轴（绿↔品红）不归色温管。荧光灯绿偏要 colorbalance 的 g 参数；只看 U 轴会漏掉 V 轴问题 |
| "眼白/牙齿是最好的白色参照" | 牙齿天然偏黄、眼白偏粉青且取样面积小。只能交叉验证，不能单独做 neutralPatch |
| "校正也可以按 intensity 打个八折" | 校正恒 100% 生效（两段式链路纪律）。想要"半量校正"应直接把参数写一半，而不是指望强度稀释 |
| "客户说'正常点'就全量拉回中性" | intentional cast 是创作资产。先判断偏色是否服务叙事；全量校正可能是在销毁风格 |
| "一个镜头的白平衡参数套全片" | 视频要 4 帧抽样交叉 + 多镜 match。单帧结论对多切点素材必然失真 |
| "偏色严重就一次拉到位" | `autoCorrections` 的纪律是"幅度保守，一次只改一点"（shift ≤ ±0.06，eq 钳制明确）。激进校正容易过冲出新偏色 |

---

## 六、意图→参数映射表

> 规则：本表把"画面问题/创作意图"翻译成 `colorwrite.grade` 的 `corrections` 参数。校正在滤镜链中的位置：`normalize → colortemperature → colorbalance → curves → eq`。

| 创作意图/场景 | 中文写法 | 英文关键词/参数 |
|---|---|---|
| 素材偏冷（阴天发蓝） | 降色温补暖 | `colortemperature=temperature=4800`（向暖方向）；或 `colorbalance: {bm:-0.03, bh:-0.03}` 压蓝 |
| 素材偏暖（钨丝灯发黄） | 升色温补冷 | `colortemperature=temperature=7200`（向冷方向）；或 `colorbalance: {bm:0.03, bh:0.03}` 补蓝 |
| 荧光灯绿偏 | 去绿补品红 | `colorbalance: {gm:-0.02, gh:-0.02}`（V 轴修正） |
| 品红偏（部分 LED） | 去品红补绿 | `colorbalance: {rm:-0.02, rh:-0.02}` |
| 阴影偏蓝高光正常 | 分区修阴影 | `colorbalance: {bs:0.03}`（只动 shadows 的 b 通道） |
| 高光偏暖阴影正常 | 分区修高光 | `colorbalance: {bh:-0.02, rh:-0.02}`（只动 highlights） |
| 有灰卡/白墙的棚拍素材 | 精确中性校正 | `colorread.analyze` 传 `neutral_patch:{x,y,w,h}` → 按 gains 反推参数，`confidence:high` |
| 人像素材肤色异常 | 先白平衡后饱和 | `colorread.analyze` 传 `skin_patch` 校验 hue∈[20,40]°；跑偏先修 U/V 再谈 eq.saturation |
| 夜景暖灯氛围保留 | 半量校正或不校正 | 直接给半量参数（如 `colortemperature` 只走中性方向一半），留痕"intentional cast" |
| 多镜头色温不统一 | 以参考镜匹配 | `colorwrite.match`，残差目标 \|ΔUAVG\|/\|ΔVAVG\| ≤ 3 |

---

## 七、模板

### 模板 A：棚拍白底产品（有 neutralPatch 的理想情况）

```
1. colorread.analyze(input, neutral_patch=白底无高光区域{x,y,w,h})
   → whiteBalance.confidence="high", source="neutral-patch"
   → gains 离散 spread ≤ 0.06：白平衡已中性，跳过本步
   → spread > 0.06：按 gains 方向反推 colortemperature / colorbalance
2. colorwrite.grade(corrections={colortemperature:..., colorbalance:...})
   校正恒 100% 生效，无 intensity 参数可稀释
3. 复检：UAVG/VAVG 回到 [122,134]，白底 YMAX ≥ 240 且不裁切
```

### 模板 B：户外风光（无中性参照，灰世界不可信）

```
1. colorread.analyze(input) → whiteBalance.confidence="low", source="gray-world"
   注意：仅作线索，不直接落链
2. 检查场景构成：天空/植被占比 >50% → 灰世界结论作废
3. 找马路/岩石/云做 neutral_patch 重新 analyze；找不到 →
   人工按时段给经验色温（正午 5500K / 阴天 6800K / 黄金时刻 3800K）
4. 4 帧抽样确认 UAVG/VAVG 方向一致后落链
```

### 模板 C：人像访谈（肤色交叉校验）

```
1. colorread.analyze(input, skin_patch=面部区域{x,y,w,h}, neutral_patch=背景白墙)
2. 双校验：neutralPatch gains 与肤色 hue∈[20,40]°、sat≤60 是否一致
   → 一致：按 neutralPatch 落链
   → 冲突（灰区说偏蓝但肤色 hue<20 偏红）：以肤色为准微调，人看的不是墙
3. colorwrite.grade 后必须复检肤色：healthy=false 即回退，肤色优先于风格
```

### 模板 D：夜景/霓虹（诚实边界示例）

```
1. colorread.analyze(input) → color_cast 报警（U/V 越界）
2. 判定：偏色为场景固有（霓虹/暖灯设计）→ 上报口径：
   "素材 UAVG=xx 越界系场景固有色光，非白平衡缺陷。
    选项：(a) 保留原貌（推荐，留痕 intentional cast）；
          (b) 半量校正（客户明确要求时）；
    灰世界自动校正已禁用（confidence:low，强彩光场景不可靠）。"
3. 未获明确指示前，不在此类素材上执行自动白平衡
```

---

## 八、决策树

```
素材进来，先做 colorread.analyze（probe + 4 帧抽样）
  │
  ├─ 疑似 log/HLG（color_transfer 或动态范围偏平）？
  │     └─ 是 → 先套 slog3-to-rec709 转换 LUT，再重新诊断（白平衡结论禁止在 log 上下）
  │
  ├─ 画面有确知的白/灰参照物（白墙/灰卡/马路/白纸，非高光区）？
  │     ├─ 有 → neutralPatch 取证（confidence:high）
  │     │     ├─ gains 离散 >0.06 → 按 gains 反推 colortemperature/colorbalance 落链
  │     │     └─ 离散 ≤0.06 → 白平衡已中性，跳过
  │     └─ 无 ↓
  │
  ├─ 画面有人物（尤其特写）？
  │     └─ 有 → skinPatch 交叉校验（hue 20–40°、sat≤60）
  │           ├─ 肤色 healthy 且 U/V 在 [122,134] → 无需动
  │           ├─ 肤色异常 → 以肤色为参照反推白平衡方向，小步修正复检
  │           └─ 灰世界结论仅作旁证，不作主依据
  │
  ├─ 场景是大面积单色主导 / 舞台灯光 / 霓虹夜景 / 明显 intentional cast？
  │     └─ 是 → 人工接管：
  │           - 判定偏色是否服务叙事（是 → 不动或半量，留痕）
  │           - 需要校正时人工给经验色温，禁止采纳灰世界结果
  │           - 上报口径见模板 D
  │
  └─ 以上都不是（色彩构成杂、光照统一的一般素材）
        └─ 灰世界可作初判（confidence:low 纪律：必须交叉验证）
              ├─ 4 帧 U/V 方向一致 → autoCorrections 保守量落链（shift ≤±0.06），复检
              └─ 帧间方向漂移 → 按"光照不统一"处理：分镜校正或 colorwrite.match 对齐参考镜
```

---

## 九、关联知识

- **CGRADE-001 肤色保护**：肤色 hue 20–40°、sat≤60 判据是白平衡的交叉校验锚点（本文 3.4 节）；肤色跑偏的处置纪律"先修白平衡再动饱和"与此互为表里。
- **CGRADE-005 示波器与量化判读**：vectorscope 上中性点居中即 U/V≈128 的图形化表达；waveform 判读黑位白位与本文 YMIN/YMAX 目标值同套口径。
- **color-grade SKILL（五步法）**：本文是其第 3 步 correct 中"白平衡"环节的展开——目标值表（UAVG/VAVG≈128±6）、"校正恒 100% 生效"、"一次只改一个变量"等纪律均源自该 SKILL 与本仓 `core.mjs` 实现。
- **COLOR-001 色调与配色**：白平衡归位之后才谈配色；intentional cast（本文 3.3）与"复古胶片暖黄""赛博霓虹"等刻意色调是同一创作意图的两面。

> 落地索引：判据见 `library/color-recipes/recipes.json`（targets）；取证与校正实现见 `connectors/color-bridge/core.mjs`（`analyze()` 的 neutralPatch/gray-world 分支、`autoCorrections()`、`buildChain()` 两段式纪律）。
