# 运镜语言（Camera Movement）领域知识库

> **用途**：AI 视频生成系统的提示词知识库。供数字员工 / Agent 在生成视频提示词时检索调用。
> **主题编号**：CINE-001　**版本**：v1.0　**更新日期**：2026-09-24
> **使用方式**：Agent 接收到涉及"镜头怎么动、视角怎么变化、画面节奏感"等创作意图时，检索本主题，将运镜意图翻译成模型能识别的运动描述写入提示词。**注意：AI 视频模型不理解专业术语背后的调度逻辑，一次提示词只写一个主运动**（见第六章映射表与第四章生成规则）。

---

## 一、核心概念

### 1.1 运镜是什么

运镜是拍摄过程中**镜头位置或指向的主动变化**。它的本质不是"让画面动起来"，而是：

> **镜头运动 = 观众视线的引导 + 情绪的节奏**

- **引导视线**：镜头往哪动，观众就看哪。推近是"看这里"，拉开是"看全局"，摇镜是"顺着看过去"。
- **控制节奏**：运动的快慢、急缓、起止，就是情绪的心跳。缓慢推近是屏住呼吸，甩镜是心跳漏拍。

记忆口诀：**"镜头是观众的眼睛，运动是导演的情绪"**。

### 1.2 运镜的两个基本维度

| 维度 | 内容 | 情绪对应 |
|---|---|---|
| **方向** | 推 / 拉 / 升 / 降 / 摇 / 移 / 环绕…… | 决定叙事的"揭示方向"：由点及面还是由面及点 |
| **速度** | 缓慢 / 中速 / 快速 / 急甩 | 决定情绪的"强度档位"：诗意 ←→ 躁动 |

### 1.3 运镜的三个决定因素（Agent 生成提示词时的完整公式）

写好一个运镜描述，需要同时交代三件事：

1. **运动方式**（怎么动）：push in / orbit / pan……
2. **运动速度**（动多快）：slow / gentle / rapid / sudden……
3. **运动主体关系**（动与不动）：镜头动主体静，还是镜头跟主体一起动

> 提示词组合技巧：只写运动方式不写速度，模型会随机发挥；补上速度副词（slowly / rapidly），画面情绪稳定性显著提高。

---

## 二、运镜分类速查表（核心速查）

