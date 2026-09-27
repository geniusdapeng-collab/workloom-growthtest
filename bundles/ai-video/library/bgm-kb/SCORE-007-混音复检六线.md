# 混音复检六线（Mix Verification Lines）领域知识库

> **用途**：配乐工位的复检判读知识库。供数字员工 / Agent 在配乐混音完成后、交付打包前，判读 `bgm_report` 回执里的复检数据时检索调用。
> **主题编号**：SCORE-007　**版本**：v1.0　**更新日期**：2026-09-27
> **使用方式**：Agent 拿到复检报告（`checks` / `warnings` / `levels` / `loudness` / `alignment`）或 `verify_failed` 错误时，检索本主题，逐线对照阈值定位根因，按"调参重混 → 换选段 → 换曲 → 删产物"的处置路径行动。**所有阈值以 `recipes.json` 的 `targets` 为准，本仓实测口径以 measure.mjs / core.mjs 为准，禁止凭耳听或凭计算值宣称达标**。

---

## 一、核心概念

### 1.1 复检是什么

复检（Verify）是**混音完成后对产物音频的实测回读**——不是检查参数有没有写对，而是检查参数写出来之后，**落到文件里的声音到底对不对**：

> **参数是承诺，实测是证据。混音报告里没有实测值的"达标"，等于没有发生。**

核心纪律（来自 core.mjs 头注与 SKILL 第六节）：

- **无回执不算完成**：产物必须给出 sha256 + 响度 / 人声余量 / 可闻度的实测复检；
- **fail-closed（失败关闭）**：测不到 = 未核实 = 拒绝交付，绝不把 `null` 解释成"差不多达标"；
- **不伪造**：解析不到就抛带稳定 code 的错误（`verify_failed` / `engine_failed`），由上层决定重试或转人工。

### 1.2 复检的位置：为什么查两次

配乐链路里复检出现在**两个位置**，缺一不可：

| 位置 | 查什么 | 为什么不能省 |
|---|---|---|
| **混音后（mix 内）** | 六线全查：响度 / 真峰值 / 余量 / 可闻度 / 卡点 / 让位 | 发现不合格可以立刻调参重混，成本最低 |
| **合流后 / 交付前（deliver）** | 对**最终产物文件**（已编码 AAC、已与视频合流）回读 loudness、再对 sha256 | loudnorm 的计算值不等于落盘值；AAC 编码会抬真峰值；交付清单 `delivery-manifest.json` 只认最终文件实测 |

关键实现：**两遍法 loudnorm 之后必须回读**。第一遍 `measureLoudness` 测出 `measured_I/TP/LRA/thresh`，第二遍 `loudnorm=...:linear=true:measured_*=...` 应用——但应用后的真实响度**不信计算值**，core.mjs 在合流出 `output` 后再跑一遍 `measureLoudness(output)` 得到 `loudnessAfter`，复检判的是 `loudnessAfter`，不是配方里的 `-14`。真峰值同理：应用时主动留 0.5dB 余量（`applyTruePeak = truePeak - 0.5`），因为"TP 是上限不是保证值，贴边设置实测会越界（实测 -0.74dBTP > -1.0 目标）"。

### 1.3 六线总览（recipes.json targets 真值）

| 复检线 | 阈值 | 超阈值行为 |
|---|---|---|
| 综合响度 `lufsIntegrated` | **[-15, -13]**（目标 -14，复检容差 ±1.5 LU） | 超差记 `loudness_ok=false`，不得宣称达标 |
| 真峰值 `truePeakDbtpMax` | **≤ -1.0 dBTP** | 闭环下压（trimMaster）后复测；仍超记 `true_peak_ok=false` |
| 人声-音乐余量 `dialogueToMusicMarginDb` | **≥ 6 dB**（<3dB 直接失败） | 3–6dB 记 warning；**<3dB → verify_failed 删产物** |
| 配乐可闻度 `musicPresenceDb` | **≥ 3 dB** | **<3dB 或测不到 → verify_failed 删产物** |
| 卡点 `alignmentMeanAbsErrorMs` | **≤ 60 ms**（±80ms 记落拍，达标率 ≥60%） | 不达标记 `unaligned` warning，换配方或按剪辑点定速 |
| 削波/底噪（astats 口径） | 底噪侧 `silencedetect noise=-38dB`；削波由真峰值线兜 | 素材缺陷如实标注，**不用配乐掩盖** |

