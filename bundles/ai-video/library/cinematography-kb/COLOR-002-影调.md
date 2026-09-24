# 影调（Tone / Luminosity）领域知识库

> **用途**：AI 视频生成系统的提示词知识库。供数字员工 / Agent 在生成视频提示词时检索调用。
> **主题编号**：COLOR-002　**版本**：v1.0　**更新日期**：2026-09-24
> **使用方式**：Agent 接收到涉及"亮一点、暗一点、通透、压抑、高级灰、死黑、氛围沉重"等创作意图时，检索本主题，将明暗意图翻译成画面效果描述写入提示词。**注意：AI 视频模型不理解"影调"这个抽象术语，必须把它翻译成明暗分布、反差、黑位处理等具体视觉描述**（见第六章映射表）。

---

## 一、核心概念

### 1.1 影调是什么

影调是**画面明暗的整体分布状态**，即亮部、中间调、暗部在画面中各占多少比重、以何种反差衔接。

> **影调 = 情绪的重力场**：画面越暗，情绪越"重"；画面越亮，情绪越"轻"。

- **色调（COLOR-001）管色彩情绪**：暖还是冷、浓还是淡——决定画面的"温度与性格"
- **影调（COLOR-002）管明暗情绪**：亮还是暗、硬还是柔——决定画面的"重量与呼吸感"
- **两者完全独立**：可以有暖调低调（烛光晚餐）、也可以有冷调高调（雪地正午）。Agent 检索时不要把它们混为一个词。

### 1.2 影调的三要素

| 要素 | 含义 | 对画面的影响 |
|---|---|---|
| **基调（Key）** | 画面整体偏亮还是偏暗（高调/中间调/低调） | 决定情绪轻重 |
| **反差（Contrast）** | 最亮与最暗之间的差距（高反差/低反差） | 决定戏剧性强弱 |
| **黑位（Black Point）** | 最暗处是死黑还是保留层次 | 决定质感与风格 |

记忆口诀：**"基调定重量，反差定戏剧，黑位定质感"**。

### 1.3 直方图直觉（Agent 判断影调的底层逻辑）

不需要真的看直方图，只需理解三种典型形态：

1. **峰值靠右** → 亮部信息多 → 高调
2. **峰值居中** → 信息均衡 → 中间调
3. **峰值靠左** → 暗部信息多 → 低调

> 提示词组合技巧：想要某种影调时，不要只写"high key"，组合"基调 + 反差 + 黑位"的三层描述（如 low key + high contrast + crushed blacks），模型输出更稳定。

---

## 二、影调全表（核心速查）

| 影调 | 英文名 | 直方图特征 | 画面感受 | 情绪气质 | 典型题材 | AI 提示词写法 |
|---|---|---|---|---|---|---|
| **高调** | high key | 峰值强烈靠右，暗部极少 | 明亮、轻盈、干净 | 纯净、希望、天真、治愈 | 时尚美妆、母婴、日系写真、婚礼 | high key lighting, bright airy, overexposed background, clean white tones |
| **中高调** | mid-high key | 峰值中右偏亮 | 日常明亮、通透 | 轻松、积极、生活感 | 日常 Vlog、电商展示、美食 | bright natural lighting, airy and fresh, well-lit scene |
| **中间调** | mid key | 峰值居中，分布均衡 | 均衡、正常、信息量大 | 客观、真实、无倾向 | 纪实、新闻、大部分常规内容 | balanced exposure, natural mid-tones, evenly lit |
| **中低调** | mid-low key | 峰值中左偏暗 | 沉稳、内敛 | 安静、思索、含蓄 | 室内访谈、文艺短片、咖啡馆场景 | subdued lighting, muted tones, slightly underexposed mood |
| **低调** | low key | 峰值强烈靠左，亮部为点缀 | 深沉、神秘、重量感 | 高级、性感、力量、悬疑 | 男性向、奢侈品、悬疑片、酒吧夜景 | low key lighting, dark moody atmosphere, deep shadows |
| **全长调** | full range | 从黑到白全分布，各段都有 | 层次丰富、立体 | 壮阔、细腻、史诗 | 风光大片、建筑摄影、电影大场面 | full tonal range, rich tonal gradation, detailed highlights and shadows |
| **高反差** | high contrast | 峰值分居两端，中间塌陷 | 硬朗、锐利、冲突感 | 戏剧、紧张、力量 | 黑白街拍、动作片、硬光人像 | high contrast, dramatic lighting, stark blacks and bright highlights |
| **低反差** | low contrast / flat | 峰值挤在中段，两端空缺 | 柔和、灰调、雾感 | 温柔、怀旧、慵懒 | 阴天人像、文艺片、后期调色素材 | low contrast, flat profile, soft muted tones, hazy |
| **剪影** | silhouette | 极致反差特例：主体全黑、背景全亮 | 图形化、符号化 | 孤独、浪漫、仪式感 | 日出日落人像、舞蹈、产品轮廓 | silhouette against bright background, backlit subject, black outline |
| **明暗对照法** | chiaroscuro | 暗部占主体，局部高光雕刻形体 | 油画感、雕塑感 | 庄严、古典、神圣 | 伦勃朗式人像、古典油画风、宗教题材 | chiaroscuro lighting, Rembrandt lighting, Caravaggio style, painterly light and shadow |

