# 题材调色美学（Genre Color Aesthetics）领域知识库

> **用途**：调色工位与数字员工的美学决策底座。回答"为什么这个题材要配这个 profile、这个 intensity、这条 avoid"。
> **主题编号**：CGRADE-004　**版本**：v1.0　**更新日期**：2026-09-27
> **使用方式**：Agent 在调用 `colorread.recipes` / `colorwrite.best` 之前检索本主题，理解配方库（`library/color-recipes/recipes.json`，13 条）与 8 个内置 profile（`connectors/color-bridge/core.mjs` 的 `PROFILES`）背后的美学逻辑。**配方库是唯一选型来源，本文是它的"为什么"**，不替代配方，只解释配方。

---

## 一、核心概念

### 1.1 题材调色美学是什么

调色不是"把画面调好看"，而是**把内容意图翻译成色彩语言**。同一个 profile，用在美食上是"诱人"，用在纪录片上就是"造假"——美学判断的第一变量永远是题材，不是口味。

> **颜色不是审美口味的自由发挥，是内容意图的翻译。**（引自 color-look-design SKILL）

三条不可动摇的总纲（配方库 `principle` 字段原文）：

1. **先校正后创作**：白平衡 / 曝光 / 裁切先修到位（100% 生效），再按 intensity 叠加题材色调。用饱和度掩盖白平衡问题是本岗位最隐蔽的错误。
2. **肤色优先于风格**：肤色 hue 必须落在 20–40°、sat≤60，任何 look 都不得突破。
3. **一个项目只用一套 look**：同一支片子风格跳变 = 观众出戏。

### 1.2 四个杠杆：情绪的全部来源

所有题材配方的差异，拆解到底只有四个杠杆的组合：

| 杠杆 | 调高的效果 | 调低的效果 | 配方中的落点 |
|---|---|---|---|
| **色温** | 暖→亲密、食欲、怀旧 | 冷→冷静、精密、疏离 | warm-film 的 colorbalance 红加蓝减；cool-technical 反向 |
| **饱和度** | 高→活力、冲动、商业 | 低→高级、克制、纪实 | festival-promo SATAVG 60–90；luxury-brand 25–50 |
| **对比度** | 高→戏剧、张力、锐利 | 低→柔和、灰调、留白 | high-contrast-social contrast=1.22；vintage-fade 0.97 |
| **影调**（明暗分布） | 亮→轻盈、通透、可信 | 暗→神秘、高级、重量感 | real-estate YAVG 100–145；night-city 允许 70–120 |

> 记忆口诀：**"色温定冷暖，饱和定浓淡，对比定戏剧，影调定轻重"**。13 条配方 = 这四根杠杆在 13 个题材上的标准答案。

### 1.3 intensity 的美学含义：风格是"剂量"

配方的 intensity 不是技术余量，是**题材对"风格可见度"的容忍度**：

- **0.4（documentary-natural）**：观众不该意识到"这片子调过色"——风格感本身就是可信度损失。
- **0.5–0.6（beauty-makeup / talking-head / kids-family / real-estate / outdoor-travel）**：主体（脸、孩子、空间、天空）的真实感是核心资产，风格只能作陪衬。
- **0.7–0.85（product-hero / automotive / night-city / festival-promo / food-appetite）**：画面本身就是表演，风格必须被看见，但仍不满档——留一分是防止 LUT 把材质与商品色推偏。

> intensity 的本质：**观众应该感受到情绪，但不应该看到滤镜。**

---

## 二、分类速查

### 2.1 八个 profile 的风格谱系（从"干净"到"风格化"）

按风格化程度排列（参数见 `core.mjs` 的 `PROFILES`，以下为满档 intensity=1.0 的画面语言）：

