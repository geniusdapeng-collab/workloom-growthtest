# 示波器与数值判读（Scopes & Signalstats）调色知识库

> **用途**：调色执行与质检的"仪表盘手册"。供调色师 / Agent 在诊断（`colorread.analyze`）、出图（`colorread.scope`）、复检（verify）时检索调用。
> **主题编号**：CGRADE-005　**版本**：v1.0　**更新日期**：2026-09-27
> **使用方式**：收到"画面发灰、死黑、过曝、偏色、太艳"等症状描述时，先用本主题把症状翻译成示波器指纹与数值判据，再决定修复手段。**所有阈值均取自本仓 color-bridge（core.mjs）与 color-grade SKILL，禁止凭感觉编造。**

---

## 一、核心概念

### 1.1 为什么调色要看表不看眼

人眼会被三件事欺骗：显示器本身不准（未经校准的消费屏普遍偏亮偏艳）、环境光改变感知（同一画面白天看和夜里看两个样）、视觉适应（盯着偏色画面 30 秒后大脑自动"白平衡"）。示波器和数值统计不疲劳、不受环境影响、跨设备一致——**它是调色交付的唯一仲裁者**。本仓纪律"无回执=未核实"的本质就是：任何"调好了"的宣称都必须附带可复算的数值与 sha256 回执。

### 1.2 本仓的数值判据体系总览

判据来自三条管线，各管一段：

| 管线 | 产出 | 工具 / 代码位置 | 回答的问题 |
|---|---|---|---|
| **signalstats 六指标** | YMIN / YAVG / YMAX / UAVG / VAVG / SATAVG（另有 YLOW/YHIGH/SATMAX/HUEAVG） | `frameStats()`（signalstats + metadata 提取，YUV 原生管线） | 黑位、曝光、白位、色度中性、饱和度是否达标 |
| **肤色复检** | skinHue（HUEAVG，单位°）+ 肤色区 SATAVG | `analyze()` 的 skinPatch 分支 | 有人脸时肤色是否健康 |
| **scoreQuality 画质分** | rmsContrast / satMean / 裁切占比 / 清晰度 | `frameQuality()` + `scoreQuality()` | 调色后画质是变好还是变差（"更艳≠更好"） |

### 1.3 六指标逐项判据（目标值表，Rec.709 / 8-bit 口径）

| 指标 | 含义 | 健康区间 | 超标症状 |
|---|---|---|---|
| **YMIN** | 最暗像素亮度（黑位） | 0–16 | >16 = 黑位漂浮（画面发灰、没"黑下去"）；=0 且 YLOW 占比高 = 死黑 |
| **YAVG** | 全帧平均亮度 | 80–140 | <80 = 欠曝偏暗；>140 = 过曝偏亮（夜景配方允许放宽到 70–120，必须留痕） |
| **YMAX** | 最亮像素亮度（白位） | 235–255 | <235 = 白位不足（画面闷、不通透）；贴满 255 且 YHIGH 占比高 = 高光裁切 |
| **UAVG / VAVG** | 平均色度（蓝-黄轴 / 红-绿轴） | 122–134（≈128±6） | 偏离 128 超 ±6 = 色偏：U>134 偏蓝、U<122 偏黄、V>134 偏红、V<122 偏绿 |
| **SATAVG** | 平均饱和度 | 40–80 | <40 = 发灰寡淡；>80 = 艳俗过载（verify 阶段超上限 +10 即告警） |
| **skinHue** | 肤色区色相角 | 20–40°，且肤色区 sat ≤60 | 出界 = 肤色跑偏（发青/发绿/发橙），先修白平衡再谈风格 |

### 1.4 scoreQuality 的双健康区间

画质打分（基准 100 = 原片）用另一条 0–1 归一化口径：

- **rmsContrast 22–45**：亮度标准差。低于 22 发灰发闷，高于 45 反差发硬。朝区间移动加分（封顶 +8），偏离扣分（封顶 −15）。
- **satMean 0.22–0.48**：平均饱和（归一化）。低于 0.22 发灰，高于 0.48 发艳。朝区间移动加分（封顶 +6），偏离扣分（封顶 −12）。
- **裁切零容忍**：shadowClipPct（y≤4 像素占比）+ highlightClipPct（y≥251 像素占比）每增加 1 个百分点扣 2.5 分——信息丢了找不回来。