### 原始口诀扩展解读（保留原口诀骨架）

> 原口诀：高调出轻盈 → 低调出高级 → 中间调出真实 → 反差定戏剧 → 黑位定质感。

- **高调 —— 轻盈制造机**：画面以亮部为主，暗部几乎消失。高调不等于"过曝废片"——主体曝光依然准确，是**背景和氛围的亮**。日系"空气感"写真的核心就是高调 + 低反差。代价：高调画面容易显平，要靠色彩（COLOR-001）或线条撑住结构。
- **低调 —— 高级感捷径**：画面以暗部为主，只用少量亮部勾勒主体。奢侈品、腕表、香水广告几乎都是低调，因为"暗"天然关联"稀有、克制、贵"。低调不是没打光，恰恰相反——**低调的每一寸亮部都是精心打出来的**。
- **中间调 —— 纪实的底色**：信息最均衡、情绪最中立，观众注意力全在内容本身。新闻、纪录、教程类内容默认走中间调。它不出彩，但也永不出错，是无脑安全牌。
- **反差 —— 戏剧的开关**：同样是低调，高反差是黑色电影（film noir）的刀锋，低反差是王家卫的烟雾。反差越大，观众心跳越快；反差越小，画面越"佛"。
- **黑位 —— 质感的分水岭**：暗部压成死黑（crushed blacks）是风格，暗部保留层次（shadow detail）是质感。AI 视频模型默认容易把暗部糊成一坨黑，**不写清楚黑位，低调画面大概率翻车**。

---

## 三、分题材实战指南

### 3.1 人像

| 场景 | 推荐影调 | 原因 |
|---|---|---|
| 美妆 / 护肤 / 少女写真 | 高调 + 低反差 | 皮肤通透、瑕疵隐形、纯净感 |
| 时尚大片 / 杂志风 | 中间调 + 高反差 | 轮廓硬朗、有力量感 |
| 男性人像 / 商务肖像 | 低调 + 中高反差 | 沉稳、权威、高级感 |
| 古典油画风人像 | 明暗对照法（chiaroscuro） | 伦勃朗式布光，面部从暗中浮现 |
| 情绪化特写 | 中低调 + 低反差 | 含蓄、留白、让观众读眼神 |

### 3.2 风景 / 城市

- 大场景风光：**全长调**，从阴影到高光都有细节，画面壮阔通透。
- 日出日落剪影：**silhouette**，主体压成全黑，天空烧出色彩。
- 城市夜景：**低调 + 高反差**，霓虹亮部点缀在暗部海洋里。
- 雾天 / 雪景：**低反差 + 高调**，灰白层次营造空灵。

### 3.3 产品 / 电商

- 奢侈品（腕表、珠宝、香水）：**低调 + 高反差 + 暗部保留层次**，一束光扫过金属表面。
- 食品 / 饮品：**中高调 + 中反差**，明亮通透激发食欲。
- 数码产品：**中低调 + 高反差**，屏幕亮部从暗背景中弹出。

### 3.4 叙事 / 影视

- 悬疑 / 惊悚：**低调 + 高反差 + 死黑**，黑暗本身就是悬念。
- 黑色电影（film noir）：**低调 + 极高反差 + 硬光**，百叶窗条纹阴影。
- 文艺片 / 回忆段落：**低反差 + 中低调**，灰调柔化时间感。
- 喜剧 / 综艺：**高调 + 中反差**，明亮是笑点的视觉底色。