| 序 | profile | 核心手法（滤镜语义） | 美学定位 | 适用题材 | 滥用风险 |
|---|---|---|---|---|---|
| 1 | **natural** | eq 微调 contrast 1.03 / sat 1.04 | "修而不饰"，只做还原 | 纪录、科普、新闻 | 当万能药：它是底线不是风格 |
| 2 | **clean-bright** | curves 提亮中部 + sat 1.14 + gamma 1.05 | 干净、通透、可信 | 产品、美妆、亲子、房产 | 用在夜景/悬疑上＝破坏氛围 |
| 3 | **warm-film** | colorbalance 红加蓝减 + 黑位抬至 0.045 | 温暖、亲和、有胶片温度 | 访谈、美食 | 暖黄过头→油光浑浊、肤色疲惫 |
| 4 | **cool-technical** | colorbalance 蓝加红减 + sat 0.93 | 冷静、精密、前沿 | 科技、SaaS、汽车 | 冷调过头→屏幕白变蓝、人脸发灰 |
| 5 | **teal-orange** | 阴影青蓝（bs=0.22）高光橙（rh=0.17）+ contrast 1.15 | 戏剧、电影感、商业大片 | 旅拍、夜景、促销 | 天空变塑料蓝、肤色被染橙 |
| 6 | **moody-dark** | 暗部下沉曲线 + sat 0.76 + brightness -0.035 | 克制、低饱和、高级感 | 高端品牌、汽车（LUT） | 压黑过头→材质死黑、噪点放大 |
| 7 | **high-contrast-social** | 深 S 曲线 + contrast 1.22 + sat 1.18 | 抓眼、刺激、小屏优先 | 节日促销、直播切片 | 用在人像/美食上＝廉价且脏 |
| 8 | **vintage-fade** | 黑位抬 0.075 + 顶部压 0.92 + sat 0.84 + contrast 0.97 | 褪色、怀旧、记忆感 | 复古、回忆杀、人文 | 用在产品/科技上＝显旧显脏 |

> 谱系直觉：**左半段（1–4）卖"可信"，右半段（5–8）卖"情绪"**。商业内容的绝大多数需求落在左半段——这是配方库 13 条里 clean-bright 占 4 条的根本原因。

### 2.2 13 条配方总览（美学定位速查）

| 配方 id | 题材 | profile | intensity | 一句话美学 |
|---|---|---|---|---|
| product-hero | 产品广告 | clean-bright | 0.7 | 白底真白，商品本色优先于风格 |
| talking-head | 访谈/口播 | warm-film | 0.6 | 人脸是唯一主角，背景可去饱和 |
| food-appetite | 美食 | warm-film | 0.85 | 红黄推进，但白瓷盘仍读作白 |
| tech-dark-ui | 科技/SaaS | cool-technical | 0.65 | 冷调只给环境，UI 白必须准 |
| outdoor-travel | 旅拍 | teal-orange | 0.6 | 天空植被色相要可信 |
| night-city | 夜景都市 | teal-orange | 0.75 | 允许暗，但暗部裁切 <3% |
| beauty-makeup | 美妆 | clean-bright | 0.5 | 肤色真实是第一诉求，禁美白式提亮 |
| kids-family | 亲子 | clean-bright | 0.6 | 整体提亮+轻暖，禁任何压黑 |
| automotive | 汽车 | cool-technical | 0.7 | 车漆是品牌资产，金属层次优先 |
| real-estate | 房产空间 | clean-bright | 0.55 | 要"通透"不要"艳丽"，饱和≤55 |
| festival-promo | 节日促销 | high-contrast-social | 0.8 | 高饱和只给画面，不给文字 |
| documentary-natural | 纪录科普 | natural | 0.4 | 只做还原，风格强度≤0.4 |
| luxury-brand | 高端品牌 | moody-dark | 0.6 | 去饱和，黑位"深而不死" |

---

## 三、分场景实战

> 本章逐条解读 13 条配方的美学依据：**为什么是这个 profile、为什么是这个 intensity、avoid 条款背后的原理。**

### 3.1 product-hero（产品广告 · clean-bright @0.7）

- **为何 clean-bright**：电商场景消费者的第一疑问是"实物是不是这样"，干净通透 = 可信。curves 中部上抬让白底真白（YMAX≥240），商品从背景中"立"起来。
- **为何 0.7**：风格要可见（区别于随手拍），但满档会让 sat 1.14 推偏商品本色——商品色是购买决策依据，失真即退货。
- **avoid"重青橙显廉价"为何成立**：青橙（teal-orange）的本质是"戏剧化的色彩分离"，观众看到青橙会下意识读作"电影/广告大片"而非"真实商品"，且阴影青蓝会污染白底与产品固有色——**风格感越强，商品可信度越低**，这就是"显廉价"的心理机制。

