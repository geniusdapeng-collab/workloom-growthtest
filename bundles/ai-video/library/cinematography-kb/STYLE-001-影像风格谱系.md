# 影像风格谱系（Visual Style）领域知识库

> **用途**：AI 视频生成系统的提示词知识库。供数字员工 / Agent 在生成视频提示词时检索调用。
> **主题编号**：STYLE-001　**版本**：v1.0　**更新日期**：2026-09-24
> **使用方式**：Agent 接收到涉及"电影感、王家卫、赛博朋克、日系、复古"等风格意图时，检索本主题，将风格名拆解为"光线 + 色调 + 材质 + 节奏 + 画幅"的完整配方写入提示词。**注意：AI 视频模型只写风格名理解不稳定，必须把风格翻译成可渲染的配方组合**（见第六章映射表）。

---

## 一、核心概念

### 1.1 风格是什么

风格不是滤镜，不是某个颜色，而是**一套固定的"光学 + 色彩 + 材质 + 节奏"配方组合**：

> **风格 = 光线配方 + 色调配方 + 材质配方 + 节奏配方（+ 画幅）**

- **光线配方**：光比大小、软硬、方向（如黑色电影=硬光+大光比；日系治愈=柔光+小光比）
- **色调配方**：色相倾向与饱和度（如好莱坞=青橙；法式复古=暖黄褪色）
- **材质配方**：颗粒、柔焦、锐度、宽容度（如胶片=颗粒+柔和高光；数字广告=高锐度+干净）
- **节奏配方**：快门、帧率感、运镜与剪辑速度（如王家卫=抽帧+慢门拖影；时尚广告=快节奏剪辑）
- **画幅配方**：2.35:1 宽银幕、16:9、9:16、4:3、1:1（见第四章）

本库是**配方层**：每条风格都是对其他主题的引用组合——光圈见 OPTICS-001、ISO 颗粒见 OPTICS-004、色调见 COLOR-001、影调见 COLOR-002、节奏见 STYLE-002、情绪映射见 NARR-001。Agent 应联合检索，而非孤立使用风格名。

### 1.2 为什么模型"只认配方不认名"

| 写法 | 模型理解稳定性 | 原因 |
|---|---|---|
| 只写 "cinematic" | 低 | 不同模型训练数据对"电影感"的标注差异极大 |
| 只写导演名 "Wong Kar-wai style" | 中 | 知名导演可被识别，但强度与侧重不可控 |
| 写全配方（光+色+材质+画幅） | 高 | 每个词都是可渲染的视觉特征，跨模型一致 |
| 导演名 + 配方 | 最高 | 名称定方向，配方锁细节 |

> 提示词组合技巧：风格意图 = **风格锚点词（风格名/导演名）+ 光线配方 + 色调配方 + 材质配方 + 画幅**，四层写全，效果最稳定。

### 1.3 风格的三条使用原则

1. **一个画面只认一个主风格**：多风格混搭（赛博朋克+侘寂）几乎必然翻车，除非明确做"碰撞"创意。
2. **风格服务题材**：恐怖题材用治愈系配方是事故；先定题材与情绪（NARR-001），再选风格。
3. **风格是减法**：风格的辨识度来自"不做什么"（如侘寂不做高饱和，黑色电影不做中间调），提示词中可用负向描述锁定。

---

## 二、风格全表（核心速查）

> 每种风格给出：视觉配方（光线+色调+材质+节奏）、情绪气质、代表导演/作品、适用题材、AI 提示词写法。英文关键词对国际模型更有效。

### 2.1 好莱坞商业大片 Hollywood Blockbuster