---

## 四、黑位的学问（Agent 必须掌握的细节）

### 4.1 两种黑位策略

| 策略 | 英文 | 视觉效果 | 适用场景 |
|---|---|---|---|
| **死黑压暗** | crushed blacks | 暗部无细节，纯黑色块 | 风格化、悬疑、潮流 MV、film noir |
| **保留暗部层次** | shadow detail retained | 暗部有纹理、看得出发丝与布料 | 质感片、奢侈品、电影感叙事 |

### 4.2 AI 视频的暗部陷阱

**这是视频生成中最容易翻车的一条规则**：

1. AI 视频模型对"dark"的默认理解是**糊成一坨黑**——噪点、色块、细节全失。
2. 写 `low key lighting` 时**必须追加黑位描述**：
   - 要质感 → 追加 `shadow details visible, subtle texture in dark areas`
   - 要风格 → 追加 `crushed blacks, pure black shadows`
3. **低调画面的噪点风险**：真实摄影中暗部拉亮会出噪点，AI 模型"学会"了这个特征，生成低调画面时可能自带脏噪点。对抗方法：加 `clean shadows, noise-free, pristine image quality`。
4. 同理，高调要防止模型理解成"过曝"：加 `properly exposed subject, not overexposed` 锁定主体曝光。

---

## 五、影调与光比的联动（联动 LIGHT-001）

> **光比 = 主光与辅光的亮度差**。影调管"整体明暗分布"，光比管"局部明暗落差"，两者共同决定画面硬度。

| 组合 | 效果 | 典型用途 |
|---|---|---|
| 大光比 + 低调 | 极强戏剧性，半脸明半脸暗 | 悬疑片、黑帮片、男性肖像 |
| 大光比 + 高调 | 亮背景中的锐利轮廓 | 时尚硬照、逆光剪影 |
| 小光比 + 高调 | 柔和无阴影，轻盈通透 | 美妆、母婴、日系 |
| 小光比 + 低调 | 暗而柔，烟雾般的含蓄 | 文艺片、情绪短片、酒吧氛围 |

- 提示词写法：大光比 → `harsh lighting ratio, strong shadow contrast, single hard light source`；小光比 → `soft even lighting, minimal shadows, diffused fill light`。
- 记忆：**"光比定软硬，影调定轻重"**——写提示词时两者都要给，只给一个模型会自由发挥。

---

## 六、创作意图 → 提示词关键词映射表（Agent 核心调用区）

> 规则：**提示词里不要只写"影调"抽象词**（多数视频模型无效），按本表翻译成明暗分布 + 反差 + 黑位的具体视觉语言。中英文都给，英文关键词对国际模型更有效。

### 6.1 基调方向（亮 ↔ 暗）

| 创作意图 | 中文提示词写法 | 英文关键词 |
|---|---|---|
| 高调、轻盈通透 | 高调照明，画面明亮通透，背景纯净偏白 | high key lighting, bright airy, clean white background |
| 日系空气感 | 高调柔光，微微过曝的梦幻感，空气般轻盈 | bright and airy, slightly overexposed glow, Japanese airy style |
| 日常明亮 | 自然明亮的照明，画面清爽 | bright natural lighting, well-lit, fresh and clean |
| 中间调、均衡 | 曝光均衡，中间调为主，真实自然 | balanced mid-tones, natural exposure, evenly lit |
| 低调、深沉 | 低调照明，画面以暗部为主，亮部仅勾勒主体 | low key lighting, dark moody, shadows dominate the frame |
| 暗黑高级感 | 大面积深黑背景，主体被一束光点亮 | dark moody atmosphere, dramatic low key, deep black background |

### 6.2 反差方向（硬 ↔ 柔）

| 创作意图 | 中文提示词写法 | 英文关键词 |
|---|---|---|
| 高反差、戏剧 | 高反差光影，黑白分明，强烈的明暗切割 | high contrast, dramatic lighting, stark blacks and whites |
| 黑色电影 | 黑白高反差，硬光，百叶窗阴影 | film noir, hard shadows, venetian blind shadows, black and white high contrast |
| 低反差、柔和 | 低反差柔和影调，灰调过渡，雾感 | low contrast, soft muted tones, flat profile, hazy |
| 后期空间大 | 低反差平调，灰片质感，保留全部层次 | flat color profile, log-like tones, maximum dynamic range |

