# 色彩空间与色域转换（Color Space & Gamut Transform）领域知识库

> **用途**：调色链路的底层知识库。供数字员工 / Agent 在处理实拍素材（尤其 log/HLG 素材）时检索调用。
> **主题编号**：CGRADE-002　**版本**：v1.1（T-21 落地）　**更新日期**：2026-09-27
> **使用方式**：Agent 拿到一条素材、或用户提到"还原 log""发灰""套 LUT"时，先检索本主题确定**转换路径**，再进入 CGRADE-001（校正）与 CGRADE-003（创意调色）。本仓库的转换能力以 `library/luts/manifest.json` 登记为准——清单里没有的转换路径，按"超出口径"上报，不硬凑。

---

## 一、核心概念

### 1.1 两个独立维度：伽马曲线 ≠ 色域

色彩空间由**两根独立的轴**构成，转换时必须分别处理，混为一谈是调色链路最常见的事故根源：

| 维度 | 定义 | 本仓库对应物 |
|---|---|---|
| **传递函数**（OETF/EOTF，俗称伽马曲线） | 码值 ↔ 光量的映射：S-Log3、HLG、PQ、BT.709 gamma | `generate-luts.mjs` 中 `slog3ToLinear()` + `linearToRec709()` 两段公开曲线 |
| **色域**（gamut，三原色坐标） | R/G/B 三个原色在 CIE 图上的落点：S-Gamut3.Cine、BT.709、BT.2020 | `sgamut3cine-to-rec709.cube`（33³，Sony 官方 S-Gamut3.Cine→XYZ 矩阵 × ITU-R BT.709 逆矩阵，线性光域作用） |

> **S-Log3→BT.709 的曲线转换 ≠ S-Gam3.Cine→BT.709 的色域矩阵。** 前者是一条一维曲线（每个通道独立映射），后者是一个 3×3 矩阵（三通道交叉混合）。只做曲线不做矩阵，画面能看，但高饱和区域（霓虹、车漆、彩妆、夕阳）色相和饱和度都是错的。

### 1.2 本仓库现状（写死的事实，不要猜）

S-Log3 转换链路已完整落地（T-21，2026-09-27）：

- `slog3-to-rec709.cube`（33³，`kind: "conversion"`）：S-Log3 曲线 → Rec.709 曲线（OETF）；
- `sgamut3cine-to-rec709.cube`（33³，`kind: "conversion"`）：S-Gamut3.Cine → BT.709 色域矩阵（Sony 官方矩阵 × ITU-R BT.709 逆矩阵，线性光域 3×3；LUT 输入/输出为 BT.709 码值域，专为串接在前者之后设计）。两者链式复合 = S-Log3 解码 → 线性 → 色域矩阵 → BT.709 编码；
- 触发条件：`colorwrite.grade` 探测/参数指示 S-Log3 且色域确认为 S-Gamut3.Cine（`source_transfer=slog3` + `source_gamut=sgamut3cine`，或元数据明确写出）时自动链式应用，恒 100%、置于校正之前；色域无法确认时仅做 OETF 转换（保持旧行为）并在 `conversion.note` / `verifyWarnings` 注明；
- 除 S-Log3 外，**没有任何其他厂商 log 的转换 LUT**（见第二章支持状态表）。

### 1.3 转换 LUT vs 创意 LUT：两级纪律

`library/color-recipes/recipes.json` 的 `levels` 字段把 LUT 使用钉死为两级：

```json
"levels": {
  "conversion": "log/HLG 素材先套 slog3-to-rec709.cube",
  "creative": "题材色调由 profile 或 look-*.cube 承载"
}
```

