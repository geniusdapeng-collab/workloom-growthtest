#!/usr/bin/env node
/**
 * LUT 生成器（自算，零第三方 LUT）
 *
 * 产物：
 *   slog3-to-rec709.cube        —— Sony S-Log3 码值 → Rec.709 显示参考（先转换，后校正）
 *   sgamut3cine-to-rec709.cube  —— S-Gamut3.Cine → BT.709 色域矩阵（线性光域 3×3，
 *                                  输入/输出为 BT.709 码值域，串接在 slog3-to-rec709.cube 之后）
 *   look-clean-bright.cube      —— 干净提亮（科普/产品说明）
 *   look-warm-film.cube         —— 暖调电影感（叙事片）
 *   look-teal-orange.cube       —— 青橙商业片
 *   look-moody-dark.cube        —— 压暗去饱和（严肃题材）
 *   look-cool-technical.cube    —— 冷调精密（科技/SaaS）
 *   look-natural.cube           —— 等价 core.mjs PROFILES.natural 滤镜串
 *   look-high-contrast-social.cube —— 等价 PROFILES["high-contrast-social"] 滤镜串
 *   look-vintage-fade.cube      —— 等价 PROFILES["vintage-fade"] 滤镜串
 *   manifest.json               —— 每个 LUT 的来源、参数与用途（进仓登记用）
 *
 * profile 等价 LUT（T-21）：把 core.mjs PROFILES 内置滤镜串（curves/colorbalance/eq）
 * 按 FFmpeg 源码语义移植为纯 JS 数学模型（见 "FFmpeg 滤镜数学移植" 段），在 17³ 格子上
 * 求值生成 LUT；单一事实源是 core.mjs 的 PROFILES，profile 改动后重跑本脚本即可同步。
 *
 * 为什么自算：第三方（含相机厂商）LUT 的再分发条款各异，本仓只保留自生成 LUT，
 * 数学来源为公开传输函数（S-Log3 公开曲线 + ITU-R BT.709 OETF）与本仓自有 look 参数。
 *
 * 用法：node bundles/ai-video/library/luts/generate-luts.mjs [--check]
 *   --check 只校验磁盘产物与本次生成结果一致（不写入）
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// profile→LUT 的单一事实源：新增/改动 profile 后重跑本脚本即可重新生成等价 LUT。
import { PROFILES } from "../../connectors/color-bridge/core.mjs";

const SIZE = 33;          // 转换 LUT：精度优先（log→709 曲线陡峭）
const LOOK_SIZE = 17;     // 创意 look：变换平滑，17³ 足够且体积小（可随时重生成）
const HERE = path.dirname(new URL(import.meta.url).pathname);
const CHECK = process.argv.includes("--check");

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Sony S-Log3：10bit 码值（归一化 0..1）→ 场景线性反射率。公开曲线。 */
export function slog3ToLinear(x) {
  const cv = clamp01(x) * 1023;
  if (cv >= 171.2102946929) return Math.pow(10, (cv - 420) / 261.5) * 0.18 + 0.01;
  return ((cv - 95) * 0.01125) / (171.2102946929 - 95);
}

/** ITU-R BT.709 OETF：线性 → 显示码值。 */
export function linearToRec709(l) {
  const v = l < 0.018 ? 4.5 * l : 1.099 * Math.pow(Math.max(l, 0), 0.45) - 0.099;
  return clamp01(v);
}

