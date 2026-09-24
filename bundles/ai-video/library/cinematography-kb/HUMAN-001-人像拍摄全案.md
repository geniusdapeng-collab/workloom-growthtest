# 人像拍摄（Human Portrait）领域知识库

> **用途**：AI 视频生成系统的提示词知识库。供数字员工 / Agent 在生成视频提示词时检索调用。
> **主题编号**：HUMAN-001　**版本**：v1.0　**更新日期**：2026-09-24
> **使用方式**：Agent 接收到涉及"拍人、人像、肖像、街拍、写真、形象照"等创作意图时，检索本主题，将"人物与镜头的关系"翻译为机位、视线、动作的画面描述写入提示词。**注意：AI 视频模型不理解"构图三分法""45 度角"等摄影术语本身，必须把机位与姿态意图翻译成画面效果描述**（见第六章映射表）。人脸是 AI 视频崩坏重灾区，生成前务必过一遍第七章规避策略。

---

## 一、核心概念

### 1.1 人像的本质：拍人 = 拍关系

人像摄影拍的不是"一个人长什么样"，而是**观众与这个人物之间的心理关系**。这个关系由三个变量决定：

> **关系 = 镜头与人物的距离（景别）× 镜头与人物的角度（机位）× 人物的视线方向**

- **距离**：特写 = 闯入私人空间（亲密/压迫）；远景 = 旁观者（疏离/客观）
- **角度**：平视 = 平等对话；仰拍 = 仰望对方；俯拍 = 俯视对方
- **视线**：看镜头 = 他在与你交流；看画外 = 你在观察他；看远方 = 他在自己的世界里

记忆口诀：**"机器站哪，观众就站哪；人看哪，心就去哪"**。Agent 生成人像提示词时，先确定"要让观众和这个人是什么关系"，再反推距离、角度、视线三要素。

### 1.2 人像提示词的四层结构

| 层级 | 内容 | 作用 |
|---|---|---|
| **关系层** | 景别 + 机位角度 + 视线方向 | 决定观众与人物的心理关系（本章核心） |
| **状态层** | 姿态 + 动态 + 表情 | 决定人物"在做什么、什么情绪" |
| **质感层** | 光线 + 景深 + 肤色材质 | 决定画面的专业度与真实感 |
| **安全层** | AI 崩坏规避词（侧脸/中景/动态） | 决定人脸、手部会不会翻车 |

> 提示词组合技巧：四层各取一两个关键词即可，不要堆叠。堆得越多，模型注意力越分散，人脸越容易崩。

### 1.3 视频人像与照片人像的根本区别

照片要"决定性瞬间"，视频要**"动态中的自然瞬间"**：

1. 视频人像的姿态必须有**动势**——行走中、转身中、发丝飘动中，而不是摆好姿势定格
2. 表情要有**过程**——从平静到微笑的变化，比一个固定的笑更动人
3. 静止凝视镜头超过 2 秒是 AI 人脸崩坏的高发场景，能用动态就不用静态

---

## 二、机位角度全表（核心速查）

