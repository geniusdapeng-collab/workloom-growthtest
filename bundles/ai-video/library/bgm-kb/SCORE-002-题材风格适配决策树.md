# 题材风格适配决策树（Genre → Style → Instrumentation → BPM）配乐知识库

> **用途**：AI 视频生成系统的配乐知识库。供数字员工 / Agent 在为成片选配音乐时检索调用。
> **主题编号**：SCORE-002　**版本**：v1.0　**更新日期**：2026-09-27
> **使用方式**：Agent 接收到"给这条片子配乐/选 BGM/定音乐风格"等意图时，检索本主题，沿「题材 → 配方 → 调式/BPM → 配器 → 电平」的决策路径落到具体参数。本文全部结论以 `library/bgm-recipes/recipes.json`（32 条配方：16 既有 + T-15 新增 16）与 `connectors/bgm-bridge/`（brief.mjs / core.mjs / tag.mjs / synth.mjs）的真实机制为准，禁止脱离配方空谈乐理。

---

## 一、核心概念

### 1.1 配乐定调的第一原则

recipes.json 的开篇原则即本文纲领：

> **配乐先服从片子的调性：题材定风格、场景定配器、情绪定调式与力度；同一个项目只用一套配乐语言，平台变体从母版派生、不重新配乐。允许的结论包含「这片子不需要配乐」。**

对应到 SKILL.md 的**定调四问**（先答完再动手）：

1. **题材**（32 类：16 既有——产品广告/口播访谈/美食/科技/旅拍/夜景/美妆/亲子/汽车/房产/促销/纪录/高端品牌/剧情/悬疑/喜剧；T-15 新增——婚礼/体育/电竞/时尚/母婴/家居/新能源/财经/城市黄昏/节庆/科普/生活 vlog/情感故事/品牌宣言/宠物/健身）→ 决定风格族；
2. **场景与主体**（棚拍白底、室内半身、屏幕演示……）→ 决定配器厚薄：**主体越细，配器越薄**；
3. **情绪目标**（干净可信/冷静精密/不安张力……）→ 决定调式（mode）与力度；
4. **发哪个平台**（抖音/小红书/视频号/B站/YouTube）→ 决定高频亮度与低频收放量（手机外放约束）。

四问答不出时，先取一条最接近的配方，再说明"为什么是它、被否掉了谁"。

### 1.2 调式（mode）的情绪含义——配方库的实测用法

| 调式 | 情绪 | 在用配方（id） |
|---|---|---|
| **major（大调）** | 明亮、可信、有温度 | product-ad / interview / food / family / realestate / festival-promo / comedy-light + T-15：baby-family / home-decor / finance / festival-holiday / edu-explainer / vlog-daily / pets / workout |
| **aeolian（自然小调）** | 内敛、叙事、克制、现代感 | night-city / documentary / premium-brand / drama-story + T-15：esports / emotional-story |
| **dorian（多利亚）** | 冷静精密：小调底色 + 大六度的一点"亮"，不丧 | tech / auto + T-15：sports / fashion / auto-ev / city-dusk |
| **mixolydian（混合利底亚）** | 开阔、在路上、不甜腻（降七级去掉大调的"圆满感"） | travel + T-15：brand-manifesto |
| **lydian（利底亚）** | 通透、梦幻、"发光感"（升四级） | beauty + T-15：wedding |
| **phrygian（弗里吉亚）** | 不安、紧张（降二级贴主音，天然压迫） | suspense |

记忆口诀：**大调卖货、小调叙事、多利亚讲精密、弗里吉亚讲危险、利底亚讲通透、混合利底亚讲远方。**

### 1.3 BPM 档位与心率/剪辑节奏的关系

BPM 不是越快越"燃"，是**与身体节律对齐**：静息心率 60–80、从容语速与步行约 84–100、运动心率 120+。配方库的 16 个基准 BPM 正落在四个档上（与 tag.mjs `bpmBucketOf` 的 slow/mid/up/fast 分档一致：<80 slow、80–110 mid、110–135 up、≥135 fast）：

| 档位 | BPM | 身体感受 | 在用配方 |
|---|---|---|---|
| 叙事档（slow） | 68–76 | 时间变慢、留白、庄重 | drama-story 68 / premium-brand 72 / documentary 76 |
| 口播档（mid） | 84–96 | 不抢语速、松弛可信 | interview 84 / suspense 84 / realestate 88 / beauty 90 / night-city 92 / food 96 |
| 商业档（mid~up） | 100–112 | 推进感但不赶 | tech 100 / family 100 / travel 104 / product-ad 112 / comedy-light 112 |
| 高能档（up） | 118–128 | 快剪卡点、肾上腺素 | auto 118 / festival-promo 128 |

**同一项目只用一个速度**——"开场 128、正片 96"听着像两条片子拼的。配方 BPM 只是基准，真实速度还要看剪辑节奏：剪辑点反推值与配方 BPM 相对差 ≤25% 时采用反推值（`bpm_strategy=cut-driven`），否则沿用配方并说明冲突（详见 SCORE-003）。

### 1.4 常用和弦级数进行的情绪色彩

| 进行 | 色彩 | 在用配方 |
|---|---|---|
| **I–V–vi–IV** | 流行万能进行：听感"正确"、不抢注意力 | product-ad / travel |
| **I–vi–IV–V** | 经典 50s 进行：亲和、怀旧、可信 | interview / realestate |
| **I–IV–V–I** | 直接明亮、童谣感、无城府 | food / comedy-light |
| **I–V–IV–I** | 上扬回落、家庭式的圆满 | family |
| **I–V–I–V** | 反复冲刺、促销式紧迫 | festival-promo |
| **i–VI–III–VII** | 小调下行：叙事、史诗、命运感 | night-city / documentary / drama-story |
| **i–VII–VI–i / i–VII–VI–V** | 力量下行：硬朗、机械感 | premium-brand / auto |
| **i–II–i–VII** | 弗里吉亚进行：紧张逼近 | suspense |

