import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPortraitPlan, runPortraitAgent } from "./portrait-agent.js";
import { CLEAN_BACKGROUND_POLICY, type BackgroundCheck } from "./portrait-agent.js";
import type { CharacterProfile } from "./character-archive.js";

function profile(overrides: Partial<CharacterProfile> = {}): CharacterProfile {
  return {
    schemaVersion: "workloom.character-profile/v1",
    id: "presenter",
    name: "平江路讲述人",
    kind: "generated",
    identity: { gender: "女性", age: "三十岁上下" },
    appearance: { face: "鹅蛋脸、眼神温和", skin: "自然肤质、可见毛孔", eyes: "深棕、有眼神光", hair: "齐肩微卷深棕" },
    wardrobe: [{ name: "黑色缎面吊带长裙", detail: "珍珠细肩带" }],
    portraitSets: [{ version: 2, dir: "portraits/v2", angles: ["front"], source: "pure-t2i", active: true }],
    ...overrides
  };
}

describe("定妆照生成 Agent：规划", () => {
  it("默认纯写实 + 场景解耦：4 角度，提示词不含地点/道具/时段与 CG 词", () => {
    const plan = buildPortraitPlan(profile());
    expect(plan.version).toBe(3); // 自动 +1
    expect(plan.angles).toEqual(["front", "threeQuarter", "closeup", "side"]);
    expect(plan.mode).toBe("photoreal");
    const prompt = plan.prompts.front!;
    expect(prompt).toContain("与任何场景无关");
    /** 抠像友好硬约束（2026-09-24 产品所有者口径）：背景必须均匀、无渐变、无投影、可抠像 */
    expect(prompt).toContain("完全均匀的中性浅灰");
    expect(prompt).toContain("无渐变、无暗角");
    expect(prompt).toContain("无投影");
    expect(prompt).toContain("抠像");
    expect(prompt).toContain("5600K");
    expect(prompt).toContain("毛孔");
    for (const bad of ["平江路", "河道", "木窗", "清晨", "黄昏", "屋檐", "超写实", "CG", "3D 渲染", "柔光箱"]) {
      expect(prompt, `提示词不应包含「${bad}」`).not.toContain(bad);
    }
    expect(plan.negativeTerms).toContain("no golden hour");
    expect(plan.negativeTerms).toContain("no cartoon");
    expect(plan.negativeTerms).toContain("no plastic skin");
  });

  it("显式声明非写实风格 / 非人主体时豁免（并记录理由）", () => {
    const cartoon = buildPortraitPlan(profile({ style: "anime" } as Partial<CharacterProfile>));
    expect(cartoon.mode).toBe("stylized");
    expect(cartoon.reason).toContain("anime");
    const animal = buildPortraitPlan(profile({ kind: "virtual-preset", name: "橘猫" }));
    expect(animal.mode).toBe("photoreal"); // virtual-preset 仍是"人"，只有 animal/object 类 kind 才豁免
  });

  it("授权真人锚点：存在的照片进入 plan.anchors，缺失的被剔除且不阻断", () => {
    const root = mkdtempSync(join(tmpdir(), "wl-pagent-anchor-"));
    const real = join(root, "real-front.jpg");
    writeFileSync(real, Buffer.alloc(4096, 7));
    const plan = buildPortraitPlan(profile(), { anchorImages: [real, join(root, "missing.jpg")] });
    expect(plan.anchors).toEqual([real]);
    expect(plan.reason).toContain("图生图锚定 1 张");
    const none = buildPortraitPlan(profile(), { anchorImages: [join(root, "missing.jpg")] });
    expect(none.anchors).toEqual([]);
    expect(none.reason).toContain("默认口径");
  });
});

