import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildVariantCoverFilters, embedCoverFirstFrame } from "./cover-assembly.js";
import { COVER_PLATFORM_IDS, getCoverSpec } from "./cover-platforms.js";

const FFMPEG = process.env.WORKLOOM_TEST_FFMPEG ?? "/Users/mac/.local/bin/ffmpeg";
const FFPROBE = process.env.WORKLOOM_TEST_FFPROBE ?? "/Users/mac/.local/bin/ffprobe";
const directory = mkdtempSync(join(tmpdir(), "workloom-cover-assembly-"));
const source = join(directory, "source ' with spaces.mp4");
const cover = join(directory, "cover blue.png");
const output = join(directory, "publication.mp4");
const execute = (args: string[]) => execFileSync(FFMPEG, ["-v", "error", "-y", ...args], { maxBuffer: 8 * 1024 * 1024 });
const pixelAt = (file: string, frame: number): Buffer => execute([
  "-i", file, "-vf", `select=eq(n\\,${frame}),scale=1:1`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
]);
const pcm = (file: string): Buffer => execute(["-i", file, "-map", "0:a:0", "-c:a", "pcm_s16le", "-f", "s16le", "-"]);

beforeAll(() => {
  const subtitles = join(directory, "fixture.srt");
  writeFileSync(subtitles, "1\n00:00:00,000 --> 00:00:01,250\nFirst subtitle stays at zero.\n\n2\n00:00:12,000 --> 00:00:14,000\nSecond subtitle does not shift.\n");
  execute([
    "-f", "lavfi", "-i", "color=c=red:s=96x160:r=24:d=30",
    "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=30",
    "-i", subtitles, "-map", "0:v", "-map", "1:a", "-map", "2:s",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-c:s", "mov_text", source,
  ]);
  execute(["-f", "lavfi", "-i", "color=c=blue:s=96x160", "-frames:v", "1", cover]);
}, 30_000);

afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe("official publication cover assembly", () => {
  it("replaces only the first frame of a 30s film without shifting audio or subtitles", async () => {
    const receipt = await embedCoverFirstFrame({ input: source, cover, output, ffmpeg: FFMPEG, ffprobe: FFPROBE });
    expect(receipt.mode).toBe("replace-first-frame");
    expect(receipt.coverFrameCount).toBe(1);
    expect(receipt.video.frameCount).toBe(720);
    expect(receipt.video.durationSeconds).toBe(30);
    expect(receipt.video.fps).toBe(24);
    expect(receipt.audio.preserved).toBe(true);
    expect(receipt.audio.streamCount).toBe(1);
    expect(receipt.subtitles.preserved).toBe(true);
    expect(receipt.subtitles.streamCount).toBe(1);
    expect(receipt.output.sha256).toMatch(/^[0-9a-f]{64}$/);
    const first = pixelAt(output, 0);
    const second = pixelAt(output, 1);
    expect(first[2]).toBeGreaterThan(240);
    expect(first[0]).toBeLessThan(10);
    expect(second[0]).toBeGreaterThan(240);
    expect(second[2]).toBeLessThan(10);
    expect(pcm(output).equals(pcm(source))).toBe(true);
    const extractSubtitles = (file: string): string => execute(["-i", file, "-map", "0:s:0", "-f", "srt", "-"]).toString();
    expect(extractSubtitles(output)).toBe(extractSubtitles(source));
  }, 30_000);

  it("supports a silent film with no subtitle stream and a different frame rate", async () => {
    const silent = join(directory, "silent.mp4");
    execute(["-f", "lavfi", "-i", "color=c=red:s=96x160:r=30:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", silent]);
    const receipt = await embedCoverFirstFrame({ input: silent, cover, output: join(directory, "silent-publication.mp4"), ffmpeg: FFMPEG, ffprobe: FFPROBE });
    expect(receipt.video.frameCount).toBe(60);
    expect(receipt.video.durationSeconds).toBe(2);
    expect(receipt.audio.streamCount).toBe(0);
    expect(receipt.subtitles.streamCount).toBe(0);
  }, 30_000);

  it("preserves every audio stream when a film contains two independent tracks", async () => {
    const multiple = join(directory, "two-audio-streams.mp4");
    execute([
      "-f", "lavfi", "-i", "color=c=red:s=96x160:r=24:d=2",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
      "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=2",
      "-map", "0:v", "-map", "1:a", "-map", "2:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", multiple,
    ]);
    const receipt = await embedCoverFirstFrame({ input: multiple, cover, output: join(directory, "two-audio-publication.mp4"), ffmpeg: FFMPEG, ffprobe: FFPROBE });
    expect(receipt.audio.streamCount).toBe(2);
    expect(receipt.audio.decodedPcmSha256).toHaveLength(2);
    expect(new Set(receipt.audio.decodedPcmSha256).size).toBe(2);
    expect(receipt.video.frameCount).toBe(48);
  }, 30_000);

  it.each(["missing", "invalid", "wrong-dimensions"])("rejects a %s cover without changing an existing target", async (kind) => {
    const target = join(directory, `preserve-${kind}.mp4`);
    writeFileSync(target, "existing delivery");
    const candidate = join(directory, `bad-${kind}.png`);
    if (kind === "invalid") writeFileSync(candidate, "not an image");
    if (kind === "wrong-dimensions") execute(["-f", "lavfi", "-i", "color=c=blue:s=160x96", "-frames:v", "1", candidate]);
    await expect(embedCoverFirstFrame({ input: source, cover: candidate, output: target, ffmpeg: FFMPEG, ffprobe: FFPROBE })).rejects.toThrow();
    expect(readFileSync(target, "utf8")).toBe("existing delivery");
    expect(readdirSync(directory).some((name) => name.includes(".pending-"))).toBe(false);
  });

  it("rejects input and cover aliases including a symlink", async () => {
    await expect(embedCoverFirstFrame({ input: source, cover, output: source, ffmpeg: FFMPEG, ffprobe: FFPROBE })).rejects.toThrow(/alias/);
    await expect(embedCoverFirstFrame({ input: source, cover, output: cover, ffmpeg: FFMPEG, ffprobe: FFPROBE })).rejects.toThrow(/alias/);
    const alias = join(directory, "source-alias.mp4");
    symlinkSync(source, alias);
    await expect(embedCoverFirstFrame({ input: source, cover, output: alias, ffmpeg: FFMPEG, ffprobe: FFPROBE })).rejects.toThrow(/alias/);
    const hardLink = join(directory, "source-hard-link.mp4");
    linkSync(source, hardLink);
    await expect(embedCoverFirstFrame({ input: source, cover, output: hardLink, ffmpeg: FFMPEG, ffprobe: FFPROBE })).rejects.toThrow(/alias/);
  });

  it("ffmpeg failure and invalid output never replace a valid existing delivery", async () => {
    const target = join(directory, "previous.mp4");
    writeFileSync(target, "previous valid delivery");
    const failure = join(directory, "fail-ffmpeg.sh");
    writeFileSync(failure, "#!/bin/sh\necho fixture encoder failure >&2\nexit 7\n");
    chmodSync(failure, 0o755);
    await expect(embedCoverFirstFrame({ input: source, cover, output: target, ffmpeg: failure, ffprobe: FFPROBE })).rejects.toThrow(/fixture encoder failure/);
    expect(readFileSync(target, "utf8")).toBe("previous valid delivery");
    const broken = join(directory, "broken-ffmpeg.sh");
    writeFileSync(broken, "#!/bin/sh\nfor last; do :; done\nprintf not-media > \"$last\"\n");
    chmodSync(broken, 0o755);
    await expect(embedCoverFirstFrame({ input: source, cover, output: target, ffmpeg: broken, ffprobe: FFPROBE })).rejects.toThrow();
    expect(readFileSync(target, "utf8")).toBe("previous valid delivery");
    expect(readdirSync(directory).some((name) => name.includes(".pending-"))).toBe(false);
  });

  it("refuses an existing symlink target outside the publication directory", async () => {
    const target = join(directory, "external-symlink.mp4");
    symlinkSync(source, target);
    await expect(embedCoverFirstFrame({ input: source, cover, output: target, ffmpeg: FFMPEG, ffprobe: FFPROBE })).rejects.toThrow();
    expect(existsSync(source)).toBe(true);
  });

  it("rejects a successful no-op encoder that never inserted the supplied cover", async () => {
    const target = join(directory, "no-op-preserved.mp4");
    writeFileSync(target, "previous valid delivery");
    const wrapper = join(directory, "no-op-ffmpeg.sh");
    writeFileSync(wrapper, `#!/bin/sh\nfirst_input=''\ncapture=0\nrender=0\nfor arg; do\n  last="$arg"\n  if [ "$capture" = 1 ] && [ -z "$first_input" ]; then first_input="$arg"; fi\n  capture=0\n  if [ "$arg" = -i ]; then capture=1; fi\n  case "$arg" in *overlay=*) render=1;; esac\ndone\nif [ "$render" = 1 ]; then cp "$first_input" "$last"; exit $?; fi\nexec '${FFMPEG}' "$@"\n`);
    chmodSync(wrapper, 0o755);
    await expect(embedCoverFirstFrame({ input: source, cover, output: target, ffmpeg: wrapper, ffprobe: FFPROBE })).rejects.toThrow(/first frame does not match cover/);
    expect(readFileSync(target, "utf8")).toBe("previous valid delivery");
  }, 30_000);

  it("serializes writers and preserves an existing target when its publication lock is held", async () => {
    const target = join(directory, "locked.mp4");
    writeFileSync(target, "previous valid delivery");
    writeFileSync(`${target}.cover-assembly.lock`, "other writer");
    await expect(embedCoverFirstFrame({ input: source, cover, output: target, ffmpeg: FFMPEG, ffprobe: FFPROBE })).rejects.toThrow(/busy/);
    expect(readFileSync(target, "utf8")).toBe("previous valid delivery");
    expect(readFileSync(`${target}.cover-assembly.lock`, "utf8")).toBe("other writer");
  });

  it("rejects a successful encoder that alters the audio even when video duration and frame count are unchanged", async () => {
    const changed = join(directory, "changed-audio.mp4");
    execute(["-i", source, "-f", "lavfi", "-i", "sine=frequency=1760:sample_rate=48000:duration=30",
      "-map", "0:v", "-map", "1:a", "-map", "0:s", "-c:v", "copy", "-c:a", "aac", "-c:s", "copy", changed]);
    const target = join(directory, "altered-audio-preserved.mp4");
    writeFileSync(target, "previous valid delivery");
    const wrapper = join(directory, "alter-audio-ffmpeg.sh");
    writeFileSync(wrapper, `#!/bin/sh\nrender=0\nfor arg; do\n  last="$arg"\n  case "$arg" in *overlay=*) render=1;; esac\ndone\nif [ "$render" = 1 ]; then cp '${changed}' "$last"; exit $?; fi\nexec '${FFMPEG}' "$@"\n`);
    chmodSync(wrapper, 0o755);
    await expect(embedCoverFirstFrame({ input: source, cover, output: target, ffmpeg: wrapper, ffprobe: FFPROBE })).rejects.toThrow(/audio.*changed/);
    expect(readFileSync(target, "utf8")).toBe("previous valid delivery");
  }, 30_000);
});

