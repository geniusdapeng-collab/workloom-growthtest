# 色调与配色（Color Palette & Color Grade）领域知识库

> **用途**：AI 视频生成系统的提示词知识库。供数字员工 / Agent 在生成视频提示词时检索调用。
> **主题编号**：COLOR-001　**版本**：v1.0　**更新日期**：2026-09-24
> **使用方式**：Agent 接收到涉及"色调、配色、颜色风格、高级感、氛围色、滤镜感"等创作意图时，检索本主题，将抽象色彩意图翻译成具体的色彩构成与调色语言写入提示词。**注意：AI 视频模型不理解色轮理论和色值本身，必须把配色意图翻译成画面可见的颜色描述**（见第六章映射表）。

---

## 一、核心概念

### 1.1 色调是什么

色调（Color Tone / Color Grade）是**画面的主导色彩方案**——观众看到一段视频的前 3 秒，还没看清内容，情绪就已经被色调定调了：

> **色调 = 情绪的第一语言。内容决定观众"看到什么"，色调决定观众"感觉如何"。**

- **暖调**（橙、黄、红主导）→ 温暖、亲密、怀旧、食欲
- **冷调**（青、蓝主导）→ 冷静、疏离、科技、悬疑
- **低饱和灰调** → 高级、克制、文艺、忧郁
- **高饱和艳调** → 活力、年轻、商业、娱乐

同一条街道，青橙色调是商业大片，莫兰迪灰调是文艺片，霓虹色调是赛博朋克——**题材没变，气质全变**。

### 1.2 色彩关系基础（够用就好）

Agent 不需要精通色轮理论，掌握以下四种关系即可覆盖 95% 的配色需求：

| 色彩关系 | 原理 | 视觉效果 | 典型应用 |
|---|---|---|---|
| **互补色** | 色轮上相对的两色（青↔橙、蓝↔黄、品红↔绿） | 对比冲击、张力强、主体跳出 | 商业大片、海报、动作戏 |
| **邻近色** | 色轮上相邻的色（蓝-青-绿、橙-黄-红） | 和谐统一、过渡自然、不刺眼 | 自然风光、日系清新、生活记录 |
| **单色系** | 同一色相的深浅变化 | 高级克制、极简、聚焦 | 静物、时尚、品牌片 |
| **三角色** | 色轮上等距三色（红-黄-蓝、橙-绿-紫） | 活泼平衡、丰富不乱 | 动画、综艺、韦斯安德森式构图 |

> 提示词组合技巧：互补色最出效果也最安全——"一个主色 + 一个对比点缀色"的描述结构（如"青色环境 + 橙色主体"）比罗列五种颜色稳定得多。

### 1.3 饱和度与明度是独立维度（Agent 最常混淆的一点）

选配色方案（色相）只是第一步，**饱和度**和**明度**是两个独立的调节轴，同样一组色相，调这两个轴能得到完全不同的气质：

| 维度 | 往高调 | 往低调 |
|---|---|---|
| **饱和度**（颜色浓淡） | 高饱和 = 活力、刺激、商业、娱乐感 | 低饱和 = 高级灰、克制、文艺、电影感 |
| **明度**（画面亮暗） | 高明度 = 轻盈、通透、干净、少女感 | 低明度 = 沉重、神秘、压抑、悬疑感 |

组合速记：
- **高饱和 + 高明度** → 糖果马卡龙、少女、甜品
- **高饱和 + 低明度** → 赛博霓虹、夜店、冲击力
- **低饱和 + 高明度** → 莫兰迪、日系小清新、高级温柔
- **低饱和 + 低明度** → 墨绿暗黑、悬疑、纪实

记忆口诀：**"色相定风格，饱和定浓淡，明度定轻重"**——三者必须在提示词中分别给出，缺一不可。

---

## 二、经典配色全表（核心速查）