| | 转换 LUT（technical） | 创意 LUT（creative） |
|---|---|---|
| 目的 | 把 log 码值**还原**到显示参考（Rec.709），"回到正常画面" | 在正常画面上**加风格**（青橙、暖调、压暗） |
| 本仓实例 | `slog3-to-rec709.cube`（OETF 曲线）+ `sgamut3cine-to-rec709.cube`（色域矩阵，T-21） | `look-clean-bright.cube` / `look-warm-film.cube` / `look-teal-orange.cube` / `look-moody-dark.cube` / `look-cool-technical.cube` / `look-natural.cube` / `look-high-contrast-social.cube` / `look-vintage-fade.cube` |
| 网格尺寸 | **33³**（曲线陡峭，精度优先，`SIZE = 33`） | **17³**（变换平滑，体积小，`LOOK_SIZE = 17`） |
| 强度 | 恒 100% 套用，不可稀释 | 按 `intensity` 混合（`core.mjs` 的 split/blend 支路），默认不满档 |
| 顺序 | 链路最前（校正之前或同级） | 链路最后（`lut3d` 恒在 look 段尾部） |

---

## 二、分类速查（常见 log/HLG 格式 × 本仓支持状态）

| 格式 | 厂商/标准 | 传递函数 | 配套色域 | 本仓转换路径 | 支持状态 |
|---|---|---|---|---|---|
| **S-Log3** | Sony | S-Log3 公开曲线（`slog3ToLinear`） | S-Gamut3.Cine | `slog3-to-rec709.cube`（曲线）+ `sgamut3cine-to-rec709.cube`（色域矩阵） | ✅ 完整支持（T-21 落地）：色域确认后自动链式应用双 LUT |
| **C-Log / C-Log3** | Canon | Canon Log 曲线 | Cinema Gamut / BT.2020 | 无对应 LUT | ❌ 未支持，按超出口径上报 |
| **V-Log** | Panasonic | V-Log 曲线 | V-Gamut | 无对应 LUT | ❌ 未支持，按超出口径上报 |
| **HLG** | ITU-R BT.2100 | Hybrid Log-Gamma（`arib-std-b67`） | BT.2020 | 无；`analyze()` 仅识别并告警 `log_or_flat` | ⚠️ 可识别、不可转换 |
| **PQ** | SMPTE ST 2084 | PQ（`smpte2084`） | BT.2020 | 无；同上仅告警 | ⚠️ 可识别、不可转换（HDR，整体超出口径） |
| **Rec.709** | ITU-R BT.709 | BT.709 OETF（`linearToRec709`） | BT.709 | 无需转换，直接进入校正段 | ✅ 原生工作口径 |

识别入口：`colorread.probe` 返回的 `video.colorTransfer` / `colorPrimaries`；`colorread.analyze` 在 `colorTransfer` 为 `arib-std-b67`/`smpte2084` 或动态范围偏平（`YMAX - YMIN < 120`）时抛出 `log_or_flat` 告警，建议语即"先套转换 LUT（本仓 slog3-to-rec709）再校正，禁止直接叠加创意 LUT"。

---

## 三、分场景实战

### 3.1 索尼 S-Log3 素材（本仓唯一闭环路径）

1. `colorread.probe` 确认素材（S-Log3 元数据常缺失，动态范围偏平 + 发灰是视觉特征）；
2. 转换段：`lut3d='…/library/luts/slog3-to-rec709.cube'`，色域确认为 S-Gamut3.Cine 时追加 `lut3d='…/library/luts/sgamut3cine-to-rec709.cube'`（`colorwrite.grade` 传 `source_transfer=slog3` + `source_gamut=sgamut3cine` 即自动链式应用），**100% 强度，不走 intensity 稀释**；
3. 校正段：白平衡/曝光（`normalize → colortemperature → colorbalance → curves → eq`，恒 100% 生效）；
4. 创意段：profile 或 `look-*.cube`，按 recipes.json 的 `intensity`（0.4–0.85）混合；
5. 高饱和画面（霓虹/车漆/彩妆）：色域矩阵落地后色相/饱和已校正；注意 S-Log3 趾部（码值 <0.2 的深影）33³ LUT 插值误差相对偏大（既有特性），深影区域复检以人眼抽帧为准。

### 3.2 C-Log / V-Log 素材