| 中文名 | 英文名 | 心理效果 | 适用 | AI 提示词写法 |
|---|---|---|---|---|
| **平视** | eye level | 平等、真实、无距离感，像朋友聊天 | 生活记录、访谈、证件肖像、大多数安全场景 | 与人物视线平齐的平视视角 / eye-level shot, camera at subject's eye level |
| **微仰** | slightly low angle | 自信、挺拔、有气场，轻微的英雄感 | 职业形象、领袖感、时尚大片、显腿长 | 轻微仰拍，人物显得挺拔自信 / slightly low angle, confident heroic presence |
| **高角度俯拍** | high angle | 弱小、可爱、无辜，或被环境压迫的窒息感 | 表现脆弱/童真、大场景压小人、俯拍坐姿 | 高角度俯拍，人物显得娇小可爱 / high angle looking down, subject appears small |
| **荷兰角** | dutch angle / canted angle | 失衡、不安、癫狂、世界出了问题 | 悬疑、精神紧绷、夜店迷幻、冲突瞬间 | 倾斜构图，画面失去水平，不安感 / dutch angle, tilted frame, unsettling |
| **POV 主观视角** | POV shot | 观众=人物本人，强代入感 | 第一人称叙事、互动感内容、恐怖/沉浸 | 第一人称主观视角 / first-person POV, subjective camera |
| **过肩** | over-the-shoulder (OTS) | 对话关系、偷窥感、介入两人之间 | 双人对话、跟随感、前景遮挡增加层次 | 从肩后拍摄，前景肩膀虚化 / over-the-shoulder shot, blurred shoulder in foreground |
| **侧脸** | profile | 轮廓美、思考感、不交流的疏离感 | 情绪写真、剪影、展示下颌线/鼻梁轮廓 | 侧面视角，展现面部轮廓 / profile view, side face, facial silhouette |
| **回眸** | looking back over shoulder | 故事感、临别、被呼唤的瞬间 | 行走中回头、告别、悬念开场 | 行走中回头看向镜头，肩膀在前景 / looking back over shoulder while walking |

### 角度组合解读（Agent 生成时的常用搭配）

- **平视 + 看镜头** = 最直接的交流，像视频通话。真实但平淡，靠表情和光线出彩。
- **微仰 + 侧脸** = 时尚大片标配。仰角给气场，侧脸避开了正脸对称性的 AI 崩坏风险，双赢。
- **俯拍 + 看镜头抬头** = 显脸小、显无辜的经典"男友视角"，短视频平台最常用的讨喜角度。
- **过肩 + 看画外** = 观众站在人物身后一起望向某个东西，悬念和代入感同时拉满。
- **回眸 + 慢速行走** = "故事开始了"的信号，配合浅景深虚化背景是情绪短片的万能开场。

---

## 三、视线方向：人物看哪，观众的心就去哪

### 3.1 三种视线的心理机制

| 视线 | 英文名 | 心理效果 | 适用 | AI 提示词写法 |
|---|---|---|---|---|
| **看镜头** | direct eye contact | 交流、挑衅、亲密、打破第四面墙 | 口播、告白、时尚大片的凌厉感 | 直视镜头，与观众眼神交流 / direct eye contact with camera, looking into lens |
| **看画外** | looking away / off-camera gaze | 故事感、被观察、若有所思，观众成了"偷看的人" | 情绪写真、叙事短片、candid 随拍 | 目光望向画面之外，若有所思 / looking off-camera thoughtfully |
| **看远方** | gazing into distance | 憧憬、迷茫、孤独、格局感 | 结尾镜头、旅行片、励志内容 | 凝视远方地平线，眼神悠远 / gazing into the distance, distant horizon |

### 3.2 视线引导线必须留白

人物视线指向的方向，**画面中要留出空间**（视线前方的"呼吸空间"）：

- 人物看画面左边 → 人物放画面右侧，左边留白 → 观众视线被引导，画面有张力
- 人物紧贴画面左边缘还往左看 → 视线"撞墙"，画面憋屈压抑（除非故意要这种窒息感）

> 提示词写法：视线留白 + 人物位于画面一侧 / negative space in the direction of gaze, subject positioned off-center。

### 3.3 视线选择的决策规则

- 要**连接**（带货、口播、亲密感）→ 看镜头
- 要**故事**（他有心事、有下文）→ 看画外
- 要**格局**（远方、梦想、结束感）→ 看远方
- 不确定时 → 看画外最不容易出错，也最不容易暴露 AI 眼神僵直的问题

---

## 四、美姿与动态（视频版）

### 4.1 身体动态

