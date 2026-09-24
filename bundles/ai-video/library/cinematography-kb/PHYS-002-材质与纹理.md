# 材质与纹理（Material & Texture）领域知识库

> **用途**：AI 视频生成系统的提示词知识库。供数字员工 / Agent 在生成视频提示词时检索调用。
> **主题编号**：PHYS-002　**版本**：v1.0　**更新日期**：2026-09-24
> **使用方式**：Agent 接收到涉及"真实感、质感、皮肤、布料、金属、玻璃、食物"等创作意图时，检索本主题，将材质意图翻译成对应的视觉特征描述写入提示词。**注意：AI 视频模型不理解"材质名称"本身，必须把材质翻译成"表面特征 + 光线互动 + 状态"的画面描述**（见第六章映射表）。

---

## 一、核心概念

### 1.1 为什么材质要单独立项

材质是"真实感"的最后 10%，也是 AI 视频与普通 CG 拉开差距的分水岭。AI 视频最常见的廉价感几乎全部来自材质崩塌：

- **塑料皮肤**：人脸像搪胶娃娃，无毛孔无细纹，光打上去一整片亮
- **蜡像脸**：皮肤光滑但僵硬，缺乏"光透进皮肤"的肉感
- **贴纸布料**：衣服像贴在身体上的印花，没有褶皱、没有垂坠、没有光泽流动
- **玩具金属**：金属件像镀铬塑料，高光糊成一团
- **假水假玻璃**：透明物体没有折射，看起来像实心果冻

> 核心结论：**材质词 = 真实感开关**。同样的画面描述，加上具体的材质特征词，真实感立刻跨档。Agent 生成任何写实向提示词时，都必须为主体补齐材质描述。

### 1.2 材质的通用提示词公式

```
材质描述 = 材质名称 + 表面特征词 + 光线互动 + 状态词
```

| 要素 | 作用 | 示例 |
|---|---|---|
| **材质名称** | 告诉模型是什么东西 | skin / silk / brushed metal |
| **表面特征词** | 告诉模型表面长什么样 | visible pores / flowing sheen / scratches |
| **光线互动** | 决定材质如何被看见（侧光显纹理，逆光显透光） | side lighting reveals texture / backlit translucency |
| **状态词** | 赋予材质"故事感" | wet / weathered / brand new / frosted |

### 1.3 光线与材质的关系（联动 LIGHT-001）

同一块布料，顺光下是"颜色"，侧光下才是"材质"。

1. **侧光 / 低角度光** → 拉出表面起伏，显纹理（皮肤毛孔、布料织纹、混凝土颗粒）
2. **逆光 / 背光** → 显透光性（薄纱、树叶、耳廓、花瓣）
3. **点光源 / 硬光** → 金属、玻璃的高光锐利度
4. **柔光 / 大光源** → 皮肤的次表面散射、奶油的油润感

> 提示词组合技巧：写材质时顺手补一句光线方向（如 side lighting / backlit），材质表现成功率显著提升。详见 LIGHT-001 光线方向与质感。

---

## 二、材质全表（核心速查）

> 每种材质给出：中文名 / 英文名 / 视觉特征关键词 / 光线互动方式 / AI 易翻车点 / 提示词写法。

### 2.1 皮肤 skin —— 塑料感重灾区，最高优先级

| 项目 | 内容 |
|---|---|
| **中文 / 英文** | 皮肤 / skin |
| **视觉特征关键词** | 毛孔 pores、细纹 fine lines、雀斑 freckles、汗珠 sweat beads、绒毛 peach fuzz、皮肤纹理 skin texture |
| **核心概念：次表面散射** | subsurface scattering（SSS）——光进入皮肤内部再散射出来的"肉感"，是真人皮肤与塑料的分水岭。逆光下耳廓、鼻翼透光泛红就是 SSS |
| **光线互动** | 柔光显 SSS 肉感；侧光显毛孔细纹；逆光显耳廓透光 |
| **AI 易翻车点** | 默认输出"磨皮脸"；毛孔缺失；高光一整片像打蜡；老人/婴儿皮肤一刀切 |
| **提示词写法** | photorealistic skin texture with visible pores and fine lines, subtle subsurface scattering, natural skin sheen, freckles on cheeks |

