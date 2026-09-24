# 管线缺失环节接入 + 门事件按 step_key 记账（2026-09-24 · T-2026-0924-0001 第二次收口）

**范围**：`bundles/ai-video/pipelines/narrative-film.yml` 里**声明了但运行时没接**的环节与确认门，
以及本次接入过程中在真机上暴露并按纪律修掉的 5 个缺陷。

**一句话结论**：`continuity`（连贯性导演评审）与 `micromotion`（微动作增强）两个环节已进运行时；
`g5/g6/g7/g8` 四个门现在**按 step_key 落账**（与阶段记录同一个 `stages.jsonl`，审计可检索）；
接入当天就靠新门抓出并修掉了 5 个真缺陷（含 1 个让 8 张定妆照对所有消费者"隐身"的老 bug）。

## 一、接入的环节

| step_key | 运行时位置 | 实现 | 判据 |
|---|---|---|---|
| `continuity` | `cine-kb` 之后、提示词融合之前 | `packages/video-studio/src/continuity.ts`（确定性 6 问 + 5 维评分）+ 监制 LLM 复核 | 硬阻断：造型无理由不一致、总时长不符、台词重复；软信号：时段倒退、方向相反、道具消失、缺收束镜 |
| `micromotion` | 提示词融合之前（**与 yml 顺序的显式差异**） | `packages/video-studio/src/micromotion.ts`（5 路：面部/眼神/身体/呼吸/融合，确定性） | 五路齐备 / 增量 ≤200 字 / 只写画面语言（无 f 值、ISO、帧率） |

**顺序差异的理由**：yml 把 `micromotion` 排在 G6 之后。运行时前移到融合之前——因为微动作增强改的是**镜头卡**
（action 字段），融合之后再改就会绕开刚通过的 G6 审核（"审过的提示词 ≠ 最终提交的提示词"）。前移后 G6 审的就是最终稿。

## 二、按 step_key 记账的门

模块：`packages/video-studio/src/gate-ledger.ts`（`buildGateEvent` / `appendGateEvent` / `readGateEvents` / `summarizeGates`）。
门事件与阶段记录写进**同一个** `stages.jsonl`（`stage: "gate"` + `stepKey` + `gate` + `checks` + 裁决），任何审计器/平台执行器可按 step_key 检索。

| 门 | step_key | 触发点 | 判据 |
|---|---|---|---|
| G5 | `g5-portrait-confirm` | 运行开始（角色资产装载后） | 四必需角度齐备、单张 >50KB、最近一次定妆照监制记录不是"打回"；无监制记录时照跑但标 `degraded` |
| G6 | `g6-prompt-confirm` | `prompt-review` 裁决后 | 交付闸/字数/语速/朝向互斥/构图先验 + 监制评分 |
| G7 | `g7-preproduction` | 关键帧全部放行之后、第一次提交渲染之前 | 提示词齐备（≥1200 字）、关键帧齐备、两环节均有放行裁决、微动作已并入 |
| G8 | `g8-render-submit` | **每次向渲染服务提交之前**（逐镜） | 提示词字数、正文无 f 值、含【约束】画幅、时长上限、首帧锚点在场；复用产物时做 `mode=recheck` 复核（不拦，仅记账） |

## 三、接入当天抓出并修掉的 5 个真缺陷

1. **定妆照"隐身"（老 bug，G5 第一次跑就抓到）**
   随仓 1 号模特的档案 `name` 是"陈卓"，而 `portraits/v3/` 下的文件名是"平江路讲述人-front.png"（沿用上一代素材前缀）。
   `character-archive.ts#findAngleFile` 按 `${name}-${angle}` 硬匹配 → **8 张定妆照全部匹配不到**，
   "角色有定妆照"这件事对所有消费者都不存在（图生图锚点为空、G5 无资产可查）。
   修复：规范命名优先 + **回退到"任意前缀-<角度>"**；runner 与 `portrait-agent` 统一复用它。
   回归：`character-archive.test.ts` 新增两例（前缀不一致可解析、规范命名优先）。
2. **G5 空路径崩溃**：角度缺失时 `statSync("")` 抛 ENOENT，把整条运行打断在第一步（真机第一次跑即复现）。修复：安全取字节数 + 缺角度由"必需角度"检查统一报。
3. **朝向互斥闸误伤分步动作**：SC-01"走三步后停下、侧身回眸看向镜头"、SC-06"先侧身看河面、再转身面向镜头"是**有时间顺序**的合法镜头语言，被当成同刻矛盾拦下；
   同时"不转身"里的"转身"被当成要求项（假阳性）。修复：先剥否定，再判顺序（`先…再…／随后／最后／停下后`）→ 顺序动作降级为提示。