| 动态 | 关键点 | AI 提示词写法 |
|---|---|---|
| **站姿** | 重心偏一侧、身体微转，避免"站军姿" | 自然站立，重心偏向一侧 / standing naturally, weight shifted to one side |
| **坐姿** | 身体前倾显亲近，后仰显松弛/傲慢 | 放松地坐着，身体微微前倾 / sitting relaxed, leaning slightly forward |
| **行走** | 视频人像第一安全动作，动态掩盖 AI 瑕疵 | 自然地走在街道上 / walking naturally through the street |
| **奔跑** | 配合慢动作=自由感；配合手持=追逐感 | 奔跑，慢动作 / running in slow motion |
| **旋转** | 裙摆与发丝甩开，动态的华丽顶点 | 旋转，裙摆和发丝飞扬 / spinning, dress and hair flowing |

### 4.2 手部动作（少给特写，给中景）

| 动作 | 情绪 | AI 提示词写法 |
|---|---|---|
| 撩发 | 风情、不经意 | 抬手把头发别到耳后 / tucking hair behind ear |
| 托腮 | 沉思、慵懒、可爱 | 手托着下巴望向窗外 / resting chin on hand, gazing out window |
| 拿道具 | 咖啡杯/书/花=生活感；墨镜/帽子=时尚感 | 手持咖啡杯行走 / walking with a coffee cup in hand |

> 注意：手部是 AI 视频第二大崩坏区。手部动作写在提示词里，但**景别保持中景以上**，不要让手占据画面中心（见第七章）。

### 4.3 表情管理

| 表情 | 写法要点 | AI 提示词写法 |
|---|---|---|
| 微笑 | 加"自然""轻微"，否则容易假笑 | 自然轻微笑 / soft natural smile |
| 大笑 | 配合动态（回头笑、奔跑笑）更真 | 开怀大笑，动态模糊 / laughing joyfully, candid laughter |
| 沉思 | 配侧脸+看画外，情绪写真标配 | 陷入沉思，目光低垂 / lost in thought, eyes lowered |
| 放空 | 无焦点眼神，慵懒氛围 | 放空的眼神，慵懒氛围 / vacant relaxed gaze, laid-back mood |

> 核心原则：**写"动态中的瞬间"而不是"摆拍定格"**。"行走中回头微笑"远比"站着微笑"出片，因为运动给了模型连续帧的合理性，也给了观众"抓拍到的真实"的心理暗示。

---

## 五、人像类型配方表（核心速查）

> 配方 = 景别 + 角度 + 光线 + 景深 + 动作。景别详见 CINE-002，光线详见 LIGHT-001，景深详见 OPTICS-001。

| 人像类型 | 配方 | AI 提示词写法 |
|---|---|---|
| **证件感正式肖像** | 胸上特写 + 平视 + 均匀柔光 + 中浅景深 + 端正微表情 | 正式肖像，平视，柔和均匀布光，表情端庄 / formal portrait, eye-level, soft even lighting, composed expression |
| **时尚大片** | 全身/七分身 + 微仰 + 硬光强阴影 + 浅景深 + 夸张姿态（叉腰/大步走/甩头） | 时尚大片，硬朗光线，戏剧性阴影，夸张自信的 pose / fashion editorial, hard light, dramatic shadows, bold confident pose |
| **生活感随拍 candid** | 中景 + 平视 + 自然光 + 中等景深 + 不看镜头 + 正在做某件事 | 抓拍瞬间，人物不知道镜头的存在，自然动作 / candid moment, unaware of camera, natural unposed action |
| **情绪写真** | 特写/近景 + 侧脸或回眸 + 低调暗光 + 极浅景深 + 眼神戏 + 微动态 | 情绪特写，低调暗光，眼神忧郁，极浅景深 / emotional close-up, low-key lighting, melancholic gaze, very shallow DOF |
| **运动人像** | 全身 + 低角度 + 侧光塑形 + 中景深 + 动态模糊（跑动/跳跃） | 低角度运动人像，动态模糊，力量感 / low angle sports portrait, motion blur, dynamic powerful movement |
| **亲子/情侣** | 中景 + 平视或微俯 + 暖调柔光 + 中浅景深 + 互动动作（牵手/对视笑/追逐） | 两人牵手散步，相视而笑，温暖光线 / couple holding hands walking, laughing together, warm soft light |
| **职业形象照** | 半身 + 微仰 + 侧光勾轮廓 + 中浅景深 + 干练动作（抱臂/整理袖口） | 职业形象，轻微仰拍，侧光，干练自信 / professional corporate portrait, slightly low angle, side lighting, confident and capable |

