# 时段与色温（Time of Day & Color Temperature）领域知识库

> **用途**：AI 视频生成系统的提示词知识库。供数字员工 / Agent 在生成视频提示词时检索调用。
> **主题编号**：LIGHT-002　**版本**：v1.0　**更新日期**：2026-09-24
> **使用方式**：Agent 接收到涉及"清晨、黄昏、正午、夜晚、暖调、冷调、氛围感"等创作意图时，检索本主题，将时段与色温意图翻译成对应的画面效果描述写入提示词。**注意：AI 视频模型不理解"下午 4 点""5200K"这类精确数值，必须把时段与色温意图翻译成画面效果描述**（见第六章映射表）。

---

## 一、核心概念

### 1.1 一天光线的变化逻辑

一天中光线的变化由**太阳高度角**驱动，高度角同时决定两件事：

> **太阳高度角 → 光质软硬 + 色温冷暖**

- **太阳低（清晨/黄昏）**→ 光线斜射、穿过大气的路径长 → **光质软、色温暖（偏金橙）**、影子长
- **太阳高（正午前后）**→ 光线直射、路径短 → **光质硬、色温中性偏冷（偏白）**、影子短
- **太阳落山后（蓝调/夜晚）**→ 直射光消失，只剩天空散射光与人工光源 → **环境冷蓝、灯光暖黄，形成天然冷暖对比**

记忆口诀：**"太阳越低越暖越软，越高越冷越硬"**。Agent 生成提示词时，只要定了时段，光质、色温、影子形态三个变量就同时被锁定，这就是"时段词是最强氛围开关"的原因。

### 1.2 色温是什么

色温用**开尔文值（K）**表示光源的颜色倾向：

- **K 值越低**（如 2800K）→ 越暖，偏黄橙（烛光、白炽灯、日出日落）
- **K 值居中**（约 5500K）→ 中性白，即标准日光
- **K 值越高**（7500K 以上）→ 越冷，偏蓝（阴天、阴影处、蓝调时刻的天空）

| 色温 | 典型光源/时段 | 视觉感受 |
|---|---|---|
| 1800–2800K | 烛光、白炽灯、日出日落瞬间 | 极暖、金黄、亲密 |
| 3200–4300K | 黄金时刻、室内暖灯、清晨傍晚 | 暖、柔和、怀旧 |
| 5000–5600K | 正午日光、电子闪光灯 | 中性、真实、平实 |
| 6000–7500K | 阴天、明亮阴影处 | 偏冷、清爽、克制 |
| 8000K+ | 蓝调时刻天空、雪天阴影 | 冷蓝、静谧、疏离 |

> 关键认知：人眼会自动"白平衡"，但镜头不会——**镜头记录的色温差才是氛围本身**。提示词里写"暖黄"还是"冷蓝"，本质上就是在指挥模型的白平衡倾向。

### 1.3 混合色温的氛围价值

单一色温给"基调"，混合色温给"张力"。最有电影感的画面几乎都是混合色温：

- **室内暖灯（约 3200K）+ 窗外蓝调天光（约 8000K）**：窗内温暖安全，窗外寒冷辽阔——城市夜景人像、咖啡馆、居家情绪片的标配。
- **冷蓝环境 + 暖色点缀光源**（路灯、车灯、橱窗）：冷画面里的一小团暖，视线和情绪都被锚住。

> 提示词组合技巧：想要电影感氛围时，不要只写一个色调，组合"冷环境 + 暖光源"或"暖主体 + 冷背景"的描述，层次立刻拉开（详见 LIGHT-003 夜景与人工光源）。

---

## 二、时段全表（核心速查）

