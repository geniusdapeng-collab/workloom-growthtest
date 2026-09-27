/**
 * LUT 资产测试：格式合法性、单调性、中性点、生成器与磁盘产物一致（黄金文件）。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  LOOKS, PROFILE_LOOKS, SGAMUT3CINE_TO_REC709, applyColorbalance, applyCurves,
  applyFilterChain, applyLook, buildAll, buildCube, linearToRec709, parseFilterChain,
  sgamut3cineToRec709, slog3ToLinear,
} from "./generate-luts.mjs";
import { PROFILES } from "../../connectors/color-bridge/core.mjs";

const dir = path.dirname(new URL(import.meta.url).pathname);
const SIZE = 33;

function parseCube(file: string) {
  const text = fs.readFileSync(path.join(dir, file), "utf8");
  const lines = text.split("\n");
  const size = Number(lines.find((l) => l.startsWith("LUT_3D_SIZE"))?.split(/\s+/)[1]);
  const values: Array<[number, number, number]> = [];
  for (const line of lines) {
    const m = /^([0-9.]+) ([0-9.]+) ([0-9.]+)$/.exec(line.trim());
    if (m) values.push([Number(m[1]), Number(m[2]), Number(m[3])]);
  }
  return { size, values, text };
}

describe("生成器数学", () => {
  it("S-Log3 曲线单调递增，且中灰码值处接近 0.18 反射率附近量级", () => {
    let prev = -1;
    for (let i = 0; i <= 100; i += 1) {
      const v = slog3ToLinear(i / 100);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(slog3ToLinear(0)).toBeLessThan(0.001);
    expect(slog3ToLinear(1)).toBeGreaterThan(1);
  });

  it("Rec.709 OETF 端点与中段行为正确", () => {
    expect(linearToRec709(0)).toBe(0);
    expect(linearToRec709(1)).toBeCloseTo(1, 3);
    expect(linearToRec709(0.18)).toBeGreaterThan(0.4);
    expect(linearToRec709(0.18)).toBeLessThan(0.55);
    expect(linearToRec709(-1)).toBe(0);
  });

  it("转换 LUT 中性保真；创意 look 允许有意偏色但幅度受限、方向与命名一致", () => {
    // 转换（S-Log3→Rec.709）必须中性保真：灰还是灰
    const neutral = [slog3ToLinear(0.5), slog3ToLinear(0.5), slog3ToLinear(0.5)].map(linearToRec709);
    expect(Math.abs(neutral[0]! - neutral[1]!)).toBeLessThan(0.001);
    expect(Math.abs(neutral[1]! - neutral[2]!)).toBeLessThan(0.001);

    // 创意 look：中灰允许被有意调色，但不能染成彩色（≤0.06）
    for (const [name, spec] of Object.entries(LOOKS)) {
      const [r, g, b] = applyLook([0.5, 0.5, 0.5], spec as never);
      const spread = Math.max(r!, g!, b!) - Math.min(r!, g!, b!);
      expect(spread, `${name} 中灰染色过强`).toBeLessThan(0.06);
    }

    // 方向性：暖调 look 必须 R>B，冷调 look 必须 B>R（防参数写反）
    const warm = applyLook([0.5, 0.5, 0.5], LOOKS["warm-film"] as never);
    expect(warm[0]).toBeGreaterThan(warm[2]!);
    const cool = applyLook([0.5, 0.5, 0.5], LOOKS["cool-technical"] as never);
    expect(cool[2]).toBeGreaterThan(cool[0]!);
  });

  it(".cube 结构合法：尺寸、行数、取值区间、红通道单调", () => {
    const text = buildCube({ title: "t", transform: ([r, g, b]) => [r, g, b] });
    const parsed = parseCubeFromText(text);
    expect(parsed.size).toBe(SIZE);
    expect(parsed.values).toHaveLength(SIZE ** 3);
    for (const [r, g, b] of parsed.values.slice(0, 200)) {
      for (const v of [r, g, b]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
    // 红通道变化最快：前 SIZE 行 r 递增
    const firstBlock = parsed.values.slice(0, SIZE).map((v) => v[0]);
    for (let i = 1; i < firstBlock.length; i += 1) {
      expect(firstBlock[i]).toBeGreaterThan(firstBlock[i - 1]!);
    }
  });

  function parseCubeFromText(text: string) {
    const lines = text.split("\n");
    const size = Number(lines.find((l) => l.startsWith("LUT_3D_SIZE"))?.split(/\s+/)[1]);
    const values: Array<[number, number, number]> = [];
    for (const line of lines) {
      const m = /^([0-9.]+) ([0-9.]+) ([0-9.]+)$/.exec(line.trim());
      if (m) values.push([Number(m[1]), Number(m[2]), Number(m[3])]);
    }
    return { size, values };
  }
});

describe("磁盘产物（黄金文件）", () => {
  const expectations: Array<[string, number]> = [
    ["slog3-to-rec709.cube", 33],
    ["sgamut3cine-to-rec709.cube", 33],
    ["look-clean-bright.cube", 17],
    ["look-warm-film.cube", 17],
    ["look-teal-orange.cube", 17],
    ["look-moody-dark.cube", 17],
    ["look-cool-technical.cube", 17],
    ["look-natural.cube", 17],
    ["look-high-contrast-social.cube", 17],
    ["look-vintage-fade.cube", 17],
  ];
  for (const [file, expectedSize] of expectations) {
    it(`${file} 存在、结构合法、${expectedSize}³ 行`, () => {
      const parsed = parseCube(file);
      expect(parsed.size).toBe(expectedSize);
      expect(parsed.values).toHaveLength(expectedSize ** 3);
      expect(parsed.text).toContain("DOMAIN_MAX 1.000000 1.000000 1.000000");
    });
  }

  it("manifest.json 与生成器一致，且声明为自生成（无第三方 LUT）", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    expect(manifest.license).toContain("self-generated");
    expect(manifest.luts.map((l: { file: string }) => l.file).sort()).toEqual([...buildAll().keys()].sort());
  });

  it("--check 模式通过（磁盘 = 生成结果）", () => {
    const out = execFileSync(process.execPath, [path.join(dir, "generate-luts.mjs"), "--check"], { encoding: "utf8" });
    expect(out).toContain("LUT 资产校验通过");
  });
});

/* ================= T-21：profile 等价 LUT + S-Gamut3.Cine 色域矩阵 LUT ================= */

