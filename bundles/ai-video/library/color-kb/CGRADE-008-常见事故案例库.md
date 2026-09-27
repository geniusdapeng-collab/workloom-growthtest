# CGRADE-008 常见事故案例库

调色链路真实事故的结构化失败案例库。案例本体在 `failure-cases/` 目录，一案例一文件；本文件负责机制说明、速查与决策入口。

## 一、核心概念

**为什么要有失败案例库**：调色链路的典型事故（强度失效、白平衡误判、"调了跟没调一样"、把成片调坏）都不是一次性的——同类根因会以新面目复发。把事故复盘固化为结构化案例，让"检测器→根因→处置→预防"可检索、可引用、可审计。

**案例入库机制**（事故复盘 → 结构化 → 引用）：

1. **事故发生与复盘**：真机事故或代码自注暴露失败模式后，先在当时载体留痕——代码注释（如 core.mjs 事故注释）、SKILL.md 事故复盘段、manifest 缺口自注。
2. **结构化**：按统一模板（见第七章）整理成案例文件，症状/检测器/根因/处置/预防五段必填；检测器必须可执行（ffmpeg 命令、colorread.\* 工具、signalstats 阈值），不得写"人工观察"了事。
3. **引用**：案例编号回填到 SKILL 失败模式表/硬红线注释中，使"纪律条文 ↔ 事故证据"双向可追；涉及 roadmap 的缺口在案例"状态"字段标注任务号。
4. **日期纪律**：发现日期以 git 提交日期或注释明确记载为准；查不到一律写"历史遗留"，**禁止编造**。

**编号规则**：`FC-COL-<三位序号>-<简述>.md`，序号为调色（COL）域内递增、只增不复用；简述用中文短句点出根因（如"blend权重方向错误致look强度失效"）。关联域后续扩展预留 `FC-AUD-`（音频）、`FC-EDIT-`（剪辑）。

## 二、分类速查

| 类别 | 涉及案例 | 共性根因 |
|---|---|---|
| 滤镜语义误用 | FC-COL-001 | 对 ffmpeg 滤镜参数语义理解错误（blend 权重方向） |
| 统计算法假设失效 | FC-COL-002、FC-COL-003 | 灰世界假设/少量抽样在真实素材上不成立 |
| 色彩科学缺口 | FC-COL-004 | 转换链只做 OETF 不做色域矩阵 |
| 可见性/有效性缺失 | FC-COL-005 | 参数低于人眼阈值且无出片验证 |
| 目标体系错误 | FC-COL-006 | 只有统计目标没有画质目标，"优化"变劣化 |
| 指标口径误用 | FC-COL-007 | 外部工具指标（HUEAVG 相位角）与目标区间（HSV 色相）不同口径却直接比较 |
| 检测器缺口 | FC-COL-008 | 交付条款要求"诚实上报"，但没有可执行检测器与阈值 |

## 三、分场景实战

- **log 素材入场**：先 `colorread.probe` 看 `color_transfer/color_primaries`，命中 log 先套 `slog3-to-rec709`（禁止直接叠创意 LUT）；S-Gamut3.Cine 素材传 `source_gamut=sgamut3cine` 链上色域矩阵（FC-COL-004，T-21 已修复）。
- **多切点混剪**：禁止单帧诊断，用默认 4 帧或按切点表传 `at`；多镜必须 `colorwrite.match` 对齐参考镜（FC-COL-003）。
- **强彩光/大面积单色场景**：analyze 回执出现 `whiteBalance.confidence=low` 时不得自动校正，先补 `neutral_patch`（FC-COL-002）。
- **指定强度出片**：交付前读 `visibility.verdict`，subtle/negligible 按 FC-COL-005 / FC-COL-001 顺序排查（先看 blend 方向、再看参数量级）。
- **"帮我自动调一下"**：一律走 `colorwrite.best` 择优，允许结论"不用调"（FC-COL-006）。

## 四、视频特有规则

- 时间维度抽样：视频不是一张图，诊断/校验至少 4 个时间点（首段/前中/后中/尾段），多切点素材按切点加密（FC-COL-003）。
- 逐镜一致性：单镜达标 ≠ 成片达标，镜间残差 |ΔYAVG| ≤ 5、|ΔUAVG|/|ΔVAVG| ≤ 3 才算成片口径。
- 编码链路约束：调色落在 8-bit H.264 交付链，重渲染即再压缩；择优在抽样静帧上做、整片只渲染一次，避免多次编解码累积损伤。
- 回执即证据：每次调色必须带 sha256 + 前后指标 + 可见性度量，无回执=未核实。

## 五、常见误区

- **以为 intensity 是线性强度旋钮**——blend 语义下权重方向写反就恒满档（FC-COL-001）。
- **以为全帧平均色拉灰就是白平衡**——单色场景下这是在抹掉氛围（FC-COL-002）。
- **以为抽一帧达标整片就达标**——多切点素材单帧不代表全片（FC-COL-003）。
- **以为套上转换 LUT 就完成 log 处理**——色域矩阵缺失时饱和照样异常（FC-COL-004）。
- **以为流程走完就是调好了**——没有可见性校验，"调了跟没调一样"也能交付（FC-COL-005）。
- **以为指标进区间就是变好**——没有画质目标的"优化"会把好片调坏（FC-COL-006）。

## 六、案例速查表

