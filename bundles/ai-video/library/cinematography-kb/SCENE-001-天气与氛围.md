# 天气与氛围（Weather & Atmosphere）领域知识库

> **用途**：AI 视频生成系统的提示词知识库。供数字员工 / Agent 在生成视频提示词时检索调用。
> **主题编号**：SCENE-001　**版本**：v1.0　**更新日期**：2026-09-24
> **使用方式**：Agent 接收到涉及"天气、下雨、下雪、雾、氛围、情绪场景"等创作意图时，检索本主题，将天气意图翻译为画面特征 + 光线条件 + 动态描述写入提示词。**注意：AI 视频模型不理解"忧郁""史诗"这类抽象情绪词本身，必须把情绪翻译成具体的天气、光线、地面反馈的视觉描述**（见第六章映射表）。

---

## 一、核心概念

### 1.1 天气是什么：免费的美术指导

天气是画面里**成本最低、收益最高的美术指导**。同一个场景、同一个人物、同一个动作，换一种天气，情绪和质感完全不同：

> **天气 = 情绪 + 光线 + 质感 的三合一预设**

- **情绪层**：雨=告别与释放，雪=安静与孤独，雾=迷茫与神秘，雨后初晴=新生与希望
- **光线层**：阴天=天然柔光箱，晴天=硬光高反差，雾天=天然柔焦与空气透视
- **质感层**：湿面反光、积雪脚印、雾中光柱——天气会给场景"加材质"

记忆口诀：**"定天气就是定情绪，定情绪先定天气"**（Agent 生成内容时最常被忽略的一步——用户只说"一个人在街上走"，Agent 应主动追问或推断天气）。

### 1.2 天气的三大画面杠杆

| 杠杆 | 天气如何起作用 | 示例 |
|---|---|---|
| **光线条件** | 云层厚度决定光的软硬与色温 | 阴天光线均匀无阴影，拍人像皮肤干净 |
| **空气介质** | 雨、雪、雾、尘在空气中形成"可见的介质" | 雾让远处景物逐层变淡，画面自带纵深 |
| **地面反馈** | 天气改变地面材质，反射与纹理翻倍 | 雨后湿街=天然镜面，霓虹倒影让画面信息量翻倍 |

### 1.3 好天气的三个判断维度（Agent 选天气时的完整公式）

"好天气"不等于"晴天"。为创作服务的天气判断：

1. **情绪匹配**：想表达的情绪 → 对应天气（见第三章速查表）
2. **光线可用**：该天气下是否有可拍的光（阴天柔光适合人像，暴雨天逆光雨丝适合戏剧）
3. **介质可见**：空气中的雨/雪/雾能否被光线"照亮"（逆光下雨丝雪粒才可见，见第四章）

> 提示词组合技巧：天气描述不要只写名词，组合"天气 + 光线方向 + 地面反馈"三件套，真实感最稳定。

---

## 二、天气全表（核心速查）

> 每格给出：画面特征 / 光线条件 / 情绪气质 / 典型题材 / 拍摄注意 / AI 提示词写法。

### 2.1 晴与云

| 天气 | 画面特征 | 光线条件 | 情绪气质 | 典型题材 | 拍摄注意 | AI 提示词写法 |
|---|---|---|---|---|---|---|
| **晴天 clear sky** | 通透、蓝天、阴影锐利 | 硬光、高反差、正午顶光慎用人像 | 活力、明朗、开阔 | 旅行、运动、青春片 | 正午阴影过硬，优先清晨/傍晚；逆光要补光 | 晴朗通透的蓝天，阳光锐利，强烈明暗对比 / clear blue sky, harsh sunlight, crisp shadows |
| **多云 partly cloudy** | 天空有层次，云朵体积感强 | 软硬交替，云隙光可能出现 | 丰富、变幻、叙事感 | 风光、城市延时、公路片 | 关注云的动势，给天空留构图空间 | 天空云层层次丰富，云隙间透下光束 / dramatic layered clouds, sunbeams through cloud gaps |
| **阴天 overcast** | 灰白天幕、无阴影、低饱和 | 天然柔光箱，光线均匀柔和 | 忧郁、沉静，也可温柔干净 | 情绪人像、文艺片、日系小清新 | 画面易平，靠构图和色彩破局；人脸极友好 | 阴天天光柔和均匀，低饱和色调，无阴影 / overcast sky, soft diffused light, muted colors, no harsh shadows |

### 2.2 雨家族