| 时段 | 英文名 | 光线特征 | 色温 | 情绪气质 | 典型题材 | 拍摄窗口 | AI 提示词写法要点 |
|---|---|---|---|---|---|---|---|
| **黎明微光** | dawn | 太阳未出，天空微亮，常有薄雾，光质极软 | 冷中带粉（5000–7000K 过渡） | 静谧、新生、孤独 | 自然风光、空镜开场、晨跑者 | 短（20–40 分钟） | 强调 mist、微弱粉光、无人感 |
| **黄金时刻** | golden hour | 日出后/日落前 1 小时，低角度斜射，暖金色，影子极长，光质柔和 | 暖金（3200–4300K） | 温暖、浪漫、希望、电影感 | 人像、风光、旅拍、情感叙事 | 短（30–60 分钟），**出片率最高** | 强调 warm golden light、long shadows、low sun |
| **上午/下午斜光** | morning/afternoon light | 太阳 30°–60°，光质较硬但方向明确，影子中等 | 中性偏暖（4300–5200K） | 日常、清新、活力 | 街拍、Vlog、产品、生活记录 | 长（各 2–3 小时） | 强调 directional sunlight、clean daylight |
| **正午顶光** | harsh noon | 太阳近头顶直射，光质最硬，阴影短而黑，眼下阴影重 | 中性白（5200–5800K） | 直白、燥热、压迫、纪实 | 纪实、体育、表现压迫感/荒芜感 | 长但一般避用 | 强调 harsh midday sun、hard shadows，慎用于人像 |
| **日落** | sunset | 太阳触地平线，天空分层渐变色（橙→粉→紫），主体易成剪影 | 极暖（1800–3000K） | 壮丽、离别、浪漫 | 逆光剪影、大场景风光、情绪收尾 | 短（15–30 分钟） | 强调 sunset glow、silhouette、gradient sky |
| **蓝调时刻** | blue hour | 日落后 20–40 分钟，天空呈均匀深蓝，城市灯光亮起，冷暖对比 | 环境冷蓝（8000K+）+ 灯光暖黄 | 静谧、都市、梦幻、高级感 | 城市人像、夜景过渡、建筑 | 极短（20–40 分钟），**城市人像神器** | 强调 deep blue sky、city lights on、warm-cool contrast |
| **夜晚** | night | 无自然光，完全依赖人工光源与天空微光 | 由人工光源决定（混合为主） | 神秘、孤独、赛博、危险 | 都市夜景、霓虹、车内戏 | 长（整夜），但光线设计复杂 | 强调 neon lights、street lamps、dark shadows（详见 LIGHT-003） |
| **阴天** | overcast | 云层=天然柔光箱，光质极软无方向，几乎无影子 | 偏冷（6000–7500K） | 忧郁、克制、文艺、平静 | 情绪人像、文艺片、森系、街拍 | 长（全天可用） | 强调 soft diffused light、no harsh shadows、muted tones |
| **雨后天光** | after-rain light | 湿度高、空气通透，地面反光如镜，云隙光偶现 | 冷中带清透感 | 清新、重生、诗意 | 城市倒影、街道、植物特写 | 不定（雨后 1–2 小时内最佳） | 强调 wet ground reflections、fresh clear air、puddle mirror |

---

## 三、分时段实战指南

### 3.1 黄金时刻为什么是"出片率最高时段"

黄金时刻（日出后/日落前约 1 小时）是性价比之王，三个物理原因：

1. **低角度 = 免费轮廓光**：太阳贴近地平线，侧逆光自然勾勒发丝与肩线（rim light），不需要任何人工补光就有"电影打光"效果（光位原理见 LIGHT-001）。
2. **暖色 = 肤色友好**：3200–4300K 的暖金光自带"美颜滤镜"，肤色显得健康通透，几乎不挑模特。
3. **长影 = 层次**：低角度拉出长长的影子，地面有了明暗纹理，画面纵深和立体感白送。

> 提示词推论：写"golden hour"一词，模型会同时激活暖色调、长影子、轮廓光三个特征——这是所有时段词里"一词多效"最强的。

### 3.2 正午顶光的正确打开方式

正午光质最硬、阴影最丑（人像眼窝鼻下黑影重），一般避用。但两种情况下它是对的：

- **纪实/体育/街头的"真实感"**：硬光 = 不加修饰的当下。
- **压迫感/荒芜感叙事**：顶光+硬阴影适合表现燥热、空旷、对抗（西部片、正午决斗）。

人像硬要用正午：找阴影处（树荫、骑楼），阴影里其实是"局部阴天柔光"。

### 3.3 蓝调时刻的城市人像

日落后 20–40 分钟，天空还有均匀的深蓝光（不是死黑），而路灯、橱窗、车灯已经亮起：

- **人脸可用环境暖灯补亮**，背景是冷蓝天空——冷暖对比自动成立。
- 天空细节尚存，楼宇轮廓清晰，比深夜"更有层次、更贵"。
- 窗口极短，是视频拍摄排期里最需要精确卡点的时段。

### 3.4 阴天不是"坏天气"，是免费柔光箱

云层把太阳变成了一整个天空大小的柔光面：