### 2.2 头发 hair

| 项目 | 内容 |
|---|---|
| **中文 / 英文** | 头发 / hair |
| **视觉特征关键词** | 发丝 individual strands、发丝光 hair sheen / shine、飘动 flowing / blowing、碎发 flyaway hairs、湿润贴头皮 wet hair clinging to scalp、蓬松 voluminous / fluffy |
| **光线互动** | 轮廓光 / 逆光打出发丝边缘金光（rim light on hair）；柔光显发色层次 |
| **AI 易翻车点** | 头发糊成一坨"头盔"；发丝之间无空隙；飘动时像一整块布；湿发与油头不分 |
| **提示词写法** | individual hair strands catching the light, fine flyaway hairs, hair flowing naturally in the wind, rim light outlining hair |

### 2.3 布料 fabric

| 子类 | 英文 | 视觉特征 | 光线互动 | 易翻车点 | 提示词写法 |
|---|---|---|---|---|---|
| 丝绸 | silk | 光泽流动、高光随动作滑动 | 侧光/顶光出流动高光带 | 高光死板不动，像锡纸 | silk fabric with flowing sheen, highlights gliding across folds |
| 棉麻 | cotton / linen | 哑光、织纹可见、自然褶皱 | 侧光显编织纹理 | 写成"光滑的布"失去麻感 | matte linen texture, visible weave, natural creases |
| 牛仔 | denim | 粗粝、斜纹、磨白做旧 | 侧光显斜纹与磨损 | 牛仔像普通蓝布 | rugged denim texture, faded washes, visible twill weave |
| 薄纱 | sheer / tulle | 透光、轻盈、叠层 | 逆光显透光层次 | 薄纱不透明成塑料片 | sheer translucent fabric, light passing through layers, backlit |
| 垂坠感 | drape | 褶皱自然下垂、随动作摆动 | 柔光+阴影显褶皱体积 | 布料无重力感，像纸 | fabric draping naturally, soft folds and wrinkles, gravity |
| 褶皱 | wrinkles / folds | 折痕、堆叠、动态变化 | 侧光强化褶皱阴影 | 褶皱数量形状全程不变 | deep folds casting soft shadows, wrinkles shifting with movement |

### 2.4 金属 metal

| 子类 | 英文 | 视觉特征 | 光线互动 | 易翻车点 | 提示词写法 |
|---|---|---|---|---|---|
| 拉丝 | brushed metal | 细密同向纹路、柔和高光 | 侧向硬光显拉丝纹 | 高光糊成一片像塑料 | brushed metal surface, fine linear grain, soft elongated highlights |
| 镜面 | polished metal | 锐利高光、清晰反射环境 | 点光源出锐利高光点 | 反射内容错误或无反射 | polished mirror-like metal, sharp specular highlights, crisp reflections |
| 做旧生锈 | rusted / weathered | 锈斑、氧化、剥漆、划痕 | 侧光显锈蚀凹凸 | 做旧变成"脏色涂装"无凹凸 | weathered rusted metal, oxidized patina, chipped paint, scratches |

### 2.5 玻璃 glass

