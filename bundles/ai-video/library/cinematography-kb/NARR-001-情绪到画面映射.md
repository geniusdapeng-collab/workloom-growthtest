# 情绪→画面映射（Emotion-to-Visual Mapping）领域知识库

> **用途**：AI 视频生成系统的提示词知识库。供数字员工 / Agent 在生成视频提示词时检索调用。
> **主题编号**：NARR-001　**版本**：v1.0　**更新日期**：2026-09-24
> **使用方式**：Agent 接收到涉及"孤独感、治愈感、高级感、氛围、调性"等抽象情绪意图时，检索本主题，将情绪词翻译成完整技术配方（景别+景深+光线+色调+影调+运镜+节奏+场景要素）写入提示词。**注意：AI 视频模型只能理解情绪词的一半，另一半必须由配方词补全——最佳实践是情绪词+配方词同写**（见第四章与第六章映射表）。

---

## 一、核心概念

### 1.1 为什么需要"情绪→画面"翻译层

本知识库是全部主题的**配方层/收口层**。原因在于用户的表达方式和模型的理解方式之间有一道鸿沟：

> **用户不会说"我要 f/1.4 + 85mm + 蓝调时刻 + 固定机位"，用户只会说"我要孤独感"。**

- 前面所有技术主题（OPTICS / CINE / LIGHT / COLOR / PHYS……）回答的是"**怎么做到**"——每个旋钮怎么调。
- 本主题回答的是"**为什么这样组合**"——哪种情绪对应哪一组旋钮的取值。

一条合格的 AI 视频提示词 = **情绪词（定调）+ 配方词（落地）**。只写情绪词，模型随机发挥，十条生成十种理解；只写配方词，画面正确但没有灵魂。两者同写，才是可控的情绪表达。

### 1.2 情绪配方的八要素结构

每一种情绪配方都由八个技术维度组合而成，缺一不可：

| 维度 | 对应知识库 | 在情绪配方中的作用 |
|---|---|---|
| **景别** | CINE-002 | 人与环境的关系：远景=孤独/史诗，特写=亲密/紧张 |
| **光圈/景深** | OPTICS-001/002 | 注意力结构：浅景深=聚焦内心，深景深=交代世界 |
| **光线** | LIGHT-001/003 | 光的软硬方向：软光=温柔，硬光/底光=不安 |
| **色温/色调** | LIGHT-002、COLOR-001 | 情绪的第一语言：暖=亲近，冷=疏离 |
| **影调** | COLOR-002 | 明暗分布：高调=轻盈，低调=沉重 |
| **运镜** | CINE-001 | 情绪的节奏与呼吸：固定=克制，手持=慌乱 |
| **节奏** | OPTICS-003、CINE-001 | 快慢与动静：慢=诗意，快=躁动 |
| **天气/人群** | PHYS-001、SCENE-001/002（预留）、HUMAN-001（预留） | 世界的状态：空街=孤独，人潮=疏离或烟火气 |

记忆口诀：**"景别定关系，景深定焦点，光线定温度，色调定气质，影调定轻重，运镜定呼吸，节奏定心跳，场景定世界"**。

### 1.3 情绪是组合拳，不是单点参数

没有任何单一参数能独立产生情绪——"蓝调"本身不等于孤独，蓝调 + 远景 + 空街 + 固定机位才是孤独。Agent 组装提示词时必须**整组取值、整组写入**，只取配方中的一两个词会导致情绪"串味"（如只取了蓝调没取空镜，出来的是都市时尚片而非孤独片）。

> 关键认知：**配方内部的参数是相互印证的**。每个维度都在说同一句话，模型才能听懂。八个维度里至少命中五个，情绪才稳定成立。

---

## 二、情绪配方全表（核心速查）

| 情绪 | 英文关键词 | 一句话配方 | 代表场景 |
|---|---|---|---|
| **孤独** | loneliness, solitary | 大远景空镜 + 深景深 + 蓝调冷色 + 低饱和 + 低调 + 固定机位/缓慢拉远 + 极慢 + 空街无人 | 蓝调时刻空旷街道，一个人影 |
| **治愈** | healing, soothing | 中近景生活细节 + 中浅景深 + 软光 + 高明度青绿日系 + 高调 + 缓慢横移 + 慢 + 微风绿植 | 阳光厨房、窗边绿植、猫 |
| **温暖** | warmth, cozy | 中近景 + 中浅景深 + 黄金时刻暖橙 + 暖调 + 中间偏高调 + 缓慢推近 + 慢 + 室内暖灯 | 黄昏窗边的拥抱、壁炉 |
| **浪漫** | romance, romantic | 近景特写 + 极浅景深光斑 + 烛光/夜景暖光 + 暖金 + 中间调 + 缓慢环绕 + 慢动作 + 灯火星光 | 烛光晚餐、夜景天台 |
| **怀旧** | nostalgia, vintage | 中景 + 中景深 + 暖黄褪色光 + 复古胶片 + 低对比中间调 + 手持轻晃 + 抽帧/慢门 + 老街旧物 | 老城区夏日、旧火车站 |
| **紧张** | tension, suspense | 近景特写 + 浅景深 + 硬光低调 + 冷青 + 低调 + 手持晃动 + 快剪感 + 逼仄空间 | 黑暗楼道、车内对峙 |
| **恐怖** | dread, horror | 中远景纵深 + 中景深 + 底光/绿灰 + 低饱和冷绿 + 极低调 + 缓慢逼近 + 极慢 + 空走廊 | 空荡走廊尽头、雾中轮廓 |
| **史诗** | epic, majestic | 大远景 + 深景深 + 金色侧光 + 金蓝对比 + 高反差中间调 + 无人机升降 + 延时/慢 + 山川云海 | 雪山日出、大漠孤城 |
| **活力** | energy, vibrant | 中近景 + 中景深 + 硬光明亮 + 高饱和鲜艳 + 高调 + 快切/甩镜 + 快 + 人群街头 | 音乐节、运动场、街舞 |
| **高级感** | luxury, premium | 特写/极简中景 + 中浅景深 + 低调定向光 + 黑金 + 低调 + 极缓慢运镜 + 极慢 + 材质特写 | 腕表、香水、高级酒店 |
| **梦幻** | dreamlike, ethereal | 近景 + 极浅景深柔焦 + 过曝高光柔光 + 粉彩高明度 + 高调 + 漂浮感缓移 + 慢动作 + 光尘雾 | 光斑中的少女、云中漫步 |
| **赛博未来** | futuristic, cyberpunk | 中远景 + 中景深 + 霓虹人工光 + 品红青 + 低调高对比 + FPV 穿梭 + 快 + 雨夜霓虹 | 雨夜霓虹街巷、全息广告 |
| **忧郁** | melancholy, blue | 中景 + 中浅景深 + 阴天窗光 + 蓝灰低饱和 + 低反差中间调 + 缓慢固定 + 极慢 + 雨天窗边 | 雨天窗边侧影、湿街独行 |
| **希望** | hope, hopeful | 远景逆光剪影 + 深景深 + 日出逆光 + 金橙渐变 + 中间偏高调 + 上升运镜 + 由慢渐升 + 破晓开阔地 | 日出山巅剪影、奔向光 |
| **压迫** | oppression, claustrophobic | 对称中景 + 深景深 + 顶光硬光 + 冷色去饱和 + 低调 + 固定/缓慢下降 + 极慢 + 狭小空间 | 空荡大厅、灰色走廊 |