| 维度 | 内容 |
|---|---|
| 视觉配方 | 光：大光比、轮廓光、戏剧化布光；色：**青橙色调 teal & orange**、高饱和；材质：高反差、高光柔化、暗部干净；节奏：稳定器运镜+快慢相间 |
| 情绪气质 | 宏大、紧张、史诗感、爆米花爽感 |
| 代表 | 迈克尔·贝、《疯狂的麦克斯4》《沙丘》 |
| 适用题材 | 动作、科幻、战争、预告片、品牌大片 |
| AI 提示词 | 好莱坞大片质感，青橙色调，大光比戏剧光，高反差，宽银幕 / Hollywood blockbuster look, teal and orange color grade, dramatic high-contrast lighting, anamorphic widescreen 2.35:1 |

### 2.2 胶片电影感 Cinematic Film Look

| 维度 | 内容 |
|---|---|
| 视觉配方 | 光：柔和高光、大宽容度、暗部不死黑；色：轻微偏色（青影/暖高光）、中低饱和；材质：**35mm 胶片颗粒 film grain**、柔焦微雾；节奏：24fps 运动模糊、平稳运镜 |
| 情绪气质 | 叙事感、质感、耐看、"像电影" |
| 代表 | 柯达 Vision3 胶片、罗杰·迪金斯摄影作品 |
| 适用题材 | 剧情、人像、短片、品牌故事 |
| AI 提示词 | 胶片电影感，35mm 颗粒，柔和高光，宽宽容度，轻微胶片偏色 / cinematic film look, 35mm film grain, soft highlight rolloff, wide dynamic range, subtle film color |

### 2.3 王家卫风格 Wong Kar-wai

| 维度 | 内容 |
|---|---|
| 视觉配方 | 光：霓虹灯+钨丝灯混合光源、暗夜高亮局部；色：浓郁红绿黄、高饱和偏色；材质：**抽帧 step printing**、慢门拖影 motion blur trails、浅景深；节奏：抽帧卡顿感+慢门流动感并存 |
| 情绪气质 | 都市孤独、暧昧、时间停滞、潮湿暧昧 |
| 代表 | 王家卫《重庆森林》《花样年华》，摄影杜可风 |
| 适用题材 | 都市情绪短片、夜景人像、音乐 MV |
| AI 提示词 | 王家卫风格，霓虹灯光，抽帧拖影，浓郁色彩，慢门运动模糊 / Wong Kar-wai style, neon-lit night, step printing, motion blur trails, saturated colors, slow shutter |

### 2.4 韦斯安德森 Wes Anderson

| 维度 | 内容 |
|---|---|
| 视觉配方 | 光：平光、均匀无阴影；色：**糖果色 pastel**（粉、薄荷绿、芥末黄）、高饱和低明度差；材质：平面感、无景深、道具感；节奏：**对称构图+定格横移/垂直升降**、机械感运镜 |
| 情绪气质 | 童话、怪诞、精致、冷幽默 |
| 代表 | 韦斯·安德森《布达佩斯大饭店》《月升王国》 |
| 适用题材 | 创意广告、产品、轻喜剧、社媒短片 |
| AI 提示词 | 韦斯安德森风格，完美对称构图，糖果配色，平面感，机械横移运镜 / Wes Anderson style, perfectly symmetrical composition, pastel candy color palette, flat lighting, lateral tracking shot |

### 2.5 日系治愈 Japanese Healing（小森林风）

| 维度 | 内容 |
|---|---|
| 视觉配方 | 光：柔光、**高明度 high-key**、自然窗光；色：青绿调、低饱和、微过曝；材质：低对比、空气感、轻颗粒；节奏：固定镜头+缓慢生活流、长镜头 |
| 情绪气质 | 安静、治愈、四季流转、日常诗意 |
| 代表 | 是枝裕和、《小森林》、滨田英明摄影 |
| 适用题材 | 生活 Vlog、美食、旅行、宠物、慢生活品牌 |
| AI 提示词 | 日系治愈风，高明度低对比，青绿色调，柔和自然光，生活细节 / Japanese healing style, high-key soft light, low contrast, teal-green tint, quiet daily life details |

### 2.6 赛博朋克 Cyberpunk

