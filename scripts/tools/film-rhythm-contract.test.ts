/** Execute current full-chain source seams locally, without submitting any generation request. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import vm from "node:vm";
import ts from "typescript-governance";
import { appendCinematicContract, auditCinematicContracts, buildCinematicContract, cinematicStyleRequested } from "../../packages/video-studio/src/cinematic-contract.js";
import { auditRhythmPlan, rhythmSfxPlacements, type RhythmPlanInput } from "../../packages/video-studio/src/rhythm-plan.js";
import { buildPlatePrompt } from "../../packages/video-studio/src/plate-prompt.js";
import { buildMaterialScenePrompt } from "../../packages/video-studio/src/material-policy.js";

const source = readFileSync(fileURLToPath(new URL("./full-chain-film.mts", import.meta.url)), "utf8");
const sourceFile = ts.createSourceFile("full-chain-film.mts", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
const nodes: ts.Node[] = [];
function visit(node: ts.Node): void { nodes.push(node); ts.forEachChild(node, visit); } visit(sourceFile);
const compile = (code: string): string => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const scope = () => ({ appendCinematicContract, auditCinematicContracts, buildCinematicContract, cinematicStyleRequested,
  auditRhythmPlan, rhythmSfxPlacements, buildPlatePrompt, buildMaterialScenePrompt, join,
  ASPECT: "16:9", SOURCE_RESOLUTION: "1080p", shotlist: { title: "Room arrival" }, authorContext: {}, sceneBible: undefined });
const shot = (shotId: string) => ({ shotId, duration: 4, subjectType: "product", scene: "brass key and lock in doorway; no people", props: "brass key and lock", dialogue: [], cinematic: {
  purpose: "show how the key unlocks the room", framing: "key and lock occupy lower third; doorway behind", depth: "key sharp; doorway readable",
  lighting: "window from left gives soft key; corridor practical behind", action: "insert key, turn, open door fully", camera: "hold as key turns, move through door after latch releases",
  artDirection: "brass key, worn lock and painted door share warm metal accents", sound: "key click and hinge movement; preserve room tone",
  continuity: { axis: "doorway left wall", screenDirection: "hand enters from right", entryState: "door closed", exitState: "door open" },
} });
const shots = () => [shot("s1"), shot("s2"), shot("s3")];
const plan = (): RhythmPlanInput => ({ profile: "fast-cut", segments: [
  { id: "detail", sourceId: "s1", inSeconds: 1, outSeconds: 1.5, role: "fast", cutReason: "latch releases" },
  { id: "reveal", sourceId: "s2", inSeconds: 0, outSeconds: 2, role: "hold", cutReason: "read room layout" },
  { id: "room-tone", sourceId: "s3", inSeconds: 0, outSeconds: 3, role: "breath", cutReason: "listen to room tone" },
], soundCues: [{ atSeconds: 0.5, kind: "impact", reason: "latch action" }] });
const preflightStart = source.indexOf("/** Author concrete editorial/cinematic decisions before any new paid generation. */");
const preflightEnd = source.indexOf("/* ---------- ②", preflightStart);
if (preflightStart < 0 || preflightEnd <= preflightStart) throw new Error("Full-chain cinematic/rhythm preflight seam was removed");
const preflightCode = compile(source.slice(preflightStart, preflightEnd));
function preflight(document: Record<string, unknown>, cards: Array<Record<string, unknown>>, options: { renderedIds?: string[]; fade?: number; transition?: string } = {}) {
  const records: Array<Record<string, unknown>> = [], files: Record<string, string> = {};
  const cachedProviderSources = new Map((options.renderedIds ?? []).map(id => [id, { file: `/${id}.mp4` }]));
  const context = { ...scope(), shots: cards, sourceDocument: document, STAGES: new Set<string>(), WORK_DIR: "/fixtures", PROJECT: "cinematic-rhythm",
    XFADE: options.fade ?? 0, EFFECTIVE_CUT_TRANSITION: options.transition ?? "", cachedProviderSources, completedByShot: cachedProviderSources,
    hasRenderedSource: (id: string) => cachedProviderSources.has(id), writeFileSync: (file: string, body: string) => { files[file] = body; },
    record: (entry: Record<string, unknown>) => { records.push(entry); } };
  vm.runInNewContext(preflightCode, context, { timeout: 1000 });
  return { records, files, stages: context.STAGES };
}
function initializer(name: string, predicate: (expression: ts.Expression) => boolean): ts.Expression {
  const declaration = nodes.find(node => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer && predicate(node.initializer)) as ts.VariableDeclaration | undefined;
  if (!declaration?.initializer) throw new Error(`Current full-chain ${name} initializer seam missing`);
  return declaration.initializer;
}

