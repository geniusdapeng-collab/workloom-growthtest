# 人群与空间（Crowd & Space）领域知识库

> **用途**：AI 视频生成系统的提示词知识库。供数字员工 / Agent 在生成视频提示词时检索调用。
> **主题编号**：SCENE-002　**版本**：v1.0　**更新日期**：2026-09-24
> **使用方式**：Agent 接收到涉及"热闹、孤独、人潮、空旷、压迫感、规模感、纵深感"等创作意图时，检索本主题，将意图翻译为"人群密度 + 人群处理方式 + 空间类型"三层描述写入提示词。**注意：人群是 AI 视频肢体崩坏的重灾区，直接写"a crowd of people"极易翻车，必须按第四章规避策略选择处理方式后再写提示词**。

---

## 一、核心概念

### 1.1 为什么人群与空间要单独立项

一条视频的"生活感、孤独感、规模感"，几乎全部来自两个变量：**画面里有多少人**（人群密度）和**人处在什么样的空间里**（空间关系）。

- 同一条街道，空无一人是后启示录，稀疏人流是日常，摩肩接踵是都市活力——**场景没变，情绪全变**。
- 同一个人，站在开阔广场中央是孤独，被拥挤人潮裹挟是窒息，站在对称殿堂里是庄严——**人物没变，叙事全变**。

同时，这是 AI 视频生成的**头号翻车区**：

1. **人群肢体崩坏**：多人同框时，模型对手脚、五官、行走姿态的生成错误率指数级上升，常见"三条腿的路人""融化的脸""穿模的行人"。
2. **空间透视错乱**：旋转楼梯、镜面反射、多重门洞等复杂透视空间，模型极易生成"不可能建筑"，线条扭曲、纵深坍塌。

因此本主题的核心思路是：**用密度档位控制情绪，用处理方式绕开 AI 短板，用空间类型承载叙事**。

### 1.2 人群密度决定情绪基调

| 密度变化 | 情绪走向 |
|---|---|
| 人越少 | 孤独、静谧、疏离、史诗、不安 |
| 人越多 | 活力、喧嚣、窒息、震撼、压迫 |

> 记忆口诀：**"人少出情绪，人多出规模；看不清脸的人群才是好人群"**（最后一条是 AI 视频的生存法则，详见第四章）。

### 1.3 空间是情绪的容器

空间不只是背景板，它通过三条途径参与叙事：

1. **引导线**：走廊、楼梯、拱廊的线条把观众视线引向主体或远方 → 纵深与方向感。
2. **尺度对比**：人之于广场之小、之于狭室之挤 → 孤独感或压迫感。
3. **秩序与框架**：对称结构给庄严，门窗洞口给"窥视感"与层次。

---

## 二、人群密度全表（核心速查）

| 密度档位 | 中文名 / 英文名 | 画面效果 | 情绪气质 | 典型场景 | AI 提示词写法（中 / 英） |
|---|---|---|---|---|---|
| **D0 空无一人** | 空镜 / empty, deserted | 场景完整呈现，无人，突出建筑、光影、天气 | 孤独、静谧、后启示录、极简、不安 | 凌晨空街、废弃商场、空教室、无人站台 | 空无一人的街道，只有[环境元素]，寂静 / empty street, deserted, no people, silent |
| **D1 稀疏人流** | 稀疏 / sparse crowd, a few passersby | 三五行人点缀画面，互不干扰，各自有空间 | 日常、安静、松弛、淡淡的疏离 | 清晨公园、工作日咖啡馆、居民区小巷 | 稀疏的行人三三两两走过 / sparse pedestrians, a few people walking, quiet street |
| **D2 正常人流** | 适中 / moderate crowd | 人流连续但不拥挤，能看清个体动作 | 生活气息、烟火气、真实感 | 傍晚商业街、菜市场、地铁非高峰 | 街道上来往的行人，自然的生活气息 / moderate crowd, everyday street life, lively but not crowded |
| **D3 拥挤人群** | 拥挤 / crowded, bustling | 人挨人，个体开始模糊成群落，动线交织 | 都市活力、喧嚣、或转向窒息感 | 早晚高峰地铁、跨年广场、网红景点 | 拥挤的人流，熙熙攘攘 / crowded bustling street, dense crowd, packed |
| **D4 大规模人群** | 人海 / mass gathering, concert crowd | 人成为"肌理"与"海洋"，个体完全消失 | 史诗、震撼、狂热、或个体的渺小 | 演唱会、体育赛事、庆典、集会 | 人山人海，一眼望不到边的人潮 / massive crowd, sea of people, epic scale gathering |