/** look 参数：黑白位 / 阴影与高光色偏 / 饱和 / 对比 / gamma。 */
export const LOOKS = {
  "clean-bright": {
    title: "WorkLoom look · clean-bright",
    use: "科普/教学/产品说明：干净、提亮、少风格",
    lift: 0.02, gain: 1.0, shadow: [0.004, 0.002, 0.012], high: [0.008, 0.004, 0],
    saturation: 1.14, contrast: 1.03, gamma: 1.05,
  },
  "warm-film": {
    title: "WorkLoom look · warm-film",
    use: "叙事片/情感向：暖调、轻提黑位、肤色友好",
    lift: 0.032, gain: 0.99, shadow: [0.02, 0.006, -0.016], high: [0.032, 0.008, -0.024],
    saturation: 1.08, contrast: 1.07, gamma: 1.03,
  },
  "teal-orange": {
    title: "WorkLoom look · teal-orange",
    use: "商业片/品牌统一：青影橙高光",
    lift: 0.006, gain: 1.0, shadow: [-0.055, -0.005, 0.075], high: [0.062, 0.01, -0.062],
    saturation: 1.02, contrast: 1.15, gamma: 0.97,
  },
  "moody-dark": {
    title: "WorkLoom look · moody-dark",
    use: "严肃/悬疑：压黑、去饱和（力度别满档）",
    lift: -0.012, gain: 0.97, shadow: [-0.022, -0.008, 0.042], high: [0, -0.01, 0.022],
    saturation: 0.76, contrast: 1.17, gamma: 0.93,
  },
  "cool-technical": {
    title: "WorkLoom look · cool-technical",
    use: "科技/SaaS/数码：冷调、精密（屏幕白必须仍读作白）",
    lift: 0.004, gain: 0.995, shadow: [-0.02, -0.004, 0.045], high: [-0.014, 0.004, 0.03],
    saturation: 0.93, contrast: 1.09, gamma: 0.98,
  },
};

export function applyLook([r, g, b], spec) {
  let rgb = [r, g, b].map((v) => clamp01(spec.lift + v * spec.gain));
  const luma = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  const shadowW = clamp01(1 - luma);
  const highW = clamp01(luma);
  rgb = rgb.map((v, i) => clamp01(v + spec.shadow[i] * shadowW + spec.high[i] * highW));
  const newLuma = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  rgb = rgb.map((v) => clamp01(newLuma + (v - newLuma) * spec.saturation));
  rgb = rgb.map((v) => clamp01(0.5 + (v - 0.5) * spec.contrast));
  rgb = rgb.map((v) => clamp01(Math.pow(v, 1 / spec.gamma)));
  return rgb;
}

/* ================= FFmpeg 滤镜数学移植（T-21，profile 等价 LUT） =================
 *
 * 按 FFmpeg 源码语义移植 core.mjs PROFILES 用到的三个滤镜，作为生成 LUT 的数学模型：
 *   - curves        ：libavfilter/vf_curves.c  自然三次样条（默认 interp=natural），
 *                     复合顺序 graph[master][graph[channel][x]]（master 在通道之后）；
 *   - colorbalance  ：libavfilter/vf_colorbalance.c  get_component()，
 *                     明度 l = max(r,g,b)+min(r,g,b)（HSL lightness×2，非 RGB2Y）；
 *   - eq            ：libavfilter/vf_eq.c  create_lut()：v=contrast*(v-0.5)+0.5+brightness，
 *                     再 pow(v,1/gamma)（gamma_weight=1）；Y 平面用 contrast/brightness/gamma*gamma_g，
 *                     U/V 平面用 saturation 作对比、sqrt(gamma_b/g)/sqrt(gamma_r/g) 作 gamma。
 * eq 作用于 YUV（BT.601 工作室摆幅，与滤镜图中 swscale 自动插入的转换一致），
 * 故 eq 前后做 RGB↔YUV 往返；全程浮点连续计算（跳过 8bit 量化，差 ≤1/255，在容差内）。
 */

/** 解析 "a=x=1:y=2,b='0/0 1/1'" 形式的滤镜串为 [{name, args}]。 */
export function parseFilterChain(chainStr) {
  const splitTop = (s, sep) => {
    const parts = [];
    let cur = "";
    let quoted = false;
    for (const ch of s) {
      if (ch === "'") quoted = !quoted;
      if (ch === sep && !quoted) { parts.push(cur); cur = ""; } else cur += ch;
    }
    parts.push(cur);
    return parts.map((p) => p.trim()).filter(Boolean);
  };
  return splitTop(chainStr, ",").map((filter) => {
    const eqAt = filter.indexOf("=");
    const name = filter.slice(0, eqAt);
    const args = {};
    for (const pair of splitTop(filter.slice(eqAt + 1), ":")) {
      const at = pair.indexOf("=");
      args[pair.slice(0, at)] = pair.slice(at + 1).replace(/^'|'$/g, "");
    }
    return { name, args };
  });
}