---

## 二、分类速查

### 2.1 三十二配方全表（recipes.json 原始参数）

| id | 题材 | mode/key | BPM | 和弦 | 配器 | 电平 dB | ducking dB | 平台 |
|---|---|---|---|---|---|---|---|---|
| product-ad | 产品广告 | major C4 | 112 | I-V-vi-IV | pad pluck bass hat bell | -22 | 12 | 抖音/小红书/视频号/B站 |
| interview | 人物访谈/口播 | major F4 | 84 | I-vi-IV-V | pad bass pluck | -26 | 14 | all |
| food | 美食餐饮 | major G4 | 96 | I-IV-V-I | pluck pad bass bell | -22 | 12 | 抖音/小红书 |
| tech | 科技/SaaS | dorian A4 | 100 | i-IV-VI-v | pad bass hat bell | -25 | 12 | B站/视频号/YouTube |
| travel | 户外旅拍 | mixolydian D4 | 104 | I-V-vi-IV | pluck pad bass hat bell | -21 | 11 | 抖音/小红书/YouTube |
| night-city | 夜景都市 | aeolian E4 | 92 | i-VI-III-VII | pad bass hat bell | -24 | 12 | 抖音/B站 |
| beauty | 美妆护肤 | lydian A4 | 90 | I-IV-vi-V | bell pad bass | -26 | 13 | 小红书/抖音 |
| family | 亲子家庭 | major D4 | 100 | I-V-IV-I | pluck pad bass bell | -23 | 12 | 小红书/视频号 |
| auto | 汽车出行 | dorian B4 | 118 | i-VII-VI-V | pad bass kick hat bell | -20 | 10 | 抖音/B站/YouTube |
| realestate | 房产空间 | major C4 | 88 | I-vi-IV-V | pad pluck bass | -25 | 13 | 小红书/视频号 |
| festival-promo | 节日促销 | major E4 | 128 | I-V-I-V | pluck bass kick hat bell | -19 | 10 | 抖音/小红书 |
| documentary | 纪录片/科普 | aeolian G4 | 76 | i-VI-III-VII | pad bass | -27 | 14 | B站/YouTube |
| premium-brand | 高端品牌 | aeolian D4 | 72 | i-VII-VI-i | pad bass bell | -26 | 13 | 视频号/YouTube/B站 |
| drama-story | 叙事剧情片 | aeolian A4 | 68 | i-VI-III-VII | pad bass pluck | -25 | 13 | B站/YouTube |
| suspense | 悬疑紧张 | phrygian E4 | 84 | i-II-i-VII | pad bass hat | -24 | 12 | B站/抖音 |
| comedy-light | 喜剧轻综艺 | major C4 | 112 | I-IV-V-I | pluck bell bass hat | -22 | 11 | 抖音/B站 |
| wedding | 婚礼 / 誓言 | lydian D4 | 78 | I-IV-vi-V | pad bell pluck | -25 | 13 | xiaohongshu/wechat-channels/douyin |
| sports | 体育赛事 / 集锦 | dorian E4 | 132 | i-VII-VI-V | kick snare bass lead pad | -19 | 10 | douyin/bilibili/wechat-channels |
| esports | 电竞 / 游戏实况 | aeolian F4 | 140 | i-VI-III-VII | sub arp lead kick pad | -20 | 10 | douyin/bilibili |
| fashion | 时尚大片 / 走秀 | dorian A4 | 120 | i-IV-i-VII | bass hat pluck pad | -22 | 11 | xiaohongshu/douyin |
| baby-family | 母婴 / 育儿日常 | major G4 | 76 | I-vi-IV-V | bell pad bass | -26 | 13 | xiaohongshu/wechat-channels |
| home-decor | 家居 / 软装 | major G4 | 92 | I-V-vi-IV | pad pluck bass bell | -24 | 12 | xiaohongshu/wechat-channels |
| auto-ev | 新能源汽车 / 智能驾驶 | dorian A4 | 108 | i-IV-VI-v | pad sub bass hat bell | -22 | 11 | douyin/bilibili |
| finance | 金融财经 / 理财 | major F4 | 94 | I-vi-IV-V | pad pluck bass | -25 | 13 | wechat-channels/bilibili |
| city-dusk | 城市黄昏 / 蓝调时刻 | dorian G4 | 88 | i-VII-VI-VII | pad bass arp bell | -24 | 12 | douyin/xiaohongshu |
| festival-holiday | 节庆氛围 / 年货 | major D4 | 120 | I-IV-V-IV | pluck bell bass kick hat | -20 | 11 | douyin/xiaohongshu/wechat-channels |
| edu-explainer | 知识科普 /  explainer | major C4 | 92 | I-V-vi-IV | pad pluck bass | -26 | 14 | bilibili/wechat-channels/douyin |
| vlog-daily | vlog 日常 / 生活记录 | major E4 | 96 | I-vi-IV-V | pluck pad bass bell | -23 | 12 | xiaohongshu/douyin/bilibili |
| emotional-story | 情感故事 / 重逢告白 | aeolian C4 | 72 | i-VI-III-VII | pad bass bell | -25 | 13 | douyin/bilibili/xiaohongshu |
| brand-manifesto | 品牌宣言 / 使命 | mixolydian G4 | 96 | I-V-IV-I | pad bass bell riser | -23 | 12 | wechat-channels/bilibili/youtube |
| pets | 宠物 / 萌宠 | major D4 | 108 | I-IV-vi-V | pluck bell pad | -23 | 11 | douyin/xiaohongshu/bilibili |
| workout | 健身 / 训练 | major A4 | 128 | I-V-vi-IV | kick bass lead pad | -20 | 10 | douyin/bilibili/xiaohongshu |

