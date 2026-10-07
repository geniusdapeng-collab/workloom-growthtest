/** Executes the current CLI declarations against local source bytes, not model/identity fixtures. */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { assessCharacterRelease, assessRenderedCharacterUse, buildCharacterReleaseContract, generationIdentityLock,
  type CharacterReleaseReport } from "../../packages/video-studio/src/character-release-contract.js";
import { REAL_PERSON_ASSET_SCHEMA } from "../../packages/video-studio/src/real-person-asset.js";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const file = join(REPO, "scripts/tools/full-chain-film.mts"), source = readFileSync(file, "utf8");
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const sourceHash = hash(source);
interface AstNode { name?: { text: string }; getFullText(source: AstSource): string }
interface AstSource { statements: ReadonlyArray<AstNode> }
interface AstCompiler {
  ScriptTarget: { Latest: number; ES2022: number }; ModuleKind: { CommonJS: number };
  createSourceFile(path: string, source: string, target: number, parents: boolean): AstSource;
  isFunctionDeclaration(node: AstNode): boolean;
  transpileModule(source: string, options: { compilerOptions: { target: number; module: number } }): { outputText: string };
}
const ts = createRequire(join(REPO, "packages/video-studio/package.json"))("typescript") as AstCompiler;
const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
const names = new Set(["assertCharacterRenderPreflight", "characterArtifact", "characterReleaseReport",
  "assertCharacterCanaryBeforeSubmit", "verifyCharacterClip", "qualityAccidentsForReview", "pickCoverFrameForPolicy", "inspectCoverForPolicy", "coverChecksPassed"]);
