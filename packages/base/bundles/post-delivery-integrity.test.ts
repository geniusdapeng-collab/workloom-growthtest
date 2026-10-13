import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

import { buildDeliveryPackage, normaliseShots, readRevisionBase, reedit } from "../../../bundles/ai-video/connectors/post-bridge/core.mjs";

const bins = {
  ffmpeg: process.env.WORKLOOM_POST_FFMPEG_PATH || "ffmpeg",
  ffprobe: process.env.WORKLOOM_POST_FFPROBE_PATH || "ffprobe",
};
const hasMediaTools = [bins.ffmpeg, bins.ffprobe].every((bin) => spawnSync(bin, ["-version"], { stdio: "ignore" }).status === 0)
  && /\blibx264\b/.test(spawnSync(bins.ffmpeg, ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout ?? "");
const scratch: string[] = [];
// Declare the fixture's real paths, including macOS /var aliases, without widening production defaults.
const ROOT_ENV_KEYS = ["WORKLOOM_POST_ALLOWED_ROOTS", "WORKLOOM_BGM_ALLOWED_ROOTS", "WORKLOOM_COLOR_ALLOWED_ROOTS", "WORKLOOM_SUBTITLE_ALLOWED_ROOTS"] as const;
const previousRoots = new Map<string, string | undefined>();
function allowScratchRoot(dir: string): void {
  for (const key of ROOT_ENV_KEYS) {
    if (!previousRoots.has(key)) previousRoots.set(key, process.env[key]);
    const existing = (process.env[key] ?? "").trim();
    process.env[key] = [existing, dir].filter(Boolean).join(delimiter);
  }
}
const expectedBase = (file: string) => {
  const base = readRevisionBase(file);
  return { expectedVersion: base.version, expectedProjectSha256: base.sha256 };
};
const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of previousRoots) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  previousRoots.clear();
});

function ffmpeg(args: string[]): void {
  const done = spawnSync(bins.ffmpeg, args, { encoding: "utf8", timeout: 30_000 });
  if (done.status !== 0) throw new Error(done.stderr || `ffmpeg exited ${done.status}`);
}

