# 景别系统（Shot Size）领域知识库

> **用途**：AI 视频生成系统的提示词知识库。供数字员工 / Agent 在生成视频提示词时检索调用。
> **主题编号**：CINE-002　**版本**：v1.0　**更新日期**：2026-09-24
> **使用方式**：Agent 接收到涉及"开场、对话、情绪、细节、氛围、产品展示"等创作意图时，检索本主题，先确定景别档位，再翻译为模型可识别的 shot size 英文术语写入提示词。**注意：主流视频模型（Runway/Pika/可灵/Sora 类）对 extreme wide shot / close-up 等标准景别词响应非常好，直接写入英文术语比长段描述更稳定**（见第六章映射表）。

---

## 一、核心概念

### 1.1 景别是什么

景别（Shot Size）指取景框容纳主体的范围大小，本质是**信息量的分配 + 心理距离的控制**：

- **取景范围越大**（远景方向）→ 环境信息多、主体信息少 → 观众与角色的心理距离远 → 客观、旁观、史诗感
- **取景范围越小**（特写方向）→ 环境信息被裁掉、主体细节被放大 → 心理距离近 → 主观、亲密、情绪压迫感

> 一句话：**景别不是"拍多大"，而是"让观众离故事多近"。** Agent 翻译创作意图时，先判断用户要的是"交代环境"还是"放大情绪"，再选档位。

### 1.2 景别的两极功能

| 维度 | 远景端（ELS/LS/FS） | 特写端（CU/ECU） |
|---|---|---|
| **信息重心** | 环境、空间关系、时代氛围 | 表情、眼神、微动作 |
| **心理距离** | 远、冷静、旁观 | 近、共情、压迫 |
| **叙事角色** | 建立（establishing）、交代 | 强调（emphasis）、揭示 |
| **典型情绪** | 孤独、渺小、壮阔、史诗 | 紧张、悲伤、温柔、爆发 |

### 1.3 景别选择的完整公式（Agent 推理时的三问）

1. **这条镜头的叙事任务是什么？** 交代环境→远；推动对话→中；放大情绪→近。
2. **主体是"人"还是"物"？** 物→insert 特写；人→按情绪强度选 MS/CU/ECU。
3. **它在整条片子里处于什么位置？** 开场→ELS/establishing；中段→MS/CU 交替；高潮→ECU；收尾→空镜或拉远。

---

## 二、景别全表（核心速查）

| 景别 | 英文名 / 缩写 | 取景范围（以人为基准） | 叙事功能 | 典型用途 | AI 提示词写法 |
|---|---|---|---|---|---|
| **大远景** | Extreme Long Shot / Extreme Wide Shot（ELS/EWS） | 人物极小或不可见，环境占满画面 | 环境叙事、交代时空、营造史诗感 | 开场、章节转换、风光大片 | extreme wide shot, vast landscape, tiny figure |
| **远景** | Long Shot / Wide Shot（LS/WS） | 人物全身但占比小，环境为主 | 人在环境中，交代人物与空间关系 | 角色登场、动作场面全貌 | wide shot, character in environment |
| **全景** | Full Shot（FS） | 人物从头到脚完整入画 | 动作完整呈现、体态语言 | 舞蹈、打斗、走秀、全身展示 | full shot, head to toe, full body |
| **中景** | Medium Shot（MS） | 腰部以上 | 对话标配，表情与肢体语言兼顾 | 访谈、对手戏、叙事推进 | medium shot, waist up |
| **中近景** | Medium Close-Up（MCU） | 胸部以上 | 比 MS 更聚焦表情，保留少量环境 | 访谈、独白、反应镜头 | medium close-up, chest up |
| **近景** | Close-Up（CU） | 肩部以上，面部占主体 | 情绪核心档位，捕捉表情变化 | 哭、笑、犹豫、震惊等情绪点 | close-up, facial expression |
| **大特写** | Extreme Close-Up（ECU） | 眼睛、嘴唇、手部等局部 | 情绪放大器、细节揭示 | 眼泪滑落、瞳孔收缩、颤抖的手 | extreme close-up, macro detail |
| **插入镜头** | Insert Shot | 与情节相关的物体特写 | 叙事伏笔、信息强调、转场缓冲 | 信件、钥匙、屏幕、合同签字 | insert shot, close-up of object |
| **空镜 / 建立镜头** | Establishing Shot / B-roll 空镜 | 无人物或人物次要的环境镜头 | 开场建立、转场呼吸、情绪留白 | 城市天际线、空房间、飘动的窗帘 | establishing shot, empty scene, no people |