### 2.2 电平与让位规律（SCORE-001 口径的配方侧投影）

- **musicLevelDb 三档**：促销/汽车 -19~-20（站前台）→ 广告/美食/喜剧 -22（背书位）→ 访谈/美妆/高端 -26、纪录 -27（铺底）。全表落在 targets 的 `musicLevelDbRange [-30, -16]` 内。
- **duckingDb 两档**：口播/纪录 13–14（取 targets `duckingDepthDb [8,14]` 上限）→ 广告/促销 10–12。口播是主角时宁可更深。

### 2.3 配器语言（synth.mjs 的实际声部）

synth.mjs 渲染层的角色定义（`composeToWav`）：**pad（情绪地基）/ bass（低频走向）/ pluck（推进感）/ kick·hat（主体段节拍）/ bell（点缀）**，另有扩展音色 sub（低频支撑）/ arp（十六分琶音）/ lead（super-saw 主音）/ snare / riser / impact。

| 声部 | 承担角色 | 什么题材加它 |
|---|---|---|
| pad | 情绪地基，能量主导声部（intensity^1.6 放大段落对比）；intro 段只留 pad+bass | 全部配方都有；纪录/高端几乎只剩它 |
| bass | 低频走向，托住和声；60Hz 以下的归属要防与内容声打架 | 全部配方；auto 需给引擎让低频 |
| pluck | 推进感，只在 body 段进入 | 广告/美食/亲子/旅拍/喜剧/房产——需要"往前推"的题材 |
| kick / hat | 节拍，kick 在 0/2 拍 | 只有 auto / festival-promo 默认带鼓；**口播类默认不进** |
| bell | 点缀，每 2 小节一次（body/breakdown 段） | 美妆/高端/家庭——"精致度"的听觉签名 |
| sub / arp / lead | 风格包专用（electronic-pulse、city-night、sports-hype） | 科技、电竞、运动、夜景 |

---

## 三、分场景实战（32 条配方逐条解读：16 既有 + T-15 新增 16）

**product-ad（产品广告）**：major/C4/112 + I-V-vi-IV 是"商业正确感"的最小风险组合——卖点靠口播，配乐只做「精致度」背书。112 BPM 推进不赶；avoid「低频轰鸣」因为白底棚拍片低频一重就显脏。notes 要点：主体段可给 pluck 推进，落版前留 1 拍空（logo 不被音乐糊住）。

**interview（人物访谈/口播）**：电平 -26、ducking 14 取全库最深——口播是主角，宁可让 BGM 更轻。avoid「打击乐（易抢字）」的道理：鼓点起音与人声辅音同处瞬态频段，hat 的 8 分打点会切碎句读；「在句尾强行收束」会跟受访者的话抢气口。84 BPM 对齐从容语速。

**food（美食）**：major/G4 + I-IV-V-I 走暖走疏。avoid「过冷调式」与调色同理——冷色抑制食欲，冷调式败胃口；「过密音符盖住咀嚼声」因为现场声（锅气、咀嚼）本身就是内容。

**tech（科技/SaaS）**：唯一用 dorian 讲"冷静精密"的配方（小调底色 + 大六度的亮，不丧）。不配 pluck 旋律——屏幕演示段留白优先，只用低频脉冲与稀疏点缀；avoid「抒情式弦乐/大幅情绪起伏」，精密感来自稳定脉冲而非煽情。

**travel（旅拍）**：全库唯一 mixolydian——降七级去掉大调的"圆满甜腻"，留下"在路上"的开阔。-21 dB 是空镜允许 BGM 站前台的电平；一旦出现现场同期声（海浪/街声）立刻让位。avoid「情绪与画面（晴天/阴天）不符」：旅拍天气是情绪的事实源。

**night-city（夜景都市）**：aeolian/E4/92，低音走心、高频克制。avoid「甜美化」（霓虹是欲望不是糖果）与「高频刺耳」（手机外放夜景片高频刺是重灾区）；有人声旁白时必须 ducking 到每个字清晰。

**beauty（美妆）**：全库唯一 lydian——升四级的"通透发光感"正对"肤质变好"的暗示。配器最薄（bell+pad+bass），avoid「厚重低音/密集打击」：要点在「轻」，低频几乎只留一层薄垫。

**family（亲子家庭）**：major/D4/100，明亮有温度；avoid「过暗调式/紧张感」。notes 的硬规则：孩子笑声/说话声要能透出来——主体段把 pluck 音量再降 2 dB。

**auto（汽车）**：dorian/B4/118 + i-VII-VI-V 力量下行，全库唯二带 kick 的配方、电平 -20 站前台。avoid 两条都关于"车才是主角"：「引擎声与低频打架」→ 60Hz 以下留给车；「节奏与换挡点错位」→ 卡点对齐换挡与镜头切换。

**realestate（房产）**：major/C4/88 + pad/pluck/bass（无鼓无铃），讲解贯穿全片、BGM 只做空间感。avoid「与讲解语速抢拍」：88 BPM 迁就户型讲解语速；「走廊长镜不加速」——空间片的稳，比推进重要。