| 配色 | 色彩构成 | 情绪气质 | 代表影视参考 | 适用题材 | AI 提示词写法 |
|---|---|---|---|---|---|
| **青橙**<br>Teal and Orange | 环境/阴影偏青蓝 + 主体/肤色偏暖橙 | 商业、大片感、通透有张力 | 《疯狂的麦克斯4》《变形金刚》几乎所有好莱坞动作片 | 商业广告、动作、旅行、城市、人物 | teal and orange color grade, cyan shadows warm highlights, Hollywood blockbuster look |
| **黑金**<br>Black and Gold | 大面积深黑 + 金色高光点缀 | 奢华、权力、高端、仪式感 | 《了不起的盖茨比》、高端酒类/腕表广告 | 奢侈品、金融、发布会、夜景 | black and gold palette, luxurious gold accents on deep black, premium look |
| **莫兰迪**<br>Morandi Muted Tones | 低饱和灰调：灰粉、灰蓝、灰绿、燕麦色，色相间微差 | 高级、温柔、安静、克制 | 莫兰迪静物画、《布达佩斯大饭店》部分内景 | 静物、家居、生活方式、文艺片、女装 | muted morandi tones, desaturated greyish palette, soft elegant, low saturation |
| **糖果马卡龙**<br>Pastel / Candy Colors | 高明度低-中饱和：粉、薄荷绿、鹅黄、淡紫，平涂感 | 甜美、梦幻、少女、治愈 | 韦斯安德森《布达佩斯大饭店》《法兰西特派》、甜品广告 | 甜品、美妆、少女、宠物、动画 | pastel color palette, candy colors, soft pink and mint, Wes Anderson style |
| **赛博霓虹**<br>Neon Cyberpunk | 品红 + 青 + 紫三色霓虹，黑底高对比 | 未来、迷幻、都市夜、科技感 | 《银翼杀手2049》《攻壳机动队》 | 夜景城市、科技、电竞、音乐视频 | cyberpunk neon palette, magenta and cyan neon lights, purple haze, futuristic night city |
| **墨绿暗黑**<br>Dark Moody Green | 深墨绿 + 黑 + 少量暖黄点光，低明度低饱和 | 神秘、幽静、潮湿、不安 | 《湮灭》《小丑》部分场景、森林系广告 | 森林、悬疑、探险、香水、暗黑时尚 | dark moody green tones, deep forest green palette, mysterious atmosphere, low key |
| **复古胶片**<br>Vintage Film | 暖黄偏色、褪色感、对比降低、颗粒 | 怀旧、记忆感、温度、故事感 | 《阳光灿烂的日子》、家庭老录像、胶片摄影 | 怀旧、回忆杀、旅行、人文纪录 | vintage film look, faded colors, warm yellow cast, film grain, nostalgic |
| **日系小清新**<br>Japanese Fresh | 高明度、低对比、青绿偏色、空气感 | 干净、治愈、日常、青春 | 是枝裕和电影、岩井俊二《情书》、日系写真 | 校园、日常 Vlog、美食、旅拍 | japanese fresh style, bright and airy, soft cyan-green tint, low contrast, clean |
| **黑白**<br>Monochrome | 去色，只剩光影明暗 | 纯粹、严肃、永恒、纪实 | 《罗马》《辛德勒的名单》、黑白人像摄影 | 纪实、人像、艺术片、访谈 | monochrome black and white, high contrast B&W, light and shadow only |
| **单一点缀色**<br>Color Splash / Single Accent | 全画面去色/低饱和 + 保留一个主体颜色 | 聚焦、符号化、戏剧化 | 《辛德勒的名单》红衣女孩、《罪恶之城》 | 品牌符号、强调主体、艺术短片 | black and white with single red accent, selective color, color splash |

### 配色选择扩展解读（保留速查骨架）

- **青橙 —— 好莱坞的安全牌**：人的肤色天然落在橙色系，背景压青后**肤色与背景自动分离**，主体不用抠图就"跳"出来。这是它成为商业片标配的根本原因。Agent 写人物出镜的商业视频时，青橙是默认首选。
- **莫兰迪 —— "高级灰"的正确写法**：用户说"高级感"，八成要的是莫兰迪而非黑白。关键是**低饱和 + 色相之间的微小灰差**，提示词必须同时写 muted / desaturated 和 greyish tones，只写 gray 会得到黑白片。
- **糖果马卡龙 —— 明度比饱和更重要**：马卡龙色的核心是**高明度**，饱和度反而是中低。写 pastel 比写 colorful 准确，写 vivid candy 会跑偏成高饱和游乐场风。
- **赛博霓虹 —— 三色锁定**：品红 + 青 + 紫，缺一不像。必须有**黑色底**托着（低明度），白天霓虹不成立。
- **复古胶片 —— "褪色"是关键词**：faded 比 old 有效。配合 film grain（颗粒）和 warm yellow cast（暖黄偏色）三件套，复古感才完整。
- **单一点缀色 —— 先写黑白再写点缀**：顺序不能反。先说 monochrome / black and white，再说 with a single red accent on [主体]，模型才能理解"只保留这一处颜色"。

---

## 三、分题材实战指南