| 天气 | 画面特征 | 光线条件 | 情绪气质 | 典型题材 | 拍摄注意 | AI 提示词写法 |
|---|---|---|---|---|---|---|
| **毛毛雨 drizzle** | 细密雨雾、空气湿润、几乎无声 | 柔光，雨天散射光 | 温柔、诗意、淡淡忧伤 | 文艺片、爱情戏、独白场景 | 雨丝太细需逆光或暗背景才可见；镜头注意水渍 | 细密雨丝在光中飘浮，空气湿润朦胧 / gentle drizzle, fine mist of rain, soft diffused light |
| **暴雨 downpour** | 雨幕倾泻、水花四溅、视线模糊 | 低照度，常配夜景灯光 | 戏剧、狼狈、释放、宣泄 | 冲突戏、哭戏、动作片 | 必须给雨"打光"（路灯/车灯逆光）；地面积水反光是关键 | 倾盆大雨形成雨幕，路灯逆光下雨水清晰可见，地面积水飞溅水花 / heavy downpour, rain backlit by streetlights, splashing puddles |
| **雷雨 thunderstorm** | 乌云压顶、闪电划破、天地昏暗 | 极低照度 + 闪电瞬时强光的极端反差 | 史诗、压迫、危机降临 | 灾难片、史诗片、重大转折 | 闪电是天然"快门"，可作为画面节奏点；云层的翻滚动势要写 | 乌云翻滚压顶，闪电照亮云层内部，暴雨如注 / dark storm clouds rolling, lightning illuminating clouds, torrential rain |
| **雨后初晴 after rain** | 湿面反光、云隙金光、空气清新 | 低角度金色阳光 + 遍地镜面反射 | 新生、希望、释然（出片神场景） | 治愈系、广告、结局场景 | 黄金窗口极短（雨停后 20 分钟内）；湿地面反光加倍光线层次 | 雨停后阳光刺破云层，湿漉漉的街道反射金色天光 / sun breaking through clouds after rain, wet streets reflecting golden light |

### 2.3 雪与冰霜

| 天气 | 画面特征 | 光线条件 | 情绪气质 | 典型题材 | 拍摄注意 | AI 提示词写法 |
|---|---|---|---|---|---|---|
| **雪 snow** | 天地纯白、落雪飘舞、万物静音 | 雪地强反射，阴天雪=柔光，晴天雪=高亮 | 纯净、安静、浪漫、孤独 | 爱情片、告别戏、冬日童话 | 曝光+1 档防雪发灰；雪粒逆光/暗背景才可见 | 雪花缓缓飘落，天地纯白宁静，脚印延伸向远方 / fresh snow falling, pure white world, footprints in snow |
| **霜 frost** | 草木覆白晶、呼吸成雾、清冷通透 | 清晨低角度冷白光，霜面微闪 | 清冷、静谧、初冬感 | 晨景、静物微距、乡村题材 | 霜的晶莹质感需要侧逆光刻画；与"冰晶微距"联动 | 清晨薄霜覆满草叶，呼吸化作白雾，晨光清冷 / frosty morning, frost-covered grass, visible breath in cold air |
| **冰雹 hail** | 冰粒砸落、弹跳四溅、突发暴力感 | 阴天散射光 | 突发、狼狈、自然的暴力 | 灾难场景、突发转折 | 冰雹落地的"弹跳"动态是真实感关键；慎用于人物近景 | 冰雹密集砸落地面弹跳四溅 / hailstones pelting down, bouncing off the ground |

### 2.4 雾、霾与沙尘

| 天气 | 画面特征 | 光线条件 | 情绪气质 | 典型题材 | 拍摄注意 | AI 提示词写法 |
|---|---|---|---|---|---|---|
| **雾 fog** | 远景消隐、层次极简、大量留白 | 柔焦散射光，光源周围出光晕 | 神秘、迷茫、静谧、高级感 | 悬疑片、森林场景、极简美学 | 雾中光柱（逆光/侧逆光）是灵魂；前景要有参照物定空间 | 浓雾弥漫，远处景物若隐若现，光束在雾中形成光柱 / dense fog, silhouettes fading into mist, light rays piercing through fog |
| **晨雾 morning mist** | 低空流动的薄雾、贴地弥漫 | 晨光斜射，雾层被染成金色或蓝调 | 仙气、宁静、新生 | 山水、田野、湖泊晨景 | 日出前后 30 分钟最佳；雾在流动，视频比照片更出效果 | 清晨薄雾贴着水面缓缓流动，晨光将雾染成淡金色 / morning mist drifting over water, golden dawn light |
| **霾 haze** | 空气浑浊、远景发黄发灰、距离感压缩 | 平光、暖调偏黄 | 压抑、都市感、末日氛围 | 都市题材、反乌托邦 | 霾≠雾：霾偏黄灰、不透明感；不要写成浪漫白雾 | 空气浑浊发黄，远处高楼只剩灰暗轮廓 / hazy polluted air, distant buildings as gray silhouettes |
| **沙尘 dust storm** | 天地昏黄、能见度极低、颗粒飞舞 | 昏黄漫射光，太阳成惨白圆盘 | 末日、苍凉、史诗、压迫 | 废土片、西部片、灾难片 | 侧光下沙尘颗粒最可见；人物需护具/眯眼等细节配合 | 昏黄沙尘席卷天地，太阳变成惨白圆盘，颗粒在风中飞舞 / dust storm, orange haze, particles flying in the wind, pale sun |