### 密度档位扩展解读

- **D0 空无一人 —— 情绪放大器**：没有人，观众的注意力全部落在空间、光影和天气上，是"此处有故事"的留白。后启示录、梦境、极简美学都靠它。提示词务必显式写 no people / deserted，否则模型会"好心"往里塞人。
- **D1 稀疏 —— 日常安全牌**：人少量出现，画面有生气又不乱。AI 生成时个体少、崩坏率低，是"要生活感又怕翻车"的折中档。
- **D2 正常 —— 生活气息甜点位**：连续的人流带来真实世界的呼吸感。建议配合虚化（见 3.1），让观众感到"有人"但看不清脸。
- **D3 拥挤 —— 双刃剑**：密度本身即是情绪。拍都市活力用暖光+高机位俯拍人流；拍窒息感用贴脸跟拍+浅景深。**此档位开始，正面清晰人脸的崩坏率显著上升**。
- **D4 人海 —— 规模即史诗**：个体消失后人群成为一种"自然现象"，适合大远景俯拍。提示词用 sea of people / crowd stretching to the horizon，模型反而稳定——因为它不再画"人"，而是画"纹理"。

---

## 三、分题材实战指南：人群的处理方式与空间运用

### 3.1 背景人群虚化（blurred crowd）—— 首选技巧

大光圈浅景深，背景人流在动但看不清脸。**既出生活气息，又完美绕开 AI 画脸崩坏**——这是本主题最重要的一条技巧。

- 写法：背景人流柔和虚化，人影流动 / blurred crowd in the background, out-of-focus passersby, shallow depth of field
- 联动 OPTICS-001 光圈：模拟 f/1.4–f/2.8 效果。
- 加分项：叠加 bokeh，让夜景人流变成光斑与人影的混合体。

### 3.2 剪影人群（silhouetted crowd）

逆光拍摄，人群只剩轮廓。没有脸、没有肢体细节 → AI 几乎不会崩。

- 写法：逆光，人群呈黑色剪影 / silhouetted crowd against the sunset, backlit figures
- 适用：日落广场、车站落地窗、舞台观众席。
- 联动 SCENE-001 天气与氛围（黄金时刻 / 逆光条件）。

### 3.3 局部人群（只拍手 / 脚 / 背影）

不拍全身和正脸，只取局部：脚步匆匆的地面视角、举起的双手、一片背影。

- 写法：低角度只拍行人脚步 / close-up of walking feet, low angle; 一片背影走向远方 / crowd seen from behind
- 好处：传达"有人在场"的全部信息，规避率仅次于虚化和剪影。

### 3.4 主体与人群的反差（静止的人 + 流动的人潮）

长曝质感：主体清晰静止，周围人群拖出运动模糊。孤独感与疏离感的顶级表达。

- 写法：一个人静止站立，周围人流拖出动态模糊 / person standing still in a flowing crowd, motion blur crowd, long exposure feel
- 这是"人潮中的孤独"意图的标准答案，直接收进模板 C。

### 3.5 远离人群（long shot distant figures）

大远景，人缩成远处的剪影小点。既交代"有人的世界"，又把 AI 的人形压力降到零。

- 写法：远景，几个人影在远处走过 / wide shot, tiny distant figures, far-away silhouettes
- 联动 CINE-002 景别系统（大远景 / extreme long shot）。

### 3.6 空间全表（空间类型 → 画面语言 → 提示词）

| 空间类型 | 画面语言 | 情绪气质 | 提示词写法（中 / 英） |
|---|---|---|---|
| **室内纵深**（走廊/楼梯/拱廊） | 引导线汇聚视线，灭点制造纵深 | 引导、延伸、神秘 | 长廊纵深，线条向远方汇聚 / long corridor, leading lines converging, deep perspective |
| **开阔广场** | 大尺度留白，人被尺度吞没 | 开阔、自由、或渺小孤独 | 空旷的广场，人物显得渺小 / vast open square, tiny figure in wide space |
| **狭小空间**（电梯/巷弄/小屋） | 四壁逼近，构图局促 | 压迫、紧张、亲密 | 狭小的空间，墙壁逼近 / cramped narrow space, claustrophobic, tight framing |
| **对称空间**（殿堂/中庭/车站大厅） | 中轴对称，庄严秩序 | 秩序、庄严、仪式感 | 对称构图的建筑内部 / symmetrical architecture, centered composition, grand hall |
| **纵深层次**（layering） | 前景遮挡 + 中景主体 + 远景交代 | 空间立体、电影感 | 前景[遮挡物]，中景[主体]，远处[背景] / layered composition, foreground element, midground subject, background depth |
| **框架构图**（frame within frame） | 门窗洞口框住主体 | 窥视感、聚焦、画中画 | 透过[门/窗/洞口]拍摄[主体] / frame within frame, shot through a doorway / window |

