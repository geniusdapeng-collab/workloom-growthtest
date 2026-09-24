# ISO 与画质氛围（ISO & Image Texture）领域知识库

> **用途**：AI 视频生成系统的提示词知识库。供数字员工 / Agent 在生成视频提示词时检索调用。
> **主题编号**：OPTICS-004　**版本**：v1.0　**更新日期**：2026-09-24
> **使用方式**：Agent 接收到涉及"画面干净、通透、胶片颗粒、噪点、暗光画质、高反差"等创作意图时，检索本主题，将 ISO 意图翻译成对应的画面质感描述写入提示词。**注意：AI 视频模型不理解 ISO 数值本身，必须把感光度意图翻译成画面气质描述**（见第六章映射表）。

---

## 一、核心概念

### 1.1 ISO 是什么

ISO 是感光元件对光线信号进行**电子增益（gain）**的倍数。它不改变进光量，只是把已经接收到的信号放大：

> **ISO 的本质是"放大器"，不是"光"。**

- **ISO 越低**（如 ISO 100）→ 增益越小 → 画面越干净 → 噪点越少，但需要更多光线
- **ISO 越高**（如 ISO 6400+）→ 增益越大 → 暗部被提亮 → **噪点同步被放大**，动态范围下降

记忆口诀：**"ISO 不造光，只放大信号——信号不够，噪点来凑"**。

### 1.2 曝光三角的联动（一句话版）

曝光 = 光圈（进多少光）× 快门（进多久）× ISO（放大多少倍）；光圈与快门已各有专题（见 OPTICS-001、OPTICS-003），**本主题只负责：当前两者都不够时，用 ISO 补上曝光，并承担它带来的画质代价**。

### 1.3 ISO 的三大代价

| 代价 | 低感（ISO 100–400） | 高感（ISO 6400+） |
|---|---|---|
| **噪点** | 几乎不可见 | 明显颗粒/彩色斑点 |
| **动态范围** | 最宽，亮暗细节都保得住 | 收窄，暗部死黑、高光易溢出 |
| **色彩纯度** | 饱和干净 | 偏色、发灰、彩噪污染 |

> 提示词组合技巧：想要"干净通透"时，不要只写 clean，组合"低光比布光 + 充足光线 + 细节锐利"的描述，效果更稳定。

---

## 二、ISO 档位全表（核心速查）

| ISO 档位 | 画质状态 | 典型用途 | 画面气质关键词 |
|---|---|---|---|
| **ISO 50–100（原生低感）** | 极干净，动态范围最大 | 商业广告、产品片、风光大片 | 通透、纯净、玻璃质感、商业级 |
| **ISO 200–400** | 干净，日常安全区 | 室内采访、棚拍、 daylight 外景 | 清爽、细腻、色彩饱和 |
| **ISO 800–1600（中感）** | 轻微噪点，放大可见 | 婚礼跟拍、室内活动、黄昏 | 自然、纪实感、略带颗粒 |
| **ISO 3200** | 噪点可见但可用 | 夜景手持、舞台、弱光纪实 | 粗粝、现场感、新闻感 |
| **ISO 6400–12800（高感）** | 噪点明显，动态范围收窄 | 星空、深夜纪实、 surveillance 感 | 颗粒感、胶片感、粗野、氛围 |
| **ISO 25600+（扩展高感）** | 噪点爆炸，色彩崩坏 | 极端暗光、风格化创作 | 强颗粒、低保真、监控录像质感 |
| **双原生 ISO（Dual Native ISO）** | 相机有两档"原生"增益基准（如 800/4000），切到高基准时高感画质跃升 | 电影机（FX3、C70 等）夜拍 | 暗光下依然干净的"作弊器"，提示词侧无需体现，仅影响实拍 |

### 档位气质扩展解读

- **ISO 100 —— 商业质感基准线**：广告、美妆、产品片的默认档位。画面如玻璃般干净，放大看不到任何杂质。代价：极度吃光，没灯没太阳就别想。
- **ISO 800–1600 —— 纪实甜点位**：婚礼、活动跟拍的常用区间。噪点在 4K 缩放下几乎不可见，换来的是快门与光圈的自由度。
- **ISO 3200+ —— 风格分水岭**：从这里开始，噪点从"事故"变成"质感"。胶片颗粒、夜行纪实、监控美学都活在这个区间。
- **扩展高感 —— 故意的低保真**：25600 以上的画面崩坏感，恰好是复古 DV、found footage 伪纪录片、Y2K 监控风格的灵魂。