### 3.1 人物 / 人像

| 场景 | 推荐配色 | 原因 |
|---|---|---|
| 商业人物 / 广告出镜 | 青橙 | 肤色自动从背景分离，最不挑场景 |
| 文艺情绪人像 | 莫兰迪 / 低饱和青调 | 情绪内敛，颜色不抢表演 |
| 少女 / 写真 | 糖果马卡龙 / 日系小清新 | 高明度显干净，肤色显白 |
| 夜景人像 | 赛博霓虹 / 黑金 | 借环境光上色，氛围浓 |
| 纪实 / 访谈 | 黑白 / 去饱和电影感 | 去掉颜色干扰，聚焦表情与语言 |

### 3.2 产品 / 静物 / 美食

- 高端产品（腕表、酒、香水）：**黑金**或**墨绿暗黑**，低明度托出质感。
- 静物 / 家居 / 生活方式：**莫兰迪**，"贵而温柔"的标准答案。
- 甜品 / 饮品：**糖果马卡龙**或暖橙调（暖色激发食欲，冷色抑制食欲——冷饮除外）。
- 科技产品：**青蓝冷调**或赛博霓虹，冷色 = 精密感。

### 3.3 城市 / 旅行 / Vlog

- 城市白天 / 建筑：青橙或低饱和青灰，通透。
- 城市夜景：赛博霓虹（未来感）或黑金（奢华感）二选一。
- 旅行回忆向：复古胶片（怀旧）或日系小清新（治愈）。
- 自然风光：邻近色思路——绿野用绿色系深浅，秋色用橙黄邻近色，不强行上互补色。

### 3.4 悬疑 / 情绪 / 艺术短片

- 悬疑惊悚：**墨绿暗黑** + 低明度，绿色在暗光下天然让人不安。
- 压抑纪实：**去饱和电影感**（desaturated cinematic），像褪色的现实。
- 艺术实验：黑白 + 单一点缀色，符号化表达。

---

## 四、视频生成的特有规则（与图片不同，Agent 必须知道）

1. **色调一致性**：AI 生成多段视频再拼接时，每段的色调词必须**逐段重复写全**，不能只写一次指望模型"记住"。第一段写了 teal and orange color grade，第二段必须原样再写，否则相邻镜头色调跳变，拼接后像两部片子。
2. **肤色保护**：任何色调都不能把人脸画成阿凡达。涉及人物的青调、绿调、霓虹色调提示词，必须追加肤色保护描述，如 **natural skin tones / accurate skin color preserved**，防止模型为了统一色调把皮肤也染青染紫。
3. **色调词放前段**：视频模型对提示词前部权重更高，色调属于全局属性，应写在提示词开头或紧跟主体之后，不要埋在句尾。
4. **动态画面的饱和度衰减**：运动镜头中颜色信息比静帧更难保持，需要高饱和效果时，描述可略加强化（vivid / rich colors），给模型的"衰减"留余量。
5. **色调与光线的绑定**：色调不是凭空存在的，依附于光源。写"复古胶片暖黄"时最好同时给光源理由（如午后阳光、钨丝灯），色调才落地——参见 LIGHT-002 时段与色温。

---

## 五、常见误区（生成提示词时的纠错规则）

| 误区 | 纠正 |
|---|---|
| "颜色越鲜艳越好看" | 恰恰相反。低饱和 = 高级灰是近十年影视主流，高饱和滥用显廉价。先看题材再定饱和度 |
| "调色是后期的事，拍摄/生成时不用管" | 色调依附于光线和场景固有色，提示词阶段不定色调，后期救不回来。AI 生成尤其如此——色调词就是"前期" |
| "配色 = 罗列颜色" | 要写色彩**关系**（谁主谁次、谁暖谁冷），不是把五种颜色堆进提示词。主色 + 点缀色的结构最稳 |
| "黑白片最简单，去色就行" | 黑白恰恰最难——去色后只剩光影，对光线和构图要求更高。提示词要强调 contrast、light and shadow |
| "高级感 = 黑白 / 灰色" | 高级感通常指低饱和而非无饱和。只写 gray 会得到黑白片，要写 muted tones / desaturated |
| "一套色调走全片不用重复写" | 视频模型无记忆，多段生成时色调词必须逐段重复（见第四章第 1 条） |
| "想要什么色就写什么色名" | 模型对色名（如"蒂芙尼蓝"）理解不稳定，要写色彩构成与画面效果（"青绿色调，高明度"） |

---

## 六、创作意图 → 提示词关键词映射表（Agent 核心调用区）

