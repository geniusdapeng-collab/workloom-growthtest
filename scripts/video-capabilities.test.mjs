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
  const previousEnv = Object.fromEntries(["VOLCENGINE_ARK_API_KEY", "WORKLOOM_VOICE_ENGINE", "WORKLOOM_VOICE_ENGINE_URL", "SEEDANCE_GENERATE_AUDIO"].map((key) => [key, process.env[key]]));
  process.env.WORKLOOM_VIDEO_ARTIFACT_ROOT = root;
  process.env.WORKLOOM_KEYS_FILE = join(root, "keys.env");
  process.env.VOLCENGINE_ARK_API_KEY = "fixture-only-render-key";
  process.env.WORKLOOM_VOICE_ENGINE = "mlx";
  process.env.WORKLOOM_VOICE_ENGINE_URL = "http://127.0.0.1:8099";
  process.env.SEEDANCE_GENERATE_AUDIO = "1";
  writeFileSync(join(root, "keys.env"), "VOLCENGINE_ARK_API_KEY=fixture-only-render-key\n");
  mkdirSync(join(root, "out"));
  const save = (manifest) => writeFileSync(join(root, "out", "P1-delivery-manifest.json"), JSON.stringify({ projectId: "P1", ...manifest }));
  try { run({ root, save, inspect: () => deliveryInspect({ projectId: "P1", outDir: "out" }) }); }
  finally {
    if (oldRoot === undefined) delete process.env.WORKLOOM_VIDEO_ARTIFACT_ROOT; else process.env.WORKLOOM_VIDEO_ARTIFACT_ROOT = oldRoot;
    if (oldKeys === undefined) delete process.env.WORKLOOM_KEYS_FILE; else process.env.WORKLOOM_KEYS_FILE = oldKeys;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}
test("delivery hashes main, attachments and asset list; later tampering is detected", () => fixture(({ root, save, inspect }) => {
  writeFileSync(join(root, "out", "main.mp4"), "master");
  writeFileSync(join(root, "out", "cover.png"), "cover");
  save({ deliverable: { path: "out/main.mp4", sha256: hash("master") }, cover: { path: "out/cover.png" },
    assets: [{ path: "out/cover.png", sha256: hash("cover") }] });
  assert.equal(inspect().integrity, "sha256-verified");
  writeFileSync(join(root, "out", "cover.png"), "tampered");
  const result = inspect();
  assert.equal(result.integrity, "incomplete");
  assert.ok(result.files.some((entry) => entry.state === "sha256-mismatch"));
}));

