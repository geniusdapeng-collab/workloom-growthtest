# 流体与粒子（Fluids & Particles）领域知识库

> **用途**：AI 视频生成系统的提示词知识库。供数字员工 / Agent 在生成视频提示词时检索调用。
> **主题编号**：PHYS-001　**版本**：v1.0　**更新日期**：2026-09-24
> **使用方式**：Agent 接收到涉及"水、雨、烟雾、雾、火焰、光尘、雪、蒸汽、粒子、水下"等创作意图时，检索本主题，将意图翻译成模型能理解的形态+运动+光线描述写入提示词。**注意：AI 视频模型不理解"真实物理"，只理解视觉特征；流体必须同时写清形态、运动方向、速度感与光线互动，缺一不可**（见第六章映射表）。

---

## 一、核心概念

### 1.1 为什么流体与粒子要单独立项

流体与粒子是 AI 视频生成物理真实感的**第一翻车区**，同时也是最出"大片感"的元素——两者一体两面：

- **翻车重灾区**：水的"果冻感"（水面像凝胶整体晃动而非独立液滴）、烟雾穿帮（烟从物体里穿过、无风却横向漂移）、火焰"贴图感"（火苗像循环播放的 GIF，边缘僵硬无层次）。真实流体由无数独立小单元组成且每帧形态不可逆，而这恰恰是当前视频模型最难模拟的部分。
- **大片制造机**：飞溅的水花、逆光的雨丝、体积雾中的光柱、慢动作的火星——几乎所有"高级感镜头"都离不开流体元素。掌握本章等于掌握了低成本提升质感的捷径。

### 1.2 流体的通用提示词公式（Agent 背诵）

> **流体描述 = 形态 + 运动方向 + 速度感 + 光线互动**

| 要素 | 作用 | 示例 |
|---|---|---|
| **形态** | 流体长什么样（液滴/丝缕/团块/薄层） | 细密雨丝、成团白烟、鹅毛大雪 |
| **运动方向** | 往哪走（上升/飘落/飞溅/贴地爬行） | 垂直上升、斜向飘落、向镜头飞溅 |
| **速度感** | 多快（缓慢/急促/凝固/慢动作） | 轻柔飘动、猛烈喷射、slow motion |
| **光线互动** | 光如何照亮它（这是流体可见的前提） | 逆光勾勒、侧光显现、背光通透 |

**光线互动是最常被漏掉的一条**：烟雾、雨丝、浮尘在顺光下几乎不可见，必须靠**逆光/侧光/背光**才能显现。写流体不写光，等于白写。

### 1.3 程度词规则

模型对"大量""少量"的理解极不稳定，必须用**可视觉化的程度词**：

- 少量 → 稀疏 sparse、几缕 a few wisps、零星 scattered
- 中量 → 弥漫 filling the air、成片 sheets of
- 大量 → 倾盆 torrential、遮天蔽日 dense、翻腾 billowing

---

## 二、流体与粒子元素全表（核心速查）

> 每种元素给出：真实形态特征 / AI 易翻车点 / 提示词技巧 / 提示词写法。

### 2.1 水（Water）

#### 飞溅 Splash

| 项目 | 内容 |
|---|---|
| 真实形态 | 液滴四散，大小不一，主体水冠+外围飞沫+回落水滴三段结构 |
| 易翻车点 | 水花变"果冻"整体晃动；液滴悬停不落；方向混乱无重力感 |
| 提示词技巧 | 必写**水量**（少量溅起/大量迸溅）、**方向**（向上/向镜头/向四周）、**速度**（凝固瞬间/慢动作/高速），配逆光或侧光 |
| 提示词写法 | 水滴向四周飞溅，逆光下水珠晶莹剔透，高速凝固瞬间。water splash frozen in motion, backlit droplets, high-speed capture |

#### 波纹 Ripple

| 项目 | 内容 |
|---|---|
| 真实形态 | 同心圆由中心向外扩散，逐圈衰减，多圈叠加干涉 |
| 易翻车点 | 波纹不扩散只原地抖动；圆圈机械均匀像贴图 |
| 提示词技巧 | 写清**起因**（雨滴落点/指尖轻触/石子投入）+ 扩散方向 |
| 提示词写法 | 雨滴落入平静湖面，涟漪从落点一圈圈向外扩散。gentle ripples expanding from where raindrops hit the calm lake surface |