| 维度 | 内容 |
|---|---|
| 视觉配方 | 光：霓虹点光源、雨夜反光、强轮廓光；色：**品红+青 magenta & cyan**、高饱和霓虹；材质：湿漉漉的地面反射、烟雾、金属与全息屏；节奏：快慢结合、 glitch 故障闪烁 |
| 情绪气质 | 高科技低生活、迷幻、反乌托邦 |
| 代表 | 《银翼杀手2049》《攻壳机动队》 |
| 适用题材 | 科幻、游戏、音乐 MV、科技产品 |
| AI 提示词 | 赛博朋克，霓虹雨夜，品红与青色灯光，湿滑街道反射，烟雾 / cyberpunk, neon-lit rainy night, magenta and cyan lights, wet street reflections, atmospheric haze |

### 2.7 黑色电影 Film Noir

| 维度 | 内容 |
|---|---|
| 视觉配方 | 光：**硬光、大光比、百叶窗阴影 venetian blind shadows**、单光源；色：高反差黑白（或极低饱和）；材质：烟雾、硬阴影、粗颗粒；节奏：缓慢、压抑、固定机位为主 |
| 情绪气质 | 悬疑、宿命、冷峻、道德灰色 |
| 代表 | 《马耳他之鹰》《双重赔偿》、约翰·休斯顿 |
| 适用题材 | 悬疑、犯罪、侦探、香水/威士忌广告 |
| AI 提示词 | 黑色电影，高反差黑白，百叶窗条纹阴影，硬光，烟雾 / film noir, high-contrast black and white, venetian blind shadows, hard single-source light, cigarette smoke |

### 2.8 纪录片 Documentary

| 维度 | 内容 |
|---|---|
| 视觉配方 | 光：自然光/现场光、不修饰；色：真实还原、低饱和；材质：**手持晃动 handheld**、粗粝颗粒、偶尔失焦；节奏：长镜头、跟随式运镜 |
| 情绪气质 | 真实、在场感、粗粝、可信 |
| 代表 | 维姆·文德斯《地球之盐》、Direct Cinema 流派 |
| 适用题材 | 人物纪实、旅行、社会议题、幕后花絮 |
| AI 提示词 | 纪录片质感，手持镜头晃动，自然光，粗粝真实 / documentary style, handheld camera shake, natural available light, raw and gritty realism |

### 2.9 法式复古 French Vintage

| 维度 | 内容 |
|---|---|
| 视觉配方 | 光：暖黄午后阳光、逆光柔化；色：**暖黄褪色 faded warm**、低对比、微偏品；材质：柔焦、胶片褪色、细颗粒；节奏：慵懒、缓慢横移 |
| 情绪气质 | 怀旧、浪漫、慵懒、旧时光 |
| 代表 | 《天使爱美丽》、法式新浪潮 |
| 适用题材 | 旅行、咖啡馆、穿搭、婚礼、香水 |
| AI 提示词 | 法式复古，暖黄色调，柔焦，胶片褪色质感，午后阳光 / French vintage look, faded warm yellow tones, soft focus, film fade, lazy afternoon sunlight |

### 2.10 吉卜力 / 新海诚动画风 Anime Style

| 维度 | 内容 |
|---|---|
| 视觉配方 | 光：通透阳光、镜头光斑 lens flare；色：**高饱和通透蓝天、积雨云 cumulonimbus**、青绿草地；材质：手绘质感、水面反光、光斑粒子；节奏：舒缓+ dramatic 云流动 |
| 情绪气质 | 治愈、青春、乡愁、宏大与日常并存 |
| 代表 | 宫崎骏（吉卜力）、新海诚《你的名字》《天气之子》 |
| 适用题材 | 风景、青春故事、旅行、动画短片 |
| AI 提示词 | 新海诚动画风，通透蓝天积雨云，镜头光斑，高饱和 / anime style, Makoto Shinkai style, vivid blue sky with cumulonimbus clouds, lens flare, lush green landscape |