---

## 三、噪点的两面性（Agent 生成提示词时的关键判断）

### 3.1 噪点 = 画质事故（该避免的）

- 商业片、产品片、美妆、美食：**任何可见噪点都是废片**。
- 彩噪（红绿蓝随机斑点）出现在人脸、天空、纯色墙面上 → 廉价感、手机感。
- 提示词对策：clean image / pristine / noise-free / smooth tones。

### 3.2 噪点 = 胶片颗粒美学（该加钱的）

- **film grain（胶片颗粒）是提示词高频加分词**：为数字画面注入"有机感"与"年代感"。
- 胶片颗粒与数码噪点的区别：颗粒**细腻、均匀、随画面亮度变化**；数码噪点**粗糙、成块、伴随彩色斑点**。
- 适用风格：胶片电影感、复古 MV、文艺片、情绪短片、35mm/16mm 胶片模拟。

| 维度 | 画质事故的噪点 | 美学加分的颗粒 |
|---|---|---|
| 形态 | 成块、闪烁、带彩斑 | 细腻、均匀、单色调 |
| 观感 | 脏、廉价、手抖感 | 有机、温暖、电影感 |
| 提示词 | （避免词）noise, artifacts | film grain, 35mm grain, analog texture |

---

## 四、噪点类型速查（哪个更不能忍）

| 类型 | 表现 | 观感伤害 | 提示词侧处理 |
|---|---|---|---|
| **亮度噪点（Luminance Noise）** | 灰色颗粒，明暗随机起伏 | ★★ 尚可忍，近似胶片颗粒 | 可转化为 film grain 风格词 |
| **彩色噪点（Chroma/Color Noise）** | 红绿蓝随机斑点，暗部与纯色区域最明显 | ★★★★★ 绝不能忍，瞬间廉价 | 负面词避开 color noise / chromatic noise |
| **条带噪点（Banding）** | 天空、渐变区域出现色阶断层 | ★★★★ 暗光+后期拉曝光时高发 | 避免词 banding, posterization |
| **热噪/死点（Hot Pixels）** | 长曝光画面里的固定亮点 | ★★★ 星空视频需注意 | 一般不写入提示词 |

> 一句话规则：**灰颗粒可以是风格，彩斑点永远是事故。**

---

## 五、视频特有的 ISO 问题（Agent 必须知道）

1. **暗光视频的降噪涂抹感**：相机/手机在高 ISO 下强制机内降噪，噪点没了但细节被涂抹成"水彩画"，人脸皮肤像塑料。AI 生成暗光画面时，过度"干净"反而假——**真实暗光素材应有轻微颗粒**，提示词可写 subtle natural grain 避免塑料感。
2. **噪点在视频中会"闪烁爬行"**：照片噪点是静止的，视频噪点逐帧随机跳动（俗称"噪点跳舞"）。AI 视频若生成噪点，要求 temporal consistency，可用 fine consistent film grain 约束，避免画面闪烁。
3. **动态范围与高光溢出（Clipped Highlights）**：高 ISO 下动态范围收窄，灯泡、车窗反光、天空等高光区域直接死白无细节（俗称"高光裁切"）。商业片要求保留高光细节（retained highlight detail / high dynamic range）；风格片则可主动利用过曝（blown-out highlights, dreamy overexposure）。
4. **暗部压死（Crushed Blacks）**：高 ISO 暗部噪点太脏，调色时直接把暗部压成纯黑以藏噪——电影感夜景的常见手法，提示词：crushed blacks, deep shadows with no detail。
5. **双原生 ISO 的启示**：电影机在暗光下也能保持干净，说明"暗光"与"颗粒"不必然绑定——提示词中暗光场景可以干净（candlelit scene, clean image）也可以颗粒（grainy low-light footage），取决于你要商业感还是纪实感。

---

## 六、创作意图 → 提示词关键词映射表（Agent 核心调用区）