---

## 二、分类速查

### 2.1 实测方法对照（measure.mjs / core.mjs 真实实现）

| 复检线 | 实测手段 | 代码出处 |
|---|---|---|
| 响度/真峰值 | `loudnorm print_format=json` 测 `input_i/input_tp/input_lra`；应用后对 output 再测一遍 | `measure.mjs: measureLoudness` / `core.mjs: normalizeLoudness + loudnessAfter` |
| 人声-音乐余量 | 人声活动窗（200–4000Hz 带通 + silencedetect -38dB/0.35s）内：`finalInVoiceBand − duckedInVoice` | `core.mjs: speechToMusicMarginDb` |
| 可闻度 | 安静窗内：`finalInQuiet − sourceInQuiet`（成品 vs 原片同窗口电平差）；兜底 `duckedInQuiet − roomTone` | `core.mjs: musicPresenceDb / presenceBasis` |
| 让位深度 | **对照实验**：同一条音乐链渲一版不挂侧链的对照，同人声窗比较 `让位后 − 对照`（负值，≤-4 判 applied） | `core.mjs: control-music / duckingDepthDb` |
| 卡点 | scene 检测（阈值梯度 0.35→0.02 自适应分级）→ 剪辑点加权落拍误差 | `measure.mjs: detectCuts` / `core.mjs: alignBeatGrid` |
| 底噪 | 静音窗内 `volumedetect mean_volume` 得 `roomToneDb` | `core.mjs: roomTone` |
| 削波/包络 | 解码 PCM 自算能量包络（8kHz 单声道、0.25s 窗 RMS） | `measure.mjs: decodePcm / energyEnvelope` |

> **为什么削波不用 astats 逐帧日志**：measure.mjs 明确注释——"`astats` / `ebur128` 的逐帧日志语义随版本变化（实测 reset 行为不稳定）"，所以本仓把音轨解码成 PCM 自己算包络与峰值，确定、可复现、可单测。削波的最终防线是**真峰值线**（≤ -1.0 dBTP）+ loudnorm 闭环下压，素材原生削波则按"不可修复"退回上游（见三·6）。

### 2.2 判定字段速查（bgm_report.checks）

| 字段 | 判真条件 | 备注 |
|---|---|---|
| `checks.loudness_ok` | `|integratedLufs − (−14)| ≤ 1.5` | 即落进 [-15.5, -12.5]，交付口径讲 [-15, -13] |
| `checks.true_peak_ok` | `truePeakDbtp ≤ -1.0 + 0.2`（测不到按通过） | 0.2dB 是测量容差，交付陈述仍写 ≤-1.0 |
| `checks.music_audible` | `musicPresenceDb ≥ 3`；**null 判 false** | fail-closed：测不到 = 不合格 |
| `checks.dialogue_preserved` | `speechToMusicMarginDb ≥ 3`（测不到按通过） | 6dB 是目标，3dB 是生死线 |
| `checks.ducking_applied` | `duckingDepthDb ≤ -4`（music-only 恒真） | 目标深度在配方 [8,14]dB 区间 |

`music_audible` 或 `dialogue_preserved` 任一 false → **删产物 + 抛 `verify_failed`**（NEVER_RETRY：测不到时重试也测不到，不是电平问题）。

---

## 三、分场景实战（六线逐条深挖）

### 3.1 综合响度 lufsIntegrated [-15,-13]（目标 -14）