### 原始口诀扩展解读（保留骨架：远全中近特）

> 原口诀：**远取其势，全取其形，中取其神，近取其情，特取其魂。**

- **远取其势 —— ELS/LS**：画面主角是"环境"，人是注脚。写提示词时环境描述权重要大于人物描述，如"荒漠中一个微小的人影"。
- **全取其形 —— FS**：动作完整性优先，任何裁掉手脚的构图都会破坏"形"。舞蹈、武术、服装展示必须 FS。
- **中取其神 —— MS/MICU**：影视对话的"标准货币"，表情和手势都看得见，信息密度均衡，是最安全、最常用的档位。
- **近取其情 —— CU**：观众开始读脸。微笑是真笑还是假笑、眼眶是否泛红，都靠 CU 交代。
- **特取其魂 —— ECU**：情绪的原子级放大。一滴泪、一次喉结滚动、指尖的颤抖，比任何台词都有力。**但 AI 生成时 ECU 风险最高**（见第四章）。

---

## 三、分题材实战指南

### 3.1 叙事短片 / 剧情

| 段落 | 推荐景别 | 原因 |
|---|---|---|
| 开场建立 | ELS / establishing shot | 先给时空坐标，再进人 |
| 角色登场 | LS → FS | 先看人与环境关系，再看全身形象 |
| 对话段落 | MS 与 MCU 交替 | 正反打标准配置，避免单调 |
| 情绪爆发点 | CU → ECU | 逐步收紧，把观众推入角色内心 |
| 收尾留白 | 空镜 / LS 拉远 | 情绪回落，给观众喘息 |

### 3.2 访谈 / 口播 / Vlog

- 主机位：**MCU（胸部以上）**，访谈感标准构图，头顶留少量空间。
- 情绪强调切镜：**CU**。
- 补充画面（B-roll）：**insert + 空镜**穿插，盖住口播剪辑点。
- 生活感 Vlog：FS/LS 手持晃动，交代"我在哪、我在做什么"。

### 3.3 产品 / 电商

- 产品全貌：**FS 或 MS**（产品完整入画，配深景深，见 OPTICS-001）。
- 卖点细节：**insert / ECU**（Logo、材质纹理、按键反馈）。
- 使用场景：**LS/WS**（产品在真实环境中的样子）。
- 节奏建议：全貌 2 秒 → 细节 1 秒 → 场景 2 秒，特写不宜连续堆叠。

### 3.4 风光 / 文旅

- 主打镜头：**ELS**，大场景+深景深（f/8 效果）是史诗感公式。
- 层次构建：ELS（全貌）→ LS（局部区域）→ 空镜（一棵树、一条溪）递进。
- 人物点缀：ELS 中加入微小人物（tiny figure）制造尺度对比。

### 3.5 情绪短片 / MV

- 情绪主体：**CU 为主力**，MV 的 70% 镜头可在 MCU–CU–ECU 区间。
- 呼吸感调节：CU 连续不超过 2 条，穿插 LS 或空镜释放压迫感。
- 高潮设计：副歌处 ECU（眼泪、嘴唇、手部）， verses 处退回 MS。

---

## 四、视频生成特有规则（AI 模型侧，Agent 必须知道）

