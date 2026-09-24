# 光线方向与质感（Light Direction & Quality）领域知识库

> **用途**：AI 视频生成系统的提示词知识库。供数字员工 / Agent 在生成视频提示词时检索调用。
> **主题编号**：LIGHT-001　**版本**：v1.0　**更新日期**：2026-09-24
> **使用方式**：Agent 接收到涉及"光线、光影、氛围、立体感、柔和、戏剧感"等创作意图时，检索本主题，将光的**方向 × 质感**翻译成模型可理解的画面描述写入提示词。**注意：AI 视频模型不理解布光术语本身，必须把光线意图翻译成明暗分布、阴影位置、情绪氛围的画面效果描述**（见第六章映射表）。

---

## 一、核心概念

### 1.1 光的两个维度：方向 × 质感

任何一段画面的光，都可以用两条轴拆解清楚：

- **方向（Direction）**：光从哪来——决定**立体感、明暗分布、情绪基调**。
- **质感（Quality）**：光是硬还是软——决定**明暗过渡的锐利程度、阴影的边缘**。

> 记忆口诀：**"方向塑造形状，质感决定气质"**（Agent 生成内容时，方向错了画面扁平，质感错了情绪跑偏）。

### 1.2 光线三大作用的速查表

| 维度 | 选项 | 画面结果 |
|---|---|---|
| **方向** | 顺光 / 侧光 / 逆光 / 顶光 / 底光 | 主体的受光面与阴影分布，立体感强弱 |
| **质感** | 硬光（直射）/ 软光（散射） | 阴影边缘锐利还是柔和，明暗反差大小 |
| **色温** | 暖 / 冷 | 情绪温度（详见 LIGHT-002 时段与色温） |

### 1.3 方向与质感是独立变量（Agent 最容易忽略的一点）

- 侧光可以是**软侧光**（阴天窗口 → 柔和立体）也可以是**硬侧光**（正午斜阳 → 强戏剧反差）。
- 逆光可以是**软逆光**（阴天剪影，灰调梦幻）也可以是**硬逆光**（日落金边，轮廓锋利）。

> 提示词组合技巧：不要只写方向或只写软硬，组合"方向 + 质感 + 情绪词"，如"柔和侧逆光 + 梦幻"，出片率显著更高。

---

## 二、光线方向全表（核心速查）

> 以人物面部为参照系，光源相对拍摄机位的方位命名。