- **实测**：loudnorm 两遍法后回读 `loudnessAfter.integratedLufs`。
- **典型根因**：① 原片自身响度偏离大，linear 模式增益不足/过量；② BGM 电平过高把整体拉上去；③ LRA 过大的素材归一化后"高潮不够响、铺垫太吵"。
- **处置**：响度偏离先动 `target_lufs` 附近归一参数再复测；伴随余量不足时**先降 `music_level_db` 再重归一**（降 BGM 同时会降 integrated，一次解决两线）。超差只许记 `loudness_ok=false`，不许写"已优化"。

### 3.2 真峰值 truePeakDbtpMax ≤ -1.0 dBTP

- **实测**：`loudnessAfter.truePeakDbtp`；应用端已预留 0.5dB 余量。
- **典型根因**：loudnorm 的 TP 是上限不是保证值，贴边必越界；AAC 编码进一步抬峰。
- **处置**：core.mjs 已有**闭环**——首测越线则 `trimMaster` 整体下压（只减不增，`masterTrimDb` 写进报告）再复测；仍越线记 `true_peak_ok=false`。**禁止**为压峰值去开大压缩糊掉动态。

### 3.3 人声-音乐余量 dialogueToMusicMarginDb ≥ 6

- **实测**：人声窗（带通 200–4000Hz）内 `成品人声频段电平 − 让位后 BGM 电平`。
- **典型根因**：`music_level_db` 太高（音乐太响）；让位深度不够（`duckingDb` 低于配方值，如访谈片该 14 只给了 8）；侧链阈值换算被钳位（`deriveDuckParams` 钳到 [-60,-6]dB）。
- **处置**：先下调 `music_level_db`（每次 2–3dB）重混；不够再加深 `duckingDb` 向配方上限靠；仍不足检查侧链频段是否为 200–4000Hz。**3–6dB 记 warning，<3dB verify_failed 删产物**。

### 3.4 可闻度 musicPresenceDb ≥ 3（低于此 verify_failed 删产物）

- **实测**：安静窗 `finalInQuiet − sourceInQuiet`；无绝对静音时用"相对安静窗"（silencedetect 阈值抬高 12dB 再找一次，`quietWindowSource=relative-quiet(noise+12dB)`）；仍无 → room-tone 基准；三皆无 → `presenceBasis=none`。
- **典型根因**：`music_level_db` 太低或 ducking 过度（让位太深把音乐压没）；选段选了能量过低的段落；连续现场声/连续口播导致**测不到**。
- **处置**：分清"测得偏低"与"测不到"——偏低就抬电平/换段；测不到（`presenceMeasured=false`）是**不可重试**的 `verify_failed`，按 `explainMusicAudibility` 指引：改用带人声间隙的素材，或指定 section 片段复用后在有人声间隙处复检再重试本变体。**宁可无 BGM，也不交"配了跟没配一样"的片**。

### 3.5 卡点 alignmentMeanAbsErrorMs ≤ 60（±80ms 落拍，达标率 ≥60%）

- **实测**：剪辑点（显式 `cutTimes` 优先，否则 scene 检测分级）按分值加权对拍格，报平均绝对误差。
- **典型根因**：配方 BPM 与剪辑节奏不匹配；快剪片里"音频起音"被误当剪辑点（台词音节级起音 → BPM 反推落空）；单镜到底无剪辑点。
- **处置**：给显式剪辑网格（`cut_times`）+ `bpmStrategy=cut-driven` 按真实剪辑定速；或换 BPM 更接近的配方。无剪辑点如实标注"退回节拍网格"，`unaligned` 只记 warning，**不是删产物线**。

### 3.6 削波/底噪（astats 口径）