> 规则：**提示词里不要直接写色值、色号或抽象风格名**（多数视频模型无效），按本表翻译成画面可见的色彩描述。中英文都给，英文关键词对国际模型更有效。

### 6.1 经典配色方向

| 创作意图 | 中文提示词写法 | 英文关键词 |
|---|---|---|
| 商业大片感 | 青橙色调，阴影偏青蓝，肤色暖橙，好莱坞调色 | teal and orange color grade, cyan shadows, warm skin tones, Hollywood blockbuster look |
| 高级灰 / 高级感 | 莫兰迪低饱和灰调，柔和雅致，色彩克制 | muted morandi tones, desaturated greyish palette, low saturation, elegant |
| 甜美少女 / 甜品 | 马卡龙粉彩配色，粉色与薄荷绿，高明度柔和 | pastel color palette, soft pink and mint, candy colors, high key |
| 赛博朋克夜景 | 赛博霓虹配色，品红与青色霓虹灯，紫色雾气，黑色底 | cyberpunk neon palette, magenta and cyan neon lights, purple haze |
| 复古怀旧 | 复古胶片质感，褪色暖黄偏色，胶片颗粒 | vintage film look, faded colors, warm yellow cast, film grain, nostalgic |
| 日系清新 | 日系小清新，高明度低对比，青绿空气感，干净通透 | japanese fresh style, bright and airy, soft cyan-green tint, low contrast |
| 黑白纪实 | 黑白影调，高对比，只剩光影 | monochrome black and white, high contrast B&W, light and shadow |
| 黑白中一点颜色 | 黑白画面，仅[主体]保留红色 | black and white with single red accent on [subject], selective color, color splash |
| 奢华高端 | 黑金配色，深黑底金色高光，奢华质感 | black and gold palette, gold accents on deep black, luxurious premium look |
| 森林神秘感 | 墨绿暗黑色调，深绿低明度，神秘幽静 | dark moody green tones, deep forest green, low key, mysterious atmosphere |

### 6.2 饱和度 / 明度调节方向

| 创作意图 | 中文提示词写法 | 英文关键词 |
|---|---|---|
| 画面明亮轻盈 | 高调明亮布光，高明度，画面通透 | high key bright, bright and airy, luminous |
| 画面暗沉压抑 | 低调暗光，低明度，大面积阴影 | low key dark, moody shadows, dim atmosphere |
| 电影感去饱和 | 低饱和电影调色，色彩克制内敛 | desaturated cinematic, muted film colors, restrained palette |
| 浓郁艳丽 | 高饱和浓郁色彩，鲜艳夺目 | vivid saturated colors, rich bold palette |
| 柔和不刺眼 | 柔和色彩，低对比，奶油般过渡 | soft muted colors, gentle low contrast, creamy tones |

### 6.3 肤色保护与一致性（人物题材必加）

| 创作意图 | 中文提示词写法 | 英文关键词 |
|---|---|---|
| 人物肤色正常 | 肤色自然准确，不受环境色调影响 | natural skin tones, accurate skin color preserved |
| 多段色调统一（逐段重复写） | 全片统一青橙色调 | consistent teal and orange grade throughout |

---

## 七、提示词模板（Agent 直接填空调用）

### 模板 A：商业大片青橙

```
[主体描述]，[动作]，青橙色调，阴影与环境偏青蓝，人物肤色暖橙自然，
[光线描述]，好莱坞电影调色质感，[运镜方式]。
Teal and orange color grade, cyan shadows, natural warm skin tones, cinematic Hollywood look.
```

示例：
> 一位穿皮夹克的男子走过雨后的城市街道，青橙色调，湿漉漉的地面反射着青蓝色环境光，人物肤色暖橙自然，侧逆光勾勒轮廓，好莱坞电影调色质感，镜头低角度缓慢跟随。Teal and orange color grade, cyan shadows, natural skin tones, cinematic Hollywood look, low angle tracking shot.

### 模板 B：日系清新

```
[主体描述]，[动作/状态]，日系小清新色调，高明度低对比，画面明亮通透带青绿空气感，
[时段]自然光，干净治愈，[运镜方式]。
Japanese fresh style, bright and airy, soft cyan-green tint, low contrast, clean.
```

示例：
> 女孩在洒满阳光的厨房里切开一颗柠檬，日系小清新色调，高明度低对比，画面明亮通透带青绿空气感，上午自然光从白窗帘透入，干净治愈，固定镜头轻微呼吸感。Japanese fresh style, bright and airy, soft cyan-green tint, low contrast, morning light, clean and healing.