### 6.3 黑位与暗部（质感开关）

| 创作意图 | 中文提示词写法 | 英文关键词 |
|---|---|---|
| 死黑风格 | 暗部压成纯黑，无细节，风格化 | crushed blacks, pure black shadows, no shadow detail |
| 暗部有层次 | 暗部保留纹理细节，发丝与布料在暗中可见 | shadow detail retained, rich shadow texture, visible detail in dark areas |
| 干净暗部 | 暗部纯净无噪点，画质干净 | clean shadows, noise-free, pristine image quality |
| 亮部不过曝 | 高光保留细节，主体曝光准确 | highlight detail preserved, properly exposed subject, not overexposed |

### 6.4 特殊影调（剪影 / 明暗对照法）

| 创作意图 | 中文提示词写法 | 英文关键词 |
|---|---|---|
| 剪影 | 主体呈纯黑剪影，背景明亮绚烂 | silhouette against bright background, backlit subject, black outline |
| 日出剪影 | 人物黑色轮廓立于日出天空前 | silhouette at sunrise, dark figure against glowing sky |
| 明暗对照法 | 明暗对照布光，人物从黑暗中浮现，油画质感 | chiaroscuro lighting, figure emerging from darkness, painterly |
| 伦勃朗式 | 伦勃朗光，脸颊三角光斑，古典肖像感 | Rembrandt lighting, triangle of light on cheek, classical portrait |
| 卡拉瓦乔式 | 卡拉瓦乔式强烈明暗，戏剧性光束切割黑暗 | Caravaggio style, dramatic shaft of light, tenebrism |

---

## 七、提示词模板（Agent 直接填空调用）

### 模板 A：高调美妆视频

```
[人物描述]，[动作/表情]，高调照明，画面明亮通透，
背景[纯白/浅色环境]，皮肤柔和无瑕，低反差，整体纯净治愈，
主体曝光准确不过曝。High key lighting, bright and airy,
soft flawless skin, low contrast, properly exposed.
```

示例：
> 一位年轻女性侧脸涂抹精华，闭眼微笑，高调照明，画面明亮通透，背景纯白纱帘，皮肤柔和无瑕，低反差，整体纯净治愈，主体曝光准确不过曝。High key lighting, bright and airy, soft flawless skin, clean white background, low contrast.

### 模板 B：低调奢侈品视频

```
[产品描述]置于深黑背景中，低调照明，一束[方向]光扫过[材质表面]，
高反差，亮部仅勾勒产品轮廓与高光线条，暗部保留细腻层次无噪点，
神秘高级。Low key lighting, dark moody, single dramatic light beam,
shadow detail retained, luxury atmosphere.
```

示例：
> 一块机械腕表置于深黑丝绒背景中，低调照明，一束侧逆光扫过表壳金属表面，高反差，亮部仅勾勒表圈轮廓与指针高光，暗部保留丝绒纹理无噪点，神秘高级。Low key lighting, single dramatic light beam, brushed metal highlights, shadow detail retained, luxury atmosphere, slow orbit shot.

### 模板 C：明暗对照人像视频

```
[人物描述]，明暗对照法布光，人物从大面积黑暗中被[方向]光雕刻而出，
面部[三角光/半明半暗]，油画质感，古典庄严，暗部深沉但保留层次。
Chiaroscuro lighting, Rembrandt lighting, painterly light and shadow,
figure emerging from darkness, rich shadow detail.
```

示例：
> 一位老者低头读信，明暗对照法布光，人物从大面积黑暗中被左侧窗光雕刻而出，面部半明半暗、暗脸颊带三角光斑，油画质感，古典庄严，暗部深沉但保留衣料纹理。Chiaroscuro lighting, Rembrandt lighting, painterly, figure emerging from darkness, rich shadow texture.

### 模板 D：高反差纪实视频

```
[场景/人物描述]，高反差影调，硬光直射，黑白分明，
阴影锐利如刀切，中间调压缩，画面硬朗有力量，
[可选：黑白画面]。High contrast, dramatic hard lighting,
stark blacks and bright highlights, gritty documentary feel.
```