/** vf_curves.c interpolate() 移植：自然三次样条（Thomas 三对角求解），区间外常数外推。 */
export function naturalCubicSpline(points) {
  const pts = [...points].sort((a, b) => a.x - b.x);
  const n = pts.length;
  if (n === 0) return (t) => clamp01(t);
  if (n === 1) return () => clamp01(pts[0].y);
  const h = [];
  for (let i = 0; i < n - 1; i += 1) h.push(pts[i + 1].x - pts[i].x);
  const r = new Array(n).fill(0);
  for (let i = 1; i < n - 1; i += 1) {
    r[i] = 6 * ((pts[i + 1].y - pts[i].y) / h[i] - (pts[i].y - pts[i - 1].y) / h[i - 1]);
  }
  const BD = new Array(n).fill(0);
  const MD = new Array(n).fill(0);
  const AD = new Array(n).fill(0);
  MD[0] = 1; MD[n - 1] = 1;
  for (let i = 1; i < n - 1; i += 1) { BD[i] = h[i - 1]; MD[i] = 2 * (h[i - 1] + h[i]); AD[i] = h[i]; }
  for (let i = 1; i < n; i += 1) {
    const den = MD[i] - BD[i] * AD[i - 1];
    const k = den ? 1 / den : 1;
    AD[i] *= k;
    r[i] = (r[i] - BD[i] * r[i - 1]) * k;
  }
  for (let i = n - 2; i >= 0; i -= 1) r[i] -= AD[i] * r[i + 1];
  return (t) => {
    const x = clamp01(t);
    if (x <= pts[0].x) return clamp01(pts[0].y);
    if (x >= pts[n - 1].x) return clamp01(pts[n - 1].y);
    let i = 0;
    while (i < n - 2 && x > pts[i + 1].x) i += 1;
    const a = pts[i].y;
    const b = (pts[i + 1].y - pts[i].y) / h[i] - (h[i] * r[i]) / 2 - (h[i] * (r[i + 1] - r[i])) / 6;
    const c = r[i] / 2;
    const d = (r[i + 1] - r[i]) / (6 * h[i]);
    const xx = x - pts[i].x;
    return clamp01(a + b * xx + c * xx * xx + d * xx * xx * xx);
  };
}

export function applyCurves([r, g, b], args) {
  const parsePoints = (s) => s.trim().split(/\s+/).filter(Boolean).map((pair) => {
    const [x, y] = pair.split("/").map(Number);
    return { x, y };
  });
  const fn = {};
  for (const key of ["r", "g", "b", "all"]) {
    fn[key] = args[key] && args[key] !== "none" ? naturalCubicSpline(parsePoints(args[key])) : null;
  }
  // ffmpeg 复合顺序：先通道曲线，再 master（all）曲线（config_input 里预合并为 graph[master][graph[ch][x]]）。
  const ch = (v, cf) => clamp01(fn.all ? fn.all(cf ? cf(v) : v) : cf ? cf(v) : v);
  return [ch(r, fn.r), ch(g, fn.g), ch(b, fn.b)];
}

/** vf_colorbalance.c get_component() 移植（preserve_lightness=0，即 profile 未用 pl）。 */
export function applyColorbalance([r, g, b], args) {
  const num = (k) => Number(args[k] ?? 0);
  const l = Math.max(r, g, b) + Math.min(r, g, b); // HSL lightness×2（ffmpeg 语义，非 RGB2Y）
  const A = 4; const B = 0.333; const SCALE = 0.7;
  const component = (v, s, m, h) => {
    const ws = clamp01((B - l) * A + 0.5) * SCALE;
    const wm = clamp01((l - B) * A + 0.5) * clamp01((1 - l - B) * A + 0.5) * SCALE;
    const wh = clamp01((l + B - 1) * A + 0.5) * SCALE;
    return clamp01(v + s * ws + m * wm + h * wh);
  };
  return [
    component(r, num("rs"), num("rm"), num("rh")),
    component(g, num("gs"), num("gm"), num("gh")),
    component(b, num("bs"), num("bm"), num("bh")),
  ];
}

/* BT.601 工作室摆幅（limited range）RGB↔YUV：与 eq 在滤镜图中所见的 YUV 域一致。 */
const KR601 = 0.299; const KB601 = 0.114;