| 中文名 | 英文名 | 画面效果 | 情绪气质 | 典型题材 | AI 提示词写法 |
|---|---|---|---|---|---|
| **顺光** | front light | 主体正面全亮，阴影藏在身后，画面偏平但显色最好 | 明快、干净、直白、纪实 | 证件感、产品展示、清新人像、美食 | 正面均匀受光，面部无明显阴影，色彩饱和通透；flat front light, even illumination, vivid colors |
| **前侧光 45°** | 45-degree light | 面部一侧亮一侧微暗，鼻梁投影自然，立体感与安全感的平衡 | 自然、亲和、稳妥、耐看 | 人像安全牌、采访、口播、日常 Vlog | 光源位于人物前方 45°，面部一侧柔和受光一侧浅阴影，立体而自然；45-degree key light, soft facial shadows, natural modeling |
| **侧光** | side light | 一半亮一半暗，皮肤纹理与材质细节被放大，阴影横切画面 | 戏剧性、力量感、沧桑感、质感 | 肖像特写、男性人像、建筑肌理、静物材质 | 光从人物正侧方照射，面部一半明亮一半沉入阴影，纹理分明；side light, half-lit face, dramatic texture, strong chiaroscuro |
| **侧逆 / 轮廓光** | rim light | 光源在主体后侧方，主体边缘被一圈亮线勾勒，发丝发光，与背景分离 | 精致、梦幻、高级感、仙气 | 逆光人像、产品轮廓、舞台、夜景人像 | 人物后侧方来光，发丝与肩膀被金色轮廓光勾勒，主体从暗背景中分离；golden rim light, glowing hair light, subject separated from background |
| **逆光** | backlight | 光源正对镜头，主体正面全暗成剪影，或大面积炫光雾化的梦幻感 | 浪漫、神秘、史诗、留白 | 剪影、日落、氛围短片、MV | 主体背对光源形成深色剪影，天空高光璀璨，光晕弥漫；silhouette backlight, glowing sky, lens flare, dreamy haze |
| **顶光** | top light | 光从头顶垂直落下，眼窝、鼻下、下巴投下深阴影，骷髅感；舞台则聚焦神圣 | 压抑、威严、审讯感 / 舞台仪式感 | 悬疑、审讯场景、舞台聚光、正午写实 | 顶光直射，眼窝深陷阴影，面部高光在额头与鼻梁；overhead top light, deep eye socket shadows, harsh noon look |
| **底光** | under light | 光源从下方往上打，下巴亮额头暗，完全违背日常视觉经验 | 恐怖、诡异、反派、邪典 | 惊悚、鬼故事篝火、反派登场 | 光源从人物下巴下方向上照射，面部阴影倒挂，眼窝发亮；under light, uplighting horror, sinister shadows |
| **伦勃朗光** | Rembrandt lighting | 45° 高位侧光，暗侧脸颊出现一个三角形光斑，明暗比经典 | 古典、油画感、庄重、深沉 | 经典肖像、男性人像、电影特写 | 暗侧脸颊出现标志性三角形光斑，如古典油画；Rembrandt lighting, triangle of light on shadow cheek, classical portrait |
| **蝴蝶光** | butterfly / paramount light | 光源在人物正前上方，鼻下投影呈蝴蝶形，颧骨高光、面部对称 | 优雅、时尚、美人光、复古好莱坞 | 时尚大片、美妆、女性人像、复古 glamour | 正面高位光，鼻下蝴蝶形浅影，面部对称明亮，颧骨高光；butterfly lighting, paramount lighting, symmetrical beauty light |
| **分割光** | split lighting | 光源在人物正侧 90°，面部严格一半亮一半暗，分界线沿鼻梁 | 性格张力、双面性、悬疑、硬汉 | 悬疑海报、反派/复杂角色、音乐人肖像 | 面部沿鼻梁精确一分为二，一半全亮一半全暗；split lighting, face split in half light and shadow, dramatic duality |

### 口诀扩展解读（保留骨架）

> 口诀：顺光显色侧光显质，轮廓分离逆光剪影，顶光压底光邪，伦勃朗三角蝴蝶美，分割一半看人心。

- **顺光——"安全但无聊"**：色彩还原最好、瑕疵最少，代价是扁平无立体感。适合"内容大于形式"的场景（产品、教程、新闻感）。
- **前侧光 45°——人像万能起点**：不知道用什么光就用它。立体感够、阴影柔和、任何脸型都不翻车，是 Agent 生成人像提示词的默认安全牌。
- **侧光——质感的放大器**：皮肤毛孔、布料织纹、墙面肌理在侧光下无所遁形。想要"高级感材质"必用；想要"磨皮柔美人像"慎用。
- **轮廓光——分离的魔法**：主体与背景亮度接近时，一圈 rim light 立刻把人物"剪"出来，是低成本制造高级感的手段。
- **逆光——不是废片是风格**：剪影保留轮廓与动作，隐藏表情与细节，天然带叙事留白；半逆光加镜头炫光则是梦幻 MV 标配。
- **顶光与底光——情绪的极端工具**：顶光向下压缩（压抑/神圣二选一，取决于上下文），底光向上颠倒（几乎必然诡异）。二者都是强风格，不可滥用。
- **伦勃朗与蝴蝶——古典人像双壁**：一个深沉（男/古典/油画），一个明亮（女/时尚/glamour）。光斑形状是模型的识别锚点，提示词务必写出"三角光斑""蝴蝶形鼻影"。
- **分割光——性格的台词**：一半亮一半暗 = 人物有隐藏面。叙事类视频里给复杂角色分配 split lighting，比台词更快立住人设。

---

## 三、光质：硬光 vs 软光（情绪分工）

### 3.1 什么是光质

> **光质 = 光源的相对大小**：光源越小越直射 → 硬；越大越散射 → 软。

| | **硬光（Hard Light）** | **软光（Soft Light）** |
|---|---|---|
| 典型来源 | 直射阳光、裸灯、聚光灯、点光源 | 阴天、柔光箱、窗户纱帘、反射光 |
| 阴影边缘 | 锐利清晰、边界分明 | 模糊渐变、几乎无形 |
| 明暗反差 | 大，高光到阴影过渡陡峭 | 小，过渡柔和绵长 |
| 情绪气质 | 力量、真实、粗粝、紧张、雕塑感 | 温柔、治愈、梦幻、包容、商业感 |
| 典型题材 | 硬汉肖像、正午街拍、时尚大片、悬疑 | 柔美女性人像、母婴、护肤广告、婚礼 |