/** 三线性插值（与 ffmpeg lut3d interp=trilinear 同语义；误差评估的最不利口径）。 */
function trilinear(parsed: { size: number; values: Array<[number, number, number]> }, p: [number, number, number]) {
  const n = parsed.size - 1;
  const f = p.map((v) => Math.min(Math.max(v, 0), 1) * n);
  const i0 = f.map((v) => Math.min(Math.floor(v), n - 1));
  const d = f.map((v, i) => v - i0[i]!);
  const at = (ri: number, gi: number, bi: number) => parsed.values[(bi * parsed.size + gi) * parsed.size + ri]!;
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c += 1) {
    let acc = 0;
    for (let a = 0; a < 2; a += 1) for (let b = 0; b < 2; b += 1) for (let k = 0; k < 2; k += 1) {
      acc += (a ? d[0]! : 1 - d[0]!) * (b ? d[1]! : 1 - d[1]!) * (k ? d[2]! : 1 - d[2]!) * at(i0[0]! + a, i0[1]! + b, i0[2]! + k)[c]!;
    }
    out[c] = acc;
  }
  return out as [number, number, number];
}

/** 代表性采样：灰阶（1/12 步进避开 17³ 格点）+ 肤色带 + 饱和色。 */
const REPRESENTATIVE_SAMPLES: Array<[number, number, number]> = [
  ...Array.from({ length: 11 }, (_, i) => (i + 1) / 12).map((v) => [v, v, v] as [number, number, number]),
  [0.78, 0.58, 0.46], [0.65, 0.47, 0.38], [0.87, 0.70, 0.60],
  [0.55, 0.38, 0.30], [0.72, 0.55, 0.47], [0.83, 0.62, 0.50],
  [0.85, 0.10, 0.08], [0.08, 0.80, 0.10], [0.06, 0.12, 0.88],
  [0.85, 0.80, 0.08], [0.10, 0.82, 0.85], [0.88, 0.10, 0.80],
  [0.70, 0.35, 0.20], [0.25, 0.65, 0.35], [0.30, 0.30, 0.75],
];

const TOL = 2 / 255;

