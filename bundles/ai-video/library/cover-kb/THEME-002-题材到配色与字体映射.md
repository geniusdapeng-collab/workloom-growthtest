# THEME-002 题材到配色与字体映射
> 版本 v1.0 · 2026-09-27 · 适用链路：视频封面设计（cover-designer 岗位）

## 一、核心概念

封面配色只扮演三个角色：
1. **主标题色**（title_color）：主标题文字颜色，绝大多数场景用高亮色（白/浅黄），保证信息流远距可读。
2. **强调色**（accent_color）：关键词描边/下划线/角标底/数字高亮，一张封面只用 1 个，承担记忆点。
3. **底图调性**：底图本身的色温与饱和度，决定标题色该亮还是该暗。

**对比度纪律**：标题与底图（或 scrim 压后的底图）明度对比建议 ≥4.5:1，底线 3:1。底图太花/太亮时，不是换标题颜色去迁就，而是加 scrim（压暗带）把底图压进可用区间——scrim 是配色的前置工序：先压底，再配色。scrim 区内的底图按"压暗后明度"参与对比度计算。

## 二、分类速查

### 字体白名单气质光谱（四选一，无第五种）
| 字体 ID | 名称 | 气质 | 适用题材 | 慎用场景 |
|---|---|---|---|---|
| smiley-sans | 得意黑 | 年轻、抓眼、速度感 | 城市/潮流/剧情/带货/本地 | 人文历史、严肃知识 |
| source-han-heavy | 思源黑体（重） | 稳重、可信、可读性最高 | 知识/品牌/测评/新闻感 | 萌宠、低幼 |
| zcool-qingke | 站酷庆科黄油体 | 圆润、活泼、亲和力 | 生活/旅行/美食/母婴/Vlog | 冲突剧情、硬数据 |
| noto-serif | 思源宋体 | 书卷气、时间感 | 人文/历史/文化/深度访谈 | 快节奏带货、潮流 |

**英文平台规则**：英文标题同样使用白名单字体的拉丁字形，且一律全大写（如 source-han-heavy 的拉丁大写用于 YouTube 封面）。禁止引入白名单外任何字体。

## 三、分场景实战（八题材 × 字体 × 双配色方案）

### 1. 知识科普
- 字体：source-han-heavy（首选）/ noto-serif（人文向）
- 方案 A 蓝白理性：title #FFFFFF，accent #4CC9FF，底图深蓝 scrim
- 方案 B 纸墨书卷：title #1A1A1A，accent #B03A2E，底图米白 #F5F0E6（配 noto-serif）

### 2. 美食
- 字体：zcool-qingke（首选）/ smiley-sans（潮流餐饮）
- 方案 A 暖黄橙：title #FFFFFF，accent #FF6B35，底图暖调 #FFF3E0 基调
- 方案 B 深夜食堂：title #FFE8B3，accent #E63946，底图深棕黑 scrim

### 3. 旅行风光
- 字体：zcool-qingke（首选）/ noto-serif（人文旅行）
- 方案 A 山海青：title #FFFFFF，accent #00C2A8
- 方案 B 日落金：title #FFFFFF，accent #FFB800，底图蓝调时刻

### 4. 剧情/短剧
- 字体：smiley-sans（首选）/ source-han-heavy（正剧）
- 方案 A 高能红：title #FFFFFF，accent #FF2D55
- 方案 B 悬疑黄黑：title #FFD400，accent #FF2D55，底图深压 scrim

### 5. 带货/种草
- 字体：smiley-sans（首选）/ source-han-heavy（大牌感）
- 方案 A 促销橙：title #FFFFFF，accent #FF6B35
- 方案 B 高级黑金：title #FFFFFF，accent #D4AF37，底图深灰黑

### 6. Vlog 日常
- 字体：zcool-qingke
- 方案 A 奶油日常：title #FFFFFF，accent #FF8FA3
- 方案 B 胶片绿：title #FFFFFF，accent #7FB069

