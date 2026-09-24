# 夜景与人工光源（Night & Artificial Light）领域知识库

> **用途**：AI 视频生成系统的提示词知识库。供数字员工 / Agent 在生成视频提示词时检索调用。
> **主题编号**：LIGHT-003　**版本**：v1.0　**更新日期**：2026-09-24
> **使用方式**：Agent 接收到涉及"夜景、霓虹、赛博、灯火、烛光、车灯、夜色氛围"等创作意图时，检索本主题，将模糊的"夜晚"翻译为具体光源组合 + 反射面 + 暗部层次的视觉描述写入提示词。**注意：AI 视频模型不理解"夜晚"这个抽象概念，必须把夜景拆成一个个点名的光源**（见第六章映射表）。

---

## 一、核心概念

### 1.1 夜景的本质：不是"黑"，是"点光源的拼图"

新手（和 AI 模型）对夜景最大的误解是：夜景 = 把白天画面调暗。完全错误。

> **夜景画面 = 一个个光源区域 + 光源之间的暗部层次**

真实夜景里，观众的视线是被一个个发光体组织起来的：一盏路灯照亮一小圈地面，一块霓虹招牌染红半面墙，一扇橱窗透出暖光，远处车流拖出光的线条。**光源之外不是纯黑，而是有层次的深蓝、暗紫、墨绿**——被天光、月光、城市光污染微弱照亮的暗部。

记忆口诀：**"夜景不画黑，夜景只画灯"**。Agent 生成夜景提示词时，第一要务不是描述"暗"，而是清点画面里有哪些光源、各是什么颜色。

### 1.2 夜景画面的三大构成

| 构成 | 作用 | 缺失后果 |
|---|---|---|
| **光源区域**（霓虹、路灯、橱窗、车灯……） | 视觉锚点，组织画面，提供色彩 | 画面一团死黑，无焦点 |
| **反射面**（湿地面、玻璃、水面、车身） | 光源的"复印件"，让光翻倍、增加层次 | 夜景干涩、廉价 |
| **暗部层次**（深蓝/暗紫的天空与阴影） | 衬托光源，提供空间深度 | 暗部死黑=画面像贴了黑纸 |

### 1.3 夜景为什么是 AI 视频的"高级感富矿"

- 夜景天然高对比、强色彩、强氛围，是 AI 视频最容易出"电影感""高级感"的题材；
- 但模型同时有强烈的**"夜景=全部糊黑"失败模式**：提示词只写 night / dark，模型就输出一块黑画布配几个白点；
- **破解方法唯一且有效：提示词必须点名具体光源**（neon signs / sodium streetlights / candle flame），并指定光源颜色与反射面。

---

## 二、人工光源全表（核心速查）

> 本表是 Agent 构建夜景提示词的"光源零件库"。每种光源给出：色温色彩、情绪氛围、典型场景、AI 提示词写法。**色温概念详见 LIGHT-002 时段与色温**。