describe("定妆照生成 Agent：执行", () => {
  function fakeArk(calls: Array<Record<string, unknown>>): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/images/generations")) {
        calls.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return new Response(JSON.stringify({ data: [{ url: "https://cdn.example.invalid/p.png" }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(new Uint8Array(4096).fill(3), { status: 200 });
    }) as unknown as typeof fetch;
  }

  /**
   * 单测用的背景探针替身：默认全部合格。
   * 生产默认走 ffmpeg 实测硬闸；单测里的 fixture 不是真图片，必须显式注入替身，
   * 否则会被硬闸按「探针不可用 = 不合格」拦下（这正是 fail-closed 的预期行为）。
   */
  const passingProber = (): BackgroundCheck => ({
    ok: true, policy: CLEAN_BACKGROUND_POLICY.id, mode: "ring", bands: [], cornerSpread: 6, maxRange: 10, maxSat: 2, notes: []
  });

  it("落盘 portraits/vN + portrait-sets/vN.json 并把新集置为 active", async () => {
    const root = mkdtempSync(join(tmpdir(), "wl-pagent-"));
    mkdirSync(join(root, "presenter"), { recursive: true });
    writeFileSync(join(root, "presenter", "profile.json"), JSON.stringify(profile(), null, 2));
    const calls: Array<Record<string, unknown>> = [];
    const result = await runPortraitAgent({
      libraryRoot: root, characterId: "presenter", apiKey: "k", model: "doubao-seedream-5-0-pro-260628",
      fetchImpl: fakeArk(calls), config: { seed: 20260925, backgroundProber: passingProber }
    });
    expect(result.version).toBe(3);
    expect(Object.keys(result.files).sort()).toEqual(["closeup", "front", "side", "threeQuarter"]);
    expect(result.portraitSet.active).toBe(true);
    const saved = JSON.parse(readFileSync(join(root, "presenter", "portrait-sets", "v3.json"), "utf8")) as { angles: string[]; source: string };
    expect(saved.angles).toHaveLength(4);
    expect(saved.source).toBe("pure-t2i");
    const updated = JSON.parse(readFileSync(join(root, "presenter", "profile.json"), "utf8")) as CharacterProfile;
    expect(updated.portraitSets!.filter((s) => s.active).map((s) => s.version)).toEqual([3]);
    expect(calls).toHaveLength(4);
    expect(String(calls[0]!.prompt)).toContain("与任何场景无关");
  });

  it("出图失败即抛错（不写半套、不改 active）", async () => {
    const root = mkdtempSync(join(tmpdir(), "wl-pagent-fail-"));
    mkdirSync(join(root, "presenter"), { recursive: true });
    writeFileSync(join(root, "presenter", "profile.json"), JSON.stringify(profile(), null, 2));
    const failing = (async () => new Response("参数被拒", { status: 400 })) as unknown as typeof fetch;
    await expect(runPortraitAgent({
      libraryRoot: root, characterId: "presenter", apiKey: "k", model: "m", fetchImpl: failing,
      config: { backgroundProber: passingProber }
    })).rejects.toThrow(/HTTP 400/);
    const updated = JSON.parse(readFileSync(join(root, "presenter", "profile.json"), "utf8")) as CharacterProfile;
    expect(updated.portraitSets!.filter((s) => s.active).map((s) => s.version)).toEqual([2]);
  });

  it("逐角度隔离：单角度失败不作废整批，失败角度登记在案", async () => {
    const root = mkdtempSync(join(tmpdir(), "wl-pagent-partial-"));
    const charDir = join(root, "presenter");
    mkdirSync(charDir, { recursive: true });
    writeFileSync(join(charDir, "profile.json"), JSON.stringify(profile({ portraitSets: [] }), null, 2));
    const calls: string[] = [];
    /** front 成功；其余角度全部命中内容安全（模拟真机 actionPose 被拦） */
    const partial = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (!url.includes("/images/generations")) return new Response(new Uint8Array(4096).fill(9), { status: 200 });
      const body = JSON.parse(String(init?.body ?? "{}")) as { prompt?: string };
      const prompt = String(body.prompt ?? "");
      calls.push(prompt);
      const angle = prompt.includes("正面全身") ? "front" : prompt.includes("面部特写") ? "closeup" : prompt.includes("45 度") ? "threeQuarter" : "side";
      if (angle !== "front") {
        return new Response(JSON.stringify({ error: { code: "OutputImageSensitiveContentDetected", message: "sensitive" } }), { status: 400 });
      }
      return new Response(JSON.stringify({ data: [{ url: "https://cdn.example.invalid/p.png" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const result = await runPortraitAgent({
      libraryRoot: root, characterId: "presenter", apiKey: "k", model: "m", fetchImpl: partial,
      config: { backgroundProber: passingProber }
    });
    expect(Object.keys(result.files)).toEqual(["front"]);
    expect(result.failures.map((f) => f.angle).sort()).toEqual(["closeup", "side", "threeQuarter"]);
    const saved = JSON.parse(readFileSync(join(charDir, "portrait-sets", "v1.json"), "utf8")) as { angles: string[]; failedAngles?: Array<{ angle: string }> };
    expect(saved.angles).toEqual(["front"]);
    expect(saved.failedAngles).toHaveLength(3);
    const updated = JSON.parse(readFileSync(join(charDir, "profile.json"), "utf8")) as CharacterProfile & { portraitAgent?: { failures?: unknown[] } };
    expect(updated.portraitSets![0]!.active).toBe(true);
    expect(updated.portraitAgent?.failures).toHaveLength(3);
  });

  it("幂等：同角度文件已存在即复用，不重复请求出图", async () => {
    const root = mkdtempSync(join(tmpdir(), "wl-pagent-idem-"));
    const charDir = join(root, "presenter");
    mkdirSync(join(charDir, "portraits", "v1"), { recursive: true });
    writeFileSync(join(charDir, "profile.json"), JSON.stringify(profile({ portraitSets: [] }), null, 2));
    writeFileSync(join(charDir, "portraits", "v1", "平江路讲述人-front.png"), Buffer.alloc(4096, 5));
    const calls: Array<Record<string, unknown>> = [];
    const result = await runPortraitAgent({
      libraryRoot: root, characterId: "presenter", apiKey: "k", model: "m",
      fetchImpl: fakeArk(calls), config: { angles: ["front"], backgroundProber: passingProber }
    });
    expect(result.reused).toEqual(["front"]);
    expect(calls).toHaveLength(0);
    expect(result.portraitSet.angles).toEqual(["front"]);
  });

  it("背景硬闸：不干净就用加固措辞重跑，重跑干净才登记", async () => {
    const root = mkdtempSync(join(tmpdir(), "wl-pagent-bg-"));
    const charDir = join(root, "presenter");
    mkdirSync(charDir, { recursive: true });
    writeFileSync(join(charDir, "profile.json"), JSON.stringify(profile({ portraitSets: [] }), null, 2));
    const prompts: string[] = [];
    const fake = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/images/generations")) {
        prompts.push(String((JSON.parse(String(init?.body ?? "{}")) as { prompt?: string }).prompt ?? ""));
        return new Response(JSON.stringify({ data: [{ url: "https://cdn.example.invalid/p.png" }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(new Uint8Array(4096).fill(4), { status: 200 });
    }) as unknown as typeof fetch;
    let call = 0;
    const prober = (): BackgroundCheck => {
      call += 1;
      const ok = call > 1; // 第一张背景不干净，第二张干净
      return { ok, policy: CLEAN_BACKGROUND_POLICY.id, mode: "ring", bands: [], cornerSpread: ok ? 8 : 60, maxRange: ok ? 12 : 80, maxSat: 3, notes: ok ? [] : ["四角亮度极差 60.0 > 22（有暗角或方向性渐变）"] };
    };
    const result = await runPortraitAgent({
      libraryRoot: root, characterId: "presenter", apiKey: "k", model: "m",
      fetchImpl: fake, config: { angles: ["front"], backgroundProber: prober }
    });
    expect(result.files.front).toBeTruthy();
    expect(result.failures).toEqual([]);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("背景硬约束·重跑");
    expect(result.backgroundChecks.front!.ok).toBe(true);
  });

  it("背景硬闸：重跑仍不干净则该角度失败（不静默入库）", async () => {
    const root = mkdtempSync(join(tmpdir(), "wl-pagent-bg2-"));
    const charDir = join(root, "presenter");
    mkdirSync(charDir, { recursive: true });
    writeFileSync(join(charDir, "profile.json"), JSON.stringify(profile({ portraitSets: [] }), null, 2));
    const calls: Array<Record<string, unknown>> = [];
    /** 只有 closeup 的背景脏（模拟真机"某角度背景带暗角"），其余角度干净 */
    const perAngle = (file: string): BackgroundCheck => file.includes("closeup")
      ? { ok: false, policy: CLEAN_BACKGROUND_POLICY.id, mode: "ring", bands: [], cornerSpread: 70, maxRange: 90, maxSat: 4, notes: ["四角亮度极差 70.0 > 22（有暗角或方向性渐变）"] }
      : passingProber();
    const result = await runPortraitAgent({
      libraryRoot: root, characterId: "presenter", apiKey: "k", model: "m",
      fetchImpl: fakeArk(calls), config: { angles: ["front", "closeup"], backgroundProber: perAngle }
    });
    expect(result.files.closeup).toBeFalsy();
    expect(result.files.front).toBeTruthy();
    expect(result.failures[0]!.error).toContain("background_not_clean");
    const saved = JSON.parse(readFileSync(join(charDir, "portrait-sets", "v1.json"), "utf8")) as { angles: string[]; backgroundChecks?: Record<string, { ok: boolean }>; failedAngles?: Array<{ angle: string }> };
    expect(saved.angles).toEqual(["front"]);
    expect(saved.backgroundChecks!.closeup!.ok).toBe(false);
    expect(saved.failedAngles![0]!.angle).toBe("closeup");
  });

  it("图生图：锚点进请求体（image 字段）且定妆照集记为 img2img + 锚点相对路径", async () => {
    const root = mkdtempSync(join(tmpdir(), "wl-pagent-img2img-"));
    const charDir = join(root, "presenter");
    mkdirSync(join(charDir, "sources"), { recursive: true });
    writeFileSync(join(charDir, "profile.json"), JSON.stringify(profile(), null, 2));
    const anchorA = join(charDir, "sources", "real-front.jpg");
    const anchorB = join(charDir, "sources", "real-side.jpg");
    writeFileSync(anchorA, Buffer.alloc(5000, 1));
    writeFileSync(anchorB, Buffer.alloc(5000, 2));
    const calls: Array<Record<string, unknown>> = [];
    const result = await runPortraitAgent({
      libraryRoot: root, characterId: "presenter", apiKey: "k", model: "doubao-seedream-5-0-pro-260628",
      fetchImpl: fakeArk(calls),
      config: { anchorImages: [anchorA, anchorB], angles: ["front"], maxAnchors: 2, backgroundProber: passingProber }
    });
    const sent = calls[0]!.image as string[];
    expect(Array.isArray(sent)).toBe(true);
    expect(sent).toHaveLength(2);
    expect(sent[0]!.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(result.portraitSet.source).toBe("img2img");
    expect(result.portraitSet.anchors).toEqual(["sources/real-front.jpg", "sources/real-side.jpg"]);
    const saved = JSON.parse(readFileSync(join(charDir, "portrait-sets", "v3.json"), "utf8")) as { source: string; anchors?: string[] };
    expect(saved.source).toBe("img2img");
    expect(saved.anchors).toEqual(["sources/real-front.jpg", "sources/real-side.jpg"]);
  });
});