| 子类 | 英文 | 视觉特征 | 光线互动 | 易翻车点 | 提示词写法 |
|---|---|---|---|---|---|
| 透明折射 | transparent / refraction | 透过玻璃看到的景物变形、边缘色散 | 逆光显通透与折射 | 玻璃后面景物无变形，像贴图 | clear glass with realistic refraction, distorted view through glass |
| 反射 | reflection | 表面映出环境光与轮廓 | 侧逆光显表面反光 | 只透不反，玻璃"消失" | glass surface reflecting ambient light, subtle reflections |
| 磨砂 | frosted glass | 半透明、柔化后方景物 | 背光显朦胧透光 | 磨砂做成不透明白板 | frosted glass, softly diffused silhouettes behind, translucent |
| 水珠凝结 | condensation | 表面细小水珠、水痕滑落 | 点光让水珠发亮 | 水珠像贴上去的圆点 | condensation droplets on cold glass, water beads glistening |

### 2.6 液体表面 liquid surface

| 子类 | 英文 | 视觉特征 | 易翻车点 | 提示词写法 |
|---|---|---|---|---|
| 油润感 | oily / glossy liquid | 表面油亮高光、缓慢流动 | 油像清水，无粘稠感 | glossy oily sheen, viscous slow-moving liquid |
| 蜂蜜拉丝 | honey drizzle | 粘稠拉丝、断丝回弹 | 拉丝像细线无粗细变化 | thick honey drizzling, viscous strands stretching |
| 奶油 | cream | 绵密、哑光油润、堆叠感 | 奶油像牙膏/塑料泡沫 | velvety whipped cream, soft peaks, matte creamy texture |

> 液体的流动、飞溅、滴落属于动态表现，动态部分请联动 PHYS-001 流体与粒子；本主题只管"表面看起来是什么质感"。

### 2.7 木质 wood

| 项目 | 内容 |
|---|---|
| **视觉特征关键词** | 年轮纹理 growth rings / wood grain、哑光温润 matte warm tone、木节 knots、凿痕 tool marks |
| **光线互动** | 侧光/低角度光显木纹起伏；柔光显温润感 |
| **AI 易翻车点** | 木纹像印刷贴纸；所有木头一种颜色；抛光木与原木不分 |
| **提示词写法** | natural wood grain texture, visible growth rings, warm matte wooden surface, rustic knots |

### 2.8 石材 stone / 混凝土 concrete

| 项目 | 内容 |
|---|---|
| **视觉特征关键词** | 粗糙肌理 rough texture、颗粒感 grainy、大理石纹理 marble veins、风化 pits and erosion |
| **光线互动** | 侧光（低角度）显表面凹凸；硬光强化颗粒阴影 |
| **AI 易翻车点** | 混凝土像灰色塑料墙；大理石纹路重复平铺像壁纸 |
| **提示词写法** | rough concrete texture, pitted weathered stone, natural marble veining, side lighting reveals surface relief |

### 2.9 食物 food

| 子类 | 英文 | 视觉特征 | 光线互动 | 提示词写法 |
|---|---|---|---|---|
| 脆皮 | crispy / crackling | 表面裂纹、金黄焦斑、碎裂瞬间 | 侧光显脆壳起伏 | golden crispy skin, crackling surface, caramelized edges |
| 流心 | molten / runny | 切开后浓稠内馅缓缓流出 | 背光显流心透亮 | molten center oozing out, runny yolk flowing slowly |
| 油亮 | glossy / glistening | 表面油光反射 | 点光源出油亮高光 | glistening glaze, glossy oily sheen on surface |
| 蒸汽 | steam | 热气升腾（动态联动 PHYS-001） | 逆光显蒸汽轮廓 | wisps of steam rising, backlit steam |

### 2.10 皮革 leather

| 项目 | 内容 |
|---|---|
| **视觉特征关键词** | 褶皱光泽 creased sheen、做旧 distressed / worn、皮纹 grain、油蜡感 waxy |
| **光线互动** | 侧光显褶皱与皮纹；柔光显油蜡温润 |
| **AI 易翻车点** | 皮革像塑料雨衣；做旧无磨损细节只有颜色变深 |
| **提示词写法** | weathered leather with natural creases, worn patina, subtle waxy sheen, visible grain |

### 2.11 植物 plant