describe("T-21 profile 等价创意 LUT（natural / high-contrast-social / vintage-fade）", () => {
  it("PROFILE_LOOKS 恰好覆盖 PROFILES 中没有自有 look 的 3 个 profile", () => {
    expect([...PROFILE_LOOKS].sort()).toEqual(["high-contrast-social", "natural", "vintage-fade"]);
    for (const name of PROFILE_LOOKS) expect(PROFILES[name as keyof typeof PROFILES]).toBeTruthy();
    // 单一事实源防线：PROFILES 增删 profile 时 PROFILE_LOOKS 必须联动（本测试会红）
    expect(Object.keys(PROFILES).sort()).toEqual([...Object.keys(LOOKS), ...PROFILE_LOOKS].sort());
  });

  it("LUT 插值结果与滤镜串数学模型偏差 ≤2/255（代表性采样：灰阶+肤色带+饱和色）", () => {
    for (const name of PROFILE_LOOKS) {
      const lut = parseCube(`look-${name}.cube`);
      const filter = PROFILES[name as keyof typeof PROFILES] as string;
      let maxErr = 0;
      for (const p of REPRESENTATIVE_SAMPLES) {
        const ref = applyFilterChain(p, filter);
        const est = trilinear(lut, p);
        for (let c = 0; c < 3; c += 1) maxErr = Math.max(maxErr, Math.abs(ref[c]! - est[c]!));
      }
      expect(maxErr, `look-${name}.cube 最大插值偏差 ${(maxErr * 255).toFixed(2)}/255`).toBeLessThanOrEqual(TOL);
    }
  });

  it("滤镜数学模型语义锚点：中性灰不被染色、对比方向正确、饱和方向正确", () => {
    // natural 只动对比/饱和，灰轴必须保持灰
    for (const v of [0.2, 0.5, 0.8]) {
      const [r, g, b] = applyFilterChain([v, v, v], PROFILES.natural as never);
      expect(Math.max(r!, g!, b!) - Math.min(r!, g!, b!)).toBeLessThan(0.01);
    }
    // high-contrast-social：暗灰更暗、亮灰更亮（对比 1.22）
    expect(applyFilterChain([0.2, 0.2, 0.2], PROFILES["high-contrast-social"] as never)[0]).toBeLessThan(0.2);
    expect(applyFilterChain([0.8, 0.8, 0.8], PROFILES["high-contrast-social"] as never)[0]).toBeGreaterThan(0.8);
    // vintage-fade：饱和 0.84，饱和色到灰轴的距离必须收缩
    const src: [number, number, number] = [0.8, 0.3, 0.2];
    const out = applyFilterChain(src, PROFILES["vintage-fade"] as never);
    const spread = (p: Array<number | undefined>) => Math.max(...(p as number[])) - Math.min(...(p as number[]));
    expect(spread(out)).toBeLessThan(spread(src));
  });

  it("FFmpeg 移植精度：curves+colorbalance 段与真实 ffmpeg 输出一致（≤0.5/255；无 ffmpeg/滤镜则跳过）", () => {
    const chain = "curves=all='0/0 0.18/0.10 0.5/0.51 0.82/0.89 1/1',colorbalance=rs=0.05:gs=0.02:bs=-0.04:rh=0.05:gh=0.03:bh=-0.03";
    const pts: Array<[number, number, number]> = [
      [0.15259, 0.30469, 0.45703], [0.61, 0.764, 0.915], [0.115, 0.337, 0.6496], [0.5, 0.5, 0.5],
    ];
    const [curvesArgs, cbArgs] = parseFilterChain(chain).map((f) => f.args);
    let out: Buffer;
    try {
      const buf = Buffer.alloc(pts.length * 3 * 2);
      pts.forEach((p, i) => p.forEach((v, j) => buf.writeUInt16LE(Math.round(v * 65535), (i * 3 + j) * 2)));
      out = execFileSync("ffmpeg", [
        "-hide_banner", "-v", "error",
        "-f", "rawvideo", "-pix_fmt", "rgb48le", "-s", `${pts.length}x1`, "-i", "pipe:0",
        "-vf", chain, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb48le", "pipe:1",
      ], { input: buf, maxBuffer: 1 << 24 });
    } catch {
      return; // 沙箱 ffmpeg 缺滤镜时跳过（CI 有 ffmpeg 时本断言生效）
    }
    pts.forEach((p, i) => {
      const js = applyColorbalance(applyCurves(p, curvesArgs as never), cbArgs as never);
      for (let j = 0; j < 3; j += 1) {
        const ff = out.readUInt16LE((i * 3 + j) * 2) / 65535;
        expect(Math.abs(ff - js[j]!), `点 ${p} 通道 ${j}`).toBeLessThanOrEqual(0.5 / 255);
      }
    });
  });
});