### 3.2 软硬光的情绪分工（Agent 判断规则）

- 用户要"真实、力量、电影感、粗粝" → **硬光**（harsh/direct light, hard shadows）。
- 用户要"温柔、治愈、高级商业感、皮肤好" → **软光**（soft diffused light, gentle shadows）。
- 用户要"大片感"但题材不明 → 硬光塑造形状 + 软光填充暗部，即"硬主光 + 软辅光"的描述。

### 3.3 阴影是免费的叙事（最容易被浪费的元素）

阴影不是光的缺席，是第二主角：

- **投影（cast shadow）**：人物投在墙上的长长影子，暗示时间（低角度阳光）与孤独。
- **百叶窗光影（blinds shadows）**：条纹状明暗切割人脸/房间，黑色电影（film noir）的标志性符号，自带悬疑。
- **树叶光斑（dappled light）**：阳光穿过树叶洒下的晃动光斑，是"夏日、青春、慵懒"的速记符号；视频中光斑随微风晃动，氛围感极强。

> 提示词技巧：写阴影比写光更有效。"光透过百叶窗在墙面投下条纹光影"比"有氛围的光"出片稳定得多。

---

## 四、视频拍摄的特有规则（与拍照不同，Agent 必须知道）

1. **光向连续性**：人物在镜头内走动/转身时，光线方向必须在整个镜头内保持逻辑一致（如始终左后侧来光）。AI 视频提示词应明确写"光从画面左侧窗外持续照入"，避免模型在镜头中途换光向导致穿帮。
2. **动态光影的描述**：视频比照片多了"光的时间维度"——树叶光斑晃动、云影掠过、霓虹闪烁、烛光摇曳。把光影的运动写进提示词（flickering, swaying, shifting shadows），画面立刻"活"。
3. **逆光 + 运镜的组合风险**：逆光镜头同时做大幅度环绕运镜，模型容易在背光面丢失主体细节。涉及逆光建议描述"缓慢、小幅度运镜"或固定机位。
4. **光质影响 AI 出片率的经验法则**：**光线描述越具体出片率越高**。"soft window light from the left"远优于"beautiful lighting"。方位（左/右/后）、质感（soft/hard）、来源（window/sunset/neon）三要素写齐。
5. **体积光需要介质**：想要"光束"（丁达尔效应），必须同时描述介质：dust particles / mist / smoke / fog，否则模型只出亮斑不出光柱。
6. **混合光源要交代色温**：室内暖灯 + 窗外冷蓝是经典电影布光，提示词写作 warm tungsten interior against cool blue window light（色温体系详见 LIGHT-002）。

---

## 五、常见误区（生成提示词时的纠错规则）

| 误区 | 纠正 |
|---|---|
| "逆光 = 废片" | 剪影与轮廓光是高级感来源；逆光隐藏细节但放大氛围，是叙事工具 |
| "人像必须顺光才好看" | 顺光扁平；前侧光、伦勃朗、蝴蝶光才是人像立体感的主力 |
| "阴影越少越干净" | 无阴影 = 无立体感 = 无情绪；阴影是构图与叙事的一部分 |
| "硬光低档、软光高级" | 光质无贵贱，只有分工：硬光出力量，软光出温柔 |
| "提示词写 lighting 模型就懂" | 必须写清方位 + 质感 + 来源，如 soft window light from left |
| "顶光底光不能用" | 二者是强风格工具：顶光出压抑/神圣，底光出恐怖，用对场景即是神来之笔 |
| "逆光对脸拍人脸全黑没法要" | 提示词补一句"面部被反光板/环境光微微补亮"（subtle fill light on face）即可两全 |
| "光只负责照明" | 光的方向与质感就是情绪本身，先于构图与色调被观众感知 |

---

## 六、创作意图 → 提示词关键词映射表（Agent 核心调用区）

> 规则：**提示词里不要只写布光术语**（部分模型有效但不稳定），按本表翻译成"方位 + 质感 + 画面效果"的视觉语言。中英文都给，英文关键词对国际模型更有效。

### 6.1 方向映射表