**festival-promo（节日促销）**：全库最快 128 BPM + I-V-I-V 反复冲刺 + 最响 -19 dB。avoid「价格口播被鼓点压住」→ 报价/期限两处必须留 ducking 窗口；「结尾不干净」→ 促销片尾要利落落版。

**documentary（纪录片）**：最轻 -27 dB、最深 ducking 14、配器最少（pad+bass）。avoid「情绪操纵」是纪录伦理——现场声与采访是事实源，配乐只在转场与空镜承担情绪。

**premium-brand（高端品牌）**：最慢 72 BPM。avoid「促销式鼓点/过亮高频」——留白就是质感，宁少不多，尾奏自然收不做硬切。

**drama-story（剧情片）**：68 BPM 跟情绪弧线走。avoid「情绪提前给满」——铺垫段只留 pad，转折处才让人声之外有第二层信息；「与台词争夺句读」同访谈纪律。

**suspense（悬疑）**：全库唯一 phrygian——降二级贴主音的压迫感即"不安"的声学定义。张力靠低频与稀疏脉冲；avoid「节奏过早开始」，揭示前留半拍静默比加音量更有效。

**comedy-light（喜剧）**：major/C4/112 + I-IV-V-I 童谣式进行。笑点靠留白：punchline 前后各留 0.5 拍，avoid「在笑点前压过台词」——别用音乐替观众笑。

### 3.1 T-15 新增 16 条逐条速读（参数以 recipes.json 为准）

**wedding（婚礼）**：lydian/D4/78 + I-IV-vi-V，"发光感"替代进行曲俗套（avoid 两条正是这个意思）。誓词/交换戒指两段是内容声主体，ducking 窗口对齐司仪停顿；first look 与拥吻两个高点前各留 1 拍空，bell 只在高点后点。

**sports（体育）**：dorian/E4/132 + i-VII-VI-V，全库最快的燃向档之一。解说与哨声是内容声：进球/绝杀瞬间允许 BGM 站前台 2 秒内，解说恢复立即让位；慢镜头撤 lead 只留 pad+bass，快切回比赛再进鼓。

**esports（电竞）**：aeolian/F4/140（全库最快）。技能音效与击杀提示音是操作反馈：sub 低频限 60Hz 以上不抢音效，团战高潮对齐 lead 进入点；阵亡/回放段撤 kick 只留 arp 铺底。

**fashion（时尚）**：dorian/A4/120，hat 八分打点必须对齐台步/剪辑点（剪辑点反推 BPM 优先于配方基准）。转身/定格给 1 拍空，pluck 只在换装后进——"旋律过满抢步频"是这类片最常见的错。

**baby-family（母婴）**：major/G4/76，八音盒质感 bell 每 2 小节一次。婴儿笑声必须透出，哭闹段 BGM 整体再降 2dB 或直接让位；强鼓与突发高频会制造惊扰感，一律 avoid。

**home-decor（家居）**：major/G4/92。before/after 对比点是结构锚：揭示前留半拍、揭示处 bell 点一下；漫游长镜保持速度不加速，收纳快剪段才允许 pluck 加密。

**auto-ev（新能源）**：dorian/A4/108。电车没有引擎声可借——精密感靠 sub 脉冲与稀疏 hat，不靠轰鸣；NOA/泊车演示段是讲解内容声，hat 减半、bell 暂停。

**finance（财经）**：major/F4/94，ducking 取上限。收益率/风险两处口播必须每字清晰；涨跌情绪不靠音乐渲染，pluck 只做推进不做煽情（avoid 促销式鼓点与轻佻铃音）。

**city-dusk（城市黄昏）**：dorian/G4/88，arp 走十六分但音量压在 pad 之下。蓝调时刻只有 20 分钟窗口、画面即情绪；入夜转场的路灯亮起镜头允许 bell 进一次，之后回归铺底。

**festival-holiday（节庆）**：major/D4/120 + I-IV-V-IV。跨年倒数 10 秒必须整体让位只留 pad，倒数结束钟声处 kick+bell 全进；市集环境声（叫卖/人群）保留不盖，结尾要收干净。

**edu-explainer（科普）**：major/C4/92、ducking 14 取上限（同 interview 纪律）。"原来如此"揭示点前留半拍静默，pluck 只进图解动画段，纯口播段退回 pad+bass——任何抢字的音符密度都是错的。

**vlog-daily（生活 vlog）**：major/E4/96。环境同期声（咖啡机/街道/键盘）是日常质感来源，保留并让 BGM 走疏；碎碎念口播段 pluck 降 2dB，空镜段允许恢复到配方电平。

**emotional-story（情感故事）**：aeolian/C4/72。泪点靠积攒不靠催：闪回段只留 pad，重逢/告白台词说完才进 bell；拥抱定格允许 BGM 站前台 3 秒内，之后淡出不留尾。

**brand-manifesto（品牌宣言）**：mixolydian/G4/96。旁白文案是主体：前 1/3 只留 pad+bass，riser 只在品牌名揭示前 2 秒进入；slogan 落版处留 1 拍空，落版后 bell 收尾不硬切。

**pets（宠物）**：major/D4/108。宠物叫声与现场反应声是内容声，叫声处让位；歪头/扑空等萌点前留 0.5 拍，bell 对齐萌点点缀而不铺满全片（低频轰鸣与突发高频都 avoid）。

