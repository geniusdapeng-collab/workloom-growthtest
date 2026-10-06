import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { copyRuntimeSources, isRuntimeSource } from "./product-runtime-assets.mjs";

function put(root, ref, contents) {
  const file = path.join(root, ref);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

function fixture(t) {
  const temp = mkdtempSync(path.join(tmpdir(), "workloom-assets 中文 空格-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, "source"), destination = path.join(temp, "runtime"), outside = path.join(temp, "outside");
  mkdirSync(root); mkdirSync(outside);
  // Controlled compiler boundary: source/path guards are under test here. Actual
  // TypeScript builds and packaged runtime execution are checked separately.
  put(root, "node_modules/typescript/bin/tsc", `const fs=require('node:fs');fs.mkdirSync('packages/industry-contract/dist',{recursive:true});fs.writeFileSync('packages/industry-contract/dist/index.js','export const contract=true;');fs.writeFileSync('packages/industry-contract/dist/index.d.ts','export declare const contract: boolean;');fs.writeFileSync('compiler-ran.txt','fixture compiler');`);
  put(root, "package.json", '{"name":"controlled-source","private":true}');
  put(root, "product.manifest.json", readFileSync(new URL("../product.manifest.json", import.meta.url)));
  for (const ref of ["scripts/product-runtime.mjs", "scripts/vite-product.mjs", "apps/web/vite.config.ts"]) {
    put(root, ref, readFileSync(new URL("../" + ref, import.meta.url)));
  }
  put(root, ".env.example", "LLM_PROVIDER=mock\n");
  put(root, "packages/industry-contract/tsconfig.json", "{}\n");
  put(root, "packages/film/src/worker.ts", "export const value = 'canonical fixture source';\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "packages", "product.manifest.json", "package.json", "scripts", "apps", ".env.example"], { cwd: root });
  return { root, destination, outside };
}

test("canonical allowlist preserves director/media/agent sources and rejects dev/secret assets", () => {
  for (const ref of ["apps/server/src/video/director-worker.ts", "bundles/ai-video/library/director-system/core.mjs", "scripts/media-runtime.mjs", "scripts/workloom-agent.mjs"]) {
    assert.equal(isRuntimeSource(ref, { includePlatformOps: false }), true, ref);
  }
  for (const ref of ["packages/a/node_modules/tool/index.js", "packages/a/.env", "apps/server/src/fixture.test.ts", "platform-ops/secret.ts", "../escape.ts"]) {
    assert.equal(isRuntimeSource(ref, { includePlatformOps: false }), false, ref);
  }
});

test("normal physical source copy records canonical source and generated contract bytes", (t) => {
  const { root, destination } = fixture(t);
  const result = copyRuntimeSources(root, destination, { version: "fixture-v1" });
  assert.ok(result.files >= 8);
  assert.equal(readFileSync(path.join(destination, "packages/film/src/worker.ts"), "utf8"), "export const value = 'canonical fixture source';\n");
  assert.equal(readFileSync(path.join(destination, "VERSION"), "utf8"), "fixture-v1\n");
  assert.equal(readFileSync(path.join(destination, ".env.defaults"), "utf8"), "LLM_PROVIDER=mock\n");
  const assets = JSON.parse(readFileSync(path.join(destination, "RUNTIME_ASSETS.json")));
  assert.ok(assets.files.some(item => item.path === "packages/industry-contract/dist/index.js" && item.origin === "compiled-internal-contract"));
});

test("tracked source through an ancestor symlink is refused before copying outside bytes", (t) => {
  const { root, destination, outside } = fixture(t);
  put(outside, "worker.ts", "synthetic out-of-checkout content\n");
  rmSync(path.join(root, "packages/film/src"), { recursive: true });
  symlinkSync(outside, path.join(root, "packages/film/src"), "junction");
  assert.throws(() => copyRuntimeSources(root, destination), /源码.*(?:链接|越界)|路径.*越界/u);
  assert.equal(existsSync(path.join(root, "compiler-ran.txt")), false);
  assert.equal(existsSync(path.join(destination, "packages/film/src/worker.ts")), false);
});

test("destination ancestor symlink cannot redirect writes outside the nominated runtime", (t) => {
  const { root, destination, outside } = fixture(t);
  mkdirSync(destination);
  symlinkSync(outside, path.join(destination, "packages"), "junction");
  put(outside, "sentinel.txt", "unchanged outside fixture\n");
  assert.throws(() => copyRuntimeSources(root, destination), /目标.*(?:链接|越界)|路径.*越界/u);
  assert.equal(existsSync(path.join(root, "compiler-ran.txt")), false);
  assert.equal(readFileSync(path.join(outside, "sentinel.txt"), "utf8"), "unchanged outside fixture\n");
  assert.equal(existsSync(path.join(outside, "film/src/worker.ts")), false);
  assert.equal(existsSync(path.join(outside, "industry-contract/dist/index.js")), false);
});

test("existing derived-output symlink cannot replace an external file", (t) => {
  const { root, destination, outside } = fixture(t);
  mkdirSync(destination);
  put(outside, "sentinel.txt", "immutable derived-output fixture\n");
  symlinkSync(path.join(outside, "sentinel.txt"), path.join(destination, "VERSION"), "file");
  assert.throws(() => copyRuntimeSources(root, destination), /目标.*(?:链接|越界)|路径.*越界/u);
  assert.equal(existsSync(path.join(root, "compiler-ran.txt")), false);
  assert.equal(readFileSync(path.join(outside, "sentinel.txt"), "utf8"), "immutable derived-output fixture\n");
});

for (const ref of [".env.defaults", "RUNTIME_ASSETS.json", "vendor/supermickey/package.json"]) {
  test(`derived ${ref} symlink is rejected before the compiler or any outside write`, (t) => {
    const { root, destination, outside } = fixture(t);
    mkdirSync(path.dirname(path.join(destination, ref)), { recursive: true });
    put(outside, "sentinel.txt", "immutable outside output\n");
    symlinkSync(path.join(outside, "sentinel.txt"), path.join(destination, ref), "file");
    assert.throws(() => copyRuntimeSources(root, destination), /目标.*(?:链接|越界)|路径.*越界/u);
    assert.equal(existsSync(path.join(root, "compiler-ran.txt")), false);
    assert.equal(readFileSync(path.join(outside, "sentinel.txt"), "utf8"), "immutable outside output\n");
  });
}

test("existing compiler output file symlink cannot redirect TypeScript writes", (t) => {
  const { root, destination, outside } = fixture(t);
  mkdirSync(path.join(root, "packages/industry-contract/dist"));
  put(outside, "sentinel.js", "immutable outside compiler output\n");
  symlinkSync(path.join(outside, "sentinel.js"), path.join(root, "packages/industry-contract/dist/index.js"), "file");
  assert.throws(() => copyRuntimeSources(root, destination), /源码.*(?:链接|越界)|路径.*越界/u);
  assert.equal(existsSync(path.join(root, "compiler-ran.txt")), false);
  assert.equal(readFileSync(path.join(outside, "sentinel.js"), "utf8"), "immutable outside compiler output\n");
});

test("dangling destination links fail before writes and deleted tracked files remain optional", (t) => {
  const { root, destination, outside } = fixture(t);
  rmSync(path.join(root, "packages/film/src/worker.ts"));
  const normal = copyRuntimeSources(root, destination);
  assert.ok(normal.files > 0);
  assert.equal(existsSync(path.join(destination, "packages/film/src/worker.ts")), false);
  rmSync(path.join(root, "compiler-ran.txt"));
  rmSync(path.join(destination, "VERSION"));
  symlinkSync(path.join(outside, "absent.txt"), path.join(destination, "VERSION"), "file");
  assert.throws(() => copyRuntimeSources(root, destination), /目标.*(?:链接|越界)|路径.*越界/u);
  assert.equal(existsSync(path.join(root, "compiler-ran.txt")), false);
  assert.equal(existsSync(path.join(outside, "absent.txt")), false);
});

test("payload cannot be created inside a selected source tree", (t) => {
  const { root } = fixture(t);
  assert.throws(() => copyRuntimeSources(root, path.join(root, "packages/film/runtime")), /目标不得位于源码目录内/u);
  assert.equal(existsSync(path.join(root, "compiler-ran.txt")), false);
  assert.equal(existsSync(path.join(root, "packages/film/runtime")), false);
});

test("compiler output ancestor symlink is rejected before the compiler can write outside", (t) => {
  const { root, destination, outside } = fixture(t);
  symlinkSync(outside, path.join(root, "packages/industry-contract/dist"), "junction");
  assert.throws(() => copyRuntimeSources(root, destination), /源码.*(?:链接|越界)|路径.*越界/u);
  assert.equal(existsSync(path.join(root, "compiler-ran.txt")), false);
  assert.equal(existsSync(path.join(outside, "index.js")), false);
});

test("canonical output aliases cannot overwrite the checkout", (t) => {
  const { root, outside } = fixture(t);
  const alias = path.join(outside, "source-alias");
  symlinkSync(root, alias, "junction");
  assert.throws(() => copyRuntimeSources(root, alias), /目标不得覆盖源码工作区/u);
  assert.equal(existsSync(path.join(root, "VERSION")), false);
});
