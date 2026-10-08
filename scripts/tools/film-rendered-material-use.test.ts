/** Execute current CLI declarations. Local byte fixtures do not certify media or identity. */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import path, { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { buildCharacterReleaseContract } from "../../packages/video-studio/src/character-release-contract.js";
import { REAL_PERSON_ASSET_SCHEMA } from "../../packages/video-studio/src/real-person-asset.js";
import { assertFilmStageCoverage } from "../../packages/video-studio/src/film-worker-runtime.js";
import { adoptCompletedOriginalRenders, freezeOriginalSubmission, issueOriginalRenderReceipt } from "./film-standard-post.mjs";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const file = join(REPO, "scripts/tools/full-chain-film.mts"), source = readFileSync(file, "utf8");
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const sourceHash = hash(source);
interface AstNode {
  name?: { text: string }; expression: AstNode; text: string;
  getFullText(source: AstSource): string;
}
interface AstSource { statements: readonly AstNode[]; parseDiagnostics: readonly unknown[] }
interface AstCompiler {
  ScriptTarget: { Latest: number; ES2022: number }; ModuleKind: { CommonJS: number };
  createSourceFile(path: string, source: string, target: number, setParentNodes: boolean): AstSource;
  isFunctionDeclaration(node: AstNode): boolean; isCallExpression(node: AstNode | AstSource): node is AstNode;
  isIdentifier(node: AstNode): boolean;
  forEachChild(node: AstNode | AstSource, callback: (child: AstNode) => void): void;
  transpileModule(source: string, options: { compilerOptions: { target: number; module: number } }): { outputText: string };
}
const ts = createRequire(join(REPO, "packages/video-studio/package.json"))("typescript") as AstCompiler;
const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
const names = new Set(["assertCharacterRenderPreflight", "characterReleaseReport", "originalForShot", "originalFactsForShot", "nativeAudioFactsForShot", "clipFor",
  "deterministicHardFailures", "syntheticReviewVerdict", "reviewStage", "pickCoverFrameForPolicy", "inspectCoverForPolicy", "coverChecksPassed"]);
const declarations = parsed.statements.filter(node => ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text));
if (declarations.length !== names.size || parsed.parseDiagnostics.length) throw new Error("MATERIAL_USE_FIXTURE_INVALID: current CLI declarations missing or invalid");
const compiled = ts.transpileModule(declarations.map(node => node.getFullText(parsed)).join("\n")
  + "\nexports.api = { assertCharacterRenderPreflight, characterReleaseReport, clipFor, nativeAudioFactsForShot, reviewStage, pickCoverFrameForPolicy, inspectCoverForPolicy, coverChecksPassed };",
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const materialStart = source.indexOf('if (STAGES.has("material-gen")) {');
const videoPreflightEnd = source.indexOf('  /**\n   * 参考图口径（', materialStart);
const mediaDeclaration = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "assertOriginalRenderMedia");
const adoptionDeclaration = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "recordAdoptedOriginal");
if (materialStart < 0 || videoPreflightEnd <= materialStart || !mediaDeclaration || !adoptionDeclaration) throw new Error("MATERIAL_USE_FIXTURE_INVALID: actual material generation/preflight blocks missing");
const materialPreflightCompiled = ts.transpileModule('(async () => {\n' + mediaDeclaration.getFullText(parsed)
  + '\n' + adoptionDeclaration.getFullText(parsed)
  + '\n' + source.slice(materialStart, videoPreflightEnd) + '\n}\n})()',
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
afterAll(() => expect(hash(readFileSync(file)), "tested CLI source must remain stable").toBe(sourceHash));
interface Api {
  assertCharacterRenderPreflight(): void;
  characterReleaseReport(phase: "canary" | "release"): { status: string; qualityReviewPerformed: false; identityVerified: false; wardrobeVerified: false; adoptedRenderedShots: string[] };
  clipFor(shot: { shotId: string }): string;
  nativeAudioFactsForShot(shot: { shotId: string }): { nativeAudio: { present: boolean } };
  reviewStage(options: { stage: string; projectId: string; deterministic: Array<{ id: string; pass?: boolean; hard?: boolean; detail: string; status?: string }> }): Promise<{ approved: boolean; score: null; qualityReviewed: false; qualityStatus: string }>;
  pickCoverFrameForPolicy(times: number[], inspect: (atSec: number) => number): { atSec: number; sharpness: number | null };
  inspectCoverForPolicy(facts: { bytes: number; width: number; height: number; expectedWidth: number; expectedHeight: number; cleanSource: boolean },
    inspect: () => unknown): { checks: Array<{ id: string; pass: boolean; hard?: boolean }>; measurements: null };
  coverChecksPassed(checks: Array<{ id: string; pass: boolean; hard?: boolean }>): boolean;
}
function fixture(policy = "off") {
  const root = mkdtempSync(join(tmpdir(), "film-rendered-use-")); roots.push(root);
  const asset = { schemaVersion: REAL_PERSON_ASSET_SCHEMA, assetId: "asset-fixture", displayName: "Structural fixture",
    certified: { gender: "female" as const, source: "fixture; no identity certification" },
    authorization: { status: "real-authorized" as const, scope: "fixture only", evidence: "synthetic fixture registration" } };
  const shots = [{ shotId: "S1" }, { shotId: "S2" }];
  const contract = buildCharacterReleaseContract({ projectId: "VID-FIXTURE", assets: [asset],
    characters: [{ characterId: "person", assetId: asset.assetId, wardrobeLock: { id: "fixture", description: "fixture suit" },
      identityAnchor: { path: join(root, "registered.jpg"), sha256: hash("fixture reference"), assetId: asset.assetId, source: "fixture" } }],
    shots: shots.map(shot => ({ ...shot, characterId: "person", assetRef: "asset://asset-fixture" })) });
  const originals = shots.map(shot => {
    const path = join(root, `${shot.shotId}.mp4`); writeFileSync(path, `source-bound bytes ${shot.shotId}; not playable provider media`);
    return { ...shot, path, sha256: hash(readFileSync(path)), bytes: statSync(path).size,
      media: { videoFrames: 121, fps: 24, audioChannels: 2, audioSampleRate: 48000, audioDurationSec: 121 / 24 } };
  });
  const rows = [{ stage: "character-identity", shotId: "S1", ok: false, evidence: { checks: { identity: "unverified", wardrobe: "failed" } } }];
  const forbidden = vi.fn(() => { throw new Error("POST_MUST_NOT_SAMPLE_OR_CALL_MODEL"); });
  const postStages = ["shot", "compose", "color", "subtitle", "danmaku", "bgm", "sfx", "cover", "mux", "master"];
  const technical: Record<string, Set<string>> = Object.fromEntries(postStages.map(stage => [stage, new Set(["tool-exit"])]));
  const context = { exports: {} as { api: Api }, REVIEW_POLICY: policy, characterReleaseContract: contract,
    characterBindings: contract.characters, completedOriginals: originals, originalPostContract: { originals },
    POST_RENDER_STAGES: new Set(postStages), POST_TECHNICAL_CHECKS: technical, WORKER_RUNTIME: null,
    ENV: {}, PROJECT: contract.projectId, join, existsSync, readFileSync, statSync,
    sha256FileSync: (path: string) => hash(readFileSync(path)), fingerprintFile: (path: string) => hash(readFileSync(path)),
    reviewFilmStage: forbidden, resolveProducerLlm: forbidden, probe: forbidden, run: forbidden,
    readStageHistory: () => rows, filmContractSource: {} };
  runInNewContext(compiled, context);
  return { root, shots, contract, originals, rows, forbidden, context, api: context.exports.api };
}

describe("current CLI adopts originals without post-render quality or model gates", () => {
  it.each(["off", "advisory", "blocking"])("%s preserves preauthorization while dropping the rendered canary/model requirement", policy => {
    const f = fixture(policy); expect(() => f.api.assertCharacterRenderPreflight()).not.toThrow();
    const previous = JSON.stringify(f.rows), report = f.api.characterReleaseReport("release");
    expect(report).toMatchObject({ status: "not-reviewed", adoptedRenderedShots: ["S1", "S2"], qualityReviewPerformed: false, identityVerified: false, wardrobeVerified: false });
    expect(JSON.stringify(f.rows)).toBe(previous); expect(f.forbidden).not.toHaveBeenCalled();
  });
  it.each(["authorization", "anchor"])("invalid pre-render %s still blocks a new submission", kind => {
    const f = fixture();
    if (kind === "authorization") f.context.characterReleaseContract = { ...f.contract, status: "failed", issues: [{ detail: "fixture denied authorization" }] } as typeof f.contract;
    else f.context.characterBindings = f.context.characterBindings.map(binding => ({ ...binding, identityAnchor: undefined }));
    expect(() => f.api.assertCharacterRenderPreflight()).toThrow(/CHARACTER_RENDER_PREFLIGHT_BLOCKED/); expect(f.forbidden).not.toHaveBeenCalled();
  });
  it("current original bytes enter processing regardless of preserved historical identity rejection", () => {
    const f = fixture(), previous = JSON.stringify(f.rows);
    expect(f.api.clipFor(f.shots[0]!)).toBe(f.originals[0]!.path);
    expect(JSON.stringify(f.rows)).toBe(previous); expect(f.forbidden).not.toHaveBeenCalled();
  });
  it.each(["changed-bytes", "missing-source", "missing-registered-original"])("%s cannot be washed by adoption metadata", kind => {
    const f = fixture(), original = f.originals[0]!;
    if (kind === "changed-bytes") writeFileSync(original.path, "changed current source bytes");
    if (kind === "missing-source") rmSync(original.path);
    if (kind === "missing-registered-original") f.context.originalPostContract.originals.splice(0, 1);
    expect(() => f.api.clipFor(f.shots[0]!)).toThrow(/STANDARD_NATIVE_ORIGINAL_CHANGED/); expect(f.forbidden).not.toHaveBeenCalled();
  });
  it("source silence is factual metadata and does not invoke speech or identity processing", () => {
    const f = fixture(); f.originals[0]!.media.audioChannels = 0; f.originals[0]!.media.audioSampleRate = 0; f.originals[0]!.media.audioDurationSec = 0;
    expect(f.api.nativeAudioFactsForShot(f.shots[0]!).nativeAudio.present).toBe(false); expect(f.api.clipFor(f.shots[0]!)).toBe(f.originals[0]!.path);
    expect(f.forbidden).not.toHaveBeenCalled();
  });
  it.each(["off", "advisory", "blocking"])("%s post stages execute only processing checks, with null quality score", async policy => {
    const f = fixture(policy);
    for (const stage of f.context.POST_RENDER_STAGES) {
      const verdict = await f.api.reviewStage({ stage, projectId: "VID-FIXTURE", deterministic: [
        { id: "tool-exit", hard: true, pass: true, detail: "actual tool result fixture" },
        { id: "clothing-quality", hard: true, pass: false, detail: "obsolete visual opinion" },
        { id: "silence-quality", hard: true, pass: false, detail: "obsolete hearing opinion" }] });
      expect(verdict).toMatchObject({ approved: true, score: null, qualityReviewed: false, qualityStatus: "unverified" });
      const failed = await f.api.reviewStage({ stage, projectId: "VID-FIXTURE", deterministic: [{ id: "tool-exit", hard: true, pass: false, detail: "actual processing failed" }] });
      expect(failed.approved).toBe(false); expect(failed.score).toBeNull();
    }
    expect(f.forbidden).not.toHaveBeenCalled();
  });
  it.each(["off", "advisory", "blocking"])("%s cover selects the declared frame and technical source facts without scoring", policy => {
    const f = fixture(policy), facts = { bytes: 10, width: 1080, height: 1920, expectedWidth: 1080, expectedHeight: 1920, cleanSource: true };
    expect(f.api.pickCoverFrameForPolicy([1.2, 0.3, 5], f.forbidden)).toEqual({ atSec: 1.2, sharpness: null });
    const result = f.api.inspectCoverForPolicy(facts, f.forbidden);
    expect(result.measurements).toBeNull(); expect(result.checks.map(check => check.id)).toEqual(["cover-produced", "clean-source"]);
    expect(f.api.coverChecksPassed(result.checks)).toBe(true);
    for (const change of [{ bytes: 0 }, { width: 720 }, { cleanSource: false }])
      expect(f.api.coverChecksPassed(f.api.inspectCoverForPolicy({ ...facts, ...change }, f.forbidden).checks)).toBe(false);
    expect(() => f.api.pickCoverFrameForPolicy([], f.forbidden)).toThrow(/COVER_FRAME_TIME_INVALID/);
    expect(() => f.api.pickCoverFrameForPolicy([Number.NaN], f.forbidden)).toThrow(/COVER_FRAME_TIME_INVALID/);
    expect(f.forbidden).not.toHaveBeenCalled();
  });
  it("the executable source has no post-render character canary, identity sampling, black/silence audit or cover-designer calls", () => {
    const forbiddenCalls = new Set(["verifyCharacterClip", "assertCharacterCanaryBeforeSubmit", "detectQualityAccidents", "callCoverDesigner", "psnrRegion", "imageDiff", "inkMetrics"]);
    const calls: string[] = [];
    const visit = (node: AstNode | AstSource): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && forbiddenCalls.has(node.expression.text)) calls.push(node.expression.text);
      ts.forEachChild(node, visit);
    };
    visit(parsed); expect(calls).toEqual([]);
  });
});