**workout（健身）**：major/A4/128。动作节拍是锚：kick 对齐发力点，组间休息撤 lead 只留 kick+bass；跟练口令是内容声，口令出现处 ducking 必须让字清晰。

---

## 四、视频特有规则（brief 解析与打分机制）

1. **关键词 → 题材命中（brief.mjs `GENRE_KEYWORDS`）**：16 条中英双语正则表，**顺序即优先级**；命中多个时取 `genreHits[0]` 为主题材、其余进 `alternatives`（最多 3 个）。显式 `recipeHint` 合法时直接覆盖词表命中。
2. **情绪修饰（`ENERGY_KEYWORDS`）**：hyped（bpmScale 1.18）/ playful（1.08）/ premium（0.94）/ calm（0.86）/ tense（1.0）。多个冲突时按 `hyped > tense > playful > calm > premium` 取"对配乐影响最大"的一个，防止"紧张又治愈"把力度抹平。
3. **策略词（`POLICY_KEYWORDS`）**：不要音乐 → `noMusic`（policy=none）；保留现场声 → keep-all 分层；不要鼓点 → avoid 加 kick/hat；音乐要轻/要突出 → 电平 ∓3 dB。
4. **高潮落点（`CLIMAX_KEYWORDS`）**：结尾反转 → 85% 处；黄金三秒 → 8% 处；中段爆发 → 50% 处；乘以 durationSec 得 `climax.atSec`，是选段对齐的依据。
5. **置信度诚实**：单一题材命中 + 有能量或高潮线索 = high；有题材 = medium；**未命中题材 = low，不硬编题材**，退回"按片子自身能量与结构选曲"。
6. **打分口径（`scoreTrackAgainstBrief`，在线源与本地曲库同一把尺子）**：六维、总分恒为 100——题材 38（带弧线偏好输入时 36）+ 能量 18/17（目标 high 0.8 / medium 0.55 / low 0.3，距离折算）+ BPM 18/17（目标 = 配方 bpm × bpmScale，相对差折算）+ 时长 9/8 + 结构 7 + 调性相容 10（另有弧线偏好 5）；总分 ≥55 判 ok，否则 weak。
7. **T-05 题材未命中负分降权（2026-09-27 落地）**：题材维度是**双向量**——配方 genre 全命中 +38/36、题材标签命中 ×0.75、**同族相邻 +15**、**完全未命中 −30**；`genre_mismatch_policy=veto` 时未命中直接出局（`verdict=rejected`，候选全出局即按三级兜底降级，绝不强行出片）。**无题材线索**（brief 没有 recipeId）时题材项给基准分（`weights.genre/2`，即 19/18），不惩罚也不奖励，由能量/BPM/结构决定胜负。正反例词同步生效：人文/口播文本里的"运动会"不再判 sports（`GENRE_KEYWORDS[].anti`，压制事实写进 `matched.suppressedGenres`）。
8. **禁忌一票否决**：曲目的 instrumentation 命中 brief 的 avoid 清单（如"不要鼓点"后含 kick/hat），直接 `score: 0, verdict: rejected`，不参与排序——禁忌优先级高于一切分数。

> **已落地（T-23，2026-09-27）**：打分口径扩为六维并再分配权重，总分恒为 100。无弧线偏好输入时：题材 38 + 能量 18 + BPM 18 + 时长 9 + 结构 7 + **调性相容 10**；有弧线偏好输入时：题材 36 + 能量 17 + BPM 17 + 时长 8 + 结构 7 + 调性 10 + 弧线偏好 5（弧线分从调性以外的既有维度协调）。**调性相容**：曲目 `key:/mode:` 标签 vs 配方 `key/mode`——同调 +10、关系大小调（大调 +9 半音 ↔ 关系小调）与五度圈相邻（半音距离 5/7 且同调式族）+6、中性（纯打击/氛围类配器，或无冲突音程）+3、冲突调性（小二度/三全音，按音程级上下行等价）-5；曲目无调性标签记 0 并在 reason 注明"不参与调性评分"，不惩罚。实现：`brief.mjs` 的 `NOTE_TO_PC`/`MAJOR_FAMILY`/`MINOR_FAMILY`/`CONFLICT_INTERVALS`/`FIFTH_INTERVALS` 常量与 `scoreTrackAgainstBrief` 调性段。

### 4.1 风格族 ↔ 配方映射（tag.mjs `classifyStyle` 与 synth.mjs `STYLE_PACKS`）

曲库实测风格族共 **12 个**（tag.mjs `STYLE_FAMILIES`，与 synth.mjs 12 个风格包同名——外部曲与自算曲同一套名字，在线/本地/自算三级兜底可互相替代）。裁决规则：特征分 = BPM 命中 26 + 能量命中 24 + 动态命中 16；**目录先验命中 +45**；特征要推翻先验须领先第二名 **≥12 分**，否则保留目录风格并降置信度。映射表：

| 风格族（BPM 区间） | 对应配方 | 依据 |
|---|---|---|
| modern-pop（95–125） | product-ad 112 / comedy-light 112 | 商业中速 + 鼓组副旋律 |
| corporate-clean（92–126） | interview 84（商务口播）/ product-ad | 明亮克制、无打击（synth 包已撤 hat） |
| electronic-pulse（118–145） | auto 118 / tech 100（偏下限）/ festival-promo 128 | 泵感 + 律动，卡点题材 |
| acoustic-warm（68–112） | travel 104 / family 100 | 原声温暖、旅拍家庭默认落点 |
| lo-fi-chill（68–96） | beauty 90 / 生活方式片 | 松弛、暖底噪 |
| ambient-calm（48–82） | premium-brand 72（低能量面） | 无鼓铺底 |
| cinematic-build（58–112） | drama-story 68 / documentary 76 / premium-brand 72 | 情绪爬升 + 编制加厚 |
| tension-dark（58–104） | suspense 84 | 低音压迫 + 悬念 |
| sports-hype（120–168） | festival-promo 128（燃向）/ sports 132 / esports 140 / workout 128（T-15 新增） | 强节奏 + 冲击 |
| festive-bright（102–142） | comedy-light 112 / festival-promo 128 | 欢快上扬 |
| documentary-bed（56–102） | documentary 76 / interview 84 | 不抢话的铺底 |
| city-night（76–118） | night-city 92 | 霓虹律动、低频 + 琶音 |