### 配方逻辑扩展解读（保留速查骨架）

- **孤独 —— "大"与"空"的数学**：孤独感的公式是**景别做大（人小）+ 环境做空（无人）+ 镜头做死（不动）**。三者缺一就变成别的情绪：人大景小是肖像，有人有景是街景，镜头运动起来就有了叙事目的。
- **治愈 vs 温暖 —— 一组近亲**：都是慢节奏软光，区别在于色温轴——治愈偏**高明度青绿（白天、日系、空气感）**，温暖偏**低角度暖橙（黄昏、室内、灯光）**。一个像"春天上午"，一个像"冬天傍晚"。
- **紧张 vs 恐怖 —— 速度的开关**：同样的低调浅景深，**手持+快切=紧张**（事情正在发生），**缓慢逼近+空场景=恐怖**（事情即将发生）。恐怖的核心是"等待"，运镜越慢越瘆人。
- **高级感 —— 做减法的情绪**：黑金、低调、极简构图、慢运镜、材质特写，全部指向"少"。高级感配方里**任何一个高饱和、快运动、杂元素的混入都会瞬间破功**。
- **梦幻 vs 怀旧 —— 时间方向不同**：梦幻是"不真实"（柔焦过曝漂浮），怀旧是"过去式"（颗粒褪色抽帧）。都带柔化，但一个往天上走，一个往回忆里走。
- **压迫 —— 构图即情绪**：对称构图 + 顶光 + 深景深的组合让观众无处可逃——画面中没有任何"虚化的安慰"，一切都被顶光照得清清楚楚。这是唯一一个**用深景深制造不适**的配方。

---

## 三、分情绪实战指南（完整配方 + 提示词）

> 每条情绪给出：八要素完整配方 → 代表场景 → 中英文提示词各一条（可直接调用）。

### 3.1 孤独 loneliness

- **景别**：大远景 / 远景，人物占画面 1/10 以下或干脆空镜
- **光圈景深**：中深景深（f/5.6–f/8 效果），空荡环境全部清晰，强调"世界很大人很小"
- **光线**：蓝调时刻天光或单一冷光源（路灯），光质软而散
- **色温色调**：冷蓝调（8000K+ 环境）+ 低饱和，可留一点暖光做对比锚点
- **影调**：低调到中间调，大面积深蓝灰
- **运镜**：固定机位，或极缓慢拉远（pull out），人越来越小
- **节奏**：极慢，画面内几乎无运动，只有风、云、水面微动
- **天气/人群**：空街、无人、薄雾或小雨后

**中文提示词**：
> 蓝调时刻的空旷城市街道，大远景，深景深画面通透，一个撑伞的人影渺小地走在街道尽头，天空均匀的深蓝色，低饱和冷色调，一盏路灯的暖光在冷蓝中孤独地亮着，固定机位，画面几乎静止只有细雨飘落，静谧孤独的氛围。Static locked shot, deep blue hour, low saturation, solitary figure, lonely atmosphere.

**英文提示词**：
> A vast empty city street at blue hour, extreme wide shot, deep depth of field, a tiny solitary figure with an umbrella walking at the far end of the street, deep blue sky, desaturated cold tones, a single warm street lamp glowing against the cold blue, static locked camera, almost motionless frame with only drizzle falling, quiet and lonely atmosphere.

### 3.2 治愈 healing

- **景别**：中近景 / 特写，聚焦生活细节
- **光圈景深**：中浅景深（f/2.8–f/4 效果），背景柔化但可辨认
- **光线**：上午/午后柔和自然光，透过白纱帘的散射光
- **色温色调**：高明度、低对比、青绿空气感（日系小清新）
- **影调**：高调明亮，画面通透
- **运镜**：缓慢横移或固定机位带轻微呼吸感
- **节奏**：慢，动作轻柔（倒水、翻书、抚摸）
- **天气/人群**：晴天微风、绿植、猫、一人独处的生活感

**中文提示词**：
> 上午阳光透过白纱帘洒进厨房，中近景，浅景深背景柔和虚化，一只手把热茶倒入陶瓷杯，蒸汽缓缓升起，日系小清新色调，高明度低对比带青绿空气感，画面明亮通透，窗台绿植在微风中轻摇，镜头缓慢横移，干净治愈的氛围。Japanese fresh style, bright and airy, soft light, healing atmosphere.

**英文提示词**：
> Morning sunlight filtering through white sheer curtains into a kitchen, medium close-up, shallow depth of field with softly blurred background, a hand pouring hot tea into a ceramic cup, steam rising slowly, Japanese fresh style color grade, bright and airy with soft cyan-green tint, high key and luminous, green plants swaying gently on the windowsill, slow lateral camera movement, clean and healing atmosphere.

### 3.3 温暖 warmth

- **景别**：中近景，人与人/人与物的亲密关系
- **光圈景深**：中浅景深（f/2.0–f/2.8 效果），背景灯光柔化成暖色块
- **光线**：黄金时刻低角度阳光，或室内暖灯（约 3200K）
- **色温色调**：暖橙金调，肤色暖
- **影调**：中间偏高调，暗部不死黑
- **运镜**：缓慢推近（slow push in），视线收拢
- **节奏**：慢，动作温柔
- **天气/人群**：黄昏、壁炉、两人或一家人

**中文提示词**：
> 黄金时刻的客厅，中近景，浅景深，祖孙两人依偎在窗边的沙发上读着同一本书，夕阳暖橙色的光从侧面洒在他们身上，背景台灯的暖光虚化成柔色块，暖金色调，肤色自然温暖，镜头极缓慢推近，温暖亲密的氛围。Golden hour, warm orange tones, slow push in, cozy intimate atmosphere.

