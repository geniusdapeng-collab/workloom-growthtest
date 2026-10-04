import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { copyRuntimeSources, registerWorkspaceModules } from "./pack-workspace-modules.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "workloom-workspace 中文 空格-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "product.manifest.json"), readFileSync(new URL("../product.manifest.json", import.meta.url)));
  mkdirSync(join(root, "packages"));
  return root;
}

function put(root, path, text) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function pkg(root, directory, overrides = {}) {
  put(root, `packages/${directory}/package.json`, JSON.stringify({
    name: "@fixture/film", version: "1.0.0", type: "module", exports: { ".": "./src/index.mjs" }, ...overrides,
  }));
  put(root, `packages/${directory}/src/index.mjs`, 'export const state = {}; export { value } from "../../../bundles/shot.mjs";');
  put(root, "bundles/shot.mjs", 'export const value = "canonical bundle";');
}

function assertRealFiles(root) {
  for (const entry of readdirSync(root)) {
    const file = join(root, entry);
    assert.equal(lstatSync(file).isSymbolicLink(), false, file);
    if (lstatSync(file).isDirectory()) assertRealFiles(file);
  }
}

test("搬动原工作区副本会破坏仓库相对引用，新注册保留同一模块实例", (t) => {
  const root = fixture(t);
  pkg(root, "film");
  cpSync(join(root, "packages/film"), join(root, "node_modules/@fixture/film"), { recursive: true });
  put(root, "probe.mjs", 'import { value, state } from "@fixture/film"; import { state as canonical } from "./packages/film/src/index.mjs"; if (state !== canonical) throw new Error("duplicate state"); console.log(value);');
  assert.throws(() => execFileSync(process.execPath, ["probe.mjs"], { cwd: root, stdio: "pipe" }), /ERR_MODULE_NOT_FOUND/u);
  assert.deepEqual(registerWorkspaceModules(root), ["@fixture/film"]);
  assert.match(execFileSync(process.execPath, ["probe.mjs"], { cwd: root, encoding: "utf8" }), /canonical bundle/u);
  assertRealFiles(join(root, "node_modules/@fixture/film"));
  assert.deepEqual(registerWorkspaceModules(root), ["@fixture/film"]);
  const relocated = join(root, "客户运行目录");
  cpSync(join(root, "packages"), join(relocated, "packages"), { recursive: true });
  cpSync(join(root, "bundles"), join(relocated, "bundles"), { recursive: true });
  cpSync(join(root, "node_modules"), join(relocated, "node_modules"), { recursive: true });
  cpSync(join(root, "probe.mjs"), join(relocated, "probe.mjs"));
  rmSync(join(root, "packages"), { recursive: true });
  assert.match(execFileSync(process.execPath, ["probe.mjs"], { cwd: relocated, encoding: "utf8" }), /canonical bundle/u);
});

test("子路径、条件 exports 和类型入口都引用保留的真实源文件", (t) => {
  const root = fixture(t);
  pkg(root, "film", { exports: { ".": { types: "./dist/index.d.ts", import: "./src/index.mjs" }, "./tool": "./src/tool.mjs" } });
  put(root, "packages/film/dist/index.d.ts", "export declare const value: string;");
  put(root, "packages/film/src/tool.mjs", "export const tool = 42;");
  registerWorkspaceModules(root);
  put(root, "probe.mjs", 'import { value } from "@fixture/film"; import { tool } from "@fixture/film/tool"; console.log(value, tool);');
  assert.match(execFileSync(process.execPath, ["probe.mjs"], { cwd: root, encoding: "utf8" }), /canonical bundle 42/u);
  const manifest = JSON.parse(readFileSync(join(root, "node_modules/@fixture/film/package.json"), "utf8"));
  assert.match(manifest.exports["."].types, /\.d\.ts$/u);
});

test("缺失构建产物在打包时失败，不留到客户启动时", (t) => {
  const root = fixture(t);
  pkg(root, "film", { exports: { ".": "./dist/missing.js" } });
  assert.throws(() => registerWorkspaceModules(root), /文件缺失或越界/u);
  assert.equal(existsSync(join(root, "node_modules/@fixture/film")), false);
});