### 2.5 特殊天象

| 天气 | 画面特征 | 光线条件 | 情绪气质 | 典型题材 | 拍摄注意 | AI 提示词写法 |
|---|---|---|---|---|---|---|
| **彩虹 rainbow** | 雨后弧形彩桥、常配湿景与金光 | 雨后初晴的低角度阳光（人背对太阳才见虹） | 希望、治愈、童话感 | 治愈系、广告、儿童题材 | 彩虹必须配"雨后"语境才合理；湿地面+金光+虹=三重出片 | 雨后天空挂起彩虹，湿润草原反射天光 / rainbow after storm, wet meadow glowing |
| **台风风眼 typhoon eye** | 风暴前后天光魔幻：铅灰、紫红、诡异的平静 | 非常态色温，紫灰/橙红混合天光 | 魔幻、不安、末日前的宁静 | 灾难片、超现实场景 | 重点写"反常"：风暴中突然风停云开的诡异平静 | 台风眼过境，风暴中突然一片诡异的宁静，天空呈紫灰色 / eerie calm in the eye of the storm, purple-gray sky |

---

## 三、天气情绪速查表（分情绪实战指南）

> Agent 最常用的检索路径：**用户给情绪 → 查本表选天气 → 去第六章拿提示词**。

| 想表达的情绪 | 首选天气 | 备选天气 | 原因 |
|---|---|---|---|
| 告别 / 离别 | 雨（毛毛雨→暴雨按烈度选） | 阴天 | 雨是影视里最经典的告别介质，雨滴=眼泪的替代物 |
| 新生 / 希望 / 释然 | 雨后初晴 | 彩虹、晨光 | 湿面金光自带"劫后重生"的物理隐喻 |
| 迷茫 / 迷失 | 雾 | 霾 | 视线被剥夺=方向感被剥夺 |
| 孤独 / 安静 | 雪 | 晨雾 | 雪吸收声音，画面自带"静音"效果 |
| 浪漫 / 心动 | 雪夜 / 毛毛雨 | 彩虹 | 落雪与细雨给亲密场景加柔焦滤镜 |
| 压抑 / 焦虑 | 阴天 | 霾、雷雨前 | 低饱和无影光让世界"没有出口" |
| 史诗 / 危机 | 雷雨 | 沙尘、台风风眼 | 天地力量的具象化 |
| 活力 / 明朗 | 晴天 | 多云 | 硬光高饱和，青春片的默认皮肤 |
| 神秘 / 悬疑 | 雾（夜雾最佳） | 雷雨夜 | 信息遮蔽=悬念 |
| 末日 / 苍凉 | 沙尘 | 霾、台风风眼 | 昏黄颗粒吞没世界秩序 |
| 温柔 / 治愈 | 毛毛雨 | 晨雾、雨后初晴 | 细密的介质让世界变软 |
| 清冷 / 克制 | 霜 | 晨雾（蓝调） | 低色温 + 极简质感 |

### 情绪强度的天气刻度

同一情绪可用天气强度调档（以"悲伤"为例）：

- 轻度：阴天 overcast（心里有事，但没哭出来）
- 中度：毛毛雨 drizzle（安静的流泪）
- 重度：暴雨 downpour（崩溃与宣泄）
- 转折：雨后初晴（哭完了，天亮了）

---

## 四、视频拍摄的特有规则（与拍照不同，Agent 必须知道）