曲库实测风格与配方 BPM 全部互相落在对方区间内（如 night-city 92 ∈ city-night [76,118]、auto 118 ∈ electronic-pulse [118,145]），选曲时可用风格族做第一道检索、再按打分口径定胜负。

---

## 五、常见误区

| 误区 | 纠正 |
|---|---|
| "配乐越快越燃，燃片就往 140+ 拉" | 全库最快才 128（festival-promo）。BPM 对齐身体节律，超过题材档位只剩"吵"。hyped 修饰也只给 bpmScale 1.18，不是翻倍 |
| "题材拿不准就编一个最像的" | brief 的纪律是**不硬编题材**：未命中给低置信，退回按能量与结构选曲；打分在"无题材线索"时给基准分（`weights.genre/2`），**有题材线索而未命中则 −30**（T-05 口径） |
| "大调 = 开心、小调 = 伤心" | 配方库里 aeolian 承担的是"内敛/叙事/克制"（night-city、premium-brand），不是悲伤；dorian 甚至是"精密"。按配方情绪目标选，不按大小调字面选 |
| "鼓点能提气，哪条片都加点" | 32 条配方里默认带 kick 的是 auto / festival-promo / sports / esports / workout / festival-holiday（其余靠风格包 drum 强度）；口播片进鼓即违反 avoid（打击乐易抢字），且打分层面对"不要鼓点"的 brief 是一票否决 |
| "一个项目换着曲子配，丰富" | 原则明文：同一项目只用一套配乐语言（调性/配器一致），平台变体从母版派生、不重新配乐 |
| "高潮就是把音乐推响" | 不许把音乐高潮对到台词最响处；揭示/笑点/报价前该留白就留白（suspense 半拍静默、comedy 前后 0.5 拍） |
| "配乐能掩盖素材问题" | 对白削波、底噪过大要如实上报，不用音乐盖过去；素材疑似已有连续配乐或现场声即内容时，结论可以是「不配」（见 SCORE-006） |
| "目录叫什么风格就信什么" | 目录先验 +45 分只是先验；特征领先 ≥12 分即推翻，冲突会写进证据 sidecar 供复核 |

---

## 六、意图→参数映射表（Agent 核心调用区）

| 创作意图 | 中文写法 | 英文关键词/参数 |
|---|---|---|
| 产品广告干净可信 | 配方 product-ad：major C4，112 BPM，pad+pluck+bass+hat+bell，-22 dB | recipe=product-ad, mode=major, bpm=112, level=-22dB, ducking=12dB |
| 口播访谈不抢字 | 配方 interview：major F4，84 BPM，pad+bass+pluck（无鼓），-26 dB | recipe=interview, bpm=84, no drums, ducking=14dB |
| 美食诱人温暖 | 配方 food：major G4，96 BPM，pluck+pad+bass+bell，保留现场声 | recipe=food, bpm=96, keep ambience, level=-22dB |
| 科技冷静精密 | 配方 tech：dorian A4，100 BPM，pad+bass+hat+bell，无抒情弦乐 | recipe=tech, mode=dorian, bpm=100, subtle pulse |
| 旅拍开阔通透 | 配方 travel：mixolydian D4，104 BPM，空镜 BGM 可站前台 -21 dB | recipe=travel, mode=mixolydian, bpm=104, open airy |
| 夜景都市戏剧感 | 配方 night-city：aeolian E4，92 BPM，低音走心高频克制 | recipe=night-city, mode=aeolian, bpm=92, style=city-night |
| 美妆通透发光 | 配方 beauty：lydian A4，90 BPM，bell+pad+bass 最薄配器 | recipe=beauty, mode=lydian, bpm=90, light and airy |
| 亲子明亮有温度 | 配方 family：major D4，100 BPM，主体段 pluck 再降 2 dB | recipe=family, bpm=100, warm pluck, level=-23dB |
| 汽车强劲卡点 | 配方 auto：dorian B4，118 BPM，带 kick，60Hz 以下留给引擎 | recipe=auto, bpm=118, kick, cut-driven alignment |
| 房产明亮通透 | 配方 realestate：major C4，88 BPM，pad+pluck+bass，不抢讲解 | recipe=realestate, bpm=88, no percussion, ducking=13dB |
| 促销热烈紧迫 | 配方 festival-promo：major E4，128 BPM，报价处留 ducking 窗口 | recipe=festival-promo, bpm=128, level=-19dB, ducking windows at price lines |
| 纪录真实克制 | 配方 documentary：aeolian G4，76 BPM，pad+bass only，-27 dB | recipe=documentary, bpm=76, pad+bass only, level=-27dB |
| 高端品牌留白 | 配方 premium-brand：aeolian D4，72 BPM，尾奏自然收 | recipe=premium-brand, bpm=72, minimal, no hard cut |
| 剧情情绪推进 | 配方 drama-story：aeolian A4，68 BPM，铺垫段只留 pad | recipe=drama-story, bpm=68, pad in buildup, arc-driven |
| 悬疑不安张力 | 配方 suspense：phrygian E4，84 BPM，揭示前半拍静默 | recipe=suspense, mode=phrygian, bpm=84, half-beat silence before reveal |
| 喜剧轻快留白 | 配方 comedy-light：major C4，112 BPM，punchline 前后各留 0.5 拍 | recipe=comedy-light, bpm=112, space around punchlines |
| 要更燃 | 在配方 BPM 上乘 bpmScale 1.18，电平 +3 dB，prefer kick/hat/bass | energy=hyped, bpmScale=1.18, levelDelta=+3dB |
| 要更治愈 | bpmScale 0.86，电平 -3 dB，去 kick，prefer pad/bell | energy=calm, bpmScale=0.86, levelDelta=-3dB, avoid kick |
| 不要配乐 | 判定 noMusic，policy=none，不产出文件 | policy=none, noMusic=true（见 SCORE-006） |