test("包名称重复、路径越界和未支持的入口协议均失败关闭", (t) => {
  const root = fixture(t);
  pkg(root, "film");
  pkg(root, "duplicate");
  assert.throws(() => registerWorkspaceModules(root), /名称重复/u);
  rmSync(join(root, "packages/duplicate"), { recursive: true });
  for (const overrides of [
    { name: "../escape" }, { exports: { ".": "../../bundles/shot.mjs" } },
    { exports: { "./*": "./src/*.mjs" } }, { type: "commonjs" },
  ]) {
    pkg(root, "film", overrides);
    assert.throws(() => registerWorkspaceModules(root));
  }
  pkg(root, "film");
  put(root, "packages/film/src/index.mjs", "export default 42;");
  assert.throws(() => registerWorkspaceModules(root), /默认导出/u);
});

test("行业载荷不会因目录存在而注册仙女座的 platform-ops", (t) => {
  const root = fixture(t);
  pkg(root, "film");
  put(root, "platform-ops/package.json", JSON.stringify({ name: "@workloom/platform-ops", type: "module", exports: "./index.mjs" }));
  put(root, "platform-ops/index.mjs", "export const ops = true;");
  assert.deepEqual(registerWorkspaceModules(root), ["@fixture/film"]);
  assert.equal(existsSync(join(root, "node_modules/@workloom/platform-ops")), false);
});

test("源码装配不遍历 pnpm 循环链接或嵌套开发依赖，仍保留实际构建产物", (t) => {
  const root = fixture(t);
  pkg(root, "film");
  put(root, "apps/server/src/index.ts", "export const ready = true;");
  put(root, "packages/film/dist/index.d.ts", "export declare const ready: boolean;");
  put(root, "packages/film/node_modules/development-only/huge.txt", "must not enter payload");
  symlinkSync(root, join(root, "apps/server/node_modules"), "dir");
  const payload = join(root, "载荷 输出");
  assert.deepEqual(copyRuntimeSources(root, payload, ["apps/server", "packages", "bundles"]), ["apps/server", "packages", "bundles"]);
  assert.equal(existsSync(join(payload, "apps/server/node_modules")), false);
  assert.equal(existsSync(join(payload, "packages/film/node_modules")), false);
  assert.equal(readFileSync(join(payload, "packages/film/dist/index.d.ts"), "utf8"), "export declare const ready: boolean;");
  assert.equal(readFileSync(join(payload, "apps/server/src/index.ts"), "utf8"), "export const ready = true;");
});

test("源码装配拒绝仓库越界和目标递归，不读取外部链接", (t) => {
  const root = fixture(t);
  pkg(root, "film");
  const outside = mkdtempSync(join(tmpdir(), "workloom-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  put(outside, "private.mjs", "export const privateValue = true;");
  symlinkSync(join(outside, "private.mjs"), join(root, "packages/film/src/outside.mjs"));
  assert.throws(() => copyRuntimeSources(root, join(root, "payload"), ["packages"]), /链接越界/u);
  assert.equal(existsSync(join(root, "payload/packages/film/src/outside.mjs")), false);
  assert.throws(() => copyRuntimeSources(root, join(root, "payload"), ["../escape"]), /路径越界/u);
  assert.throws(() => copyRuntimeSources(root, join(root, "packages/film/output"), ["packages"]), /不可位于源码目录内/u);
});

test("源码复制 CLI 保留中文空格路径并以失败退出码报告缺参", (t) => {
  const root = fixture(t);
  pkg(root, "film");
  const script = fileURLToPath(new URL("./pack-workspace-modules.mjs", import.meta.url));
  const payload = join(root, "客户 安装源码");
  const args = [script, "--copy-sources", payload, "packages", "bundles"];
  assert.match(execFileSync(process.execPath, args, { cwd: root, encoding: "utf8" }), /未遍历开发依赖目录/u);
  assert.equal(existsSync(join(payload, "packages/film/src/index.mjs")), true);
  assert.throws(() => execFileSync(process.execPath, [script, "--copy-sources", payload], { cwd: root, stdio: "pipe" }), /缺少载荷源码路径/u);
});