---

## 二、分类速查

### 2.1 三类示波器分工

| 示波器 | 看的是什么 | 对应数值判据 | 本仓滤镜调用（core.mjs SCOPE_FILTERS） |
|---|---|---|---|
| **waveform 波形图** | 亮度在画面横轴上的分布 | YMIN / YAVG / YMAX / YLOW / YHIGH | `waveform=filter=lowpass:scale=ire:graticule=green:flags=numbers+dots,format=rgb24` |
| **vectorscope 矢量示波器** | 色度（色相+饱和）的平面分布 | UAVG / VAVG / SATAVG / skinHue | `vectorscope=mode=color:graticule=green:flags=white,format=rgb24` |
| **histogram 直方图** | RGB 三通道像素值频次 | 色偏（通道错位）、对比形态、裁切 | `histogram=display_mode=stack,format=rgb24` |

### 2.2 waveform 读法

- **纵轴是亮度（IRE 刻度），横轴对齐画面横轴**——波形上某个位置的高度 = 画面同一列像素的亮度。
- **黑位判断**：波形底部应贴近 0 IRE 线但不堆积成一条死线。底部悬空（最低处明显高于 0）→ YMIN>16，黑位漂浮发灰；底部糊成一条粗亮线 → 大量像素压在 0，死黑。
- **白位判断**：波形顶部应接近 100 IRE（对应 8-bit 235–255）。顶到天花板被"削平"→ 高光裁切；顶部离顶很远 → 白位不足，画面闷。
- **裁切识别**：`analyze()` 用 YLOW/YHIGH 像素计数量化——压死或裁切像素占比 >1% 即报 shadow_crush / highlight_clip 警告。
- **曝光判断**：波形主体（最密集区）的位置对应 YAVG。整体压在下半区 → YAVG<80 欠曝；顶在上半区 → YAVG>140 过曝。

### 2.3 vectorscope 读法

- **中心 = 无色（黑白灰），半径 = 饱和度，角度 = 色相**。所有无彩色像素都应落在圆心。
- **中性判据**：图迹中心应正对圆心——对应 UAVG/VAVG≈128（122–134 区间）。整体图迹偏向某个方向偏离圆心 → 色偏，偏的方向就是偏色的色相。
- **饱和度半径**：图迹伸展的平均半径对应 SATAVG（40–80 为适度）。缩成中心一小团 = 低饱和；撑到接近图框边缘甚至贴边 = 饱和过载（frameQuality 口径：sat>0.92 且 mx>60 计为 oversat）。
- **肤色线**：vectorscope 上从圆心向左上方（约 11 点钟方向）延伸的参考线就是肤色线。人脸像素的图迹应落在这条线附近——对应 **skinHue 20–40°**。偏离肤色线：往黄绿方向跑 = 肤色发菜，往品红跑 = 肤色发猪肝。有人脸必须复检（skill 红线）。

### 2.4 histogram 读法

- 本仓用 `display_mode=stack` 把 R/G/B 三通道直方图堆叠显示。
- **色偏识别**：三个通道形态相似但整体横向错位 = 色偏。B 通道整体右移（高值多）= 偏蓝；R 通道右移 = 偏红。与 vectorscope 图迹偏心互为印证，落到数值上就是 UAVG/VAVG 偏离 128。
- **对比度形态**：直方图铺满全宽 = 对比充分（对应 rmsContrast 22–45 区间）；挤在中间一小段 = 发灰（rmsContrast<22）；两端顶出边界形成"墙" = 两头裁切。
- **与 waveform 的分工**：waveform 保留空间位置（哪块天空爆了），histogram 只看总体统计（爆了多少像素）。判裁切两个一起看。

### 2.5 数值→示波器对照速查