describe("pure style cover filters", () => {
  it("renders three distinct style covers with the real filter parser and leaves the source image intact", () => {
    const base = join(directory, "style-base.png");
    execute(["-f", "lavfi", "-i", "color=c=0x607080:s=96x160", "-frames:v", "1", base]);
    const before = readFileSync(base);
    const rendered = new Set<string>();
    for (const [variantId, accent] of [["warm-film", "#E8B44A"], ["punchy-social", "#FF6A5A"], ["cool-tech", "#6FD3E8"]] as const) {
      const filters = buildVariantCoverFilters({ variantId, accent, platform: "wechat-channels", width: 96, height: 160 });
      const file = join(directory, `style-${variantId}.png`);
      execute(["-i", base, "-vf", filters.filter, "-frames:v", "1", file]);
      rendered.add(readFileSync(file).toString("base64"));
    }
    expect(rendered.size).toBe(3);
    expect(readFileSync(base).equals(before)).toBe(true);
  });

  it("keeps every accent box inside each registered platform safe area and burns no labels", () => {
    for (const platform of COVER_PLATFORM_IDS) {
      const spec = getCoverSpec(platform);
      const filters = new Set<string>();
      for (const variantId of ["warm-film", "punchy-social", "cool-tech"] as const) {
        const plan = buildVariantCoverFilters({ variantId, accent: "#FF6633", platform, ...spec.canvas });
        const { accentBox: box, safeArea: safe } = plan;
        expect(box.x).toBeGreaterThanOrEqual(safe.left);
        expect(box.y).toBeGreaterThanOrEqual(safe.top);
        expect(box.x + box.width).toBeLessThanOrEqual(safe.right);
        expect(box.y + box.height).toBeLessThanOrEqual(safe.bottom);
        expect(plan.filter).not.toMatch(/drawtext|text=|风格|AI生成|暖色|科技|社媒/);
        filters.add(plan.filter);
      }
      expect(filters.size).toBe(3);
    }
  });

  it("rejects unknown styles, unsafe color injection, unknown platforms, and invalid dimensions", () => {
    const input = { variantId: "warm-film" as const, accent: "#FFD166", platform: "douyin", width: 1080, height: 1920 };
    expect(() => buildVariantCoverFilters({ ...input, variantId: "unknown" as never })).toThrow();
    expect(() => buildVariantCoverFilters({ ...input, accent: "#FF0000:drawtext=text=AI生成" })).toThrow();
    expect(() => buildVariantCoverFilters({ ...input, platform: "unknown" })).toThrow();
    expect(() => buildVariantCoverFilters({ ...input, width: 0 })).toThrow();
    expect(() => buildVariantCoverFilters({ ...input, height: Number.NaN })).toThrow();
  });
});