| 项目 | 内容 |
|---|---|
| **视觉特征关键词** | 叶脉 leaf veins、绒毛 fuzz / fine hairs、露珠 dew drops、蜡质叶面 waxy leaves、逆光透光 translucent petals |
| **光线互动** | 逆光显叶片/花瓣透光与叶脉；点光让露珠发亮 |
| **AI 易翻车点** | 叶子像塑料假花；露珠是白色圆点；花瓣不透光 |
| **提示词写法** | delicate leaf veins, backlit translucent petals, dew drops glistening on petals, fine fuzz on stems |

---

## 三、分题材实战指南

### 3.1 人物特写（皮肤 + 毛发）

- 皮肤三件套必写：**毛孔 + 细纹 + 次表面散射**。少一个就向蜡像滑坡。
- 年龄区分：婴儿皮肤写 smooth baby skin with soft peach fuzz；老人写 aged skin with wrinkles and age spots；不要混用。
- 毛发：特写必写 individual hair strands + flyaway hairs；风吹场景加 hair flowing naturally in the wind。
- 光线联动：特写配柔光显肉感（soft lighting + subsurface scattering），配轮廓光显发丝（rim light on hair）。

### 3.2 服饰 / 时尚

- 先定布料子类（丝/麻/牛仔/纱），再写特征词，最后补动态（flowing / draping）。
- 薄纱、丝绸必须配光线描述：backlit sheer fabric / highlights gliding across silk。
- 一身上限两种布料重点描述，超过两种画面注意力被打散（见第五章误区）。

### 3.3 产品（金属 + 玻璃）

- 金属先分拉丝/镜面/做旧，三种高光形态完全不同，不能都写 shiny metal。
- 玻璃必写折射 refraction，否则透明物体像实心果冻。
- 冷饮杯：condensation droplets 是"冰镇感"的第一信号词。
- 产品特写统一配 ECU 景别（联动 CINE-002），材质细节才有呈现空间。

### 3.4 美食

- 质感四选词：脆皮 crispy / 流心 molten / 油亮 glistening / 蒸汽 steam，按菜品取用。
- 流心、拉丝是"动态材质"，动作描述（oozing / stretching）与质感词缺一不可。
- 蒸汽必须逆光才有轮廓，提示词写 backlit steam。
- 流体动态细节联动 PHYS-001 流体与粒子。

### 3.5 场景 / 道具（木、石、皮革、植物）

- 老物件的"故事感" = 做旧三件套：weathered + worn + patina。
- 木质/石材场景配低角度侧光，纹理立体感翻倍。
- 植物微距：露珠 + 叶脉 + 逆光透光，三个词撑起整个画面。

---

## 四、AI 视频生成的特有规则（与静态图像不同，Agent 必须知道）

1. **材质词前置，紧贴主体**：模型注意力靠前集中，把材质词放在主体之后立刻出现的位置。❌ "a woman in a red dress, cinematic lighting, silk fabric" → ✅ "a woman in a flowing silk dress with gliding highlights, cinematic lighting"。
2. **一个画面不超过三种复杂材质**：AI 视频帧间一致性差，材质越多越容易出现"这件衣服每一帧质感都不一样"。主体一种重点材质 + 环境最多两种辅助材质。
3. **"photorealistic + 具体材质词"远大于单独 photorealistic**：单独写 photorealistic 只是许愿，模型不知道往哪儿写实；写成 photorealistic skin texture with visible pores 才有抓手。
4. **特写是材质的试金石**：材质描述只有在中近景、特写（CU/ECU，见 CINE-002）下才会真正渲染出来；远景里写材质词基本无效，别浪费提示词预算。
5. **材质要有动态一致性描述**：视频里布料要写褶皱随动作变化（wrinkles shifting with movement）、头发要写飘动（flowing in the wind），否则模型输出"静态贴片"材质。
6. **状态词决定叙事**：同一材质，湿润 wet / 做旧 weathered / 崭新 brand new 是三个完全不同的画面，状态词是廉价但高效的导演工具。