本仓没有对应转换 LUT，**禁止拿 `slog3-to-rec709.cube` 硬套**（曲线不同，套完黑位白位全错）。处置：如实上报"该 log 格式未登记转换路径"，建议用户在拍摄机内输出 Rec.709 或外部完成转换后再进链路。

### 3.3 HLG / PQ（HDR）素材

`analyze()` 能识别（`log_or_flat` 告警），但 HDR 交付整体超出 `color-delivery-spec` 的 Rec.709/8-bit 口径。处置：**不做色调映射（tone mapping）硬凑**，按 SKILL.md 第一章"遇到时按超出交付口径上报"。

### 3.4 已是 Rec.709 的素材（手机直出、屏幕录制、AI 生成视频）

跳过 conversion 级，直接进校正 + 创意两级。这是本链路覆盖最多的场景，13 个 recipes 全部以此假设标定目标区间（YAVG 80–140、SATAVG 40–80）。

---

## 四、视频特有规则（本链路实现层纪律）

1. **lut3d 在滤镜链中的位置**：`core.mjs` 的 `buildChain()` 固定为 `校正段, profile 滤镜, lut3d`——`lut3d` 恒为最后一步（"LUT 最后套"）。转换 LUT 的使用点在**校正之前**（先还原再校正），创意 LUT 在校正之后，两者不要在同一次 `colorwrite.grade` 调用里混排。
2. **两段式强度**：校正恒 100% 生效；只有 look（profile/LUT）走 `split=2 + blend=all_opacity=intensity` 支路。转换 LUT 属于"还原"不属于 look，**必须满档**，稀释转换等于只还了一半的伽马。
3. **可见性校验对转换同样生效**：`grade()` 的 `frameDifference` 要求 look 产生 ≥2/255 的像素差，否则 `verify_failed` 拒绝出片——log 素材转换前后差异巨大，正常必然通过；若不通过，先怀疑 LUT 没加载上（路径含 `:` 需转义，`escapeFilterPath` 已处理）。
4. **多段一致性**：同一项目的 log 素材必须走同一条转换路径 + 同一套 look（recipes.json 原则："一个项目只用一套 look"）；平台变体从已调色母版派生，禁止重新调色（SKILL.md 第二章）。
5. **元数据标签（T-04 已落地 2026-09-27）**：输出必须为 `yuv420p` 8-bit H.264，并显式打 `color_primaries/color_trc/colorspace = bt709` 标签——不打标签的 bt709 文件在部分播放器会被误解释，等于白转换。工具侧已由 `grade()` 固定写入并用 ffprobe **回读校验**：三标签读回不是 bt709 即 `verify_failed` 删产物；读不到（老 ffprobe）记"未核实"警告但不静默当通过。
   - **判读口径配套**：打标后 ffmpeg 会按文件标签做 YUV→RGB 转换，未打标的源按 SD/601 猜——同一份像素只差一个标签，RGB 平均差实测可达 7.61/255。因此本仓所有产 RGB 的判读路径（`regionAverageRgb` / `rawFrame` / `frameDifference` / `compareFrames` / `renderScopes`）统一按 **bt709 解释输入**（`RGB_INPUT_COLOR_ARGS`），可见性度量只说"画面变了多少"，不再混入元数据差异。

---

## 五、常见误区（转换错误的典型症状对照表）