**英文提示词**：
> A living room at golden hour, medium close-up, shallow depth of field, a grandmother and grandchild snuggling on a sofa by the window reading the same book, warm orange sunset light falling on them from the side, background lamp light melting into soft warm blur, warm golden tones, natural warm skin, very slow push in, cozy and intimate atmosphere.

### 3.4 浪漫 romance

- **景别**：近景 / 特写，眼神、指尖、并肩
- **光圈景深**：极浅景深（f/1.2–f/1.8 效果），背景灯光化作圆形光斑（bokeh）
- **光线**：烛光、串灯、夜景暖光，单一暖光源为主
- **色温色调**：暖金 / 暖橙，混合少量冷环境做对比
- **影调**：中间调偏暗，光源处明亮
- **运镜**：缓慢环绕（orbit）或极缓推近
- **节奏**：慢动作（slow motion）
- **天气/人群**：夜晚、灯火、星光、两人世界

**中文提示词**：
> 天台的烛光晚餐，近景，极浅景深，两人隔着烛光相视而笑，背景城市的万家灯火虚化成金色圆形光斑，烛火轻轻摇曳映在眼底，暖金色调，慢动作，镜头缓慢环绕，浪漫梦幻的氛围。Candlelight, creamy bokeh, city lights bokeh balls, slow motion, romantic atmosphere.

**英文提示词**：
> A candlelit dinner on a rooftop terrace, close-up, extremely shallow depth of field, a couple smiling at each other across the candlelight, city lights behind them melting into golden circular bokeh, candle flame flickering reflected in their eyes, warm golden tones, slow motion, slow orbit shot, romantic dreamy atmosphere.

### 3.5 怀旧 nostalgia

- **景别**：中景，带年代感环境
- **光圈景深**：中景深（f/4–f/5.6 效果），人景皆清如旧照片
- **光线**：午后暖阳、钨丝灯，光线带暖黄偏色
- **色温色调**：褪色暖黄、对比降低、胶片颗粒
- **影调**：低对比中间调，像被时间洗过
- **运镜**：手持轻微晃动（家庭录像感）
- **节奏**：抽帧（step printing）或慢门拖影，模仿老胶片
- **天气/人群**：老街、旧物、老式自行车、电线杆

**中文提示词**：
> 九十年代老城区的夏日午后，中景，孩子们追逐着自行车跑过斑驳的墙影，复古胶片质感，褪色暖黄偏色，明显的胶片颗粒，对比度柔和降低，手持镜头轻微晃动，轻微抽帧感模仿老胶片，老式居民楼与电线杆，怀旧记忆感。Vintage film look, faded colors, warm yellow cast, film grain, nostalgic.

**英文提示词**：
> A summer afternoon in a 1990s old town, medium shot, children chasing a bicycle past mottled wall shadows, vintage film look, faded colors with warm yellow cast, visible film grain, gently reduced contrast, handheld camera with subtle shake, slight step-printing motion like old film stock, old apartment blocks and telephone poles, nostalgic memory-like atmosphere.

### 3.6 紧张 tension

- **景别**：近景 / 特写，信息被剥夺
- **光圈景深**：浅景深（f/1.8–f/2.8 效果），背景危机模糊不可见
- **光线**：硬光、低调、单一方向光，明暗切割锐利
- **色温色调**：冷青 / 去饱和
- **影调**：低调，大面积阴影
- **运镜**：手持晃动（subtle shake）、跟随
- **节奏**：快切感、急促
- **天气/人群**：逼仄空间、夜晚、人少但压迫

**中文提示词**：
> 夜晚的地下停车场，近景特写，浅景深背景完全虚化，男子紧张地回头张望，额头渗出汗珠，头顶惨白的荧光灯在他脸上投下硬朗的阴影，冷青色调去饱和，低调布光大面积黑暗，手持镜头急促晃动，紧张压迫的氛围。Handheld shaky cam, shallow DOF, low key lighting, tense atmosphere.

**英文提示词**：
> An underground parking lot at night, close-up, shallow depth of field with fully blurred background, a man nervously glancing back, sweat beading on his forehead, harsh pale fluorescent light casting hard shadows across his face, desaturated cold cyan tones, low key lighting with large areas of darkness, urgent handheld camera shake, tense and oppressive atmosphere.

### 3.7 恐怖 dread

- **景别**：中远景带纵深，走廊/通道构图
- **光圈景深**：中深景深，黑暗深处保持可辨（威胁在深处）
- **光线**：底光（uplighting）、闪烁光源、绿灰惨白
- **色温色调**：低饱和冷绿灰
- **影调**：极低调，黑暗占画面 70%+
- **运镜**：极缓慢向前逼近（slow push in），越慢越瘆人
- **节奏**：极慢，几乎静止后的突然一动
- **天气/人群**：空走廊、无人、雾

**中文提示词**：
> 废弃医院的空荡走廊，中远景纵深构图，走廊尽头隐约有一个人形轮廓立在黑暗里，闪烁的绿白色荧光灯忽明忽暗，低饱和绿灰色调，极低调画面大部分沉入黑暗，镜头以几乎察觉不到的速度缓慢向前逼近，死寂恐怖的氛围。Slow push in, flickering fluorescent light, dark moody green, horror atmosphere.

**英文提示词**：
> An empty corridor of an abandoned hospital, medium-wide shot with deep perspective, a vague humanoid silhouette standing in the darkness at the far end, flickering greenish-white fluorescent light, desaturated grey-green tones, extremely low key with most of the frame sunk in darkness, camera pushing in at an almost imperceptible speed, dead-silent horror atmosphere.

### 3.8 史诗 epic

- **景别**：大远景 / 超大远景，天地为幕
- **光圈景深**：深景深（f/8–f/11 效果），前景到地平线全清晰
- **光线**：黄金时刻低角度金色侧光，云层缝隙光（god rays）
- **色温色调**：金蓝对比（暖主体+冷环境）
- **影调**：高反差中间调，云层与山体细节丰富
- **运镜**：无人机缓慢升降 / 大范围移动，或延时
- **节奏**：延时摄影的流动感或极慢的庄严感
- **天气/人群**：山川、云海、大漠、风暴前

**中文提示词**：
> 雪山之巅的日出，超大远景，深景深从前景岩石到远处雪峰全部清晰锐利，第一缕金色阳光越过山脊洒在云海上，云层缝隙中射下丁达尔光柱，金蓝对比色调，云层在延时摄影中翻涌流动，无人机镜头缓慢上升，壮阔史诗感。Aerial drone shot, golden hour, god rays, epic majestic landscape.