### 3.2 talking-head（访谈/口播 · warm-film @0.6）

- **为何 warm-film**：暖调拉近心理距离，口播内容的货币是"信任"，warm-film 的黑位微抬（0.045）给面部一层胶片式的柔。
- **为何 0.6**：人脸是绝对主体，强度再高 skinGuard 也兜不住——观众对肤色的偏差极其敏感，对背景的偏差几乎无感，所以背景可以放心去饱和，面部必须保守。
- **avoid 原理**："肤色推向橙红"= 显疲惫（橙红是晒伤/熬夜的视觉联想）；"对比过强"= 面部阴影变脏，亲和力崩塌。

### 3.3 food-appetite（美食 · warm-film @0.85）

- **为何 warm-film 且全库最高强度之一**：暖色（红黄轴）激发食欲是生理级的——熟肉、烘焙、油炸的"熟成信号"都在暖区。0.85 的底气来自美食画面主体本身就是高饱和暖色，风格与内容同向叠加不冲突。
- **avoid 原理**："过度暖黄→油光变浑浊"——暖黄一旦侵入白色参照物（瓷盘、台布），观众大脑会判定"灯光脏"进而推断"食物不新鲜"。**白色参照物必须读作中性白，这是暖调美食片的锚点。**

### 3.4 tech-dark-ui（科技/SaaS · cool-technical @0.65）

- **为何 cool-technical**：冷色 = 精密、理性、未来，sat 0.93 的去饱和呼应"工程师审美"。
- **avoid 原理**："冷调过头→屏幕白变蓝"——UI 是交付物本身，界面白读作蓝等于告诉客户"我们产品有色偏"。所以冷调只加在环境与高光，**UI 本体的白平衡是禁区**。

### 3.5 outdoor-travel（旅拍 · teal-orange @0.6）

- **为何 teal-orange**：户外是青橙的出生地——天空/水体天然在青蓝区，肤色/沙土/阳光在橙区，青橙只是**放大自然中已存在的互补**，所以它在旅拍上永远不违和。
- **为何只 0.6**：teal-orange 满档时 bs=0.22 会把天空推成"塑料蓝"——饱和度极高的均匀蓝色块是廉价滤镜的第一指纹。0.6 保留云层层次与植被色相的可信度。

### 3.6 night-city（夜景 · teal-orange @0.75）

- **为何比旅拍强度高**：夜景的霓虹/车灯/钨丝灯本身就是高对比冷暖光源，青橙顺应现实光色，0.75 也不显假。YAVG 允许下探到 70（白天下限 80）——**黑是夜景的合法组成部分**。
- **avoid 原理**："暗部压死→噪点被放大"——传感器噪点集中在暗部，压黑后再提亮是噪点显影；"高光溢出→灯牌糊成一片"，灯牌的形状信息一旦丢失，夜景的"都市感"也随之丢失。

### 3.7 beauty-makeup（美妆 · clean-bright @0.5）

- **为何全库最低创作强度之一**：美妆的商业逻辑是"效果真实可信"，观众买精华是因为相信"用完皮肤就是这样"。任何可见的风格化都在削弱这个论证。
- **avoid 原理**："美白式提亮"与"磨皮感"同罪——**肤质纹理是信任的载体**，纹理没了，产品功效的说服力也没了。

### 3.8 kids-family（亲子 · clean-bright @0.6）

- **美学核心**：亲子题材要"轻"——高明度、低对比、轻暖调。压黑、低调、冷调都与"家庭温暖"的语义冲突，所以 avoid 直接禁掉"对比过强"和"冷调"。

### 3.9 automotive（汽车 · cool-technical @0.7 + look-moody-dark.cube）

- **为何 cool-technical**：冷调 + 去饱和呼应金属、工程、性能。LUT 选 moody-dark 是因为汽车广告的主流视觉是"暗夜一束光扫过车身"。
- **avoid 原理**："车漆色相偏移"是红线中的红线——车漆颜色是品牌资产（想想某品牌的红），偏一度都是事故；金属高光的层次比整体亮度重要，高光爆掉 = 车身质感归零。

