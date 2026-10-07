/** Real local FFmpeg fixtures; no provider, identity, speech or paid-production proof. */
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const ffmpeg = process.env.WL_FFMPEG ?? "ffmpeg", ffprobe = process.env.WL_FFPROBE ?? "ffprobe";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
function run(binary: string, args: string[]) {
  return spawnSync(binary, args, { cwd: repo, encoding: "utf8", timeout: 90_000, maxBuffer: 16 * 1024 * 1024 });
}
function fixture(frames: number, audioSeconds: number, seed: number, out: string) {
  const result = run(ffmpeg, ["-v", "error", "-nostdin", "-n", "-f", "lavfi", "-i", `testsrc2=s=160x288:r=24:d=${frames / 24}`,
    // A pure periodic tone has many equally valid correlation peaks. Seeded
    // noise provides an identifiable reference for the real AV-sync detector.
    "-f", "lavfi", "-i", `anoisesrc=seed=${seed}:sample_rate=32000:duration=${audioSeconds}:amplitude=0.3`,
    "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "32000", "-ac", "2", out]);
  expect(result.status, result.stderr).toBe(0);
}
function compose(clips: string[], out: string, extra: string[] = []) {
  return run(process.execPath, ["--import", "tsx", "scripts/tools/compose-film.mts", "--clips", clips.join(","), "--out", out,
    "--width", "160", "--height", "288", "--fps", "24", "--fade", "0", "--color", "none", "--native-clock", ...extra]);
}
function probe(file: string) {
  const result = run(ffprobe, ["-v", "error", "-count_frames", "-show_streams", "-of", "json", file]);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout).streams as Array<{ codec_type: string; nb_read_frames: string; duration: string; avg_frame_rate: string }>;
}
function pictureHashes(file: string) {
  const result = run(ffmpeg, ["-v", "error", "-nostdin", "-i", file, "-map", "0:v:0", "-f", "framehash", "-hash", "sha256", "-"]);
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.split("\n").filter(line => line && !line.startsWith("#")).map(line => line.split(",").at(-1)!.trim());
}

describe("native complete picture clock composition", () => {
  it("retains endpoint frames and current source bytes across three AAC container boundaries", () => {
    const dir = mkdtempSync(join(tmpdir(), "compose-native-clock-")); roots.push(dir);
    const counts = [97, 121, 97], clips = counts.map((_, index) => join(dir, `source-${index}.mp4`));
    clips.forEach((clip, index) => fixture(counts[index]!, counts[index]! / 24 + 0.04, 533 + index * 173, clip));
    const hashes = clips.map(digest), out = join(dir, "master.mp4");
    const result = compose(clips, out);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const video = probe(out).find(stream => stream.codec_type === "video")!;
    expect(Number(video.nb_read_frames)).toBe(315);
    expect(video.avg_frame_rate).toBe("24/1");
    expect(Number(video.duration)).toBeCloseTo(315 / 24, 6);
    const av = JSON.parse(readFileSync(join(dir, "master.av-sync.json"), "utf8"));
    expect(av).toMatchObject({ ok: true, clipCount: 3, nativeClock: true, retimeFactor: 1 });
    expect(av.measured).toBe(3);
    expect(pictureHashes(out)).toEqual(clips.flatMap(pictureHashes));
    expect(clips.map(digest)).toEqual(hashes);
  }, 120_000);
  it("rejects a short native audio tail before producing a master", () => {
    const dir = mkdtempSync(join(tmpdir(), "compose-native-short-")); roots.push(dir);
    const clip = join(dir, "short.mp4"); fixture(97, 3.5, 733, clip);
    const before = digest(clip), result = compose([clip], join(dir, "master.mp4"));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("STANDARD_POST_NATIVE_CLOCK_INCOMPLETE");
    expect(digest(clip)).toBe(before);
  }, 120_000);
  it("rejects retiming flags before invoking media work", () => {
    const dir = mkdtempSync(join(tmpdir(), "compose-native-retime-")); roots.push(dir);
    const clip = join(dir, "source.mp4"); fixture(97, 4.09, 733, clip);
    const result = compose([clip], join(dir, "master.mp4"), ["--retime-to", "4"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("STANDARD_NATIVE_COMPOSE_OPTIONS_INVALID");
  }, 120_000);
});
