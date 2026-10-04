import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deliveryInspect, productionPlan } from "../bundles/geo-growth/capabilities/video.mjs";

const hash = (text) => createHash("sha256").update(text).digest("hex");
function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "影片交付 空格-"));
  const oldRoot = process.env.WORKLOOM_VIDEO_ARTIFACT_ROOT;
  const oldKeys = process.env.WORKLOOM_KEYS_FILE;
  process.env.WORKLOOM_VIDEO_ARTIFACT_ROOT = root;
  process.env.WORKLOOM_KEYS_FILE = "/dev/null";
  mkdirSync(join(root, "out"));
  const save = (manifest) => writeFileSync(join(root, "out", "P1-delivery-manifest.json"), JSON.stringify({ projectId: "P1", ...manifest }));
  try { run({ root, save, inspect: () => deliveryInspect({ projectId: "P1", outDir: "out" }) }); }
  finally {
    if (oldRoot === undefined) delete process.env.WORKLOOM_VIDEO_ARTIFACT_ROOT; else process.env.WORKLOOM_VIDEO_ARTIFACT_ROOT = oldRoot;
    if (oldKeys === undefined) delete process.env.WORKLOOM_KEYS_FILE; else process.env.WORKLOOM_KEYS_FILE = oldKeys;
    rmSync(root, { recursive: true, force: true });
  }
}
test("delivery hashes main, attachments and asset list; later tampering is detected", () => fixture(({ root, save, inspect }) => {
  writeFileSync(join(root, "out", "main.mp4"), "master");
  writeFileSync(join(root, "out", "cover.png"), "cover");
  save({ deliverable: { path: "out/main.mp4", sha256: hash("master") }, cover: { path: "out/cover.png" },
    assets: [{ path: "out/cover.png", sha256: hash("cover") }] });
  assert.equal(inspect().integrity, "verified");
  writeFileSync(join(root, "out", "cover.png"), "tampered");
  const result = inspect();
  assert.equal(result.integrity, "incomplete");
  assert.ok(result.files.some((entry) => entry.state === "sha256-mismatch"));
}));
test("empty manifest, missing or empty main, directory and missing digest never pass", () => fixture(({ root, save, inspect }) => {
  for (const manifest of [{}, { deliverable: { path: "out/missing.mp4", sha256: hash("a") } },
    { deliverable: { path: "out", sha256: hash("a") } }]) {
    save(manifest); assert.equal(inspect().integrity, "incomplete");
  }
  writeFileSync(join(root, "out", "main.mp4"), "");
  save({ deliverable: { path: "out/main.mp4", sha256: hash("") } });
  assert.equal(inspect().files[0].state, "empty-or-not-file");
  writeFileSync(join(root, "out", "main.mp4"), "master");
  save({ deliverable: { path: "out/main.mp4" } });
  assert.equal(inspect().files[0].state, "sha256-unavailable");
}));
test("cross-project manifests, conflicting digests, invalid JSON and path escapes fail", () => fixture(({ root, save, inspect }) => {
  save({ projectId: "other" }); assert.throws(inspect, /项目标识/u);
  save({ assets: [{ path: "out/a", sha256: "a" }, { path: "out/a", sha256: "b" }] });
  assert.throws(inspect, /冲突/u);
  writeFileSync(join(root, "out", "P1-delivery-manifest.json"), "{"); assert.throws(inspect, /JSON/u);
  save({ deliverable: { path: "../escape", sha256: hash("x") } });
  assert.equal(inspect().files[0].state, "out-of-root");
  const external = mkdtempSync(join(tmpdir(), "video-external-"));
  try {
    writeFileSync(join(external, "private.mp4"), "private");
    symlinkSync(join(external, "private.mp4"), join(root, "out", "escape.mp4"));
    save({ deliverable: { path: "out/escape.mp4", sha256: hash("private") } });
    assert.equal(inspect().files[0].state, "out-of-root");
  } finally { rmSync(external, { recursive: true, force: true }); }
}));
test("suggested POSIX command preserves every argument literally and supplies a PowerShell representation", () => fixture(({ root }) => {
  const projectId = "客户'; printf INERT_MARKER; $(printf inert) `printf inert`";
  const plan = productionPlan({ title: "中文标题", projectId, platform: "YouTube 中文 空格", shotlistPath: "out/镜头 卡.json", outDir: "out/成片 空格" });
  const capture = join(root, "capture.mjs");
  writeFileSync(capture, "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
  const quote = (text) => "'" + text.replace(/'/gu, "'\"'\"'") + "'";
  const command = plan.recommendedCommand.replace(/^'pnpm'/u, `${quote(process.execPath)} ${quote(capture)}`);
  const actual = JSON.parse(execFileSync("/bin/sh", ["-c", command], { encoding: "utf8" }));
  assert.deepEqual(actual, plan.execution.args);
  assert.ok(actual.includes(projectId));
  assert.ok(plan.recommendedPowerShellCommand.startsWith("& 'pnpm'"));
  assert.ok(plan.recommendedPowerShellCommand.includes("客户'';"));
  assert.throws(() => productionPlan({ projectId: "line\nbreak" }), /非空字符串/u);
}));