---

## 五、常见误区（生成提示词时的纠错规则）

| 误区 | 纠正 |
|---|---|
| "写实 = 写 photorealistic 就够了" | photorealistic 只是方向，必须落到具体材质词（visible pores / wood grain / rust）才有效 |
| "材质越多越好，全身都写满" | 一个画面超过三种复杂材质会帧间崩坏；聚焦一种主体材质 |
| "皮肤写 smooth skin 显得干净" | smooth skin 是塑料感元凶，写实人物必须写 pores + fine lines |
| "shiny 可以描述一切反光材质" | 金属高光、玻璃反射、丝绸光泽是三种光学现象，分别用 specular highlights / reflections / flowing sheen |
| "材质词放哪都行" | 材质词必须前置紧贴主体，远离主体的材质词容易被模型丢弃 |
| "远景也要写材质细节" | 材质只在特写/近景生效；远景应把提示词预算留给构图与光线 |
| "做旧 = 颜色调暗调脏" | 做旧要写出物理痕迹：scratches / chipped paint / worn edges / patina |
| "布料不用写动态" | 视频里布料不写 drape / flowing / wrinkles shifting，会得到"贴纸衣服" |

---

## 六、创作意图 → 提示词关键词映射表（Agent 核心调用区）

> 规则：**提示词里不要只写材质名**（只写 skin/silk 模型会按最平庸的方式理解），按本表翻译成"特征 + 光线 + 状态"的完整视觉语言。中英文都给，英文关键词对国际模型更有效。

### 6.1 皮肤与毛发

| 创作意图 | 中文提示词写法 | 英文关键词 |
|---|---|---|
| 真实皮肤（通用） | 真实皮肤质感，可见毛孔与细纹 | photorealistic skin texture, visible pores and fine lines |
| 皮肤的肉感透光 | 皮肤呈现柔和的次表面散射，光透进皮肤的肉感 | subsurface scattering, light penetrating soft skin |
| 雀斑 / 瑕疵真实感 | 脸颊有自然雀斑与细小瑕疵 | natural freckles on cheeks, subtle skin imperfections |
| 汗湿皮肤 | 皮肤表面有细密汗珠，微微反光的湿润感 | fine sweat beads on skin, damp skin with subtle sheen |
| 老人皮肤 | 布满皱纹与老年斑的苍老皮肤 | aged wrinkled skin, age spots, deep lines |
| 婴儿皮肤 | 婴儿般柔嫩皮肤，带细小绒毛 | smooth baby skin, soft peach fuzz |
| 发丝分明 | 根根分明的发丝被光照亮 | individual hair strands catching the light |
| 碎发 / 自然感 | 额前细小碎发自然飘散 | fine flyaway hairs, natural baby hairs |
| 风吹头发 | 头发在风中自然飘动，发丝丝丝分离 | hair flowing naturally in the wind, strands separating |
| 湿发 | 湿润的头发贴着头皮与脸颊 | wet hair clinging to scalp and cheeks |
| 蓬松头发 | 蓬松有空气感的秀发 | voluminous fluffy hair with airy texture |
| 发丝轮廓光 | 逆光勾勒出发丝的金色轮廓 | rim light outlining hair, glowing hair edges |

### 6.2 布料

| 创作意图 | 中文提示词写法 | 英文关键词 |
|---|---|---|
| 丝绸光泽流动 | 丝绸表面光泽随动作流动 | silk fabric with flowing sheen, highlights gliding across folds |
| 棉麻哑光 | 哑光棉麻质地，可见编织纹理 | matte linen texture, visible weave, natural creases |
| 粗粝牛仔 | 粗粝牛仔布，斜纹与磨白做旧 | rugged denim, visible twill weave, faded worn washes |
| 薄纱透光 | 薄纱轻盈透光，逆光看层层叠加 | sheer translucent fabric, light passing through layers, backlit |
| 垂坠感 | 布料自然垂坠，褶皱随动作变化 | fabric draping naturally, folds shifting with movement |
| 褶皱细节 | 深深浅浅的褶皱投下柔和阴影 | deep and shallow folds casting soft shadows, natural wrinkles |