| 数值组合 | 示波器指纹 |
|---|---|
| YMIN>16 + rmsContrast<22 | waveform 底部悬空 + 整体压扁，histogram 挤中段 |
| YLOW 占比>1% | waveform 底部糊死线，histogram 左端顶墙 |
| YMAX<235 | waveform 顶部离顶，画面闷 |
| YHIGH 占比>1% | waveform 顶部削平，histogram 右端顶墙 |
| UAVG>134 或 <122 | vectorscope 图迹偏蓝/偏黄方向，histogram B 通道错位 |
| SATAVG<40 / satMean<0.22 | vectorscope 图迹缩成中心小团 |
| SATAVG>80 / satMean>0.48 | vectorscope 图迹撑满贴边 |
| skinHue 出 20–40° | vectorscope 肤色图迹偏离肤色线 |

---

## 三、分场景实战

### 3.1 常规交付质检（白天下限口径）

走完整五步（probe → analyze → correct → look → verify）后，用目标值表逐项过：YMIN 0–16、YAVG 80–140、YMAX 235–255、UAVG/VAVG 122–134、SATAVG 40–80；有人脸加 skinHue 20–40° 且 sat≤60。任何一项出界，回到对应修复手段，**一次只改一个变量**，改完复检。

### 3.2 夜景 / 暗场题材

夜景配方（night-city）允许 YAVG 放宽到 70–120（低于白天下限 80），但必须留痕说明；**暗部裁切比不得超 3%**——夜景死黑会放大噪点。波形读法相应调整：主体密集区允许压在下半区，但底部不能糊死线，灯牌高光不能削平。

### 3.3 高端低饱和题材

luxury-brand 配方口径 SATAVG 25–50、YAVG 85–130：vectorscope 图迹本就偏小团，**不能用全局 40 下限误判为发灰**。判据要用配方 overrides 而非全局 targets。黑位要求"深而不死"：暗部裁切 <1%。

### 3.4 多镜匹配验收

多镜匹配后看残差而非绝对值：|ΔYAVG| ≤ 5、|ΔUAVG| / |ΔVAVG| ≤ 3。三镜并排放 waveform，波形形态应大致重合；vectorscope 图迹中心应落在同一位置。残差超标 = 匹配没做好，回 `colorwrite.match` 重做。

### 3.5 疑似 log 素材识别

`analyze()` 的判据：color_transfer 为 arib-std-b67 / smpte2084，**或 YMAX−YMIN < 120**（动态范围偏平）。示波器指纹：waveform 整体挤在中段、两头都够不到边；histogram 收窄；vectorscope 图迹偏小。处置纪律：先套转换 LUT（本仓 slog3-to-rec709），**禁止在 log 上直接叠创意 LUT**。

---

## 四、视频特有规则

1. **抽帧不代表全片**：诊断默认抽 4 帧（时长 10% / 35% / 60% / 85% 处），多切点素材用 1–2 帧会失真。判"全片达标"必须看多帧汇总（`summarize` 取均值），不能用单帧说事。
2. **示波器图要标注时间码**：本仓产物文件名自带时刻（`{片名}-{waveform|vectorscope|histogram}-t{秒}s.png`），引用证据时必须连同时间码一起给，否则无法定位问题镜头。
3. **scope 是静帧，视频是动的**：单帧 scope 合格不等于镜头内不闪烁。曝光/白平衡修复后要多抽几帧复检数值稳定性，尤其是运镜穿过明暗区的镜头。
4. **文件名禁用"@"**：事件账本会对形似邮箱的字符串做 PII 脱敏，证据路径里出现"@"会被打码（core.mjs 注释明示的纪律）——引用证据包路径时不要自行改名加"@"。
5. **数值达标≠画质变好**：统计区间只是"不许变差"的底线。最终裁决看 scoreQuality：对比度/清晰度下降重罚、裁切零容忍、亮度漂移受罚；最佳候选没超过阈值（默认 +2 分）就判"无需调色"，不产出文件。

---

## 五、常见误区