#### 倒影 Reflection

| 项目 | 内容 |
|---|---|
| 真实形态 | 镜面倒影随微波轻微扭曲、拉长，亮度略低于实景 |
| 易翻车点 | 倒影与实景完全对称（过于完美显假）；倒影与波动不同步 |
| 提示词技巧 | 写"轻微扭曲的倒影"更像真的；完全镜面要写"无风、镜面般平静" |
| 提示词写法 | 建筑倒影在微波动的水面上轻轻晃动拉长。softly distorted reflections shimmering on gently rippling water |

#### 瀑布 Waterfall

| 项目 | 内容 |
|---|---|
| 真实形态 | 水流分层：顶部平滑水舌→中段拉丝成缕→底部撞击成雾 |
| 易翻车点 | 整面水像白布整体下滑；底部无水雾；水流速度均匀无加速感 |
| 提示词技巧 | 写清三段结构 + 底部水雾 + 水量（细流 trickling / 轰鸣 cascading）；慢门拉丝效果用 silky smooth |
| 提示词写法 | 瀑布从岩壁倾泻而下，水流中段拉成银丝，底部撞击激起白色水雾弥漫。waterfall cascading down the cliff, silky streams of water, white mist rising from the plunge pool |

#### 海浪 Ocean Waves

| 项目 | 内容 |
|---|---|
| 真实形态 | 浪由远及近推进，浪尖翻卷发白（白浪花），拍岸后碎成泡沫退回 |
| 易翻车点 | 海面整体上下起伏像呼吸；浪不破碎；泡沫像棉絮静止 |
| 提示词技巧 | 写**浪的进程**（远处涌起→翻卷→拍岸→碎成泡沫）+ 浪级（微波 gentle / 巨浪 massive） |
| 提示词写法 | 海浪由远及近涌来，浪尖翻卷出白色浪花，拍打礁石碎成泡沫。waves rolling in, whitecaps curling, crashing against rocks into foam |

### 2.2 雨（Rain）

| 项目 | 内容 |
|---|---|
| 真实形态 | 雨丝因下落速度呈倾斜线条（受风影响）；毛毛细雨呈弥散水雾感；暴雨呈密集斜线并伴随地面积水溅射 |
| 易翻车点 | 雨丝垂直僵硬无风感；雨滴悬浮不落；雨量词不达意（写"大雨"出毛毛雨） |
| 提示词技巧 | **必写光线**——雨丝只有逆光/侧光下才可见；写雨量程度词（drizzle/downpour/torrential）；写雨与环境的互动（打湿地面、积水面溅起小水花） |
| 提示词写法 | 暴雨倾盆，密集雨丝在路灯逆光中清晰可见，地面积水溅起无数小水花。heavy rain backlit by streetlights, raindrops splashing on wet pavement |

### 2.3 烟雾（Smoke）

| 项目 | 内容 |
|---|---|
| 真实形态 | **白烟**：轻盈、上升快、边缘柔和易消散；**黑烟**：厚重、翻滚成团、上升缓慢；**香烟丝缕**：细如发丝、蛇形蜿蜒、遇气流断成涡；**干冰**：比空气重，贴地爬行、遇障碍绕行 |
| 易翻车点 | 烟穿过实体物体；无风横向漂移；烟的边缘硬得像剪纸；黑白烟行为互换 |
| 提示词技巧 | 必写**烟的颜色/浓度**（决定重量感）+ **运动方式**（上升/翻滚/蜿蜒/贴地）+ **光线**（逆光烟雾才有体积感） |
| 提示词写法 | 一缕细烟从香头袅袅升起，在侧逆光中蜿蜒盘旋。thin wisps of smoke curling upward, backlit, serpentine trails |

### 2.4 雾（Fog / Mist / Haze）