> 规则：**提示词里不要直接写 ISO 数值**（模型无效），按本表翻译成画质气质语言。中英文都给，英文关键词对国际模型更有效。

### 6.1 干净通透方向（模拟 ISO 100–400）

| 创作意图 | 中文提示词写法 | 英文关键词 |
|---|---|---|
| 商业级干净画面 | 画面纯净无噪点，玻璃般通透 | clean image, pristine digital, noise-free |
| 细节锐利 | 细节丰富锐利，纹理清晰可见 | crisp details, sharp textures, high fidelity |
| 色彩纯净 | 色彩饱和干净，无色偏无彩斑 | clean colors, smooth color gradation |
| 高光细节保留 | 高光层次丰富不过曝，动态范围宽广 | high dynamic range, retained highlight detail |
| 丝滑暗部 | 暗部纯净平滑，无噪点无断层 | smooth shadows, clean blacks, no banding |

### 6.2 胶片颗粒方向（模拟"美化的高感"）

| 创作意图 | 中文提示词写法 | 英文关键词 |
|---|---|---|
| 电影胶片颗粒 | 细腻胶片颗粒，35mm 胶片质感 | film grain, 35mm film texture, subtle grain |
| 复古模拟味 | 模拟胶片噪点，复古胶片氛围 | analog noise, vintage film look, retro grain |
| 16mm 粗颗粒 | 粗糙 16mm 胶片颗粒，独立电影感 | coarse 16mm grain, indie film texture |
| 有机数字噪点 | 轻微有机噪点，画面呼吸感 | organic noise texture, natural grain |
| 柯达胶片感 | 柯达胶卷色调与颗粒，暖调颗粒 | Kodak film emulation, warm grain |

### 6.3 暗光噪点方向（模拟 ISO 3200+）

| 创作意图 | 中文提示词写法 | 英文关键词 |
|---|---|---|
| 暗光纪实噪点 | 暗光颗粒感，新闻纪实粗糙画质 | low light noise, gritty documentary texture |
| 监控录像质感 | 低保真噪点，监控摄像头画质 | surveillance footage look, low-fi noisy image |
| 手持夜景颗粒 | 手持夜景，高感颗粒与光斑共存 | handheld night footage, high ISO grain |
| 伪纪录片崩坏感 | 噪点闪烁，found footage 粗糙画质 | found footage noise, degraded video quality |
| 高反差夜景 | 暗部压死纯黑，高光溢出，强反差 | crushed blacks, clipped highlights, high contrast night |

### 6.4 负面词（负面提示词 / 规避项）

- 要干净时负面词：noise, grain, artifacts, color noise, banding, low quality
- 要颗粒时负面词：plastic skin, over-smoothed, watercolor smearing, digital noise (只用 film grain)

---

## 七、提示词模板（Agent 直接填空调用）

### 模板 A：商业级干净画面（ISO 100 气质）

```
[主体/产品描述]，[动作]，画面纯净无噪点，玻璃般通透，
细节锐利纹理清晰，[布光描述]，色彩饱和干净，高光层次丰富不过曝。
Clean image, pristine digital, noise-free, crisp details, high dynamic range.
```

示例：
> 一瓶香水在黑色大理石台面上缓缓旋转，画面纯净无噪点，玻璃般通透，瓶身切割面反射细节锐利清晰，三点柔光布光，色彩饱和干净，高光层次丰富不过曝。Clean image, pristine digital, noise-free, crisp details, high dynamic range, slow rotation.

### 模板 B：胶片颗粒氛围（film grain 加分）

```
[主体描述]，[动作/情绪]，35mm 胶片质感，细腻胶片颗粒覆盖画面，
[色调描述]，柔和反差，电影感，[运镜方式]。
35mm film texture, subtle film grain, cinematic, organic feel.
```

示例：
> 少女坐在窗边翻看旧照片，午后阳光洒在侧脸，35mm 胶片质感，细腻胶片颗粒覆盖画面，暖黄复古色调，柔和反差，电影感，镜头缓慢推近。35mm film texture, subtle film grain, warm vintage tones, cinematic, slow push-in.

### 模板 C：暗光纪实（ISO 3200+ 气质）

```
[场景描述]，手持跟拍[主体]，暗光颗粒感，新闻纪实粗糙画质，
现场光源照明，暗部压死保留氛围，画面粗粝真实。
Low light noise, gritty documentary texture, handheld, crushed blacks.
```

