import test from "node:test";
import assert from "node:assert/strict";
import { parseRootList } from "./root-list.mjs";
test("portable roots preserve drive letters, Chinese, spaces and colons", () => {
  const roots = ["C:\\客户 作品\\media", "D:\\director", "/tmp/a:b"];
  assert.deepEqual(parseRootList(JSON.stringify(roots)), roots);
  assert.deepEqual(parseRootList("C:\\客户 作品\\media;D:\\director", { platform: "win32" }), roots.slice(0, 2));
  assert.deepEqual(parseRootList("C:/客户 作品;D:/director"), ["C:/客户 作品", "D:/director"]);
  assert.deepEqual(parseRootList("/tmp/a:/tmp/b", { platform: "darwin" }), ["/tmp/a", "/tmp/b"]);
});
test("malformed explicit configuration fails closed instead of broadening access", () => {
  for (const value of ["[]", "[null]", "[", '["/tmp",2]', '["/tmp\\u0000x"]']) assert.throws(() => parseRootList(value));
  assert.deepEqual(parseRootList("", { fallback: ["/tmp"] }), ["/tmp"]);
});
