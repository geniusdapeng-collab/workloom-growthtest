/**
 * explayer.test.ts —— 口播解说片引擎单元/契约测试 · T-2026-0926-0008
 *
 * 覆盖（全部不触库、不联网）：
 *  ① 卡注册表：frontmatter 解析 / const 槽抽取 / 展示文案抽取（剥注释）/ 内容补丁（唯一命中约束）；
 *  ② 对齐器：数字汉字化、DP 逐字对齐、timing 展开契约；
 *  ③ SHOTBOOK 校验：逐字覆盖/白名单/同卡连用/素材在场/sfx 落点；
 *  ④ 引擎闸：许可口径（noncommercial vs authorized + LICENSE-GRANT.md）与就绪度；
 *  ⑤ 渲染 CLI 组装：--all/--changed/--only 三态与幂等参数。
 *
 * 真实引擎（vendor/talkcraft）在场时，追加一条装配契约测试（模板复制 + 卡保真 + props 结构）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCardRegistry, extractConstSlots, extractDisplayStrings, parseFrontmatter, patchCardSource } from "./card-registry.js";
import { alignScriptToTimestamps, expandToTiming, intToChinese, normalizeSpoken } from "./aligner.js";
import { licenseStateOf, engineStatus, REQUIRED_ENGINE_FILES } from "./engine.js";
import { deriveAnchors, deriveBeats, validateShotbook } from "./shotbook.js";
import { renderShotsArgs, renderWorkerCount, remotionSubmitParams, RemotionProvider } from "./remotion-provider.js";
import { explainerOutputSize, type ExplainerShotbook, type ExplainerScript, type SemanticsFile, type TimestampsFile } from "./types.js";

describe("输出画布契约", () => {
  it("默认 HD，UHD 竖屏与横屏均为原生尺寸", () => {
    expect(explainerOutputSize("9:16")).toEqual({ width: 1080, height: 1920 });
    expect(explainerOutputSize("9:16", "uhd")).toEqual({ width: 2160, height: 3840 });
    expect(explainerOutputSize("16:9", "uhd")).toEqual({ width: 3840, height: 2160 });
  });
});

const CARD_SRC = `import React from "react";
// 这是注释里的中文，不该进展示文案
export const meta = { width: 960, height: 540, fps: 30, durationInFrames: 110 };
const CONFIG = { lead: 0.3, hold: 1.8 };
const BARS = [16, 23, 30];
const MONTHS = ["1月", "2月", "3月"];
export default function Demo({ hostSrc }: { hostSrc?: string }) {
  return (
    <div>
      <h1>柱状增长</h1>
      <span>半年翻了一倍</span>
      {hostSrc}
    </div>
  );
}
`;

describe("card-registry", () => {
  it("解析 frontmatter（中文字段 + 列表拆分）", () => {
    const fm = parseFrontmatter(`---\nname: bar-chart-growth\n标题: 柱状增长\n输入: 文, 人(可选)\n语义: 数据\nprops: hostSrc\n---\n正文`);
    expect(fm.name).toBe("bar-chart-growth");
    expect(fm["标题"]).toBe("柱状增长");
    expect(fm["输入"]).toBe("文, 人(可选)");
  });

  it("抽取模块级 const 字面量槽（跳过函数与运行期表达式）", () => {
    const slots = extractConstSlots(CARD_SRC);
    const names = slots.map((s) => s.name);
    expect(names).toContain("BARS");
    expect(names).toContain("MONTHS");
    expect(names).toContain("CONFIG");
    expect(slots.find((s) => s.name === "BARS")?.value).toEqual([16, 23, 30]);
    expect(names).not.toContain("meta");
  });

  it("展示文案抽取剥掉注释里的中文", () => {
    const strings = extractDisplayStrings(CARD_SRC);
    expect(strings).toContain("柱状增长");
    expect(strings.some((s) => s.includes("不该进展示文案"))).toBe(false);
  });

  it("内容补丁：const 槽替换 + 唯一字符串替换；找不到/不唯一即抛错", () => {
    const patched = patchCardSource(CARD_SRC, {
      consts: { BARS: [40, 55, 72] },
      replaces: [{ from: "半年翻了一倍", to: "从 12 家到 260 家" }],
    });
    expect(patched.source).toContain("const BARS = [40,55,72];");
    expect(patched.source).toContain("从 12 家到 260 家");
    expect(patched.applied).toContain("const:BARS");
    expect(() => patchCardSource(CARD_SRC, { consts: { NOPE: 1 } })).toThrow(/找不到内容槽/);
    expect(() => patchCardSource(CARD_SRC, { replaces: [{ from: "柱状增长", to: "x" }] }))
      .not.toThrow();
    expect(() => patchCardSource(CARD_SRC.replace("半年翻了一倍", "重复字"), { replaces: [{ from: "重复字", to: "x" }] }))
      .not.toThrow();
    expect(() => patchCardSource("const A = 1;\nconst B = 1;\n", { replaces: [{ from: "1", to: "2" }] }))
      .toThrow(/不唯一/);
  });

  it("对象槽浅合并：只给要改的键，其余键（时间轴/缓动/几何）保持不变", () => {
    const patched = patchCardSource(CARD_SRC, { consts: { CONFIG: { hold: 3.2 } } });
    expect(patched.source).toContain('"lead":0.3');
    expect(patched.source).toContain('"hold":3.2');
    const config = JSON.parse(/const CONFIG = (.*);/.exec(patched.source)![1]!) as { lead: number; hold: number };
    expect(config).toEqual({ lead: 0.3, hold: 3.2 });
  });

  it("注册表白名单过滤", () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-cards-"));
    mkdirSync(join(dir, "references/cards"), { recursive: true });
    mkdirSync(join(dir, "template/cards"), { recursive: true });
    writeFileSync(join(dir, "references/cards/keep.md"), "---\nname: keep\n标题: 保留\n语义: 数据\n---\n");
    writeFileSync(join(dir, "references/cards/drop.md"), "---\nname: drop\n标题: 丢弃\n语义: 数据\n---\n");
    writeFileSync(join(dir, "template/cards/keep.tsx"), CARD_SRC);
    writeFileSync(join(dir, "template/cards/drop.tsx"), CARD_SRC);
    const registry = buildCardRegistry(dir, { whitelist: ["keep"] });
    expect(registry.entries.map((e) => e.slug)).toEqual(["keep"]);
    expect(registry.bySlug.get("keep")?.semantics).toEqual(["数据"]);
  });
});

describe("aligner", () => {
  it("阿拉伯数字 → 汉字读法（对齐键）", () => {
    expect(intToChinese(0)).toBe("零");
    expect(intToChinese(18)).toBe("十八");
    expect(intToChinese(260)).toBe("二百六十");
    expect(intToChinese(2026)).toBe("二千零二十六");
    expect(normalizeSpoken("成本下降12%，产能25万")).toContain("十二");
    expect(normalizeSpoken("成本下降12%")).not.toMatch(/[0-9%]/);
  });

  it("DP 逐字对齐：句级起止正确、match=1、words 逐字", () => {
    const script: ExplainerScript = {
      sentences: [
        { i: 1, text: "获客增长系统。" },
        { i: 2, text: "先有人群，再有内容。" },
      ],
    };
    // 模拟 ASR 词表（字级等分；含一个繁体"獲"验证繁简归一）
    const words = [
      { text: "獲客", start: 0, end: 0.6 },
      { text: "增长", start: 0.6, end: 1.2 },
      { text: "系统", start: 1.2, end: 1.8 },
      { text: "先有", start: 2.0, end: 2.4 },
      { text: "人群", start: 2.4, end: 2.8 },
      { text: "再有", start: 2.8, end: 3.2 },
      { text: "内容", start: 3.2, end: 3.6 },
    ];
    const result = alignScriptToTimestamps(script, words, 3.8);
    expect(result.total).toBe(3.8);
    expect(result.sentences).toHaveLength(2);
    expect(result.sentences[0]!.start).toBeCloseTo(0, 2);
    expect(result.sentences[0]!.end).toBeCloseTo(1.8, 2);
    expect(result.sentences[0]!.match).toBe(1);
    expect(result.sentences[0]!.ok).toBe(true);
    expect(result.sentences[1]!.start).toBeGreaterThanOrEqual(2.0);
    expect(result.sentences[1]!.words.map((w) => w.text).join("")).toBe("先有人群再有内容");
  });

  it("缺字插值：ASR 漏字时仍给出单调时间且不越界", () => {
    const script: ExplainerScript = { sentences: [{ i: 1, text: "一二三四五六" }] };
    const words = [
      { text: "一二", start: 0, end: 0.4 },
      { text: "五六", start: 1.0, end: 1.4 },
    ];
    const result = alignScriptToTimestamps(script, words, 1.5);
    const charTimes = result.sentences[0]!.words.map((w) => w.start);
    for (let i = 1; i < charTimes.length; i += 1) expect(charTimes[i]!).toBeGreaterThanOrEqual(charTimes[i - 1]!);
    expect(charTimes[charTimes.length - 1]!).toBeLessThanOrEqual(1.5);
    expect(result.sentences[0]!.match).toBeLessThan(1);
  });

  it("timing 展开：标点零时长、CJK 保留 token 跨度（vendor make_timing 同契约）", () => {
    const timestamps: TimestampsFile = {
      sr: 16000,
      total: 1.2,
      sentences: [{
        i: 1, text: "你好，AI。", start: 0, end: 1.2, asr: "", match: 1, ok: true,
        words: [
          { text: "你", start: 0, end: 0.3 },
          { text: "好", start: 0.3, end: 0.6 },
          { text: "ai", start: 0.8, end: 1.0 },
        ],
      }],
    };
    const chars = expandToTiming(timestamps);
    expect(chars.map((c) => c.ch).join("")).toBe("你好，AI。");
    const comma = chars.find((c) => c.ch === "，")!;
    expect(comma.t).toBe(comma.e);
    expect(chars.find((c) => c.ch === "你")!.t).toBe(0);
  });
});

describe("shotbook 校验", () => {
  const registryDir = mkdtempSync(join(tmpdir(), "tc-registry-"));
  mkdirSync(join(registryDir, "references/cards"), { recursive: true });
  mkdirSync(join(registryDir, "template/cards"), { recursive: true });
  for (const slug of ["card-a", "card-b", "card-c"]) {
    writeFileSync(join(registryDir, `references/cards/${slug}.md`), `---\nname: ${slug}\n标题: ${slug}\n语义: 数据\n---\n`);
    writeFileSync(join(registryDir, `template/cards/${slug}.tsx`), CARD_SRC.replace("柱状增长", slug));
  }
  const registry = buildCardRegistry(registryDir);
  const script: ExplainerScript = { sentences: [{ i: 1, text: "第一句话。" }, { i: 2, text: "第二句话。" }] };
  const timestamps: TimestampsFile = {
    sr: 16000, total: 6,
    sentences: [
      { i: 1, text: "第一句话。", start: 0, end: 2.5, asr: "", match: 1, ok: true, words: [{ text: "第", start: 0, end: 0.2 }, { text: "一", start: 0.2, end: 0.4 }] },
      { i: 2, text: "第二句话。", start: 2.5, end: 6, asr: "", match: 1, ok: true, words: [{ text: "第", start: 2.5, end: 2.7 }, { text: "二", start: 2.7, end: 2.9 }] },
    ],
  };
  const semantics: SemanticsFile = {
    sentences: [
      { i: 1, text: "第一句话。", sem: "论点", weight: "main", entities: [], need: "", shot: null },
      { i: 2, text: "第二句话。", sem: "数据", weight: "main", entities: [], need: "", shot: null },
    ],
  };
  const good: ExplainerShotbook = {
    style: { domain: "测试", tone: "克制", palette: { base: "#000", accent: "#fff", ink: "#eee" }, font: "sans", energy: "中" },
    rhythmTable: [
      { shotId: "s01", hostForm: "半身", container: "装框", card: "card-a" },
      { shotId: "s02", hostForm: "角标左下", container: "底床", card: "card-b" },
    ],
    shots: [
      { id: "s01", start: 0, end: 2.5, text: "第一句话。", card: "card-a", content: {}, replace: [], skin: {}, material: { kind: "文" }, sfx: [], notes: "" },
      { id: "s02", start: 2.5, end: 6, text: "第二句话。", card: "card-b", content: {}, replace: [], skin: {}, material: { kind: "文" }, sfx: [], notes: "" },
    ],
  };
  const check = (shotbook: ExplainerShotbook) =>
    validateShotbook({ shotbook, script, timestamps, registry, engineDir: registryDir });

  it("正样本通过（含 beats/anchors 派生）", () => {
    const result = check(good);
    expect(result.errors).toEqual([]);
    const beats = deriveBeats(good, timestamps, semantics);
    expect(beats).toHaveLength(2);
    expect(beats[0]!.anchor).toBe("第一");
    expect(timestamps.sentences.some((s) => s.words.some((w) => w.text === "第"))).toBe(true);
    const anchors = deriveAnchors(beats, good);
    expect(anchors[0]!.burst).toBe(true); // 首镜必须连拍
  });

  it("文本改写/漏字 → FAIL（防编造）", () => {
    const bad = { ...good, shots: [{ ...good.shots[0]!, text: "改写过的句子。" }, good.shots[1]!] };
    const result = check(bad as ExplainerShotbook);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.rule === "文本")).toBe(true);
  });

  it("卡不在白名单 → FAIL", () => {
    const bad = { ...good, shots: [{ ...good.shots[0]!, card: "card-z" }, good.shots[1]!] };
    const result = check(bad as ExplainerShotbook);
    expect(result.errors.some((e) => e.rule === "选卡")).toBe(true);
  });

  it("同卡连用 3 镜 → FAIL；短镜 → FAIL；素材缺 ref → FAIL", () => {
    const three = {
      ...good,
      shots: [
        { ...good.shots[0]!, id: "s01", start: 0, end: 2, card: "card-a" },
        { ...good.shots[1]!, id: "s02", start: 2, end: 4, card: "card-a", text: "第二句话。" },
        { ...good.shots[1]!, id: "s03", start: 4, end: 6, card: "card-a", text: "第二句话。" },
      ],
      rhythmTable: [
        { shotId: "s01", hostForm: "半身", container: "装框", card: "card-a" },
        { shotId: "s02", hostForm: "半身", container: "装框", card: "card-a" },
        { shotId: "s03", hostForm: "半身", container: "装框", card: "card-a" },
      ],
    };
    const result = check(three as ExplainerShotbook);
    expect(result.errors.some((e) => e.rule === "版式")).toBe(true);
    const shortShot = {
      ...good,
      shots: [
        { ...good.shots[0]!, end: 0.5 },
        { ...good.shots[1]!, start: 0.5 },
      ],
    };
    expect(check(shortShot as ExplainerShotbook).errors.some((e) => /镜长/.test(e.message))).toBe(true);
    const noRef = {
      ...good,
      shots: [{ ...good.shots[0]!, material: { kind: "图" } }, good.shots[1]!],
    };
    expect(check(noRef as ExplainerShotbook).errors.some((e) => e.rule === "素材")).toBe(true);
  });

  it("sfx 落点越界 → FAIL", () => {
    const badSfx = {
      ...good,
      shots: [{ ...good.shots[0]!, sfx: [{ t: 2.4, name: "whoosh", vol: 0.3 }] }, good.shots[1]!],
    };
    const result = check(badSfx as ExplainerShotbook);
    expect(result.errors.some((e) => e.rule === "音效")).toBe(true);
  });
});

describe("engine 许可闸与就绪度", () => {
  const fakeEngine = (opts: { license?: boolean; grant?: boolean } = {}): string => {
    const dir = mkdtempSync(join(tmpdir(), "tc-engine-"));
    for (const rel of REQUIRED_ENGINE_FILES) {
      const path = join(dir, rel);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, rel === "LICENSE" ? "PolyForm Noncommercial License 1.0.0" : "x");
    }
    mkdirSync(join(dir, "template/cards"), { recursive: true });
    mkdirSync(join(dir, "template/motion-systems"), { recursive: true });
    mkdirSync(join(dir, "references/cards"), { recursive: true });
    writeFileSync(join(dir, "template/cards/a.tsx"), "// card");
    writeFileSync(join(dir, "PINNED"), JSON.stringify({ commit: "deadbeef", cards: 108 }));
    if (opts.grant) writeFileSync(join(dir, "LICENSE-GRANT.md"), "授权方：A\n被授权方：B\n范围：C\n日期：2026-09-26\n");
    if (opts.license === false) {
      writeFileSync(join(dir, "LICENSE"), "");
    }
    mkdirSync(join(dir, "runtime"), { recursive: true });
    writeFileSync(join(dir, "runtime/package.json"), JSON.stringify({ dependencies: { remotion: "4.0.519" } }));
    return dir;
  };

  it("noncommercial：无授权文件也可渲染（评估口径）", () => {
    const dir = fakeEngine();
    const license = licenseStateOf(dir, { TALKCRAFT_LICENSE_SCOPE: "noncommercial" });
    expect(license.okToRender).toBe(true);
    expect(license.upstreamLicenseKind).toBe("polyform-noncommercial");
  });

  it("authorized：缺 LICENSE-GRANT.md → 拒绝渲染；补齐即通过", () => {
    const without = fakeEngine();
    expect(licenseStateOf(without, { TALKCRAFT_LICENSE_SCOPE: "authorized" }).okToRender).toBe(false);
    const withGrant = fakeEngine({ grant: true });
    expect(licenseStateOf(withGrant, { TALKCRAFT_LICENSE_SCOPE: "authorized" }).okToRender).toBe(true);
  });

  it("就绪度：缺运行时依赖/冒烟标记 → ready=false 且原因可执行", () => {
    const dir = fakeEngine();
    const status = engineStatus(dir, { TALKCRAFT_LICENSE_SCOPE: "noncommercial" });
    expect(status.installed).toBe(true);
    expect(status.cardCount).toBe(1);
    expect(status.ready).toBe(false);
    expect(status.reason).toMatch(/运行时/);
  });

  it("非法许可口径直接抛错（不静默回落）", () => {
    const dir = fakeEngine();
    expect(() => licenseStateOf(dir, { TALKCRAFT_LICENSE_SCOPE: "whatever" })).toThrow(/TALKCRAFT_LICENSE_SCOPE/);
  });
});

describe("渲染 CLI 组装", () => {
  it("UHD 强制单段单帧，HD 维持可配置并行度", () => {
    expect(renderWorkerCount(2160, 3840, 8)).toBe(1);
    expect(renderWorkerCount(3840, 2160, 2)).toBe(1);
    expect(renderWorkerCount(1080, 1920, 2)).toBe(2);
    expect(() => renderWorkerCount(1080, 1920, 0)).toThrow(/正整数/);
  });

  it("三态范围与参数顺序（render_shots.mjs 真实契约）", () => {
    expect(renderShotsArgs({ scope: "full", parallel: 2, muxOut: "../out/v1.mp4", propsFile: "props.json" }))
      .toEqual(["--shots", "shots.json", "--all", "--parallel", "2", "--mux", "../out/v1.mp4", "--props", "@props.json"]);
    expect(renderShotsArgs({ scope: "changed:s07" })).toEqual(["--shots", "shots.json", "--changed", "s07", "--parallel", "2"]);
    expect(renderShotsArgs({ scope: "only:s07,s08" })).toEqual(["--shots", "shots.json", "--only", "s07,s08", "--parallel", "2"]);
    expect(() => renderShotsArgs({ scope: "nope" })).toThrow(/渲染范围非法/);
  });
});

describe("真实引擎契约（vendor/talkcraft 在场时才跑）", () => {
  const engineDir = join(process.cwd(), "vendor/talkcraft");
  const enabled = existsSync(join(engineDir, "PINNED"));
  it.skipIf(!enabled)("108 张卡与 frontmatter 可解析（抽样 5 张）", () => {
    const registry = buildCardRegistry(engineDir);
    expect(registry.entries.length).toBeGreaterThanOrEqual(100);
    for (const entry of registry.entries.slice(0, 5)) {
      expect(entry.slug.length).toBeGreaterThan(0);
      expect(entry.codePath).toMatch(/template\/cards\//);
      expect(readFileSync(join(engineDir, entry.codePath), "utf8").length).toBeGreaterThan(200);
    }
  });
});


describe("Remotion provider 参数合同", () => {
  it("唯一提交入口的 extra 参数与 CLI 顶层参数得到相同执行参数", () => {
    const params = { jobDir: "/tmp/prepared", audioSeconds: 6.25, scope: "only:s01,s02", parallel: 3 };
    const nested = remotionSubmitParams({ prompt: "script", estimatedUnits: 6, params: { durationSec: 6, extra: params } });
    expect(nested).toEqual(remotionSubmitParams({ prompt: "script", estimatedUnits: 6, params }));
    expect(renderShotsArgs(nested)).toContain("s01,s02");
    expect(nested.jobDir).toBe("/tmp/prepared");
  });
  it("冲突参数与空范围在任何文件写入/进程启动前拒绝", async () => {
    const provider = new RemotionProvider({ env: {} });
    await expect(provider.submit({ prompt: "script", estimatedUnits: 6, params: { jobDir: "/a", extra: { jobDir: "/b" } } })).rejects.toThrow("冲突");
    await expect(provider.submit({ prompt: "script", estimatedUnits: 6, params: { extra: { scope: "only:", audioSeconds: 5 } } })).rejects.toThrow();
    await expect(provider.submit({ prompt: "script", estimatedUnits: 6, params: { extra: { parallel: 0 } } })).rejects.toThrow();
  });
});

describe("解说片 submit 路由不可变请求复放", () => {
  let caller: any;
  const scope = { tenantId: "tenant-ex", workspaceId: "workspace-ex" };
  let saved: any;
  let row: any;
  const prepare = vi.fn(), submit = vi.fn(), create = vi.fn(), approve = vi.fn(), update = vi.fn(), renderJob = vi.fn();
  const query = vi.fn();
  beforeAll(async () => {
    const { initTRPC } = await import("@trpc/server");
    const t = initTRPC.context<any>().create();
    vi.doMock("../../trpc/context.js", () => ({ router: t.router, protectedProcedure: t.procedure,
      writeProcedure: t.procedure, scopeOf: (identity: any) => ({ tenantId: identity.tenantId, workspaceId: identity.workspaceId }) }));
    vi.doMock("@workloom/db", () => ({ getAppPool: () => ({}), getGatewayPool: () => ({}) }));
    vi.doMock("../gen/submit.js", () => ({ submitGenJob: submit }));
    vi.doMock("@workloom/base/asset-cms", () => ({ create, approve }));
    vi.doMock("@workloom/base/fence-engine", () => ({ judge: () => ({ level: "auto", impacts: [], triggeredBy: [] }) }));
    vi.doMock("@workloom/base/model-router", () => ({ checkRenderBudget: () => ({ allowed: true }), planTierToPlanId: () => "pro" }));
    vi.doMock("../router.js", () => ({ loadActiveRules: async () => ({ rules: [], defaultLevel: "auto" }) }));
    vi.doMock("./pipeline.js", () => ({ runExplainerPipeline: prepare }));
    vi.doMock("./db.js", () => ({ scopedQuery: query, projectOf: async () => ({ id: "project-ex", kind: "explainer" }),
      latestShotbook: async () => row, updateShotbook: update, renderJobOf: renderJob }));
    caller = (await import("./router.js")).explainerRouter.createCaller({ identity: { ...scope, memberNo: "MEM-EX", plan: "pro" } } as any);
  });
  beforeEach(() => {
    saved = null;
    row = { id: "shotbook", project_id: "project-ex", version: 3, script_text: "正文句子。", shotbook: { shots: [{ id: "s1", card: "verified-card" }] } };
    prepare.mockReset().mockResolvedValue({ jobDir: "/tmp/prepared-project", voice: { sha256: "voice" }, timestamps: { total: 5.4, sentences: [{ i: 1, ok: true }] } });
    submit.mockReset().mockResolvedValue({ taskId: "accepted-task" }); update.mockReset();
    renderJob.mockReset().mockResolvedValue(null);
    create.mockReset().mockImplementation(async (_a, _g, _s, input) => {
      saved = { id: `${input.scriptKey}-v1`, project_id: input.projectId, shot_id: input.shotId, script_key: input.scriptKey,
        version: 1, md: input.md, fields: input.fields, status: "draft" };
      return saved;
    });
    approve.mockReset().mockImplementation(async () => { saved = { ...saved, status: "approved" }; return { script: saved }; });
    query.mockReset().mockImplementation(async (sql, params, actualScope) => {
      expect(actualScope).toEqual(scope);
      if (sql.includes("SELECT s.* FROM render_scripts")) {
        expect(params).toEqual([scope.workspaceId, expect.stringMatching(/^explainer-shotbook(?:-uhd)?$/), scope.tenantId, "project-ex"]);
        return saved && (!saved.script_key || saved.script_key === params[1]) ? [saved] : [];
      }
      if (sql.includes("SUM(")) return [{ total: "0" }];
      if (sql.includes("FROM explainer_shotbooks")) return [row];
      throw new Error(`unexpected query ${sql}`);
    });
  });
  it("接受后记账失败重试复用相同 script/version/params，不重做配音工程，不重复审批", async () => {
    submit.mockRejectedValueOnce(new Error("SUBMISSION_FINALIZATION_PENDING"));
    await expect(caller.submit({ projectId: "project-ex" })).rejects.toThrow("SUBMISSION_FINALIZATION_PENDING");
    const first = submit.mock.calls[0]?.[0];
    await caller.submit({ projectId: "project-ex" });
    const repeated = submit.mock.calls[1]?.[0];
    expect(repeated.script).toEqual(first.script); expect(repeated.params).toEqual(first.params);
    expect(prepare).toHaveBeenCalledTimes(1); expect(create).toHaveBeenCalledTimes(1); expect(approve).toHaveBeenCalledTimes(1);
    expect(repeated.idempotencyKey).toBe("explainer:shotbook:v3");
  });
  it("UHD 采用独立脚本与幂等键，重试沿用已装配的原生 4K 画布", async () => {
    await caller.submit({ projectId: "project-ex", quality: "uhd" });
    const first = submit.mock.calls[0]?.[0];
    expect(first.script.script_key).toBe("explainer-shotbook-uhd");
    expect(first.idempotencyKey).toBe("explainer:shotbook:v3:uhd");
    expect(first.params.resolution).toBe("2160x3840");
    expect(prepare.mock.calls[0]?.[0].quality).toBe("uhd");
    await caller.submit({ projectId: "project-ex", quality: "uhd" });
    const repeated = submit.mock.calls[1]?.[0];
    expect(repeated.script).toEqual(first.script);
    expect(repeated.params).toEqual(first.params);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(approve).toHaveBeenCalledTimes(1);
  });
  it("另一清晰度仍在渲染时拒绝覆盖分镜的工程目录", async () => {
    renderJob.mockImplementation(async (_scope, key) => key === "explainer:shotbook:v3:uhd" ? { status: "running" } : null);
    await expect(caller.submit({ projectId: "project-ex" })).rejects.toThrow("仍在运行");
    expect(prepare).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });
  it.each([{ voiceProfile: "changed" }, { renderScope: "only:s1" }, { assets: [{ from: "/a", to: "b" }] }])("相同分镜改变输入 %j，在重做准备/调用供应商前拒绝", async (patch) => {
    await caller.submit({ projectId: "project-ex" });
    await expect(caller.submit({ projectId: "project-ex", ...patch })).rejects.toThrow("绑定其他");
    expect(prepare).toHaveBeenCalledTimes(1); expect(submit).toHaveBeenCalledTimes(1);
  });
  it("同工作区其他项目分镜不能套用当前项目提交或交付", async () => {
    row.project_id = "project-other";
    await expect(caller.submit({ projectId: "project-ex", shotbookId: "shotbook" })).rejects.toThrow("不属于");
    await expect(caller.finalize({ projectId: "project-ex", shotbookId: "shotbook" })).rejects.toThrow("当前项目");
    expect(prepare).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled();
  });
  it("旧脚本缺少不可变请求凭据时拒绝重建和重发", async () => {
    saved = { id: "legacy", version: 6, md: "old", fields: {} };
    await expect(caller.submit({ projectId: "project-ex" })).rejects.toThrow("未核实");
    expect(prepare).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
  });
});
