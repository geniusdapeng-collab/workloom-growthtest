# 技能：口播解说片制作（talkcraft-ops）

> 适用岗位：口播编导（`explainer-director`）· 版本 v1.0 · 2026-09-26 · T-2026-0926-0008
>
> 一句话：**一份口播稿 + 一条配音 → 字级对齐的图文动效解说片**。每个动效节拍都锚在确切的字上，
> 画面由 108 张动效配方卡（引擎资产）与本仓受控模板组装，机器闸六条 + 独立审片双重验收后才交付。

## 一、什么时候用这条链

用（口播解说片）：

- 讲解/科普/解读/教程/盘点/产品功能介绍；
- 已有（或即将有）**成稿口播**，要求字幕与配音**逐字同步**；
- 想要"图文动效 + 人物出镜"的成片，而不是逐镜 AI 生成实拍素材。

不用（换管线）：

- 要卖货、要转化、要投放素材 → 营销片管线（`marketing-film`，先跑商品情报五站）；
- 讲故事/情绪/形象片/空镜蒙太奇 → 叙事片管线（`narrative-film`）。

## 二、前置条件（缺一条都别开工）

| 前置 | 检查命令 | 说明 |
|---|---|---|
| 引擎已安装 | `pnpm talkcraft:check` | 引擎在 `vendor/talkcraft/`（**不入库**，安装期拉取）；卡 108 张 |
| 运行时冒烟过 | 同上（`runtimeReady=true`） | `runtime/node_modules` + 共享无头浏览器 + 冒烟渲 1 帧 |
| 许可口径明确 | `video.explainer.engine` | 评估/内部验证走 `noncommercial`；**商用交付必须** `TALKCRAFT_LICENSE_SCOPE=authorized` 且 `LICENSE-GRANT.md` 在场 |
| 配音可用 | 配音工位 `/health` | TTS：本机克隆音色（如 `chen-zhuo-film`）；真人录音：必须先过预剪确认 |

## 三、标准流程（每一步都有机器可验的产物）

1. **口播稿入档**：写进 `script.json`（句子数组）。**数字必须写汉字**（"百分之四十"，不是"40%"）——
   逐字对齐按文本对位，阿拉伯数字对不上读音，会整句漂移。
2. **配音**：TTS 或真人录音（真人录音 `voice_trim` 先出 `--dry-run` 报告，人过目确认才落盘）。
3. **字级时间戳**：`timestamps.json`（每句 + 逐字）+ `timing.json`（模板 `tSay/msSay` 的时间源）。
   `match < 0.90` 的句子一律进人工听核清单，不静默放行。
4. **语义标注**：26 词封闭词表（钩子/论点/例证/数据/对比/列举/定义/步骤/转折/设问/金句/标题/引用/自我介绍/
   介绍他人/号召/时间地点/空间叙事/机制/选择/过程演示/章节/转场/强调/氛围/结尾）。这是**选卡第一道过滤**。
5. **SHOTBOOK 分镜**：G0 风格档 + 版式节奏表 + 逐镜层矩阵。LLM 只产数据，
   确定性校验 32 项（文本逐字覆盖、卡在白名单、内容补丁可执行、同卡不连用 3 镜、版式节奏表覆盖、sfx 落点…）。
6. **工程装配**：模板 + 选中卡原文（`src/cards/<slug>.tsx`）+ 逐镜派生（`src/scenes/<shotId>.tsx`）+
   `props.json`/`beats.json`/`anchors.json`/`cues.json` + `node_modules → runtime/node_modules`。