function rgbToYuvLimited([r, g, b]) {
  const yf = KR601 * r + (1 - KR601 - KB601) * g + KB601 * b;
  return [
    16 + 219 * yf,
    128 + (224 * 0.5 * (b - yf)) / (1 - KB601),
    128 + (224 * 0.5 * (r - yf)) / (1 - KR601),
  ];
}

function yuvLimitedToRgb([y, u, v]) {
  const yf = (y - 16) / 219;
  const b = yf + (2 * (1 - KB601) * (u - 128)) / 224;
  const r = yf + (2 * (1 - KR601) * (v - 128)) / 224;
  const g = (yf - KR601 * r - KB601 * b) / (1 - KR601 - KB601);
  return [clamp01(r), clamp01(g), clamp01(b)];
}

/** vf_eq.c create_lut() 移植（连续浮点版；gamma_weight=1）。v 为 0..255 码值域。 */
function eqLut(v, contrast, brightness, gamma) {
  let x = clamp01(v / 255);
  x = contrast * (x - 0.5) + 0.5 + brightness;
  if (x <= 0) return 0;
  x = Math.pow(x, 1 / gamma);
  if (x >= 1) return 255;
  return x * 255;
}

export function applyEq(rgb, args) {
  const contrast = Number(args.contrast ?? 1);
  const brightness = Number(args.brightness ?? 0);
  const saturation = Number(args.saturation ?? 1);
  const gamma = Number(args.gamma ?? 1);
  const gr = Number(args.gamma_r ?? 1);
  const gg = Number(args.gamma_g ?? 1);
  const gb = Number(args.gamma_b ?? 1);
  const [y, u, v] = rgbToYuvLimited(rgb);
  return yuvLimitedToRgb([
    eqLut(y, contrast, brightness, gamma * gg),
    eqLut(u, saturation, 0, Math.sqrt(gb / gg)),
    eqLut(v, saturation, 0, Math.sqrt(gr / gg)),
  ]);
}

/** 按滤镜串顺序应用（与 core.mjs PROFILES 的执行语义一致）。 */
export function applyFilterChain(rgb, chainStr) {
  let out = [...rgb];
  for (const { name, args } of parseFilterChain(chainStr)) {
    if (name === "curves") out = applyCurves(out, args);
    else if (name === "colorbalance") out = applyColorbalance(out, args);
    else if (name === "eq") out = applyEq(out, args);
    else throw new Error(`applyFilterChain 未移植的滤镜：${name}`);
  }
  return out.map(clamp01);
}

/** PROFILES 中尚无等价 look LUT 的 profile（LOOKS 之外的全部）。 */
export const PROFILE_LOOKS = Object.keys(PROFILES).filter((name) => !LOOKS[name]);

/* ================= S-Gamut3.Cine → BT.709 色域矩阵（T-21） =================
 *
 * 矩阵来源：
 *   - S-Gamut3.Cine→XYZ：Sony 官方《Technical Summary for S-Gamut3.Cine/S-Log3 and
 *     S-Gamut3/S-Log3》及配套 S-Gamut3_S-Gamut3Cine_Matrix.xlsx 公布值
 *     （colour-science/colour 的 MATRIX_S_GAMUT3_CINE_TO_XYZ 同源）；
 *   - XYZ→BT.709：由 ITU-R BT.709 原色坐标（R .64/.33, G .30/.60, B .15/.06, D65）
 *     按标准方法构建的 RGB→XYZ 矩阵求逆（构建结果与规范参考值逐位一致）。
 * 作用域：矩阵在**线性光域**作用。LUT 输入/输出为 BT.709 码值域（显示参考），
 * 内部用逆/正 OETF 包裹，以便直接串接在 slog3-to-rec709.cube 之后：
 *   S-Log3 解码 → 线性 →（encode→本 LUT 内 decode→矩阵→encode）→ 等效于 线性→矩阵→BT.709 编码。
 */

/** Sony 官方公布：S-Gamut3.Cine → CIE XYZ（D65）。 */
export const SGAMUT3CINE_TO_XYZ = [
  [0.5990839208, 0.2489255161, 0.1024464902],
  [0.2150758201, 0.8850685017, -0.1001443219],
  [-0.0320658495, -0.0276583907, 1.1487819910],
];