| 中文名 | 英文名 | 画面效果 | 情绪含义 | 典型场景 | AI 视频模型里怎么写 |
|---|---|---|---|---|---|
| **推** | push in / dolly in | 画面逐渐靠近主体，景别由大变小 | 聚焦、情绪收拢、逼近真相 | 人物特写前的情绪积蓄、关键道具揭示 | slow push in on the subject, camera slowly moves closer |
| **拉** | pull out / dolly out | 主体逐渐变小，环境展开 | 揭示环境、孤独感、落幕感 | 结尾拉远交代全貌、人物置于广袤空间 | pull back reveal, camera pulls out to reveal the vast scene |
| **升** | crane up | 镜头垂直抬升，视野拔高 | 史诗感、升华、格局打开 | 大场面开场、高潮段落拔升 | crane shot rising up, camera rises to reveal |
| **降** | crane down | 镜头垂直下降，由全景落入局部 | 降临、聚焦、氛围沉降 | 从天空降到人物、由宏观到个体 | crane down, camera descends onto the subject |
| **摇** | pan | 机位不动，镜头水平旋转 | 环顾、跟随、交代空间关系 | 扫视风景、视线追随移动主体 | slow pan from left to right, camera pans across |
| **移** | tracking / dolly | 机位平行移动，像沿轨道滑行 | 陪伴感、平稳叙事、观察行进 | 侧面跟拍行走人物、横移展示空间 | smooth tracking shot, camera dollies alongside the subject |
| **跟** | follow | 镜头在主体后方/前方跟随移动 | 代入感、同行感、紧张推进 | 跟拍人物穿行街巷、追逐戏 | follow shot, camera follows the subject from behind |
| **环绕** | orbit / arc | 镜头以主体为圆心做弧线运动 | 展示、高光时刻、神化主体 | 英雄亮相、产品 360° 展示、深情对视 | orbit shot around the subject, 360 degree arc shot |
| **甩** | whip pan | 镜头极速水平甩动，画面瞬间模糊跳转 | 冲击、转场、突发、慌乱 | 事件突变、节奏切换、喜剧惊吓 | whip pan transition, sudden fast pan |
| **手持** | handheld | 画面带自然晃动与呼吸感 | 纪实、临场、紧张、不安 | 新闻纪实、动作戏、恐怖氛围 | handheld shaky cam, documentary style, subtle camera shake |
| **斯坦尼康** | steadicam | 移动但平稳顺滑，无晃动 | 流畅跟随、优雅行进、沉浸长镜头 | 走廊长镜头、舞会穿行、一镜到底感 | steadicam shot, smooth gliding camera movement |
| **无人机** | drone / aerial | 高空俯瞰或大范围飞行 | 上帝视角、宏大、抽离 | 城市全景、地貌风光、车队行进 | aerial drone shot, bird's eye view, sweeping drone footage |
| **FPV 穿越** | FPV drone | 高速穿梭、贴地俯冲、翻滚 | 速度、刺激、第一人称沉浸 | 穿越楼宇/峡谷、竞速追逐 | FPV drone shot diving through, high-speed fly-through |
| **变焦推拉** | zoom in / zoom out | 机位不动，焦距变化放大缩小 | 突兀、压迫、窥视感（区别于推拉的透视变化） | 纪录片快速取景、喜剧强调 | zoom in on the face（注意与 push in 区分，见 2.1） |
| **滑动变焦** | dolly zoom / vertigo shot | 机位推拉同时反向变焦，主体不变背景拉伸/压缩 | 眩晕、震惊、世界崩塌 | 人物顿悟/惊恐瞬间（希区柯克《迷魂记》） | dolly zoom, vertigo effect, background warping behind static subject |
| **固定机位** | static / locked shot | 镜头完全不动，画面内元素自行动 | 克制、观察、冷静、仪式感 | 空镜、对称构图、冷峻叙事 | static locked shot, fixed camera, tripod shot |

### 2.1 专题：zoom（变焦）与 push in（推拉）的区别（Agent 最常混淆点）

- **push in / dolly in（机位移动）**：镜头物理靠近主体，**透视关系改变**——前景变大、背景相对缩小，画面有"走近"的空间感。
- **zoom in（焦距变化）**：机位不动，只放大画面，**透视不变**——像把照片局部裁大，空间扁平，带窥视感。
- **dolly zoom（滑动变焦）**：推/拉机位的同时反向变焦，主体大小不变、背景被拉伸或压缩，产生强烈眩晕失真——只用于震惊、顿悟、不安等极端情绪点。

> 提示词侧：想要"走近人物"写 push in，不要写 zoom in；多数 AI 模型对 zoom 的响应是简单画面缩放，没有透视变化。

### 2.2 运镜速度 = 情绪强度（对照速查）

| 速度 | 情绪 | 写法示例 |
|---|---|---|
| 极缓慢（几乎察觉不到） | 诗意、冥想、高级感、时间凝固 | very slow / imperceptible drift, extremely slow push in |
| 缓慢匀速 | 抒情、凝视、积蓄 | slow / gentle / gradual |
| 中速 | 日常叙事、自然跟随 | steady / smooth |
| 快速 | 躁动、紧张、活力 | fast / rapid / energetic |
| 急甩 / 俯冲 | 冲击、惊吓、肾上腺素 | sudden / whip / diving |

---

## 三、分题材实战指南

### 3.1 人物情绪