| 创作意图 | 中文提示词写法 | 英文关键词 |
|---|---|---|
| 柔美窗光 | 柔和的自然光从左侧大窗洒入，面部过渡细腻无硬阴影 | soft window light from the left, gentle diffused daylight |
| 金色轮廓光 | 夕阳从人物身后照来，发丝与肩膀被金色轮廓光勾勒 | golden rim light, glowing hair light, backlit golden hour |
| 逆光剪影 | 人物背对落日呈深色剪影，天空璀璨，轮廓分明 | silhouette against sunset, backlight, dark figure on glowing sky |
| 伦勃朗光 | 高位侧光，暗侧脸颊出现三角形光斑，古典油画质感 | Rembrandt lighting, triangle of light on cheek, classical portrait |
| 蝴蝶光 | 正前上方柔光，鼻下蝴蝶形浅影，面部对称明亮 | butterfly lighting, paramount lighting, beauty light |
| 分割光 | 面部沿鼻梁一半明亮一半全暗，性格张力 | split lighting, half-lit face, dramatic duality |
| 正午硬光 | 正午顶光直射，眼窝深陷阴影，反差强烈粗粝 | harsh noon light, overhead sun, deep hard shadows |
| 戏剧性低调侧光 | 大面积阴影中一束硬侧光切出主体，黑色电影感 | low-key dramatic side light, film noir, chiaroscuro |

### 6.2 光质与特殊光影映射表

| 创作意图 | 中文提示词写法 | 英文关键词 |
|---|---|---|
| 树叶光斑 | 阳光穿透树叶在人物与地面洒下晃动的斑驳光影 | dappled light through leaves, dancing light spots |
| 百叶窗光影 | 光透过百叶窗在墙面与面部投下条纹明暗，悬疑感 | blinds shadows, striped light through venetian blinds, noir mood |
| 体积光束 | 一束光柱穿透尘埃斜射入昏暗房间，颗粒浮动 | volumetric light rays, god rays through dust particles, Tyndall effect |
| 阴天软光 | 阴天柔和漫射光包裹全身，无阴影，肤感细腻 | overcast soft light, diffused cloudy daylight, shadowless |
| 朦胧逆光雾感 | 强光从背后涌入镜头，画面蒙上梦幻光雾 | dreamy backlit haze, lens flare, soft glow |
| 烛光 / 火光 | 暖色烛光摇曳，人物面部被跃动的暖光映照 | warm candlelight, flickering firelight on face |
| 霓虹侧光 | 霓虹灯牌的红蓝光从两侧打在人物脸上，赛博氛围 | neon side lighting, red and blue neon glow on face |
| 长投影 | 低角度夕阳把人物影子拉得很长，投在地面 | long shadows, low-angle golden hour light, elongated shadow |

### 6.3 氛围叠加词（与光线描述配合使用）

- 硬光氛围：雕塑感 sculptural、粗粝 gritty、高反差 high contrast、黑色电影 film noir
- 软光氛围：通透 airy、奶油肌 creamy skin、梦幻 dreamy、治愈 healing
- 通用质感词：电影感 cinematic、油画感 painterly、低调布光 low-key、高调布光 high-key

---

## 七、提示词模板（Agent 直接填空调用）

### 模板 A：柔美窗光人像视频

```
[主体描述]，[动作/情绪]，坐在[窗边场景]，
柔和的自然光从[左/右]侧大窗洒入，面部一侧明亮一侧浅影过渡细腻，
皮肤质感通透，[景别]，缓慢[运镜方式]。
Soft window light from the left, gentle diffused daylight, creamy skin, cinematic.
```

示例：
> 一位穿米色毛衣的女孩低头翻动书页，坐在木质书桌旁的飘窗边，柔和的自然光从左侧大窗洒入，面部一侧明亮一侧浅影过渡细腻，皮肤质感通透，半身近景，镜头缓慢推近。Soft window light from the left, gentle diffused daylight, slow push-in, cinematic.

### 模板 B：逆光剪影视频

```
[主体描述]背对[光源：落日/城市天际线/海面]站立/行走，
人物呈深色剪影，[天空/背景]高光璀璨渐变，
[风/衣摆/发丝动态]，轮廓边缘泛金色微光，氛围留白。
Silhouette backlight, glowing sky, golden rim on edges, lens flare.
```