| 项目 | 内容 |
|---|---|
| 真实形态 | **fog** 浓雾（能见度低、整体均匀）；**mist** 薄雾（贴地分层、半透明）；**haze** 霾/薄霭（弥散在空气中的柔光介质）。晨雾常呈水平分层 |
| 易翻车点 | 雾均匀得像白幕无层次；雾中光柱方向与光源不符；雾静止不动 |
| 提示词技巧 | 写**分层**（贴地薄雾/半腰雾带）+ **体积光**（volumetric light rays / god rays 穿过雾）+ 缓慢流动 |
| 提示词写法 | 晨雾在林间分层流动，阳光穿过树冠在雾中投下一道道光柱。morning mist layered between trees, volumetric light rays piercing through the fog |

### 2.5 火（Fire）

| 项目 | 内容 |
|---|---|
| 真实形态 | 火焰分层：**内焰**（底部偏蓝、稳定）→**中焰**（橙黄、最亮）→**外焰**（橙红、飘忽透明）。火星（embers）被热气流卷起螺旋上升，逐渐熄灭变暗 |
| 易翻车点 | 火焰像循环贴图重复摆动；边缘僵硬无透明渐变；火星直线上升不熄灭；蜡烛火苗大如篝火 |
| 提示词技巧 | 按尺度选词：**烛光** candlelight（小而稳、微微颤动）/ **篝火** bonfire（多股火舌、火星飞溅）/ **爆炸** explosion（火球+冲击波+浓烟）。必写 flickering（摇曳）与 glowing embers（发光火星） |
| 提示词写法 | 篝火熊熊燃烧，橙黄火舌分外援曳，发光火星螺旋升上夜空。bonfire with flickering orange flames, glowing embers spiraling up into the night sky, slow motion |

### 2.6 灰尘与光尘（Dust Particles）

| 项目 | 内容 |
|---|---|
| 真实形态 | 细小颗粒在光束中缓慢漂浮、受气流微微打转，大小不一、亮度随机 |
| 易翻车点 | 颗粒太大像下雪；运动太快像虫子；均匀分布无随机感 |
| 提示词技巧 | **氛围神器，逆光专用**：必写 in the light beam / backlit；速度写 floating / drifting slowly；数量写 sparse（少量更高级） |
| 提示词写法 | 午后阳光从窗户斜射进来，细小尘埃在光柱中缓缓漂浮。dust particles floating slowly in a beam of afternoon sunlight, backlit, serene atmosphere |

### 2.7 雪（Snow）

| 项目 | 内容 |
|---|---|
| 真实形态 | **鹅毛大雪**：大片、成团、下落慢、轨迹飘忽；**细雪**：小颗粒、密集、受风斜落。**空中飘雪** vs **落地积雪**是两种描述，勿混淆 |
| 易翻车点 | 雪花大小均一像撒盐；垂直下落无风感；落雪与地面积雪矛盾（空中大雪纷飞地上无雪） |
| 提示词技巧 | 写**雪片大小**（large fluffy snowflakes / fine powdery snow）+ **风**（gently falling / blowing sideways）+ **地面积雪状态**（snow-covered ground）保持逻辑一致 |
| 提示词写法 | 鹅毛大雪纷纷扬扬缓缓飘落，屋顶和枝头已积起厚厚白雪。large fluffy snowflakes falling softly, snow-covered rooftops and branches |

### 2.8 蒸汽（Steam）

| 项目 | 内容 |
|---|---|
| 真实形态 | 细长、柔缓、上升后逐渐变淡消散，形态比烟更"润"，常见于咖啡、温泉、热食 |
| 易翻车点 | 蒸汽太浓像烟；上升太快像着火；从冷物体上冒蒸汽（逻辑穿帮） |
| 提示词技巧 | 关键词 gentle / delicate / rising slowly；配**侧逆光**显形；与"温暖、治愈、美食"氛围强绑定 |
| 提示词写法 | 热气从咖啡杯口袅袅升起，在晨光中轻柔舒展。delicate steam rising gently from a cup of coffee, backlit by morning light |

### 2.9 粒子特效（Sparks / Glitter / Confetti）

| 项目 | 内容 |
|---|---|
| 真实形态 | **火花 sparks**：焊接/打铁/烟花棒的亮橙色短线，抛物线下落；**金粉 glitter**：微小反光颗粒，闪烁漂浮；**彩纸 confetti**：彩色小纸片，翻转折射光线、缓降 |
| 易翻车点 | 火花轨迹无重力感；金粉不闪烁；彩纸不翻转像色块 |
| 提示词技巧 | 写**材质带来的光学特性**：火花 trailing（拖尾）、金粉 shimmering（闪烁）、彩纸 fluttering and tumbling（翻转飘落） |
| 提示词写法 | 金色火花从仙女棒四散飞溅，拖着光轨划出一道道光弧。golden sparks flying from a sparkler, trailing arcs of light |