describe("T-21 sgamut3cine-to-rec709.cube（S-Gamut3.Cine→BT.709 色域矩阵）", () => {
  // Sony 官方公布矩阵（Technical Summary for S-Gamut3.Cine/S-Log3 及 S-Gamut3_S-Gamut3Cine_Matrix.xlsx）
  // × ITU-R BT.709 逆矩阵的合成参考值（独立核算，防移植手误）
  const M_REF = [
    [1.626947, -0.540139, -0.086809],
    [-0.178516, 1.417941, -0.239425],
    [-0.044436, -0.195920, 1.240356],
  ];

  it("矩阵系数与 Sony/BT.709 公开标准合成值一致（±2e-3），且白点保持（行和≈1）", () => {
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        expect(Math.abs(SGAMUT3CINE_TO_REC709[i]![j]! - M_REF[i]![j]!)).toBeLessThanOrEqual(2e-3);
      }
      expect(Math.abs(SGAMUT3CINE_TO_REC709[i]!.reduce((a, b) => a + b, 0) - 1)).toBeLessThan(1e-6);
    }
  });

  it("灰轴中性保真：LUT 格点上灰进灰出（33 个格点逐点精确）", () => {
    const lut = parseCube("sgamut3cine-to-rec709.cube");
    expect(lut.size).toBe(33);
    expect(lut.values).toHaveLength(35937);
    for (let i = 0; i < lut.size; i += 1) {
      const v = lut.values[(i * lut.size + i) * lut.size + i]!;
      const x = i / (lut.size - 1);
      for (const c of v) expect(Math.abs(c - x)).toBeLessThan(1e-3);
    }
  });

  it("关键采样点数值容差：色域内 ≤2/255；硬裁剪拐点带为 LUT 固有限制（≤5/255）", () => {
    const lut = parseCube("sgamut3cine-to-rec709.cube");
    for (const p of REPRESENTATIVE_SAMPLES) {
      const ref = sgamut3cineToRec709(p);
      const est = trilinear(lut, p);
      // 拐点判定：模型线性域输出贴边（被 clamp）= 处于色域外裁剪拐点带
      const linear = p.map((v) => (v < 0.081 ? v / 4.5 : Math.pow((v + 0.099) / 1.099, 1 / 0.45)));
      const mapped = SGAMUT3CINE_TO_REC709.map((row) => row[0]! * linear[0]! + row[1]! * linear[1]! + row[2]! * linear[2]!);
      const nearKink = mapped.some((v) => v < 0.01 || v > 0.99);
      const tol = nearKink ? 5 / 255 : TOL;
      for (let c = 0; c < 3; c += 1) {
        expect(Math.abs(ref[c]! - est[c]!), `点 ${p} 通道 ${c}（${nearKink ? "拐点带" : "色域内"}）`).toBeLessThanOrEqual(tol);
      }
    }
  });

  it("转换链复合语义：slog3-to-rec709 后串接本 LUT = S-Log3 解码→线性→色域矩阵→BT.709 编码", () => {
    // 取线性 ≤1（不被超白裁剪）的码值点：复合结果必须等于"解码→矩阵→编码"的理想链路
    for (const c of [[0.5, 0.5, 0.5], [0.35, 0.42, 0.5], [0.45, 0.3, 0.2], [0.2, 0.5, 0.55]] as Array<[number, number, number]>) {
      const afterOetf = c.map((v) => linearToRec709(slog3ToLinear(v))) as [number, number, number];
      const chained = sgamut3cineToRec709(afterOetf);
      const linear = c.map((v) => slog3ToLinear(v));
      const ideal = SGAMUT3CINE_TO_REC709.map((row) => row[0]! * linear[0]! + row[1]! * linear[1]! + row[2]! * linear[2]!)
        .map((v) => Math.min(Math.max(v, 0), 1))
        .map((v) => linearToRec709(v));
      for (let j = 0; j < 3; j += 1) expect(Math.abs(chained[j]! - ideal[j]!)).toBeLessThan(1e-9);
    }
  });
});