**英文提示词**：
> Sunrise above snow-capped peaks, extreme wide shot, deep depth of field with everything sharp from foreground rocks to distant summits, the first golden rays crossing the ridge onto a rolling sea of clouds, god rays piercing through cloud gaps, gold-and-blue color contrast, clouds surging in timelapse motion, drone camera slowly rising, majestic epic atmosphere.

### 3.9 活力 energy

- **景别**：中近景为主，广角带环境
- **光圈景深**：中景深，信息量大
- **光线**：硬光、明亮、高反差日光或舞台光
- **色温色调**：高饱和鲜艳色彩（vivid）
- **影调**：高调明亮
- **运镜**：快切感、甩镜、FPV、快速跟随
- **节奏**：快，动感强
- **天气/人群**：人群、街头、运动场、晴天

**中文提示词**：
> 夏日街头的滑板少年，中近景广角，鲜艳高饱和色彩，正午硬光在地面投下利落阴影，少年腾空跃起的瞬间，镜头快速跟随并甩向动作方向，动感模糊，画面明亮充满活力，街头潮流感。Vivid saturated colors, hard sunlight, fast whip pan, energetic.

**英文提示词**：
> A skateboarder on a sunny summer street, wide-angle medium close-up, vivid saturated colors, harsh midday sunlight casting crisp shadows on the ground, the moment he launches into the air, camera rapidly following with a whip pan toward the motion, motion blur, bright and energetic frame, street-style vibe.

### 3.10 高级感 luxury

- **景别**：特写 / 极简中景，大面积留白（负空间）
- **光圈景深**：中浅景深（f/2.8–f/4 效果），焦点锐利如刀
- **光线**：低调定向光，一束光只照亮主体局部
- **色温色调**：黑金配色，深黑底+金色高光
- **影调**：低调，黑暗是画布
- **运镜**：极缓慢推近或环绕（imperceptible drift）
- **节奏**：极慢，近乎凝固
- **天气/人群**：无人、极简空间、材质特写（金属/皮革/玻璃）

**中文提示词**：
> 纯黑背景中的一只机械腕表，特写，中浅景深焦点锐利，一束定向光只照亮表盘与金属表链的局部，金色指针在深黑中泛着低调光泽，黑金配色，极简构图大面积负空间，镜头以几乎静止的速度极缓慢环绕，蓝宝石镜面的反光缓缓流转，奢华高级质感。Black and gold palette, low key, slow orbit, luxurious premium look.

**英文提示词**：
> A mechanical wristwatch against a pure black background, close-up, medium-shallow depth of field with razor-sharp focus, a single directional beam lighting only part of the dial and metal bracelet, golden hands glowing subtly in deep darkness, black and gold palette, minimalist composition with large negative space, camera orbiting at an almost imperceptible speed, reflections slowly gliding across the sapphire crystal, luxurious premium texture.

### 3.11 梦幻 dreamlike

- **景别**：近景 / 中近景
- **光圈景深**：极浅景深 + 柔焦（soft focus / glow）
- **光线**：过曝高光、逆光柔光、光尘可见
- **色温色调**：粉彩高明度（pastel）、轻微朦胧
- **影调**：高调，亮部微微溢出
- **运镜**：漂浮感缓移（floating drift）、缓慢升降
- **节奏**：慢动作，失重感
- **天气/人群**：雾、光尘、花瓣、薄纱

**中文提示词**：
> 晨雾弥漫的花园，近景，极浅景深加柔焦效果，穿白裙的少女伸手触碰悬浮在空气中的光尘与花瓣，逆光让她周身笼罩着过曝的柔光轮廓，粉彩色调高明度，画面朦胧通透，慢动作，镜头如失重般缓缓漂浮，梦幻 ethereal 氛围。Dreamlike, soft focus, overexposed glow, floating camera, slow motion.

**英文提示词**：
> A misty garden at dawn, close-up, extremely shallow depth of field with soft focus glow, a girl in a white dress reaching for glowing dust motes and petals suspended in the air, backlight wrapping her in an overexposed halo, pastel high-key tones, hazy and luminous, slow motion, camera drifting weightlessly, ethereal dreamlike atmosphere.

### 3.12 赛博未来 futuristic

- **景别**：中远景带纵深，城市峡谷构图
- **光圈景深**：中景深，霓虹招牌层层可辨
- **光线**：霓虹人工光为主，雨夜地面全反射
- **色温色调**：品红 + 青 + 紫三色霓虹，黑色底
- **影调**：低调高对比
- **运镜**：FPV 穿越、快速推进
- **节奏**：快，速度感
- **天气/人群**：雨夜、积水、霓虹、全息广告、人影憧憧

**中文提示词**：
> 雨夜的赛博朋克城市街巷，中远景纵深构图，品红与青色霓虹灯招牌交错闪烁，紫色雾气弥漫，积水地面倒映着整片霓虹，全息广告在楼宇间流转，低调高对比，FPV 镜头高速穿梭在霓虹与雨丝之间，未来科技感。Cyberpunk neon palette, magenta and cyan neon, rain-soaked streets, FPV drone shot.

**英文提示词**：
> A rainy cyberpunk city alley at night, medium-wide shot with deep perspective, magenta and cyan neon signs flickering across each other, purple haze filling the air, wet pavement mirroring the entire neon cityscape, holographic ads flowing between buildings, low key high contrast, FPV drone camera flying through neon and rain at high speed, futuristic tech atmosphere.

### 3.13 忧郁 melancholy

- **景别**：中景，人物与环境各半
- **光圈景深**：中浅景深，背景雨景柔化
- **光线**：阴天窗光 / 雨天散射光，软而无方向
- **色温色调**：蓝灰低饱和
- **影调**：低反差中间调，灰蒙蒙
- **运镜**：固定机位或极缓慢移动
- **节奏**：极慢，时间黏稠
- **天气/人群**：雨、湿街、窗边、独行

**中文提示词**：
> 雨天的咖啡馆窗边，中景，中浅景深，一个人望着窗外发呆，手指无意识地在起雾的玻璃上划过，窗外的雨丝和模糊的行人柔化成蓝灰色背景，蓝灰低饱和色调，低反差灰蒙影调，固定机位，画面只有雨在动，淡淡忧郁的氛围。Rainy window, muted blue-grey tones, low contrast, static shot, melancholic.