| 误区 | 纠正 |
|---|---|
| "我显示器上看着挺好" | 未校准屏不可信。交付判据只看数值区间与 sha256 回执，不看任何人的屏幕 |
| "YAVG 进了 80–140 就万事大吉" | 平均值会骗人：一半死黑一半过曝平均也能落 110。必须同时看 YMIN/YMAX、YLOW/YHIGH 占比和 waveform 形态 |
| "饱和度越高越艳越好看" | SATAVG>80 或 satMean>0.48 即判过载，scoreQuality 双向罚。高级灰才是主流，艳=廉价 |
| "色偏靠降饱和压下去" | 色偏是 UAVG/VAVG 偏 128，降饱和只会让画面变灰，色度中心还是歪的。正确路径：先做白平衡（colorbalance 反向微调） |
| "肤色不对就单独降肤色饱和" | 肤色跑偏（skinHue 出 20–40°）九成是白平衡问题。先修白平衡再动饱和，肤色优先于风格化 |
| "波形没顶到 100 IRE 就是欠曝" | 画面里本来没有白色物体时 YMAX 自然不到 235。看波形要结合画面内容，白位判据只约束"应当有白"的场景（如白底产品图要求 YMAX≥240） |
| "一张 scope 图代表整条片子" | scope 是单时刻静帧。多切点素材必须按 4 帧抽样纪律出图，跨镜对比用残差判据 |
| "histogram 顶墙一点点没关系" | 裁切是信息永久丢失，判据就是 >1% 即警告，scoreQuality 每 +1% 扣 2.5 分。零容忍 |

---

## 六、意图→参数映射表

> 规则：症状 → 判据指标 → 修复手段，全部对齐本仓真实阈值与滤镜。

| 创作意图/症状 | 中文写法 | 英文关键词/参数 |
|---|---|---|
| 画面发灰、不通透 | YMIN>16 或 rmsContrast<22：黑位漂浮、对比不足 | eq=contrast 上调；curves 压黑位到底（目标 YMIN 0–16） |
| 欠曝偏暗 | YAVG<80：平均亮度低于下限 | eq=brightness≈(110−YAVG)/255、gamma≤1.35（autoCorrections 口径） |
| 过曝偏亮 | YAVG>140：平均亮度高于上限 | eq=brightness 负向微调、gamma≥0.75；配合 curves 收顶 |
| 暗部死黑 | YLOW 占比>1%：shadow_crush | curves 抬底或降低对比；夜景允许裁切 ≤3%、高端题材 <1% |
| 高光裁切 | YHIGH 占比>1% 或 YMAX 贴 255：highlight_clip | curves 收顶或降曝光；白底场景反向要求 YMAX≥240 |
| 偏蓝/偏黄 | UAVG 出 122–134（U>134 偏蓝、U<122 偏黄） | colorbalance bm/bh 反向微调（shift=−(UAVG−128)/400，±0.06 封顶） |
| 偏红/偏绿 | VAVG 出 122–134（V>134 偏红、V<122 偏绿） | colorbalance rm/rh 反向微调（shift=−(VAVG−128)/400，±0.06 封顶） |
| 发灰寡淡（饱和低） | SATAVG<40 或 satMean<0.22 | eq=saturation 上调（≤1.2，有人物红线） |
| 饱和过载 | SATAVG>80 或 satMean>0.48 或 oversatPct 上升 | eq=saturation 下调（≥0.8），复检肤色 |
| 肤色跑偏 | skinHue 出 20–40° 或肤色区 sat>60 | 先修白平衡再动饱和；肤色优先于风格化 |
| 疑似 log 素材 | YMAX−YMIN<120 或 transfer=arib-std-b67/smpte2084 | 先套 slog3-to-rec709 转换 LUT，禁止直接叠创意 LUT |
| 多镜色调不一 | 残差 \|ΔYAVG\|>5 或 \|ΔUAVG\|/\|ΔVAVG\|>3 | colorwrite.match 以参考镜派生校正并复检 |

---

## 七、模板

### 模板 A：诊断报告引用格式（analyze 结果 → 人读结论）

```
【量化诊断】片名：{input}，抽样时刻：{t1/t2/t3/t4}s
六指标：YMIN={} YAVG={} YMAX={} UAVG={} VAVG={} SATAVG={}
目标值：YMIN 0–16 / YAVG 80–140 / YMAX 235–255 / UAVG·VAVG 122–134 / SATAVG 40–80
超标项：{kind} — {detail}；建议：{suggestion}
肤色复检：hue={}°（目标 20–40°），sat={}（≤60），结论：{healthy/异常}
```

### 模板 B：证据包出图调用（colorread.scope）

