# ACCT-001 账号定位到视觉锤
> 版本 v1.0 · 2026-09-27 · 适用链路：视频封面设计（cover-designer 岗位）

## 一、核心概念

视觉锤（Visual Hammer）= 账号封面系统中"一眼可识别"的固定视觉资产组合。同一账号的封面必须"长一个样"，原因有三：

1. **主页网格整体观感**：用户从单条视频点进主页后，视线 0.5–1 秒扫过前 6–9 个封面。版式、字体、色板统一的账号被感知为"专业、有体系、值得关注"；风格杂乱的账号被感知为"搬运号/随手拍"，关注转化率可差 2–3 倍。
2. **粉丝识别成本**：信息流是高速滑动场景，粉丝认出"这是你"靠的不是头像和昵称，而是封面的字体、配色、构图惯性。识别成本每降一分，老粉完播与互动就抬一分。
3. **算法账号标签**：推荐系统对账号做"内容标签+视觉标签"双重建模。长期稳定的封面视觉结构（同类构图、同类色彩分布）会强化账号标签纯度，使推流人群更精准；风格漂移会稀释标签，导致流量泛化、点击率下滑。

视觉锤不是审美偏好，是资产。锁定之后，所有封面设计动作必须先过视觉锤校验，再谈创意。

## 二、分类速查

五类账号的一致性策略：

| 账号类型 | 封面一致性策略 | 字体色板策略 | archetype 偏好 | 禁忌 |
|---|---|---|---|---|
| 人设IP号 | 固定人物+固定景别（胸像/半身）+固定机位光位 | 高对比个人代表色；字体四选一后终身锁定 | person-led | 频繁换装换场景导致"脸不熟"；偶尔用无人封面打破惯性 |
| 品牌官号 | VI 规范优先：固定 logo 角标位、品牌色压边条 | 品牌 VI 色作主标题/强调色；source-han-heavy 优先 | subject-led（产品/场景满幅） | 用网感花字破坏品牌感；人物出镜抢产品主体 |
| 种草号 | 产品满幅"货架感"：统一构图（居中/45°/俯拍平铺）+统一滤镜 | 暖调或奶油调一套色板轮换；zcool-qingke | subject-led | 混入生活随手拍；一图多产品堆叠 |
| 知识号 | 讲师半身（person-led）或图表满幅（subject-led），二选一后系列内不变 | 冷调理性色板；source-han-heavy 或 noto-serif | 两者皆可，账号级须锁定一种 | 今天讲师明天插画后天截图，版式漂移 |
| 本地生活号 | 门头/招牌菜/地标三选一作固定主体 | 高饱和食欲色系；smiley-sans | subject-led | 字体每周换；用与品类无关的网红滤镜 |

## 三、分场景实战

### 场景 A：新账号冷启动（0–30 条）
- 第 1–3 条：定视觉锤四件套（见第四章），允许微调，不允许推翻。
- 第 4–30 条：四件套零改动执行，只换底图与标题文案。
- 第 30 条复盘：看主页截图整体观感+单条 CTR 对比，最多改一个变量（如只换强调色）。
- 冷启动期 strict 建议设 true，强制校验，防止"这条想试试别的风格"。

### 场景 B：老账号改版
- 粉丝 <1 万：可一夜全换，损失可控。
- 粉丝 1–10 万：渐进替换——新系列先用新锤，旧内容不动，过渡期用角标区分新旧。
- 粉丝 >10 万：只改色板/角标，不动字体与 archetype；或开新栏目承接新视觉，主栏目维持旧锤。

### 场景 C：多平台分发
- 同一视觉锤跨平台保留三要素不动：字体、主标题色、archetype。
- 仅按平台微调：标题字数（主标题 ≤12 字，小红书 ≤14、B站 ≤16）、色板饱和度（快手降精致度、YouTube 提对比，详见 THEME-002）。

## 四、参数速查（核心调用区）