### 2.10 水下（Underwater）

| 项目 | 内容 |
|---|---|
| 真实形态 | 气泡（bubbles）球状上升、越大升越快且轻微摆动；光线在水面折射成晃动的光纹（caustics）；物体呈失重悬浮感 |
| 易翻车点 | 气泡下沉；水体透明得像空气（无折射、无蓝色调）；头发衣物不飘浮 |
| 提示词技巧 | 三件套必写：**气泡上升** + **折射光纹 caustics** + **蓝色调与悬浮感**；深度感用 sun rays penetrating the water surface |
| 提示词写法 | 阳光穿透水面洒下晃动的光纹，串串气泡缓缓上升，发丝在水中轻柔漂浮。underwater scene, sun rays penetrating the surface, caustic light patterns, bubbles rising slowly, hair floating weightlessly |

---

## 三、分题材实战指南

### 3.1 情绪 / 氛围片

| 场景 | 推荐流体元素 | 原因 |
|---|---|---|
| 治愈 / 宁静 | 蒸汽、薄雾、光尘 | 运动柔缓，逆光下自带柔光滤镜 |
| 孤独 / 冷峻 | 细雨、雾、飘雪 | 低饱和+慢速运动拉满疏离感 |
| 紧张 / 危险 | 黑烟、暴雨、火星 | 高对比+快速运动制造压迫感 |
| 浪漫 / 梦幻 | 金粉、光尘、细雪 | 微粒反光元素是"仙女滤镜"平替 |

### 3.2 商业 / 广告片

- **美食**：蒸汽（热气=新鲜的心理暗示）+ 慢动作飞溅（酱汁、水花）。蒸汽永远配侧逆光。
- **饮品**：水花飞溅凝固瞬间 + 气泡上升特写 + 杯壁冷凝水珠。
- **汽车 / 科技**：雨天湿地反光 + 轮胎溅水慢动作 + 体积雾光柱营造未来感。

### 3.3 叙事 / 电影感镜头

- 开场空镜：体积雾+光柱+浮尘，三秒立住氛围。
- 转场：烟雾/水雾充满画面做天然遮罩。
- 高潮镜头：慢动作水花/火星/爆炸粒子，用慢动作放大戏剧张力。

### 3.4 自然 / 风光

- 瀑布： silky smooth 慢门拉丝 + 底部水雾 + 彩虹（mist + sunlight 可召唤彩虹）。
- 海浪：写清浪的进程（涌起→翻卷→拍岸），航拍视角成功率高于贴海面视角。
- 晨雾森林：分层雾 + volumetric light rays，是本主题成功率最高的组合之一。

---

## 四、AI 视频生成的特有规则（Agent 必须知道）

1. **单一元素成功率高，多种流体叠加易崩**：雨+雾+水花同框，模型大概率摆烂出一种。复杂画面只保留一个主流体元素，其余用"远处隐约"带过。
2. **慢动作是流体最好的朋友**：slow motion 既掩盖物理模拟瑕疵，又天然放大美感。水花、火焰、火星、烟雾统统建议挂 slow motion（联动 STYLE-002、OPTICS-003）。
3. **避免流体直接接触人脸与手部**：水泼脸、手捧水、雨中面部特写是崩坏重灾区（五官会被流体带歪）。需要人与流体同框时，让流体在人物身后、脚下或远景。
4. **程度词必须写**："some rain"模型随机发挥，"drizzle / heavy downpour / torrential rain"才可控。宁可写过头，不能不写。
5. **光线决定可见性**：烟雾、雨丝、浮尘、蒸汽必须配逆光/侧光/背光（backlit / side-lit / rim light），顺光下模型会"忘记"生成它们。
6. **逻辑一致性自检**：下雨地面要湿、下雪地上要积、蒸汽下方要有热源。提示词里把因果写全，模型才不自相矛盾。

---

## 五、常见误区（生成提示词时的纠错规则）