---

## 七、模板

### 模板 A：配乐选型说明（输出契约，四问必答）

```
题材：[16 题材之一]　场景/主体：[棚拍白底 / 室内半身 / …]　情绪目标：[干净可信 / …]　平台：[douyin / …]
配方 id：product-ad　调性/调式：C4 major　BPM：112（依据：配方基准 / 剪辑点反推，相对差 ≤25% 取反推值）
配器：pad pluck bass hat bell（无 kick）　配乐电平：-22 dB　让位深度：12 dB
被否掉的候选：[interview——本片有明确卖点展示而非纯口播 / …]
```

### 模板 B：brief 命中回执解读

```
提示词："夜幕下的城市霓虹，主角在雨中奔跑，结尾反转揭晓，快剪高能"
→ recipeId=night-city（命中 夜景/霓虹/city/night）；energy=hyped（快剪高能）→ bpmScale=1.18，
  目标 BPM = 92 × 1.18 ≈ 109；climax=end → atSec = 片长 × 0.85；
  energyLevel=high → prefer kick/hat/bass；confidence=high（题材+能量+高潮三线命中）
```

### 模板 C：新配方设计卡（T-15 扩库用）

```
id：[kebab-case]　genre：[题材]　scene：[典型画面]　mood：[两字+两字情绪]
mode/key：[按 §1.2 调式表选]　bpm：[按 §1.3 档位选]　chords：[4 级数循环]
instrumentation：[pad 必有，其余按"主体越细配器越薄"]　musicLevelDb / duckingDb：[按 §2.2 两档规律]
platforms / avoid / notes：[avoid 必须是"可执行的反例"，notes 写明内容声与 BGM 的边界]
```

### 模板 D：T-15 扩库方向（新增 ≥14 条的设计依据）

> 房产/汽车/夜景/节庆/亲子已有基础配方（realestate/auto/night-city/festival-promo/family），T-15 对其做**子场景细化**而非重复建设；以下为净新增方向。

| 拟新增 id | 题材 | mode/key | BPM | 配器倾向 | 电平/ducking | 核心 avoid |
|---|---|---|---|---|---|---|
| wedding | 婚礼 | lydian D4 | 78 | pad bell pluck（弦乐质感） | -25/13 | 压誓言与誓词、进行曲式俗套 |
| sports | 体育赛事/集锦 | dorian E4 | 132 | kick snare bass lead pad（sports-hype） | -19/10 | 解说被鼓点压、高潮对到慢镜头 |
| esports | 电竞 | aeolian F4 | 140 | sub arp lead kick（electronic-pulse） | -20/10 | 甜美旋律、低频盖游戏音效 |
| fashion | 时尚走秀 | dorian A4 | 120 | bass hat pluck pad（极简律动） | -22/11 | 旋律过满抢台步节奏 |
| maternity | 母婴 | major G4 | 76 | bell pad（八音盒质感） | -26/13 | 强鼓、突发高频惊扰感 |
| finance | 金融/理财 | major F4 | 94 | pad pluck bass（corporate-clean） | -25/13 | 促销式鼓点、轻佻铃音 |
| education | 教育课程 | major C4 | 92 | pad pluck bass | -26/14 | 任何抢字的密度 |
| pets | 宠物 | major D4 | 108 | pluck bell pad（playful） | -23/11 | 低频轰鸣（宠物片高频灵动为主） |
| workout | 健身 | major A4 | 128 | kick bass lead（sports-hype 下限） | -20/10 | 节奏与动作组数错位 |
| cafe-life | 咖啡/生活方式 | major E4 | 82 | pad pluck bass（lo-fi 取向） | -25/12 | 鼓组过重破坏松弛感 |
| rural | 三农/乡村 | mixolydian G4 | 92 | pluck pad bass（原声） | -23/12 | 电子音色、城市感律动 |
| game-highlight | 游戏集锦 | aeolian E4 | 136 | sub arp kick hat | -20/10 | 盖游戏内关键音效 |
| launch-event | 发布会/年会 | major D4 | 104 | pad bass bell riser impact（cinematic-build） | -22/12 | 开场即满、尾段硬切 |
| charity | 公益/慈善 | aeolian C4 | 72 | pad bell bass | -26/13 | 煽情过度、情绪操纵（同纪录伦理） |