### 视觉锤四件套（锁定后所有封面必须遵守）
| 件 | 字段 | 取值口径 | 示例 |
|---|---|---|---|
| 锁定字体 | font_id | 白名单四选一：smiley-sans / source-han-heavy / zcool-qingke / noto-serif | source-han-heavy |
| 锁定色板 | palette.title_color / palette.accent_color | 主标题色+强调色各 1 个 hex，系列内不变 | #FFFFFF / #FF6B35 |
| 锁定版式 | archetype_bias | person-led 或 subject-led 二选一；禁止第三种"人物小图贴地标" | person-led |
| 系列角标 | badge_series | ≤10 字，固定方位（建议左上或右上） | 「职场36计」 |

### 账号档案字段表
| 字段 | 类型 | 说明 | 校验行为 |
|---|---|---|---|
| account_id | string | 账号唯一标识 | 缺省=无档案，按通用模板执行 |
| positioning | string | 一句话定位（≤20 字） | 仅作设计参考，不校验 |
| account_type | enum | ip（人设IP号）/ brand（品牌官号）/ seeding（种草号）/ knowledge（知识号）/ local（本地生活号）——中文标签亦可，检索桥会归一 | 决定默认 archetype 与字体候选 |
| platforms | list | 分发平台列表 | 决定标题字数上限与配色修正 |
| visual_hammer | object | 四件套 | 偏离默认 warn；strict=true 判非法 |
| hook_bias | list | **HOOK-001 公式 ID**：question / conflict / data-shock / contrast / value-preview / curiosity-gap / pattern-interrupt | 与 HOOK-001 联动（enrich 按偏好过滤钩子篇目） |
| taboo | list | 账号级禁忌（如"不用红色""不出小孩正脸"） | 命中即判非法，无视 strict |
| strict | bool | 严格模式 | true=偏离视觉锤判非法；false=warn 并记录 |

## 五、常见误区

| 误区 | 后果 | 正确做法 |
|---|---|---|
| 每条封面"重新设计"求新鲜感 | 主页像搬运号，粉丝识别失败，关注率低 | 四件套锁定，新鲜感只通过底图与标题文案表达 |
| 账号做大了才定视觉锤 | 改版成本高，老粉流失 | 冷启动前 3 条就定，30 条内零改动 |
| 视觉锤=只锁字体 | 颜色、版式漂移照样毁主页 | 字体+色板+archetype+角标四件套缺一不可 |
| 多平台一图全发 | 字数超限被截断，配色水土不服 | 三要素不动，仅按平台调字数与饱和度 |
| 老板今天要粉色明天要黑色 | 视觉资产归零，算法标签漂移 | 以账号档案 strict=true 为由拒绝频繁变更 |
| 直接搬竞品的视觉锤 | 主页"双胞胎"，无法建立识别 | 竞品扫街是为了避开撞色撞版式，不是抄袭 |
| 角标文案每条都换 | 系列识别失效 | badge_series ≤10 字锁定，系列结束才换 |

## 六、意图→设计映射表（核心调用区）

| 意图/题材（账号类型×平台） | 设计动作（视觉锤配置） | 判据 |
|---|---|---|
| 人设IP号×抖音 | font_id=smiley-sans；title #FFFFFF+个人代表强调色（如 #FFD400）；archetype_bias=person-led；角标右上 | 主页连续 9 图景别一致；人物占画面高 ≥55% |
| 人设IP号×小红书 | 同上；标题放宽 ≤14 字；色板降饱和 10–15% | 双列网格相邻图不撞色 |
| 品牌官号×抖音 | font_id=source-han-heavy；title=VI 主色（如 #0052D9）；accent=VI 辅助色；subject-led；logo 角标左上 | 每条封面 VI 色出现 ≥1 处 |
| 品牌官号×B站 | 同上；标题 ≤16 字；深色 scrim 提升可读性 | 标题与底图明度对比 ≥4.5:1 |
| 种草号×小红书 | font_id=zcool-qingke；title #FFFFFF；accent #FF6B35 或莫兰迪一套；subject-led；角标「好物Vol.N」 | 产品占画面 ≥50%；无人物小卡 |
| 知识号×抖音 | font_id=source-han-heavy；title #FFFFFF；accent #4CC9FF；锁定 person-led（讲师）或 subject-led（图表）其一 | 30 条内 archetype 零漂移 |
| 知识号×YouTube | font_id=source-han-heavy（英文用其拉丁字形全大写）；accent 高饱和 #FF3B30/#FFD60A；subject-led 偏图表 | 缩略图 120px 宽时标题仍可辨 |
| 本地生活号×抖音/快手 | font_id=smiley-sans；title #FFFFFF；accent 食欲色 #FF6B35/#FFB800；subject-led（招牌菜/门头） | 封面 1 秒读出"什么店什么菜" |
| 母婴号×小红书 | font_id=zcool-qingke；奶油色板 #FFF8F0/#FFB6C1；person-led（亲子）或 subject-led（萌娃）锁定其一 | 色板低饱和；无高对比刺激色 |
| 旅行人设号×抖音 | font_id=zcool-qingke；title #FFFFFF；accent #00C2A8；person-led（人物须 ≥55% 高） | 人物不满 55% 时改走 subject-led 地标满幅 |

