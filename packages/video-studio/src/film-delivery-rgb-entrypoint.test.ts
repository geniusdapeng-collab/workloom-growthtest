/**
 * Extract the real private RGB helper, real sample insertion and actual delivery
 * checks by AST. No CLI body, RGB implementation or policy body is copied here.
 * Subprocess results are fixtures; no FFmpeg, provider, model or network runs.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { afterAll, describe, expect, it } from "vitest";
import {
  assessVariantAxes, assessVariantDistinctness, VARIANT_MIN_COUNT,
  type VariantSample,
} from "./deliver.js";

const REPO = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const SOURCE = path.join(REPO, "scripts/tools/full-chain-film.mts");
const requireForRepo = createRequire(path.join(REPO, "packages/video-studio/package.json"));
const ts = requireForRepo("typescript") as any;
const source = fs.readFileSync(SOURCE, "utf8");
const sourceSha = createHash("sha256").update(source).digest("hex");
const parsed = ts.createSourceFile(SOURCE, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

interface ResultFixture {
  status: number | null;
  stdout: Buffer | null;
  stderr?: Buffer;
  error?: Error;
  signal?: string | null;
}
interface GateFixture {
  id: string; pass: boolean; hard: boolean; detail: string;
}
interface ManifestFixture {
  id: string; gradeProfile: string | null;
  cover: { sha256: string } | null; bgm: { sha256: string } | null;
}
interface ActualCli {
  measure(file: string, times: number[]): VariantSample["frames"];
  capture(samples: VariantSample[], plan: { output: string; variant: { id: string } },
    measured: { lufs: number | null; peakDb: number | null }, times: number[]): void;
  gates(samples: VariantSample[], manifest: ManifestFixture[], bgmLayerOff: boolean): GateFixture[];
}

function one<T>(items: T[], label: string): T {
  if (items.length !== 1) throw new Error(`RGB_AST_AMBIGUOUS_OR_MISSING: ${label}:${items.length}`);
  return items[0]!;
}
function declarations(name: string): any[] {
  const found: any[] = [];
  const visit = (node: any) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return found;
}
function statementOf(declaration: any, label: string): string {
  const statement = declaration.parent?.parent;
  if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) {
    throw new Error(`RGB_AST_UNSAFE_SHARED_DECLARATION: ${label}`);
  }
  return statement.getText(parsed);
}
function optionalProperty(object: any, name: string): any {
  if (!ts.isObjectLiteralExpression(object)) throw new Error(`RGB_AST_EXPECTED_OBJECT: ${name}`);
  const matches = object.properties.filter((entry: any) => ts.isPropertyAssignment(entry)
    && (ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name)) && entry.name.text === name);
  if (!matches.length) return undefined;
  return one<any>(matches, name).initializer;
}
function property(object: any, name: string): any {
  const found = optionalProperty(object, name);
  if (!found) throw new Error(`RGB_AST_MISSING_PROPERTY: ${name}`);
  return found;
}

const helper = one(declarations("meanColorsAt"), "meanColorsAt");
const sampleStatements: any[] = [];
const deliveryGates: any[] = [];
const visit = (node: any) => {
  if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
    const call = node.expression;
    if (ts.isPropertyAccessExpression(call.expression) && ts.isIdentifier(call.expression.expression)
      && call.expression.expression.text === "samples" && call.expression.name.text === "push") {
      const frame = call.arguments.length === 1 && ts.isObjectLiteralExpression(call.arguments[0])
        ? optionalProperty(call.arguments[0], "frames") : undefined;
      if (frame && ts.isCallExpression(frame) && ts.isIdentifier(frame.expression)
        && frame.expression.text === "meanColorsAt") sampleStatements.push(node);
    }
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "recordGate"
    && node.arguments.length === 1 && ts.isObjectLiteralExpression(node.arguments[0])) {
    const key = property(node.arguments[0], "stepKey");
    if (ts.isStringLiteral(key) && key.text === "deliver") deliveryGates.push(node.arguments[0]);
  }
  ts.forEachChild(node, visit);
};
visit(parsed);
const sampleStatement = one(sampleStatements, "actual samples.push(meanColorsAt)").getText(parsed);
const gateObject = one(deliveryGates, "actual deliver recordGate");
const gateChecks = property(gateObject, "checks");
if (!ts.isArrayLiteralExpression(gateChecks)) throw new Error("RGB_AST_EXPECTED_GATE_CHECK_ARRAY");
const selectedChecks = ["variants-produced", "variants-distinct", "variant-axes"].map(id =>
  one<any>(gateChecks.elements.filter((element: any) => ts.isObjectLiteralExpression(element)
    && ts.isStringLiteral(property(element, "id")) && property(element, "id").text === id), id).getText(parsed));
const distinctness = one(declarations("distinctness").filter(entry => entry.initializer && ts.isCallExpression(entry.initializer)
  && ts.isIdentifier(entry.initializer.expression) && entry.initializer.expression.text === "assessVariantDistinctness"), "distinctness");
const axes = one(declarations("variantAxes").filter(entry => entry.initializer && ts.isCallExpression(entry.initializer)
  && ts.isIdentifier(entry.initializer.expression) && entry.initializer.expression.text === "assessVariantAxes"), "variantAxes");

function actualCli(run: (file: string, args: string[], options: Record<string, unknown>) => ResultFixture): ActualCli {
  const raw = statementOf(helper, "meanColorsAt") + "\n"
    + `exports.__actual = {
      measure: meanColorsAt,
      capture: (samples, plan, measured, times) => { ${sampleStatement} },
      gates: (samples, variantManifest, bgmLayerOff) => {
        ${statementOf(distinctness, "distinctness")}
        ${statementOf(axes, "variantAxes")}
        return [${selectedChecks.join(",\n")}];
      }
    };`;
  const compiled = ts.transpileModule(raw, { reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  const errors = (compiled.diagnostics ?? []).filter((item: any) => item.category === ts.DiagnosticCategory.Error);
  if (errors.length) throw new Error(`RGB_AST_COMPILE_ERROR: ${ts.formatDiagnosticsWithColorAndContext(errors, {
    getCanonicalFileName: (file: string) => file, getCurrentDirectory: () => REPO, getNewLine: () => "\n",
  })}`);
  const context = { Buffer, FFMPEG: "rgb-fixture-ffmpeg", spawnSync: run,
    assessVariantAxes, assessVariantDistinctness, VARIANT_MIN_COUNT,
    exports: {} as { __actual: ActualCli } };
  runInNewContext(compiled.outputText, context, { filename: SOURCE, timeout: 5_000 });
  return context.exports.__actual;
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
const manifest = (): ManifestFixture[] => ["cool", "warm", "punchy"].map((id, index) => ({
  id, gradeProfile: `grade-${index}`, cover: { sha256: `cover-${index}` }, bgm: { sha256: `bgm-${index}` },
}));
const sample = (variantId: string, r: number, lufs: number | null = null): VariantSample => ({
  variantId, frames: [{ r, g: 0, b: 0 }], loudness: lufs === null ? null : { lufs, peakDb: -1 },
});
const checkMap = (checks: GateFixture[]) => Object.fromEntries(checks.map(check => [check.id, check.pass]));

afterAll(() => {
  expect(createHash("sha256").update(fs.readFileSync(SOURCE)).digest("hex"), "CLI source must remain unchanged").toBe(sourceSha);
});

describe("actual full-chain RGB measurement admission", () => {
  it.each(faults)("rejects $name before inserting a sample", ({ result }) => {
    let calls = 0;
    const cli = actualCli(() => { calls++; return result; });
    const samples: VariantSample[] = [];
    expect(() => cli.capture(samples, { output: "fixture-broken.mp4", variant: { id: "broken" } },
      { lufs: null, peakDb: null }, [0.2, 0.5, 0.8])).toThrow();
    expect(samples).toEqual([]);
    expect(calls).toBe(1);
  });

  it.each(faults)("cannot approve a pack after $name", ({ result }) => {
    const cli = actualCli((_command, args) => {
      const file = args[5]!;
      return file.endsWith("-0.mp4") ? result
        : success(file.endsWith("-1.mp4") ? [80, 0, 0] : [160, 0, 0]);
    });
    const samples: VariantSample[] = [], admitted: ManifestFixture[] = [], failures: unknown[] = [];
    // This fixture loop only supplies controlled variants; the measurement call,
    // sample insertion, distinctness, axes and selected hard checks are real code.
    for (const [index, variant] of manifest().entries()) {
      try {
        cli.capture(samples, { output: `fixture-${index}.mp4`, variant },
          { lufs: null, peakDb: null }, [0.2, 0.5, 0.8]);
        admitted.push(variant);
      } catch (error) { failures.push(error); }
    }
    const checks = cli.gates(samples, admitted, false);
    expect(checks.every(check => check.pass), JSON.stringify({ samples, checks,
      failureCount: failures.length, admittedCount: admitted.length })).toBe(false);
    expect(failures).toHaveLength(1);
    expect(samples.map(row => row.variantId)).toEqual(["warm", "punchy"]);
    expect(admitted).toHaveLength(2);
    expect(checkMap(checks)["variants-produced"]).toBe(false);
  });

  it("keeps a real zero RGB frame and the actual seek/extraction command", () => {
    const commands: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = [];
    const cli = actualCli((file, args, options) => { commands.push({ file, args, options }); return success([0, 0, 0]); });
    const frames = cli.measure("fixture-black.mp4", [0.2, 0.5, 0.8]);
    expect(frames).toEqual([{ r: 0, g: 0, b: 0 }, { r: 0, g: 0, b: 0 }, { r: 0, g: 0, b: 0 }]);
    expect(commands.map(command => command.args[3])).toEqual(["0.2", "0.5", "0.8"]);
    expect(commands.every(command => command.file === "rgb-fixture-ffmpeg"
      && command.args.includes("rgb24") && command.args.includes("scale=1:1")
      && command.options.maxBuffer === 1024)).toBe(true);
  });

  it("admits three genuinely different RGB variants with null loudness", () => {
    const cli = actualCli((_command, args) => success([Number(args[5]!.match(/(\d+)\.mp4$/)?.[1] ?? 0), 0, 0]));
    const samples: VariantSample[] = [];
    for (const [index, variant] of manifest().entries()) cli.capture(samples,
      { output: `fixture-${index * 80}.mp4`, variant }, { lufs: null, peakDb: null }, [0.2, 0.5, 0.8]);
    expect(samples).toHaveLength(3);
    expect(cli.gates(samples, manifest(), false).every(check => check.hard && check.pass)).toBe(true);
  });
});

describe("actual delivery OR predicate and independent three-axis policy", () => {
  const cli = actualCli(() => { throw new Error("RGB_FIXTURE_UNEXPECTED_SUBPROCESS"); });
  it("retains audio-only measurable differences rather than requiring every axis", () => {
    const samples = [sample("cool", 0, -14), sample("warm", 0, -16), sample("punchy", 0, -18)];
    expect(cli.gates(samples, manifest(), false).every(check => check.pass)).toBe(true);
    expect(assessVariantDistinctness(samples).pairs.every(pair => pair.videoDelta === 0 && pair.audioDelta >= 1)).toBe(true);
  });
  it("null loudness alone supplies zero difference and cannot approve identical RGB", () => {
    const samples = [sample("cool", 0), sample("warm", 0), sample("punchy", 0)];
    expect(checkMap(cli.gates(samples, manifest(), false))["variants-distinct"]).toBe(false);
    expect(assessVariantDistinctness(samples).pairs.every(pair => pair.audioDelta === 0)).toBe(true);
  });
  it.each([
    { label: "video threshold is inclusive", samples: [sample("cool", 0), sample("warm", 6), sample("punchy", 12)] },
    { label: "audio threshold is inclusive", samples: [sample("cool", 0, -14), sample("warm", 0, -15), sample("punchy", 0, -16)] },
  ])("retains $label", ({ samples }) => {
    expect(checkMap(cli.gates(samples, manifest(), false))["variants-distinct"]).toBe(true);
  });
  it.each(["gradeProfile", "cover", "bgm"] as const)("still rejects duplicate %s despite measurable RGB", (key) => {
    const rows = manifest(); rows[1]![key] = rows[0]![key] as never;
    const checks = checkMap(cli.gates([sample("cool", 0), sample("warm", 80), sample("punchy", 160)], rows, false));
    expect(checks["variants-distinct"]).toBe(true);
    expect(checks["variant-axes"]).toBe(false);
  });
  it("requires three admitted variants even when two have measurable differences", () => {
    const checks = checkMap(cli.gates([sample("cool", 0), sample("warm", 80)], manifest().slice(0, 2), false));
    expect(checks["variants-distinct"]).toBe(true);
    expect(checks["variants-produced"]).toBe(false);
    expect(checks["variant-axes"]).toBe(false);
  });
  it("allows declared BGM-off with distinct grade/cover while retaining the other axes", () => {
    const rows = manifest().map(row => ({ ...row, bgm: null }));
    const samples = [sample("cool", 0), sample("warm", 80), sample("punchy", 160)];
    expect(cli.gates(samples, rows, true).every(check => check.pass)).toBe(true);
    expect(checkMap(cli.gates(samples, rows, false))["variant-axes"]).toBe(false);
    rows[1]!.cover = rows[0]!.cover;
    expect(checkMap(cli.gates(samples, rows, true))["variant-axes"]).toBe(false);
  });
});