describe("current full-chain preflight prevents unfulfillable generation/edit contracts", () => {
  it("blocks explicit cinematic generation with no concrete decisions", () => {
    expect(() => preflight({ productionStyle: "cinematic" }, [{ shotId: "s1" }])).toThrow(/CINEMATIC_CONTRACT_FAILED.*CINEMATIC_DECISIONS_MISSING/);
  });
  it("accepts authored cinematic/fast-cut decisions and activates only explicitly placed synthetic cues", () => {
    const result = preflight({ productionStyle: "大片", rhythmPlan: plan() }, shots());
    expect(result.stages.has("sfx")).toBe(true); expect(result.records.map(row => row.stage)).toEqual(["cinematic-contract", "rhythm-plan"]);
    expect(result.records.every(row => row.verdict === null)).toBe(true);
    const rhythm = JSON.parse(Object.values(result.files).find(body => body.includes('"editorial-rhythm/v1"'))!);
    expect(rhythm).toMatchObject({ status: "unverified", evidence: { timeline: "declared", artisticQuality: "unverified", beatAlignment: "unverified" } });
  });
  it("leaves absent decisions advisory for ordinary films and reused successful clips", () => {
    expect(preflight({}, [{ shotId: "s1" }]).records[0]!.ok).toBe(true);
    const result = preflight({ productionStyle: "cinematic" }, [{ shotId: "s1" }], { renderedIds: ["s1"] });
    expect(result.records[0]!.ok).toBe(true); expect((result.records[0]!.evidence as Record<string, unknown>).requiredShotIds).toEqual([]);
  });
  it("requires actual source ranges for an explicit fast-cut request", () => {
    expect(() => preflight({ editingProfile: "fast-cut" }, shots())).toThrow(/RHYTHM_FASTCUT_PLAN_REQUIRED/);
  });
  it.each(["missing", "reordered"])("blocks %s storyboard coverage", kind => {
    const p = plan(); if (kind === "missing") p.segments.splice(1, 1); else p.segments.reverse();
    expect(() => preflight({ rhythmPlan: p }, shots())).toThrow(/RHYTHM_STORYBOARD_COVERAGE_REQUIRED/);
  });
  it.each([{ fade: 0.2 }, { transition: "fade" }])("rejects undeclared timeline overlap %j", options => {
    expect(() => preflight({ rhythmPlan: plan() }, shots(), options)).toThrow(/RHYTHM_EXPLICIT_TRANSITION_UNSUPPORTED/);
  });
  it("blocks protected action loss and non-diegetic score instructions before generating", () => {
    const p = plan(); p.segments[0]!.protectedRanges = [{ inSeconds: 0.5, outSeconds: 2, kind: "action", reason: "complete latch action" }];
    expect(() => preflight({ rhythmPlan: p }, shots())).toThrow(/RHYTHM_PREFLIGHT_FAILED/);
    const cards = shots(); cards[0]!.cinematic.sound = "key click；背景音乐使用交响配乐";
    expect(() => preflight({ productionStyle: "cinematic" }, cards)).toThrow(/CINEMATIC_SOUND_BGM_CONFLICT/);
  });
});