### 2.11 蒸汽波 Vaporwave

| 维度 | 内容 |
|---|---|
| 视觉配方 | 光：霓虹粉紫光、CRT 屏幕光；色：**粉紫渐变 pink-purple gradient**、青绿点缀；材质：复古未来元素（希腊雕像、棕榈树、老式电脑）、扫描线、VHS 噪点；节奏：循环 glitch、慢速漂移 |
| 情绪气质 | 复古未来主义、迷幻、怀旧反讽 |
| 代表 | 蒸汽波音乐视觉、Macintosh Plus 专辑封面 |
| 适用题材 | 音乐 MV、潮牌、艺术实验短片 |
| AI 提示词 | 蒸汽波，粉紫渐变天空，复古未来元素，VHS 噪点扫描线 / vaporwave aesthetic, pink-purple gradient sky, retro-futuristic elements, VHS noise and scanlines |

### 2.12 侘寂 Wabi-sabi

| 维度 | 内容 |
|---|---|
| 视觉配方 | 光：微弱漫射光、单侧窗光；色：灰调大地色（米白、灰褐、苔绿）、极低饱和；材质：**旧物肌理、粗陶、枯山水、留白 negative space**；节奏：极缓或静止、固定长镜头 |
| 情绪气质 | 残缺之美、寂静、物哀、时间感 |
| 代表 | 小津安二郎、千利休美学、Axel Vervoordt |
| 适用题材 | 茶/器物、空间设计、香道、冥想、高端东方品牌 |
| AI 提示词 | 侘寂美学，大量留白，旧物质感，灰调大地色，微光 / wabi-sabi aesthetic, generous negative space, weathered textures, muted earthy tones, faint diffused light |

### 2.13 时尚广告 Fashion Film

| 维度 | 内容 |
|---|---|
| 视觉配方 | 光：**硬光几何光影**、造型光、大反差；色：高对比、单色系或撞色；材质：高锐度、干净、皮肤质感精修感；节奏：**快节奏剪辑感、定格 pose、变速 ramp** |
| 情绪气质 | 冷艳、高级、攻击性、距离感 |
| 代表 | 尼克·奈特、Vogue/奢侈品牌广告 |
| 适用题材 | 服装、美妆、珠宝、潮牌 |
| AI 提示词 | 时尚大片，硬光几何光影，高对比，冷艳，快节奏剪辑感 / high fashion film, hard geometric light and shadow, high contrast, sharp details, fast-cut editorial rhythm |

### 2.14 恐怖悬疑 Horror

| 维度 | 内容 |
|---|---|
| 视觉配方 | 光：**低调照明 low-key**、局部光源（手电、烛光）；色：绿灰调、低饱和、暗部死黑；材质：脏污质感、雾、颗粒噪点；节奏：缓慢推进+手持窥视感 POV、突发抖动 |
| 情绪气质 | 不安、压抑、未知恐惧 |
| 代表 | 《招魂》《遗传厄运》、温子仁 |
| 适用题材 | 恐怖短片、悬疑预告、万圣节营销 |
| AI 提示词 | 恐怖片氛围，低调照明，绿灰色调，手持窥视视角，雾气 / horror atmosphere, low-key lighting, desaturated green-grey tones, handheld voyeuristic POV, creeping fog |

---

## 三、风格速查：用户说"我要电影感"到底要什么

### 3.1 "电影感"配方拆解（最高频模糊意图）

> **电影感 cinematic = 浅景深 + 胶片颗粒 + 宽画幅 + 青橙色调 + 柔和高光**，五要素缺一不可，只写 "cinematic" 模型随机发挥。

| 要素 | 具体内容 | 引用主题 |
|---|---|---|
| 浅景深 | 主体从背景分离，背景柔和虚化（f/1.4–f/2.8 效果） | OPTICS-001 |
| 胶片颗粒 | 35mm film grain，细腻颗粒覆盖全画面 | OPTICS-004 |
| 宽画幅 | 2.35:1 宽银幕，上下黑边 | 本主题第四章 |
| 青橙色调 | 阴影偏青、肤色与高光偏橙 | COLOR-001 |
| 柔和高光 | 高光不过曝、柔和滚落 highlight rolloff | COLOR-002 |