- **实测**：底噪 = 静音窗 `roomToneDb`（-38dB silencedetect 口径）；削波防线 = 真峰值线 + PCM 包络峰值（不用 astats 日志，见二·1 注）。
- **典型根因**：**素材原生问题**——对白已削波、底噪过大。这是上游（拍摄/渲染）事故，混音修不了。
- **处置**：如实标注并**退回上游**；底噪大导致可闻度难达标时，`suggestedMusicLevel` 已被钳在 [-30,-16] 区间（`roomTone + 10`），不得为盖底噪把 BGM 推到区间外——**不用配乐掩盖素材缺陷**。

---

## 四、视频特有规则

1. **复检在混音之后、交付之前还要再查**：mix 内六线全查是为了低成本返工；deliver 阶段对最终文件（AAC 编码 + 视频合流后）回读 loudness 与 sha256，是因为编码与合流会改变实测值，`delivery-manifest.json` 只认落盘文件。
2. **两遍法之后必须回读**：`loudnessAfter` 是对 `output` 的实测，不是对 `measured_*` 参数的复述。任何"按计算应该达标"的陈述都是违规。
3. **平台变体从已配乐母版派生，不重新混音**：9:16/时长裁剪只派生不重混（否则同片不同响度/不同让位）；派生变体如需响度归一，记为"平台派生"而非"重新配乐"，且每个变体的复检数据独立留证。
4. **无视频轨不豁免复检**：纯音频输入退回节拍网格对齐（`detectCuts` 返回 `note: 输入无视频轨`），其余五线照查。
5. **软失败不是免检**：桥不可达/超时 → `receipt.synced=false` 挂起转人工，**不伪造成功回执**；复检数据缺失的产物同样不得交付。

---

## 五、常见误区

| 误区 | 纠正 |
|---|---|
| "参数写对了就等于达标" | 只信回读。`loudnessAfter` 是对 output 的实测，两遍法的计算值不作数 |
| "真峰值设 -1.0 就一定是 -1.0" | TP 是上限不是保证值，贴边实测会越界（本仓实测 -0.74）；所以应用端预留 0.5dB + trimMaster 闭环 |
| "可闻度测不到 = 音乐太轻，加大音量重试" | 测不到（`presenceBasis=none`）是窗口问题不是电平问题，`verify_failed` 明确不可重试；换带人声间隙的素材或指定 section 复检 |
| "余量不足就整体降音量" | 降整体会连人声一起降、响度线跟着挂。正确顺序：先降 `music_level_db`，再加深 `duckingDb` |
| "卡点不达标就删产物" | 卡点是 warning 线不是生死线；生死线只有可闻度 <3dB 与余量 <3dB 两条 |
| "底噪大就把 BGM 调响盖过去" | 素材缺陷如实标注退回上游，不用配乐掩盖；电平已被钳在 [-30,-16] |
| "复检不过就跳过复检再跑一次" | 禁止关闭复检（围栏 G-BGM3）；`skip_verify` 是违规路径 |
| "删了产物任务就算失败结案" | 删产物后走降级链路：调参重混 ≤3 次 → 换选段 → 换曲 → 转人工，不许静默无 BGM 交付 |

---

## 六、意图→参数映射表