describe("actual generation prompt seams compile the current cinematic contract", () => {
  it("puts spatial decisions into the actual plate wrapper without video-only sound and camera instructions", () => {
    const node = nodes.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "platePrompt");
    if (!node) throw new Error("Plate wrapper missing");
    const fn = vm.runInNewContext(compile(`${node.getText(sourceFile)}\nplatePrompt;`), scope(), { timeout: 1000 }) as (card: Record<string, unknown>, name: string) => string;
    const card = shot("s1"), contract = buildCinematicContract(card), output = fn(card, "");
    expect(output).toContain(contract.framing); expect(output).toContain(contract.depth); expect(output).toContain(contract.lighting);
    expect(output).not.toContain(contract.sound); expect(output).not.toContain(contract.camera);
  });
  it("injects decisions into the actual formal text prompt expression", () => {
    const expression = initializer("finalPrompt", exp => exp.getText(sourceFile).startsWith("appendCinematicContract("));
    const card = shot("s1"), contract = buildCinematicContract(card);
    const output = vm.runInNewContext(compile(`const result = ${expression.getText(sourceFile)}; result;`), { ...scope(), shot: card, dialogueFixed: { prompt: "formal 25-field prompt" } }, { timeout: 1000 }) as string;
    for (const key of ["purpose", "framing", "depth", "lighting", "action", "camera", "artDirection", "sound"] as const) expect(output).toContain(contract[key]);
  });
  it("injects the same decisions into the actual material-scene route while retaining material provenance discipline", () => {
    const card = { ...shot("s1"), photo: "/fixtures/photo.jpg", materialUsage: "generation-reference" }, contract = buildCinematicContract(card);
    let code: string;
    const inline = nodes.find(node => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "prompt" && node.initializer?.getText(sourceFile).startsWith("appendCinematicContract(") && node.initializer.getText(sourceFile).includes("buildMaterialScenePrompt")) as ts.VariableDeclaration | undefined;
    if (inline?.initializer) code = `const prompt = ${inline.initializer.getText(sourceFile)}; prompt;`;
    else {
      const declaration = initializer("prompt", exp => exp.getText(sourceFile).startsWith("buildMaterialScenePrompt("));
      const assignment = nodes.find(node => ts.isExpressionStatement(node) && node.expression.getText(sourceFile).startsWith("prompt = appendCinematicContract("));
      if (!assignment) throw new Error("Material cinematic assignment seam missing");
      code = `let prompt = ${declaration.getText(sourceFile)}; ${assignment.getText(sourceFile)} prompt;`;
    }
    const output = vm.runInNewContext(compile(code), { ...scope(), card, duration: 4, reference: { prompt: "original reference contract" } }, { timeout: 1000 }) as string;
    expect(output).toContain("实景依据"); expect(output).toContain("不得复刻参考图的构图");
    for (const key of ["purpose", "framing", "depth", "lighting", "action", "camera", "artDirection", "sound"] as const) expect(output).toContain(contract[key]);
  });
});

describe("current declared sound execution respects the caller's explicit switch", () => {
  it("runs authored cues only when --no-sfx is absent", () => {
    const node = nodes.find(node => ts.isIfStatement(node) && node.thenStatement.getText(sourceFile).includes("await executeRhythmSound({")) as ts.IfStatement | undefined;
    if (!node) throw new Error("Current declared sound execution condition missing");
    const code = compile(`const enabled = ${node.expression.getText(sourceFile)}; enabled;`);
    const enabled = (noSfx: boolean): boolean => vm.runInNewContext(code, { ...scope(), sourceDocument: { rhythmPlan: plan() },
      STAGES: new Set(["sfx"]), flag: (name: string) => noSfx && name === "--no-sfx", scored: "/fixtures/current.mp4",
      existsSync: () => true, DRY_RUN: false }, { timeout: 1000 }) as boolean;
    expect(enabled(false)).toBe(true); expect(enabled(true)).toBe(false);
  });
});