| 场景 | 推荐运镜 | 原因 |
|---|---|---|
| 情绪特写（哭、笑、凝视） | 缓慢推 push in | 视线收拢，观众被拉进人物内心 |
| 人物亮相 / 高光时刻 | 环绕 orbit / arc | 多面展示，仪式感与神化 |
| 孤独 / 失落 | 拉 pull out | 人越来越小，环境吞没个体 |
| 行走叙事 | 移 tracking / 跟 follow | 陪伴感，观众与人物同行 |
| 震惊顿悟瞬间 | dolly zoom | 世界失真的生理性眩晕 |

### 3.2 风光 / 城市

- 大场景揭示：**升 crane up** 或 **无人机 aerial**，视野拔高即史诗。
- 地貌扫视：**慢摇 pan**，模拟人眼环顾。
- 穿越峡谷 / 楼宇：**FPV drone**，速度与沉浸。
- 静谧空镜：**固定机位 static**，克制反而高级。

### 3.3 产品 / 商业

- 单品展示：**环绕 orbit**（360° 呈现）+ 缓慢推近细节。
- 质感揭示：**crane down** 由环境落到产品，或 rack focus 配合推镜。
- 节奏感广告：**whip pan** 快切转场，动感活力。

### 3.4 动作 / 追逐

- 追逐跟拍：**跟 follow** 或 **手持 handheld**，临场与慌乱。
- 流畅穿行：**斯坦尼康 steadicam**，一镜到底的优雅紧张。
- 极速场景：**FPV drone**，贴地飞行。
- 撞击 / 突变瞬间：**whip pan** 衔接。

### 3.5 纪实 / Vlog

- 临场记录：**手持 handheld**（写明 subtle shake，避免过度晃动）。
- 边走边讲：**跟 follow / 移 tracking**，中速。
- 场景交代：**慢摇 pan** 开场。

---

## 四、AI 视频生成的特有规则（Agent 必须知道）

1. **一次只写一个主运动**：复合运动（如"推近同时环绕再上升"）在现有模型中极易失败或画面崩坏。**简单单一运动的成功率远高于复合运动**。需要复合效果时，拆分多个镜头分别生成。
2. **运动词要放在显眼位置**：运镜描述宜放在提示词前部或用 camera 引导（如 camera slowly pushes in on...），模型对句式 "camera + verb" 响应最稳定。
3. **必须写速度副词**：不写速度，模型随机发挥。slow / smooth / rapid / sudden 是控制情绪的关键开关。
4. **浅景深 + 大运动 = 脱焦风险**：f/1.4 级浅景深画面（见 OPTICS-001）叠加大幅度运镜（快速推拉、环绕、FPV），AI 视频极易出现焦点漂移、主体糊化。规则：**景深越浅，运镜越要慢、幅度越小**；大运动场景改用中深景深描述。
5. **环绕运动的角度预期**：orbit 类提示词多数模型只能稳定输出 90°–180° 弧线，写 360° 时首尾一致性差。需要完整环绕时写 arc shot / half orbit 更稳。
6. **甩镜与变焦的稳定性**：whip pan、dolly zoom 属于高难运动，成功率偏低，建议配合强运动模糊描述（motion blur）遮盖过渡瑕疵。
7. **固定机位也是运镜**：当画面内有丰富动态（雨、人流、车流）时，static locked shot 反而最稳、最出效果——让内容动而不是镜头动。

---

## 五、常见误区（生成提示词时的纠错规则）

| 误区 | 纠正 |
|---|---|
| "运镜越多越高级" | 一个镜头一个主运动。复合运动既难生成又破坏叙事焦点，克制才是高级 |
| "zoom 和 push in 是一回事" | zoom 只放大画面无透视变化，push in 有真实空间推进感。走近人物要写 push in |
| "不写速度模型会懂" | 速度是情绪开关，不写就随机。slow/rapid 必须明确 |
| "浅景深 + 环绕快速运动更炫" | 浅景深配大运动必脱焦。浅景深只配缓慢小幅运镜（联动 OPTICS-001） |
| "环绕就写 360 degree orbit" | 多数模型环绕超 180° 后主体一致性崩坏，写 arc / half orbit 更稳 |
| "所有视频都要有运镜" | 固定机位 + 画面内动态（雨、人流）是克制的高级手法，且生成最稳定 |
| "手持 = 晃得越厉害越真实" | 过度晃动画面崩坏，写 subtle shake / slight handheld feel |
| "dolly zoom 可以随便用" | 滑动变焦是极端情绪专用标点，滥用等于全程感叹号 |