### 配方使用说明

- **先选类型，再改一两个变量**做个性化，不要从零组装。
- 配方中的"景深"翻译成 OPTICS-001 的视觉语言（浅景深=背景虚化），不要写 F 值。
- 亲子/情侣类的核心是**互动动作**而非单人美貌，提示词里互动动词（牵手、对视、追逐）权重最高。

---

## 六、创作意图 → 提示词关键词映射表（Agent 核心调用区）

> 规则：**提示词里不要直接写"45 度角""三分法构图"等术语**（多数视频模型无效），按本表翻译成画面语言。中英文都给，英文关键词对国际模型更有效。

### 6.1 机位角度

| 创作意图 | 中文提示词写法 | 英文关键词 |
|---|---|---|
| 平等真实 | 与人物视线平齐的平视视角 | eye-level shot, camera at eye level |
| 自信气场 | 轻微仰拍，人物挺拔有气场 | slightly low angle, low angle hero shot, confident presence |
| 弱小/可爱 | 高角度俯拍，人物显得娇小 | high angle shot, looking down at subject |
| 不安失衡 | 倾斜构图，画面失去水平 | dutch angle, tilted frame, canted angle |
| 第一人称代入 | 第一人称主观视角 | first-person POV, subjective camera |
| 对话/偷窥 | 从肩后拍摄，前景肩膀虚化 | over-the-shoulder shot, OTS |
| 轮廓/思考 | 侧面视角，面部轮廓清晰 | profile view, side face, profile silhouette |
| 故事感回头 | 行走中回头看向镜头 | looking back over shoulder while walking |

### 6.2 视线方向

| 创作意图 | 中文提示词写法 | 英文关键词 |
|---|---|---|
| 交流/挑衅/亲密 | 直视镜头，与观众眼神交流 | direct eye contact, looking into the lens |
| 故事感/被观察 | 目光望向画面之外，若有所思 | looking away thoughtfully, off-camera gaze |
| 憧憬/迷茫 | 凝视远方，眼神悠远 | gazing into the distance, distant gaze |
| 低头害羞/忧郁 | 目光低垂 | eyes lowered, looking down |
| 视线留白 | 视线方向留出画面空间，人物偏于一侧 | negative space in gaze direction, off-center composition |

### 6.3 姿态与动态

| 创作意图 | 中文提示词写法 | 英文关键词 |
|---|---|---|
| 生活抓拍 | 抓拍瞬间，自然不做作的动作 | candid moment, natural unposed |
| 自然微笑 | 自然轻微笑，不刻意 | natural smile, soft genuine smile |
| 街头行走 | 自然地走在街道上，步伐轻快 | walking through street, natural stride |
| 发丝飞扬 | 风吹动发丝，发丝飞扬 | hair flowing in wind, windblown hair |
| 裙摆旋转 | 旋转，裙摆甩开成圆弧 | spinning, dress flaring out, twirling |
| 撩发 | 抬手把头发别到耳后 | tucking hair behind ear |
| 托腮沉思 | 手托下巴，若有所思 | resting chin on hand, thoughtful |
| 大笑 | 开怀大笑，真实情绪 | laughing joyfully, candid laughter |
| 奔跑慢动作 | 奔跑，慢动作，充满自由感 | running in slow motion, sense of freedom |

### 6.4 风格与类型