| 光源 | 英文名 | 色温 / 色彩 | 氛围 | 典型场景 | AI 提示词写法（中 / 英） |
|---|---|---|---|---|---|
| **城市霓虹** | neon signs | 品红/青/紫等饱和色，冷暖混杂 | 赛博、繁华、迷幻、都市欲望 | 雨夜街道、赛博朋克城市、港风老街 | 霓虹招牌在潮湿街道上投下品红与青色光晕 / neon signs casting pink and cyan glow on wet street |
| **路灯（钠灯）** | sodium streetlight | 约 2200K，暖橙色 | 孤独、怀旧、安静、市井 | 空旷街角、深夜小巷、独行人物 | 暖橙色路灯光池照亮一小圈柏油路 / warm orange pool of sodium streetlight |
| **车灯与车轨** | car lights / light trails | 车头白黄、车尾红，流动线条 | 流动、速度、都市脉搏 | 高架、长曝光街景、俯瞰城市 | 车流拖出红白光轨划破夜色 / red and white light trails from traffic, long exposure |
| **橱窗与广告牌** | storefront glow / billboard glow | 暖白/冷白/彩色，大面积柔光 | 商业感、烟火气、城市亮度基底 | 商业街、便利店、深夜橱窗 | 便利店橱窗透出冷白光洒在人行道上 / cold white glow spilling from storefront window |
| **室内钨丝灯** | tungsten light | 约 2800–3200K，暖黄 | 温暖、家居、亲密、怀旧 | 客厅、咖啡馆、卧室夜戏 | 暖黄钨丝灯下的室内，温馨家居氛围 / warm tungsten interior, cozy domestic glow |
| **烛光** | candlelight | 约 1800K，极暖橙黄，闪烁 | 浪漫、神秘、油画感、仪式感 | 晚餐、生日、古堡、祈祷 | 烛光摇曳，在脸上投下温暖跳动的光影 / flickering candlelight, warm dancing shadows on face |
| **屏幕光** | screen glow | 冷蓝白（约 6500K+） | 现代生活、孤独、科技、深夜 | 深夜办公、床上刷手机、网吧 | 冷蓝屏幕光照亮黑暗中的人脸 / cold blue screen glow illuminating face in the dark |
| **LED 彩灯 / 氛围灯** | LED strip / ambient RGB light | 任意色，常品红/紫/蓝 | 潮流、居家氛围、电竞、派对 | 卧室氛围灯、电竞房、酒吧 | 紫色 LED 氛围灯勾勒房间轮廓 / purple LED ambient light outlining the room |
| **舞台光** | stage light | 高饱和彩色 + 强聚光 | 戏剧、表演、聚焦、狂欢 | 演唱会、剧场、Livehouse | 彩色舞台追光刺破黑暗，光束中尘埃飞舞 / colored stage spotlights cutting through darkness, dust in light beams |
| **手电筒 / 探照灯** | flashlight / searchlight | 冷白窄光束 | 悬疑、探索、紧张、惊悚 | 黑暗走廊、废墟探险、夜间搜索 | 手电筒光束在黑暗中扫动，只照亮局部 / flashlight beam sweeping through darkness |
| **烟花** | fireworks | 高饱和彩色，瞬时光爆 | 庆典、浪漫、绚烂、短暂 | 跨年、节日、告白场景 | 烟花在夜空绽放，彩色光点洒落 / fireworks bursting in night sky, colorful sparks falling |
| **闪电** | lightning | 冷白蓝，瞬时强光 | 震撼、危险、史诗、恐怖 | 暴风雨夜、旷野、海景 | 闪电撕裂夜空，瞬间照亮乌云轮廓 / lightning bolt tearing the sky, briefly illuminating storm clouds |
| **月亮与月光** | moonlight | 实际极弱的冷光（约 4000K 感），画面常做蓝化处理 | 静谧、孤独、诗意、冷峻 | 月夜旷野、屋顶、窗边剪影 | 冷蓝月光洒落，物体拖出长长的影子 / cold blue moonlight, long soft shadows |

### 光源使用要点

- **钠灯 vs 钨丝灯不要混**：钠灯是街头户外橙光，钨丝灯是室内暖黄光，英文提示词分别用 sodium 与 tungsten，模型对这两个词响应非常好；
- **月光其实极弱**：真实月光照度很低，电影里"雪亮月夜"是打光结果。提示词写 moonlit 时建议补充 cold blue 色调与长影子，模型才能给出"可读的月夜"而非黑场；
- **屏幕光是当代叙事利器**：一个人 + 一块屏幕冷光 = 讲不完的都市孤独故事，且构图简单、模型成功率高。

---

## 三、夜景三要素（Agent 组词公式）

### 3.1 光源颜色对比

夜景的高级感大半来自**光源之间的色彩对撞**，而非光源本身：

| 对比组合 | 英文写法 | 情绪 | 典型用途 |
|---|---|---|---|
| **青橙对比** | teal and orange | 电影感、都市、主流大片 | 霓虹街道、城市夜景通用 |
| **品红青对比** | magenta and cyan | 赛博、迷幻、未来感 | 赛博朋克、电竞、潮流 |
| **暖黄 vs 冷蓝** | warm tungsten vs cold blue | 内外两个世界、孤独与温暖 | 窗内暖光 vs 窗外冷夜 |
| **红 vs 青** | red neon vs cyan haze | 危险、欲望、港风 | 老街、悬疑、犯罪题材 |