### 3.10 real-estate（房产 · clean-bright @0.55）

- **美学核心**：房产卖的是"采光"和"空间感"，两者都靠"通透"传达。饱和度上限压到 55，因为艳色会让空间显"假"（像效果图而非实景）；窗景高光必须保层次——**窗外过曝 = 采光说服力归零**。

### 3.11 festival-promo（节日促销 · high-contrast-social @0.8）

- **为何唯一用这个 profile**：促销内容的战场是小屏信息流，0.5 秒内必须抓住眼球——contrast 1.22 + sat 1.18 是为小屏+快速滑动设计的武器。
- **avoid 原理**："高饱和只给画面不给文字"——价格是转化信息，红金堆砌把字幕淹掉，画面赢了、转化输了。

### 3.12 documentary-natural（纪录 · natural @0.4）

- **美学核心**：纪录片的货币是可信度，"看得出调色"= 观众开始怀疑内容本身也被加工过。只做还原（白平衡/曝光到位），风格强度 0.4 封顶——**这是"克制即美学"的极端形态**。

### 3.13 luxury-brand（高端品牌 · moody-dark @0.6）

- **为何 moody-dark**：奢侈的视觉语法是"少"——去饱和（sat 0.76）、低明度、大面积暗。"暗"关联稀有与克制，这是低调影调的高级感捷径（参见 COLOR-002）。
- **avoid 原理**："压黑过头→材质死黑"——奢侈品恰恰靠材质（皮革纹理、金属拉丝）立信，黑位要"深而不死"（暗部裁切 <1%），比 documentary 更严格。

---

## 四、视频特有规则

1. **批次纪律：一个项目只用一套 look**。美学依据：观众对色彩风格的适应是"校准式"的——开场 3 秒大脑完成对本片色彩基准的校准，此后所有镜头都按这个基准解读。中途换 look 等于不断重置观众的校准，产生"这一段不属于这部片子"的出戏感。平台变体只能从**已调色母版**派生，禁止二次调色。
2. **log/HLG 素材先转换再创作**：先套 `slog3-to-rec709.cube`，禁止在平素材上直接叠创意 LUT——灰底上叠 LUT 得到的是双倍不可控的偏色。
3. **intensity 只稀释创作段**：校正（白平衡/曝光/裁切）恒 100% 生效，只有 look 按 intensity 混合。美学含义：**"修对"是义务，"调味"是选择**。
4. **夜景不硬套白天下限**：YAVG 允许低于 80 但必须留痕，暗部裁切比 <3%。硬按白天标准提亮夜景，噪点显影反而更廉价。
5. **有人脸就复检肤色**：任何题材，只要画面出现人脸，按 talking-head 的标准复检（hue 20–40°、sat≤60），肤色优先于题材风格。
6. **可见性校验是美学防线**：调了跟没调一样（像素差 <2/255）会被系统拒绝交付——"看不出差别的调色"本身就是不合格的美学决策。

---

## 五、常见误区

| 误区 | 纠正 |
|---|---|
| "颜色越艳越抓眼，促销片就该拉满" | 拉满后文字与商品色一起被淹。festival-promo 的纪律是"高饱和只给画面不给文字"，饱和有预算，要花在刀刃上 |
| "青橙是电影感，什么题材都能套" | 青橙是"戏剧化的色彩分离"，套在产品片上会污染商品本色、显廉价（product-hero avoid 第一条）；它的合法领土是旅拍、夜景、促销 |
| "高级感 = 压黑 + 低饱和" | 只对一半。luxury-brand 的黑位要求"深而不死"（裁切 <1%），压死黑丢的是材质——高级感恰恰住在暗部层次里 |
| "美妆片提亮 = 专业" | 美白式提亮让肤质失真，观众要的是"可信的皮肤"不是"发光的面具"。beauty-makeup 强度压到 0.5 的原因在此 |
| "纪录片也可以来点风格化" | 观众一旦意识到"这片子调过色"，就会连带怀疑内容被加工。documentary-natural 0.4 封顶是可信度的保险费 |
| "美食片暖调越浓越开胃" | 暖黄侵入白瓷盘时，大脑判定"灯光脏→食物不新鲜"。白色参照物必须读作中性白，这是暖调的天花板 |
| "一个系列换几个 look 试试新鲜感" | 同项目风格跳变 = 观众出戏。新鲜感应该来自内容与剪辑，不是色彩基准的漂移 |
| "夜景太暗，按白天标准提亮" | 黑是夜景的合法组成部分；提亮放大噪点反而廉价。night-city 允许 YAVG 70–120 并留痕 |
| "intensity 是技术参数，随便给" | intensity 是题材对风格可见度的容忍度：纪录片 0.4、美妆 0.5、美食 0.85，每个数字背后都是美学判断 |
| "给已经很棒的成片再加个 look 锦上添花" | 给好画面上妆只会弄坏它（do-no-harm）。第零问判"无需调色"时一个文件都不产出 |

