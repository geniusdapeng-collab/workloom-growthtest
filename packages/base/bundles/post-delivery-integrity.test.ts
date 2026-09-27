import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { normaliseShots, readRevisionBase, reedit } from "../../../bundles/ai-video/connectors/post-bridge/core.mjs";

const bins = {
  ffmpeg: process.env.WORKLOOM_POST_FFMPEG_PATH || "ffmpeg",
  ffprobe: process.env.WORKLOOM_POST_FFPROBE_PATH || "ffprobe",
};
const hasMediaTools = [bins.ffmpeg, bins.ffprobe].every((bin) => spawnSync(bin, ["-version"], { stdio: "ignore" }).status === 0)
  && /\blibx264\b/.test(spawnSync(bins.ffmpeg, ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout ?? "");
const scratch: string[] = [];
const expectedBase = (file: string) => {
  const base = readRevisionBase(file);
  return { expectedVersion: base.version, expectedProjectSha256: base.sha256 };
};

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function ffmpeg(args: string[]): void {
  const done = spawnSync(bins.ffmpeg, args, { encoding: "utf8", timeout: 30_000 });
  if (done.status !== 0) throw new Error(done.stderr || `ffmpeg exited ${done.status}`);
}

it.skipIf(!hasMediaTools)("rejects a replaced normalization cache and a modified prior variant during reedit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "workloom-post-integrity-"));
  scratch.push(dir);
  const source = join(dir, "source.mp4");
  ffmpeg(["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=12:duration=1", "-f", "lavfi", "-i", "sine=frequency=500:sample_rate=48000:duration=1", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", source]);
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
  const previousVideo = join(dir, "previous.mp4");
  copyFileSync(replacement, previousVideo);
  const cover = join(dir, "cover.png");
  writeFileSync(cover, "synthetic-cover");
  const coverSha256 = createHash("sha256").update("synthetic-cover").digest("hex");
  const projectPath = join(dir, "film-project.json");
  const project = {
    schemaVersion: "workloom.film-project/v1", projectId: "integrity", version: 1,
    resolution: [160, 90], fps: 12,
    layers: {
      shots: [{ shotId: "SC-01", normalised: fresh.path, source, sourceSha256: fresh.sourceHash, sha256: fresh.sha256, duration: fresh.duration }],
      variants: ["warm-story", "clean-tech"].map((id) => ({ id, assembly: { path: fresh.path, sha256: fresh.sha256 }, color: { path: fresh.path, sha256: fresh.sha256 },
        artifacts: { video: { path: previousVideo, sha256: fresh.sha256 }, cover: { path: cover, sha256: coverSha256 } } })),
    },
  };
  writeFileSync(projectPath, JSON.stringify(project));
  await expect(reedit({ projectPath, ...expectedBase(projectPath), deliveryDir: dir, patch: { copy: { title: "changed" } }, bins })).rejects.toMatchObject({ code: "verify_failed" });

  copyFileSync(fresh.path, previousVideo);
  const revision = await reedit({ projectPath, ...expectedBase(projectPath), deliveryDir: dir, patch: { copy: { title: "changed" } }, bins });
  expect(revision.executed).toBe(true);
  expect(revision.version).toBe(3); // v2 failed integrity and remains reserved for audit.
  expect(JSON.parse(readFileSync(join(dir, "versions", "v2", "revision-failed.json"), "utf8")).code).toBe("verify_failed");
  const next = JSON.parse(readFileSync(revision.projectPath, "utf8"));
  expect(next.layers.variants[0].assembly.sha256).toBe(fresh.sha256);
  expect(next.layers.variants[0].color.sha256).toBe(fresh.sha256);
  expect(next.layers.variants[0].artifacts.video.sha256).toBe(fresh.sha256);
  const committedBefore = readFileSync(revision.projectPath);
  await expect(reedit({ projectPath, ...expectedBase(projectPath), deliveryDir: dir, patch: { copy: { title: "different" } }, bins }))
    .rejects.toMatchObject({ code: "revision_conflict" });
  expect(readFileSync(revision.projectPath)).toEqual(committedBefore);
  const nextRevision = await reedit({ projectPath: revision.projectPath, ...expectedBase(revision.projectPath), patch: { copy: { title: "again" } }, bins });
  expect(nextRevision.version).toBe(4);
  expect(nextRevision.targetDir).toBe(join(dir, "versions", "v4"));
  const coverRevision = await reedit({ projectPath: nextRevision.projectPath, ...expectedBase(nextRevision.projectPath), patch: { cover: { variantId: "warm-story", subtitle: "New cover" } }, bins });
  expect(coverRevision.rebuilt.filter((row: { layer: string }) => row.layer === "cover").map((row: { variant: string }) => row.variant)).toEqual(["warm-story"]);
  expect(coverRevision.reused.filter((row: { layer: string }) => row.layer === "cover").map((row: { variant: string }) => row.variant)).toEqual(["clean-tech"]);
}, 30_000);