| 误区 | 纠正 |
|---|---|
| "烟雾越大越有氛围" | 浓到糊满画面只剩灰。氛围感来自少量烟雾+逆光体积感，sparse wisps 比 dense smoke 高级 |
| "AI 生成的瀑布都长一样" | 因为都写了 waterfall 一个词。写清三段结构+水量+水雾+慢门拉丝，立刻差异化 |
| "写 rain 就会下雨" | 不写光线，雨丝不可见；不写程度词，雨量随机。rain 必须带 backlit 和程度词 |
| "火焰就是 orange fire" | 火焰要分层：内焰偏蓝、外焰橙红、加 flickering 与 embers 才不像贴图 |
| "水就是 transparent water" | 水的可见性全靠反光与折射，要写 glistening / reflective / backlit |
| "多种流体叠加更震撼" | 雨+雾+瀑布同框必崩。一次只让一种流体当主角 |
| "流体越大越清晰越好" | 流体怼镜头（泼水、喷烟）是手部面部崩坏重灾区，保持中远距离 |
| "下雪就是 white dots falling" | 要写雪片大小+风+地面积雪状态，否则出"撒盐"效果且逻辑穿帮 |

---

## 六、创作意图 → 提示词关键词映射表（Agent 核心调用区）

> 规则：**流体意图必须翻译成"形态+方向+速度+光线"四要素齐全的视觉描述**。中英文都给，英文关键词对国际模型更有效。

### 6.1 水

| 创作意图 | 中文提示词写法 | 英文关键词 |
|---|---|---|
| 水花凝固瞬间 | 水花飞溅凝固在半空，水珠逆光晶莹 | water splash frozen in motion, backlit droplets |
| 湖面微澜 | 平静湖面泛起轻柔涟漪，一圈圈向外扩散 | gentle ripples spreading across the calm lake surface |
| 镜面倒影 | 无风水面如镜面，倒影清晰稳定 | mirror-like water surface, perfect reflection |
| 微波倒影 | 倒影随微波轻轻晃动、拉长变形 | softly distorted reflections on rippling water |
| 瀑布拉丝 | 瀑布水流拉出银丝，底部水雾升腾 | silky smooth waterfall, mist rising from the base |
| 海浪拍岸 | 海浪翻卷着白色浪花拍打礁石，碎成泡沫 | waves with whitecaps crashing against rocks into foam |

### 6.2 雨

| 创作意图 | 中文提示词写法 | 英文关键词 |
|---|---|---|
| 毛毛细雨 | 细密雨丝如雾般飘落，逆光中隐约可见 | drizzle, fine misty rain, barely visible in backlight |
| 暴雨倾盆 | 暴雨如注，密集雨丝在灯光逆光中清晰可见 | heavy downpour, torrential rain backlit by streetlights |
| 雨打水面 | 雨滴密集敲打水面，溅起无数细小水花 | raindrops drumming on the water surface, tiny splashes |
| 雨后湿漉 | 地面湿漉反光，霓虹倒影在积水中晃动 | wet pavement reflections, neon lights shimmering in puddles |

### 6.3 烟 / 雾 / 蒸汽

| 创作意图 | 中文提示词写法 | 英文关键词 |
|---|---|---|
| 丝缕轻烟 | 一缕细烟袅袅升起，在逆光中蜿蜒盘旋 | wisps of smoke curling upward, backlit, serpentine |
| 厚重黑烟 | 黑烟成团翻滚着缓慢升腾 | thick black smoke billowing upward slowly |
| 干冰贴地 | 白色烟雾贴着地面缓缓爬行流动 | low-lying fog crawling across the ground |
| 晨雾分层 | 晨雾在山谷间分层流动，半山腰一条雾带 | morning mist layered in the valley, drifting slowly |
| 体积雾光柱 | 阳光穿过雾气投下一道道可见光柱 | volumetric fog, god rays piercing through the mist |
| 咖啡热气 | 热气从咖啡杯口袅袅升起，轻柔舒展 | steam rising gently from a cup of coffee, delicate |
| 温泉蒸汽 | 温泉水面薄雾弥漫，蒸汽缓缓升腾 | mist hovering over hot spring water, steam drifting |

### 6.4 火 / 粒子 / 雪 / 水下