---

## 六、意图→参数映射表

> 规则：意图先映射到**配方 id**（首选）或 **profile + intensity**（配方未覆盖时的兜底），参数名与 `core.mjs` 的 `PROFILES` / recipes.json 严格一致。

| 创作意图 | 中文写法 | 英文关键词/参数 |
|---|---|---|
| 商品可信、白底干净 | 产品广告配方，白底真白，商品本色优先 | recipe: `product-hero` / profile `clean-bright` @0.7 |
| 口播可信、亲和 | 访谈配方，暖调胶片，肤色优先，背景去饱和 | recipe: `talking-head` / profile `warm-film` @0.6, skinGuard |
| 食物诱人、有食欲 | 美食配方，红黄推进，白瓷盘读作中性白 | recipe: `food-appetite` / profile `warm-film` @0.85, SATAVG 55–85 |
| 科技感、冷静精密 | 科技配方，冷调去饱和，UI 白不动 | recipe: `tech-dark-ui` / profile `cool-technical` @0.65 |
| 旅拍通透、大片感 | 旅拍配方，轻青橙，天空不变塑料蓝 | recipe: `outdoor-travel` / profile `teal-orange` @0.6 |
| 夜景都市、戏剧感 | 夜景配方，青橙加强，暗部裁切<3% | recipe: `night-city` / profile `teal-orange` @0.75, YAVG 70–120 |
| 美妆通透、肤质真实 | 美妆配方，强度减半，禁美白式提亮 | recipe: `beauty-makeup` / profile `clean-bright` @0.5 |
| 亲子温暖、明亮轻盈 | 亲子配方，提亮+轻暖，禁压黑 | recipe: `kids-family` / profile `clean-bright` @0.6, YAVG 100–140 |
| 汽车强劲、金属质感 | 汽车配方，冷调+暗夜 LUT，车漆色不偏 | recipe: `automotive` / profile `cool-technical` @0.7 + `look-moody-dark.cube` |
| 空间通透、采光可信 | 房产配方，饱和≤55，窗景保层次 | recipe: `real-estate` / profile `clean-bright` @0.55 |
| 促销热烈、小屏抓眼 | 促销配方，高对比高饱和，文字不受损 | recipe: `festival-promo` / profile `high-contrast-social` @0.8, SATAVG 60–90 |
| 纪录真实、修而不饰 | 纪录配方，只做还原，强度≤0.4 | recipe: `documentary-natural` / profile `natural` @0.4 |
| 高端克制、低饱和质感 | 高端品牌配方，去饱和，黑位深而不死 | recipe: `luxury-brand` / profile `moody-dark` @0.6, SATAVG 25–50 |
| 怀旧褪色、记忆感 | 褪色胶片 look，黑位抬、顶部压、低对比 | profile `vintage-fade` @0.5–0.7（T-14 复古题材候选） |
| 画面发灰/偏色修正 | 先校正后创作：白平衡/曝光/裁切 100% 生效 | corrections（autoCorrections）：normalize + colorbalance + eq |

---

## 七、模板

### 模板 A：配方选型陈述（输出归档用）

```
题材：[题材] ｜ 场景：[棚拍/实景/有无人脸] ｜ 情绪目标：[可信/诱人/冷静/热烈/克制]
配方 id：[xxx] ｜ profile：[xxx] ｜ LUT：[look-xxx.cube / 无] ｜ intensity：[0.x]
目标区间：SATAVG [a,b] / YAVG [a,b] ｜ 本片特例：[如"画面含儿童，按 kids-family 复检肤色"]
禁忌自检：本配方的 avoid 清单逐条确认未命中。
```