标准提示词组合：
> 电影感，浅景深，35mm 胶片颗粒，2.35:1 宽银幕，青橙色调，柔和高光 / cinematic film look, shallow depth of field, 35mm film grain, 2.35:1 anamorphic widescreen, teal and orange grade, soft highlight rolloff

### 3.2 其他高频模糊词的拆解

| 用户说 | 实际配方 |
|---|---|
| "高级感" | 低饱和 + 大光比 + 简洁构图 + 慢运镜（时尚广告/侘寂方向，需追问） |
| "氛围感" | 浅景深 + 柔光 + 颗粒 + 局部光源（灯、烛光）+ 环境粒子（尘、雾） |
| "ins 风" | 高明度 + 低饱和暖调 + 柔焦 + 生活场景（≈日系治愈变体） |
| "复古" | 需追问年代：80s=暖黄胶片褪色；90s=VHS 噪点；民国=钨丝灯暖调低饱和 |
| "大片感" | 青橙 + 大光比 + 宽银幕 + 稳定器运镜（≈好莱坞方向） |

---

## 四、画幅比例联动（风格的隐形配方）

画幅是风格的一部分，选错画幅配方就破功。**AI 视频提示词中画幅要显式写出**。

| 画幅 | 名称/场景 | 风格联想 | 提示词写法 |
|---|---|---|---|
| **2.35:1** | 变形宽银幕 | 电影感、史诗、大片 | anamorphic widescreen 2.35:1, cinematic black bars |
| **16:9** | 标准横屏 | 通用、剧集、纪录片 | 16:9 widescreen（多数模型默认，可省略） |
| **9:16** | 竖屏短视频 | 抖音/视频号、人像、亲密感 | vertical 9:16, portrait orientation |
| **4:3** | 复古/学院比例 | 老电视、胶片、文艺片（《布达佩斯大饭店》部分段落） | 4:3 aspect ratio, vintage academy ratio |
| **1:1** | 方形 | 社媒方形、Instagram、产品 | square 1:1 aspect ratio |
| **1.85:1** | 标准院线 | 剧情片、介于标准与宽银幕之间 | 1.85:1 theatrical ratio |

> 注意：部分模型不支持直接指定画幅，需在生成参数中设置；提示词中写出画幅描述（如 "anamorphic widescreen, lens flare, oval bokeh"）仍可引导构图与镜头特征。

---

## 五、AI 视频生成的特有规则（Agent 必须知道）

1. **风格词必须"配方化"写全**：光 + 色 + 材质 + 画幅四层齐备。只写风格名（"赛博朋克"）不同模型理解差异巨大，写全配方后跨模型稳定。
2. **知名导演名可被识别但要配配方**："Wong Kar-wai style" 多数模型认识，但只写名字强度不可控；正确写法是"导演名定方向 + 配方锁细节"（如 Wong Kar-wai style + neon light + step printing + slow shutter trails）。
3. **负向排除锁风格**：风格辨识度靠"不做什么"。侘寂写 "no vibrant colors"，黑色电影写 "no mid-tones, pure black shadows"，赛博朋克避免写 daylight。
4. **材质词是风格稳定器**：颗粒 grain、烟雾 haze、湿反射 wet reflections、扫描线 scanlines 这类材质词比形容词更能锚定风格，每种风格至少带 1–2 个材质词。
5. **节奏词决定"像不像视频"**：step printing、handheld shake、slow push-in、fast-cut 等节奏描述让风格从"一张图"变成"一段影像"，与 STYLE-002 联合使用。
6. **风格一致性跨镜头**：多镜头生成时，每个镜头的提示词都要重复完整配方（不能只写一次），否则镜头间风格漂移。