4. **文本类产物没把正文给监制**：`prompt` 环节只送路径清单，监制只能回"无正文可核验"（真机 58 分打回）。
   修复：`producer-gate.ts` 按预算把 json/text 正文片段送审（单文件 1600 字、总量 12000 字）。修好后监制逐条读出了下列实质问题（并被逐个修掉）。
5. **`mux`（软字幕轨收口）环节缺 rubric**：该阶段一直在默认阶段表里，但从没被跑到；第一次跑到即 `TypeError` 打断交付链最后一步。修复：补 `mux` 的 4 条评审要点。

## 四、监制读出正文后暴露的 4 处知识注入偏差（同日晚第四轮校准）

| 现象 | 根因 | 修复（`bundles/ai-video/connectors/cine-kb-bridge/core.mjs`） |
|---|---|---|
| 糖粥/海棠糕镜头里出现"咖啡杯" | PHYS-001 §2.8「蒸汽」的示例句是咖啡专用，规则只判"食物+蒸汽"就注入 | 规则改名 `steam-coffee`，要求场景真是咖啡语境；中餐蒸汽缺行已登记为 KB 缺口 |
| 红灯笼场景被注入"烛火小而稳定…暖光晕开" | 烛火行只判 `lantern`（灯笼） | 改为必须真有火焰（`candle`：烛光/蜡烛/火锅/篝火） |
| 糖粥镜头被注入"酱汁油亮挂壁" | 食物质感行只判"食物" | 追加 `/酱|汁|炖|卤|烤|油亮|挂壁|油光/` |
| 造型描述里的"发丝随转头轻摆"触发"行走中回头看向镜头" | 回头类动作把"转头"算作回眸 | 只认 `回眸/回头/回望`（否定剥离照旧） |
| 运镜行下发字面占位符"画面内[元素]自行运动" | KB 模板行未实例化 | 新增 `resolvePlaceholders()`：按卡片填 灯笼/水面与倒影/摇橹船/往来行人/飘落的花叶，兜底"画面内元素"，并在 trace 标 `placeholderResolved` |
| 夜景收尾镜的景深文案是"奶油般虚化、梦幻光斑、**主体悬浮感**" | `apertureStopFor` 取"第一个有交集的档"，f/1.4–f/2.8 被 f/1.2–f/1.4 档代言 | 改为**按区间重叠长度取档** → 得到"柔和虚化、主体突出、电影感" |

## 五、真机验证（VID-PJL02 交付链，2026-09-24 晚）

```
[gate G5 g5-portrait-confirm]  ok(deg)   定妆照资产齐备（8 角度解析正常）
[continuity]                   ok 100    六项跨镜检查全 PASS（此前从未被调用）
[micromotion]                  ok        6 镜 × 5 路并入 action
[gate G6 g6-prompt-confirm]    ok 88     提示词放行（正文已送审；此前因"无正文可核验"被打回 4 次）
[gate G7 g7-preproduction]     ok        prompt+plate 放行裁决齐备
[shot SC-01..SC-06]            ok 83–90  六镜复检全放行
[gate G8 g8-render-submit]     ok ×6     逐镜提交判据复核（mode=recheck）
[subtitle/danmaku/bgm/cover]   ok 93/88/86/86
[mux]                          ok 96     软字幕轨版（画面零改动）
[master]                       ok 93     终审放行 → VID-PJL02-30s-final.mp4（硬字幕版）
```

阶段日志：`work/vm-work/logs/stages.jsonl`（门事件 18 条：G5 ×6、G6 ×5（放行 1 / 打回 4）、G7 ×1、G8 ×6）。

## 六、未覆盖 / 遗留

- **平台侧消费未接**：门事件已经按 step_key 落账，但 `apps/server` 的管线执行器还**没有读**这张账本
  （`apps/server/src/video/studio-worker.ts` 走的是 `onApproval` 审批事件）。CLI 侧闭环，平台侧待接。
- 监制在本次复跑中对**调色**（52 分：饱和度不降反升、全局冷偏）与**首轮弹幕**（58 分：文案复读）投过反对票；
  运行时按"不劣化优先"保留了上一版产物，随后在 `subtitle,danmaku,bgm,cover,mux` 复跑中放行（93/88/86/86）。
  这两项属于后期参数与文案池的改进项，未在本轮展开。
- 微动作 LLM 复评默认关闭（`--micromotion-review` 可开），当前只有确定性判据；开 LLM 的收益/成本未做 A/B。