示例：
> 题材：美食 ｜ 场景：餐厅实拍，含厨师手部出镜 ｜ 情绪目标：诱人、温暖
> 配方 id：food-appetite ｜ profile：warm-film ｜ LUT：look-warm-film.cube ｜ intensity：0.85
> 目标区间：SATAVG 55–85 / YAVG 95–140 ｜ 本片特例：白瓷盘区域做中性白复检
> 禁忌自检：无过度暖黄、高光未爆。

### 模板 B：第零问判断（要不要调）

```
素材来源：[相机原片 / log 素材 / 生成视频 / 已调色成片母版]
若为已调色母版 → 跑 colorwrite.best：候选池无方案高过原片 2 分
  → 输出"无需调色"，不产出文件（do-no-harm）。
若为原片/log/生成素材 → 先校正（白平衡/曝光/裁切），再按模板 A 选型。
```

### 模板 C：配方未覆盖题材的兜底设计（T-14 流程）

```
1. 定调四问：题材 / 场景与主体 / 情绪目标 / 平台（缺一不动手）；
2. 在情绪→色彩映射表（SKILL 第三节）找到最近的情绪行，确定四杠杆方向；
3. 在八个 profile 谱系中选最近的 profile："卖可信"选左半段（natural/clean-bright/warm-film/cool-technical），"卖情绪"选右半段（teal-orange/moody-dark/high-contrast-social/vintage-fade）；
4. intensity 参照同类题材定级：真实感优先 0.5–0.6，风格可见 0.7–0.85；
5. 写清 avoid（至少一条：本片最核心的"颜色资产"是什么，它不许被怎样）。
```

---

## 八、决策树

```
拿到素材
  │
  ├─ 第零问：是已调色成片母版吗？
  │     ├─ 是 → colorwrite.best 打分：无候选超原片 +2 → 【无需调色，不产出文件】
  │     └─ 否（原片/log/生成）→ 先校正（白平衡/曝光/裁切）→ 进入题材分支
  │
  ├─ 题材判定（定调四问第 1 问）
  │     │
  │     ├─ 卖"可信"（真实感是核心资产）
  │     │     ├─ 商品是主角 → product-hero（clean-bright @0.7）
  │     │     ├─ 人脸是主角 → talking-head（warm-film @0.6，skinGuard）
  │     │     ├─ 肤质是主角 → beauty-makeup（clean-bright @0.5）
  │     │     ├─ 空间/采光是主角 → real-estate（clean-bright @0.55）
  │     │     ├─ 家庭温暖是主角 → kids-family（clean-bright @0.6）
  │     │     └─ 事实本身是主角 → documentary-natural（natural @0.4）
  │     │
  │     ├─ 卖"情绪"（风格感是核心资产）
  │     │     ├─ 食欲冲动 → food-appetite（warm-film @0.85）
  │     │     ├─ 开阔通透 → outdoor-travel（teal-orange @0.6）
  │     │     ├─ 都市戏剧 → night-city（teal-orange @0.75，YAVG 可 70–120）
  │     │     ├─ 购买紧迫 → festival-promo（high-contrast-social @0.8）
  │     │     └─ 高级克制 → luxury-brand（moody-dark @0.6，暗部裁切<1%）
  │     │
  │     └─ 卖"精密"（技术感是核心资产）
  │           ├─ 软件/界面 → tech-dark-ui（cool-technical @0.65，UI 白不动）
  │           └─ 硬件/车 → automotive（cool-technical @0.7 + look-moody-dark.cube）
  │
  ├─ 覆盖检查
  │     ├─ 有人脸？→ 按 talking-head 标准复检肤色（hue 20–40°，sat≤60）
  │     ├─ 有品牌固有色（车漆/口红/商品）？→ 本色优先于风格，偏即回退
  │     └─ 配方未覆盖？→ 走模板 C 兜底，从情绪映射表反推四杠杆
  │
  └─ 批次纪律：全项目锁定同一 profile/LUT/intensity
        → 平台变体只从已调色母版派生，禁止二次调色
```

---