示例：
> 凌晨的急诊室走廊，手持跟拍一位奔跑的护士，暗光颗粒感，新闻纪实粗糙画质，只有头顶日光灯照明，暗部压死保留氛围，画面粗粝真实。Low light noise, gritty documentary texture, handheld tracking shot, crushed blacks.

### 模板 D：高反差夜景（clipped highlights + crushed blacks）

```
[夜景场景]，强烈明暗反差，霓虹灯光高光溢出成光晕，
暗部完全压死为纯黑，[主体]剪影/轮廓光勾勒，赛博/电影感。
High contrast night, clipped highlights, blown-out neon glow, crushed blacks.
```

示例：
> 雨夜的香港街头，强烈明暗反差，霓虹招牌高光溢出成彩色光晕，湿漉漉的地面反射灯光，暗部完全压死为纯黑，行人剪影穿行其间，赛博朋克电影感。High contrast night, clipped highlights, blown-out neon glow, crushed blacks, cyberpunk.

### 模板 E：低保真监控 / 伪纪录片（进阶风格）

```
[场景描述]，监控摄像头视角/手持 DV，低保真噪点闪烁，
画面粗糙颗粒，色彩偏色发灰，时间戳质感，found footage 风格。
Surveillance footage look, low-fi noisy image, degraded video quality, found footage.
```

---

## 八、意图 → ISO 氛围 → 提示词 决策流程（Agent 推理链）

```
用户意图
  │
  ├─ "高级/商业/产品/美妆，要干净" → 低感气质（ISO 100–400 效果）
  │     → 提示词：clean image + pristine digital + noise-free + high dynamic range
  │
  ├─ "电影感/复古/文艺/怀旧" → 胶片颗粒气质（美化高感）
  │     → 提示词：film grain + 35mm film texture + analog noise
  │
  ├─ "纪实/新闻/现场/粗粝真实" → 高感噪点气质（ISO 3200+ 效果）
  │     → 提示词：low light noise + gritty documentary + crushed blacks
  │
  ├─ "赛博夜景/霓虹/高反差" → 高感 + 高光溢出气质
  │     → 提示词：high contrast night + clipped highlights + blown-out glow
  │
  ├─ "监控/DV/伪纪录片/Y2K" → 扩展高感崩坏气质
  │     → 提示词：surveillance look + low-fi noise + found footage
  │
  └─ "暗光但要干净（电影机夜戏）" → 暗光低噪气质
        → 提示词：candlelit/night scene + clean image + subtle natural grain
```

---

## 九、常见误区与关联知识

### 9.1 常见误区（生成提示词时的纠错规则）

| 误区 | 纠正 |
|---|---|
| "噪点 = 废片" | 胶片颗粒是付费级美学；只有彩噪、涂抹、闪烁才是事故 |
| "ISO 越高画面越亮越好" | ISO 是拿画质换亮度，提亮的是噪点不是细节 |
| "ISO 数值写进提示词模型就懂" | 模型不认 ISO 6400，只认 grainy / clean 的画面描述 |
| "暗光画面一定要降噪到最干净" | 过度降噪 = 塑料皮肤水彩画；轻微颗粒才真实 |
| "颗粒和噪点是一回事" | 胶片颗粒细腻均匀单色；数码彩噪成块带斑点，观感天差地别 |
| "高 ISO 只影响噪点" | 还压缩动态范围，高光溢出、暗部死黑随之而来 |
| "夜景提示词写 night 就够了" | 不写画质气质，模型随机输出干净或脏，需显式指定 grain 方向 |

### 9.2 关联知识

- OPTICS-001 光圈（大光圈换低 ISO，浅景深与噪点控制的取舍）
- OPTICS-003 快门（快门速度换低 ISO，运动模糊与画质的取舍）
- LIGHT-003 夜景与人工光源（暗光场景的布光逻辑决定 ISO 压力）
- STYLE-001 影像风格谱系（胶片/纪实/商业风格与画质气质的对应关系）

> ISO 是曝光三角的最后一环：光圈与快门定生死，ISO 定气质。生成提示词时建议与 OPTICS-001、OPTICS-003 联合检索。