| 创作意图 | 中文提示词写法 | 英文关键词 |
|---|---|---|
| 时尚大片 | 时尚杂志大片风格，夸张姿态，硬光 | fashion editorial, fashion magazine style, bold pose, hard light |
| 情绪写真 | 情绪特写，低调暗光，眼神有戏 | emotional portrait, low-key lighting, expressive eyes |
| 职业形象 | 职业形象照，干练自信 | professional headshot, corporate portrait |
| 情侣互动 | 两人互动，牵手相视而笑 | couple interacting, holding hands, warm chemistry |
| 运动力量感 | 运动人像，动态模糊，低角度力量感 | sports portrait, motion blur, athletic dynamic |

### 6.5 肤色与质感（联动 PHYS-002 材质与纹理）

| 创作意图 | 中文提示词写法 | 英文关键词 |
|---|---|---|
| 皮肤真实感 | 真实皮肤质感，可见毛孔与细微纹理 | realistic skin texture, visible pores, natural skin detail |
| 胶片肤色 | 胶片质感肤色，轻微颗粒 | film-like skin tones, subtle film grain |
| 避免蜡像脸 | 避免过度磨皮，保留皮肤自然纹理与瑕疵 | no plastic skin, natural skin imperfections, no airbrushed look |
| 健康光泽 | 皮肤有自然光泽，非油光 | healthy natural skin glow |

---

## 七、AI 视频特有问题：人脸是崩坏重灾区（重点规避策略）

人脸是 AI 视频生成失败率最高的元素——观众对人脸瑕疵的容忍度趋近于零（恐怖谷效应）。以下策略按优先级排序，Agent 生成人像提示词时**逐条过检**：

1. **侧脸 > 正脸**：正脸要求双眼、双颊严格对称，是崩坏高发区；侧脸只需一条轮廓线，成功率显著提高。非必要不正脸。
2. **中景 > 特写**：脸部在画面中占比越小，瑕疵越不可见。情绪特写务必配合"极浅景深 + 眼部合焦"把模型算力集中在眼睛上。
3. **动态 > 静止凝视**：人物在走、在转头、发丝在动时，观众注意力被运动分散，且连续帧的动态瑕疵比静止帧的僵直更不刺眼。静止凝视镜头控制在 2 秒以内。
4. **描述气质 > 描述具体五官**：写"清冷的气质、坚毅的眼神"比写"高鼻梁、薄嘴唇、双眼皮"更稳——具体五官描述会让模型强行拼装特征，极易拼歪。
5. **手部尽量少给特写**：手部是仅次于人脸的崩坏区。需要手部动作（撩发、拿道具）时保持中景，让手自然出现在动作里，而不是画面主体。
6. **亚洲面孔写明 asian**：不标注时模型默认偏向欧美骨相，亚洲面孔需求写 asian woman / east asian man 更稳定。
7. **避免快速大幅度表情变化**：从大笑到哭泣的瞬间切换几乎必崩。表情要么恒定微动态，要么缓慢渐变（calm expression slowly turning into a smile）。
8. **多人场景控制人数**：3 人以上同框，边缘人脸几乎必崩。群像用远景/剪影/背影规避。

---

## 八、提示词模板（Agent 直接填空调用）

### 模板 A：生活感街拍

```
[人物描述]自然地走在[街道场景]上，[正在做的事/手部动作]，不看镜头，
平视视角，中景，自然光，中等景深，背景行人轻微虚化，抓拍感，生活气息。
Candid moment, walking through street, natural unposed, eye-level shot, medium shot, natural light.
```

示例：
> 一位穿米色风衣的年轻女子自然地走在秋日街道上，手持咖啡杯，偶尔低头看手机，不看镜头，平视视角，中景，午后柔和自然光，背景行人轻微虚化，抓拍感。Candid moment, asian woman walking through autumn street with coffee cup, natural unposed, eye-level medium shot, soft afternoon light.

### 模板 B：时尚大片