---

## 六、创作意图 → 提示词关键词映射表（Agent 核心调用区）

> 规则：**提示词里不要只写风格名**，按本表取"锚点词 + 配方词"组合使用。中英文都给，英文关键词对国际模型更有效。

### 6.1 电影感与主流风格

| 创作意图 | 中文提示词写法 | 英文关键词 |
|---|---|---|
| 电影感（通用） | 电影感，浅景深，35mm 颗粒，宽银幕，青橙色调 | cinematic film look, 35mm film grain, shallow DOF, anamorphic widescreen, teal and orange |
| 好莱坞大片 | 好莱坞大片质感，青橙色调，大光比，戏剧光 | Hollywood blockbuster look, teal and orange grade, dramatic high-contrast lighting |
| 胶片质感 | 35mm 胶片颗粒，柔和高光，胶片偏色 | 35mm film grain, soft highlight rolloff, subtle film color cast |
| 宽银幕史诗 | 2.35:1 变形宽银幕，椭圆光斑，横向炫光 | 2.35:1 anamorphic widescreen, oval bokeh, horizontal lens flare |
| 王家卫都市夜 | 王家卫风格，霓虹灯，抽帧拖影，浓郁色彩 | Wong Kar-wai style, neon lights, step printing, motion blur trails, saturated colors |
| 韦斯安德森 | 韦斯安德森风格，对称构图，糖果色，平面感 | Wes Anderson style, symmetrical composition, pastel palette, flat lighting |

### 6.2 亚文化与类型片风格

| 创作意图 | 中文提示词写法 | 英文关键词 |
|---|---|---|
| 赛博朋克 | 赛博朋克，霓虹雨夜，品红青光，湿地反射 | cyberpunk, neon rain, magenta and cyan, wet street reflections |
| 黑色电影 | 黑色电影，高反差黑白，百叶窗阴影，硬光烟雾 | film noir, high-contrast black and white, venetian blind shadows, hard light, smoke |
| 恐怖悬疑 | 低调照明，绿灰色调，手持窥视视角，雾 | horror atmosphere, low-key lighting, green-grey tones, handheld POV, fog |
| 时尚大片 | 时尚广告，硬光几何影，高对比，快节奏 | fashion film, hard geometric shadows, high contrast, fast-cut editorial |
| 纪录片 | 纪录片质感，手持晃动，自然光，粗粝真实 | documentary style, handheld shake, natural light, raw gritty realism |
| 蒸汽波 | 蒸汽波，粉紫渐变，VHS 噪点，复古未来 | vaporwave, pink-purple gradient, VHS noise scanlines, retro-futuristic |

### 6.3 东方与治愈系风格

| 创作意图 | 中文提示词写法 | 英文关键词 |
|---|---|---|
| 日系治愈 | 日系治愈，高明度低对比，青绿调，生活细节 | Japanese healing style, high-key low contrast, teal-green tint, daily life details |
| 新海诚动画 | 新海诚动画风，通透天空积雨云，光斑 | anime style, Makoto Shinkai style, vivid sky cumulonimbus, lens flare |
| 吉卜力手绘 | 吉卜力手绘风，柔和水彩，田园绿意 | Studio Ghibli style, hand-painted watercolor, lush pastoral green |
| 侘寂 | 侘寂美学，留白，旧物质感，灰调大地色 | wabi-sabi, negative space, weathered texture, muted earthy tones |
| 法式复古 | 法式复古，暖黄褪色，柔焦，午后阳光 | French vintage, faded warm yellow, soft focus, afternoon sunlight |

### 6.4 画幅与材质叠加词