```
工具：colorread.scope
参数：input_path={成片路径}, at_seconds={问题时刻}, kinds=["waveform","vectorscope","histogram"], out_dir={证据目录}
产物：{片名}-waveform-t{秒}s.png / -vectorscope-t{秒}s.png / -histogram-t{秒}s.png（各带 sha256）
引用纪律：连同时间码引用；路径不含"@"（防事件账本 PII 打码）
```

### 模板 C：交付复检清单（verify 阶段逐项打勾）

```
□ 六指标全部落入 targets（或配方 overrides）区间
□ YLOW/YHIGH 裁切占比 ≤1%（夜景 ≤3%，高端 <1%）
□ 有人脸：skinHue 20–40° 且肤色区 sat≤60
□ rmsContrast 22–45、satMean 0.22–0.48（scoreQuality 口径）
□ 多镜：|ΔYAVG|≤5、|ΔUAVG|/|ΔVAVG|≤3
□ scope 三图 + 前后指标 + 滤镜链 + sha256 回执齐全
```

---

## 八、决策树

```
拿到 signalstats / 画质数值
  │
  ├─ YMAX−YMIN < 120 或 transfer 为 arib-std-b67/smpte2084？
  │     └─ 是 → 疑似 log/HLG/PQ → 先套 slog3-to-rec709 转换 LUT → 重新诊断
  │
  ├─ YAVG < 80？（夜景按 70 判）
  │     └─ 欠曝 → eq=brightness≈(110−YAVG)/255 + gamma≤1.35 → 复检
  ├─ YAVG > 140？
  │     └─ 过曝 → eq=brightness 负向 + gamma≥0.75 + curves 收顶 → 复检
  │
  ├─ YLOW 占比 > 1%？→ 死黑 → curves 抬底 / 降对比 → 复检
  ├─ YHIGH 占比 > 1%？→ 高光裁切 → curves 收顶 / 降曝光 → 复检
  │
  ├─ |UAVG−128| > 6 或 |VAVG−128| > 6？
  │     └─ 色偏（U 偏蓝黄、V 偏红绿）→ colorbalance 按偏移反向微调（±0.06 封顶）
  │        → 有 neutral 灰区时用 regionAverageRgb 精确校正 → 复检
  │
  ├─ SATAVG < 40？→ 低饱和 → eq=saturation ≤1.25（有人物 ≤1.2）→ 复检
  ├─ SATAVG > 80？→ 饱和过载 → eq=saturation ≥0.8 → 复检肤色
  │
  ├─ 有人脸且 skinHue 出 20–40° 或 sat > 60？
  │     └─ 肤色跑偏 → 先修白平衡，再谈饱和与风格（肤色优先红线）
  │
  └─ 全部达标 → scoreQuality 终裁：
        rmsContrast 22–45？satMean 0.22–0.48？裁切无新增？清晰度不掉？
        ├─ 是 → 交付（附 scope 三图 + 前后指标 + sha256 回执）
        └─ 否 → 回退到对应修复手段，或按"不劣化优先"判 no_change_needed
```

---

## 九、关联知识

- **CGRADE-001 肤色**：skinHue 20–40° 判据的肤色科学依据、肤色线（I 线）在 vectorscope 上的定位、不同人种的色相差异——本文 2.3 节的肤色判读应与 CGRADE-001 联合检索。
- **CGRADE-002 色彩空间**：Rec.709 / 8-bit 交付口径、log/HLG/PQ 转换（slog3-to-rec709）与 YUV 色度采样——本文所有数值区间仅在 Rec.709 8-bit 口径下成立，色彩空间判定见 CGRADE-002。
- **color-grade SKILL（skills/color-grade/SKILL.md）**：五步执行纪律（probe→analyze→correct→look→verify）、目标值表、profile 选型与硬红线（原片只读、肤色红线、可见性校验 ≥4/255 visible）。本文是 SKILL 的"仪表盘读法"配套。
- **color-recipes（library/color-recipes/recipes.json）**：13 个题材配方的 targets overrides（如 night-city 的 YAVG 70–120、luxury-brand 的 SATAVG 25–50）——判读时配方区间优先于全局区间。