- 无阴影、无高光溢出，皮肤瑕疵被柔光抹平——情绪人像、森系、文艺片的天然影棚。
- 代价是画面容易"平、灰、闷"：提示词要主动补对比（深色服装、鲜艳点缀、wet ground 反光）。

### 3.5 黎明与日落的差异（Agent 易混淆）

- **黎明**：冷调占比更大（粉、灰蓝），空气常有雾，画面"静"，适合开场与孤独感。
- **日落**：暖调占比更大（橙、金红），人间烟火气（归家、灯火初上），适合收尾与情感释放。
- 英文提示词 dawn/sunrise 与 dusk/sunset 不要混用，模型对两者的色彩倾向理解不同。

---

## 四、视频拍摄的特有规则（与拍照不同，Agent 必须知道）

1. **黄金时刻窗口短，必须先排期再开拍**：有效窗口只有 30–60 分钟，且最金的"核心 15 分钟"转瞬即逝。实拍要先踩点、先彩排运镜、太阳到位即正式拍。AI 视频没有这个问题——**提示词写时段词，模型 100% 给你黄金光，这是 AI 视频相对实拍的最大红利之一**。
2. **时段词是 AI 视频最强的氛围开关**：实测中，加入一个时段词（golden hour / blue hour / dawn）对画面氛围的改写幅度，通常大于任何运镜或风格词。Agent 排提示词时，时段词应放在场景描述之前，权重更高。
3. **镜头内时间一致性**：一段视频内太阳位置、影长、色温必须自洽。AI 视频长镜头或分镜组接时，每个镜头都要重复声明时段词，否则模型会在镜头间"跳时间"（影子方向突变是最常见破绽）。
4. **日出/日落延时感**：表现"时间流逝"可用延时描述词（time-lapse, sun moving across sky, shadows lengthening），这是视频相对照片的独占表达。
5. **混合色温要明说**：AI 模型默认倾向统一白平衡，想要"室内暖灯+窗外冷蓝"必须同时写出两个色温描述，只写一个会被拉平。
6. **180° 快门规则下正午光的代价**：实拍正午开大光圈拍浅景深必须上 ND 镜（联动 OPTICS-001）；AI 视频无此限制，但写"正午+浅景深"时建议补一句 soft cinematic look，防止模型输出过曝硬边。

---

## 五、常见误区（生成提示词时的纠错规则）

| 误区 | 纠正 |
|---|---|
| "中午光线最足，最适合拍" | 光足 ≠ 光好。正午顶光光质最硬、阴影最丑，一般避用；人像、风光的首选是黄金时刻 |
| "色温必须准确还原现场" | 色温是创作工具不是考卷。黄昏写成更暖、阴天写成更冷的"夸张还原"，氛围反而更对 |
| "阴天/下雨天不能出片" | 阴天是天然柔光箱，雨后是反光板+镜面地面，文艺情绪片反而更吃这两种天 |
| "提示词写'下午 4 点''5200K'模型就懂" | 模型只认视觉描述。要写 warm golden low-angle light、cool blue tones（见第六章） |
| "一个时段词管整段视频" | 多镜头/长镜头要逐镜重申时段，否则影子方向和色温会穿帮 |
| "黄金时刻 = 日落" | 黄金时刻包括日出后 1 小时；蓝调时刻紧接日落之后，三者是不同窗口，提示词不可混用 |
| "暖调就是高级、冷调就是阴森" | 冷暖无高下：暖可燥热压迫（正午偏暖白），冷可静谧高级（蓝调时刻），取决于叙事目标 |
| "夜景就是全黑" | 好夜景是"深蓝+暖灯+暗部细节"，写 pitch black 只会得到死黑画面（详见 LIGHT-003） |

---

## 六、创作意图 → 提示词关键词映射表（Agent 核心调用区）

> 规则：**提示词里不要直接写时刻与 K 值**（多数视频模型无效），按本表翻译成视觉语言。中英文都给，英文关键词对国际模型更有效。

### 6.1 暖调时段方向