## 七、设计模板

### 模板 1：人设IP号标准锤
- font_id：smiley-sans
- palette：title #FFFFFF；accent #FFD400（个人代表色，仅用于关键词描边/下划线条）
- archetype_bias：person-led，胸像居中偏左 1/3，人物高 ≥55%
- badge_series：「栏目名」≤6 字，右上角，圆角底条用 accent
- 标题：主标题 ≤12 字置于人物对侧留白区；副标题字高比 0.022–0.06

### 模板 2：知识号图表锤
- font_id：source-han-heavy
- palette：title #FFFFFF；accent #4CC9FF
- archetype_bias：subject-led，核心图表/关键帧满幅，底部 25% scrim 压暗带
- badge_series：「干货第N期」左上
- 标题：疑问式 ≤12 字压 scrim 上，关键词用 accent

### 模板 3：本地生活货架锤
- font_id：smiley-sans
- palette：title #FFFFFF；accent #FF6B35
- archetype_bias：subject-led，招牌菜 45° 俯拍满幅，暖调滤镜统一
- badge_series：「店名·第N探」≤10 字
- 标题：店名+招牌菜二选一上主标题，利益点（价格/折扣）进副标题

## 八、决策树

```
新账号从零定视觉锤
├─ 一句话定位：谁+给谁看什么+解决什么
├─ 定位里"人"是核心资产？
│  ├─ 是 → 候选 archetype=person-led（人设IP/知识讲师/Vlog）
│  └─ 否 → 候选 archetype=subject-led（品牌/种草/本地/风光）
├─ 竞品扫街：列 5 个同赛道头部账号，截图其主页九宫格
│  ├─ 记录各家字体气质/主色/archetype
│  └─ 排除已被头部占用的组合（撞锤=识别自杀）
├─ 定四件套
│  ├─ 字体：年轻潮流→smiley-sans；稳重知识→source-han-heavy
│  │        生活旅行→zcool-qingke；人文历史→noto-serif
│  ├─ 色板：title 优先 #FFFFFF（通吃）；accent 从品类色库选 1 个
│  ├─ archetype：沿用上面候选，写入 archetype_bias
│  └─ 角标：栏目名 ≤10 字，定固定方位
├─ 写入账号档案：strict=true（冷启动期）
├─ 30 条验证
│  ├─ 每 10 条截主页九宫格自查：像不像一个妈生的？
│  ├─ CTR 低于账号均值 30% 的单条：只怀疑底图与钩子，不动四件套
│  └─ 30 条后复盘：最多改 1 个变量（如强调色），其余不动
└─ 固化：写入 visual_hammer，后续封面走校验（偏离 warn / strict 判非法）
```

## 九、关联知识

- ACCT-002 系列化与主页拼图：视觉锤在主页网格中的编排纪律
- THEME-001 题材到版式映射：archetype 与构图的题材级细化
- THEME-002 题材到配色与字体映射：色板与字体的题材级细化
- HOOK-001 钩子文案：hook_bias 与标题句式
- CRAFT-001~003 工艺篇：scrim、字级、导出参数
- PLAT-001~006 平台篇：各平台封面规格与社区审美