1. **天气是动词不是名词**：视频里的天气必须写**动态**。雨的密度（细雨丝/雨幕）、雪的落速（缓飘/暴风雪）、雾的流动方向（贴地流动/翻滚升腾）都是提示词必填项。静态天气描述在视频模型里会生成"假天气"。
2. **雨丝、雪粒要逆光才可见**：空气中的介质颗粒需要**逆光或侧逆光**照明（路灯、车灯、窗户光）才能在画面里显形。提示词写法：rain backlit by streetlights / snowflakes glowing in backlight。顺光下雨雪直接消失（联动 LIGHT-001 光线方向）。
3. **地面反馈让真实感翻倍**：AI 视频最大的"假感"来源是天气与场景无交互。必须写交互：雨→wet streets / splashing puddles / reflections on wet ground；雪→footprints in snow / snow accumulating on shoulders；雾→silhouettes fading into fog。这是视频相比照片的决定性优势点（联动 PHYS-001 流体与粒子）。
4. **雪景曝光 +1 档**：相机/模型倾向把白雪拍成 18% 灰。提示词侧要强调 bright white snow / pure white，防止画面发灰发脏。
5. **雾中光柱需要光源 + 介质 + 角度三要素**：写 volumetric light rays / god rays through fog 时必须同时给出光源（清晨阳光、车灯、手电），否则模型只会生成"灰蒙蒙一片"（联动 LIGHT-002 时段与色温）。
6. **天气过渡是高级叙事**：视频可以写天气的**变化过程**：clouds gathering / rain gradually stopping / fog slowly lifting——天气变化本身即是时间流逝与情绪转折的可视化。
7. **声音的缺席也要写**：雪天的"万籁俱寂"在视觉上的等价物是 muffled, silent, still world——纯视觉提示词里写"安静"反而有助于模型生成低动态、稳定构图的画面。

---

## 五、常见误区（生成提示词时的纠错规则）

| 误区 | 纠正 |
|---|---|
| "坏天气不能拍/不能生成" | 反了。坏天气是免费的美术指导：雨=戏剧，雾=高级，雪=纯净，阴天=柔光箱。商业大片最爱坏天气 |
| "雪景直接拍就行" | 白雪会被拍成灰色。提示词必须强调 bright white / pure white，等效曝光 +1 档 |
| "写 rain 模型就会生成雨" | 只写 rain 往往生成"看不见的雨"。必须三件套：雨的密度 + 逆光照亮雨丝 + 地面水花/湿面反光 |
| "雾天就是灰蒙蒙" | 霾才是灰黄浑浊；雾是白色、有层次、能出光柱的。写反了情绪全错 |
| "晴天是最好的天气" | 正午晴天是拍人像最差的天气（顶光骷髅影）。晴天的正确用法是清晨/傍晚低角度光 |
| "阴天画面太灰没法用" | 阴天是天然柔光箱，人像皮肤、色彩还原的最佳天气；低饱和是风格不是缺陷 |
| "天气词写完就够了" | 天气只定氛围的一半，另一半在光线方向与地面反馈。三件套缺一不可 |
| "彩虹可以出现在任何场景" | 彩虹只存在于"雨后 + 阳光 + 观察者背对太阳"的物理语境中，否则出戏 |

---

## 六、创作意图 → 提示词关键词映射表（Agent 核心调用区）

> 规则：**提示词里不要只写天气名词**，按本表补全"光线 + 动态 + 地面反馈"。中英文都给，英文关键词对国际模型更有效。

### 6.1 天空与云

| 创作意图 | 中文提示词写法 | 英文关键词 |
|---|---|---|
| 阴天柔光氛围 | 阴天天光柔和均匀，低饱和色调，画面无阴影 | overcast sky, soft diffused light, muted colors, no harsh shadows |
| 云层层次天空 | 天空云层厚重有层次，云的体积感分明 | dramatic clouds, layered cloud formations, volumetric clouds |
| 云隙光 / 丁达尔 | 阳光从云隙间倾泻而下形成光柱 | sun breaking through clouds, crepuscular rays, god rays |
| 晴朗通透 | 晴朗蓝天，阳光通透，空气澄澈 | clear blue sky, crisp sunlight, crystal-clear air |

### 6.2 雨家族