function invert3(m) {
  const [a, b, c] = m[0]; const [d, e, f] = m[1]; const [g, h, i] = m[2];
  const A = e * i - f * h; const B = -(d * i - f * g); const C = d * h - e * g;
  const D = -(b * i - c * h); const E = a * i - c * g; const F = -(a * h - b * g);
  const G = b * f - c * e; const H = -(a * f - c * d); const I = a * e - b * d;
  const det = a * A + b * B + c * C;
  return [[A / det, D / det, G / det], [B / det, E / det, H / det], [C / det, F / det, I / det]];
}

function matMul3(A, B) {
  return A.map((row) => [0, 1, 2].map((j) => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]));
}

/** ITU-R BT.709 RGB→XYZ（D65，规范参考值；由 BT.709 原色坐标构建并核对一致）。 */
const BT709_TO_XYZ = [
  [0.4123907993, 0.3575843394, 0.1804807884],
  [0.2126390059, 0.7151686788, 0.0721923154],
  [0.0193308187, 0.1191947798, 0.9505321522],
];

/** S-Gamut3.Cine → BT.709（线性光域 3×3；行和≈1，白点保持）。 */
export const SGAMUT3CINE_TO_REC709 = matMul3(invert3(BT709_TO_XYZ), SGAMUT3CINE_TO_XYZ);

/** BT.709 OETF 逆函数：显示码值 → 线性。 */
export function rec709ToLinear(v) {
  const x = clamp01(v);
  return x < 0.081 ? x / 4.5 : Math.pow((x + 0.099) / 1.099, 1 / 0.45);
}

export function applyGamutMatrix([r, g, b], m) {
  return [
    m[0][0] * r + m[0][1] * g + m[0][2] * b,
    m[1][0] * r + m[1][1] * g + m[1][2] * b,
    m[2][0] * r + m[2][1] * g + m[2][2] * b,
  ];
}

/** sgamut3cine-to-rec709.cube 的逐格变换：BT.709 码值域进出，线性光域内做矩阵。 */
export function sgamut3cineToRec709(rgb) {
  const linear = rgb.map(rec709ToLinear);
  return applyGamutMatrix(linear, SGAMUT3CINE_TO_REC709).map(clamp01).map(linearToRec709);
}

function cubeLine([r, g, b]) {
  return `${r.toFixed(6)} ${g.toFixed(6)} ${b.toFixed(6)}`;
}