### 3.7 空镜的价值（没有人 = 想象空间）

空镜不是"没拍到人"，而是**主动把人抽走**：

- 给观众投射想象的空间——刚走的人、要来的人、发生过的事；
- 承担转场与呼吸功能，是叙事的标点符号；
- 联动 CINE-002 景别系统中的 establishing shot（建立镜头）：空镜 + 大远景 = 交代时空的标准开场。

提示词要点：显式写 empty / deserted / no people + 一个动态环境元素（飘动的窗帘、摇曳的树、流云），让"无人"的画面依然活着。

---

## 四、AI 视频生成的特有规则（重点，Agent 必须执行）

### 4.1 人群是肢体崩坏重灾区

多人同框时，模型需要同时维持多张脸、多组四肢、多条行走进动线，错误率随人数指数上升。典型事故：

- 路人脸部融化 / 五官漂移；
- 三条腿、关节反折、行走滑步（脚下无接触感）；
- 人与人穿模、融合成"连体人"。

### 4.2 规避策略排序（按稳定性从高到低，Agent 优先取靠前者）

```
虚化（blurred crowd）＞ 剪影（silhouetted）＞ 远景小人（distant figures）
＞ 背影（from behind）＞ 局部（手/脚/背影特写）＞ 正面特写群像（尽量避免）
```

- 要"生活感"→ 用**虚化**，不要写清晰人群。
- 要"热闹"→ 用**剪影 + 俯拍人流**，不要写 crowded faces。
- 要"人海"→ 用 **sea of people 纹理化**写法，让模型画肌理而不是画人。
- **正面特写群像是禁区**：除非剧情强需求，否则改写为 3.1–3.5 任意一种。

### 4.3 复杂透视空间要简化提示词

旋转楼梯、镜面反射、多重门洞、扶梯交错等空间，AI 极易生成透视错误（"不可能建筑"）。规则：

- **一次只描述一个空间元素**：写"长廊纵深"就不要再叠加"镜面地板反射长廊"。
- 旋转楼梯优先用**俯拍几何图案**写法：spiral staircase seen from above, geometric pattern——把透视问题降级为平面图案问题。
- 镜面场景改为"局部反射"（a mirror reflection of the subject）而非"整个空间全是镜子"。

### 4.4 人群运动描述要给出方向

AI 生成人群时若无方向约束，动线会互相打架。提示词中给出统一流向更稳：

- 人群朝同一方向行走 / crowd walking in one direction
- 人流从画面两侧穿过 / pedestrians crossing the frame

---

## 五、常见误区（生成提示词时的纠错规则）

| 误区 | 纠正 |
|---|---|
| "人越多越有生活气息" | 生活气息来自 D2 正常人流 + 环境细节；人再多就从"生活"滑向"事件"，且崩坏率飙升 |
| "AI 人群直接拍正面就行" | 正面清晰群像是崩坏重灾区；规避排序：虚化＞剪影＞远景＞背影＞局部＞正面（见 4.2） |
| "空镜是没内容、凑时长" | 空镜是留白与呼吸，承载想象空间与转场功能（见 3.7），是最稳的高级感来源 |
| "写 crowded 模型就会画好人群" | crowded 只给密度不给处理方式；必须叠加 blurred / silhouetted / distant 等处理词 |
| "空间越复杂越显高级" | 复杂透视（旋转楼梯、镜面）是 AI 透视错乱重灾区，提示词要做减法（见 4.3） |
| "主体清晰=所有人都清晰" | 深景深人群=全员脸崩；主体清晰、人群虚化的分层才是正确写法 |
| "框架构图随便找个框" | 框架需要框内有主体、框外有信息；提示词要写明"透过什么框、框住什么" |

---

## 六、创作意图 → 提示词关键词映射表（Agent 核心调用区）

> 规则：意图先过第四章规避策略选定处理方式，再从本表取词。中英文都给，英文关键词对国际模型更有效。