> 配色原理详见 COLOR-001 色调与配色。提示词中**至少写出一对色彩对比**，夜景立刻脱离"黑+白点"的廉价感。

### 3.2 反射面（夜景的免费加分项）

光源只画一次是夜景，光源 + 反射是**大片夜景**：

- **湿地面 / 雨后街道**：rain-soaked street, wet asphalt reflections——把每个光源复制一份拉长，画面信息量翻倍；
- **玻璃幕墙 / 橱窗**：glass reflections, neon reflected in windows；
- **水面**：城市河景、海港，lights reflected on water；
- **车身 / 墨镜 / 手机屏幕**：小面积高光反射，特写镜头的质感来源。

> 规则：只要夜景提示词里出现"雨"或"湿地面"，模型成功率与高级感同步上升。**拿不准就加 rain-soaked**。

### 3.3 暗部不是死黑（保留层次）

- 提示词中主动描述暗部内容：deep blue night sky / faint purple haze / silhouettes of buildings in the dark；
- 保留细节的关键词：detailed shadows, visible shadow detail, moody low-key lighting with rich blacks（rich blacks ≠ 死黑，是"有质感的深黑"）；
- 反向规避：不要只写 dark / black night，这正是触发模型"全部糊黑"的词。

---

## 四、拍摄侧的特有规则（Agent 必须知道的翻译逻辑）

1. **大光圈 + 高感是夜景标配**：夜景拍摄依赖 f/1.4–f/2.8 大光圈进光（联动 OPTICS-001 光圈），配合高感光度（联动 OPTICS-004 ISO）。翻译成画面语言：浅景深 + 背景灯点化作圆形光斑（bokeh city lights）+ 轻微胶片颗粒。
2. **星芒 = f/16 + 点光源**：想让路灯、车灯出放射状星芒，描述 starburst streetlights / radiating light rays（联动 OPTICS-001 第四章 f/16 条目）。
3. **车轨 = 长曝光**：车灯光轨是慢门拖影的产物（联动 OPTICS-003 快门速度与运动模糊），提示词必须带 long exposure / light trails，否则模型只画静止的车。
4. **手持夜景的晃动感**：纪实感夜景可加 handheld, slight camera shake, available light，弱化"影棚感"。
5. **噪点辩证看**：高感噪点在视频里可描述为 film grain / subtle noise，少量颗粒是胶片氛围，过量才是事故（见第五章误区）。

---

## 五、常见误区（生成提示词时的纠错规则）

| 误区 | 纠正 |
|---|---|
| "夜景=把画面调暗" | 夜景=点光源拼图。提示词点名具体光源，而不是写 dark |
| "提示词写 night 模型就懂" | night 只会触发黑场。必须写 neon signs / streetlights / candle flame 等具体光源 |
| "暗部越黑越干净" | 死黑=画面贴黑纸。暗部要有深蓝/暗紫层次与剪影 |
| "噪点毁所有" | 适量 film grain 是夜景胶片氛围；只有满屏彩色噪点才是失败，可加 clean shadows 约束 |
| "月光很亮" | 月光是极弱冷光，写 moonlit 要配 cold blue 色调与长影子，否则画面不成立 |
| "夜景颜色越多越好" | 一个画面 1–2 对色彩对比足矣；五颜六色全上=廉价游乐场 |
| "所有光源一个色温" | 真实城市夜景色温混杂（橙钠灯+冷橱窗+蓝屏幕），混杂才真实 |
| "车轨直接写车灯就行" | 不写 long exposure / light trails，模型只生成静止车辆 |

---

## 六、创作意图 → 提示词关键词映射表（Agent 核心调用区）

