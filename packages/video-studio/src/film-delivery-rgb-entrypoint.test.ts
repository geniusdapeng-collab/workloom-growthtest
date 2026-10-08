/** Actual private RGB diagnostic and actual delivery recipe checks, extracted by AST.
 * Diagnostics keep genuine failure semantics; normal publication never calls them.
 * Controlled subprocess results are not real media, provider or quality certification.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { afterAll, describe, expect, it } from "vitest";
import { assessVariantAxes, assessVariantDistinctness, VARIANT_MIN_COUNT, type VariantSample } from "./deliver.js";

const REPO = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const SOURCE = path.join(REPO, "scripts/tools/full-chain-film.mts");
const ts = createRequire(path.join(REPO, "packages/video-studio/package.json"))("typescript") as typeof import("typescript");
const source = fs.readFileSync(SOURCE, "utf8"), sourceSha = createHash("sha256").update(source).digest("hex");
const parsed = ts.createSourceFile(SOURCE, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
interface ResultFixture { status: number | null; stdout: Buffer | null; stderr?: Buffer; error?: Error; signal?: string | null }
interface GateFixture { id: string; pass: boolean; hard: boolean; detail: string }
interface ManifestFixture { id: string; gradeProfile: string | null; cover: { sha256: string } | null; bgm: { sha256: string } | null }
interface ActualCli { measure(file: string, times: number[]): VariantSample["frames"]; gates(manifest: ManifestFixture[], bgmLayerOff: boolean): GateFixture[] }
function one<T>(items: T[], label: string): T {
  if (items.length !== 1) throw new Error(`RGB_AST_AMBIGUOUS_OR_MISSING: ${label}:${items.length}`);
  return items[0]!;
}
function declarations(name: string): import("typescript").VariableDeclaration[] {
  const found: import("typescript").VariableDeclaration[] = [];
  const visit = (node: import("typescript").Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(parsed); return found;
}
function statementOf(declaration: import("typescript").VariableDeclaration): string {
  const statement = declaration.parent.parent;
  if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) throw new Error("RGB_AST_UNSAFE_SHARED_DECLARATION");
  return statement.getText(parsed);
}
function property(object: import("typescript").ObjectLiteralExpression, name: string): import("typescript").Expression {
  const properties = object.properties.filter((node): node is import("typescript").PropertyAssignment => ts.isPropertyAssignment(node)
    && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && node.name.text === name);
  return one(properties, `property ${name}`).initializer;
}
const helper = one(declarations("meanColorsAt"), "meanColorsAt");
const deliveryGates: import("typescript").ObjectLiteralExpression[] = [], measurementCalls: string[] = [];
const visit = (node: import("typescript").Node): void => {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    if (node.expression.text === "meanColorsAt") measurementCalls.push(node.getText(parsed));
    if (node.expression.text === "recordGate" && node.arguments.length === 1 && ts.isObjectLiteralExpression(node.arguments[0]!)) {
      const object = node.arguments[0]!, key = property(object, "stepKey");
      if (ts.isStringLiteral(key) && key.text === "deliver") deliveryGates.push(object);
    }
  }
  ts.forEachChild(node, visit);
};
visit(parsed);
const gateChecks = property(one(deliveryGates, "actual delivery gate"), "checks");
if (!ts.isArrayLiteralExpression(gateChecks)) throw new Error("RGB_AST_EXPECTED_CHECK_ARRAY");
const checkIds = gateChecks.elements.filter(ts.isObjectLiteralExpression).map(check => property(check, "id").getText(parsed));
const selectedChecks = ["variants-produced", "variant-axes"].map(id => one(gateChecks.elements.filter((node): node is import("typescript").ObjectLiteralExpression =>
  ts.isObjectLiteralExpression(node) && ts.isStringLiteral(property(node, "id")) && (property(node, "id") as import("typescript").StringLiteral).text === id), id).getText(parsed));
const axes = one(declarations("variantAxes"), "variantAxes");
function actualCli(run: (file: string, args: string[], options: Record<string, unknown>) => ResultFixture): ActualCli {
  const compiled = ts.transpileModule(statementOf(helper) + `\nexports.__actual = {
    measure: meanColorsAt,
    gates: (variantManifest, bgmLayerOff) => { ${statementOf(axes)} return [${selectedChecks.join(",\n")}]; }
  };`, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  if (compiled.diagnostics?.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)) throw new Error("RGB_AST_COMPILE_ERROR");
  const context = { Buffer, FFMPEG: "rgb-fixture-ffmpeg", spawnSync: run, assessVariantAxes, VARIANT_MIN_COUNT, exports: {} as { __actual: ActualCli } };
  runInNewContext(compiled.outputText, context, { filename: SOURCE, timeout: 5_000 }); return context.exports.__actual;
}
const success = (rgb: [number, number, number]): ResultFixture => ({ status: 0, stdout: Buffer.from(rgb), stderr: Buffer.alloc(0) });
const faults: Array<{ name: string; result: ResultFixture }> = [
  { name: "nonzero exit despite valid-looking RGB bytes", result: { status: 1, stdout: Buffer.from([0, 0, 0]), stderr: Buffer.from("decode failed") } },
  { name: "spawn error despite status zero and valid bytes", result: { status: 0, stdout: Buffer.from([0, 0, 0]), error: new Error("EIO fixture") } },
  { name: "signal termination with null status", result: { status: null, signal: "SIGTERM", stdout: Buffer.from([0, 0, 0]) } },
  { name: "successful exit with short stdout", result: { status: 0, stdout: Buffer.from([0, 0]) } },
  { name: "successful exit with absent stdout", result: { status: 0, stdout: null } },
  { name: "successful exit with array-like non-Buffer stdout", result: { status: 0, stdout: [0, 0, 0] as unknown as Buffer } },
];
const manifest = (): ManifestFixture[] => ["cool", "warm", "punchy"].map((id, index) => ({ id, gradeProfile: `grade-${index}`, cover: { sha256: `cover-${index}` }, bgm: { sha256: `bgm-${index}` } }));
const sample = (variantId: string, r: number, lufs: number | null = null): VariantSample => ({ variantId, frames: [{ r, g: 0, b: 0 }], loudness: lufs === null ? null : { lufs, peakDb: -1 } });
const checks = (rows: GateFixture[]) => Object.fromEntries(rows.map(row => [row.id, row.pass]));
afterAll(() => expect(createHash("sha256").update(fs.readFileSync(SOURCE)).digest("hex"), "CLI source must remain unchanged").toBe(sourceSha));

describe("actual RGB diagnostic preserves process failure semantics", () => {
  it.each(faults)("rejects $name without inventing black pixels", ({ result }) => {
    let calls = 0;
    const cli = actualCli(() => { calls++; return result; });
    expect(() => cli.measure("fixture-broken.mp4", [0.2, 0.5, 0.8])).toThrow(/VARIANT_RGB_MEASUREMENT_FAILED/);
    expect(calls).toBe(1);
  });
  it("accepts true black pixels and uses the actual seek/extraction command", () => {
    const commands: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = [];
    const cli = actualCli((file, args, options) => { commands.push({ file, args, options }); return success([0, 0, 0]); });
    expect(cli.measure("fixture-black.mp4", [0.2, 0.5, 0.8])).toEqual([{ r: 0, g: 0, b: 0 }, { r: 0, g: 0, b: 0 }, { r: 0, g: 0, b: 0 }]);
    expect(commands.map(command => command.args[3])).toEqual(["0.2", "0.5", "0.8"]);
    expect(commands.every(command => command.file === "rgb-fixture-ffmpeg" && command.args.includes("rgb24") && command.args.includes("scale=1:1") && command.options.maxBuffer === 1024)).toBe(true);
  });
});

describe("actual normal publication checks requested recipe axes without quality scoring", () => {
  const cli = actualCli(() => { throw new Error("DEFAULT_PUBLICATION_MUST_NOT_SAMPLE_RGB"); });
  it("normal delivery has no RGB diagnostic calls or quality-distinctness gate", () => {
    expect(measurementCalls).toEqual([]); expect(checkIds).not.toContain('"variants-distinct"');
    expect(cli.gates(manifest(), false).every(row => row.pass)).toBe(true);
  });
  it.each(["gradeProfile", "cover", "bgm"] as const)("duplicate requested %s sources still fail their actual recipe contract", key => {
    const rows = manifest(); rows[1]![key] = rows[0]![key] as never;
    expect(checks(cli.gates(rows, false))["variant-axes"]).toBe(false);
  });
  it("requires three actual variants rather than accepting two complete recipes", () => {
    const result = checks(cli.gates(manifest().slice(0, 2), false));
    expect(result["variants-produced"]).toBe(false); expect(result["variant-axes"]).toBe(false);
  });
  it("declared music-off uses distinct grade/cover sources and preserves their independent requirements", () => {
    const rows = manifest().map(row => ({ ...row, bgm: null }));
    expect(cli.gates(rows, true).every(row => row.pass)).toBe(true); expect(checks(cli.gates(rows, false))["variant-axes"]).toBe(false);
    rows[1]!.cover = rows[0]!.cover; expect(checks(cli.gates(rows, true))["variant-axes"]).toBe(false);
  });
});

describe("optional independent distinctness diagnostic keeps its original mathematics", () => {
  it("retains audio-only measurable differences with the OR predicate", () => {
    const result = assessVariantDistinctness([sample("cool", 0, -14), sample("warm", 0, -16), sample("punchy", 0, -18)]);
    expect(result.approved).toBe(true); expect(result.pairs.every(pair => pair.videoDelta === 0 && pair.audioDelta >= 1)).toBe(true);
  });
  it("null loudness supplies no diagnostic difference for identical RGB", () => {
    const result = assessVariantDistinctness([sample("cool", 0), sample("warm", 0), sample("punchy", 0)]);
    expect(result.approved).toBe(false); expect(result.pairs.every(pair => pair.audioDelta === 0)).toBe(true);
  });
  it.each([
    { label: "video threshold is inclusive", samples: [sample("cool", 0), sample("warm", 6), sample("punchy", 12)] },
    { label: "audio threshold is inclusive", samples: [sample("cool", 0, -14), sample("warm", 0, -15), sample("punchy", 0, -16)] },
  ])("retains $label", ({ samples }) => expect(assessVariantDistinctness(samples).approved).toBe(true));
});