function savePlanInputs(root, shot = { shotId: "S1", duration: 5 }) {
  writeFileSync(join(root, "out", "shots.json"), JSON.stringify({ fps: 24, products: ["商品"], shots: [shot] }));
  writeFileSync(join(root, "out", "route.json"), JSON.stringify({ schemaVersion: "workloom.video-route-record/v1", decision: { route: "marketing" } }));
  return { projectId: "P1", shotlistPath: "out/shots.json", routePath: "out/route.json", outDir: "out/result" };
}
test("standard native production has no local ASR or dubbing prerequisite", () => fixture(({ root }) => {
  const input = savePlanInputs(root, { shotId: "S1", duration: 5, speechMode: "voice-over", dialogue: [{ text: "原片旁白" }] });
  process.env.WORKLOOM_VOICE_ENGINE = "mock";
  process.env.WORKLOOM_VOICE_ENGINE_URL = "https://unused.invalid";
  const plan = productionPlan(input);
  assert.equal(plan.ready, true);
  assert.equal(plan.audioSourcePolicy, "render-native");
  assert.ok(plan.audioContracts.every(contract => contract.sourcePolicy === "render-native"));
  assert.ok(!plan.checklist.some(entry => entry.id === "local-asr"));
  assert.ok(!plan.argv.includes("--narration-unified"));
  assert.ok(plan.beforeRun.every(text => !/配音工位/u.test(text)));
}));
test("native plan rejects replacement narration, muted generation and unsupported exact shot clocks", () => fixture(({ root }) => {
  const input = savePlanInputs(root);
  assert.equal(productionPlan({ ...input, unifiedNarration: true }).ready, false);
  process.env.SEEDANCE_GENERATE_AUDIO = "0";
  assert.equal(productionPlan(input).ready, false);
  process.env.SEEDANCE_GENERATE_AUDIO = "1";
  for (const duration of [3, 4.5, 13]) {
    savePlanInputs(root, { shotId: "S1", duration });
    const plan = productionPlan(input);
    assert.equal(plan.ready, false, `duration ${duration}`);
    assert.deepEqual(plan.argv, []);
  }
}));
test("standard delivery outputs and first-frame cover claims are actually hashed", () => fixture(({ root, save, inspect }) => {
  writeFileSync(join(root, "out", "main.mp4"), "master");
  writeFileSync(join(root, "out", "soft.mp4"), "soft");
  writeFileSync(join(root, "out", "cover.png"), "cover");
  const outputs = [{ id: "master", path: join(root, "out", "main.mp4"), sha256: hash("master"), bytes: 6,
    cover: join(root, "out", "cover.png"), coverReceipt: { cover: { path: join(root, "out", "cover.png"), sha256: hash("cover") } } },
    { id: "softsub", path: "out/soft.mp4", sha256: hash("soft"), bytes: 4 }];
  save({ schemaVersion: "workloom.standard-post-delivery/v1", mode: "original-native-standard-postproduction", outputs });
  assert.equal(inspect().integrity, "sha256-verified");
  assert.equal(inspect().files.length, 3);
  writeFileSync(join(root, "out", "cover.png"), "tampered");
  assert.ok(inspect().files.some(entry => entry.state === "sha256-mismatch"));
}));
test("standard output empty, duplicate, missing master, invalid and conflicting covers never pass", () => fixture(({ root, save, inspect }) => {
  writeFileSync(join(root, "out", "main.mp4"), "master");
  writeFileSync(join(root, "out", "cover.png"), "cover");
  const output = { id: "master", path: "out/main.mp4", sha256: hash("master"), bytes: 6, cover: "out/cover.png",
    coverReceipt: { cover: { path: "out/cover.png", sha256: hash("cover") } } };
  for (const outputs of [[], [null], [output, output], [{ ...output, id: "unknown" }], [{ ...output, id: "softsub" }],
    [{ ...output, cover: "out/other.png" }], [{ ...output, coverReceipt: {} }]]) {
    save({ schemaVersion: "workloom.standard-post-delivery/v1", outputs });
    assert.equal(inspect().integrity, "incomplete", JSON.stringify(outputs));
  }
}));
test("empty manifest, missing or empty main, directory and missing digest never pass", () => fixture(({ root, save, inspect }) => {
  for (const manifest of [{}, { deliverable: { path: "out/missing.mp4", sha256: hash("a") } },
    { deliverable: { path: "out", sha256: hash("a") } }]) {
    save(manifest); assert.equal(inspect().integrity, "incomplete");
  }
  writeFileSync(join(root, "out", "main.mp4"), "");
  save({ deliverable: { path: "out/main.mp4", sha256: hash("") } });
  assert.equal(inspect().files[0].state, "empty-file");
  writeFileSync(join(root, "out", "main.mp4"), "master");
  save({ deliverable: { path: "out/main.mp4" } });
  assert.equal(inspect().integrity, "unverified");
  assert.equal(inspect().files[0].verified, false);
}));
test("cross-project manifests, conflicting digests, invalid JSON and path escapes fail", () => fixture(({ root, save, inspect }) => {
  save({ projectId: "other" }); assert.throws(inspect, /项目标识/u);
  save({ assets: [{ path: "out/a", sha256: "a" }, { path: "out/a", sha256: "b" }] });
  assert.equal(inspect().integrity, "incomplete");
  assert.ok(inspect().files.some((entry) => entry.state === "invalid-metadata" && /冲突/u.test(entry.detail)));
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
  const projectId = "P1";
  const platform = "客户'; printf INERT_MARKER; $(printf inert) `printf inert`";
  writeFileSync(join(root, "out", "镜头 卡.json"), JSON.stringify({ fps: 24, products: ["商品"], shots: [{ shotId: "S1", duration: 5 }] }));
  writeFileSync(join(root, "out", "route.json"), JSON.stringify({ schemaVersion: "workloom.video-route-record/v1", decision: { route: "marketing" } }));
  const plan = productionPlan({ title: "中文标题", projectId, platform, shotlistPath: "out/镜头 卡.json", routePath: "out/route.json", outDir: "out/成片 空格" });
  assert.equal(plan.ready, true);
  const capture = join(root, "capture.mjs");
  writeFileSync(capture, "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
  const quote = (text) => "'" + text.replace(/'/gu, "'\"'\"'") + "'";
  const command = plan.recommendedCommand.replace(/^'pnpm'/u, `${quote(process.execPath)} ${quote(capture)}`);
  const actual = JSON.parse(execFileSync("/bin/sh", ["-c", command], { encoding: "utf8" }));
  assert.deepEqual(actual, plan.execution.args);
  assert.ok(actual.includes(projectId));
  assert.ok(actual.includes(platform));
  assert.ok(plan.recommendedPowerShellCommand.startsWith("& 'pnpm'"));
  assert.ok(plan.recommendedPowerShellCommand.includes("客户'';"));
  assert.throws(() => productionPlan({ projectId: platform }), /项目 ID/u);
  assert.throws(() => productionPlan({ projectId: "line\nbreak" }), /项目 ID/u);
}));