### 7. 测评/对比
- 字体：source-han-heavy（首选）/ smiley-sans（3C 潮流测评）
- 方案 A 数据蓝：title #FFFFFF，accent #3A86FF
- 方案 B 对比黄黑：title #FFD400，accent #FFFFFF，底图深压

### 8. 母婴/宠物
- 字体：zcool-qingke
- 方案 A 奶油粉：title #FFFFFF，accent #FFB6C1，底图 #FFF8F0 基调
- 方案 B 暖阳橘：title #FFFFFF，accent #FFA552

## 四、参数速查（核心调用区）

| 参数 | 口径 | 取值 |
|---|---|---|
| title_color | 主标题色 hex | 默认 #FFFFFF；浅底图用 #1A1A1A 系 |
| accent_color | 强调色 hex | 每封面 1 个，来自账号色板 |
| scrim_opacity | 压暗带不透明度 | 0.25–0.45，以压后对比 ≥4.5:1 为准 |
| contrast_ratio | 标题/底图明度对比 | 建议 ≥4.5:1，底线 3:1 |
| font_id | 白名单四选一 | smiley-sans / source-han-heavy / zcool-qingke / noto-serif |
| en_transform | 英文标题规则 | 白名单拉丁字形 + 全大写 |
| 字高比 | 主标题/副标题 | 主标题 0.045–0.12；副标题 0.022–0.06（题材区间见 THEME-001） |

### 平台配色修正
| 平台 | 修正方向 |
|---|---|
| 快手 | 避免过度精致/低饱和"性冷淡"配色；提高明度对比、加大字号 |
| 小红书 | 低饱和莫兰迪吃香；accent 降饱和 10–15%（如 #FF6B35→#E98A63） |
| YouTube | 高饱和高对比吃香；accent 可至 #FF3B30/#FFD60A 级饱和 |
| 抖音/B站 | 标准区间，按题材方案直接执行 |

## 五、常见误区

| 误区 | 后果 | 正确做法 |
|---|---|---|
| 一张封面用 3 种以上彩色 | 无记忆点，视觉嘈杂 | 主标题色+1 个强调色，其余黑白灰 |
| 底图太亮就把标题换浅灰 | 对比度不足，缩略图里消失 | 加 scrim 压暗底图，标题保持高亮 |
| 为"特别"引入白名单外字体 | 校验判非法，账号视觉锤崩坏 | 四选一；气质不够靠字号/排版补 |
| 英文封面用系统默认无衬线 | 与中文封面气质割裂 | 白名单字体拉丁字形+全大写 |
| 母婴封面用高能红 accent | 调性冲突，社区反感 | 治愈系低饱和 accent（粉/橘/奶油） |
| 快手封面照搬小红书莫兰迪 | 远距糊成一团 | 平台修正：提对比、降精致 |
| 强调色每期换 | 账号色板资产归零 | accent 来自账号 visual_hammer 色板 |
| 对比度凭感觉 | 时好时坏 | 按 4.5:1 校验，不足就加 scrim |

## 六、意图→设计映射表（核心调用区）