**英文提示词**：
> A rainy day by a café window, medium shot, medium-shallow depth of field, a person gazing out lost in thought, fingers absently tracing the fogged glass, rain streaks and blurred pedestrians melting into a blue-grey background, desaturated blue-grey tones, low contrast greyish grade, static camera with only the rain moving, quietly melancholic atmosphere.

### 3.14 希望 hope

- **景别**：远景逆光剪影
- **光圈景深**：深景深，天地通透
- **光线**：日出 / 破晓逆光，主体成剪影，天际渐变
- **色温色调**：金橙渐变到粉紫
- **影调**：中间偏高调，暗部有细节
- **运镜**：上升运镜（crane up / rising），由低到高
- **节奏**：由慢渐升，积蓄后释放
- **天气/人群**：破晓、开阔地、山顶、海边

**中文提示词**：
> 破晓时分的山顶，远景，深景深，一个人张开双臂站在山脊线上成为逆光剪影，太阳正从云海尽头升起，天空从金橙渐变到粉紫，第一缕光穿透晨雾，镜头从低角度缓缓上升越过人物肩线迎向朝阳，希望与新生的氛围。Sunrise silhouette, crane up rising shot, golden gradient sky, hopeful.

**英文提示词**：
> Dawn on a mountain summit, wide shot, deep depth of field, a person standing on the ridgeline with arms open as a backlit silhouette, the sun rising from the edge of a sea of clouds, sky gradient from golden orange to pink-violet, first light piercing the morning mist, camera slowly rising from a low angle past the figure's shoulder toward the rising sun, hopeful and reborn atmosphere.

### 3.15 压迫 oppression

- **景别**：对称中景 / 中远景，建筑框住人
- **光圈景深**：深景深（f/8–f/11 效果），无处虚化的"全清晰"
- **光线**：顶光硬光，在人物眼窝投下深影
- **色温色调**：冷色去饱和（灰蓝 / 灰绿）
- **影调**：低调，天花板压低画面
- **运镜**：固定机位或极缓慢下降（crane down）
- **节奏**：极慢，仪式感般窒息
- **天气/人群**：狭小空间、空荡大厅、灰墙

**中文提示词**：
> 灰色办公楼的狭长走廊，对称中景，深景深画面横平竖直全部清晰，一个人渺小地站在走廊正中央，惨白的顶光在地面投下方格状硬影，冷灰蓝去饱和色调，低调压抑，天花板压得很低，固定机位一动不动，窒息般的压迫感。Symmetrical composition, top lighting, desaturated cold tones, oppressive claustrophobic atmosphere.

**英文提示词**：
> A narrow corridor in a grey office building, symmetrical medium shot, deep depth of field with everything clinically sharp, a tiny figure standing at the exact center, pale overhead light casting grid-like hard shadows on the floor, desaturated cold grey-blue tones, low key and oppressive, ceiling pressing low, motionless static camera, suffocating claustrophobic atmosphere.

### 3.16 配方的可调旋钮（同一情绪的加减档）

同一情绪不是唯一解，通过"加减一档"可以适配不同题材。旋钮规则：**一次只动一两个维度，其余维度保持原位**，情绪主轴就不会跑偏。

**示例：孤独的三档变体**

| 版本 | 调整维度 | 配方变化 | 提示词关键改动 |
|---|---|---|---|
| 城市版（基准） | — | 蓝调空街 + 大远景 + 固定机位 | empty city street at blue hour, static shot |
| 自然版 | 场景+光线 | 换空旷自然场景（海边/雪原/沙漠），冷灰天光，雾 | lone figure on a vast misty beach, overcast grey light |
| 室内版 | 景别+光线 | 景别收到中景（房间即"世界"），单一冷窗光，人物背对 | alone in a dim apartment, cold window light, back turned |

**通用加减档旋钮表**

| 旋钮 | 加一档（情绪强化） | 减一档（情绪柔化/商业化） |
|---|---|---|
| 景别 | 更大（人更小，更孤独/更史诗） | 收近一档（更亲切、更产品友好） |
| 饱和度 | 更低（更文艺压抑）/ 更高（更刺激） | 回到中性（更耐看、更品牌安全） |
| 明度 | 更低（更沉重）/ 更高（更轻盈） | 中间调（更日常） |
| 运镜速度 | 更慢（更高级/更瘆人） | 中速（更叙事、更广告） |
| 对比度 | 更高（更戏剧） | 更低（更柔和治愈） |
| 颗粒/柔焦 | 加重（更风格化） | 干净（更商业质感） |

> 同理：温暖可拆为**黄昏版/壁炉版/美食版**；高级感可拆为**黑金版（腕表酒类）/莫兰迪版（女装家居）/科技版（冷灰蓝 3C）**；紧张可拆为**追逐版（手持快切）/对峙版（固定缓慢推近）**。Agent 按题材选版本，不要混用。

---

## 四、AI 视频生成的特有规则（Agent 必须知道）

1. **情绪词只值一半分**：主流视频模型（Runway/Pika/可灵/Sora 类）对 loneliness、epic、healing 这类情绪词有一定理解，但理解是"模糊的方向"而非"精确的配方"。**最佳实践 = 情绪词 + 配方词同写**：先给情绪词定调（lonely atmosphere），再跟完整配方词锁死画面（extreme wide shot, deep blue hour, static camera, empty street）。只写情绪词，十条生成十种画面；加上配方词，十条都是同一种孤独。
2. **情绪词的摆放位置**：情绪词放在提示词**结尾做收口**（"……, lonely atmosphere"），配方词放前面做主体描述。模型对前部权重高，画面构成必须靠前；情绪词靠后起到"盖章定调"作用。
3. **配方词内部一致性检查**：写入前自检——配方各维度是否在说同一句话？"暖橙色调 + 蓝调时刻"是冲突（蓝调时刻环境光为冷蓝，暖橙只能来自点光源）；"高调明亮 + 低调布光"是硬冲突。冲突配方会让模型随机二选一，情绪直接跑偏。
4. **多段拼接的情绪一致性**：分镜生成时，同一情绪的配方词必须**逐段完整重复**，不能只写一次。镜头变了（景别、运镜可以变），色调、影调、光线、氛围词必须原样复制，否则相邻镜头像两部片子（同 COLOR-001 第四章第 1 条）。
5. **情绪强度的"衰减余量"**：视频模型对强烈情绪（恐怖、压迫）的响应普遍偏保守，配方词可略加强一档——要写"极低调画面大部分沉入黑暗"而不是"暗一点"。反之治愈、温暖类情绪模型容易过饱和过甜，饱和度词要克制。
6. **节奏词必须显式给出**：慢动作、抽帧、延时、快切感是情绪配方的一半，模型不会从情绪词自动推断。写 slow motion / timelapse / subtle step printing，不要指望"nostalgic"自动带抽帧。

