import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectFinalCharacterQualification } from "./final-shot-character-qualification.js";

const repoRoot = resolve(import.meta.dirname, "../../..");
const portrait =
  "bundles/ai-video/library/characters/model-01-chen-zhuo/portraits/v3/平江路讲述人-front.png";

function qualifiedShot(prompt = `17.【定妆照】image://characters/model-01-chen-zhuo/portraits/v3/平江路讲述人-front.png。`) {
  return {
    shotId: "S1",
    duration: 5,
    characters: ["chen-zhuo"],
    characterRef: "chen-zhuo: image://characters/model-01-chen-zhuo/portraits/v3/平江路讲述人-front.png",
    characterConstraint: "画面只出现陈卓一人，禁止分身。",
    prompt,
    fields: {
      portraits: portrait,
    },
  };
}

describe("final character qualification", () => {
  it("accepts a registered, authorized, current portrait bound to the shot and PRD", () => {
    const result = inspectFinalCharacterQualification({
      repoRoot,
      shots: [qualifiedShot()],
      portraitStudio: { status: "completed" },
      portraitResolver: { studioCount: 1, uploadedCount: 0, textCount: 0 },
      characterSystem: {
        characters: [{
          characterId: "chen-zhuo",
          name: "陈卓",
          portraitPath: portrait,
          authorization: "real-authorized",
        }],
      },
    });
    expect(result).toMatchObject({
      pass: true,
      issues: [],
      resolver: { studioCount: 1, uploadedCount: 0, textCount: 0 },
    });
  });

  it.each([
    ["PENDING_GENERATION", qualifiedShot()],
    ["厂商占位路径", { ...qualifiedShot(), fields: { portraits: "/characters/character/portrait_v1.png" } }],
    ["空镜冲突", { ...qualifiedShot(), characterConstraint: "本镜为空镜，画面不得出现任何人物。" }],
  ])("fails closed for %s", (_label, shot) => {
    const result = inspectFinalCharacterQualification({
      repoRoot,
      shots: [shot],
      portraitStudio: { status: "skipped", reason: "auto(G5_PORTRAIT)" },
      portraitResolver: { studioCount: 0, uploadedCount: 0, textCount: 1 },
      characterSystem: {
        characters: [{ characterId: "chen-zhuo", name: "陈卓", portraitPath: portrait }],
      },
    });
    expect(result.pass).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("does not require a portrait for an object-only shot", () => {
    const result = inspectFinalCharacterQualification({
      repoRoot,
      shots: [{
        shotId: "S6",
        duration: 3,
        characters: [],
        characterRef: "NONE",
        characterConstraint: "本镜为产品空镜，禁止出现任何人物。",
        fields: { portraits: "/characters/character/portrait_v1.png" },
        prompt: "产品特写，无人物。",
      }],
      portraitStudio: { status: "skipped", reason: "no-characters-or-products" },
      portraitResolver: { studioCount: 0, uploadedCount: 0, textCount: 0 },
      characterSystem: { characters: [] },
    });
    expect(result).toMatchObject({ pass: true, issues: [] });
  });
});