### 6.3 金属与玻璃

| 创作意图 | 中文提示词写法 | 英文关键词 |
|---|---|---|
| 拉丝金属 | 拉丝金属表面，细密同向纹路与柔和高光 | brushed metal, fine linear grain, soft elongated highlights |
| 镜面金属 | 镜面抛光金属，锐利高光与清晰反射 | polished mirror-like metal, sharp specular highlights, crisp reflections |
| 做旧生锈 | 风化锈蚀金属，氧化锈斑与剥落漆面 | weathered rusted metal, oxidized patina, chipped paint, scratches |
| 玻璃折射 | 透明玻璃产生真实折射，透过玻璃的景物变形 | clear glass with realistic refraction, distorted view through glass |
| 玻璃反射 | 玻璃表面映出环境光的反射 | glass surface reflecting ambient light, subtle reflections |
| 磨砂玻璃 | 磨砂玻璃后景物柔化成朦胧轮廓 | frosted glass, softly diffused silhouettes behind |
| 玻璃冷凝水珠 | 冰凉玻璃杯表面凝结细密水珠 | condensation droplets on cold glass, water beads glistening |

### 6.4 光泽度通用词

| 创作意图 | 中文提示词写法 | 英文关键词 |
|---|---|---|
| 亮面 / 油亮 | 表面油亮有光泽，高光清晰 | glossy surface, glistening sheen, clear highlights |
| 哑光 | 哑光质地，无反光，柔和吸光 | matte finish, non-reflective, soft light-absorbing surface |
| 油润 | 油润质感，表面一层温润油光 | oily lustrous surface, rich glossy coating |
| 粗糙 | 粗糙表面肌理，颗粒感明显 | rough texture, grainy tactile surface |

### 6.5 木 / 石 / 皮革 / 植物

| 创作意图 | 中文提示词写法 | 英文关键词 |
|---|---|---|
| 木纹温润 | 天然木纹与年轮，哑光温润的木面 | natural wood grain, visible growth rings, warm matte wooden surface |
| 粗糙混凝土 | 粗糙混凝土肌理，坑洼颗粒感 | rough concrete texture, pitted grainy surface |
| 大理石纹理 | 天然大理石流动纹理 | natural marble veining, flowing stone patterns |
| 做旧皮革 | 做旧皮革，自然褶皱与磨损包浆 | weathered leather, natural creases, worn patina |
| 皮革褶皱光泽 | 皮革褶皱处的柔和油蜡光泽 | creased leather with subtle waxy sheen, visible grain |
| 叶脉清晰 | 叶片上纤细清晰的叶脉 | delicate leaf veins, intricate vein patterns |
| 花瓣露珠 | 花瓣上的露珠闪闪发亮 | dew drops glistening on petals |
| 蜡质叶面 | 蜡质叶片表面油亮反光 | waxy leaves with glossy sheen |
| 植物绒毛 | 茎叶上细密的绒毛 | fine fuzz on stems and leaves |
| 逆光透光叶片 | 逆光下叶片透光，叶脉纹理毕现 | backlit translucent leaves, veins glowing against light |

### 6.6 食物质感（联动 PHYS-001）