| 创作意图 | 中文提示词写法 | 英文关键词 |
|---|---|---|
| 黄金时刻通用 | 黄金时刻，低角度暖金色阳光，长影子，柔和轮廓光 | golden hour, warm golden light, low sun angle, long soft shadows |
| 魔法时刻（影视惯用语） | 魔法时刻光线，万物镀金，梦幻暖调 | magic hour, everything bathed in gold, dreamy warm glow |
| 日落晚霞 | 日落余晖，天空橙红渐变，暖色霞光铺满画面 | sunset glow, orange-pink gradient sky, warm sunset tones |
| 日落逆光剪影 | 逆光日落，主体呈剪影轮廓，金边勾勒 | backlit sunset, silhouette against the sun, golden rim light |
| 日出希望感 | 清晨第一缕阳光，金粉色晨光，万物苏醒 | first morning light, golden-pink sunrise, sunrise glow |
| 暖调肤色友好人像 | 暖金色阳光洒在面部，肤色通透健康 | warm sunlight on skin, glowing skin tones, flattering warm light |

### 6.2 冷调/柔光时段方向

| 创作意图 | 中文提示词写法 | 英文关键词 |
|---|---|---|
| 蓝调时刻 | 蓝调时刻，天空均匀深蓝，城市灯光初上，冷暖对比 | blue hour, deep blue sky, city lights turning on, warm-cool contrast |
| 黎明微光 | 黎明微光，天将亮未亮，薄雾弥漫，青灰色世界 | dawn mist, pre-dawn twilight, faint first light, misty blue-grey |
| 冷蓝色调 | 冷蓝色调，画面清透克制，情绪冷静疏离 | cool blue tones, crisp cold palette, calm distant mood |
| 阴天柔光 | 阴天柔光，光线均匀无阴影，低饱和灰调 | overcast soft light, diffused lighting, no harsh shadows, muted tones |
| 雨后天光 | 雨后初晴，空气清透，地面湿润反光如镜 | after-rain light, fresh clear air, wet ground reflections, puddle mirror |
| 夜晚霓虹 | 夜晚城市，霓虹灯光，深色阴影，光斑氛围 | night city, neon lights, deep shadows, bokeh lights |

### 6.3 硬光/特殊方向

| 创作意图 | 中文提示词写法 | 英文关键词 |
|---|---|---|
| 正午硬光（纪实/压迫） | 正午顶光，阳光直射，阴影短而锐利，燥热直白 | harsh midday sun, direct overhead light, hard short shadows, sweltering |
| 上午/下午日常斜光 | 明亮的午后阳光，方向明确的斜射光，干净日常 | bright afternoon sunlight, directional sunlight, clean daylight |
| 混合色温（室内暖+窗外冷） | 室内暖黄灯光，窗外蓝调天光，冷暖同框对比 | mixed lighting, warm interior light, cool blue exterior through window |
| 云隙光/丁达尔 | 云隙光柱倾泻而下，空气中尘埃可见 | god rays, crepuscular rays, volumetric light beams |
| 时间流逝（延时） | 延时摄影，光影在墙面上移动，影子逐渐拉长 | time-lapse, moving light and shadow, shadows lengthening |

### 6.4 氛围叠加词（与时段词配合使用）

- 暖调氛围：镀金 gilded、蜂蜜色 honey-toned、怀旧 nostalgic、奶油暖光 creamy warm light
- 冷调氛围：清冷 crisp、忧郁 melancholic、静谧 serene、电影青 teal cast
- 通用强化：大气感 atmospheric、柔焦光晕 soft glow、层次丰富 layered tones

---

## 七、提示词模板（Agent 直接填空调用）

### 模板 A：黄金时刻人像

```
[人物描述]，[动作/情绪]，黄金时刻，低角度暖金色阳光从侧面打来，
发丝与肩线被轮廓光勾勒，地面拉出长长的影子，浅景深，电影感。
Golden hour, warm golden light, low sun angle, rim light on hair, long shadows, cinematic.
```

示例：
> 一位穿米色风衣的女子在河岸边缓步行走，黄金时刻，低角度暖金色阳光从侧面打来，发丝与肩线被轮廓光勾勒，地面拉出长长的影子，浅景深，背景河水泛着金色波光，镜头缓慢跟随。Golden hour, warm golden light, rim light on hair, long shadows, glistening river, slow tracking shot, cinematic.

### 模板 B：蓝调城市

```
[城市/街景描述]，蓝调时刻，天空呈均匀深蓝色，[灯光元素：路灯/橱窗/车灯]亮起暖光，
冷暖对比强烈，[人物/车流动作]，画面静谧有层次。
Blue hour, deep blue sky, city lights glowing warm, warm-cool contrast, serene urban mood.
```

示例：
> 雨后的城市街角，蓝调时刻，天空呈均匀深蓝色，街灯与便利店橱窗亮起暖光，冷暖对比强烈，地面水洼倒映着灯火，一位撑伞行人走过，画面静谧有层次。Blue hour, deep blue sky, warm street lights, wet pavement reflections, a pedestrian with umbrella, serene urban mood.

