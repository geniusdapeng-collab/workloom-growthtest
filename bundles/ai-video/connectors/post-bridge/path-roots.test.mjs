import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { allowedRoots, assertPathAllowed } from "./core.mjs";
import { snapshotAudioStemArtifact } from "../bgm-bridge/audio-stems.mjs";

const digest = async (file) => createHash("sha256").update(await fs.readFile(file)).digest("hex");
test("系统临时路径的 lexical/canonical 别名都可冻结真实源字节，根外路径和子符号链接仍拒绝", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "post-roots-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "post-roots-outside-"));
  try {
    const source = path.join(root, "source.bin");
    const external = path.join(outside, "external.bin");
    await fs.writeFile(source, "current authorized source bytes");
    await fs.writeFile(external, "outside bytes");
    const roots = allowedRoots({ WORKLOOM_POST_ALLOWED_ROOTS: root });
    assert.ok(roots.includes(path.resolve(root)));
    assert.ok(roots.includes(await fs.realpath(root)));
    assert.equal(assertPathAllowed(source, roots), await fs.realpath(source));
    const sha256 = await digest(source);
    const copied = await snapshotAudioStemArtifact({ file: source, sha256, output: path.join(root, "snapshot.bin"), allowedRoots: roots });
    assert.equal(await digest(copied.path), sha256);
    assert.equal(await digest(source), sha256);
    assert.throws(() => assertPathAllowed(external, roots), { code: "path_not_allowed" });
    await fs.symlink(external, path.join(root, "linked-source.bin"));
    await assert.rejects(snapshotAudioStemArtifact({ file: path.join(root, "linked-source.bin"), sha256: await digest(external),
      output: path.join(root, "linked-copy.bin"), allowedRoots: roots }), { code: "path_not_allowed" });
    assert.throws(() => assertPathAllowed(path.join(root, "linked-source.bin"), roots), { code: "path_not_allowed" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});
