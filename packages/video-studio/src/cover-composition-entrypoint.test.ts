/** Actual CLI source selection with declared metadata; no rendered-material quality review. */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { afterAll, describe, expect, it } from "vitest";
import { coverShotHasCharacter, coverShotMatchesLead, coverShotCharacterIds, resolveCoverHero, resolveCoverComposition,
  fallbackCoverPlan, parseCoverPlan, buildCoverDesignPrompt, type CoverLeadSource, type CoverPlan, type CoverShotSource, type CoverComposition } from "./cover-design.js";
import { captureLineageInputs, createLineageReceipt, stageLineageApproved, type LineageReceipt } from "./production-lineage.js";

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
const names = new Set(["coverSourcesForShots", "coverCompositionForPlan", "callCoverDesigner", "record", "lineageStage"]);
const declarations = parsed.statements.filter(node => ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text));
if (declarations.length !== names.size) throw new Error("COVER_FIXTURE_INVALID: actual CLI source functions missing");
const selector = parsed.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === "selectCoverPlanForPolicy");
const selectionStart = source.indexOf("  /**\n   * ① 设计稿：");
const selectionEnd = source.indexOf("  /** 人物卡来源：", selectionStart);
if (selectionStart < 0 || selectionEnd < 0) throw new Error("COVER_FIXTURE_INVALID: actual selection block missing");
const compiled = ts.transpileModule([...declarations, ...selector].map(node => node.getFullText(parsed)).join("\n")
  + "\nasync function selectActualCover() {\n" + source.slice(selectionStart, selectionEnd)
  + "\nreturn { plan, designVia, designNote }; }"
  + "\nexports.api = { coverSourcesForShots, coverCompositionForPlan, callCoverDesigner, selectActualCover, record };",
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
interface Api {
  callCoverDesigner(input: unknown): Promise<string>;
  selectActualCover(): Promise<{ plan: CoverPlan; designVia: string; designNote: string }>;
  record(input: Record<string, unknown>): { stage: string; ok: boolean; degraded: boolean; lineage: LineageReceipt };
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
  it.each(["off", "blocking"])("actual %s selection and record preserve the correct publication state", async policy => {
    const dir = mkdtempSync(join(tmpdir(), "cover-lineage-"));
    try {
      // These bytes exercise provenance, not image decoding or artistic review.
      const submitted = join(dir, "submitted.json"), original = join(dir, "original.bin"), cover = join(dir, "cover.png");
      writeFileSync(submitted, JSON.stringify({ projectId: "fixture" }));
      writeFileSync(original, "synthetic input bytes"); writeFileSync(cover, "synthetic output bytes");
      const inputs = [submitted, original], snapshot = captureLineageInputs(inputs), sourceHash = sha(readFileSync(submitted));
      const rows: Array<{ stage: string; ok: boolean; degraded: boolean; lineage: LineageReceipt }> = [];
      let modelCalls = 0;
      const recipe = { component: originalHash, stage: "cover" };
      const sandbox = { ...context, exports: {} as { api: Api }, REVIEW_POLICY: policy, fallbackCoverPlan, parseCoverPlan, buildCoverDesignPrompt,
        WORKER_RUNTIME: { design: async () => { modelCalls++; throw new Error("fixture model unavailable"); } },
        designInput: { title: "前台排队了", archetype: "person-led", character: lead, shots: shots.map(shot => ({ shotId: shot.shotId })) },
        leadMatchedPersons: [shots[0], shots[2]], shots, fallbackBackground: shots[1], shotlist: { title: "前台排队了" },
        arg: (_name: string, value: unknown) => value, log: () => {}, sha256FileSync: (path: string) => sha(readFileSync(path)),
        SHOTS_FILE: submitted, sourceFileHash: sourceHash, PROJECT: "fixture", RUN_ID: "fixture-run", REVISION_CONTEXT: null,
        sourceHashFor: () => sourceHash, lineageRecipe: () => recipe, sourceSupportFiles: inputs, sourceSnapshot: snapshot,
        lineageInputPaths: new Map(), lineageInputSnapshots: new Map(), records: rows, STAGE_LOG: join(dir, "stages.jsonl"),
        stamp: () => "2026-10-07T00:00:00.000Z", createLineageReceipt, appendFileSync };
      runInNewContext(compiled, sandbox);
      const selection = await sandbox.exports.api.selectActualCover();
      const result = sandbox.exports.api.record({ stage: "cover", shotId: null, invoked: true, ok: true, cached: false,
        degraded: selection.designVia === "fallback", attempt: 1, ms: 0, artifact: cover,
        evidence: { designVia: selection.designVia, qualityReviewPerformed: false },
        verdict: { approved: true, degraded: false, score: null, qualityStatus: "unverified", evidence: [{ path: cover, sha256: sha(readFileSync(cover)) }] } });
      if (policy === "off") {
        expect(modelCalls).toBe(0); expect(selection.designVia).toBe("deterministic");
        expect(result).toMatchObject({ ok: true, degraded: false, lineage: { status: "passed", errors: [] } });
        expect(stageLineageApproved({ records: rows, projectId: "fixture", stage: "cover", sourceHash: () => sourceHash, recipe }).ok).toBe(true);
      } else {
        expect(modelCalls).toBe(1); expect(selection.designVia).toBe("fallback");
        expect(result).toMatchObject({ ok: false, degraded: true, lineage: { status: "unverified", errors: [] } });
        expect(stageLineageApproved({ records: rows, projectId: "fixture", stage: "cover", sourceHash: () => sourceHash, recipe }).ok).toBe(false);
      }
      expect(JSON.parse(readFileSync(join(dir, "stages.jsonl"), "utf8")).lineage).toEqual(result.lineage);
      if (policy === "off") {
        writeFileSync(cover, "changed output bytes");
        expect(stageLineageApproved({ records: rows, projectId: "fixture", stage: "cover", sourceHash: () => sourceHash, recipe }).ok).toBe(false);
        rmSync(cover);
        const missing = sandbox.exports.api.record({ stage: "cover", shotId: null, invoked: true, ok: true, cached: false,
          degraded: false, attempt: 1, ms: 0, artifact: cover, evidence: {}, verdict: { approved: true, degraded: false } });
        expect(missing.ok).toBe(false); expect(missing.lineage.status).toBe("unverified");
        expect(missing.lineage.errors.length).toBeGreaterThan(0);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