### 模板 C：阴天情绪

```
[人物/场景描述]，阴天柔光，光线均匀柔和无阴影，低饱和灰调，
[情绪动作]，[深色/亮色点缀元素]形成视觉焦点，文艺克制，安静氛围。
Overcast soft light, diffused lighting, no harsh shadows, muted tones, melancholic quiet mood.
```

示例：
> 空旷的海边栈桥，一位穿黑色大衣的男子凭栏远望，阴天柔光，光线均匀柔和无阴影，低饱和灰调，海风扬起衣角，灰蓝色海面与天空连成一片，文艺克制，安静氛围。Overcast soft light, muted grey-blue tones, figure in black coat, vast quiet sea, melancholic mood.

### 模板 D：日落逆光

```
[主体描述]，日落逆光，太阳贴近地平线，主体呈剪影/半剪影，
金边轮廓勾勒，天空橙红粉紫渐变，[飞尘/水汽/前景元素]在光中可见，壮丽浪漫。
Backlit sunset, silhouette, golden rim light, orange-pink gradient sky, epic romantic mood.
```

示例：
> 一对情侣站在山顶相拥，日落逆光，太阳贴近地平线，两人呈剪影，金边轮廓勾勒，天空橙红粉紫渐变，薄雾在光中浮动，镜头缓慢升起拉远，壮丽浪漫。Backlit sunset, couple silhouette, golden rim light, orange-pink gradient sky, slow drone rise, epic romantic mood.

### 模板 E：混合色温室内（进阶）

```
[室内场景描述]，室内暖黄灯光照亮[主体]，落地窗外是蓝调时刻的冷蓝天光，
冷暖同框对比，[主体动作]，温馨与辽阔并置，电影感。
Mixed lighting, warm interior tungsten light, cool blue hour exterior through window, cinematic contrast.
```

---

## 八、氛围意图 → 时段 → 提示词 决策流程（Agent 推理链）

```
用户氛围意图
  │
  ├─ "温暖/浪漫/希望/电影感人像" → 黄金时刻
  │     → 提示词：golden hour + warm golden light + long shadows + rim light
  │
  ├─ "壮丽/离别/情感高潮/剪影" → 日落
  │     → 提示词：sunset glow + silhouette + gradient sky + backlit
  │
  ├─ "都市/静谧/高级感/夜景但要层次" → 蓝调时刻
  │     → 提示词：blue hour + deep blue sky + city lights on + warm-cool contrast
  │
  ├─ "孤独/新生/开场空镜" → 黎明微光
  │     → 提示词：dawn mist + faint first light + blue-grey world
  │
  ├─ "忧郁/文艺/克制/森系" → 阴天
  │     → 提示词：overcast soft light + muted tones + no harsh shadows
  │
  ├─ "清新/诗意/倒影" → 雨后天光
  │     → 提示词：after-rain light + wet ground reflections + fresh air
  │
  ├─ "纪实/压迫/燥热/荒芜" → 正午顶光（慎用）
  │     → 提示词：harsh midday sun + hard shadows + sweltering
  │
  ├─ "日常/活力/街拍记录" → 上午/下午斜光
  │     → 提示词：bright afternoon sunlight + directional light + clean daylight
  │
  ├─ "神秘/霓虹/都市夜生活" → 夜晚
  │     → 提示词：night city + neon lights + deep shadows（联动 LIGHT-003）
  │
  └─ "温馨室内 vs 辽阔窗外" → 混合色温
        → 提示词：mixed lighting + warm interior + cool blue exterior
```

---

## 九、关联知识

- LIGHT-001 光线方向与质感（顺光/侧光/逆光/轮廓光——时段决定光位，光位决定质感，两者必须联合检索）
- LIGHT-003 夜景与人工光源（蓝调时刻之后的灯光设计、混合色温深入展开）
- COLOR-001 色调与配色（冷暖色温与整体调色、情绪色彩体系）
- SCENE-001 天气与氛围（阴天、雨天、雾天与时段光线的叠加效果）

> 时段是光位与色温的总开关：生成提示词时建议 LIGHT-002 与 LIGHT-001 联合检索——先定时锁定色温与光质，再定光位细化立体感；涉及夜景再叠加 LIGHT-003，涉及整体调色再叠加 COLOR-001。