> **T-15 已落地（2026-09-27）**：recipes.json 扩至 32 条（16 既有 + 16 新增），brief.mjs 词表与 core.mjs 平台差异参数同步接入，测试口径见 `connectors/bgm-bridge/recipes-expansion.test.ts`。
> 实际新增配方 id（与上表设计一一对应，部分按"子场景细化"改名/调参）：
> `wedding`（婚礼）、`sports`（体育赛事，douyin/bilibili 覆盖）、`esports`（电竞，douyin 覆盖）、`fashion`（时尚大片，xiaohongshu 覆盖）、`baby-family`（母婴，上表 maternity）、`home-decor`（家居软装，realestate 子场景）、`auto-ev`（新能源智驾，auto 子场景）、`finance`（金融财经，wechat-channels 覆盖）、`city-dusk`（城市黄昏蓝调，night-city 子场景）、`festival-holiday`（节庆年货，festival-promo 子场景，douyin 覆盖）、`edu-explainer`（知识科普，bilibili 覆盖）、`vlog-daily`（vlog 日常）、`emotional-story`（情感故事，drama-story 子场景）、`brand-manifesto`（品牌宣言，premium-brand 子场景）、`pets`（宠物）、`workout`（健身，douyin 覆盖）。
> 平台差异参数结构化：7 条新配方带 `platformOverrides`（允许覆盖 musicLevelDb/duckingDb/lufsTarget），由 core.mjs `applyPlatformOverrides` 在带平台上下文时生效；pets/workout 按上表落地，launch-event/charity 两个方向留待后续扩库。

---

## 八、决策树（题材 + 情绪 + 平台 → 配方选择 → 参数确认）

```
用户意图 / 渲染提示词
  │
  ├─ ① 跑 bgmread.brief（关键词表命中）
  │     ├─ 命中题材 → recipeId = genreHits[0]（顺序即优先级；recipeHint 可显式覆盖）
  │     ├─ 未命中 → confidence=low：不硬编题材，退回按能量/结构选曲（无题材线索时题材项给基准分 weights.genre/2；有线索未命中则 −30，T-05 口径）
  │     └─ 命中"不要音乐" → 输出「无需配乐」（policy=none，见 SCORE-006）
  │
  ├─ ② 情绪修饰调参（取最具体的一个：hyped > tense > playful > calm > premium）
  │     ├─ 燃/快剪 → 目标 BPM = 配方 BPM × 1.18，电平 +3 dB，prefer kick/hat/bass
  │     ├─ 治愈/舒缓 → × 0.86，电平 -3 dB，avoid kick
  │     ├─ 克制/高级 → × 0.94，电平 -2 dB
  │     └─ 轻快/俏皮 → × 1.08
  │
  ├─ ③ 禁忌过滤（一票否决，先于任何分数）
  │     ├─ "不要鼓点" → 候选含 kick/hat 直接 rejected
  │     └─ 配方 avoid 逐条核对（口播避打击乐、auto 避低频打架、suspense 避过早进节奏……）
  │
  ├─ ④ 选曲打分（题材 40 + 能量 20 + BPM 20 + 时长 10 + 结构 10，≥55 判 ok）
  │     ├─ 在线源优先 → 失败回退本地曲库（同一打分口径）
  │     └─ 本地曲库风格族经 classifyStyle 实测：BPM26+能量24+动态16，目录先验 45，推翻需领先 ≥12 分
  │
  ├─ ⑤ 参数确认（回执必答）
  │     ├─ BPM：配方基准 vs 剪辑点反推，相对差 ≤25% 取反推（bpm_strategy=cut-driven）
  │     ├─ 高潮落点：结尾 85% / 开场 8% / 中段 50%，选段能量峰对齐 filmPeak
  │     ├─ 电平：配方 musicLevelDb ± brief 的 levelDelta（±3 dB）
  │     └─ 平台：手机外放平台（抖音/小红书）高频克制、低频收；长视频平台（B站/YouTube）允许更宽动态
  │
  └─ ⑥ 选不出来的诚实出口
        ├─ 无安全窗口 / 现场声即内容 → 报「无需配乐」并给依据（SCORE-006）
        └─ 高潮识别不到 → 不硬对，取代表性段落从片头铺，回执写明 skipped
```

---

## 九、关联知识

- **SCORE-001 电平与响度口径**（-14 LUFS 目标、真峰值 ≤-1 dBTP、人声-音乐余量 ≥6 dB、ducking 深度 [8,14] dB）——本文 musicLevelDb/duckingDb 的测量基准，配乐参数落地前必须先统一电平口径。
- **SCORE-003 卡点与选段对齐**（剪辑点反推 BPM、落拍误差 ≤80ms、filmPeakAlign、结构边界吸附）——本文 §1.3「剪辑节奏优先」与第八章第⑤步的执行细节。
- **SCORE-006 允许不配**（已有连续配乐 / 无安全窗口 / 现场声即内容三类"不产出"判据）——本文决策树第①/⑥步的出口依据。
- **COLOR-001 色调与配色**——音乐调式与画面色调共用同一套情绪语言（暖调 ↔ major、冷调 ↔ aeolian/dorian、霓虹 ↔ city-night），联合检索保证声画气质一致。
- **CGRADE-004 题材调色美学**——题材维度的画面侧对照表；其 T-14 扩库与本文 T-15 扩库互为声画两翼。
- 机制源码：`connectors/bgm-bridge/brief.mjs`（关键词表与打分）、`core.mjs`（在线/本地两通道调用打分）、`tag.mjs`（风格族裁决与曲库打标）、`synth.mjs`（12 风格包与配器渲染）。

> 题材拿不准时宁可低置信退回能量选曲，也不硬编；配乐的全部判断都要能写进回执复核——这是本知识库与配乐工位共用的纪律。