---

## 五、常见误区（生成提示词时的纠错规则）

| 误区 | 纠正 |
|---|---|
| "情绪词写得越煽情越好" | 模型不认形容词堆叠。"极其悲伤、痛彻心扉、令人心碎的孤独" = 一个 lonely。情绪强度靠配方档位调（更暗、更空、更慢），不靠修辞 |
| "一条提示词堆三种情绪" | 一条提示词一个主情绪。"孤独又温暖还带着希望"会得到三不像。多情绪请分镜：一段一个情绪，靠剪辑完成情绪弧线 |
| "只写情绪词就够了" | 情绪词只值一半分（见第四章第 1 条），必须补配方词落地 |
| "只写配方词不写情绪词" | 画面正确但没有调性锚点，模型可能在表演和动态上跑偏。情绪词放在句尾收口，成本极低收益稳定 |
| "所有情绪都用浅景深大光圈" | 浅景深=聚焦内心，适合亲密/浪漫/紧张；孤独要深景深的"世界很大"，压迫要深景深的"无处可逃"，史诗要深景深的"天地全清"。景深是情绪工具不是档次 |
| "配方维度随便取两三个就行" | 八维至少命中五维情绪才稳定（见 1.3）。只写"蓝调+慢"出来的是普通夜景片不是孤独片 |
| "暖色=温暖，冷色=孤独，一招鲜" | 色温只是八维之一。暖色+空街+远景+固定机位照样孤独（"全世界都熄灯了只剩一盏"）；冷色+近景+软光+慢移照样治愈（日系青绿） |
| "情绪配方和题材无关" | 同一情绪按题材选变体（见 3.16）。产品片的孤独和文艺片的孤独不是同一组参数 |
| "节奏是剪辑的事，提示词不用管" | AI 视频的节奏在提示词里：slow motion、timelapse、fast-paced 直接写进单段提示词，快慢本身就是情绪 |
| "参考了配方就可以省略跨库细节" | 本库是收口层，给的是"取哪一档"；具体档位的词法细节回到各主题查（见第八章跨库指引） |

---

## 六、意图 → 情绪 → 提示词 映射表（Agent 核心调用区）

> 规则：**情绪词用标准英文写法 + 配方缩写拼接**，按本表直接组装。配方缩写是对应配方全部维度的高度浓缩，实际生成时建议展开为完整配方词（示例见第三章与第七章）。

### 6.1 情绪词 → 标准英文 + 配方缩写

| 中文意图 | 标准英文情绪词 | 配方缩写（英文速记） |
|---|---|---|
| 孤独 | lonely, solitary, isolated | extreme wide shot, deep depth of field, blue hour cold tones, low saturation, static camera, empty street, solitary figure |
| 治愈 | healing, soothing, comforting | medium close-up, shallow DOF, soft diffused light, japanese fresh style, bright and airy, cyan-green tint, slow lateral movement, quiet daily details |
| 温暖 | warm, cozy, heartwarming | medium close-up, shallow DOF, golden hour warm light, warm orange tones, slow push in, indoor warm lamp glow |
| 浪漫 | romantic, intimate | close-up, extremely shallow DOF, candlelight, creamy bokeh, warm golden tones, slow motion, slow orbit |
| 怀旧 | nostalgic, vintage, memory-like | medium shot, moderate DOF, vintage film look, faded warm yellow cast, film grain, handheld subtle shake, step printing |
| 紧张 | tense, suspenseful, on edge | close-up, shallow DOF, hard low key lighting, cold desaturated tones, handheld shaky cam, fast-paced urgent |
| 恐怖 | dreadful, ominous, horror | medium-wide deep perspective, flickering uplighting, dark moody green, extremely low key, imperceptibly slow push in, empty corridor |
| 史诗 | epic, majestic, grand | extreme wide shot, deep focus, golden side light, god rays, high contrast, aerial drone rising, timelapse clouds |
| 活力 | energetic, vibrant, dynamic | wide-angle medium shot, vivid saturated colors, hard bright sunlight, high key, fast whip pan, energetic motion blur |
| 高级感 | luxurious, premium, elegant | close-up, shallow DOF razor focus, low key directional light, black and gold palette, minimalist negative space, imperceptibly slow orbit, material texture detail |
| 梦幻 | dreamlike, ethereal, surreal | close-up, extremely shallow DOF, soft focus glow, overexposed backlight halo, pastel high key, floating drift camera, slow motion |
| 赛博未来 | futuristic, cyberpunk, neon | medium-wide deep perspective, magenta and cyan neon, purple haze, low key high contrast, rain-soaked reflections, FPV drone fly-through |
| 忧郁 | melancholic, blue, wistful | medium shot, medium-shallow DOF, soft overcast window light, muted blue-grey tones, low contrast, static camera, rain |
| 希望 | hopeful, uplifting, reborn | wide shot silhouette, deep focus, sunrise backlight, golden gradient sky, crane up rising, mist parting |
| 压迫 | oppressive, claustrophobic, suffocating | symmetrical composition, deep focus, harsh top light, desaturated cold grey, low key, static or slow crane down, confined space |

### 6.2 反向查询表（技术参数 → 情绪反推）

> 使用场景：用户给了参考图 / 参考视频 / 一组技术参数，问"照这个感觉做"。Agent 按参数组合在本表反查情绪，再回 6.1 取完整配方。

| 参数组合特征 | 反推情绪 | 置信度提示 |
|---|---|---|
| 大远景 + 冷蓝 + 低饱和 + 无人 + 固定机位 | 孤独 | 若有雨/雾置信度更高 |
| 高明度 + 青绿 + 软光 + 生活细节 + 慢 | 治愈 | 日系空气感是强信号 |
| 暖橙 + 中近景 + 人物互动 + 慢推 | 温暖 | 黄金时刻/暖灯是强信号 |
| 极浅景深光斑 + 烛光/串灯 + 慢动作 | 浪漫 | bokeh 光斑是强信号 |
| 颗粒 + 暖黄褪色 + 手持 + 抽帧 | 怀旧 | 颗粒+褪色双特征几乎不会误判 |
| 手持晃动 + 浅景深 + 低调 + 快切 | 紧张 | 速度是区分恐怖的关键 |
| 底光 + 绿灰 + 极低调 + 缓慢逼近 + 空走廊 | 恐怖 | "慢"是区分紧张的关键 |
| 大远景 + 深景深 + 金色侧光 + 无人机/延时 | 史诗 | 自然大场景是强信号 |
| 高饱和 + 硬光 + 快切/甩镜 + 人群 | 活力 | 高明度+高饱和双高是强信号 |
| 黑金 + 低调 + 极简 + 慢运镜 + 材质特写 | 高级感 | 负空间占比大是强信号 |
| 柔焦 + 过曝高光 + 粉彩 + 漂浮感 | 梦幻 | 与治愈的区别：过曝与失重感 |
| 霓虹品红青 + 雨夜 + FPV | 赛博未来 | 三色霓虹缺一置信度下降 |
| 蓝灰 + 低反差 + 雨 + 固定机位 + 中景人物 | 忧郁 | 与孤独的区别：景别更近、有人有戏 |
| 日出 + 逆光剪影 + 上升运镜 | 希望 | 上升方向是强信号 |
| 对称构图 + 顶光 + 深景深 + 冷色 + 小空间 | 压迫 | 对称+顶光组合几乎不会误判 |