```
[人物描述]，[夸张姿态/动态]，轻微仰拍，硬朗光线制造戏剧性阴影，
浅景深，背景[简洁场景]虚化，时尚杂志大片质感，自信凌厉。
Fashion editorial, slightly low angle, hard light, dramatic shadows, bold confident pose, shallow depth of field.
```

示例：
> 一位穿黑色西装的男模大步走向镜头，轻微仰拍，硬朗侧光在墙面投下戏剧性长阴影，浅景深，背景极简水泥墙虚化，时尚杂志大片质感，眼神凌厉自信。Fashion editorial, male model striding toward camera, low angle hero shot, hard side light with dramatic shadows, bold confident pose.

### 模板 C：情绪特写

```
[人物描述]的面部特写，侧脸，目光[看向/情绪]，低调暗光勾勒轮廓，
极浅景深，眼部锐利合焦，[微动态]，安静压抑的情绪氛围。
Emotional close-up, profile view, low-key lighting, very shallow DOF, sharp focus on eyes, melancholic mood.
```

示例：
> 一位女子的面部特写，侧脸，目光低垂若有所思，窗边低调暗光勾勒面部轮廓，极浅景深，眼部锐利合焦，一滴泪光闪烁，睫毛轻微颤动，安静忧郁的氛围。Emotional close-up, profile view, eyes lowered, low-key window lighting, very shallow depth of field, sharp focus on eyes, melancholic mood.

### 模板 D：运动人像

```
[人物描述]在[运动场景][运动动作]，低角度仰拍，侧光勾勒肌肉线条，
中等景深，运动瞬间动态模糊，力量感与速度感，慢动作。
Low angle sports portrait, motion blur, dynamic powerful movement, athletic, slow motion.
```

示例：
> 一位短发女运动员在黄昏的跑道上全力冲刺，低角度仰拍，夕阳侧光勾勒身体线条，中等景深，腿部带动态模糊，发丝向后飞扬，力量感与速度感，慢动作。Low angle sports portrait, asian female athlete sprinting at dusk, side sunlight, motion blur on legs, hair flowing back, slow motion, powerful and dynamic.

### 模板 E：夜景人像

```
[人物描述]在[夜晚场景]，[动作/视线]，背景城市灯光虚化成暖色圆形光斑，
极浅景深，[光源]照亮面部，电影感，[机位角度]。
Night portrait, creamy bokeh, defocused city lights, very shallow depth of field, cinematic.
```

示例：
> 一位穿红色大衣的女子在雨后的夜市街口回眸，看向镜头轻微笑，背景霓虹灯光虚化成暖色圆形光斑，极浅景深，路灯光照亮面部轮廓，地面倒影，电影感，平视中近景。Night portrait, woman in red coat looking back over shoulder at camera, neon lights as creamy bokeh, very shallow DOF, wet street reflections, cinematic.

---

## 九、意图 → 人像方案 → 提示词 决策流程（Agent 推理链）

