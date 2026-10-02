# 销售讲解型营销片模板（sales-pitch-5ring）

> 一句话：**一个主讲人 + 一条台词线 + 五段结构**，80–95 秒把一套 B 端系统讲清楚并卖出下一步。
> 真机出处：T-2026-0926-0007（VID-GR01《WorkLoom 获客增长系统 · 85 秒销售片》，18 镜 / 89.5s / 9:16 1080p）。

## 什么时候用

- 要把一套系统/一个方案卖给客户，需要**主讲人把话讲透**（而不是快剪空镜）；
- 交付场景是社媒（抖音/小红书/视频号）+ 线下投屏，一支片子两处用；
- 素材口径：全部镜头由系统生成（无实拍素材），人物使用随仓内置模特；
- 需要"同一组素材产出 2–3 个风格版本"供客户挑选（多风格交付包）。

## 怎么用（一条命令）

```bash
node_modules/.bin/tsx scripts/tools/full-chain-film.mts \
  --shots    bundles/ai-video/library/templates/sales-pitch-5ring/examples/workloom-growth/shotlist.json \
  --project  VID-GR01 \
  --library  <项目自有角色库，可省略（默认用内置 1 号模特陈卓）> \
  --work-dir <.vm-work 根> --out <交付目录> \
  --brief    bundles/ai-video/library/templates/sales-pitch-5ring/examples/workloom-growth/brief.json \
  --stages   cine-kb,continuity,micromotion,spec,plates,videos,voice,compose,color,subtitle,bgm,cover,mux,deliver \
  --subtitle-mode both \
  --cover-hero person --cover-hook "获客，算得清" \
  --cut-transition hblur --cut-transition-duration 0.18 --cut-transition-at 6,10,14,17 \
  --xfade 0.3 --narration-profile chen-zhuo-film --max-attempts 2 \
  --keys-file ~/.workloom/live.env
```

分批复跑（推荐，失败面小、可断电续跑）：

```bash
# ① 提示词（零成本）+ 关键帧（Seedream，按张计费）
… --stages spec,plates
# ② 逐镜渲染（Seedance，按秒计费，最贵最长）+ 配音复核
… --stages videos,voice
# ③ 后期与交付包（本地算力，零 token）
… --stages compose,color,subtitle,bgm,cover,mux,deliver
```

## 硬口径（照做才过闸）

| 项 | 口径 | 出处 |
|---|---|---|
| 台词字数 | 单镜 ≤ 时长 × 2.8 字（≈ 时长 × 80% × 3.5 字/秒） | `vendor/config/speech-rate.js` + 交付闸 |
| 字段齐备 | 内容镜 25 字段（含【景深】【道具】【节奏】【角色约束】） | `vendor PromptDeliveryGuard` |
| 情绪字段 | 必须含可见部位微动作（眼/眉/嘴角/手/肩/呼吸…） | 同上（缺即打回） |
| 场景字段 | 只写环境；人物、朝向、动作分别落在【角色】【构图】【动作】 | 监制评审纪律 |
| 服装 | 以角色档案为准（内置模特 w1 月白旗袍）；换装先补档案造型 | `docs/character-registry.md` |
| 屏幕文字 | 一律虚化/过曝成色块，禁止可辨认文字与数字 | 监制硬纪律 |
| 字幕 | 母版不烧字；旁挂 srt/ass/vtt + 软字幕轨副本 | `docs/video-delivery-and-revision.md` |
| 变体差异 | 3 个变体必须实测可辨（画面平均像素差 / 音轨差异），雷同一票否决 | G-DLV1 |

## 场景圣经与开场钩子（2026-09-27 新增，示例已按新口径升级）

示例镜头卡里现在带三样新东西，直接复跑就会被用到：

| 字段 | 在哪 | 作用 |
|---|---|---|
| `sceneBible` | shotlist 顶层 | 片级真实空间事实源（上海静安 1936 年纺织厂改建办公楼 + 1.2 公里外门店）：空间实指 / 材质带工艺与使用痕迹 / 场景内实用光源 / 色彩纪律。管线在装载期把它**展开进每镜的既有字段** |
| `hook` | shotlist 顶层 | 开场钩子卡（`question` 型，承诺「还在给平台打工吗」由 GR-06 用台词回应）；钩子音 `impact@0.08s` 落在 0–0.6s 窗口 |
| `propInteraction` | 7 个含可交互道具的镜头 | 道具-人体物理关系（朝向/操作者/承重/遮挡）：手机与平板**屏幕朝向使用者本人**，观众只见机身背面或侧缘 |
| `devicePolicy` + `devices[]` | 顶层标记 + 11 个含电子设备的镜头 | **场景里的电子设备全部为 2024 年后世代的 Apple 在售机型**（MacBook Pro / iPad Pro / iPhone 16·17 / Studio Display XDR / Magic Keyboard / Magic Mouse / AirPods），机型逐镜声明（裸词不算） |

渲染前自检（零 token，硬缺陷会阻断渲染）：

```bash
# 改造前口径（看镜头卡原文；本模板改造前的实测：硬缺陷 12 · 软提示 18）
node_modules/.bin/tsx scripts/tools/environment-realism-audit.mts \
  --shots bundles/ai-video/library/templates/sales-pitch-5ring/examples/workloom-growth/shotlist.json

# 管线真实口径（先把圣经展开进每镜；本模板现在应为 0 硬缺陷 / 0 软提示）
node_modules/.bin/tsx scripts/tools/environment-realism-audit.mts \
  --shots bundles/ai-video/library/templates/sales-pitch-5ring/examples/workloom-growth/shotlist.json --expand
```

口径细节见 `docs/environment-realism.md` 与 `docs/opening-hook.md`；两类真机 badcase 见
`docs/badcases/BADCASE-2026-0927-env-average-room.md`、`docs/badcases/BADCASE-2026-0927-phone-screen-toward-audience.md`。

## 真机打回清单

见 `template.yml#anti_patterns`（人脸漂移 / 服装冲突 / 手部畸变 / 屏幕文字 / 玻璃镜像第二张脸 /
场景被写实校验静默替换）——每一条都是 VID-GR01 上真实发生并已修复的坑，附修法。

## 示例

`examples/workloom-growth/` 是 VID-GR01 的原始镜头卡与简报（18 镜 / 89.5s），
可直接复跑同一支片子，或替换产品内容后按同一结构改写。