| 创作意图 | 中文提示词写法 | 英文关键词 |
|---|---|---|
| 毛毛雨诗意 | 细密雨丝在光中飘浮，空气湿润朦胧 | gentle drizzle, fine mist of rain, soft rain haze |
| 暴雨戏剧 | 倾盆大雨形成雨幕，路灯逆光下雨水如银线，地面积水飞溅 | heavy downpour, sheets of rain backlit by streetlights, splashing puddles |
| 雷雨压迫 | 乌云翻滚压顶，闪电撕裂天空照亮云层 | thunderstorm approaching, dark rolling clouds, lightning splitting the sky |
| 雨中街头（夜景） | 雨夜街道，霓虹在湿滑路面拖出彩色倒影 | rainy night street, neon reflections on wet pavement |
| 雨后初晴 | 雨停后阳光刺破云层，湿街反射金色天光 | sun breaking through after rain, wet streets reflecting golden light |
| 彩虹 | 雨后天空挂起彩虹，湿润大地泛着天光 | rainbow after storm, rain-washed landscape glowing |

### 6.3 雪与冰霜

| 创作意图 | 中文提示词写法 | 英文关键词 |
|---|---|---|
| 落雪安静 | 雪花缓缓飘落，天地纯白宁静，万籁俱寂 | fresh snow falling, pure white world, silent snowfall |
| 暴雪 | 暴风雪呼啸，雪粒横飞，能见度极低 | blizzard, snowflakes flying sideways, whiteout conditions |
| 雪中脚印 | 新雪上一串脚印延伸向远方 | footprints trailing in fresh snow |
| 雪夜路灯 | 雪粒在路灯光晕中飞舞发光 | snowflakes swirling in streetlight glow, backlit snow |
| 霜晨 | 清晨薄霜覆满草叶，呼吸化作白雾，晨光清冷 | frosty morning, frost-covered grass, visible breath, crisp dawn light |
| 冰雹 | 冰雹密集砸落，在地面弹跳四溅 | hailstones pelting down, ice pellets bouncing off ground |

### 6.4 雾、霾、沙尘与特殊天象

| 创作意图 | 中文提示词写法 | 英文关键词 |
|---|---|---|
| 浓雾神秘 | 浓雾弥漫，人影在雾中若隐若现 | dense fog, silhouettes fading into mist |
| 晨雾流动 | 清晨薄雾贴着水面/山谷缓缓流动，晨光染金 | morning mist drifting over water, golden dawn light through mist |
| 雾中光柱 | 光束穿透浓雾形成清晰可见的光柱 | light rays piercing through fog, volumetric god rays in mist |
| 霾都压抑 | 空气浑浊发黄，远处高楼只剩灰暗剪影 | hazy polluted air, distant buildings as gray silhouettes |
| 沙尘末日 | 昏黄沙尘席卷天地，太阳变成惨白圆盘 | dust storm approaching, orange haze swallowing the city, pale sun |
| 台风风眼 | 风暴中心诡异的宁静，天空呈紫灰色 | eerie calm in the eye of the storm, purple-gray sky, ominous stillness |
| 冰雹暴 / 极端天象 | 天地昏暗，极端天气肆虐 | extreme weather, apocalyptic sky, nature's fury |

### 6.5 氛围叠加词（与天气配合使用）

- 雨系氛围：melancholic、cathartic、noir、moody、romantic
- 雪系氛围：serene、pristine、ethereal、lonely、hushed
- 雾系氛围：mysterious、dreamlike、minimalist、suspenseful
- 晴系氛围：vibrant、energetic、idyllic、crisp

---

## 七、提示词模板（Agent 直接填空调用）

### 模板 A：雨夜街头

```
[人物描述]在雨夜街道上[动作]，大雨倾盆，路灯/霓虹逆光将雨丝照成银线，
湿滑路面反射[光源颜色]的倒影，积水飞溅，[情绪氛围词]，电影感。
Heavy downpour, rain backlit by streetlights, neon reflections on wet pavement, cinematic.
```

示例：
> 一位撑黑伞的男人在雨夜街道上缓步前行，大雨倾盆，路灯逆光将雨丝照成银线，湿滑路面反射着霓虹灯红蓝色的倒影，脚下积水飞溅，孤独而克制的氛围，电影感。Heavy downpour, rain backlit by streetlights, neon reflections on wet pavement, moody, cinematic, slow tracking shot.

### 模板 B：雪中漫步

```
[人物描述]在[场景]中行走，雪花[落速描述]飘落，天地纯白明亮，
身后一串脚印延伸向远方，万籁俱寂，[情绪氛围词]。
Fresh snow falling, pure white world, footprints in snow, serene silence.
```