1. **模型对 shot size 术语响应极好**：extreme wide shot / medium shot / close-up 等标准英文术语是训练数据中的高频标注词，**直接写入比中文长描述更稳定**，建议中英双语都给、英文在前。
2. **特写比全景更容易出真实感**：CU/ECU 画面元素少、构图简单，模型不容易露馅；ELS/WS 元素多，容易出现结构崩坏（多个人物肢体粘连、建筑透视错乱）。**单条生成追求"稳"时优先中近景。**
3. **面部特写是双刃剑**：CU 出片质感好，但**面部细节过多（ECU 怼脸）反而容易崩**——五官漂移、皮肤塑料感。ECU 建议对准"局部+动态"（眼泪滑落、睫毛颤动），避免静态正脸大特写。
4. **手部特写谨慎**：手部是 AI 视频的重灾区（手指数量/关节错误），ECU 手部务必搭配"简单动作"（轻握、缓慢划过），避免复杂手势。
5. **单条生成也要想清楚景别**：AI 视频单条约 5–10 秒，无法像实拍剪辑那样靠多镜头递进叙事，**每条镜头必须独立承担一个景别任务**——生成前先问"这条是建立、推进还是放大"，不要把"远-中-近"全塞进一条。
6. **景别跳变一致性**：多镜头拼接时，相邻镜头景别跨度建议 ≥2 档（如 LS→MS→CU），同档位切换易产生"跳切"感。
7. **角度词与景别词可叠加**：模型同时接受 shot size + camera angle 组合（如 close-up, low angle），组合使用可控性更高（见第六章 6.3）。

---

## 五、常见误区（生成提示词时的纠错规则）

| 误区 | 纠正 |
|---|---|
| "特写越多越有电影感" | 景别是叙事工具不是档次。连续 CU/ECU 会让观众失去空间坐标，电影感来自"远-中-近"的节奏对比 |
| "景别和焦距是一回事" | 景别=取景范围，焦距=视角与透视。85mm 也能拍全景（退远），14mm 也能拍特写（怼近）。两者独立又联动（见 OPTICS-002） |
| "开大光圈就有电影感特写" | 景别决定拍多大，光圈决定虚化多少。ECU+85mm+f/1.4 是组合拳，单靠任何一项都不成立 |
| "提示词里写'镜头拉近'模型就懂" | "zoom in"是运镜不是景别。先写 shot size（close-up）再写运镜（slow push-in），两者都要给 |
| "开场随便什么景别都行" | 开场默认用 ELS/establishing shot 交代时空，特写开场只适用于刻意制造悬念的场景 |
| "AI 视频可以一条镜头讲完所有景别" | 单条 5–10 秒只承担一个景别任务，贪多会导致画面语义混乱、主体漂移 |
| "insert 是废镜头" | 插入镜头是叙事伏笔和转场胶水，缺了它对话戏会干瘪、剪辑点会暴露 |

---

## 六、创作意图 → 提示词关键词映射表（Agent 核心调用区）

> 规则：**景别词直接写英文术语**，放在提示词靠前位置（模型对前置词权重更高）。中文描述用于补充画面内容。角度类词汇同属取景语言，一并收录。

### 6.1 景别档（由远到近）

| 创作意图 | 中文提示词写法 | 英文关键词 |
|---|---|---|
| 大远景 / 史诗开场 | 大远景，人物渺小，广阔天地 | extreme wide shot (EWS), extreme long shot, vast landscape, tiny figure |
| 远景 / 人在环境中 | 远景，人物全身，环境为主 | wide shot (WS), long shot (LS), character in environment |
| 全景 / 动作完整 | 全景，从头到脚完整入画 | full shot (FS), head to toe, full body in frame |
| 中景 / 对话标配 | 中景，腰部以上 | medium shot (MS), waist up |
| 中近景 / 访谈感 | 中近景，胸部以上 | medium close-up (MCU), chest up |
| 近景 / 面部表情 | 近景，肩部以上，表情清晰 | close-up (CU), facial expression, head and shoulders |
| 大特写 / 情绪放大 | 大特写，眼部/嘴唇局部 | extreme close-up (ECU), macro shot, eyes/lips detail |
| 插入镜头 / 物体伏笔 | 物体特写，叙事细节 | insert shot, close-up of object, detail shot |
| 空镜 / 转场呼吸 | 空镜头，无人物环境画面 | establishing shot, empty scene, no people, B-roll |
| 过肩镜头 / 对话关系 | 过肩拍，前景人物肩部虚化 | over-the-shoulder shot (OTS), shoulder in foreground |
| 主观镜头 / 第一人称 | 第一人称视角，所见即画面 | POV shot, first-person perspective, point of view |