> 规则：**提示词里不要只写"夜晚/night"**，按本表把意图翻译成"具体光源 + 颜色 + 反射面 + 暗部层次"。中英文都给，英文关键词对国际模型更有效。

| 创作意图 | 中文提示词写法 | 英文关键词 |
|---|---|---|
| 霓虹街头 | 霓虹招牌林立的街道，品红与青色光晕 | neon-lit street, pink and cyan neon signs, glowing signage |
| 赛博朋克城市 | 赛博朋克都市夜景，密集霓虹与全息广告，青品红对比 | cyberpunk city night, dense neon and holographic ads, magenta-cyan contrast |
| 雨夜反射 | 雨后潮湿街道倒映霓虹灯光 | rain-soaked street reflections, wet asphalt mirroring neon lights |
| 暖色路灯孤独感 | 暖橙钠灯光池照亮空旷街角 | warm orange sodium streetlight pool, lonely empty street corner |
| 钨丝灯室内 | 暖黄钨丝灯下的温馨室内 | warm tungsten interior, cozy 2800K glow, domestic warmth |
| 烛光场景 | 烛光摇曳，温暖跳动的光影，油画质感 | candlelit, flickering warm candlelight, chiaroscuro oil painting look |
| 屏幕光照脸 | 黑暗中冷蓝屏幕光照亮人脸 | screen glow on face, cold blue monitor light in dark room |
| 车轨长曝 | 长曝光下车流拖出红白光轨 | car light trails long exposure, red and white streaks of traffic |
| 城市光斑虚化 | 背景城市灯光化作圆形散景光斑 | bokeh city lights, creamy defocused light orbs, f/1.4 look |
| 月夜 | 冷蓝月光洒落，地面拖出长影 | moonlit, cold blue moonlight, long soft shadows |
| 烟花夜空 | 烟花在夜空绽放，火星洒落 | fireworks in night sky, bursting sparks, celebration glow |
| 闪电风暴夜 | 闪电撕裂夜空，瞬间照亮云层 | lightning storm night, bolt illuminating dark clouds |
| 电影感夜景 | 电影感夜景，青橙色调，丰富暗部细节 | cinematic night scene, teal and orange grade, rich shadow detail |
| LED 氛围房间 | 紫蓝色 LED 氛围灯勾勒房间 | LED ambient lighting, purple-blue glow outlining the room |
| 舞台追光 | 舞台追光刺破黑暗，光束中尘埃飞舞 | stage spotlight cutting through darkness, volumetric light beams |
| 手电筒悬疑 | 手电筒光束在黑暗中扫动 | flashlight beam sweeping through darkness, suspense |
| 橱窗夜光 | 深夜商店橱窗透出冷白光 | storefront glow at night, cold white light spilling onto sidewalk |
| 窗内暖光 vs 窗外冷夜 | 窗内暖黄灯光与窗外冷蓝夜色对比 | warm window light against cold blue night, interior-exterior contrast |

---

## 七、提示词模板（Agent 直接填空调用）

### 模板 A：赛博霓虹街头

```
[城市/街道描述]的夜晚，密集霓虹招牌[招牌颜色：品红/青/紫]闪烁，
[人物]穿行其间，地面[反射面]倒映灯光，暗部建筑呈深蓝剪影，
青品红对比色调，电影感。
Cyberpunk city night, neon-lit street, magenta and cyan contrast, cinematic.
```

示例：
> 未来都市窄巷的夜晚，密集霓虹招牌品红与青色闪烁，穿黑色雨衣的独行女子穿行其间，潮湿地面倒映灯光，暗部建筑呈深蓝剪影，青品红对比色调，电影感，镜头缓慢跟随。Cyberpunk city night, neon-lit alley, magenta and cyan contrast, wet pavement reflections, cinematic tracking shot.

### 模板 B：雨夜反射

```
雨后的[街道场景]，积水路面如镜，倒映[光源1：霓虹/路灯]与[光源2：车灯/橱窗]，
[人物/车辆]经过激起细微波纹，空气中有薄雾，[色彩对比]色调。
Rain-soaked street, wet asphalt reflections, [light source] mirrored in puddles, light haze.
```