| 创作意图 | 中文提示词写法 | 英文关键词 |
|---|---|---|
| 脆皮 | 金黄酥脆表皮，焦糖化裂纹 | golden crispy skin, caramelized crackling surface |
| 流心 | 切开后浓稠流心缓缓涌出 | molten center oozing out, runny filling flowing |
| 蜂蜜拉丝 | 蜂蜜粘稠拉丝，断丝缓慢回弹 | thick honey drizzling, viscous strands stretching |
| 奶油绵密 | 绵密奶油，柔软堆叠的哑光质感 | velvety whipped cream, soft peaks, matte creamy texture |
| 油亮酱汁 | 酱汁油亮挂壁，高光诱人 | glistening glossy sauce, appetizing oily sheen |
| 蒸汽升腾 | 热气腾腾，逆光下蒸汽清晰可见 | wisps of steam rising, backlit steam |

---

## 七、提示词模板（Agent 直接填空调用）

### 模板 A：人物特写（皮肤 + 毛发）

```
[主体描述]，[表情/动作]，真实皮肤质感，可见毛孔与细纹，
柔和的次表面散射透出皮肤肉感，[发丝描述：根根分明的发丝/额前碎发]，
[光线：柔光/轮廓光]，特写镜头，浅景深。
Photorealistic skin texture with visible pores, subtle subsurface scattering,
individual hair strands, soft lighting, close-up, shallow DOF.
```

示例：
> 一位三十岁女性的面部特写，轻轻侧头微笑，真实皮肤质感，可见毛孔与眼角细纹，柔和的次表面散射透出皮肤肉感，额前碎发被光照亮根根分明，窗边柔光，特写镜头，浅景深。Photorealistic skin texture with visible pores and fine lines, subtle subsurface scattering, individual hair strands catching the light, soft window light, close-up, shallow depth of field.

### 模板 B：服饰布料（时尚视频）

```
[人物]身着[布料子类+特征：丝绸光泽流动/薄纱透光]的[服装]，
布料自然垂坠，褶皱随[动作]变化，[光泽动态：高光沿褶皱滑动]，
[光线：侧光/逆光]，[运镜]。
Silk fabric with flowing sheen, fabric draping naturally,
folds shifting with movement, highlights gliding across folds.
```

示例：
> 一位舞者身着深绿色丝绸长裙旋转，丝绸表面光泽随动作流动，布料自然垂坠，褶皱随旋转层层展开，高光沿褶皱滑动，侧逆光打亮裙摆边缘，镜头缓慢环绕。Silk fabric with flowing sheen, fabric draping naturally, folds shifting with movement, highlights gliding across folds, backlit edges, slow orbit shot.

### 模板 C：产品（金属 + 玻璃）

```
[产品描述]，[金属表面：拉丝金属细密纹路/镜面抛光锐利高光]，
[玻璃描述：真实折射/表面凝结水珠]，[状态：崭新/做旧]，
极特写镜头聚焦[局部]，[光线：侧向硬光/点光源]，背景简洁虚化。
Brushed metal with fine linear grain, sharp specular highlights,
condensation droplets, extreme close-up, clean blurred background.
```

示例：
> 一杯冰镇精酿啤酒，玻璃杯壁真实折射吧台灯光，杯面凝结细密水珠缓缓滑落，金色酒液透亮，极特写镜头聚焦杯壁水珠，点光源让水珠闪闪发亮，背景酒吧灯光虚化成暖色光斑。Condensation droplets on cold glass, realistic refraction, water beads glistening, extreme close-up, creamy bokeh background.

### 模板 D：美食质感

```
[菜品描述]，[质感词：金黄脆皮/流心涌出/油亮酱汁]，
[动态：蒸汽升腾/拉丝缓慢回弹]，逆光凸显蒸汽轮廓，
侧光凸显表面起伏，特写镜头缓慢推进。
Golden crispy skin, molten center oozing out, wisps of backlit steam rising,
side lighting reveals texture, close-up slow push-in.
```