示例：
> 一位穿深色大衣的女子在空旷的雪原上缓步行走，大片雪花缓缓飘落，天地纯白明亮，身后一串脚印延伸向远方，万籁俱寂，安静而孤独。Fresh snow falling, bright white landscape, footprints trailing behind, serene and lonely, wide static shot.

### 模板 C：雾中森林

```
[场景描述]被浓雾笼罩，[光源]穿透雾气形成清晰光柱，
远处[元素]若隐若现只剩剪影，近处[前景元素]清晰，神秘悬疑氛围。
Dense fog, light rays piercing through mist, silhouettes fading into fog, mysterious.
```

示例：
> 清晨的松林被浓雾笼罩，晨光穿透雾气形成一道道金色光柱，远处树木若隐若现只剩深色剪影，近处挂着露珠的蕨叶清晰可见，神秘而静谧。Dense morning fog, sunbeams piercing through mist, tree silhouettes fading into fog, volumetric god rays, mysterious atmosphere, slow push-in.

### 模板 D：雨后初晴

```
雨停后的[场景]，阳光刺破云层洒下金光，湿漉漉的[地面/街道]
反射着天光与[元素]的倒影，空气清新通透，[人物][动作]，希望与释然。
Sun breaking through clouds after rain, wet ground reflecting golden light, fresh and hopeful.
```

示例：
> 雨停后的老城街道，阳光刺破云层洒下金色光束，湿漉漉的石板路反射着天光与建筑的倒影，空气清新通透，一个女孩收起雨伞仰头微笑，希望与释然。Sun breaking through clouds after rain, wet cobblestone street reflecting golden light, fresh clear air, hopeful mood, crane shot rising.

### 模板 E：雷雨压境（进阶）

```
[大场景描述]，乌云从[方向]翻滚压顶而来，闪电在云层内部炸亮，
狂风卷起[元素]，天地昏暗，史诗压迫感，[人物/主体]渺小立于前景。
Thunderstorm approaching, dark clouds rolling in, lightning illuminating clouds, epic and ominous.
```

---

## 八、情绪 → 天气 → 提示词 决策流程（Agent 推理链）

```
用户情绪意图
  │
  ├─ "告别/悲伤/宣泄" → 雨家族（按烈度：毛毛雨→暴雨→雷雨）
  │     → 提示词：gentle drizzle / heavy downpour backlit / thunderstorm approaching
  │
  ├─ "希望/新生/释然/治愈" → 雨后初晴 / 彩虹
  │     → 提示词：sun breaking through after rain + wet streets reflecting golden light
  │
  ├─ "迷茫/神秘/悬疑" → 雾（日雾=迷茫，夜雾=悬疑）
  │     → 提示词：dense fog + silhouettes fading + volumetric light rays
  │
  ├─ "孤独/安静/纯净" → 雪（注意 bright white 防发灰）
  │     → 提示词：fresh snow falling + pure white world + footprints + silence
  │
  ├─ "压抑/焦虑/克制" → 阴天 / 霾
  │     → 提示词：overcast sky + muted colors + no shadows
  │
  ├─ "浪漫/心动" → 雪夜路灯 / 毛毛雨
  │     → 提示词：snowflakes swirling in streetlight glow / gentle drizzle
  │
  ├─ "史诗/危机/末日" → 雷雨 / 沙尘 / 台风风眼
  │     → 提示词：thunderstorm approaching / dust storm / eerie calm in storm eye
  │
  └─ "活力/明朗/青春" → 晴天（限定清晨/傍晚低角度光）
        → 提示词：clear blue sky + golden sunlight + crisp shadows
```

**通用补全规则**：选定天气后，依次检查三件套——①介质动态写了吗（落速/密度/流向）？②逆光照亮介质写了吗？③地面反馈写了吗？三项齐全再输出。

---

## 九、关联知识（后续主题预留）

- PHYS-001 流体与粒子（雨滴、水花、雪粒、雾气的物理运动规律，写天气动态必查）
- LIGHT-001 光线方向与质感（逆光照亮雨丝雪粒的原理）
- LIGHT-002 时段与色温（晨雾的蓝调与金色、台风天光的非常态色温）
- SCENE-002 人群与空间（天气如何改变人群行为与城市空间质感）
- NARR-001 情绪 → 画面映射（情绪词汇翻译成视觉语言的总表，本主题第三章是其子集）

> 天气从不单独成立：它必然与光线（LIGHT 系列）、粒子物理（PHYS-001）、人物行为（SCENE-002）同时出现。生成天气类提示词时建议 SCENE-001 与 LIGHT-002、PHYS-001 联合检索。