/** 生成 .cube 文本（红通道变化最快，符合 Adobe/Resolve 约定）。 */
export function buildCube({ title, size = SIZE, transform }) {
  const lines = [`TITLE "${title}"`, `LUT_3D_SIZE ${size}`, "DOMAIN_MIN 0.000000 0.000000 0.000000", "DOMAIN_MAX 1.000000 1.000000 1.000000", ""];
  const step = 1 / (size - 1);
  for (let bi = 0; bi < size; bi += 1) {
    for (let gi = 0; gi < size; gi += 1) {
      for (let ri = 0; ri < size; ri += 1) {
        lines.push(cubeLine(transform([ri * step, gi * step, bi * step])));
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

export function buildAll() {
  const out = new Map();
  out.set("slog3-to-rec709.cube", buildCube({
    title: "Sony S-Log3 to Rec.709 (self-computed, WorkLoom ai-video)",
    transform: ([r, g, b]) => [r, g, b].map((v) => linearToRec709(slog3ToLinear(v))),
  }));
  out.set("sgamut3cine-to-rec709.cube", buildCube({
    title: "S-Gamut3.Cine to Rec.709 gamut matrix (linear-light, BT.709 code-value domain; chain after slog3-to-rec709.cube)",
    transform: sgamut3cineToRec709,
  }));
  for (const [name, spec] of Object.entries(LOOKS)) {
    out.set(`look-${name}.cube`, buildCube({ title: spec.title, size: LOOK_SIZE, transform: (rgb) => applyLook(rgb, spec) }));
  }
  for (const name of PROFILE_LOOKS) {
    out.set(`look-${name}.cube`, buildCube({
      title: `WorkLoom look · ${name}（等价 core.mjs PROFILES 滤镜串）`,
      size: LOOK_SIZE,
      transform: (rgb) => applyFilterChain(rgb, PROFILES[name]),
    }));
  }
  return out;
}

const manifest = () => ({
  schemaVersion: "workloom.luts/v1",
  generatedBy: "bundles/ai-video/library/luts/generate-luts.mjs",
  license: "self-generated（本仓自有产物，无第三方 LUT 再分发）",
  source: {
    slog3: "Sony S-Log3 公开传输函数（码值→线性反射率）",
    rec709: "ITU-R BT.709 OETF",
    sgamut3cine: "S-Gamut3.Cine→XYZ 矩阵：Sony《Technical Summary for S-Gamut3.Cine/S-Log3 and S-Gamut3/S-Log3》及 S-Gamut3_S-Gamut3Cine_Matrix.xlsx 公布值；XYZ→BT.709 由 ITU-R BT.709 原色构建",
    note: "S-Log3 曲线转换与 S-Gamut3.Cine→BT.709 色域矩阵均已落地（T-21）；其他厂商 log（C-Log/V-Log/HLG/PQ）未登记转换路径，按超出口径上报",
  },
  luts: [
    { file: "slog3-to-rec709.cube", kind: "conversion", size: SIZE, use: "log 素材先转换（禁止在 log 上直接叠创意 LUT）" },
    {
      file: "sgamut3cine-to-rec709.cube",
      kind: "conversion",
      size: SIZE,
      use: "S-Gamut3.Cine 色域→BT.709 色域矩阵；串接在 slog3-to-rec709.cube 之后（S-Log3 且色域确认为 S-Gamut3.Cine 时启用，恒 100%）",
      note: "3×3 矩阵在线性光域作用；LUT 输入/输出为 BT.709 码值域（OETF 包裹），与 slog3-to-rec709.cube 链式复合后等效于 S-Log3 解码→线性→色域矩阵→BT.709 编码",
    },
    ...Object.entries(LOOKS).map(([name, spec]) => ({
      file: `look-${name}.cube`, kind: "creative", size: LOOK_SIZE, use: spec.use,
      params: { lift: spec.lift, gain: spec.gain, shadow: spec.shadow, high: spec.high, saturation: spec.saturation, contrast: spec.contrast, gamma: spec.gamma },
      note: "满档参数（intensity=1.0 的画面语言）；低于 0.6 强度基本看不出变化，交付前必须过可见性校验",
    })),
    ...PROFILE_LOOKS.map((name) => ({
      file: `look-${name}.cube`,
      kind: "creative",
      size: LOOK_SIZE,
      use: `等价 core.mjs PROFILES["${name}"] 内置滤镜串的 LUT 形态（供 recipes/外部链路按 .cube 引用）`,
      params: { profile: name, filter: PROFILES[name] },
      note: "由 FFmpeg curves/colorbalance/eq 源码语义移植的数学模型在 17³ 格子上求值生成；profile 滤镜串改动后重跑 generate-luts.mjs 同步",
    })),
  ],
});

function main() {
  const artifacts = buildAll();
  const problems = [];
  for (const [file, content] of artifacts) {
    const target = path.join(HERE, file);
    const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
    if (CHECK) {
      if (existing !== content) problems.push(`${file} 与生成结果不一致（跑 generate-luts.mjs 重建）`);
      continue;
    }
    fs.writeFileSync(target, content, "utf8");
  }
  const manifestText = `${JSON.stringify(manifest(), null, 2)}\n`;
  if (CHECK) {
    const existing = fs.existsSync(path.join(HERE, "manifest.json")) ? fs.readFileSync(path.join(HERE, "manifest.json"), "utf8") : null;
    if (existing !== manifestText) problems.push("manifest.json 与生成结果不一致");
    if (problems.length) {
      console.error(`✗ LUT 资产校验失败：\n  - ${problems.join("\n  - ")}`);
      process.exit(1);
    }
    console.log(`✓ LUT 资产校验通过（${artifacts.size} 个 .cube + manifest.json）`);
    return;
  }
  fs.writeFileSync(path.join(HERE, "manifest.json"), manifestText, "utf8");
  for (const file of artifacts.keys()) {
    const buf = fs.readFileSync(path.join(HERE, file));
    console.log(`✓ ${file}  ${(buf.length / 1024).toFixed(1)}KB  sha256=${createHash("sha256").update(buf).digest("hex").slice(0, 12)}…`);
  }
  console.log(`✓ manifest.json（${artifacts.size} 个 LUT 登记）`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