it.skipIf(!hasMediaTools)("rejects a replaced normalization cache and a modified prior variant during reedit", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "workloom-post-integrity-")));
  scratch.push(dir);
  allowScratchRoot(dir);
  const source = join(dir, "source.mp4");
  ffmpeg(["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=12:duration=1", "-f", "lavfi", "-i", "sine=frequency=500:sample_rate=48000:duration=1", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", source]);
  const sourceHash = digest(source);
  const params = { shots: [{ shotId: "SC-01", path: source }], project: { resolution: [160, 90], fps: 12 }, workDir: dir, bins };
  const [first] = await normaliseShots(params);
  expect(first.reused).toBe(false);
  const [reused] = await normaliseShots(params);
  expect(reused.reused).toBe(true);
  expect(reused.sha256).toBe(first.sha256);

  const replacement = join(dir, "replacement.mp4");
  ffmpeg(["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "color=c=red:size=160x90:rate=12:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", replacement]);
  copyFileSync(replacement, first.path);
  await expect(normaliseShots(params)).rejects.toMatchObject({ code: "verify_failed" });
  const [fresh] = await normaliseShots({ ...params, force: true });
  expect(fresh.reused).toBe(false);
  expect(digest(source)).toBe(sourceHash);

  // A reuse-integrity test needs a real completed delivery and its processing proofs.
  // An unproven legacy project is intentionally rebuilt and cannot exercise that branch.
  const library = join(dir, "music"); mkdirSync(library);
  ffmpeg(["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000:duration=3", "-c:a", "pcm_s16le", join(library, "fixture.wav")]);
  writeFileSync(join(library, "tracks.json"), JSON.stringify({ tracks: [
    { id: "integrity-warm", title: "Synthetic warm fixture", style: "acoustic-warm", mood: "温暖自在", file: "fixture.wav", durationSec: 3, license: "workloom-self-generated", source: "offline-synthetic-fixture", artist: "test fixture" },
    { id: "integrity-clean", title: "Synthetic clean fixture", style: "corporate-clean", mood: "干净可信", file: "fixture.wav", durationSec: 3, license: "workloom-self-generated", source: "offline-synthetic-fixture", artist: "test fixture" },
  ] }));
  const env = { ...process.env, WORKLOOM_BGM_DISCOVER: "0", WORKLOOM_BGM_LIBRARY_DIR: library, WORKLOOM_BGM_HOME: join(dir, "bgm-home") };
  const deliveryDir = join(dir, "delivery");
  await buildDeliveryPackage({ project: { projectId: "integrity", title: "Integrity fixture", resolution: [160, 90], fps: 12,
    copy: { title: "Integrity fixture", hook: "Local fixture", body: "before" } }, shots: params.shots,
    variants: ["warm-story", "clean-tech"], outDir: deliveryDir, bins, env });
  const projectPath = join(deliveryDir, "film-project.json");
  const originalProject = readFileSync(projectPath);
  const project = JSON.parse(originalProject.toString("utf8"));
  expect(project.processing.some((proof: { stage: string; id: string }) => proof.stage === "transitions" && proof.id === "master")).toBe(true);
  for (const variant of project.layers.variants) {
    for (const stage of ["transitions", "color", "bgm"]) {
      expect(project.processing.some((proof: { stage: string; id: string }) => proof.stage === stage && proof.id === variant.id)).toBe(true);
    }
  }
  const previousVideo = resolve(deliveryDir, project.layers.variants[0].artifacts.video.path);
  const originalVideo = readFileSync(previousVideo);
  expect(digest(previousVideo)).toBe(project.layers.variants[0].artifacts.video.sha256);
  copyFileSync(replacement, previousVideo);
  await expect(reedit({ projectPath, ...expectedBase(projectPath), deliveryDir, patch: { copy: { title: "changed" } }, bins, env })).rejects.toMatchObject({ code: "verify_failed" });
  expect(readFileSync(projectPath)).toEqual(originalProject);
  expect(digest(source)).toBe(sourceHash);

  writeFileSync(previousVideo, originalVideo);
  const revision = await reedit({ projectPath, ...expectedBase(projectPath), deliveryDir, patch: { copy: { title: "changed" } }, bins, env });
  expect(revision.executed).toBe(true);
  expect(revision.version).toBe(3); // v2 failed integrity and remains reserved for audit.
  expect(JSON.parse(readFileSync(join(deliveryDir, "versions", "v2", "revision-failed.json"), "utf8")).code).toBe("verify_failed");
  const next = JSON.parse(readFileSync(revision.projectPath, "utf8"));
  for (const original of project.layers.variants) {
    const current = next.layers.variants.find((variant: { id: string }) => variant.id === original.id);
    expect(current.assembly.sha256).toBe(original.assembly.sha256);
    expect(current.color.sha256).toBe(original.color.sha256);
    expect(current.artifacts.video.sha256).toBe(original.artifacts.video.sha256);
  }
  const committedBefore = readFileSync(revision.projectPath);
  await expect(reedit({ projectPath, ...expectedBase(projectPath), deliveryDir, patch: { copy: { title: "different" } }, bins, env }))
    .rejects.toMatchObject({ code: "revision_conflict" });
  expect(readFileSync(revision.projectPath)).toEqual(committedBefore);
  const nextRevision = await reedit({ projectPath: revision.projectPath, ...expectedBase(revision.projectPath), patch: { copy: { title: "again" } }, bins, env });
  expect(nextRevision.version).toBe(4);
  expect(nextRevision.targetDir).toBe(join(deliveryDir, "versions", "v4"));
  const coverRevision = await reedit({ projectPath: nextRevision.projectPath, ...expectedBase(nextRevision.projectPath), patch: { cover: { variantId: "warm-story", subtitle: "New cover" } }, bins, env });
  expect(coverRevision.rebuilt.filter((row: { layer: string }) => row.layer === "cover").map((row: { variant: string }) => row.variant)).toEqual(["warm-story"]);
  expect(coverRevision.reused.filter((row: { layer: string }) => row.layer === "cover").map((row: { variant: string }) => row.variant)).toEqual(["clean-tech"]);
  expect(readFileSync(projectPath)).toEqual(originalProject);
  expect(readFileSync(revision.projectPath)).toEqual(committedBefore);
  expect(digest(previousVideo)).toBe(project.layers.variants[0].artifacts.video.sha256);
  expect(digest(source)).toBe(sourceHash);
}, 120_000);