| 创作意图 | 中文提示词写法 | 英文关键词 |
|---|---|---|
| 烛光特写 | 烛火小而稳定，微微摇曳，暖光晕开 | candle flame flickering gently, warm glow |
| 篝火星飞溅 | 篝火火舌分外援曳，发光火星螺旋升空 | bonfire with flickering flames, glowing embers spiraling up |
| 慢动作火星 | 慢动作火星在夜空中划出光轨后熄灭 | slow motion fire embers trailing light, fading into darkness |
| 爆炸火球 | 爆炸火球翻腾膨胀，浓烟紧随其后 | explosion fireball billowing, thick smoke following |
| 光尘漂浮 | 细小尘埃在光柱中缓缓漂浮闪烁 | dust particles floating in a light beam, backlit |
| 鹅毛大雪 | 大片雪花成团缓缓飘落，地面已积厚雪 | large fluffy snowflakes falling softly, snow-covered ground |
| 细雪斜飞 | 细密雪粒被风斜吹，密集飞舞 | fine powdery snow blowing sideways in the wind |
| 火花拖尾 | 火花四散飞溅，拖着光轨划出弧线 | sparks flying with light trails, arcing |
| 金粉闪烁 | 金粉颗粒在光中闪烁漂浮 | glitter particles shimmering and drifting in the light |
| 彩纸飘落 | 彩色纸屑翻转着缓缓飘落 | confetti fluttering and tumbling down slowly |
| 水下气泡 | 串串气泡缓缓上升，阳光在水面折射出晃动光纹 | underwater bubbles rising, caustic light patterns, sun rays through water |
| 水下悬浮 | 人物在水中失重悬浮，发丝轻柔漂浮 | floating weightlessly underwater, hair drifting gently |

### 6.5 通用光线互动叠加词（与流体配合使用）

- 逆光显形：backlit、against the light、silhouetted
- 侧光塑形：side-lit、rim light
- 体积光：volumetric light、god rays、light beams
- 晶莹反光：glistening、glowing、translucent

---

## 七、提示词模板（Agent 直接填空调用）

### 模板 A：逆光雨丝

```
[时间/场景]，[雨量程度]的雨，密集雨丝在[光源]逆光中清晰可见，
地面[积水/湿滑反光状态]，雨滴落处溅起细小水花，[镜头运动]，电影感。
[light/heavy/torrential] rain, backlit by [light source], raindrops splashing on wet ground.
```

示例：
> 深夜的小巷，暴雨倾盆，密集雨丝在路灯逆光中清晰可见，地面积水映着霓虹反光，雨滴落处溅起细小水花，镜头缓慢推进，电影感。Torrential rain, backlit by streetlights, neon reflections on wet pavement, slow push-in, cinematic.

### 模板 B：烟雾氛围

```
[场景]，[烟的形态/颜色]的烟雾[运动方式：袅袅升起/贴地爬行/翻滚升腾]，
在[逆光/侧光]中呈现体积感，[少量/弥漫]程度，氛围[情绪词]。
Wisps of smoke curling upward / low-lying fog crawling, backlit, volumetric.
```

示例：
> 老茶馆内，一缕青灰色细烟从香炉袅袅升起，在窗格透入的侧逆光中蜿蜒盘旋，稀疏几缕，氛围静谧怀旧。Wisps of smoke curling upward, side-lit through window lattice, serene nostalgic mood.

### 模板 C：水花慢动作

```
[起因：物体落入/击打]水面，水花向[方向]飞溅，慢动作凝固瞬间，
水珠在[逆光/侧光]下晶莹剔透，背景[虚化/纯色]，超细节。
Slow motion water splash frozen in motion, backlit glistening droplets.
```

示例：
> 一颗草莓落入牛奶，乳白色水花向四周飞溅，慢动作凝固瞬间，水珠在逆光下晶莹剔透，纯黑背景，超细节。Slow motion splash frozen in motion, backlit droplets, black background, high-speed photography style.

### 模板 D：火焰特写

```
[火源：蜡烛/篝火/壁炉]的火焰，内焰偏蓝外焰橙红分层，火舌[摇曳方式]，
[发光火星缓慢升空]，暖光映照周围环境，慢动作，电影感。
Flickering flames with layered colors, glowing embers rising, slow motion, warm glow.
```