---

## 七、完整配方提示词示例（Agent 直接调用）

> 以下 7 套为代表情绪的完整长提示词，中英文成对，可直接使用或按 3.16 旋钮调档。

### 配方一：孤独（城市版）

```
中文：
蓝调时刻的城市天台边缘，超大远景，深景深画面从前景栏杆到远处楼群全部清晰，
城市灯火刚刚点亮，天空是均匀的深蓝色，一个渺小的身影独自坐在天台边缘，
低饱和冷蓝色调，只有远处一户窗户透出暖黄的灯光，
固定机位，画面几乎静止，只有云在极缓慢地移动，
静谧、空旷、孤独的氛围。
```

```
English:
A vast city rooftop at blue hour, extreme wide shot, deep depth of field with
everything sharp from the foreground railing to the distant skyline, city lights
just turning on under an even deep blue sky, a tiny solitary figure sitting alone
on the rooftop edge, desaturated cold blue tones, only one distant window glowing
warm yellow, static locked camera, the frame almost motionless with clouds drifting
imperceptibly, quiet, empty, lonely atmosphere.
```

### 配方二：治愈

```
中文：
清晨阳光洒满的日式小厨房，中近景，浅景深背景柔和虚化，
女孩穿着亚麻围裙给窗台上的绿植浇水，水珠在逆光中闪闪发亮，
日系小清新色调，高明度低对比带青绿空气感，画面明亮通透，
白纱帘在微风中轻轻飘动，一只猫蜷在桌角打盹，
镜头极缓慢地横移，干净、安静、治愈的氛围。
```

```
English:
A sunlit Japanese-style kitchen in the early morning, medium close-up, shallow
depth of field with softly blurred background, a girl in a linen apron watering
green plants on the windowsill, water droplets sparkling against the backlight,
Japanese fresh style color grade, bright and airy with a soft cyan-green tint,
high key and luminous, white sheer curtains swaying in the breeze, a cat curled
up dozing in the corner of the table, camera drifting laterally at an extremely
slow pace, clean, quiet, healing atmosphere.
```

### 配方三：怀旧

```
中文：
九十年代南方小城的暑假午后，中景，孩子们举着冰棍跑过骑楼老街，
阳光透过梧桐叶在地面投下斑驳光影，复古胶片质感，褪色暖黄偏色，
明显的胶片颗粒，对比度柔和降低，轻微抽帧模仿老胶片的顿挫感，
手持镜头轻微晃动跟拍，老式自行车、电线杆、搪瓷杯，
怀旧、温暖、带着记忆温度的氛围。
```

```
English:
A summer vacation afternoon in a 1990s southern Chinese town, medium shot,
children running through an old arcade street with popsicles, sunlight filtering
through plane tree leaves casting dappled shadows, vintage film look, faded
colors with a warm yellow cast, visible film grain, gently reduced contrast,
slight step-printing motion mimicking old film stock, handheld camera with subtle
shake following the kids, old bicycles, telephone poles, enamel mugs,
nostalgic, warm, memory-tinted atmosphere.
```

### 配方四：紧张

```
中文：
深夜的办公楼梯间，近景特写，浅景深背景完全虚化成黑暗，
女人贴着墙壁屏住呼吸，手里紧攥着手机，屏幕的冷光是画面唯一光源，
远处传来脚步声，她的瞳孔微微收缩，冷青去饱和色调，
低调布光，大面积阴影吞没画面，手持镜头随着她的呼吸急促轻晃，
令人窒息的紧张悬疑氛围。
```

```
English:
A stairwell in an office building late at night, close-up, shallow depth of field
with the background fully blurred into darkness, a woman pressed against the wall
holding her breath, clutching her phone whose cold screen light is the only light
source, footsteps approaching in the distance, her pupils contracting slightly,
desaturated cold cyan tones, low key lighting with shadows swallowing most of the
frame, handheld camera trembling subtly with her breathing,
suffocatingly tense suspenseful atmosphere.
```

### 配方五：史诗

```
中文：
黎明的大漠，超大远景，深景深从前景沙丘纹理到远处地平线全部清晰锐利，
第一缕金色阳光贴着沙丘的脊线掠过，一半是金色的沙一半是冷蓝的阴影，
驼队的剪影沿着沙脊缓缓行进，低角度侧光把影子拉得极长，
金蓝对比色调，无人机镜头从沙丘后缓缓升起揭示整片大漠，
天地间壮阔苍凉的史诗感。
```

```
English:
A desert at dawn, extreme wide shot, deep depth of field with everything sharp
from foreground dune ripples to the far horizon, the first golden sunlight
skimming along the dune crests, half golden sand and half cold blue shadow,
the silhouette of a camel caravan moving slowly along the ridge, low-angle side
light stretching shadows impossibly long, gold-and-blue color contrast, drone
camera rising slowly from behind a dune to reveal the entire desert,
vast and majestic epic atmosphere.
```

### 配方六：高级感

```
中文：
深黑色背景中的一瓶香水，特写，中浅景深焦点锐利如刀，
一束定向光只照亮瓶身的切割玻璃与液体，其余沉入纯黑，
金色液体在光中泛着内敛的光泽，黑金配色，极简构图大面积负空间，
一滴香水沿瓶身缓缓滑落，镜头以几乎静止的速度极缓慢环绕，
玻璃折射的光斑缓缓流转，克制、奢华、高级的质感。
```

