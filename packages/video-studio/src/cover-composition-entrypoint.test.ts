/** Actual CLI source selection with declared metadata; no rendered-material quality review. */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { afterAll, describe, expect, it } from "vitest";
import { coverShotHasCharacter, coverShotMatchesLead, coverShotCharacterIds, resolveCoverHero, resolveCoverComposition,
  fallbackCoverPlan, type CoverLeadSource, type CoverPlan, type CoverShotSource, type CoverComposition } from "./cover-design.js";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const file = join(repo, "scripts/tools/full-chain-film.mts"), source = readFileSync(file, "utf8");
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const originalHash = sha(source);
interface AstNode { name?: { text: string }; getFullText(source: AstSource): string }
interface AstSource { statements: ReadonlyArray<AstNode> }
interface Compiler {
  ScriptTarget: { Latest: number; ES2022: number }; ModuleKind: { CommonJS: number };
  createSourceFile(path: string, source: string, target: number, parents: boolean): AstSource;
  isFunctionDeclaration(node: AstNode): boolean;
  transpileModule(source: string, options: { compilerOptions: { target: number; module: number } }): { outputText: string };
}
const ts = createRequire(join(repo, "packages/video-studio/package.json"))("typescript") as Compiler;
const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
const names = new Set(["coverSourcesForShots", "coverCompositionForPlan", "callCoverDesigner"]);
const declarations = parsed.statements.filter(node => ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text));
if (declarations.length !== names.size) throw new Error("COVER_FIXTURE_INVALID: actual CLI source functions missing");
const compiled = ts.transpileModule(declarations.map(node => node.getFullText(parsed)).join("\n")
  + "\nexports.api = { coverSourcesForShots, coverCompositionForPlan, callCoverDesigner };",
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
interface Api {
  callCoverDesigner(input: unknown): Promise<string>;
  coverSourcesForShots(shots: CoverShotSource[], lead: CoverLeadSource | null): {
    personShots: CoverShotSource[]; leadMatchedPersons: CoverShotSource[]; fallbackBackground: CoverShotSource;
  };
  coverCompositionForPlan(mode: string, plan: CoverPlan, background: CoverShotSource, person: CoverShotSource | null, lead: CoverLeadSource | null): CoverComposition;
}
const context = { exports: {} as { api: Api }, coverShotHasCharacter, coverShotMatchesLead, coverShotCharacterIds, resolveCoverComposition,
  REVIEW_POLICY: "off", fetch: () => { throw new Error("default design must not call a model"); } };
runInNewContext(compiled, context);
const api = context.exports.api;
afterAll(() => expect(sha(readFileSync(file)), "CLI source must remain immutable during this run").toBe(originalHash));
const lead = { id: "ceo", name: "出镜人物", appearanceInShots: ["FF-01", "FF-03"] };
const shots: CoverShotSource[] = [
  { shotId: "FF-01", characterId: "ceo", character: "出镜人物正面口播" },
  { shotId: "FF-02", character: "本镜为产品镜，画面没有人物；普通话女声只以模型原生画外音出现。" },
  { shotId: "FF-03", characterId: "ceo", character: "出镜人物邀请酒店老板咨询" }
];
const plan = fallbackCoverPlan({ title: "前台排队了", character: lead, shots: shots.map(shot => ({ shotId: shot.shotId })) },
  { headline: "前台排队了", heroShotId: "FF-02", personShotId: "FF-01" });

describe("封面正式 CLI 单主视觉与来源", () => {
  it("actual CLI keeps the product shot out of the people pool and uses it as the background candidate", () => {
    const sources = api.coverSourcesForShots(shots, lead);
    expect(sources.personShots.map(shot => shot.shotId)).toEqual(["FF-01", "FF-03"]);
    expect(sources.leadMatchedPersons.map(shot => shot.shotId)).toEqual(["FF-01", "FF-03"]);
    expect(sources.fallbackBackground.shotId).toBe("FF-02");
  });
  it("automatic CEO composition paints one complete source and places text below the face", () => {
    const result = api.coverCompositionForPlan("auto", plan, shots[1]!, shots[0]!, lead);
    expect(result).toMatchObject({ heroMode: "person-solo", heroShotId: "FF-01", insetEnabled: false, insetShotId: null, lowerBandText: true });
  });
  it.each(["landmark", "split", "person"])("legacy %s suppresses the same CEO from different frames", mode => {
    const result = api.coverCompositionForPlan(mode, plan, shots[2]!, shots[0]!, lead);
    expect(result.insetEnabled).toBe(false); expect(result.suppressedReason).toBe("same-character");
    expect(result.heroMode).toBe("person-solo"); expect(result.lowerBandText).toBe(true);
  });
  it("the same source shot cannot be painted twice even without known character identity", () => {
    const result = api.coverCompositionForPlan("landmark", plan, shots[0]!, shots[0]!, null);
    expect(result.insetEnabled).toBe(false); expect(result.suppressedReason).toBe("same-shot");
  });
  it("unknown identity does not permit a second person visual", () => {
    const result = api.coverCompositionForPlan("split", plan, { shotId: "a", character: "人物甲" }, { shotId: "b", character: "人物乙" }, null);
    expect(result.insetEnabled).toBe(false); expect(result.suppressedReason).toBe("second-person-visual");
  });
  it("an explicitly requested person composition may keep a different non-person product inset", () => {
    const result = api.coverCompositionForPlan("person", plan, shots[1]!, shots[0]!, lead);
    expect(result).toMatchObject({ heroShotId: "FF-01", insetEnabled: true, insetShotId: "FF-02", suppressedReason: null });
  });
  it("subject-only plans never require or paint a person card", () => {
    const subject = fallbackCoverPlan({ title: "产品", archetype: "subject-led", character: lead, shots: [{ shotId: "FF-01" }, { shotId: "FF-02" }] },
      { headline: "自助入住机", heroShotId: "FF-02", personShotId: "FF-01" });
    expect(subject.person.enabled).toBe(false);
    expect(api.coverCompositionForPlan("product", subject, shots[1]!, shots[0]!, lead)).toMatchObject({ heroShotId: "FF-02", insetEnabled: false });
    expect(resolveCoverHero("auto", false)).toBe("subject");
  });
  it("explicit absence, voice-only negation and declared appearance are distinguished", () => {
    expect(coverShotHasCharacter({ shotId: "FF-01", hasCharacter: false, characterId: "ceo" }, lead)).toBe(false);
    for (const character of ["画面无人物", "人物不出镜，仅女声旁白", "no people, native female voice-over"]) {
      expect(coverShotHasCharacter({ shotId: "FF-02", character }, lead)).toBe(false);
    }
    expect(coverShotMatchesLead({ shotId: "FF-01", character: "这位女士口播" }, lead)).toBe(true);
    expect(coverShotMatchesLead({ shotId: "FF-01", characterId: "another-person" }, lead)).toBe(false);
    expect(coverShotHasCharacter({ shotId: "drone", character: "无人机航拍，主角口播" }, null)).toBe(true);
  });
  it("actual default designer exits to deterministic design before any model call", async () => {
    await expect(api.callCoverDesigner({ shots: [] })).rejects.toThrow("COVER_DETERMINISTIC_DESIGN_DEFAULT");
  });
  it("empty sources and unknown layout fail explicitly before drawing", () => {
    expect(() => api.coverSourcesForShots([], null)).toThrow("COVER_SOURCE_SHOTS_EMPTY");
    expect(() => resolveCoverHero("unregistered", true)).toThrow(/未知封面主视觉/);
  });
});