### 模板 C：莫兰迪静物

```
[静物/产品描述]，莫兰迪低饱和灰调，灰粉/灰蓝/燕麦色系，色彩克制柔和，
柔光，[材质细节]，安静高级，镜头缓慢[运镜方式]。
Muted morandi tones, desaturated greyish palette, soft light, elegant, low saturation.
```

示例：
> 一组陶土花瓶与干花摆放在亚麻桌布上，莫兰迪低饱和灰调，灰粉与燕麦色系，色彩克制柔和，窗边柔光，陶器哑光质感清晰，安静高级，镜头缓慢横移。Muted morandi tones, desaturated greyish palette, soft window light, matte texture, elegant, slow lateral dolly.

### 模板 D：赛博夜景

```
[城市场景描述]，赛博霓虹配色，品红与青色霓虹灯招牌，紫色雾气弥漫，
黑色夜空底，[天气/地面反射]，未来感，[运镜方式]。
Cyberpunk neon palette, magenta and cyan neon lights, purple haze, futuristic night city.
```

示例：
> 雨夜的小巷深处，赛博霓虹配色，品红与青色霓虹灯招牌交错闪烁，紫色雾气弥漫，黑色夜空底，积水地面反射霓虹光斑，未来感，镜头缓慢向前推进。Cyberpunk neon palette, magenta and cyan neon signs, purple haze, wet street reflections, futuristic night city, slow push-in.

### 模板 E：复古胶片（进阶）

```
[场景描述]，复古胶片质感，褪色暖黄偏色，胶片颗粒，对比度柔和降低，
[年代感元素]，怀旧记忆感，[运镜方式]。
Vintage film look, faded colors, warm yellow cast, film grain, nostalgic.
```

示例：
> 老城区夏日的午后，孩子们追逐着自行车跑过斑驳的墙影，复古胶片质感，褪色暖黄偏色，胶片颗粒，对比度柔和降低，老式居民楼与电线杆，怀旧记忆感，手持镜头轻微晃动。Vintage film look, faded colors, warm yellow cast, film grain, nostalgic, handheld feel.

---

## 八、意图 → 配色 → 提示词 决策流程（Agent 推理链）

```
用户意图
  │
  ├─ 情绪 / 气质出发
  │     ├─ "商业、大片、通透" → 青橙
  │     │     → 提示词：teal and orange color grade + natural skin tones
  │     ├─ "高级、温柔、安静" → 莫兰迪
  │     │     → 提示词：muted morandi tones + low saturation
  │     ├─ "甜美、少女、治愈" → 糖果马卡龙
  │     │     → 提示词：pastel color palette + high key
  │     ├─ "未来、迷幻、夜" → 赛博霓虹
  │     │     → 提示词：cyberpunk neon palette + magenta and cyan
  │     ├─ "神秘、压抑、悬疑" → 墨绿暗黑
  │     │     → 提示词：dark moody green + low key
  │     └─ "怀旧、回忆" → 复古胶片
  │           → 提示词：vintage film look + faded colors + film grain
  │
  ├─ 品牌 / 产品出发
  │     ├─ 奢侈品 / 金融 → 黑金 → black and gold palette
  │     ├─ 美妆 / 女装 → 莫兰迪或马卡龙 → muted tones / pastel
  │     ├─ 科技 / 3C → 青蓝冷调或霓虹 → cool cyan tones / neon palette
  │     └─ 食品 / 餐饮 → 暖橙调（冷色抑制食欲，冷饮除外）→ warm appetizing tones
  │
  ├─ 人物出镜（任何配色）
  │     → 追加肤色保护：natural skin tones preserved
  │
  └─ 多段视频拼接（任何配色）
        → 色调词逐段重复写全：consistent [配色] grade throughout
```

---

## 九、关联知识（后续主题预留）

- COLOR-002 影调（高调/中间调/低调与明暗分布，与色调配合定画面气质）
- LIGHT-002 时段与色温（黄金时刻/蓝调时刻/正午，色调的光源依据）
- LIGHT-003 夜景与人工光源（霓虹/钨丝灯/LED 的色彩属性，夜景配色落地）
- STYLE-001 影像风格谱系（胶片/数码/各导演色彩风格的整体定位）

> 色调依附于光线而存在，生成提示词时建议 COLOR-001 与 LIGHT-002 / LIGHT-003 联合检索；涉及明暗分布时与 COLOR-002 联合检索。