## 九、关联知识

- **CGRADE-001 肤色**：肤色 hue 20–40°、sat≤60 的全部细则。本文所有"skinGuard""肤色优先"条款的技术依据；任何人脸出镜题材的必读前置。
- **CGRADE-003 平台特性**：抖音小屏加对比、小红书忌脏黄、视频号字幕对比度等平台派生规则。本文"平台变体从母版派生"纪律的执行细节在此。
- **COLOR-001 色调与配色 / COLOR-002 影调**（cinematography-kb）：生成侧（写提示词）的色调与影调知识，与本文的后期调色互为前后端——生成时定调、调色时守调。
- **color-look-design SKILL**：定调四问与第零问的原始出处，情绪→色彩映射表、禁忌清单、失败模式处置的操作手册。本文是其美学注解，选型执行以 SKILL 与 recipes.json 为准。
- **recipes.json 与 `core.mjs` PROFILES**：本文全部结论的唯一事实来源。配方更新时本文同步修订。

---

## 附录：T-14 配方扩库的美学定位建议（设计依据）【已落地 2026-09-27】

> 以下 12 个题材已全部落地为 recipes.json 真实配方（库总数 13→25，含 overrides.platformOverrides 平台微调，由 `core.mjs` findRecipes 消费）。表中"→ 配方 id"列为落地后的真实 id；其中房产/汽车/夜景/节庆按既定方向做了子场景细化而非重复建设。

| 新题材 | profile 倾向 | intensity | 核心禁忌 | 美学定位一句话 | → 配方 id |
|---|---|---|---|---|---|
| 婚礼 | clean-bright 偏暖（或 warm-film 低强度） | 0.5–0.65 | 禁冷调、禁压黑、肤色禁偏橙 | 高调轻盈是人生高光时刻的语法 | `wedding-day` |
| 体育 | high-contrast-social | 0.65–0.8 | 禁饱和爆掉队服色、禁慢感柔调 | 力量与速度靠对比度表达 | `sports-event` |
| 游戏/电竞 | cool-technical 或 teal-orange | 0.65–0.8 | 屏幕画面色相不许偏、禁洗白暗场 | 冷调霓虹是玩家文化的母语 | `gaming-esports` |
| 时尚 | moody-dark 或 vintage-fade | 0.55–0.7 | 禁高饱和艳俗、服装本色禁偏 | 时尚的底色是克制，风格交给廓形 | `fashion-editorial` |
| 母婴 | clean-bright | 0.5–0.6 | 禁任何压黑与冷调、肤色从严 | 比 kids-family 更软：高调+低反差 | `baby-family` |
| 房产（细化） | 沿用 real-estate | 0.5–0.6 | 窗景过曝、饱和>55 | 拆分子场景：样板间/毛坯/夜景灯光 | `real-estate-showroom` |
| 汽车（细化） | 沿用 automotive | 0.65–0.75 | 车漆色相偏移 | 拆分子场景：外观/内饰/夜间行驶 | `automotive-night` |
| 金融 | cool-technical 低饱和 或 moody-dark | 0.5–0.6 | 禁暖黄"传销感"、禁高饱和 | 冷、稳、克制=值得托付 | `finance-corporate` |
| 夜景（细化） | 沿用 night-city | 0.7–0.8 | 暗部压死、灯牌糊片 | 拆分子场景：霓虹街区/车流/室内 | `city-night-neon` |
| 阴雨 | natural 或 vintage-fade 低强度 | 0.4–0.55 | 禁强行提亮造假天晴、禁暖调 | 阴雨的灰本身就是情绪，顺它不逆它 | `rain-mood` |
| 复古 | vintage-fade | 0.6–0.75 | 禁黑白死灰（复古≠去色）、禁锐化感 | 褪色三件套：抬黑位+压顶部+降对比 | `retro-film` |
| 节庆（细化） | 沿用 festival-promo | 0.75–0.85 | 文字可读性、商品色失真 | 拆分子场景：春节红金/圣诞冷绿等 | `festival-sale` |

> 设计原则回顾：新配方入库前必须能回答模板 C 的五步——四问、情绪行、profile、intensity 定级、至少一条"颜色资产"禁忌。回答不出的题材不配进库。