| 复检项/症状 | 中文写法 | 英文关键词/参数 |
|---|---|---|
| 综合响度超差 | 响度落在 [-15,-13] 之外，记 loudness_ok=false | `lufsIntegrated`, `lufsTarget=-14`, `loudness_ok`, `measureLoudness` |
| 真峰值越线 | 真峰值超 -1.0 dBTP，闭环下压再复测 | `truePeakDbtpMax=-1.0`, `true_peak_ok`, `trimMaster`, `masterTrimDb` |
| 音乐太响压人声 | 人声-音乐余量不足 6dB，先降音乐电平 | `dialogueToMusicMarginDb=6`, `speechToMusicMarginDb`, `music_level_db` |
| 人声被压住（生死线） | 余量 <3dB，删产物重混 | `dialogue_preserved`, `verify_failed`, `duckingDb [8,14]` |
| 配了跟没配一样 | 可闻度 <3dB，verify_failed 删产物 | `musicPresenceDb=3`, `music_audible`, `presenceMeasured` |
| 可闻度测不到 | 连续现场声无安静窗，不可重试 | `quietWindowSource=relative-quiet(noise+12dB)`, `presenceBasis=none`, `explainMusicAudibility` |
| 音乐听不见 | 电平太低或让位过度，抬电平或换段 | `musicLevelDbRange [-30,-16]`, `duckingDepthDb`, `section=climax` |
| 让位太浅/太深 | 对照实验实测侧链深度，目标 ≤-4dB | `ducking_applied`, `sidechaincompress`, `control-music`, `deriveDuckParams` |
| 卡点不齐 | 平均误差 >60ms，按剪辑点定速 | `alignmentMeanAbsErrorMs=60`, `cut-driven`, `cutTimes`, `±80ms 落拍` |
| 底噪过大 | 静音窗底噪实测，退回上游不掩盖 | `roomToneDb`, `silencedetect noise=-38dB`, `volumedetect` |
| 对白削波 | 素材原生削波不可修复，退回上游 | `energyEnvelope peakDb`, PCM decode（非 astats 日志） |
| 人声频段活动 | 带通能量活动检测（非语音识别） | `voiceBandHz [200,4000]`, `detectVoiceBandSegments`, `band-activity` |

---

## 七、模板

### 模板 A：复检报告判读（拿到 bgm_report 后逐项过）

```
1. checks 五闸：loudness_ok / true_peak_ok / music_audible / dialogue_preserved / ducking_applied
   → 任一 false：若是 music_audible 或 dialogue_preserved → verify_failed 路径（模板 B）
   → 其余 false → 记"未达标"+ 实测值，不得写"已优化"
2. warnings 逐条：余量 3–6dB / 让位 >-6dB / 卡点 unaligned / 安静窗 BGM 高过人声
   → 按第三章对应根因调参，重混后**重新复检**（不是改完就算）
3. levels 证据：speechToMusicMarginDb / musicPresenceDb / duckingDepthDb（对照口径为准，
   duckingContrastDb 仅回归参考）/ roomToneDb
4. loudness 证据：before/after + masterTrimDb（trim ≠ 0 说明发生过闭环下压）
5. alignment：meanAbsErrorMs / 达标率 / 采用 BPM 与依据（cut-driven 还是 recipe）
6. voiceActivity：quietWindowSource 与 presenceBasis（区分"测得偏低"与"测不到"）
```

### 模板 B：verify_failed 处置（删产物后的降级链路）

```
verify_failed 触发（产物已删，不得交付）
  │
  ├─ music_audible=false 且 presenceMeasured=true（测得偏低）
  │     → 抬 music_level_db 2–3dB 或换更高能选段 → 重混复检（重试 ≤3 次）
  ├─ music_audible=false 且 presenceMeasured=false（测不到，不可重试）
  │     → 换带人声间隙的素材 / 指定 section 片段在间隙处复检 → 再试本变体
  ├─ dialogue_preserved=false（余量 <3dB）
  │     → 降 music_level_db → 加深 duckingDb（向配方 [8,14] 上限）→ 重混复检
  └─ 三级取曲链降级：在线曲源 → 本地曲库 → 自算作曲（attempts 逐级留痕，降级不静默）
       仍失败 → 转人工；软失败记 receipt.synced=false 挂起，不伪造成功回执
```

### 模板 C：bgm_report 证据包（交付必备字段）

```
output.path + output.hash（sha256，磁盘文件与回执对得上）
bgm：配方 id/曲目 id + sha256 + appliedGainDb
loudness.before / loudness.after（integrated / truePeak / lra）+ masterTrimDb
levels：speechToMusicMarginDb / musicPresenceDb / duckingDepthDb / roomToneDb
checks + warnings（未达标项如实列出）
alignment：达标率 / meanAbsErrorMs / bpm 与依据
voiceActivity：quietWindowSource / presenceBasis
evidence：waveform-before-after.png（+ 选段时 section-picked.png）
license：reviewed / commercialUse（外部曲目附署名文件）
```

