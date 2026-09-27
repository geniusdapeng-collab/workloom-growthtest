# FC-BGM-001 题材未命中 0 分不否决——运动曲错配江南口播片

| 字段 | 内容 |
|---|---|
| 编号 | FC-BGM-001 |
| 发现日期 | 2026-09-24（full-chain-film.mts 注释"2026-09-24 真机补"） |
| 严重度 | 高 |
| 状态 | 已修复（T-05 负分降权 + veto 策略 + 正反例词，2026-09-27；`--bgm-track` 人工点名兜底保留） |

## 症状

`best` 自动选曲把「运动/高燃」风格的曲目选给了江南水乡口播片：回执 `match.reasons` 里明确写着"题材未命中"，但因为能量/BPM 维度命中，该曲仍被采信并混进成片。题材维度打 0 分却不构成否决，错配曲目靠其他维度总分胜出。

## 检测器

- 回执审查：跑 `bgm-cli best`（`bundles/ai-video/connectors/bgm-bridge/cli.mjs`）后检查 evidence 目录回执的 `match.reasons`——出现 `题材未命中（曲目 genre=...）` 且该曲仍被选中，即命中本失败模式。
- 打分判据（修复后）：`scoreTrackAgainstBrief` 题材未命中分支给 **−30**（`GENRE_MISMATCH_PENALTY`）并写 reason；`genre_mismatch_policy=veto` 时直接 `verdict=rejected`；对照题材命中 +38/36、同族 +15。
- 回归用例：`connectors/bgm-bridge/genre-mismatch.test.ts`「江南人文口播 brief：题材判成 documentary，动感曲目不再被选走」（断言运动曲得分 <0 且 weak）。
- 人工判据：口播/人文类片子配到 `sports-hype`（运动燃点）风格族曲目即疑似错配。

## 根因

- `bundles/ai-video/connectors/bgm-bridge/brief.mjs:215` `scoreTrackAgainstBrief`：打分口径为"题材 40 + 能量 20 + BPM 20 + 时长 10 + 结构 10，禁忌一票否决"——**只有配器禁忌（avoid）是一票否决，题材未命中只是 0 分**，靠能量/BPM/结构照样能拿 60 分胜出。
- 现场记录：`scripts/tools/full-chain-film.mts:3341-3347` 注释——"`best` 的自动选曲在'题材'维度上不够硬——真机把「运动/高燃」的曲目选给了江南水乡口播片（match.reasons 明确写着'题材未命中'，但因为能量/BPM 命中仍被采信）"。

## 处置

- 落地：宿主侧新增 `--bgm-track <曲库 id | 绝对路径>` 人工点名兜底（full-chain-film.mts:3348-3392）——监制直接指定题材贴合的曲目，**跳过自动择优**，但仍走混音/让位/响度/选段全套复检，不绕过质量闸。
- **已落地（T-05，2026-09-27）**：题材未命中改负分降权（−30；不是 0 分），错配曲目在总分上自动沉底；`veto` 策略可让未命中直接出局，候选全出局时按三级兜底降级（在线→本地→自算作曲），不强行出片；人文/口播文本里的"运动会"等词由 `GENRE_KEYWORDS[].anti` 压制并写进 `matched.suppressedGenres`。

## 预防措施

- 题材维度升级为"准硬约束"：recipeId 存在且题材未命中时给负分（T-05），仅靠能量/BPM 不得翻盘。
- 口播/访谈类 brief 选曲后强制人审回执 `match.reasons`，见"题材未命中"即换曲或走 `--bgm-track` 点名。
- 宁可判"不配"也不错配——与 bgm-score-design/SKILL.md 失败模式表"情绪与画面相反"同口径（回退换配方；宁可"不配"也不要错配）。

## 关联

- 代码：`bundles/ai-video/connectors/bgm-bridge/brief.mjs:215-238`（打分与题材未命中分支）；`scripts/tools/full-chain-film.mts:3341-3348`（事故注释与 --bgm-track）
- SKILL 引用：`bgm-score-design/SKILL.md` 失败模式表第 2 行"情绪与画面相反…宁可'不配'也不要错配"
- 任务号：T-05（题材未命中负分降权，2026-09-27 落地）
- 兜底修复随提交 `5288456`（2026-09-26）所在代码线维护