const declarations = parsed.statements.filter(node => ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text));
if (declarations.length !== names.size) throw new Error("MATERIAL_USE_FIXTURE_INVALID: current CLI declarations missing");
const compiled = ts.transpileModule(declarations.map(node => node.getFullText(parsed)).join("\n")
  + "\nexports.api = { assertCharacterRenderPreflight, characterReleaseReport, assertCharacterCanaryBeforeSubmit, verifyCharacterClip, qualityAccidentsForReview, pickCoverFrameForPolicy, inspectCoverForPolicy, coverChecksPassed };",
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
afterAll(() => expect(hash(readFileSync(file)), "the tested CLI source must not change during execution").toBe(sourceHash));
interface Row { stage: string; shotId: string; evidence: Record<string, unknown> }
interface Api {
  assertCharacterRenderPreflight(): void;
  characterReleaseReport(phase: "canary" | "release"): CharacterReleaseReport;
  assertCharacterCanaryBeforeSubmit(shotId: string): void;
  verifyCharacterClip(shot: { shotId: string }, prompt: string): Promise<boolean>;
  qualityAccidentsForReview(file: string): { blackSeconds: number; silenceSeconds: number } | null;
  pickCoverFrameForPolicy(times: number[], inspect: (atSec: number) => number): { atSec: number; sharpness: number | null };
  inspectCoverForPolicy(facts: { bytes: number; width: number; height: number; expectedWidth: number; expectedHeight: number; cleanSource: boolean },
    inspect: () => { checks: { id: string; pass: boolean; hard?: boolean }[]; measurements: unknown }): { checks: { id: string; pass: boolean; hard?: boolean }[]; measurements: unknown };
  coverChecksPassed(checks: { id: string; pass: boolean; hard?: boolean }[]): boolean;
}
function fixture(policy = "off") {
  const root = mkdtempSync(join(tmpdir(), "film-rendered-use-")); roots.push(root);
  const asset = { schemaVersion: REAL_PERSON_ASSET_SCHEMA, assetId: "asset-fixture", displayName: "Fixture only",
    certified: { gender: "female" as const, source: "local structural fixture; no identity certification" },
    authorization: { status: "real-authorized" as const, scope: "local fixture", evidence: "synthetic fixture registration" } };
  const shots = [{ shotId: "S1" }, { shotId: "S2" }];
  const contract = buildCharacterReleaseContract({ projectId: "VID-FIXTURE", assets: [asset],
    characters: [{ characterId: "person", assetId: asset.assetId, wardrobeLock: { id: "fixture", description: "fixture suit" },
      identityAnchor: { path: join(root, "registered.jpg"), sha256: hash("fixture reference"), assetId: asset.assetId, source: "fixture" } }],
    shots: shots.map(shot => ({ ...shot, characterId: "person", assetRef: "asset://asset-fixture" })) });
  const rows: Row[] = [], prompts = new Map<string, string>();
  for (const shot of shots) {
    const base = `fixture original prompt ${shot.shotId}`, prompt = `${base}\n${generationIdentityLock(contract, shot.shotId).promptFragment}`;
    writeFileSync(join(root, `${shot.shotId}.mp4`), `source-bound fixture bytes ${shot.shotId}; not playable model output`);
    writeFileSync(join(root, `${shot.shotId}.txt`), base);
    writeFileSync(join(root, `${shot.shotId}.submitted.txt`), prompt); prompts.set(shot.shotId, prompt);
    rows.push({ stage: "shot", shotId: shot.shotId, evidence: { rawSha256: hash(readFileSync(join(root, `${shot.shotId}.mp4`))),
      basePromptSha256: hash(base), generationPromptSha256: hash(prompt), requestInputVerified: true,
      referenceAssets: generationIdentityLock(contract, shot.shotId).referenceAssets } });
  }
  const forbidden = vi.fn(() => { throw new Error("DEFAULT_MATERIAL_USE_MUST_NOT_SAMPLE_OR_CALL_VISION"); });
  const saved: Record<string, unknown>[] = [];
  const accidents = vi.fn(() => ({ blackSeconds: 4, silenceSeconds: 5 }));
  const resolveVision = vi.fn(() => null);
  const context = { exports: {} as { api: Api }, REVIEW_POLICY: policy, characterReleaseContract: contract,
    characterBindings: contract.characters, WORKER_RUNTIME: null, ENV: {}, PROJECT: contract.projectId, ONLY: [], allAssetShots: shots,
    CLIP_DIR: root, PROMPT_DIR: root, WORK_DIR: root, join, existsSync, readFileSync,
    sha256FileSync: (file: string) => hash(readFileSync(file)), fingerprintText: hash,
    readStageHistory: () => rows, lineageRecords: (history: Row[], stage: string) => history.filter(row => row.stage === stage),
    latestLineageRecord: (history: Row[]) => history.at(-1), stageApproved: () => false,
    assessRenderedCharacterUse, assessCharacterRelease, resolveProducerLlm: resolveVision, isAssetShot: () => true,
    probe: forbidden, mkdirSync: forbidden, run: forbidden, reviewCharacterVisualStage: forbidden,
    record: (row: Record<string, unknown>) => saved.push(row), detectQualityAccidents: accidents };
  runInNewContext(compiled, context);
  return { root, rows, shots, prompts, contract, saved, forbidden, accidents, resolveVision, api: context.exports.api };
}

describe("actual CLI default adopts source-bound renders without secondary inspection", () => {
  it("preflight and later person rendering do not require a vision model or canary opinion", () => {
    const f = fixture();
    expect(() => f.api.assertCharacterRenderPreflight()).not.toThrow();
    expect(() => f.api.assertCharacterCanaryBeforeSubmit("S2")).not.toThrow();
    expect(f.resolveVision).not.toHaveBeenCalled(); expect(f.forbidden).not.toHaveBeenCalled();
  });
  it("an explicit review policy still requires its real visual model", () => {
    const f = fixture("blocking"); expect(() => f.api.assertCharacterRenderPreflight()).toThrow(/CHARACTER_VISION_UNAVAILABLE/);
    expect(f.resolveVision).toHaveBeenCalledOnce();
  });
  it("the current first clip is adopted despite a preserved historical rejection", async () => {
    const f = fixture();
    const opinion = { checks: { identity: "unverified", wardrobe: "failed" }, rejected: true, reason: "fixture old refusal" };
    f.rows.push({ stage: "character-identity", shotId: "S1", evidence: { identityEvidence: opinion } });
    const before = JSON.stringify(f.rows);
    expect(await f.api.verifyCharacterClip(f.shots[0]!, f.prompts.get("S1")!)).toBe(true);
    expect(JSON.stringify(f.rows)).toBe(before);
    expect(f.saved[0]).toMatchObject({ stage: "character-material-use", invoked: false, ok: true,
      evidence: { adoption: { qualityReviewPerformed: false, materialUsePolicy: "default-use", shots: [{ identity: "unverified", wardrobe: "unverified" }] } } });
    expect(f.forbidden).not.toHaveBeenCalled();
    expect(f.api.characterReleaseReport("release").releaseAllowed).toBe(true);
  });
  it.each(["clip-bytes", "submitted-prompt", "reference-group", "missing-clip"])("%s mismatch cannot be washed by default adoption", async kind => {
    const f = fixture(), shot = f.shots[0]!;
    if (kind === "clip-bytes") writeFileSync(join(f.root, "S1.mp4"), "changed source bytes");
    if (kind === "submitted-prompt") f.rows[0]!.evidence.generationPromptSha256 = hash("another prompt");
    if (kind === "reference-group") f.rows[0]!.evidence.referenceAssets = ["asset://unbound"];
    if (kind === "missing-clip") rmSync(join(f.root, "S1.mp4"));
    expect(await f.api.verifyCharacterClip(shot, f.prompts.get(shot.shotId)!)).toBe(false);
    expect(f.api.characterReleaseReport("release").releaseAllowed).toBe(false);
    expect(f.forbidden).not.toHaveBeenCalled();
  });
  it("adopting one clip does not claim a complete source release when the second is missing", async () => {
    const f = fixture(); rmSync(join(f.root, "S2.mp4"));
    expect(await f.api.verifyCharacterClip(f.shots[0]!, f.prompts.get("S1")!)).toBe(true);
    expect(f.api.characterReleaseReport("release").releaseAllowed).toBe(false);
  });
  it("default finalization does not run black-frame or silence quality inspection", () => {
    const f = fixture(); expect(f.api.qualityAccidentsForReview("uninspected.mp4")).toBeNull();
    expect(f.accidents).not.toHaveBeenCalled();
    const explicit = fixture("blocking"); expect(explicit.api.qualityAccidentsForReview("diagnostic.mp4")).toEqual({ blackSeconds: 4, silenceSeconds: 5 });
    expect(explicit.accidents).toHaveBeenCalledOnce();
  });
  it("default cover uses its planned frame and source facts without sharpness/PSNR/safe-area inspection", () => {
    const f = fixture();
    expect(f.api.pickCoverFrameForPolicy([1.2, 0.3, 5], f.forbidden)).toEqual({ atSec: 1.2, sharpness: null });
    const facts = { bytes: 10, width: 1080, height: 1920, expectedWidth: 1080, expectedHeight: 1920, cleanSource: true };
    const result = f.api.inspectCoverForPolicy(facts, f.forbidden);
    expect(result.measurements).toBeNull(); expect(result.checks.map(check => check.id)).toEqual(["cover-produced", "clean-source"]);
    expect(f.api.coverChecksPassed(result.checks)).toBe(true); expect(f.forbidden).not.toHaveBeenCalled();
    for (const change of [{ bytes: 0 }, { width: 720 }, { cleanSource: false }]) {
      expect(f.api.coverChecksPassed(f.api.inspectCoverForPolicy({ ...facts, ...change }, f.forbidden).checks)).toBe(false);
    }
  });
  it("explicit cover diagnostics still score frames and execute real measurements", () => {
    const f = fixture("blocking"), inspectFrame = vi.fn((time: number) => time === 5 ? 2.4 : 1.1);
    expect(f.api.pickCoverFrameForPolicy([1.2, 5], inspectFrame)).toEqual({ atSec: 5, sharpness: 2.4 });
    expect(inspectFrame).toHaveBeenCalledTimes(2);
    const diagnosed = { checks: [{ id: "background-sharpness", pass: false, hard: true }], measurements: { fixture: "unacceptable actual score" } };
    const inspect = vi.fn(() => diagnosed);
    const result = f.api.inspectCoverForPolicy({ bytes: 1, width: 1, height: 1, expectedWidth: 1, expectedHeight: 1, cleanSource: true }, inspect);
    expect(result).toEqual(diagnosed); expect(inspect).toHaveBeenCalledOnce(); expect(f.api.coverChecksPassed(result.checks)).toBe(false);
    expect(f.api.coverChecksPassed([{ ...diagnosed.checks[0]!, hard: false }])).toBe(true);
    expect(() => f.api.pickCoverFrameForPolicy([], inspectFrame)).toThrow(/COVER_FRAME_TIME_INVALID/);
  });
});