示例：
> 一位长裙女子背对海边落日缓步行走，人物呈深色剪影，天空从橙到紫高光渐变，海风吹起裙摆与发丝，轮廓边缘泛金色微光，氛围留白。Silhouette against sunset, backlight, golden rim light, lens flare, slow dolly.

### 模板 C：戏剧侧光（低调）视频

```
昏暗[场景]，大面积阴影中一束硬侧光从[左/右]侧切出[主体]，
面部一半明亮一半沉入黑暗，[纹理/烟雾/尘埃]细节分明，
黑色电影质感，高反差。
Low-key dramatic side light, half-lit face, film noir, chiaroscuro, high contrast.
```

示例：
> 昏暗的旧仓库，大面积阴影中一束硬侧光从左侧切出一名穿风衣的男人，面部一半明亮一半沉入黑暗，烟雾中的尘埃颗粒分明，黑色电影质感，高反差。Low-key dramatic side light, film noir, chiaroscuro, volumetric dust.

### 模板 D：时尚蝴蝶光人像视频

```
[主体描述]，[妆容/造型描述]，正前上方柔和主光，
鼻下投蝴蝶形浅影，面部对称明亮，颧骨高光立体，
[纯色/时尚背景]，杂志大片质感，缓慢环绕运镜。
Butterfly lighting, paramount beauty light, symmetrical face, editorial fashion look.
```

示例：
> 一位红唇短发的模特直视镜头微抬下巴，正前上方柔和主光，鼻下投蝴蝶形浅影，面部对称明亮，颧骨高光立体，纯灰色背景，杂志大片质感，镜头缓慢环绕。Butterfly lighting, paramount beauty light, editorial fashion look, slow orbit.

### 模板 E：光影叙事（进阶）

```
[场景描述]，光透过[百叶窗/树叶/格栅]在[主体/墙面]投下[条纹/斑驳]光影，
光影随[风/时间]缓缓移动，主体[动作]，[情绪氛围词]。
[Blinds shadows / dappled light through leaves], shifting patterns, [mood].
```

---

## 八、意图 → 光向光质 → 提示词 决策流程（Agent 推理链）

```
用户意图
  │
  ├─ "温柔 / 治愈 / 皮肤好 / 清新" → 软光 + 前侧光（窗光）
  │     → 提示词：soft window light + gentle diffused daylight
  │
  ├─ "梦幻 / 浪漫 / 氛围感 / 仙气" → 逆光或侧逆 + 软雾感
  │     → 提示词：golden rim light / backlit haze / lens flare
  │
  ├─ "剪影 / 史诗 / 留白 / 日落大片" → 正逆光 + 硬（点光源太阳）
  │     → 提示词：silhouette backlight + glowing sky
  │
  ├─ "戏剧 / 悬疑 / 力量 / 男性肖像" → 硬侧光 + 低调
  │     → 提示词：low-key dramatic side light + film noir + chiaroscuro
  │
  ├─ "时尚 / 美妆 / 美人 / 复古 glamour" → 蝴蝶光 + 软
  │     → 提示词：butterfly lighting + paramount beauty light
  │
  ├─ "古典 / 油画 / 庄重肖像" → 伦勃朗光
  │     → 提示词：Rembrandt lighting + triangle of light on cheek
  │
  ├─ "双面 / 复杂角色 / 海报感" → 分割光
  │     → 提示词：split lighting + half light half shadow
  │
  ├─ "恐怖 / 诡异 / 反派登场" → 底光；压抑 / 审讯 → 顶光
  │     → 提示词：under light / overhead top light + deep shadows
  │
  └─ "夏日 / 青春 / 慵懒" → 树叶光斑 + 动态
        → 提示词：dappled light through leaves + dancing light spots
```

---

## 九、关联知识（后续主题预留）

- LIGHT-002 时段与色温（黄金时刻 / 蓝调时刻 / 暖冷色温对情绪的影响）
- LIGHT-003 夜景与人工光源（霓虹 / 路灯 / 室内布光 / 混合光源实战）
- COLOR-002 影调（高调 / 低调 / 中间调与明暗分布的整体控制）
- HUMAN-001 人像拍摄全案（光线、景别、角度、引导的完整工作流）

> 光线的方向质感（本主题）决定"形状与情绪"，时段色温（LIGHT-002）决定"颜色与氛围"，生成提示词时建议 LIGHT-001 与 LIGHT-002 联合检索。