| 创作意图 | 中文提示词写法 | 英文关键词 |
|---|---|---|
| 竖屏短视频 | 竖屏 9:16 构图，主体居中 | vertical 9:16, portrait orientation, centered subject |
| 复古方画幅 | 4:3 复古画幅，老电视质感 | 4:3 aspect ratio, vintage TV look |
| 颗粒增强 | 明显胶片颗粒覆盖画面 | visible film grain overlay, heavy grain |
| 柔焦梦幻 | 全局柔焦，朦胧光晕 | soft focus, dreamy glow, halation |
| VHS 做旧 | VHS 录像带噪点，扫描线，色偏 | VHS tape noise, scanlines, chromatic aberration |

---

## 七、提示词模板（Agent 直接填空调用）

### 模板 A：电影感人像

```
[主体描述]，[动作/表情]，电影感，浅景深背景虚化，35mm 胶片颗粒，
2.35:1 宽银幕，青橙色调，柔和高光，[光线描述]，缓慢[运镜方式]。
Cinematic film look, shallow DOF, 35mm film grain, 2.35:1 anamorphic widescreen,
teal and orange grade, soft highlight rolloff.
```

示例：
> 一位穿米色风衣的女子站在黄昏街头回望，电影感，浅景深背景车流虚化成光斑，35mm 胶片颗粒，2.35:1 宽银幕，青橙色调，柔和高光，夕阳轮廓光勾勒发丝，镜头缓慢推近。Cinematic film look, shallow DOF, 35mm film grain, anamorphic widescreen, teal and orange grade, rim light, slow push-in.

### 模板 B：赛博街景

```
[城市街景描述]，赛博朋克，霓虹雨夜，品红与青色灯光交织，
湿滑街道镜面反射，低空烟雾弥漫，[飞行器/全息广告等未来元素]，
镜头缓慢[运镜方式]，偶尔 glitch 故障闪烁。
Cyberpunk, neon-lit rainy night, magenta and cyan lights,
wet street reflections, atmospheric haze, subtle glitch.
```

示例：
> 狭窄的未来都市后巷，赛博朋克，霓虹雨夜，品红与青色灯牌交织闪烁，湿滑路面镜面反射灯光，低空烟雾弥漫，全息广告投射在雨幕中，镜头缓慢前推，偶尔 glitch 故障闪烁。Cyberpunk alley, neon rain, magenta and cyan signs, wet reflective street, holographic ads in the rain, slow push-in, subtle glitch.

### 模板 C：日系生活

```
[生活场景描述]，日系治愈风，高明度低对比，青绿色调微过曝，
柔和自然窗光，[生活细节：蒸汽/风/织物飘动]，固定镜头或极缓运镜，
轻颗粒，安静长镜头。
Japanese healing style, high-key low contrast, teal-green tint,
soft natural window light, gentle film grain, slow quiet take.
```

示例：
> 乡间厨房的木桌上摆着刚煮好的味噌汤，日系治愈风，高明度低对比，青绿色调微过曝，柔和晨光照进窗，汤面蒸汽缓缓升起，窗帘被风轻轻吹动，固定长镜头，轻颗粒。Japanese healing style, high-key soft morning light, rising steam, curtain swaying, static long take, gentle grain.

### 模板 D：复古胶片

```
[场景描述]，法式复古，暖黄褪色色调，柔焦朦胧，
胶片颗粒与轻微划痕，午后逆光，[怀旧元素]，
慵懒缓慢横移运镜，旧时光质感。
French vintage look, faded warm yellow tones, soft focus,
film grain and slight scratches, lazy lateral dolly.
```

示例：
> 巴黎街角的老咖啡馆，法式复古，暖黄褪色色调，柔焦朦胧，胶片颗粒与轻微划痕，午后逆光穿过蕾丝窗帘，旧皮椅上放着一本翻开的书，镜头慵懒缓慢横移。French vintage café, faded warm tones, soft focus, film grain, backlit lace curtains, slow lazy dolly.

### 模板 E：黑色电影

```
[人物/场景描述]，黑色电影，高反差黑白，百叶窗条纹阴影切割画面，
单侧硬光，香烟烟雾在光束中悬浮，暗部死黑，缓慢[运镜方式]。
Film noir, high-contrast black and white, venetian blind shadows,
hard single-source light, smoke floating in light beams.
```