---

## 六、创作意图 → 提示词关键词映射表（Agent 核心调用区）

> 规则：**提示词里用 "camera + 运动动词" 句式**，中英文都给，英文关键词对国际模型更有效。一次只取一个主运动。

### 6.1 收拢方向（聚焦情绪）

| 创作意图 | 中文提示词写法 | 英文关键词 |
|---|---|---|
| 缓慢推近人物特写 | 镜头缓慢推近至人物面部 | slow push in, camera slowly pushes in on the face, dolly in |
| 聚焦关键道具/细节 | 镜头缓缓推向[物体]，周围逐渐虚化 | slow dolly in on the object, push in to close-up |
| 情绪收拢/紧张积蓄 | 镜头不易察觉地缓慢靠近 | imperceptible slow push in, creeping dolly in |
| 滑动变焦/眩晕震惊 | 主体保持不动，背景被拉伸扭曲，眩晕效果 | dolly zoom, vertigo shot, background warping behind static subject |
| 变焦放大（窥视感） | 镜头变焦放大至人物面部，画面扁平压迫 | zoom in on the face, compressed flat zoom |

### 6.2 展开方向（揭示环境）

| 创作意图 | 中文提示词写法 | 英文关键词 |
|---|---|---|
| 拉远揭示全貌 | 镜头缓缓拉远，揭示广阔环境 | pull back reveal, camera pulls out to reveal the surroundings |
| 孤独感/落幕 | 镜头拉远，人物在广袤空间中越来越小 | slow pull out, subject shrinking in vast empty space |
| 升起俯瞰（史诗） | 镜头垂直升起，视野拔高展现全景 | crane up, camera rises to reveal the epic landscape |
| 无人机上帝视角 | 高空无人机俯瞰，缓缓向前飞行 | aerial drone shot, bird's eye view, sweeping drone footage |
| 降落到主体 | 镜头从高空缓缓降落到[主体] | crane down, camera descends from sky onto the subject |

### 6.3 平行与环绕方向（陪伴与展示）

| 创作意图 | 中文提示词写法 | 英文关键词 |
|---|---|---|
| 侧面平行跟拍 | 镜头平稳横移跟随行走的人物 | smooth tracking shot, camera dollies alongside the walking subject |
| 后方跟拍（代入感） | 镜头在人物身后平稳跟随 | follow shot, camera follows the subject from behind |
| 环绕展示（高光） | 镜头以主体为中心缓慢环绕 | slow orbit shot around the subject, arc shot |
| 产品 360° 展示 | 镜头环绕产品做半圆弧运动，背景虚化 | half orbit around the product, circular arc movement |
| 水平摇镜环顾 | 镜头缓慢从左向右摇摄，扫过全景 | slow pan from left to right, camera pans across the scene |
| 斯坦尼康流畅穿行 | 镜头平稳顺滑地跟随人物穿过[空间] | steadicam shot, smooth gliding movement through the hallway |

### 6.4 动感与速度方向（冲击与临场）

| 创作意图 | 中文提示词写法 | 英文关键词 |
|---|---|---|
| 甩镜转场 | 镜头极速甩向一侧，画面模糊跳转 | whip pan transition, sudden fast pan with motion blur |
| 手持纪实感 | 手持镜头，轻微自然晃动，纪实风格 | handheld shaky cam, subtle camera shake, documentary style |
| 手持紧张感 | 手持镜头明显晃动，紧迫临场 | intense handheld shake, urgent shaky cam footage |
| FPV 穿越俯冲 | FPV 无人机高速穿越[峡谷/楼宇]，贴地俯冲 | FPV drone shot diving through, high-speed fly-through |
| FPV 竞速追逐 | FPV 镜头紧贴主体高速追逐 | FPV chase shot, low-altitude high-speed pursuit |
| 快速推近（冲击） | 镜头快速推向主体，带运动模糊 | rapid push in with motion blur, crash zoom in |