| 误区 / 操作 | 典型症状 | 纠正 |
|---|---|---|
| 对 log 素材直接叠创意 LUT | 画面发灰、对比塌陷、暗部一团死黑 | 先 conversion 后 creative，两级不可合并 |
| 拿 S-Log3 的 LUT 套 C-Log/V-Log | 黑位白位错位，整体偏色 | 该格式未登记，上报而非硬套 |
| 以为曲线转换 = 完整色彩空间转换 | 高饱和区域色相漂移（霓虹变色、车漆偏色） | 曲线和色域是两根轴；S-Log3+S-Gamut3.Cine 素材走双 LUT 链（T-21 已落地），色域不确定时报告会注明缺口 |
| 转换 LUT 也按 intensity 稀释 | 伽马只还一半，画面"灰中带艳" | conversion 恒 100%，只有 creative 走强度混合 |
| 肤色蜡黄就拉色相 | 越拉越脏 | 肤色问题先修白平衡（UAVG/VAVG 归 128），再降饱和；skinHue 目标 20–40°（recipes.json targets） |
| 转换后饱和爆炸就全局去饱和 | 正常颜色也被压灰 | 饱和异常先确认色域元数据并启用 `sgamut3cine-to-rec709.cube`（T-21），不是 eq=saturation 能修的 |
| 输出不打色彩元数据标签 | 播放器误解释，前功尽弃 | 交付必须 `bt709` 三标签齐全（T-04 已落地：工具自动打标 + ffprobe 回读校验） |

---

## 六、意图→参数映射表（Agent 核心调用区）

| 创作意图 | 中文写法 | 英文关键词/参数 |
|---|---|---|
| 索尼 log 素材还原 | 先套 S-Log3 转换 LUT 再校正 | `lut3d=slog3-to-rec709.cube`（conversion 级，100%） |
| log 素材做青橙商业片 | 转换 → 校正 → 青橙 look | conversion + `profile=teal-orange` / `look-teal-orange.cube`，intensity 0.6–0.75 |
| log 素材做暖调叙事 | 转换 → 校正 → 暖调电影感 | conversion + `profile=warm-film` / `look-warm-film.cube`，intensity 0.6–0.85 |
| 识别素材是否 log/HLG | 探测传递函数与动态范围 | `colorread.probe` 看 `colorTransfer`；`colorread.analyze` 的 `log_or_flat` 告警 |
| 判断未知素材色彩空间 | 读元数据三字段 | `color_primaries` / `color_transfer` / `color_space`（ffprobe stream 字段） |
| C-Log/V-Log 素材进链路 | 本仓无转换路径，如实上报 | 超出口径上报；禁止套用 `slog3-to-rec709.cube` |
| HLG/PQ 素材交付 | HDR 超出 Rec.709 口径，上报 | `arib-std-b67` / `smpte2084` → 按 color-delivery-spec 上报 |
| 输出打标 Rec.709 | 交付元数据三标签 + 回读校验 | `color_primaries=bt709` `color_trc=bt709` `colorspace=bt709` + `-pix_fmt yuv420p`；`outputColor.verified=true`（T-04 已落地） |
| 高饱和素材色域存疑 | 确认色域并启用色域矩阵 | `source_gamut=sgamut3cine` → 自动链式应用 `sgamut3cine-to-rec709.cube`（T-21 已落地）；色域不确定时报告 `conversion.note` 注明 |
| 转换后画面仍发灰 | 检查 LUT 是否真加载 | 可见性校验 `frameDifference` ≥2/255；`verify_failed` 即未生效 |

---

## 七、模板

### 模板 A：S-Log3 素材完整链路（本仓唯一闭环）

```
1. 探测：colorread.probe(input) → 确认动态范围/元数据
2. 转换：colorwrite.grade(input, source_transfer="slog3", source_gamut="sgamut3cine", intensity=1)
   —— 自动链式应用 slog3-to-rec709.cube + sgamut3cine-to-rec709.cube，产出 Rec.709 中间片（此步不加任何 profile）
3. 校正+创意：colorwrite.grade(中间片, corrections={…}, profile="<recipe.profile>", intensity=<recipe.intensity>)
4. 复检：colorread.analyze 对照 recipes.json targets（YAVG 80–140 / SATAVG 40–80 / skinHue 20–40°）
5. 交付：Rec.709 / 8-bit / yuv420p / H.264，bt709 三标签齐全（工具自动打标并 ffprobe 回读校验，T-04 已落地）
```

### 模板 B：未知素材进站处置

```
1. colorread.probe → 读 colorTransfer / colorPrimaries / colorSpace
2. colorread.analyze → 是否触发 log_or_flat 告警
3. 对照第二章支持状态表选路径：
   - S-Log3 → 模板 A
   - Rec.709 → 跳过转换，直接校正+创意
   - C-Log / V-Log / HLG / PQ → 超出口径上报，不产出"硬凑"成片
```