### 6.1 人群密度方向

| 创作意图 | 中文提示词写法 | 英文关键词 |
|---|---|---|
| 繁华都市人流 | 熙熙攘攘的都市人流，街道充满生活气息 | bustling city crowd, busy street, vibrant urban life |
| 凌晨空街 | 空无一人的街道，黎明微光，寂静 | empty street at dawn, deserted, no people, quiet dawn light |
| 稀疏日常 | 稀疏的行人三三两两走过，安静日常 | sparse pedestrians, a few people walking by, calm everyday scene |
| 拥挤地铁 | 拥挤的地铁车厢，人贴着人 | crowded subway, packed train car, rush hour crowd |
| 废弃商场 | 废弃的商场空无一人，积灰与微光 | deserted mall, abandoned shopping mall, dusty empty interior |
| 人海史诗 | 人山人海望不到边，大远景俯拍 | mass gathering, sea of people stretching to the horizon, epic aerial view |

### 6.2 人群处理方式方向

| 创作意图 | 中文提示词写法 | 英文关键词 |
|---|---|---|
| 虚化流动人群 | 背景人流柔和虚化，人影流动看不清脸 | blurred crowd in motion, out-of-focus passersby, shallow depth of field |
| 逆光剪影人群 | 夕阳逆光，人群呈黑色剪影 | silhouetted crowd against sunset, backlit figures |
| 人潮中静止的人 | 一个人静止站立，周围人流拖出动态模糊 | person standing still in flowing crowd, motion blur crowd, long exposure feel |
| 远处人影 | 大远景，几个人影在远处走过 | long shot distant figures, tiny silhouettes far away |
| 行人脚步 | 低角度只拍行人匆匆的脚步 | low angle shot of walking feet, hurried footsteps |
| 一片背影 | 人群的背影朝同一方向走去 | crowd seen from behind, walking away from camera |
| 举起的手 | 演唱会人群中举起的无数双手 | concert crowd with raised hands, close-up of hands |

### 6.3 空间方向

| 创作意图 | 中文提示词写法 | 英文关键词 |
|---|---|---|
| 框架构图 | 透过[门/窗]框住[主体]，画中画构图 | frame within frame, shot through a doorway / window |
| 走廊引导线 | 长廊纵深，线条向远方灭点汇聚 | leading lines corridor, one-point perspective, deep vanishing point |
| 对称建筑 | 对称构图的宏伟大厅，中轴居中 | symmetrical architecture, centered composition, grand hall |
| 开阔广场 | 空旷巨大的广场，人物显得渺小 | vast open square, tiny lone figure, wide negative space |
| 狭小压迫空间 | 狭小的房间，墙壁逼近，构图局促 | cramped small room, claustrophobic space, tight framing |
| 纵深层次 | 前景[遮挡物]虚化，中景主体，远景交代环境 | layered depth, foreground occlusion, midground subject, background context |
| 拱廊纵深 | 连续拱廊向远处延伸，光影交替 | arcade corridor receding into distance, repeating arches, rhythm of light and shadow |
| 旋转楼梯（简化写法） | 俯拍旋转楼梯，呈几何螺旋图案 | spiral staircase seen from above, geometric spiral pattern |

---

## 七、提示词模板（Agent 直接填空调用）

### 模板 A：都市人流（生活气息 / 都市活力）

```
[城市/街区场景]，[时间/天气]，背景人流柔和虚化、人影流动，
[主体]清晰，[光线氛围]，生活气息，浅景深。
Blurred crowd in motion, shallow depth of field, bustling urban life, cinematic.
```

示例：
> 傍晚的商业街，暖色霓虹初亮，背景人流柔和虚化、人影流动看不清脸，一位穿风衣的女子站在路边清晰合焦，逆光轮廓，生活气息，浅景深。Blurred crowd in motion, shallow depth of field, golden hour neon, rim light, cinematic.

### 模板 B：孤独空镜（无人 / 留白）

```
空无一人的[场景]，[时间/光线]，只有[一个动态环境元素]，
寂静，[氛围词]，画面留大量空白。
Empty and deserted, no people, silent, [one moving ambient element], minimalist.
```

示例：
> 空无一人的海边栈道，清晨薄雾，只有一面被风吹动的旗帜，寂静，冷灰色调，画面留大量空白。Empty deserted boardwalk, morning mist, a single flag moving in the wind, silent, minimalist, muted tones.