### 6.5 静止方向（克制与观察）

| 创作意图 | 中文提示词写法 | 英文关键词 |
|---|---|---|
| 固定机位观察 | 固定机位，镜头完全静止，画面内[元素]自行运动 | static locked shot, fixed camera on tripod |
| 仪式感对称构图 | 固定机位，严格对称构图，人物居中不动 | static symmetrical composition, centered locked frame |
| 空镜/时间流逝 | 固定机位空镜，云影与光线缓慢变化 | static wide shot, time passing, light shifting slowly |

### 6.6 速度修饰词（叠加在任何运镜前）

- 诗意/高级：very slow, imperceptible drift, extremely slow, glacial
- 抒情/稳定：slow, gentle, gradual, smooth, steady
- 躁动/活力：fast, rapid, energetic, swift
- 冲击/失控：sudden, abrupt, whip, violent

---

## 七、提示词模板（Agent 直接填空调用）

### 模板 A：人物情绪特写（推 / 环绕）

```
[人物描述]，[表情/微动作]，镜头缓慢推近至面部特写，浅景深背景虚化，
[光线描述]，情绪[情绪词]，电影感。
Slow push in on the subject, shallow depth of field, cinematic, [emotion].
```

示例：
> 一位老人坐在窗边，眼中含泪望向远方，镜头缓慢推近至面部特写，浅景深背景暖光虚化，黄昏侧光勾勒皱纹，情绪克制而深沉，电影感。Slow push in, shallow DOF, golden hour side light, restrained emotion, cinematic.

### 模板 B：场景揭示（拉 / 升 / 无人机）

```
[主体/前景]，镜头缓缓[拉远/升起]，逐渐揭示[宏大环境]，
[时间/光线]，深景深全画面清晰，史诗感。
Pull back reveal / crane up to reveal [environment], deep focus, epic scale.
```

示例：
> 旅人独自站在沙丘顶端，镜头缓缓升起拉远，逐渐揭示一望无际的沙漠与远处落日，金色时刻，深景深全画面清晰，孤独而史诗。Crane up pull back reveal, vast desert at golden hour, deep focus, epic and lonely, aerial drone shot.

### 模板 C：产品展示（环绕 / 推近）

```
[产品描述]置于[环境/台面]，镜头以产品为中心缓慢环绕，
浅景深背景柔和虚化，[材质/高光细节]清晰可见，[光线]。
Slow orbit shot around the product, shallow DOF, [detail] in sharp focus.
```

示例：
> 一只机械腕表置于黑色大理石台面，镜头以腕表为中心缓慢环绕，浅景深背景柔化为深色渐变，表盘雕花与指针高光清晰可见，顶部聚光。Slow orbit shot, shallow DOF, spotlight from above, luxury product reveal, arc shot.

### 模板 D：动作追逐（跟 / 手持 / FPV）

```
[主体]在[环境]中[奔跑/穿行/追逐]，镜头[身后跟随/手持跟拍/FPV 紧贴]，
[速度词]，运动模糊，[光线/氛围]，紧张临场。
Follow shot / handheld shaky cam / FPV chase, motion blur, intense.
```

示例：
> 一名男子在雨夜的小巷中狂奔，镜头在身后手持跟拍，明显晃动与呼吸感，霓虹灯光在湿漉漉的地面拖出光轨，运动模糊，紧张窒息。Handheld shaky cam follow shot, neon reflections on wet ground, motion blur, urgent and breathless, rain.