示例：
> 正午的工地，工人弯腰搬运钢筋，高反差影调，硬光直射，黑白分明，安全帽下的阴影锐利如刀切，中间调压缩，画面硬朗有力量，黑白画面。High contrast, dramatic hard lighting, stark blacks and bright highlights, gritty documentary feel, black and white.

### 模板 E：剪影情绪视频（进阶）

```
[主体]呈纯黑剪影，立于[明亮背景：日出/霓虹/窗户]前，
极致反差，主体无细节全黑，背景[色彩/光效]绚烂，
缓慢[运镜]。Silhouette against bright background, extreme contrast,
backlit subject, black outline against glowing sky.
```

---

## 八、意图 → 影调 → 提示词 决策流程（Agent 推理链）

```
用户意图（情绪重量）
  │
  ├─ "轻盈/纯净/治愈/明亮" → 高调（high key）
  │     → 提示词：high key lighting + bright airy + not overexposed
  │
  ├─ "日常/真实/客观记录" → 中间调（mid key）
  │     → 提示词：balanced mid-tones + natural exposure
  │
  ├─ "高级/神秘/力量/男性向" → 低调（low key）
  │     → 提示词：low key + dark moody
  │        ├─ 要质感 → 追加 shadow detail retained + noise-free
  │        └─ 要风格 → 追加 crushed blacks
  │
  ├─ "壮阔/史诗/风光大片" → 全长调（full range）
  │     → 提示词：full tonal range + detailed highlights and shadows
  │
  ├─ "戏剧/紧张/冲突" → 高反差（high contrast）
  │     → 提示词：high contrast + dramatic + stark blacks and whites
  │        └─ 黑白极端 → film noir + hard shadows
  │
  ├─ "温柔/怀旧/灰调" → 低反差（low contrast）
  │     → 提示词：low contrast + soft muted tones + hazy
  │
  ├─ "图形化/仪式感/日出日落" → 剪影（silhouette）
  │     → 提示词：silhouette against bright background + backlit
  │
  └─ "古典/油画感/庄严" → 明暗对照法（chiaroscuro）
        → 提示词：chiaroscuro / Rembrandt lighting + painterly
```

---

## 九、常见误区（生成提示词时的纠错规则）

| 误区 | 纠正 |
|---|---|
| "画面越亮越好" | 亮只是高调一种选择；低调的高级感、悬疑感无法被亮替代。影调服务情绪，不是越亮越正确 |
| "低调 = 没打光的废片" | 恰恰相反。低调的每一处亮部都是精准打出来的，暗部层次更需要控制；低调是布光难度最高的影调 |
| "影调和色调是一回事" | 完全独立。色调管色彩冷暖浓淡（COLOR-001），影调管明暗分布，可自由组合（如暖调低调、冷调高调） |
| "写 dark 模型就懂低调" | 模型默认把 dark 理解成糊黑一团，必须追加黑位描述（shadow detail 或 crushed blacks）并加 noise-free |
| "剪影就是主体没曝光" | 剪影是主动的极致反差设计：主体纯黑 + 背景绚烂，两者缺一不可，只写 dark subject 会得到废片 |
| "高反差 = 高级" | 高反差是戏剧工具不是档次。美妆、母婴恰恰需要低反差；反差强弱取决于情绪目标 |
| "低反差画面灰蒙蒙是失误" | 低反差/flat 是刻意的柔和美学，也为后期保留空间；与"曝光不足的发灰"是两回事 |
| "明暗对照法只适用于黑白" | chiaroscuro 是明暗结构技法，彩色画面同样适用（烛光晚餐、电影布光都是彩色 chiaroscuro） |

---

## 十、关联知识（后续主题预留）

- COLOR-001 色调与配色（冷暖色温、配色方案——影调的独立搭档）
- LIGHT-001 光线方向与质感（顺光/侧光/逆光/光比——决定影调的物理来源）
- OPTICS-004 ISO 与噪点（低调画面的噪点控制、暗部信噪比）
- STYLE-001 影像风格谱系（film noir、日系、胶片等风格的影调配方）

> 影调 = 基调 × 反差 × 黑位，三者与光比（LIGHT-001）、色调（COLOR-001）联合作战。生成提示词时建议 COLOR-001、COLOR-002 与 LIGHT-001 联合检索。
