import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = resolve(fileURLToPath(import.meta.url), "..");
const repo = resolve(here, "../../..");
const pnpm = join(repo, "node_modules/.pnpm");
const tsx = readdirSync(pnpm).filter(name => name.startsWith("tsx@"))
  .map(name => join(pnpm, name, "node_modules/tsx/dist/cli.mjs"))
  .filter(existsSync).sort().at(-1);

describe("vendor渲染的并发定妆照绑定", () => {
  it.each([
    { first: "a", rejectFirst: false },
    { first: "b", rejectFirst: false },
    { first: "a", rejectFirst: true },
  ] as const)("两项目重叠，先退出=$first，抛错=$rejectFirst", ({ first, rejectFirst }) => {
    if (!tsx) throw new Error("未找到本仓 tsx 运行时");
    const root = mkdtempSync(join(tmpdir(), "wl-portrait-overlap-"));
    const script = join(root, "case.mts");
    try {
      writeFileSync(script, `
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { installVendorRenderCompatBridge, withVendorPortraitBindingBridge } from ${JSON.stringify(join(here, "vendor-compat.ts"))};
const require = createRequire(${JSON.stringify(join(repo, "package.json"))});
const { RenderingEngine } = require(${JSON.stringify(join(repo, "vendor/supermickey/hyperreality-system/engines/rendering-engine/rendering-engine.js"))});
const { RenderSubmitterCore } = require(${JSON.stringify(join(repo, "vendor/supermickey/scripts/render-submitter-core.js"))});
const { PromptGuardian } = require(${JSON.stringify(join(repo, "vendor/supermickey/scripts/prompt-guardian.js"))});
const root = ${JSON.stringify(root)};
const first = ${JSON.stringify(first)};
const rejectFirst = ${JSON.stringify(rejectFirst)};
const originalSave = PromptGuardian.prototype._saveLog;
PromptGuardian.prototype._saveLog = function(...args) {
  this.logPath = join(root, "guardian-log.json");
  return originalSave.apply(this, args);
};
const original = [RenderingEngine.prototype.render, RenderingEngine.prototype._generateBindingManifest,
  RenderingEngine.prototype._convertToShotFormat, RenderSubmitterCore.prototype.buildPayload];
const originalParser = RenderingEngine.prototype._parseCharacterRef;
const methods = () => [RenderingEngine.prototype.render, RenderingEngine.prototype._generateBindingManifest,
  RenderingEngine.prototype._convertToShotFormat, RenderSubmitterCore.prototype.buildPayload];
const angles = ["front", "threeQuarter", "closeup", "side"];
const ready = { a: Promise.withResolvers(), b: Promise.withResolvers() };
const go = { a: Promise.withResolvers(), b: Promise.withResolvers() };
const create = (name, value) => {
  const charactersDir = join(root, name, "characters");
  const dir = join(charactersDir, "guest");
  const outputDir = join(root, name, "output");
  mkdirSync(dir, { recursive: true });
  const files = Object.fromEntries(angles.map((angle, index) => {
    const path = join(dir, "guest-" + angle + ".png");
    writeFileSync(path, Buffer.alloc(4096, value + index));
    return [angle, path];
  }));
  const index = { schemaVersion: "workloom.portrait-index/v1", projectId: name, generatedAt: "",
    characters: { guest: { kind: "character", id: "guest", name: "住客", dir, files } }, products: {} };
  const engine = new RenderingEngine({ charactersDir, outputDir, apiKey: "test-only", endpoint: "test-model" });
  let body = null;
  engine.submitter.callApi = async payload => { body = payload; return { id: "test-" + name, status: "queued" }; };
  const promise = withVendorPortraitBindingBridge({ resolveIndex: () => index }, async () => {
    ready[name].resolve();
    await go[name].promise;
    if (rejectFirst && name === first) throw new Error("controlled pre-render abort");
    const result = await engine.render([{ shotId: "SC-01", portraits: [], characterRef: "", duration: 6,
      prompt: "guest 住客穿红色外套，站在有光照的房间中央，保持自然站姿，镜头平稳拍摄人物正面，背景清晰，没有额外角色，台词：今天我们来到这里。" }]);
    const images = (body?.content ?? []).filter(item => item.type === "image_url");
    const manifest = result.success ? JSON.parse(readFileSync(join(outputDir, "binding-manifest.json"), "utf8")) : null;
    return { success: result.success, bytes: images.map(item => Buffer.from(item.image_url.url.split(",")[1], "base64")[0]),
      schemaVersion: manifest?.schemaVersion, errors: result.errors };
  }).catch(error => ({ success: false, error: String(error) }));
  return { promise };
};
const a = create("a", 16);
await ready.a.promise;
const b = create("b", 32);
await ready.b.promise;
const runs = { a, b };
const second = first === "a" ? "b" : "a";
const unrelated = new RenderingEngine({ charactersDir: join(root, "unrelated") });
const unrelatedManifest = await unrelated._generateBindingManifest([{ shotId: "OTHER", characterRef: "" }]);
const unrelatedUnpatched = unrelatedManifest.schemaVersion === undefined && Object.keys(unrelatedManifest.characters).length === 0;
const originalParse = originalParser;
const scopedParserPatched = RenderingEngine.prototype._parseCharacterRef !== originalParse;
go[first].resolve();
const finished = { [first]: await runs[first].promise };
const retainedWhileActive = methods().every((method, i) => method !== original[i]);
const scopedParserRetained = RenderingEngine.prototype._parseCharacterRef !== originalParse;
go[second].resolve();
finished[second] = await runs[second].promise;
const restored = methods().every((method, i) => method === original[i]);
const scopedParserRestored = RenderingEngine.prototype._parseCharacterRef === originalParse;
const releaseParserA = installVendorRenderCompatBridge();
const parser = RenderingEngine.prototype._parseCharacterRef;
const releaseParserB = installVendorRenderCompatBridge();
const parserSingleWrapper = RenderingEngine.prototype._parseCharacterRef === parser;
releaseParserA();
releaseParserA();
const parserRetained = RenderingEngine.prototype._parseCharacterRef === parser;
releaseParserB();
const parserRestored = RenderingEngine.prototype._parseCharacterRef === originalParse;
console.log("RESULT " + JSON.stringify({ ...finished, retainedWhileActive, restored,
  scopedParserPatched, scopedParserRetained, scopedParserRestored, parserSingleWrapper, parserRetained, parserRestored,
  unrelatedUnpatched }));
`, "utf8");
      const stdout = execFileSync(process.execPath, [tsx, script], { encoding: "utf8", timeout: 30_000, cwd: repo });
      const line = stdout.split("\n").find(entry => entry.startsWith("RESULT "));
      if (!line) throw new Error(`子进程未输出回执：${stdout.slice(-600)}`);
      const observed = JSON.parse(line.slice(7));
      expect(observed, JSON.stringify(observed)).toMatchObject({
        a: rejectFirst
          ? { success: false, error: "Error: controlled pre-render abort" }
          : { success: true, bytes: [16, 17, 18, 19], schemaVersion: "workloom.portrait-binding/v2" },
        b: { success: true, bytes: [32, 33, 34, 35], schemaVersion: "workloom.portrait-binding/v2" },
        retainedWhileActive: true,
        restored: true,
        scopedParserPatched: true,
        scopedParserRetained: true,
        scopedParserRestored: true,
        parserSingleWrapper: true,
        parserRetained: true,
        parserRestored: true,
        unrelatedUnpatched: true,
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }, 45_000);
});