7. **素材体检**：`preflight.py --media-only`（人物素材与素材盘点），FAIL 不进渲染。
8. **渲染**：`render_shots.mjs`（段缓存 + 帧数断言；音轨整条不分段）。单镜返修走 `--changed sNN`。
9. **机器闸六条**：静止/抖动、音效在场、音效可听、卡保真、词落点、评审材料抽帧拼图。任一 FAIL 不交付。
10. **独立审片**：材料 = 拼图 + QA 报告 + SHOTBOOK 可读版；P0/P1 修完才放行（≤3 轮）。
11. **交付**：两遍 loudnorm（第一遍量测、第二遍 `linear=true`）→ 复跑 `sfx_check --mix` → 入媒资库
    `kind=final_cut`、`pipeline_kind=explainer`。

## 四、命令速查

```bash
# 引擎安装/体检（不入库；安装期从上游按 PINNED 拉取）
pnpm talkcraft:install -- --with-runtime --with-asr
pnpm talkcraft:check

# 一条命令出片（真机验收/运维路径；与服务端 video.explainer.* 共用 pipeline）
pnpm explainer:run -- \
  --script var/scripts/<口播稿>.md \
  --task-id <任务名> \
  --profile <音色档案> \
  --host-portraits bundles/ai-video/library/characters/model-01-chen-zhuo/portraits/v3 \
  --brand-product "<产品名>"

# 单镜返修（只重渲该段±邻段）
pnpm explainer:run -- --script ... --task-id 同上一任务 --render-scope changed:s07
```

## 五、纪律（违反必出事故，逐条都有实战来历）

1. **顺序不可换**：预剪 → 时间戳 → 一切后续。换配音必须重跑对齐（音频 sha256 进档案）。
2. **节拍不手敲**：一切落点由 `timing.json` 查得；手敲的近似秒数静帧 QA 看不见（历史上早 2 秒）。
3. **卡不重写**：动效实现以引擎 `template/cards/<slug>.tsx` 原文为准，只允许改 CONFIG/文案（`card_lint` 保真闸）。
4. **一镜一主角**：同一时刻只能有一个重音；元素说完就让位（降权留守，不是消失）。
5. **版式轮换**：同卡不连用 3 镜；人物形态与素材容器至少换其一。
6. **字幕素排**：整句硬现硬走、无动效、无标点；竖屏安全区（避开平台文案区与点赞栏）。
7. **音效克制**：单记 ≤0.35、同帧最多一记、连续揭示类不配音效。
8. **许可不越线**：引擎是 PolyForm Noncommercial，商用交付前必须有作者书面授权；引擎源码永不入库。

## 六、失败模式与处置

| 症状 | 根因 | 处置 |
|---|---|---|
| `引擎未安装完整` | `vendor/talkcraft/` 缺文件（未装或被清） | `pnpm talkcraft:install -- --with-runtime` |
| `许可闸拒绝渲染` | `authorized` 但无 `LICENSE-GRANT.md` | 取授权文件；评估期可切回 `noncommercial`（不得对外商用交付） |
| 成片整体偏一拍 | 段边界取整与 Sequence 不一致 / 手敲节拍 | 重跑 `beat_lint`；确认 `--shots` 与 `props.total` 同源 |
| 画面"像 PPT" | 相机曲线缺失或静止窗 >1s | 跑 `motion_check`，补相机极缓推进（不是加呼吸动效） |
| 音效"在场但听不见" | cue 全埋在人声里 | 跑 `sfx_check --mix`，把 cue 挪到句间 ≥0.5s 气口 |
| 卡被"神似化"重写 | 未复制卡原文直接手写 | `card_lint` 会 FAIL；从引擎重新复制该卡 |
| 渲染中途断电 | —— | 段缓存保留；重跑同命令只渲缺失段（幂等键防重复提交） |

## 七、验收口径（交付前必答）

- 机器闸六条是否全 PASS（SKIP 必须写理由）？
- `beat_lint` 的 |Δ| 最大值与镜尾保护带最小值是多少？
- `card_lint` 覆盖了本片用到的每一张卡吗？
- `qa_extract` + `contact_sheet` 的拼图是否进了独立审片，P0/P1 是否清零？
- 交付文件的 `sha256`、时长、响度（I/TP/LRA）与媒资库记录是否一致？