| 意图/调性 | 设计动作（字体+色板+强调色） | 判据 |
|---|---|---|
| 知识科普·理性权威 | source-han-heavy；title #FFFFFF；accent #4CC9FF；深蓝 scrim | 对比 ≥4.5:1 |
| 人文历史·书卷 | noto-serif；title #1A1A1A；accent #B03A2E；米白底 #F5F0E6 | 纸感底+深色字对比 ≥4.5:1 |
| 美食·暖食欲 | zcool-qingke；title #FFFFFF；accent #FF6B35；暖 scrim | 底图暖调；对比 ≥4.5:1 |
| 美食·夜宵档 | smiley-sans；title #FFE8B3；accent #E63946；深棕 scrim 0.35–0.45 | 深夜氛围但标题高亮 |
| 旅行·清新 | zcool-qingke；title #FFFFFF；accent #00C2A8 | scrim ≤0.3，地标不被压死 |
| 旅行·人文古城 | noto-serif；title #FFFFFF；accent #FFB800 | 字高比 0.045–0.07 不压景 |
| 剧情·高能冲突 | smiley-sans；title #FFFFFF；accent #FF2D55；字高 0.08–0.12 | 远距 1 秒读出冲突词 |
| 剧情·悬疑 | source-han-heavy；title #FFD400；accent #FF2D55；深 scrim | 黄字黑底对比 ≥4.5:1 |
| 带货·促销 | smiley-sans；title #FFFFFF；accent #FF6B35；价格数字用 accent | 数字为画面最大字级之一 |
| 带货·高级大牌 | source-han-heavy；title #FFFFFF；accent #D4AF37；深灰底 | 无第二强调色 |
| Vlog·日常治愈 | zcool-qingke；title #FFFFFF；accent #FF8FA3；轻 scrim ≤0.25 | 无硬促销感 |
| 测评·数据流 | source-han-heavy；title #FFFFFF；accent #3A86FF；VS 条用 accent | 中缝元素与设计层同色 |
| 母婴·奶油 | zcool-qingke；title #FFFFFF；accent #FFB6C1；底 #FFF8F0 基调 | accent 低饱和；无刺激色 |
| 宠物·暖阳 | zcool-qingke；title #FFFFFF；accent #FFA552 | 主体毛色与 accent 不撞色 |
| 快手全题材 | 字体不变；accent 提饱和；字高比取区间上限 | 缩略图远距可读 |
| 小红书全题材 | 字体不变；accent 降饱和 10–15%（莫兰迪化） | 与社区信息流不突兀 |
| YouTube 英文 | source-han-heavy 拉丁字形全大写；accent #FF3B30 或 #FFD60A | 120px 宽可读；对比 ≥4.5:1 |

## 七、设计模板

### 模板 1：理性知识蓝
- font_id：source-han-heavy
- title_color #FFFFFF / accent_color #4CC9FF
- scrim：底部 25%，不透明度 0.35，深蓝基调
- 适用：知识科普、测评、品牌官号
- 英文：拉丁字形全大写

### 模板 2：暖食欲橙
- font_id：zcool-qingke
- title_color #FFFFFF / accent_color #FF6B35
- scrim：底部 20%，0.25–0.3，保食物暖色不被压灰
- 适用：美食、本地生活、带货促销
- 小红书执行时 accent→#E98A63

### 模板 3：奶油治愈粉
- font_id：zcool-qingke
- title_color #FFFFFF / accent_color #FFB6C1
- scrim：顶部或底部 15–20%，0.2，保画面轻盈
- 适用：母婴、宠物、Vlog
- 判据：accent 低饱和，整体明度偏高

## 八、决策树

```
定字体
├─ 题材气质？
│  ├─ 年轻/潮流/冲突/促销 → smiley-sans
│  ├─ 稳重/知识/数据/品牌 → source-han-heavy
│  ├─ 生活/美食/旅行/母婴/Vlog → zcool-qingke
│  └─ 人文/历史/深度 → noto-serif
└─ 查账号锤：visual_hammer.font_id 存在？→ 以锤为准，上表仅作题材兜底

定配色
├─ 查账号色板：有锁定 title/accent？→ 直接用，跳过选色
├─ 无锁定 → 按题材方案 A/B 二选一（本文第三章）
├─ 底图过亮/过花？→ 先加 scrim（0.25–0.45），再测对比
├─ 对比度校验：标题 vs 压后底图 ≥4.5:1？
│  ├─ 否 → scrim 加深，或标题换 #FFFFFF
│  └─ 是 → 通过
└─ 平台修正：快手提对比 / 小红书降饱和 / YouTube 提饱和

英文标题
└─ 白名单同字体拉丁字形 + 全大写；禁止新字体
```

## 九、关联知识

- ACCT-001 账号定位到视觉锤：账号级色板锁定
- ACCT-002 系列化与主页拼图：色板轮换与网格色彩
- THEME-001 题材到版式映射：版式与字级
- HOOK-001 钩子文案：关键词高亮的文案选择
- CRAFT-001~003 工艺篇：scrim 参数、对比度测量、字级口径
- PLAT-001~006 平台篇：各平台社区审美与规格
