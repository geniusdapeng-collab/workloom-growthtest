import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPortraitPlan, runPortraitAgent } from "./portrait-agent.js";
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
    expect(prompt).toContain("中性浅灰无缝背景");
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

  it("落盘 portraits/vN + portrait-sets/vN.json 并把新集置为 active", async () => {
    const root = mkdtempSync(join(tmpdir(), "wl-pagent-"));
    mkdirSync(join(root, "presenter"), { recursive: true });
    writeFileSync(join(root, "presenter", "profile.json"), JSON.stringify(profile(), null, 2));
    const calls: Array<Record<string, unknown>> = [];
    const result = await runPortraitAgent({
      libraryRoot: root, characterId: "presenter", apiKey: "k", model: "doubao-seedream-5-0-pro-260628",
      fetchImpl: fakeArk(calls), config: { seed: 20260925 }
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
      libraryRoot: root, characterId: "presenter", apiKey: "k", model: "m", fetchImpl: failing
    })).rejects.toThrow(/HTTP 400/);
    const updated = JSON.parse(readFileSync(join(root, "presenter", "profile.json"), "utf8")) as CharacterProfile;
    expect(updated.portraitSets!.filter((s) => s.active).map((s) => s.version)).toEqual([2]);
  });
});