### 模板 C：人潮中的静止主体（疏离感）

```
[主体]静止站立在[场景]，周围人流朝[方向]流动并拖出动态模糊，
主体清晰静止，长曝光质感，[光线]，疏离感。
Person standing still in a flowing crowd, motion blur crowd, long exposure feel.
```

示例：
> 一位老人静止站立在地铁站厅中央，周围人流朝闸机方向流动并拖出动态模糊，老人清晰静止，长曝光质感，冷白顶光，疏离感。Person standing still in a flowing crowd, motion blur, long exposure feel, cool fluorescent light, cinematic.

### 模板 D：空间纵深（引导线 / 层次感）

```
[空间类型]，[引导线元素]向远方汇聚，前景[遮挡物]虚化，
中景[主体]，远景[交代元素]，纵深层次，[光线]。
Leading lines, one-point perspective, layered depth, foreground occlusion.
```

示例：
> 古老的拱廊，连续拱门向远方灭点汇聚，前景一根廊柱虚化，中景一个行人背影，远景出口透出亮光，纵深层次，侧光。Arcade corridor, leading lines converging, one-point perspective, blurred foreground column, layered depth, side light.

### 模板 E：框架构图（进阶）

```
透过[门/窗/洞口]拍摄[主体]，框架构图，框外[环境信息]，
框内主体[状态/光线]，画中画，电影感。
Frame within frame, shot through a doorway / window, cinematic.
```

示例：
> 透过老式木窗拍摄庭院里读书的少女，框架构图，框外是斑驳的窗棂与虚化的室内，框内少女被午后阳光照亮，画中画，电影感。Frame within frame, shot through an old wooden window, sunlit courtyard, cinematic.

---

## 八、氛围意图 → 人群密度 + 处理方式 → 提示词 决策流程（Agent 推理链）

```
用户氛围意图
  │
  ├─ "孤独/安静/留白/后启示录"
  │     → 密度 D0 空无一人（或 D1 远处一两个人影）
  │     → 处理：空镜 + 一个动态环境元素；远景人影用 distant figures
  │     → 提示词：empty / deserted / no people + [ambient element]
  │
  ├─ "日常/生活气息/烟火气"
  │     → 密度 D1–D2 稀疏到正常
  │     → 处理：背景人群虚化（首选，见 4.2 排序）
  │     → 提示词：blurred crowd in motion + shallow depth of field
  │
  ├─ "都市活力/热闹/喧嚣"
  │     → 密度 D3 拥挤
  │     → 处理：虚化 或 剪影 或 俯拍人流（禁正面清晰群像）
  │     → 提示词：bustling crowd + blurred / silhouetted / high-angle
  │
  ├─ "震撼/史诗/规模感"
  │     → 密度 D4 人海 + 大空间
  │     → 处理：大远景，人群纹理化
  │     → 提示词：sea of people + epic aerial / wide shot
  │
  ├─ "窒息/压迫/疏离"
  │     → 密度 D3 + 狭小空间；或 D0–D1 + 开阔空间（反向孤独）
  │     → 处理：人潮中静止主体（motion blur crowd）或 tight framing
  │     → 提示词：person standing still in flowing crowd / claustrophobic
  │
  ├─ "庄严/秩序/仪式感"
  │     → 密度 D0–D1 + 对称空间
  │     → 处理：对称构图 + 纵深引导线
  │     → 提示词：symmetrical architecture + leading lines + centered
  │
  └─ "窥视/叙事/画中画"
        → 密度按剧情 + 框架构图
        → 处理：透过门窗洞口拍主体
        → 提示词：frame within frame, shot through a doorway / window
```

---

## 九、关联知识

- SCENE-001 天气与氛围（黄金时刻/逆光条件决定剪影人群的可行性；雾雨雪改变空间能见度与孤独感）
- CINE-002 景别系统（establishing shot 与空镜的联动；大远景决定 distant figures 的写法）
- OPTICS-001 光圈（背景人群虚化 = 浅景深效果，直接调用其 6.1 映射表；星芒与夜景人流光斑叠加）
- NARR-001 情绪→画面映射（孤独/疏离/震撼等情绪的完整映射链，本主题是其人群与空间维度的展开）

> 生成含人群的画面时，建议 SCENE-002 与 OPTICS-001（虚化）、CINE-002（景别）联合检索：先定情绪与密度（本篇），再定处理方式与景深（光圈篇），最后定景别与机位（景别篇）。