---

## 八、决策树

```
复检报告到手
  │
  ├─ ① 逐项核对 checks 五闸
  │     ├─ loudness_ok=false → 响度线（3.1）：先查是否伴随余量不足，
  │     │     是则先降 music_level_db 再重归一 → 复检
  │     ├─ true_peak_ok=false → 真峰值线（3.2）：trimMaster 已闭环仍越线
  │     │     → 记未达标，禁开压缩糊动态 → 复检
  │     ├─ music_audible=false → 可闻度线（3.4）
  │     │     ├─ 测得偏低 → 抬电平/换选段 → 重混复检
  │     │     └─ 测不到 → 换素材/指定 section → 复检（不可直接重试）
  │     ├─ dialogue_preserved=false → 余量生死线（3.3）：降电平→加深让位 → 重混复检
  │     └─ ducking_applied=false → 让位线：查侧链频段/阈值钳位 → 重混复检
  │
  ├─ ② warnings 定位根因（不删产物，但不得忽略）
  │     ├─ 余量 3–6dB → 跷跷板：降 music_level_db 会让可闻度变紧，两线一起看
  │     ├─ 让位 >-6dB → 查 deriveDuckParams 阈值与 speechLevel 实测
  │     ├─ 卡点 unaligned → cutTimes + cut-driven 定速，或换配方
  │     └─ 安静窗 BGM 高过人声 → 降电平保现场感
  │
  ├─ ③ 跷跷板组合处置顺序（固定，不许乱跳）
  │     ├─ 响度达标但余量不足（音乐太响）→ 先降 music_level_db（响度跟着降，再重归一）
  │     ├─ 余量达标但可闻度不足（ducking 过度）→ 先减 duckingDb，不够再抬 music_level_db
  │     └─ 可闻度与余量同时告急 → 音乐选段/配器问题（太满或太薄）→ 换段或换曲，不硬调电平
  │
  ├─ ④ 处置执行：调参重混（≤3 次）→ 换选段 → 换曲（三级取曲链）→ 转人工
  │
  └─ ⑤ 复检闭环：每次处置后重新跑完整六线，全部 checks=true 且 warnings 清零/有解释
        → 写 bgm_report 证据包 → 进 deliver 阶段对最终文件再查一遍（回读 + sha256）
        → 仍不过：宁可无 BGM，不交不合格品（verify_failed 已删产物）
```

---

## 九、关联知识

- **SCORE-001 电平口径**：`music_level_db` 区间 [-30,-16]、让位深度 [8,14]dB、人声频段 200–4000Hz 等电平侧参数——复检六线的"上游变量"，调参处置时与本主题联合检索。
- **SCORE-004 平台响度与交付差异**：-14 LUFS / -1.0 dBTP 的交付口径来历、平台归一化行为（经验口径）、48k/AAC 192k/视频 copy 规格——复检第一、二线的目标值出处。
- **bgm-audio-layering（SKILL）**：四种分层策略、deriveDuckParams 换算公式、复检线与失败纪律原文（可闻度 <3dB → verify_failed；桥不可达 → `receipt.synced=false` 软失败转人工）。
- **bgm-delivery-spec（SKILL）**：证据包九件、返工归因表、诚实上报条款（3–6dB 记告警、卡点 <60% 记未对齐、素材缺陷不可修复）。
- **bgm-vocal-separation（SKILL）**：对白已削波/底噪极大的退回上游纪律——复检第六线的素材缺陷判据。

> 复检问题先按本主题逐线定位；涉及"为什么定这个数"联查 SCORE-004，涉及"调哪个参数"联查 SCORE-001 与 bgm-audio-layering；删产物后的降级与转人工按 bgm-delivery-spec 与围栏 G-BGM0..G-BGM5 执行。