示例：
> 篝火特写，内焰偏蓝外焰橙红分层，火舌随风摇曳，发光火星螺旋升上夜空缓缓熄灭，暖光映照四周木柴，慢动作，电影感。Bonfire with flickering layered flames, glowing embers spiraling up, slow motion, cinematic warm glow.

### 模板 E：蒸汽美食

```
[食物/饮品]特写，热气从[杯口/表面]袅袅升起，细长柔缓，
在[侧逆光/晨光]中轻柔可见，浅景深背景柔和虚化，温暖治愈氛围。
Delicate steam rising gently, backlit, shallow depth of field, cozy atmosphere.
```

示例：
> 一杯手冲咖啡特写，热气从杯口袅袅升起，细长柔缓，在清晨窗边的侧逆光中轻柔可见，浅景深背景书架柔和虚化，温暖治愈氛围。Steam rising gently from fresh coffee, backlit by morning window light, shallow DOF, cozy.

### 模板 F：水下场景

```
水下视角，[主体]在水中失重悬浮，串串气泡缓缓上升，
阳光穿透水面投下晃动的折射光纹，整体蓝色调，[发丝/衣料]轻柔漂浮。
Underwater, floating weightlessly, bubbles rising, caustic light patterns, blue tones.
```

示例：
> 水下视角，白裙少女在水中失重悬浮，串串气泡缓缓上升，阳光穿透水面投下晃动的折射光纹，整体通透蓝色调，裙摆与发丝轻柔漂浮。Underwater scene, bubbles rising slowly, caustic light patterns, ethereal blue tones.

---

## 八、意图 → 流体 → 提示词 决策流程（Agent 推理链）

```
用户意图
  │
  ├─ "要水花/水波/水景" → 水
  │     ├─ 动态冲击（飞溅/拍岸）→ 形态：droplets/foam + 方向 + slow motion + backlit
  │     └─ 静态氛围（波纹/倒影）→ 形态：ripples/reflection + 起因 + gentle + 光线反射
  │
  ├─ "要下雨" → 雨
  │     ├─ 氛围小雨 → drizzle + misty + 逆光隐约可见 + 湿漉地面
  │     └─ 戏剧暴雨 → downpour/torrential + backlit（必写）+ 积水溅射 + 反光
  │
  ├─ "要烟/雾氛围" → 烟雾/雾
  │     ├─ 轻盈上升 → wisps of smoke curling + backlit + sparse
  │     ├─ 厚重压迫 → thick black smoke billowing + slow
  │     ├─ 贴地神秘 → low-lying fog crawling + 地面光源
  │     └─ 仙境光柱 → volumetric fog + god rays（成功率最高组合）
  │
  ├─ "要火" → 火
  │     ├─ 温馨 → candle flame flickering + warm glow（小而稳）
  │     ├─ 野性 → bonfire + glowing embers spiraling + slow motion
  │     └─ 爆裂 → explosion fireball billowing + thick smoke
  │
  ├─ "要氛围颗粒感" → 光尘/雪/粒子
  │     ├─ 室内治愈 → dust particles in light beam + sparse + 慢
  │     ├─ 冬日浪漫 → fluffy snowflakes falling softly + 地面积雪
  │     └─ 庆典华丽 → confetti fluttering / glitter shimmering
  │
  └─ "要水下" → 水下
        → bubbles rising + caustic light + blue tones + weightless 四件套缺一不可

通用收尾：所有流体提示词最后自检——形态写了吗？方向写了吗？速度写了吗？光线写了吗？程度词写了吗？逻辑（雨湿地、雪积地、汽有源）通吗？
```

---

## 九、关联知识（后续主题预留）

- PHYS-002 材质与纹理（水面反射、金属、布料等表面质感）
- SCENE-001 天气与氛围（雨、雪、雾的场景级描述与情绪映射）
- OPTICS-003 快门速度与运动模糊（慢门水流拉丝、180° 快门规则、慢动作原理）
- LIGHT-001 光线方向与质感（逆光/侧光/背光——流体可见性的前提）

> 流体提示词的可见性依赖光线方向，动感依赖快门与慢动作，生成提示词时建议 PHYS-001 与 LIGHT-001、OPTICS-003 联合检索。
