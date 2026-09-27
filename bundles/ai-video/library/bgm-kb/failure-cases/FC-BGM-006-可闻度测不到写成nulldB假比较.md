# FC-BGM-006 可闻度测不到写成「nulldB < 阈值」假比较——白跑一次 -3dB 重混

| 字段 | 内容 |
|---|---|
| 编号 | FC-BGM-006 |
| 发现日期 | 2026-09-24（提交 2e00caa） |
| 严重度 | 中 |
| 状态 | 已修复 |

## 症状

素材全程连续现场声/连续口播时，既无绝对静音窗口也找不到相对安静窗口，`musicPresenceDb` 只能为 `null`；但回执写成「配乐可闻度 nulldB < 3dB」——一次**没发生过的比较**。误导性文案让人当成电平问题反复调电平，post-bridge 还据此白跑一次 -3dB 混音重试（换了电平也照样测不到，纯烧算力）。

## 检测器

- 回执字段：`presenceBasis` 三态——`quiet-window`（安静窗口实测）/ `room-tone`（房间底噪基准）/ `none`（测不到）；`none` 时结论必须是"无法测量（原因）+ 下一步"，不得出现 `nulldB < XdB` 字样。
- 纯函数判据：`explainMusicAudibility`（core.mjs，2e00caa 拆出）`measured=false` 时输出"配乐可闻度无法测量（…）→ 按「未核实」拒绝出片"。
- 单元回归：`bundles/ai-video/connectors/bgm-bridge/verify-message.test.ts`（45 行新增用例）。
- 硬闸口径（bgm-audio-layering/SKILL.md:111）：配乐可闻度 <3dB → 工具 `verify_failed` 删除产物（"配了跟没配一样"）；测不到按「未核实」同样拒绝出片，fail-closed 不变。

## 根因

- 旧实现把"测不到"（`musicPresenceDb=null`）与"测得偏低"混进同一个比较模板，直接字符串插值出 `nulldB < 3dB`——空值参与了从未发生的数值比较。
- 下游 post-bridge 只看"可闻度不达标"就触发 -3dB 重混重试，没有区分"可调"与"不可调（无测量窗口）"，导致一次注定失败的白跑重试。

## 处置

- 提交 `2e00caa`（2026-09-24）：
  - core.mjs 新增 `explainMusicAudibility()` 纯函数，区分两种结论：测得偏低报实测差值（可据此调电平）；测不到如实报"无法测量（原因）+ 下一步建议"。
  - `mix()` 计算 `presenceMeasured` 与 `presenceBasis`（quiet-window/room-tone/none）写入回执，下游不再从 null 反推。
  - 测不到情形标 `retryable:false`，post-bridge 跳过白跑的 -3dB 混音。
  - 新增 verify-message.test.ts；门禁 test:scripts 19 用例 / capabilities:check / bundle:governance 全绿。
- 修复文案给出可行下一步："可改用带人声间隙的素材、或指定 section 片段复用后在有人声间隙处复检再重试本变体"。

## 预防措施

- 指标空值不得进入比较句式：所有"实测 vs 阈值"文案必须先断言测量确实发生（`measured=true`）。
- 重试必须有可变更的杠杆：`retryable:false` 的情形直接报失败与建议，不做无差别重试（与 8c8425e"重试必须带变更"同纪律）。
- 回执结论分级：测得偏低（可调电平）/ 测不到（改素材或选段）/ 达标——三类处置路径不同，不得合并。

## 关联

- 提交：`2e00caa` fix(video): 配乐可闻度测不到时不再写「nulldB < 阈值」假比较 + 跳过一次白跑重试 [T-2026-0924-0084]
- 代码：`bundles/ai-video/connectors/bgm-bridge/core.mjs`（explainMusicAudibility、presenceBasis）、`verify-message.test.ts`；`bundles/ai-video/connectors/post-bridge/core.mjs`（retryable:false 跳过重试）
- SKILL 引用：`bgm-audio-layering/SKILL.md:111`（可闻度 ≥3dB 硬闸与 verify_failed 删除产物）；`presets/bgm-composer.yml:50`
- 同类纪律：提交 `8c8425e`（重试必须带变更，停止"重采样烧额度"）