### 6.2 角度档（取景语言的另一半）

| 创作意图 | 中文提示词写法 | 英文关键词 |
|---|---|---|
| 平视 / 客观 | 平视角度，与主体齐平 | eye level shot, neutral angle |
| 低角度 / 威严 | 低角度仰拍，主体高大 | low angle shot, looking up, powerful |
| 高角度 / 弱势 | 高角度俯拍，主体渺小 | high angle shot, looking down, vulnerable |
| 鸟瞰 / 上帝视角 | 垂直俯拍，上帝视角 | bird's eye view, top-down shot, overhead shot |
| 荷兰角 / 不安 | 倾斜构图，画面失衡 | dutch angle, tilted frame, canted angle |
| 贴地 / 速度感 | 贴地视角，超低机位 | ground level shot, worm's eye view |

### 6.3 组合公式（景别 + 焦距 + 光圈联动，跨主题调用）

| 想要的效果 | 组合 | 提示词关键词 |
|---|---|---|
| **情绪炸弹** | ECU + 85mm + f/1.4 效果 | extreme close-up, 85mm lens, shallow depth of field, creamy bokeh |
| **史诗开场** | ELS + 14mm + f/8 效果 | extreme wide shot, 14mm ultra-wide, deep focus, epic scale |
| **亲密对话** | MCU + 50mm + f/2.8 效果 | medium close-up, 50mm lens, soft background blur |
| **环境叙事** | LS + 35mm + f/5.6 效果 | wide shot, 35mm lens, moderate depth of field |
| **产品聚焦** | insert + 100mm 微距 + f/2.8 效果 | insert shot, macro lens, sharp detail, blurred background |

> 焦距与透视原理检索 OPTICS-002；光圈与景深原理检索 OPTICS-001。

---

## 七、提示词模板（Agent 直接填空调用）

### 模板 A：开场建立镜头

```
extreme wide shot / establishing shot，[大环境描述]，[人物极小或无人]，
[时间/天气/光线]，深景深全画面清晰，[史诗/宁静/压抑]氛围，镜头缓慢[运动]。
Establishing shot, vast [environment], deep focus, [mood], slow [movement].
```

示例：
> Establishing shot，黎明时分的雪山峡谷被薄雾笼罩，谷底一个微小的人影独行，金色晨光刺破云层，深景深全画面清晰，史诗而孤独的氛围，镜头缓慢上升。Extreme wide shot, vast snow mountain valley, tiny lone figure, golden morning light, deep focus, epic and lonely mood, slow drone rise.

### 模板 B：对话场景

```
medium shot / medium close-up，[人物A]与[人物B]在[场景]对话，
腰部/胸部以上，[表情与肢体语言]，柔和虚化背景，正反打交替，
over-the-shoulder shot 切入，[光线]，生活感/电影感。
Medium shot, two people talking, waist up, soft blurred background, OTS shot.
```

示例：
> Medium close-up，咖啡馆内女子与男子隔桌对话，胸部以上，女子微笑但眼神躲闪，男子身体前倾，背景暖色灯光柔和虚化，正反打交替，过肩镜头切入，窗外雨痕，电影感。Medium close-up, chest up, OTS shot, soft bokeh cafe lights, rainy window, cinematic.

### 模板 C：情绪特写