| 案例编号 | 症状关键词 | 检测器 | 处置 |
|---|---|---|---|
| FC-COL-001 | 强度参数失效、intensity 调低无变化 | 两档 intensity 出片 + frameDifference 对比；审查 blend 输入顺序 | buildChain 把已调色放第一输入，opacity=intensity |
| FC-COL-002 | 彩光/单色场景白平衡误判、氛围被抹平 | analyze 回执 confidence=low + source=gray-world；\|UAVG/VAVG−128\|>6 人工复核 | 标注 low confidence 不自动校正；补 neutral_patch 精确取样 |
| FC-COL-003 | 多切点素材校正失真、各镜跳变 | 抽样点少且含切点；perFrame 指标跨点波动超容差 | 已修复（T-02）：默认 `sampling=scene` 场景切分抽样、按段时长加权聚合；场景 ≤4 退回 10/35/60/85%；多镜走 match 对齐参考镜 |
| FC-COL-004 | log 素材转换后饱和异常、色相偏移 | probe 查 color_primaries；analyze log_or_flat；oversatPct 异常 | 已修复（T-21）：S-Log3+S-Gamut3.Cine 自动链式应用 `slog3-to-rec709` + `sgamut3cine-to-rec709` 双 LUT；色域不确定时报告 `conversion.note` 注明 |
| FC-COL-005 | 调了跟没调一样、像素差 1.5% | visibility.verdict：negligible(<2/255) 拒付；subtle(2–4) 提醒 | profile 参数按可见性重标定 + 可见性 fail-closed 校验 |
| FC-COL-006 | 自动调色把成片调坏（亮度+33.6/饱和+46%） | scoreQuality 候选分 <100；best verdict=no_change_needed | 引入画质分打分 + best 择优默认入口，允许"不调" |
| FC-COL-007 | 真实肤色被判异常、绿/青被判"健康肤色" | 同帧比较 `skin.hue`（标准 HSV）与 `skin.hueFfmpeg`（HUEAVG）：绿色 HUEAVG∈[20,40] 而 HSV≈110° | 已修复（T-01）：判据改用 `standardHueFromUv`，HUEAVG 仅作证据 |
| FC-COL-008 | 失焦/噪点/色带被"调过了"交付，或正常浅景深被误返工 | `detectDefects`：blurdetect（≥15 不可修复）、噪点差分 YAVG（≥9）、色带 holeRatio（≥0.25） | 已修复（T-03）：检测器 + 阈值 + 证据留痕；交付硬闸 `on_unfixable=block` |

## 七、模板

```markdown
# FC-COL-xxx <标题>

| 字段 | 内容 |
|---|---|
| 编号 | FC-COL-xxx |
| 发现日期 | （git 提交日期，查不到就写"历史遗留"） |
| 严重度 | 高/中/低 |
| 状态 | 已修复 / 已列入 roadmap（任务号）/ 处置中 |

## 症状
（用户/系统观察到的现象）
## 检测器
（可执行的检查命令、工具名或判据——必须具体，如 ffmpeg 命令、colorread.* 工具、signalstats 指标阈值）
## 根因
（技术根因，引用具体文件与代码位置）
## 处置
（当时的修复方式）
## 预防措施
（流程/判据/工具层面的长期预防）
## 关联
（提交 hash、SKILL.md 章节、roadmap 任务号）
```

## 八、决策树

```
发现调色异常
├─ 画面几乎没变？
│   ├─ 是 → 查 FC-COL-005（可见性）→ visibility=negligible？
│   │       ├─ 是 → 再查 FC-COL-001（blend 方向/intensity 语义）
│   │       └─ 否 → 提高 intensity 或换更强 look 重出
├─ 颜色方向不对？
│   ├─ 白平衡/偏色 → analyze 回执 confidence=low？
│   │       ├─ 是 → FC-COL-002：补 neutral_patch 重测
│   │       └─ 否 → 按返工判定表重做校正段（不动 look）
│   ├─ log 素材饱和/色相异常 → FC-COL-004（已修复，T-21）：probe 确认色域 → 传 source_gamut=sgamut3cine 重跑，检查报告 conversion.luts
├─ 各镜头不一致/跳变？
│   └─ 是 → FC-COL-003：检查抽样点数 → colorwrite.match 整批重跑
├─ 自动调色后反而更差？
│   └─ 是 → FC-COL-006：改走 colorwrite.best 择优，接受"无需调色"
└─ 均不命中 → 按第七章模板新立案例，编号回填 SKILL 失败模式表
```

## 九、关联知识

- `color-grade/SKILL.md`：调色执行纪律（五步方法、目标值表、硬红线、2026-09-21 两起事故复盘——FC-COL-005/006 的原始出处）
- `color-delivery-spec/SKILL.md`：调色交付规范（证据包、返工判定表、不可修复清单）
- `bundles/ai-video/connectors/color-bridge/core.mjs`：调色桥内核（buildChain 强度混合、analyze 白平衡、defaultTimestamps 抽样、frameDifference 可见性、scoreQuality 画质分——FC-COL-001/002/003/005/006 的代码现场）
- `bundles/ai-video/library/luts/manifest.json`：LUT 清单（FC-COL-004 出处；缺口自注已随 T-21 移除）
- 入库提交：`729be0a`（2026-09-24，color-bridge/SKILL/luts 一并入库；事故本体日期以代码注释与 SKILL 复盘记载为准）
