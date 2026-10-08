/** Execute actual CLI entrypoint declarations with local byte/lineage fixtures. No paid I/O. */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { constants as fsConstants, copyFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import {
  createLineageReceipt, latestLineageRecord, reusableLineageArtifact, stageLineageApproved,
  type LineageReceipt,
} from "../../packages/video-studio/src/production-lineage.js";
import { assessVoiceArtifact, fingerprintFile, fingerprintText } from "./film-voice-artifact.js";
import { assertFilmAudioSource, resolveFilmAudioContract, type FilmAudioShot } from "./film-audio-policy.mjs";
import { assertCoverPublication } from "./film-publication-policy.mjs";
import { validateStandardNativeClock } from "../../packages/video-studio/src/standard-post-contract.js";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const CLI_FILE = join(REPO, "scripts/tools/full-chain-film.mts");
const cliSource = readFileSync(CLI_FILE, "utf8");
const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const cliSourceSha256 = sha(cliSource);
// The video-studio package declares the TypeScript compiler used by this fixture.
// The root package may use a native compiler without the JavaScript AST API.
interface AstNode { name?: { text: string }; initializer?: AstNode; getFullText(source: AstSource): string }
interface AstSource { statements: ReadonlyArray<AstNode> }
interface AstCompiler {
  ScriptTarget: { Latest: number; ES2022: number }; ModuleKind: { CommonJS: number };
  createSourceFile(path: string, source: string, target: number, setParentNodes: boolean): AstSource;
  isFunctionDeclaration(node: AstNode): boolean;
  isVariableDeclaration(node: AstNode): boolean;
  forEachChild(node: AstNode | AstSource, callback: (child: AstNode) => void): void;
  transpileModule(source: string, options: { compilerOptions: { target: number; module: number } }): { outputText: string };
}
const ts = createRequire(join(REPO, "packages/video-studio/package.json"))("typescript") as AstCompiler;
const parsed = ts.createSourceFile(CLI_FILE, cliSource, ts.ScriptTarget.Latest, true);
const functionNames = new Set(["originalForShot", "originalFactsForShot", "nativeAudioFactsForShot", "assertOriginalRenderMedia", "clipFor", "assertFactualReleaseSources"]);
const declarations = parsed.statements.filter((statement) =>
  ts.isFunctionDeclaration(statement) && !!statement.name && functionNames.has(statement.name.text));
if (declarations.length !== functionNames.size) throw new Error("ENTRYPOINT_FIXTURE_INVALID: official declarations missing");
const variantSourceInitializers: AstNode[] = [];
const visit = (node: AstNode | AstSource): void => {
  if ("name" in node && ts.isVariableDeclaration(node) && node.name?.text === "variantSource" && node.initializer) {
    variantSourceInitializers.push(node.initializer);
  }
  ts.forEachChild(node, visit);
};
visit(parsed);
if (variantSourceInitializers.length !== 1) throw new Error("ENTRYPOINT_FIXTURE_INVALID: official variant source initializer missing or ambiguous");
const compiled = ts.transpileModule(declarations.map((statement) => statement.getFullText(parsed)).join("\n")
  + "\nexports.fixture = { clipFor, assertFactualReleaseSources, variantSource: () => ("
  + variantSourceInitializers[0]!.getFullText(parsed) + ") };", {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const masterStart = cliSource.indexOf('/* ---------- ⑪ 正式母版：'), masterEnd = cliSource.indexOf('/* ---------- ⑫ 多风格交付包', masterStart);
if (masterStart < 0 || masterEnd <= masterStart) throw new Error("ENTRYPOINT_FIXTURE_INVALID: official master export block missing");
const masterCompiled = ts.transpileModule(cliSource.slice(masterStart, masterEnd), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const probeDeclaration = parsed.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "probe");
if (!probeDeclaration) throw new Error("ENTRYPOINT_FIXTURE_INVALID: official media probe missing");
const probeCompiled = ts.transpileModule(probeDeclaration.getFullText(parsed) + "\nexports.probe = probe;", {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

interface FixtureRow {
  stage: string; shotId: string | null; ok: boolean; degraded: boolean;
  artifact: string | null; evidence: Record<string, unknown>; lineage: LineageReceipt;
}
interface FixtureShot extends FilmAudioShot { shotId: string; duration: number; speechMode: "on-camera" | "voice-over"; dialogue: Array<{ speaker: string; text: string }> }
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
afterAll(() => { expect(sha(readFileSync(CLI_FILE)), "official source must stay stable during test").toBe(cliSourceSha256); });

function fixture(mode: FixtureShot["speechMode"] = "on-camera") {
  const dir = mkdtempSync(join(tmpdir(), "film-entrypoint-")); roots.push(dir);
  const raw = join(dir, "GT-01.mp4"), voiced = join(dir, "GT-01.voiced.mp4"), master = join(dir, "master-raw.mp4");
  // Bytes represent receipt-bound artifacts, not playable production videos or identity proof.
  writeFileSync(raw, "fixture raw native source bytes");
  writeFileSync(voiced, "fixture independently dubbed source bytes");
  writeFileSync(master, "fixture composed master bytes");
  const projectId = "VID-ENTRYPOINT-FIXTURE", sourceHash = sha("frozen fixture source");
  const shot: FixtureShot = { shotId: "GT-01", duration: 5, speechMode: mode, dialogue: [{ speaker: "CEO", text: "入住不必等待。" }] };
  const dialogue = shot.dialogue.map((row) => row.text).join(" ");
  const contract = resolveFilmAudioContract(shot);
  const manifestFile = join(dir, "mock-original-render-manifest.json");
  writeFileSync(manifestFile, "mock canonical original manifest bytes, not provider authority");
  const manifestSha256 = fingerprintFile(manifestFile);
  const originalPostContract = { fps: 24, width: 1080, height: 1920, manifestFile, manifestSha256,
    originals: [{ shotId: shot.shotId, path: raw, sha256: fingerprintFile(raw), bytes: statSync(raw).size,
      media: { fps: 24, width: 1080, height: 1920, videoFrames: 120, videoDurationSec: 5,
        audioSampleRate: 48000, audioChannels: 2, audioDurationSec: 5 } }] };
  const rows: FixtureRow[] = [];
  const recipe = (stage: string) => ({ component: cliSourceSha256, stage });
  const make = (stage: string, inputs: string[], outputs: string[], evidence: Record<string, unknown>, shotId: string | null = null, ok = true): FixtureRow => ({
    stage, shotId, ok, degraded: !ok, artifact: outputs[0] ?? null, evidence,
    lineage: createLineageReceipt({ projectId, sourceHash, runId: "fixture", stage, shotId,
      recipe: recipe(stage), status: ok ? "passed" : "failed", inputs, outputs }),
  });
  rows.push(make("voice", [raw], [raw], { projectId, source: "clip-audio", rawSha256: fingerprintFile(raw),
    textSha256: fingerprintText(dialogue), audioPolicyHash: contract.policyHash,
    verification: "native-audio-source-verified", originalManifestSha256: manifestSha256,
    spokenTextVerified: false, lipSyncVerified: false }, shot.shotId));
  rows.push(make("compose", [raw], [master], {}));
  rows.push(make("shot", [], [raw], { rawSha256: fingerprintFile(raw), requestInputVerified: true }, shot.shotId));
  const stageApproved = (stage: string, shotIds: Array<string | null> = [null]) => stageLineageApproved({ records: rows,
    projectId, stage, shotIds, sourceHash: () => sourceHash, recipe: recipe(stage) }).ok;
  const context = {
    exports: {} as { fixture: { clipFor: (shot: FixtureShot) => string; assertFactualReleaseSources: () => void; variantSource: () => string } },
    PROJECT: projectId, POST_DIR: dir, CLIP_DIR: dir, OUT_DIR: dir, WORK_DIR: dir, NARRATION_PROFILE: "fixture-profile",
    master, colored: master, subtitled: master, danmakuOut: master, bgmScored: master,
    cleanScored: master, scored: master, deliverablePath: master,
    DANMAKU_ENABLED: false,
    SUBTITLE_MODE: "sidecar",
    publicationNeedsCover: false, publicationCoverReceipt: null, shots: [shot],
    // Frozen submitted intent and derived picture duration are distinct in the actual CLI.
    sourceDocument: { shots: [structuredClone(shot)] },
    isMaterialShot: (_shot: FixtureShot) => false,
    join, existsSync, statSync, writeFileSync, sha256FileSync: fingerprintFile,
    FPS: 24, SOURCE_SIZE: { width: 1080, height: 1920 }, originalPostContract,
    // Real bytes bind provenance; the media facts are explicitly a deterministic probe fixture.
    probe: (_file: string) => ({ fps: 24, width: 1080, height: 1920, videoFrames: 120, videoDurationSec: 5,
      hasAudio: true, audioSampleRate: 48000, audioChannels: 2, audioDurationSec: 5 }),
    dialogueText: (_shot: FixtureShot) => dialogue, voicedFile: (_id: string) => voiced, readStageHistory: () => rows,
    lineageRecords: (history: FixtureRow[], _stage: string) => history,
    latestLineageRecord, stageApproved,
    latestVoiceRecord: (_id: string) => rows.filter((row) => row.stage === "voice" && row.shotId === shot.shotId).at(-1) ?? null,
    artifactReusable: (stage: string, candidate: string, upstream?: string, shotId: string | null = null) => reusableLineageArtifact({
      records: rows, scope: { projectId, sourceHash }, stage, shotId, recipe: recipe(stage), candidate, upstream }),
    characterReleaseReport: (_phase: string): {
      releaseAllowed: boolean; issues: Array<{ shotId: string | null; code: string }>; authorizationScope: string;
    } => ({ releaseAllowed: true, issues: [], authorizationScope: "fixture-no-asset-character" }),
    assessVoiceArtifact, fingerprintFile, fingerprintText, resolveFilmAudioContract, assertFilmAudioSource, assertCoverPublication,
    validateStandardNativeClock,
  };
  runInNewContext(compiled, context);
  return { raw, voiced, master, shot, rows, make, context, guard: context.exports.fixture.assertFactualReleaseSources,
    variantSource: context.exports.fixture.variantSource };
}
function failure(guard: () => void): string {
  try { guard(); return "allowed"; }
  catch (error) { return typeof error === "object" && error && "message" in error ? String(error.message) : String(error); }
}
function row(f: ReturnType<typeof fixture>, stage: string): FixtureRow {
  const found = f.rows.find((entry) => entry.stage === stage);
  if (!found) throw new Error(`ENTRYPOINT_FIXTURE_INVALID: ${stage}`);
  return found;
}
const POST_EDGES = [
  ["color", "colored"], ["subtitle", "subtitled"], ["danmaku", "danmakuOut"],
  ["bgm", "bgmScored"], ["sfx", "cleanScored"],
] as const;
function wireCurrentPostChain(f: ReturnType<typeof fixture>) {
  let upstream = f.master;
  const edges = new Map<string, { upstream: string; output: string }>();
  for (const [stage, property] of POST_EDGES) {
    const output = join(f.context.POST_DIR, `master-${stage}.mp4`);
    writeFileSync(output, `current ${stage} bytes derived from ${upstream}`);
    f.rows.push(f.make(stage, [upstream], [output], {}));
    f.context[property] = output;
    edges.set(stage, { upstream, output });
    upstream = output;
  }
  f.context.scored = f.context.cleanScored;
  f.context.DANMAKU_ENABLED = true;
  return edges;
}

describe("actual film release entrypoints with real local byte and lineage receipts", () => {
  it("current native source, current generated shot and actual compose input permit release", () => {
    const f = fixture(); expect(failure(f.guard)).toBe("allowed");
  });
  it("a current raw voiceover source also permits release", () => {
    const f = fixture("voice-over"); expect(failure(f.guard)).toBe("allowed");
  });
  it("the actual release entrypoint accepts one native endpoint frame against immutable submitted seconds", () => {
    const f = fixture(), measured = f.context.originalPostContract.originals[0]!.media;
    measured.videoFrames = 121; measured.videoDurationSec = 121 / 24; measured.audioDurationSec = 121 / 24;
    f.shot.duration = 121 / 24;
    f.context.probe = () => ({ ...measured, hasAudio: true });
    expect(f.context.sourceDocument.shots[0]!.duration).toBe(5);
    expect(failure(f.guard)).toBe("allowed");
    expect(f.context.sourceDocument.shots[0]!.duration).toBe(5);
  });
  it("nominal frozen seconds do not veto a different complete source clock", () => {
    const f = fixture(); f.context.sourceDocument.shots[0]!.duration = 4;
    const submitted = JSON.stringify(f.context.sourceDocument);
    expect(failure(f.guard)).toBe("allowed");
    expect(JSON.stringify(f.context.sourceDocument)).toBe(submitted);
    writeFileSync(f.context.originalPostContract.manifestFile, "changed issued frozen manifest authority");
    expect(failure(f.guard)).toMatch(/PUBLICATION_ORIGINAL_MANIFEST_CHANGED/);
  });
  it("the actual release entrypoint refuses a missing frozen submitted shot", () => {
    const f = fixture(); f.context.sourceDocument.shots.length = 0;
    expect(failure(f.guard)).toMatch(/STANDARD_NATIVE_ORIGINAL_BINDING_INVALID/);
  });
  it("a historical successful TTS voiceover cannot publish even when it entered the old compose", () => {
    const f = fixture("voice-over");
    f.rows[0] = f.make("voice", [f.raw], [f.voiced], { ...row(f, "voice").evidence, source: "tts-narration",
      profile: "fixture-profile", voicedSha256: fingerprintFile(f.voiced) }, f.shot.shotId);
    f.rows[f.rows.findIndex((entry) => entry.stage === "compose")] = f.make("compose", [f.voiced], [f.master], {});
    expect(failure(f.guard)).toMatch(/PUBLICATION_COMPOSE_SOURCE_MISMATCH/);
  });
  it("an old master with no current compose receipt cannot publish", () => {
    const f = fixture(); f.rows.splice(f.rows.findIndex((entry) => entry.stage === "compose"), 1);
    expect(failure(f.guard)).toMatch(/PUBLICATION_COMPOSE_UNVERIFIED/);
  });
  it("changed composed master bytes invalidate their previous positive receipt", () => {
    const f = fixture(); writeFileSync(f.master, "changed composed master bytes");
    expect(failure(f.guard)).toMatch(/PUBLICATION_COMPOSE_UNVERIFIED/);
  });
  it("a compose receipt that actually used TTS cannot be washed by a current native raw voice pass", () => {
    const f = fixture();
    f.rows[f.rows.findIndex((entry) => entry.stage === "compose")] = f.make("compose", [f.voiced], [f.master], {});
    expect(failure(f.guard)).toMatch(/PUBLICATION_COMPOSE_SOURCE_MISMATCH/);
  });
  it("historical voice quality rejection does not veto pinned originals and actual compose", () => {
    const f = fixture("voice-over");
    f.rows.push(f.make("voice", [f.raw], [f.raw], { ...row(f, "voice").evidence }, f.shot.shotId, false));
    expect(failure(f.guard)).toBe("allowed");
  });
  it("obsolete voice policy metadata does not restrict adoption of pinned originals", () => {
    const f = fixture("voice-over"); row(f, "voice").evidence.audioPolicyHash = sha("another policy");
    expect(failure(f.guard)).toBe("allowed");
  });
  it("old TTS receipt metadata cannot replace the independently pinned native composition source", () => {
    const f = fixture(); row(f, "voice").evidence.source = "tts-narration";
    expect(failure(f.guard)).toBe("allowed");
  });
  it("a later source-audio quality vote does not veto successful original bytes", () => {
    const f = fixture(); f.rows.push(f.make("voice", [f.raw], [f.raw], { ...row(f, "voice").evidence }, f.shot.shotId, false));
    expect(failure(f.guard)).toBe("allowed");
  });
  it("issued original authority does not depend on a current quality shot row", () => {
    const f = fixture(); f.rows.splice(f.rows.findIndex((entry) => entry.stage === "shot"), 1);
    expect(failure(f.guard)).toBe("allowed");
  });
  it.each([undefined, false])("historical request row (%s) does not override separate issued-original proof", (proof) => {
    const f = fixture(); row(f, "shot").evidence.requestInputVerified = proof;
    expect(failure(f.guard)).toBe("allowed");
  });
  it("new raw bytes cannot be washed by fresh voice and compose receipts after the generation receipt", () => {
    const f = fixture(); writeFileSync(f.raw, "fixture changed raw generation bytes");
    f.rows[0] = f.make("voice", [f.raw], [f.raw], { ...row(f, "voice").evidence, rawSha256: fingerprintFile(f.raw) }, f.shot.shotId);
    f.rows[f.rows.findIndex((entry) => entry.stage === "compose")] = f.make("compose", [f.raw], [f.master], {});
    expect(failure(f.guard)).toMatch(/STANDARD_NATIVE_ORIGINAL_CHANGED/);
  });
  it("changed issued original manifest blocks publication after otherwise current receipts", () => {
    const f = fixture(); writeFileSync(f.context.originalPostContract.manifestFile, "mock changed original manifest bytes");
    expect(failure(f.guard)).toMatch(/PUBLICATION_ORIGINAL_MANIFEST_CHANGED/);
  });
  it("a current voice and compose pass cannot release a shot absent from issued originals", () => {
    const f = fixture(); f.context.originalPostContract.originals.length = 0;
    expect(failure(f.guard)).toMatch(/STANDARD_NATIVE_ORIGINAL_CHANGED/);
  });
  it("silent source metadata is accepted for actual post normalization", () => {
    const f = fixture(), originalProbe = f.context.probe;
    Object.assign(f.context.originalPostContract.originals[0]!.media, { audioChannels: 0, audioSampleRate: 0, audioDurationSec: 0 });
    f.context.probe = file => ({ ...originalProbe(file), hasAudio: false, audioChannels: 0, audioSampleRate: 0, audioDurationSec: 0 });
    expect(failure(f.guard)).toBe("allowed");
  });
  it("raw picture duration is normalized by official post rather than quality rejected", () => {
    const f = fixture(), originalProbe = f.context.probe;
    f.context.probe = file => ({ ...originalProbe(file), videoDurationSec: 4.99 });
    expect(failure(f.guard)).toBe("allowed");
  });
  it("raw frame rate is accepted without nominal equality veto", () => {
    const f = fixture(); f.context.originalPostContract.originals[0]!.media.fps = 25;
    expect(failure(f.guard)).toBe("allowed");
  });
  it.each(["spokenTextVerified", "lipSyncVerified"])("obsolete native quality claim %s is ignored by actual original byte authority", (key) => {
    const f = fixture(); row(f, "voice").evidence[key] = true;
    expect(failure(f.guard)).toBe("allowed");
  });
  it("old quality row hash is not the independently pinned original hash", () => {
    const f = fixture(); row(f, "shot").evidence.rawSha256 = sha("another generation artifact");
    expect(failure(f.guard)).toBe("allowed");
  });
  it("later wardrobe or source quality rejection does not veto pinned original adoption", () => {
    const f = fixture(); f.rows.push(f.make("shot", [], [f.raw], { ...row(f, "shot").evidence }, f.shot.shotId, false));
    expect(failure(f.guard)).toBe("allowed");
  });
  it("material release uses its current generation verification gate in the global entrypoint", () => {
    const f = fixture("voice-over"); f.context.isMaterialShot = () => true;
    f.rows.splice(f.rows.findIndex((entry) => entry.stage === "shot"), 1);
    f.rows.push(f.make("gate:material-generate:verify", [f.raw], [], {}, f.shot.shotId));
    expect(failure(f.guard)).toBe("allowed");
  });
  it("issued material original has separate task authority and needs no quality verify gate", () => {
    const f = fixture("voice-over"); f.context.isMaterialShot = () => true;
    expect(failure(f.guard)).toBe("allowed");
  });
  it("historical material quality gate failure does not restrict pinned original byte authority", () => {
    const f = fixture("voice-over"); f.context.isMaterialShot = () => true;
    f.rows.push(f.make("gate:material-generate:verify", [f.raw], [], {}, f.shot.shotId));
    f.rows.push(f.make("gate:material-generate:verify", [f.raw], [], {}, f.shot.shotId, false));
    expect(failure(f.guard)).toBe("allowed");
  });
  it("historical identity rejection is retained as data without restricting official post", () => {
    const f = fixture();
    f.context.characterReleaseReport = () => ({ releaseAllowed: false,
      issues: [{ shotId: f.shot.shotId, code: "IDENTITY_REVIEW_REJECTED" }], authorizationScope: "fixture-identity-rejection" });
    expect(failure(f.guard)).toBe("allowed");
    const recorded = JSON.parse(readFileSync(join(f.context.WORK_DIR, `${f.context.PROJECT}-character-release-report.json`), "utf8"));
    expect(recorded.releaseAllowed).toBe(false);
    expect(recorded.issues).toEqual([{ shotId: f.shot.shotId, code: "IDENTITY_REVIEW_REJECTED" }]);
  });
  it("current shot, voice and compose passes cannot release an unrelated old postproduction source", () => {
    const f = fixture(), stale = join(f.context.POST_DIR, "master-sfx.mp4");
    writeFileSync(stale, "old dubbed or old character footage left by a failed postproduction workstation");
    f.context.cleanScored = stale;
    f.context.scored = stale;
    expect(failure(f.guard)).not.toBe("allowed");
  });
  it("a complete currently approved postproduction chain preserves the actual source through release", () => {
    const f = fixture(); wireCurrentPostChain(f);
    expect(failure(f.guard)).toBe("allowed");
  });
  it.each(POST_EDGES)("%s cannot use existing output bytes without its current direct input receipt", (stage) => {
    const f = fixture(); wireCurrentPostChain(f);
    f.rows.splice(f.rows.findIndex((entry) => entry.stage === stage), 1);
    expect(failure(f.guard)).not.toBe("allowed");
  });
  it.each(POST_EDGES)("%s cannot substitute a successful receipt bound to another upstream source", (stage) => {
    const f = fixture(), edges = wireCurrentPostChain(f), other = join(f.context.POST_DIR, "old-unrelated-upstream.mp4");
    writeFileSync(other, "old independently dubbed or wrong-character upstream footage");
    const edge = edges.get(stage)!;
    f.rows[f.rows.findIndex((entry) => entry.stage === stage)] = f.make(stage, [other], [edge.output], {});
    expect(failure(f.guard)).not.toBe("allowed");
  });
  it("a stale subtitle file with no current approval cannot become the variant source", () => {
    const f = fixture();
    writeFileSync(join(f.context.POST_DIR, "master-subtitled.mp4"), "old independently dubbed subtitle master");
    expect(f.variantSource()).toBe(f.master);
  });
  it("a currently approved subtitle artifact can become the variant source", () => {
    const f = fixture(), candidate = join(f.context.POST_DIR, "master-subtitled.mp4");
    f.context.SUBTITLE_MODE = "burn";
    writeFileSync(candidate, "current subtitle artifact derived from current master");
    f.rows.push(f.make("subtitle", [f.master], [candidate], {}));
    f.context.subtitled = candidate;
    expect(f.variantSource()).toBe(candidate);
  });
  it("changed subtitle bytes cannot be reused as a current variant source", () => {
    const f = fixture(), candidate = join(f.context.POST_DIR, "master-subtitled.mp4");
    f.context.SUBTITLE_MODE = "burn";
    writeFileSync(candidate, "current subtitle artifact derived from current master");
    f.rows.push(f.make("subtitle", [f.master], [candidate], {}));
    f.context.subtitled = candidate;
    writeFileSync(candidate, "old substituted subtitle master");
    expect(failure(f.variantSource)).toMatch(/VARIANT_SOURCE_UNVERIFIED/);
  });
  it("a later rejected subtitle record overrides its previous approved variant source", () => {
    const f = fixture(), candidate = join(f.context.POST_DIR, "master-subtitled.mp4");
    f.context.SUBTITLE_MODE = "burn";
    writeFileSync(candidate, "current subtitle artifact derived from current master");
    f.rows.push(f.make("subtitle", [f.master], [candidate], {}));
    f.rows.push(f.make("subtitle", [f.master], [candidate], {}, null, false));
    f.context.subtitled = candidate;
    expect(failure(f.variantSource)).toMatch(/VARIANT_SOURCE_UNVERIFIED/);
  });
  it.each(["burn", "both"])("%s subtitle mode requires a current approved burned source even when a file exists", (mode) => {
    const f = fixture(), candidate = join(f.context.POST_DIR, "master-subtitled.mp4");
    f.context.SUBTITLE_MODE = mode;
    writeFileSync(candidate, "old independently dubbed subtitle master");
    expect(failure(f.variantSource)).toMatch(/VARIANT_SOURCE_UNVERIFIED/);
  });
  it("sidecar mode selects the current verified colored source with no music mixed into it", () => {
    const f = fixture(), current = join(f.context.POST_DIR, "master-graded.mp4");
    writeFileSync(current, "current graded master with original speech and no BGM");
    f.rows.push(f.make("color", [f.master], [current], {}));
    f.context.colored = current;
    f.context.subtitled = current;
    writeFileSync(join(f.context.POST_DIR, "master-subtitled.mp4"), "old dubbed subtitle master");
    expect(f.variantSource()).toBe(current);
  });
  it("a changed colored source cannot be washed by a fresh subtitle pass", () => {
    const f = fixture(), current = join(f.context.POST_DIR, "master-graded.mp4"), candidate = join(f.context.POST_DIR, "master-subtitled.mp4");
    f.context.SUBTITLE_MODE = "burn";
    writeFileSync(current, "current graded master with original speech and no BGM");
    f.rows.push(f.make("color", [f.master], [current], {}));
    f.context.colored = current;
    writeFileSync(current, "old swapped colored bytes");
    writeFileSync(candidate, "subtitle freshly derived from swapped bytes");
    f.rows.push(f.make("subtitle", [current], [candidate], {}));
    f.context.subtitled = candidate;
    expect(failure(f.variantSource)).toMatch(/VARIANT_SOURCE_UNVERIFIED/);
  });
  it("a latest rejected color receipt prevents source selection even while its bytes still exist", () => {
    const f = fixture(), current = join(f.context.POST_DIR, "master-graded.mp4");
    writeFileSync(current, "current graded master with original speech and no BGM");
    f.rows.push(f.make("color", [f.master], [current], {}));
    f.rows.push(f.make("color", [f.master], [current], {}, null, false));
    f.context.colored = current;
    expect(failure(f.variantSource)).toMatch(/VARIANT_SOURCE_UNVERIFIED/);
  });
});

describe("actual master export uses the complete requested picture frame clock", () => {
  function masterFixture() {
    const dir = mkdtempSync(join(tmpdir(), "film-master-entrypoint-")); roots.push(dir);
    const source = join(dir, "master-source.mp4"), target = join(dir, "final.mp4");
    writeFileSync(source, "source-bound fixture bytes; metadata fixture does not certify playable media");
    const rows: Array<Record<string, unknown>> = [];
    const media = { width: 1080, height: 1920, fps: 24, videoFrames: 241,
      videoDurationSec: 241 / 24, duration: 241 / 24, hasAudio: false };
    const context = {
      STAGES: new Set(["master"]), DRY_RUN: false, scored: source, OUT_DIR: dir, DELIVERABLE: target,
      OUTPUT_SIZE: { width: 1080, height: 1920 }, FPS: 24, expectedMasterSeconds: 241 / 24,
      SUBTITLE_MODE: "sidecar", subtitleSidecar: null, POST_DIR: dir, QUALITY: "hd",
      deliverablePath: "", masterApprovedForUhd: false,
      assertFactualReleaseSources: () => {}, rememberInputs: (_stage: string, _inputs: string[]) => {},
      probe: () => media, fingerprintArtifact: (file: string) => ({ sha256: fingerprintFile(file) }),
      auditDeliverableNaming: () => ({ suggestedName: null }),
      existsSync, copyFileSync, renameSync, rmSync, join, basename, randomUUID, fsConstants,
      record: (row: Record<string, unknown>) => rows.push(row), log: (_line: string) => {},
    };
    return { source, target, rows, media, context, run: () => runInNewContext(masterCompiled, context) };
  }
  it("publishes all endpoint source frames and the same bytes when the requested clock is factual", () => {
    const f = masterFixture(); f.run();
    expect(fingerprintFile(f.target)).toBe(fingerprintFile(f.source));
    expect(f.context.deliverablePath).toBe(f.target);
    expect(f.rows).toHaveLength(1);
    expect(f.rows[0]).toMatchObject({ ok: true, evidence: { qualityReviewPerformed: false } });
  });
  it.each(["added-frame", "dropped-frame", "contradictory-duration", "fractional-fps", "wrong-canvas", "missing-fps", "nonfinite-duration"])("%s cannot publish a success row", kind => {
    const f = masterFixture();
    if (kind === "added-frame") { f.media.videoFrames += 1; f.media.videoDurationSec = f.media.duration = f.media.videoFrames / 24; }
    if (kind === "dropped-frame") { f.media.videoFrames -= 1; f.media.videoDurationSec = f.media.duration = f.media.videoFrames / 24; }
    if (kind === "contradictory-duration") f.media.videoDurationSec = f.media.duration = 241 / 24 + 0.01;
    if (kind === "fractional-fps") f.media.fps = 24.0001;
    if (kind === "wrong-canvas") f.media.width = 720;
    if (kind === "missing-fps") Reflect.deleteProperty(f.media, "fps");
    if (kind === "nonfinite-duration") f.media.videoDurationSec = f.media.duration = Number.NaN;
    expect(f.run).toThrow(/MASTER_EXPORT_SPEC_INVALID/);
    expect(existsSync(f.target)).toBe(false); expect(f.rows).toEqual([]);
  });
  it("the actual probe reports an available average picture clock ahead of the advertised cadence", () => {
    const f = masterFixture();
    const context = { exports: {} as { probe: (file: string) => Record<string, unknown> }, FFPROBE: "fixture-ffprobe", statSync,
      run: () => JSON.stringify({ format: { duration: 241 / 24 }, streams: [{ codec_type: "video", width: 1080,
        height: 1920, avg_frame_rate: "23999/1000", r_frame_rate: "24/1", nb_frames: "241", duration: 241 / 24 }] }) };
    runInNewContext(probeCompiled, context);
    expect(context.exports.probe(f.source).fps).toBe(23.999);
  });
  it("the actual probe retains advertised cadence only when the average clock is unavailable", () => {
    const f = masterFixture();
    const context = { exports: {} as { probe: (file: string) => Record<string, unknown> }, FFPROBE: "fixture-ffprobe", statSync,
      run: () => JSON.stringify({ format: { duration: 241 / 24 }, streams: [{ codec_type: "video", width: 1080,
        height: 1920, avg_frame_rate: "0/0", r_frame_rate: "24/1", nb_frames: "241", duration: 241 / 24 }] }) };
    runInNewContext(probeCompiled, context);
    expect(context.exports.probe(f.source).fps).toBe(24);
  });
});