```
close-up / extreme close-up，[人物]的[面部/眼部/嘴唇]，
[微表情/微动作：眼泪滑落、睫毛颤动、嘴角抽动]，
浅景深背景完全虚化，[光线勾勒]，情绪[悲伤/震惊/释然]，镜头几乎静止。
Close-up, [subtle micro-expression], shallow DOF, [lighting], emotional, nearly static camera.
```

示例：
> Extreme close-up，女子的眼睛，一滴眼泪沿脸颊缓慢滑落，睫毛轻颤，浅景深背景虚化为冷蓝色块，侧光勾勒泪痕反光，克制的悲伤，镜头几乎静止。Extreme close-up of eyes, a tear rolling down, shallow depth of field, cold blue bokeh, restrained sadness, static camera.

### 模板 D：产品细节

```
insert shot / extreme close-up，[产品局部：Logo/纹理/接口/材质]，
[动态：手指轻触、缓慢旋转、光线扫过]，浅景深聚焦细节，
[质感光线]，镜头缓慢推进/环绕，广告级质感。
Insert shot, macro detail of [product part], sharp focus, soft blurred background, slow push-in, premium look.
```

示例：
> Insert shot，手表表盘特写，秒针划过刻度，一束光线扫过金属表壳反射出高光，浅景深聚焦表盘细节，深色背景完全虚化，镜头缓慢环绕，广告级质感。Macro insert shot, watch dial, light sweeping across metal case, sharp focus, dark blurred background, slow orbit, premium commercial look.

### 模板 E：过肩 / POV 关系镜头（进阶）

```
over-the-shoulder shot，前景[人物A肩部虚化]，焦点在[人物B面部]，
[B的表情反应]，浅景深，对话张力，[光线氛围]。
或：POV shot，第一人称视角，[手部入画动作]，[所见环境]，轻微手持晃动。
OTS shot, shallow focus on subject / POV, first-person, hands in frame, handheld.
```

---

## 八、意图 → 景别 → 提示词 决策流程（Agent 推理链）

```
用户意图
  │
  ├─ "开场/交代这是哪/大场面" → ELS + establishing shot
  │     → extreme wide shot + vast environment + deep focus + epic
  │
  ├─ "人物登场/动作全貌/舞蹈打斗" → FS
  │     → full shot + head to toe + full body movement
  │
  ├─ "两人在说话/访谈/口播" → MS / MCU
  │     → medium shot, waist up + OTS 正反打
  │
  ├─ "要情绪/表情/哭或笑" → CU
  │     → close-up + facial expression + shallow DOF
  │
  ├─ "情绪爆点/一滴泪/眼神" → ECU（避开静态正脸与复杂手部）
  │     → extreme close-up + eyes/lips + micro-movement + nearly static
  │
  ├─ "给观众看一个关键物件/伏笔" → insert
  │     → insert shot + macro detail of object + sharp focus
  │
  ├─ "转场喘口气/结尾留白" → 空镜
  │     → establishing shot + empty scene + no people
  │
  ├─ "要代入感/第一人称" → POV
  │     → POV shot + hands in frame + handheld
  │
  └─ "要压迫感或崇高感" → 景别不动，加角度
        → low angle（崇高）/ high angle（弱势）/ dutch angle（不安）
```

---

## 九、关联知识

- OPTICS-002 焦距与视角（广角/标准/长焦对景别表现力的影响，ECU+85mm / ELS+14mm 的透视原理）
- OPTICS-001 光圈（景别确定后用景深控制信息量，特写配浅景深、远景配深景深）
- CINE-001 运镜语言（景别是"框多大"，运镜是"框怎么动"，两者叠加构成完整镜头语言）
- NARR-001 情绪→画面映射（情绪强度与景别收紧程度的对应关系）

> 景别、焦距、光圈是取景的三根支柱，生成提示词时建议 CINE-002 与 OPTICS-001、OPTICS-002 联合检索；涉及情绪叙事时叠加 NARR-001。