```
English:
A perfume bottle against a deep black background, close-up, medium-shallow depth
of field with razor-sharp focus, a single directional beam lighting only the
faceted glass and the liquid inside, everything else sinking into pure black,
golden liquid glowing with restrained luster, black and gold palette, minimalist
composition with large negative space, a single drop sliding slowly down the
bottle, camera orbiting at an almost imperceptible speed, refracted light spots
gliding across the glass, restrained, luxurious, premium texture.
```

### 配方七：希望

```
中文：
破晓时分的海边，远景，深景深，一个人站在齐膝的海水中面向东方，
成为逆光的剪影，太阳正从海平面升起，天空从金橙渐变到粉紫，
晨雾在阳光中缓缓散开，海面碎金般闪烁，海鸥掠过天际，
镜头从海面的低角度缓缓上升越过人物迎向朝阳，
新生、希望、万物苏醒的氛围。
```

```
English:
A seaside at dawn, wide shot, deep depth of field, a person standing knee-deep
in the water facing east as a backlit silhouette, the sun rising from the sea
horizon, sky gradient from golden orange to pink-violet, morning mist slowly
parting in the sunlight, the sea surface glittering like scattered gold, seagulls
sweeping across the sky, camera rising slowly from a low angle at water level
past the figure toward the rising sun, reborn, hopeful, world-awakening atmosphere.
```

---

## 八、意图 → 情绪 → 配方 → 提示词 决策流程（Agent 推理链）

```
用户意图
  │
  ├─ 1. 情绪词识别（用户直接给了情绪词：孤独/治愈/高级……）
  │     → 查第六章 6.1 取标准英文情绪词 + 配方缩写
  │     → 回第三章对应小节展开八要素完整配方
  │
  ├─ 2. 模糊意图翻译（用户没给情绪词，只给了场景描述："一个人下班回家的路"）
  │     → 推断最可能情绪（此例→孤独或忧郁）
  │     → 与用户确认或直接选主情绪，进入第 1 步
  │
  ├─ 3. 参考图/参数反推（用户给了参考："照这个感觉做"）
  │     → 提取参考的技术参数组合
  │     → 查第六章 6.2 反向查询表反推情绪
  │     → 回第 1 步取完整配方
  │
  ├─ 4. 题材调档（确认题材：产品片/文艺片/广告/Vlog）
  │     → 查 3.16 可调旋钮，选对应版本（城市版/自然版/室内版……）
  │     → 一次只动一两个维度，情绪主轴不变
  │
  ├─ 5. 细节跨库检索（配方某一维需要更细的词法时）
  │     ├─ 景深虚化细节、焦外光斑 → OPTICS-001 光圈
  │     ├─ 焦距选择、广角/长焦画面语言 → OPTICS-002 焦距与视角
  │     ├─ 慢门拖影、抽帧、运动模糊 → OPTICS-003 快门与运动模糊
  │     ├─ 胶片颗粒、噪点氛围 → OPTICS-004 ISO 与画质氛围
  │     ├─ 运镜方式与速度词法 → CINE-001 运镜语言
  │     ├─ 景别定义与构图 → CINE-002 景别系统
  │     ├─ 光位（顺/侧/逆/底光/顶光）→ LIGHT-001 光线方向与质感
  │     ├─ 时段与色温（黄金时刻/蓝调/阴天）→ LIGHT-002 时段与色温
  │     ├─ 霓虹/烛光/人工光源 → LIGHT-003 夜景与人工光源
  │     ├─ 配色方案（青橙/黑金/莫兰迪/霓虹）→ COLOR-001 色调与配色
  │     ├─ 影调（高调/低调/明暗分布）→ COLOR-002 影调
  │     ├─ 雨、雾、蒸汽、光尘 → PHYS-001 流体与粒子
  │     ├─ 材质特写（玻璃/金属/皮革）→ PHYS-002 材质与纹理
  │     ├─ 天气系统、场景要素 → SCENE-001/002（预留）
  │     ├─ 影像风格、导演风格 → STYLE-001/002（预留）
  │     └─ 人群密度与调度 → HUMAN-001（预留）
  │
  ├─ 6. 组装提示词（结构：主体描述 → 配方词 → 情绪词收口）
  │     → 中文：场景主体 + 景别 + 景深 + 光线 + 色调 + 影调 + 运镜 + 节奏 + ……氛围
  │     → 英文：subject + shot size + DOF + lighting + color grade + camera movement + pace + ……atmosphere
  │     → 参照第七章 7 套完整示例的结构
  │
  └─ 7. 写入前自检（第四章规则）
        ├─ 配方词是否内部一致（无冷暖/高低调硬冲突）
        ├─ 八维是否至少命中五维
        ├─ 是否只含一个主情绪
        ├─ 节奏词是否显式给出
        └─ 多段生成时色调影调词是否逐段重复
```

---

## 九、关联知识（后续主题预留）

- OPTICS-001 光圈（景深虚化的档位细节，情绪配方的"焦点"维度）
- OPTICS-002 焦距与视角（广角/长焦对画面语言的影响，配方的空间透视基础）
- OPTICS-003 快门与运动模糊（慢门、抽帧、动态模糊，配方的"节奏"维度落地）
- OPTICS-004 ISO 与画质氛围（胶片颗粒、噪点，怀旧/纪实配方的质感来源）
- CINE-001 运镜语言（推拉升降摇移与速度，配方的"呼吸"维度）
- CINE-002 景别系统（远全中近特的叙事功能，配方的"关系"维度）
- LIGHT-001 光线方向与质感（顺/侧/逆/底/顶光，恐怖与压迫配方的核心）
- LIGHT-002 时段与色温（黄金时刻/蓝调/阴天，温暖/孤独/希望配方的时间锚）
- LIGHT-003 夜景与人工光源（烛光/霓虹/路灯，浪漫与赛博配方的光源依据）
- COLOR-001 色调与配色（青橙/黑金/莫兰迪/霓虹，配方的"气质"维度）
- COLOR-002 影调（高调/中间调/低调，配方的"轻重"维度）
- PHYS-001 流体与粒子（雨雾烟光尘，忧郁/恐怖/梦幻配方的环境质感）
- PHYS-002 材质与纹理（金属/玻璃/皮革特写，高级感配方的落地）
- SCENE-001 天气系统（预留）
- SCENE-002 场景类型库（预留）
- STYLE-001 影像风格谱系（预留）
- STYLE-002 导演/流派风格（预留）
- HUMAN-001 人群与调度（预留）

> 本主题是全部技术主题的收口层：情绪配方只决定"每个维度取哪一档"，各档位的具体词法细节需回到对应主题联合检索（检索指引见第八章第 5 步）。**情绪配方不写孤立参数，只写相互印证的参数组合。**
