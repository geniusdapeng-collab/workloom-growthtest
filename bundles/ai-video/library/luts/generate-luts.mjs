#!/usr/bin/env node
/**
 * LUT 生成器（自算，零第三方 LUT）
 *
 * 产物：
 *   slog3-to-rec709.cube   —— Sony S-Log3 码值 → Rec.709 显示参考（先转换，后校正）
 *   look-clean-bright.cube —— 干净提亮（科普/产品说明）
 *   look-warm-film.cube    —— 暖调电影感（叙事片）
 *   look-teal-orange.cube  —— 青橙商业片
 *   look-moody-dark.cube   —— 压暗去饱和（严肃题材）
 *   manifest.json          —— 每个 LUT 的来源、参数与用途（进仓登记用）
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
  for (const [name, spec] of Object.entries(LOOKS)) {
    out.set(`look-${name}.cube`, buildCube({ title: spec.title, size: LOOK_SIZE, transform: (rgb) => applyLook(rgb, spec) }));
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
    note: "仅做色调曲线转换，未做 S-Gamut3.Cine→BT.709 色域矩阵；极端色域素材请先确认色域或补矩阵",
  },
  luts: [
    { file: "slog3-to-rec709.cube", kind: "conversion", size: SIZE, use: "log 素材先转换（禁止在 log 上直接叠创意 LUT）" },
    ...Object.entries(LOOKS).map(([name, spec]) => ({
      file: `look-${name}.cube`, kind: "creative", size: LOOK_SIZE, use: spec.use,
      params: { lift: spec.lift, gain: spec.gain, shadow: spec.shadow, high: spec.high, saturation: spec.saturation, contrast: spec.contrast, gamma: spec.gamma },
      note: "满档参数（intensity=1.0 的画面语言）；低于 0.6 强度基本看不出变化，交付前必须过可见性校验",
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