### 模板 C：超出口径上报话术

```
素材色彩空间为 <C-Log3 / V-Log / HLG / PQ>，本链路转换清单（manifest.json）未登记对应路径
（HDR/杜比视界/ACES 超出 Rec.709/8-bit 交付口径）。按 color-delivery-spec 纪律如实上报，
未强行套用近似 LUT 产出不可靠成片。建议：机内转 Rec.709 后重进链路，或走外部调色流程。
```

---

## 八、决策树（拿到未知素材 → 选哪条转换路径）

```
拿到素材
  │
  ├─ ① colorread.probe：colorTransfer / colorPrimaries 有值吗？
  │     │
  │     ├─ bt709 / unspecified + 动态范围正常（YMAX−YMIN ≥ 120）
  │     │     → Rec.709 素材 → 跳过 conversion，直接校正+创意（第三章 3.4）
  │     │
  │     ├─ arib-std-b67（HLG）或 smpte2084（PQ）
  │     │     → HDR，整体超出口径 → 上报（模板 C），不做 tone mapping 硬凑
  │     │
  │     └─ unspecified / log 特征（发灰、低对比、低饱和）
  │           │
  │           ├─ ② colorread.analyze 触发 log_or_flat？
  │           │     │
  │           │     ├─ 否 → 按 Rec.709 处理，但交付前复检指标
  │           │     │
  │           │     └─ 是 → ③ 确认厂商 log 格式
  │           │           │
  │           │           ├─ Sony S-Log3 → slog3-to-rec709.cube（100%）
  │           │           │     色域确认 S-Gamut3.Cine → 追加 sgamut3cine-to-rec709.cube（T-21）
  │           │           │     → 校正 → 创意 look（模板 A）
  │           │           │
  │           │           ├─ Canon C-Log / Panasonic V-Log
  │           │           │     → 本仓无 LUT → 上报，禁止硬套（模板 C）
  │           │           │
  │           │           └─ 无法确认厂商
  │           │                 → 上报并要求用户提供机型/格式，不猜
  │
  └─ ④ 任何路径的交付末端：Rec.709 / 8-bit / yuv420p / H.264 + bt709 三标签（T-04 已落地：工具打标 + 回读）
        HDR / 杜比视界 / ACES 需求 → 一律上报，不在本链路解决
```

---

## 九、关联知识

- **CGRADE-001 白平衡与曝光校正**：转换之后、创意之前的校正段（normalize/colortemperature/colorbalance/curves/eq 的参数推导与目标区间）。
- **CGRADE-003 创意调色与 LUT 使用**：creative 级 look-*.cube 与 profile 的选型、intensity 纪律、肤色保护——本文只负责"先把素材变正常"，"变好看"看 CGRADE-003。
- **CGRADE-005 调色交付与证据包**：交付口径落地（sha256、before/after 指标、scope 三图、可见性度量）。
- **SKILL：color-delivery-spec**：Rec.709/8-bit/H.264 交付口径、HDR/ACES 上报边界、返工判定表——本文的上报话术与该 SKILL 第六章对齐。
- **代码锚点**：`library/luts/manifest.json`（LUT 清单）、`library/luts/generate-luts.mjs`（`slog3ToLinear` / `linearToRec709` / `sgamut3cineToRec709` / SIZE=33 / LOOK_SIZE=17）、`library/color-recipes/recipes.json`（levels 两级与 targets）、`connectors/color-bridge/core.mjs`（`buildChain` 中 lut3d 的位置、`resolveConversionLuts` 转换链决策、`analyze` 的 log_or_flat 判定、可见性校验）。

> 转换是地基，校正和创意是地上的楼。凡涉及"还原、log、发灰、色彩空间"的诉求，先检索 CGRADE-002 定转换路径，再联合 CGRADE-001/003 出方案。