示例：
> 深夜办公室，侦探坐在桌后，黑色电影，高反差黑白，百叶窗条纹阴影切割他的脸与墙面，台灯单侧硬光，香烟烟雾在光束中缓缓悬浮，暗部死黑，镜头极缓推近他若有所思的眼睛。Film noir office, venetian blind shadows across face, hard desk lamp, cigarette smoke in light beam, crushed blacks, very slow push-in.

---

## 八、意图 → 风格 → 提示词 决策流程（Agent 推理链）

```
用户风格意图
  │
  ├─ 说出明确风格名（"赛博朋克"/"王家卫"）
  │     → 查第二章全表取配方 → 锚点词 + 光色材质画幅写全
  │     → 例："王家卫" → Wong Kar-wai style + neon + step printing + slow shutter trails
  │
  ├─ 模糊风格词（"电影感"/"高级感"/"氛围感"）
  │     → 查第三章拆解表 → 翻译为五要素配方
  │     → "电影感" → 浅景深 + 颗粒 + 宽画幅 + 青橙 + 柔和高光
  │     → "高级感"/"复古"等歧义词 → 追问题材或给两个方向选项
  │
  ├─ 只有题材没有风格词（"拍个悬疑短片"）
  │     → 题材 → 情绪（NARR-001）→ 匹配风格（悬疑 → 黑色电影/恐怖）
  │     → 再取该风格完整配方
  │
  ├─ 只有画面元素（"雨夜霓虹街道"）
  │     → 元素反推风格（雨夜+霓虹 → 赛博朋克 或 王家卫）
  │     → 用色调区分：品红青+未来元素 → cyberpunk；浓郁红绿+人物情绪 → 王家卫
  │
  └─ 多风格混搭请求
        → 默认劝阻；确认是"碰撞创意"后，主风格配方写全，副风格只取 1–2 个元素点缀
```

---

## 九、常见误区（生成提示词时的纠错规则）

| 误区 | 纠正 |
|---|---|
| "加个滤镜/写个风格名就有风格" | 风格=光线+色调+材质+节奏的完整配方，只写风格名模型理解不稳定，必须配方化写全（见 1.2） |
| "电影感=浅景深" | 电影感是配方：颗粒+柔和高光+青橙/胶片色+宽画幅+自然运镜，浅景深只是其中一项（见 3.1） |
| "王家卫风=港风滤镜" | 核心是抽帧拖影（step printing）+霓虹+浓郁色彩+慢门，缺一不可 |
| "风格越混搭越独特" | 一条提示词只承载一种主风格；赛博朋克+侘寂同时写，模型只会给出四不像 |
| "画幅无所谓" | 2.35:1 宽银幕本身就是最强的"电影感"信号词之一，画幅是隐形配方（见第四章） |
| "导演名可以随便堆" | 导演名可辅助识别，但必须同时写出视觉配方；堆三个以上导演名=风格对冲 |
| "动画风就是 cartoon" | 新海诚/吉卜力要写清"通透天空、积雨云、光斑、胶片质感"等具体画面特征，单独 cartoon 会出低幼画风 |

## 十、关联知识

- COLOR-001 色调与配色（青橙/品红青/糖果色等色调配方的展开）
- COLOR-002 影调（高调/低调/软调/硬调与明暗分布）
- OPTICS-001 光圈（风格配方中的景深层）
- OPTICS-004 ISO 与噪点（胶片颗粒 film grain 的生成逻辑）
- STYLE-002 镜头节奏与剪辑感（风格配方中的节奏层：抽帧/快慢门/剪辑速度）
- NARR-001 情绪 → 画面映射（先定情绪再选风格的决策入口）

> 风格 = 其他主题配方的固定组合。生成提示词时建议 STYLE-001 与 COLOR-001、STYLE-002 联合检索，先查本表确定风格配方，再到对应主题取细节关键词。
