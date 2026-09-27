import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadCharacterEntry, loadCharacterLibrary, resolveShotCast } from "./character-archive.js";

/**
 * 随仓内置角色库的门禁（T-2026-0928-0002）：
 *   ① 1 号陈卓仍是**唯一默认**（defaultModel 不得被 2 号顶替）；
 *   ② 2 号林予安是原创虚构 AI 角色，档案可装载、8 角度齐备、按名字可解析；
 *   ③ 清单里每个内置模特都要有可解析档案（防止"只加清单不加资产"）。
 */
const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const CHARACTERS_ROOT = resolve(REPO_ROOT, "bundles/ai-video/library/characters");

describe("随仓内置角色库", () => {
  const registry = JSON.parse(readFileSync(resolve(CHARACTERS_ROOT, "registry.json"), "utf8")) as {
    defaultModel: string;
    models: Array<{ ordinal: number; id: string; name: string; archive: string }>;
  };

  it("默认模特仍是 1 号陈卓，2 号只在点名时使用", () => {
    expect(registry.defaultModel).toBe("chen-zhuo");
    expect(registry.models.map((model) => [model.ordinal, model.id])).toEqual([[1, "chen-zhuo"], [2, "lin-yu-an"]]);
  });

  it("登记的内置模特都有可装载档案，8 角度齐备", () => {
    for (const model of registry.models) {
      const entry = loadCharacterEntry(resolve(REPO_ROOT, model.archive));
      expect(entry, model.id).not.toBeNull();
      expect(entry!.id).toBe(model.id);
      expect(entry!.verification.status, `${model.id}: ${entry!.verification.issues.join("；")}`).toBe("passed");
      for (const angle of ["front", "threeQuarter", "closeup", "side", "back", "actionPose", "emotionCloseup", "handDetail"]) {
        expect(Object.keys(entry!.files), `${model.id} ${angle}`).toContain(angle);
      }
    }
  });

  it("2 号林予安按姓名可解析，且是原创虚构 AI 角色", () => {
    const library = loadCharacterLibrary(CHARACTERS_ROOT);
    expect([...library.keys()]).toEqual(expect.arrayContaining(["chen-zhuo", "lin-yu-an"]));
    const profile = JSON.parse(readFileSync(resolve(CHARACTERS_ROOT, "model-02-lin-yu-an/profile.json"), "utf8")) as { kind: string; id: string };
    expect(profile.kind).toBe("generated");
    const cast = resolveShotCast({ shotId: "S1", character: "林予安" }, [...library.values()].map((entry) => ({
      id: entry.id, name: entry.name, aliases: entry.aliases
    })));
    expect(cast.characters.map((character) => character.id)).toEqual(["lin-yu-an"]);
  });
});