示例：
> 雨后的十字路口，积水路面如镜，倒映红色霓虹与暖黄车灯，一辆出租车缓缓经过激起细微波纹，空气中有薄雾，青橙对比色调。Rain-soaked intersection, neon and headlights mirrored in puddles, light haze, teal and orange, slow dolly shot.

### 模板 C：烛光人像

```
[人物描述]在黑暗中，仅靠[蜡烛数量]支烛光照明，烛光摇曳，
在脸上投下温暖跳动的光影，背景隐入深黑，油画质感，浅景深。
Candlelit portrait, flickering warm candlelight, chiaroscuro, oil painting texture, shallow DOF.
```

示例：
> 一位长发女子在黑暗书房中，仅靠三支烛光照明，烛光摇曳在她脸上投下温暖跳动的光影，背景隐入深黑，油画质感，浅景深，镜头极缓慢推进。Candlelit portrait, three flickering candles, chiaroscuro lighting, oil painting look, shallow depth of field, slow push-in.

### 模板 D：城市车轨

```
[高处视角/街角视角]俯瞰[道路/高架]，长曝光效果，
车流拖出红色尾灯与白色前灯的光轨，划破深蓝夜色，
两旁建筑[灯光描述]，画面通透。
Long exposure, car light trails, red and white streaks of traffic cutting through deep blue night.
```

示例：
> 高楼天台俯瞰城市高架，长曝光效果，车流拖出红色尾灯与白色前灯的光轨划破深蓝夜色，两旁写字楼灯火点点，画面通透，镜头缓慢横移。Long exposure from rooftop, red and white light trails cutting through deep blue night, glowing office windows, slow pan.

---

## 八、意图 → 光源组合 → 提示词 决策流程（Agent 推理链）

```
用户意图
  │
  ├─ "赛博/未来/潮流" → 霓虹 + LED + 湿地面反射
  │     → neon-lit street + magenta and cyan + rain-soaked reflections
  │
  ├─ "孤独/安静/深夜街头" → 钠灯路灯 + 大面积暗部
  │     → warm sodium streetlight pool + deep blue shadows + empty street
  │
  ├─ "浪漫/仪式/油画感" → 烛光（唯一主光源）
  │     → candlelit + flickering warm light + chiaroscuro
  │
  ├─ "温馨/家/夜晚室内" → 钨丝灯 + 窗外冷色夜
  │     → warm tungsten interior + cold blue night outside window
  │
  ├─ "现代生活/深夜独处" → 屏幕光（冷蓝）
  │     → screen glow on face + dark room + cold blue
  │
  ├─ "都市脉搏/速度/俯瞰" → 车灯车轨（长曝）
  │     → car light trails + long exposure + deep blue night
  │
  ├─ "庆典/告白/高潮时刻" → 烟花
  │     → fireworks in night sky + sparks falling + faces lit by bursts
  │
  ├─ "悬疑/探索/惊悚" → 手电筒/探照灯窄光束
  │     → flashlight beam sweeping + darkness + limited visibility
  │
  ├─ "史诗/危险/自然力量" → 闪电
  │     → lightning bolt + storm clouds briefly illuminated
  │
  └─ "诗意/冷峻/旷野" → 月光（弱冷光）
        → moonlit + cold blue + long soft shadows + silhouette
```

---

## 九、关联知识

- LIGHT-002 时段与色温（色温数值体系；钠灯 2200K / 钨丝灯 2800K / 屏幕光 6500K 的色温坐标）
- OPTICS-001 光圈（夜景大光圈虚化光斑、f/16 点光源星芒）
- OPTICS-004 ISO（高感与夜景颗粒/噪点的平衡）
- COLOR-001 色调与配色（青橙/品红青对比的色彩原理）

> 夜景提示词的标准配方 = 具体光源（本主题第二章）+ 色彩对比（COLOR-001）+ 反射面 + 暗部层次 + 大光圈虚化（OPTICS-001）。生成夜景视频提示词时建议 LIGHT-003 与 COLOR-001 联合检索。