```
用户意图
  │
  ├─ 第一步：定人像类型
  │     ├─ 正式/证件 → 模板：正式肖像配方（平视+柔光+特写）
  │     ├─ 时尚/大片 → 模板：时尚配方（微仰+硬光+夸张姿态）
  │     ├─ 生活/记录 → 模板：candid 配方（平视+自然光+不看镜头）
  │     ├─ 情绪/氛围 → 模板：情绪写真配方（侧脸+低调光+极浅景深）
  │     ├─ 运动/力量 → 模板：运动配方（低角度+侧光+动态模糊）
  │     └─ 双人/亲子/情侣 → 模板：互动配方（中景+暖光+互动动作）
  │
  ├─ 第二步：定角度与视线（关系层）
  │     ├─ 要交流感 → 平视 + 看镜头（direct eye contact）
  │     ├─ 要气场 → 微仰 + 侧脸或看镜头（low angle hero shot）
  │     ├─ 要故事感 → 侧脸/回眸 + 看画外（looking away thoughtfully）
  │     ├─ 要代入感 → POV 或过肩（first-person POV / OTS）
  │     └─ 要可爱/脆弱 → 高角度俯拍 + 抬头看镜头（high angle）
  │
  ├─ 第三步：定动作（状态层，视频必须有动势）
  │     ├─ 无明确动作需求 → 默认"行走 + 回眸"，最安全的视频动态
  │     ├─ 要柔美 → 旋转/发丝飞扬（hair flowing in wind / spinning）
  │     ├─ 要生活感 → 手部小动作 + 不看镜头（candid moment）
  │     └─ 要力量 → 奔跑/跳跃 + 慢动作（running in slow motion）
  │
  ├─ 第四步：过 AI 安全检查（第七章）
  │     ├─ 正脸特写？→ 能改侧脸/中景就改
  │     ├─ 静止凝视超 2 秒？→ 加微动态（发丝/呼吸/眨眼）
  │     ├─ 手部特写？→ 景别拉大到中景
  │     ├─ 具体五官描述？→ 换成气质描述
  │     ├─ 亚洲面孔？→ 写明 asian
  │     └─ 快速表情切换？→ 改为缓慢渐变
  │
  └─ 第五步：组装提示词
        → 关系层（角度+视线）+ 状态层（动态+表情）+ 质感层（光线+景深）+ 安全层
        → 每层取 1–2 个关键词，参考第八章模板填空
```

---

## 十、常见误区（生成提示词时的纠错规则）

| 误区 | 纠正 |
|---|---|
| "人像 = 脸越清楚越好" | 脸占画面越大，AI 崩坏越明显，观众对瑕疵越敏感。中景动态人像往往比大特写更"好看"。清晰是手段不是目的，关系与情绪才是 |
| "看镜头才专业" | 恰恰相反，时尚编辑与电影叙事大量用看画外。看镜头=交流，看画外=故事，是两种功能而非高低之分 |
| "摆好 pose 再拍" | 视频要的是动态中的自然瞬间。摆拍定格在视频里僵硬且易崩，永远优先写"行走中/转身中/笑的过程中" |
| "仰拍就是显高大，随便用" | 大仰角拍普通人会暴露鼻孔、双下巴，变形严重。日常人物用"轻微仰拍"（slightly low angle）即可 |
| "描述五官越详细越像本人" | AI 视频里写具体五官（高鼻梁薄嘴唇）极易拼装崩坏。描述气质、发型、服装、姿态，比描述五官更稳定地传达"这个人是谁" |
| "磨皮越狠越美" | 过度磨皮=蜡像脸=廉价感。真实皮肤质感（realistic skin texture, visible pores）才是高级感的来源 |
| "表情越丰富越生动" | AI 视频的表情快速变化是崩坏重灾区。恒定微表情+缓慢渐变才是安全且高级的做法 |
| "人像提示词只管人，背景随便" | 背景决定景深策略与氛围。夜景光斑、街道纵深、纯色墙面都是人像提示词的必备组件，人景要一起设计 |

---

## 十一、关联知识

- OPTICS-001 光圈（人像景深策略：特写浅景深、合影中景深的换算规则）
- OPTICS-002 焦距与视角（85mm 人像镜的特写压缩感 vs 35mm 环境人像）
- CINE-002 景别系统（特写/近景/中景/全身的心理距离定义）
- LIGHT-001 光线方向与质感（蝴蝶光/伦勃朗光/轮廓光对人像气质的塑造）
- PHYS-002 材质与纹理（皮肤、发丝、布料的真实感关键词库）
- NARR-001 情绪 → 画面映射（忧郁/温暖/紧张等情绪的人像画面参数）

> 人像提示词 = 关系（本主题）× 景别（CINE-002）× 光线（LIGHT-001）× 质感（PHYS-002）。生成时建议 HUMAN-001 与 LIGHT-001、CINE-002 联合检索。