### 模板 E：史诗风光（无人机 / 升降 / 慢摇）

```
[地貌/场景描述]，无人机镜头[向前飞行/缓缓升起/缓慢横移]，
[时间/光线]，深景深通透锐利，宏大史诗感，画面稳定。
Aerial drone shot, sweeping over [landscape], deep focus, epic scale, smooth and stable.
```

示例：
> 雪山群峰之上的云海，无人机镜头缓缓向前飞行穿越云层，清晨第一缕阳光染红峰顶，深景深通透锐利，宏大史诗感，画面稳定流畅。Aerial drone shot flying through sea of clouds, snow peaks at dawn, deep focus, epic scale, smooth gliding movement.

### 模板 F：震惊顿悟（滑动变焦）

```
[人物]突然[表情/反应]，滑动变焦，人物大小不变，
身后背景被[拉伸/压缩]扭曲，眩晕感，世界失真。
Dolly zoom, vertigo effect, subject static while background warps.
```

示例：
> 女子听到消息后瞳孔骤缩，滑动变焦，人物大小不变，身后走廊被无限拉长扭曲，强烈眩晕感，整个世界瞬间失真。Dolly zoom, vertigo effect, corridor stretching infinitely behind static subject, disorienting.

---

## 八、意图 → 运镜 → 提示词 决策流程（Agent 推理链）

```
用户意图
  │
  ├─ "聚焦人物情绪 / 逼近真相" → 缓慢推 push in
  │     → 提示词：slow push in + shallow DOF（特写）+ cinematic
  │
  ├─ "揭示环境 / 孤独感 / 结尾落幕" → 拉 pull out / 升 crane up
  │     → 提示词：pull back reveal / camera rises + deep focus + vast space
  │
  ├─ "史诗宏大 / 上帝视角" → 无人机 aerial / 升 crane up
  │     → 提示词：aerial drone shot + bird's eye view + epic scale
  │
  ├─ "陪伴同行 / 跟随叙事" → 移 tracking / 跟 follow / 斯坦尼康
  │     → 提示词：smooth tracking shot / follows from behind / steadicam
  │
  ├─ "高光展示 / 神化主体 / 产品呈现" → 环绕 orbit / arc
  │     → 提示词：slow orbit / arc shot（≤180° 更稳）
  │
  ├─ "追逐 / 临场 / 纪实紧张" → 手持 handheld / 跟 follow / FPV
  │     → 提示词：handheld shaky cam / FPV chase + motion blur
  │
  ├─ "速度刺激 / 穿越俯冲" → FPV drone
  │     → 提示词：FPV drone diving through + high-speed
  │
  ├─ "突变 / 转场冲击" → 甩镜 whip pan
  │     → 提示词：whip pan transition + motion blur
  │
  ├─ "震惊 / 顿悟 / 世界崩塌" → 滑动变焦 dolly zoom
  │     → 提示词：dolly zoom / vertigo effect + background warping
  │
  ├─ "克制观察 / 仪式感 / 画面内已有动态" → 固定机位 static
  │     → 提示词：static locked shot + 画面内动态元素
  │
  └─ 速度校验：意图偏"诗意/抒情" → 加 very slow / gentle
        意图偏"躁动/紧张" → 加 rapid / sudden / intense
```

---

## 九、关联知识（后续主题预留）

- OPTICS-001 光圈（浅景深与运镜速度的脱焦约束，大运动场景联动检索）
- OPTICS-002 焦距与视角（广角强化运镜动感、长焦压缩空间的运镜适配）
- CINE-002 景别系统（运镜本质上是景别的连续变化，推拉与景别的配合）
- STYLE-002 镜头节奏与剪辑感（运镜速度与成片节奏、whip pan 转场的剪辑逻辑）

> 运镜与景深、焦距强耦合：生成含运镜的提示词时，建议 CINE-001 与 OPTICS-001、OPTICS-002 联合检索，避免"浅景深 + 大运动"等高风险组合。