describe("same-run material success enters the issued-original state before new submission preflight", () => {
  async function stageFixture(options: { worker?: boolean; mixed?: boolean; pendingAuthorized?: boolean; fault?: "authorization" | "provider" | "empty" | "source-changed" | "witness-changed" } = {}) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "film-material-same-run-"))); roots.push(root);
    const productionRoot = options.worker ? join(root, "work") : root;
    const projectId = "VID-MATERIAL-SAME-RUN", logDir = join(productionRoot, "logs", projectId), clipDir = join(productionRoot, "clips", projectId);
    const promptDir = join(productionRoot, "prompts", projectId), plateDir = join(productionRoot, "plates", projectId);
    for (const dir of [logDir, clipDir, promptDir, plateDir, join(logDir, "accepted-tasks")]) mkdirSync(dir, { recursive: true });
    const photo = join(root, "reference.jpg"); writeFileSync(photo, Buffer.alloc(21_000, 3));
    const material = { shotId: "MAT-01", duration: 4, photo, material: true };
    const pending = { shotId: "GEN-02", duration: 4, material: false };
    const shots = options.mixed ? [material, pending] : [material];
    const submittedBytes = Buffer.from(JSON.stringify({ projectId, durationSeconds: shots.length * 4, shots }));
    const submitted = await freezeOriginalSubmission({ productionRoot, projectId, bytes: submittedBytes });
    const originals = await adoptCompletedOriginalRenders({ productionRoot, projectId, submittedSha256: submitted.sha256 });
    const completed = new Map(originals.map(original => [original.shotId, original]));
    const rows: Array<Record<string, unknown>> = [], gates: Array<{ checks: Array<{ id: string; pass: boolean; hard?: boolean }> }> = [];
    const model = vi.fn(async () => {
      if (options.fault === "provider") throw new Error("ACTUAL_PROVIDER_FAILURE_FIXTURE");
      writeFileSync(join(logDir, "accepted-tasks", "MAT-01.json"), JSON.stringify({ schemaVersion: "workloom.render-task/v1", state: "accepted",
        taskId: "task-local-accepted-fixture", requestHash: hash("fixture submitted request"), submissionSource: "local-submit", updatedAt: new Date().toISOString() }));
      return { url: "local-byte-fixture", taskId: "task-local-accepted-fixture", requestInputVerified: true, resumed: false };
    });
    if (options.pendingAuthorized) {
      writeFileSync(join(promptDir, "GEN-02.txt"), "authorized pending prompt fixture ".repeat(80));
      writeFileSync(join(plateDir, "GEN-02-plate.png"), Buffer.alloc(51_000, 4));
    }
    const pendingShots = () => shots.filter(shot => !completed.has(shot.shotId));
    const context = {
      STAGES: new Set(["material-gen", "videos"]), DRY_RUN: false, SOURCE_SIZE: { width: 1080, height: 1920 },
      FIRST_PASS_ORDER: shots, shots, completedOriginals: originals, completedByShot: completed,
      WORK_DIR: productionRoot, PROJECT: projectId, LOG_DIR: logDir, CLIP_DIR: clipDir, PROMPT_DIR: promptDir, PLATE_DIR: plateDir,
      sourceFileHash: submitted.sha256, WORKER_RUNTIME: null, ASPECT: "9:16", SOURCE_RESOLUTION: "1080p", FPS: 24,
      FFMPEG: "fixture-local-preparation", VIDEO_MODEL: "fixture-only-no-provider-network", MATERIAL_POLICY_VERSION: "fixture-only",
      shotlist: { title: "Fixture" }, abs: (path: string) => path, join, existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, statSync,
      isMaterialShot: (shot: typeof material) => shot.material,
      pendingShots, materialShots: () => pendingShots().filter(shot => shot.material),
      generatedShots: () => pendingShots().filter(shot => !shot.material), promptShots: () => pendingShots().filter(shot => !shot.material), assetShots: () => [],
      readMaterialSpec: () => ({ photo, usage: "generation-reference", focus: { x: 0.5, y: 0.5 } }),
      buildMaterialScenePrompt: () => "9:16 实景依据 构建一段 不得复刻参考图的构图 贴图式运动 画面全程静止 ".repeat(20),
      run: (_binary: string, args: string[]) => writeFileSync(args.at(-1)!, Buffer.alloc(51_000, 5)),
      rememberInputs: () => {}, sha256FileSync: (path: string) => hash(readFileSync(path)),
      preflightSubmitGuard: () => { if (options.fault === "authorization") throw new Error("PRERENDER_AUTHORIZATION_DENIED_FIXTURE"); },
      arkVideo: model, dataUrl: () => "fixture-input-reference", renderSecondsFor: (seconds: number) => seconds,
      download: (_url: string, path: string) => writeFileSync(path, options.fault === "empty" ? Buffer.alloc(0) : Buffer.alloc(12_000, 6)),
      // Real receipt, witness, task journal and source-byte adapters are exercised.
      // These local bytes/probe facts do not certify playable media or a provider.
      issueOriginalRenderReceipt, adoptCompletedOriginalRenders,
      probe: (path: string) => statSync(path).size > 0 ? { width: 64, height: 128, duration: 4, videoFrames: 96, fps: 24 } : { error: "empty source byte fixture" },
      record: (row: Record<string, unknown>) => {
        rows.push(row);
        if (row.stage === "material-gen" && row.ok === true) {
          if (options.fault === "source-changed") writeFileSync(join(clipDir, "MAT-01.raw.mp4"), "changed after real first issuance");
          if (options.fault === "witness-changed") writeFileSync(join(logDir, "original-issued", "MAT-01.seal.json"), JSON.stringify({ taskId: "wrong-task" }));
        }
      },
      recordGate: (gate: { checks: Array<{ id: string; pass: boolean; hard?: boolean }> }) => {
        gates.push(gate); return { approved: gate.checks.every(check => !check.hard || check.pass), reason: "fixture actual hard checks" };
      },
      readStageHistory: () => rows, stageApproved: () => options.pendingAuthorized === true, artifactReusable: () => options.pendingAuthorized === true,
      envHardTotal: 0, envSoftTotal: 0, envAccepted: false, envSummary: { hard: 0, soft: 0, byRule: {} }, devSummary: { hard: 0, soft: 0, byRule: {} },
      sceneBible: null, ENV_REPORT_FILE: join(root, "env.json"), scenePolicyReport: null, REVIEW_POLICY: "off", DEVICE_POLICY_VERSION: "fixture",
      PLATFORM: "fixture", speechOver: [], speechAccepted: false, speechLoose: [], speechProfile: { tier: "fixture", target: 1, max: 4 }, speechMeasured: [],
      hookSummary: { hard: 0, soft: 0 }, hookAccepted: false, hookCard: null, hookSfxEnabled: false, HOOK_WINDOW_SEC: 3, hookWindowFor: () => 3,
      micromotionTraces: new Map(), ACCEPT_REJECTED: [], basename: (path: string) => path.split("/").at(-1), log: () => {},
      process: { exit: (code: number) => { throw new Error(`ACTUAL_PREFLIGHT_EXIT_${code}`); } },
    };
    const execute = () => runInNewContext(materialPreflightCompiled, context) as Promise<void>;
    return { execute, model, context, rows, gates, root, productionRoot, submitted, submittedBytes, clipDir, originals, completed };
  }
  it("a same-run successful original smaller than 100KB is adopted by actual receipt and witness without another quality gate", async () => {
    const f = await stageFixture(); await f.execute();
    expect(statSync(join(f.clipDir, "MAT-01.raw.mp4")).size).toBeLessThan(100_000);
    expect(f.completed.get("MAT-01")).toMatchObject({ shotId: "MAT-01", disposition: "issued-provider-success-reused" });
    expect(f.originals.map(original => original.shotId)).toEqual(["MAT-01"]);
    expect(f.model).toHaveBeenCalledTimes(1);
    expect(f.gates).toHaveLength(1); // Submission gate only; completed materials do not re-enter G7.
  });
  it.each([false, true])("mixed pending preauthorization remains effective (%s)", async authorized => {
    const f = await stageFixture({ mixed: true, pendingAuthorized: authorized });
    if (authorized) await f.execute(); else await expect(f.execute()).rejects.toThrow(/ACTUAL_PREFLIGHT_EXIT_5/);
    expect(f.completed.has("MAT-01")).toBe(true); expect(f.completed.has("GEN-02")).toBe(false);
    expect(f.model).toHaveBeenCalledTimes(1);
    expect(f.gates.at(-1)?.checks.find(check => check.id === "material-segments")?.pass).toBe(true);
    expect(f.gates.at(-1)?.checks.find(check => check.id === "prompt-files")?.pass).toBe(authorized);
  });
  it("a same-run material adoption completes the actual worker result and independently reverified parent coverage", async () => {
    const f = await stageFixture({ worker: true }); await f.execute();
    const adopted = f.rows.filter(row => row.stage === "render-adopted");
    const inputFile = join(f.productionRoot, "logs", f.context.PROJECT, "submitted-original.json");
    const context = { jobId: "fixture-job", tenantId: "fixture-tenant", workspaceId: "fixture-workspace", projectId: f.context.PROJECT,
      attempt: 1, runId: "fixture-run", workerName: "full-chain-film", workerVersion: "fixture-only", stages: ["material-gen", "videos"],
      options: {}, inputRef: relative(dirname(f.root), inputFile), inputSha256: f.submitted.sha256,
      workDir: f.root, archiveRoot: dirname(f.root), allowedMethods: ["video.generate"], budgetCny: 0,
      deadlineAt: new Date(Date.now() + 60_000).toISOString() };
    const summary = join(f.productionRoot, "logs", f.context.PROJECT, "stage-summary.json");
    writeFileSync(summary, JSON.stringify({ fixture: true, records: f.rows }));
    const fixtureFile = join(f.root, "worker-result-input.json");
    writeFileSync(fixtureFile, JSON.stringify({ context, records: f.rows, verified: f.originals.map(original => original.shotId) }));
    const workerModule = pathToFileURL(join(REPO, "packages/video-studio/src/film-worker-runtime.ts")).href;
    const program = `import { readFileSync } from "node:fs"; import { FullChainFilmWorker } from ${JSON.stringify(workerModule)};
const value=JSON.parse(readFileSync(process.argv[1],"utf8"));
const worker=new FullChainFilmWorker(value.context,process.argv[2],{send(){throw new Error("UNEXPECTED_COMPONENT_CALL")},subscribe(){return ()=>{}}});
worker.finish(value.records,true,value.verified);`;
    await new Promise<void>((resolve, reject) => execFile(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", program, fixtureFile, REPO],
      { cwd: REPO, timeout: 20_000 }, error => error ? reject(error) : resolve()));
    expect(adopted).toHaveLength(1);
    expect(adopted[0]).toMatchObject({ shotId: "MAT-01", ok: true, degraded: false, invoked: false, cached: true,
      evidence: { taskId: "task-local-accepted-fixture", qualityReviewPerformed: false, historicalQualityRowsUnchanged: true } });
    const result = JSON.parse(readFileSync(join(f.root, "film-result.json"), "utf8"));
    expect(result).toMatchObject({ complete: true, jobId: context.jobId, stages: context.stages, inputSha256: f.submitted.sha256 });
    expect(result.records.filter((row: Record<string, unknown>) => row.stage === "render-adopted")).toHaveLength(1);
    for (const artifact of result.artifacts) {
      const file = join(f.root, artifact.ref);
      expect(hash(readFileSync(file))).toBe(artifact.sha256); expect(statSync(file).size).toBe(artifact.bytes);
    }
    const parentFile = join(REPO, "apps/server/src/video/film-worker.ts"), parentSource = readFileSync(parentFile, "utf8");
    const parentAst = ts.createSourceFile(parentFile, parentSource, ts.ScriptTarget.Latest, true);
    const parentFunctions = parentAst.statements.filter(node => ts.isFunctionDeclaration(node)
      && ["verifyCompletedFilmOriginals", "filmWorkerEnvironment"].includes(node.name?.text ?? ""));
    const envStart = parentSource.indexOf("const CHILD_PUBLIC_ENV = new Set("), envEnd = parentSource.indexOf("export function filmWorkerEnvironment", envStart);
    expect(parentFunctions).toHaveLength(2); expect(envStart).toBeGreaterThan(-1); expect(envEnd).toBeGreaterThan(envStart);
    const parentCompiled = ts.transpileModule(parentSource.slice(envStart, envEnd) + parentFunctions.map(node => node.getFullText(parentAst)).join("\n")
      + "\nexports.verify=verifyCompletedFilmOriginals;", { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const parentExports = {} as { verify(input: { productionRoot: string; projectId: string; submittedSha256: string }): Promise<string[]> };
    runInNewContext(parentCompiled, { exports: parentExports, REPO_ROOT: REPO, path, pathToFileURL, execFile, process,
      fail: (code: string, message: string) => { throw new Error(`${code}: ${message}`); } });
    const verified = await parentExports.verify({ productionRoot: f.productionRoot, projectId: f.context.PROJECT, submittedSha256: f.submitted.sha256 });
    expect(verified).toEqual(["MAT-01"]);
    expect(() => assertFilmStageCoverage(context.stages, context.options, JSON.parse(f.submittedBytes.toString()), result.records, verified)).not.toThrow();
    expect(() => assertFilmStageCoverage(context.stages, context.options, JSON.parse(f.submittedBytes.toString()), result.records, [])).toThrow(/本次官方验证/);
    expect(() => assertFilmStageCoverage(context.stages, context.options, JSON.parse(f.submittedBytes.toString()),
      result.records.filter((row: Record<string, unknown>) => row.stage !== "render-adopted"), verified)).toThrow(/videos:MAT-01/);
    writeFileSync(f.originals[0]!.path, "changed after worker finalization; parent must refuse these current bytes");
    await expect(parentExports.verify({ productionRoot: f.productionRoot, projectId: f.context.PROJECT, submittedSha256: f.submitted.sha256 })).rejects.toThrow(/file bytes changed/);
    expect(hash(readFileSync(parentFile))).toBe(hash(parentSource));
    expect(f.model).toHaveBeenCalledTimes(1);
  });
  it.each(["authorization", "provider", "empty", "source-changed", "witness-changed"] as const)("%s failure cannot produce adopted success or another submission", async fault => {
    const expectedErrors = { authorization: /PRERENDER_AUTHORIZATION_DENIED_FIXTURE/, provider: /ACTUAL_PROVIDER_FAILURE_FIXTURE/,
      empty: /RENDER_SOURCE_UNREADABLE/, "source-changed": /file bytes changed/, "witness-changed": /issued render witness changed/ };
    const f = await stageFixture({ fault }); await expect(f.execute()).rejects.toThrow(expectedErrors[fault]);
    expect(f.completed.size).toBe(0); expect(f.originals).toEqual([]);
    expect(f.model).toHaveBeenCalledTimes(fault === "authorization" ? 0 : 1);
  });
});