示例：
> 一块刚切开的熔岩巧克力蛋糕，浓稠巧克力流心缓缓涌出，表面糖霜细腻哑光，热气腾腾，逆光凸显蒸汽轮廓，侧光凸显蛋糕表面起伏，特写镜头缓慢推进。Molten chocolate center oozing out, wisps of backlit steam rising, matte powdered sugar, side lighting reveals texture, close-up slow push-in.

### 模板 E：老物件叙事（做旧材质，进阶）

```
[老物件描述]，做旧[材质：皮革/金属/木材]，自然褶皱与磨损包浆，
[物理痕迹：划痕/剥漆/锈斑]，低角度侧光凸显表面肌理，
镜头缓慢滑过表面，怀旧氛围。
Weathered [leather/metal/wood], worn patina, scratches and chipped paint,
low-angle side lighting reveals texture, slow slide across surface, nostalgic mood.
```

示例：
> 一只用了三十年的棕色皮箱，做旧皮革布满自然褶皱与磨损包浆，铜扣氧化发绿，边角磕碰掉色，低角度侧光凸显皮面肌理，镜头缓慢滑过箱体表面，怀旧氛围。Weathered leather with natural creases and worn patina, oxidized brass buckle, low-angle side lighting reveals texture, slow slide shot, nostalgic mood.

---

## 八、意图 → 材质 → 提示词 决策流程（Agent 推理链）

```
用户意图
  │
  ├─ 主体是"人"
  │     ├─ 要真实感/电影感 → 皮肤：pores + fine lines + subsurface scattering
  │     │     → 毛发：individual strands + flyaway hairs（+ rim light）
  │     ├─ 要时尚/服饰 → 定布料子类 → silk sheen / linen matte / denim rugged / sheer backlit
  │     │     → 补动态：draping + folds shifting with movement
  │     └─ 要年龄感 → 婴儿：peach fuzz / 老人：wrinkles + age spots
  │
  ├─ 主体是"产品/器物"
  │     ├─ 金属 → 先分三种：brushed（纹路）/ polished（锐高光）/ rusted（锈斑剥漆）
  │     ├─ 玻璃 → refraction 必写 + reflection / frosted / condensation 按需叠加
  │     └─ 木/石/皮革 → 特征词（grain / veins / creases）+ 低角度侧光
  │
  ├─ 主体是"食物"
  │     ├─ 质感四选词：crispy / molten / glistening / steam
  │     ├─ 动态联动 PHYS-001：oozing / stretching / rising
  │     └─ 光线：蒸汽必逆光 backlit，表面起伏必侧光 side lighting
  │
  ├─ 主体是"植物/自然"
  │     → 逆光透光（backlit translucent）+ 细节（veins / fuzz / dew drops）
  │
  ├─ 要"故事感/年代感" → 做旧三件套：weathered + worn + patina
  │     → 补物理痕迹：scratches / chipped paint / oxidized
  │
  └─ 通用检查
        ├─ 材质词是否紧贴主体？（前置原则）
        ├─ 画面复杂材质是否 ≤ 3 种？
        ├─ 是否写了 photorealistic + 具体材质词（而非空写 photorealistic）？
        └─ 景别是否到位？材质只在 CU/ECU 生效（联动 CINE-002）
```

---

## 九、关联知识（后续主题预留）

- PHYS-001 流体与粒子（液体流动、飞溅、蒸汽、烟尘的动态描述，与本主题"食物/液体表面"联动）
- LIGHT-001 光线方向与质感（侧光显纹理、逆光显透光的光线选择依据，材质表现的另一半）
- CINE-002 景别系统（CU/ECU 特写是材质细节的呈现前提，决定材质词是否有效）
- HUMAN-001 人像拍摄全案（人物题材下皮肤、毛发、布料材质的综合应用）
- OPTICS-001 光圈（浅景深特写放大材质细节，深景深场景材质靠光线呈现）

> 材质表现的完整公式 = 材质特征词（本主题）× 光线方向（LIGHT-001）× 特写景别（CINE-002）。生成写实向提示词时建议三者联合检索。
