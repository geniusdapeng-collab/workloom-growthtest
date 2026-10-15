import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { COVER_PLATFORM_IDS, getCoverSpec } from "./cover-platforms.js";
import { COVER_FONTS, type CoverFontId } from "./cover-design.js";
import { renderLocalCover, type LocalCoverRenderInput } from "./local-cover-render.js";

function binary(name: string, configured?: string): string {
  if (configured && isAbsolute(configured)) return realpathSync(configured);
  const file = (process.env.PATH ?? "").split(delimiter).map((directory) => join(directory, configured ?? name)).find(existsSync);
  if (!file) throw new Error(`Local media test requires ${name}; absence is a test failure`);
  return realpathSync(file);
}
const FFMPEG = binary("ffmpeg", process.env.WORKLOOM_TEST_FFMPEG ?? process.env.WL_FFMPEG);
const FFPROBE = binary("ffprobe", process.env.WORKLOOM_TEST_FFPROBE ?? process.env.WL_FFPROBE);
const FONT = fileURLToPath(new URL("../../../bundles/ai-video/library/fonts/cn/SourceHanSansCN-Heavy.otf", import.meta.url));
const FONT_SHA = "88c749b0a54a0800124ded6544e399302ed224aa49992ea364b88769f825c54c";
const directory = realpathSync(mkdtempSync(join(tmpdir(), "workloom-local-cover-")));
const source = join(directory, "source ' : with spaces.png"), video = join(directory, "existing-render.mp4");
const sha = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");
const execute = (args: string[]): Buffer => execFileSync(FFMPEG, ["-v", "error", "-nostdin", "-y", ...args], { maxBuffer: 80 * 1024 * 1024 });
const base = (name: string, patch: Partial<LocalCoverRenderInput> = {}): LocalCoverRenderInput => ({
  source: { kind: "image", path: source }, title: "让酒店服务\n更从容", subtitle: "示例品牌 · 双屏自助机",
  platform: "wechat-channels", width: 180, height: 320,
  fontFile: FONT, fontSha256: FONT_SHA, ffmpeg: FFMPEG, ffprobe: FFPROBE,
  out: join(directory, `${name}.png`), ...patch
});
const stale = (target: string): Buffer => { const bytes = Buffer.from("previous valid local output"); writeFileSync(target, bytes); return bytes; };
const wrapper = (name: string, body: string): string => {
  const path = join(directory, `${name}.cjs`);
  writeFileSync(path, `#!${process.execPath}\nconst fs=require('node:fs');const cp=require('node:child_process');const args=process.argv.slice(2);const last=args.at(-1);\n${body}\nconst result=cp.spawnSync(${JSON.stringify(FFMPEG)},args,{stdio:'inherit'});process.exit(result.status??8);\n`);
  chmodSync(path, 0o755);
  return path;
};
function expectNoScratch(): void {
  expect(readdirSync(directory).filter((name) => name.startsWith(".local-cover-") || name.endsWith(".local-cover.lock"))).toEqual([]);
}

beforeAll(() => {
  expect(sha(readFileSync(FONT))).toBe(FONT_SHA);
  execute(["-f", "lavfi", "-i", "color=c=0x9ca1a3:s=180x320", "-vf", "drawbox=x=55:y=155:w=70:h=100:color=0x455a70:t=fill", "-frames:v", "1", "-threads", "1", source]);
  execute(["-f", "lavfi", "-i", "color=c=red:s=180x320:r=24:d=1", "-f", "lavfi", "-i", "color=c=blue:s=180x320:r=24:d=1",
    "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", video]);
}, 30_000);
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe("local-only cover renderer: actual media and copy", () => {
  it.each(["original", "warm-story", "content-auto"] as const)("accepts %s without grading the already styled cover frame again", async (variant) => {
    const before = sha(readFileSync(source));
    const result = await renderLocalCover(base(`ai-${variant}`, { variant }));
    expect(result.receipt.recipe.variant).toBe(variant);
    expect(result.receipt.recipe.backgroundFilters.join(",")).not.toMatch(/eq=|curves=|colorbalance=|lut3d=|tonemap=/);
    expect(result.receipt.text.every((line) => line.changedPixelCount > 0)).toBe(true);
    expect(result.receipt.source.sha256).toBe(before);
    expect(sha(readFileSync(source))).toBe(before);
  });

  it("renders CJK title/subtitle pixels and current file/font/recipe proofs with zero network calls", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Local renderer must not use fetch"));
    try {
      const before = sha(readFileSync(source));
      const result = await renderLocalCover(base("normal"));
      expect(sha(readFileSync(result.path))).toBe(result.sha256);
      expect(result.receipt.source.sha256).toBe(before);
      expect(result.receipt.font.sha256).toBe(FONT_SHA);
      expect(result.receipt.font.glyphCoverageChecked).toBe(true);
      expect(result.receipt.font.codePoints).toContain("酒".codePointAt(0));
      expect(result.receipt.output).toMatchObject({ width: 180, height: 320 });
      expect(result.receipt.output.rgbaSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result.receipt.text.map((line) => line.field)).toEqual(["title", "title", "subtitle"]);
      for (const line of result.receipt.text) {
        const bounds = result.receipt.recipe.safeBounds;
        expect(line.alphaPixelCount).toBeGreaterThan(10);
        expect(line.changedPixelCount).toBeGreaterThan(10);
        expect(line.bbox.x).toBeGreaterThanOrEqual(bounds.left);
        expect(line.bbox.x + line.bbox.width).toBeLessThanOrEqual(bounds.right);
        expect(line.bbox.y).toBeGreaterThanOrEqual(bounds.top);
        expect(line.bbox.y + line.bbox.height).toBeLessThanOrEqual(bounds.titleBottom);
      }
      const draw = result.receipt.commands.filter((command) => command.argv.some((arg) => arg.includes("drawtext=")));
      expect(draw).toHaveLength(3);
      expect(draw.every((command) => command.argv.join(" ").includes("expansion=none"))).toBe(true);
      expect(draw.every((command) => !command.argv.join(" ").includes("让酒店"))).toBe(true);
      expect(network).not.toHaveBeenCalled();
      expect(sha(readFileSync(source))).toBe(before);
      expectNoScratch();
    } finally { network.mockRestore(); }
  });

  it("extracts the requested nonzero video frame instead of the opening frame", async () => {
    const first = await renderLocalCover(base("video-zero", { source: { kind: "video-frame", path: video, timeSec: 0 } }));
    const chosen = await renderLocalCover(base("video-chosen", { source: { kind: "video-frame", path: video, timeSec: 1.25 } }));
    expect(chosen.receipt.source.timeSec).toBe(1.25);
    expect(chosen.receipt.source.sha256).toBe(sha(readFileSync(video)));
    expect(chosen.receipt.source.frameRgbaSha256).not.toBe(first.receipt.source.frameRgbaSha256);
    const expected = execute(["-i", video, "-ss", "1.25", "-map", "0:v:0", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"]);
    expect(chosen.receipt.source.frameRgbaSha256).toBe(sha(expected));
  }, 30_000);

  it("produces repeatable decoded pixels for the same frozen local recipe", async () => {
    const left = await renderLocalCover(base("repeat-one"));
    const right = await renderLocalCover(base("repeat-two"));
    expect(left.receipt.output.rgbaSha256).toBe(right.receipt.output.rgbaSha256);
    expect(left.receipt.recipe.sha256).toBe(right.receipt.recipe.sha256);
  }, 30_000);
  it("creates a new regular output directory and removes its private writer files", async () => {
    const out = join(directory, "new-output", "nested", "cover.png");
    const result = await renderLocalCover(base("new-parent", { out }));
    expect(result.path).toBe(out);
    expect(sha(readFileSync(out))).toBe(result.sha256);
    expect(readdirSync(join(directory, "new-output", "nested"))).toEqual(["cover.png"]);
  });
  it.each([
    ["smiley-sans", "b447d7e781f08bc95c4c9f23ba71ed2b8ebb639aa7184485c71c4ca5afcd25c4"],
    ["source-han-heavy", FONT_SHA],
    ["zcool-qingke", "54f0c0df4308cd74cd0f2fd3494ae054dbc4a1fd6fa7d71f4807eb4cdd8b4136"],
    ["noto-serif", "050080d9255a86808f2945bffac582b31ef32bc36411ce29563b4961670c66f9"]
  ] as const)("renders the actual registered %s font and Unicode cmap glyphs", async (fontId, fontSha256) => {
    const fontFile = fileURLToPath(new URL(`../../../bundles/ai-video/library/fonts/${COVER_FONTS[fontId].file}`, import.meta.url));
    const result = await renderLocalCover(base(`font-${fontId}`, { fontId: fontId as CoverFontId, fontFile, fontSha256, title: "酒店服务更从容", subtitle: "DEMO-T001" }));
    expect(result.receipt.font.sha256).toBe(fontSha256);
    expect(result.receipt.font.id).toBe(fontId);
    expect(result.receipt.text.every((line) => line.alphaPixelCount > 0 && line.changedPixelCount > 0)).toBe(true);
  });

  it.each(COVER_PLATFORM_IDS)("fits actual text pixels and distinct styles in %s platform bounds", async (platform) => {
    const spec = getCoverSpec(platform), width = spec.orientation === "horizontal" ? 320 : 180;
    const height = width * spec.canvas.height / spec.canvas.width;
    const rendered = new Set<string>();
    for (const variant of ["warm-film", "punchy-social", "cool-tech"] as const) {
      const result = await renderLocalCover(base(`platform-${platform}-${variant}`, {
        platform, width, height, variant, title: spec.language === "en" ? "HOTEL SERVICE\nMADE SIMPLE" : "让服务更从容", subtitle: "DEMO-T001"
      }));
      rendered.add(result.receipt.output.rgbaSha256);
      expect(result.receipt.text.every((line) => line.bbox.x + line.bbox.width <= result.receipt.recipe.safeBounds.right
        && line.bbox.y + line.bbox.height <= result.receipt.recipe.safeBounds.titleBottom)).toBe(true);
      expect(result.receipt.text.map((line) => line.text).join(" ")).not.toMatch(/warm-film|punchy-social|cool-tech|AI生成/);
    }
    expect(rendered.size).toBe(3);
  }, 30_000);

  it("shrinks an allowed long English title by actual glyph bounds and keeps the copy intact", async () => {
    const title = "WIDE-HOTEL-SERVICE";
    const result = await renderLocalCover(base("fit-long", { title, subtitle: undefined, platform: "tiktok" }));
    expect(result.receipt.text[0]!.text).toBe(title);
    expect(result.receipt.text[0]!.fitAttempts).toBeGreaterThan(1);
    expect(result.receipt.text[0]!.bbox.width).toBeLessThanOrEqual(result.receipt.recipe.safeBounds.right - result.receipt.recipe.safeBounds.left);
  });

  it("renders literal quotes, colon, backslash, dollar and percent without filter/shell expansion", async () => {
    const title = "A:'\\$%{n}";
    const literal = await renderLocalCover(base("literal", { title, platform: "youtube", width: 320, height: 180, subtitle: undefined }));
    const plain = await renderLocalCover(base("literal-control", { title: "A", platform: "youtube", width: 320, height: 180, subtitle: undefined }));
    expect(literal.receipt.text[0]!.text).toBe(title);
    expect(literal.receipt.text[0]!.bbox.width).toBeGreaterThan(plain.receipt.text[0]!.bbox.width);
    expect(literal.receipt.commands.some((command) => command.argv.some((arg) => arg.includes(title)))).toBe(false);
    expect(literal.receipt.output.rgbaSha256).not.toBe(plain.receipt.output.rgbaSha256);
  }, 30_000);
});

describe("local-only cover renderer: input/refusal boundaries", () => {
  it.each(["", " ", "酒店\n", "酒店\n\n服务", "酒店\t服务", "酒店\u0000服务", "酒店\u200B服务", "AI生成", "暖色电影感", "warm-film", "cool-tech", 42, null])("rejects invalid visible title %j before output mutation", async (title) => {
    const options = base(`copy-${sha(String(title)).slice(0, 8)}`, { title: title as string });
    const before = stale(options.out);
    await expect(renderLocalCover(options)).rejects.toMatchObject({ code: "LOCAL_COVER_COPY_INVALID" });
    expect(readFileSync(options.out)).toEqual(before);
  });
  it.each(["双屏\n自助机", "双屏\r自助机", "社媒冲击感", "一".repeat(25), 42])("rejects invalid subtitle %j", async (subtitle) => {
    await expect(renderLocalCover(base("bad-subtitle", { subtitle: subtitle as string }))).rejects.toMatchObject({ code: "LOCAL_COVER_COPY_INVALID" });
  });
  it("preserves creative AI subject copy while rejecting false source and film-duration claims", async () => {
    await expect(renderLocalCover(base("source-claim", { title: "酒店实拍", footageOrigin: "generated" }))).rejects.toMatchObject({ code: "LOCAL_COVER_COPY_INVALID" });
    await expect(renderLocalCover(base("duration-claim", { title: "89秒看懂", durationSeconds: 30 }))).rejects.toMatchObject({ code: "LOCAL_COVER_COPY_INVALID" });
    const actual = await renderLocalCover(base("creative-ai", { title: "AI班组服务酒店", subtitle: "30秒首响", durationSeconds: 89, footageOrigin: "generated" }));
    expect(actual.receipt.text[0]!.text).toBe("AI班组服务酒店");
  });
  it.each([
    { platform: "unknown" }, { platform: "" }, { variant: "unknown" }, { width: 0 }, { height: NaN }, { width: 180.5 }, { width: 5000 }, { width: 320, height: 180 },
    { fontId: "unknown" }, { timeoutMs: 0 }, { timeoutMs: "1000" }, { durationSeconds: 0 }, { durationSeconds: "30" }, { footageOrigin: "unknown" }
  ])("rejects invalid geometry/style/deadline %j", async (patch) => {
    await expect(renderLocalCover(base("bad-geometry", patch as Partial<LocalCoverRenderInput>))).rejects.toMatchObject({ code: "LOCAL_COVER_INPUT_INVALID" });
  });
  it.each([-1, NaN, Infinity, "0", 2, 9])("rejects invalid/out-of-range video frame time %j", async (timeSec) => {
    await expect(renderLocalCover(base("bad-time", { source: { kind: "video-frame", path: video, timeSec: timeSec as number } }))).rejects.toMatchObject({ code: "LOCAL_COVER_SOURCE_INVALID" });
  });
  it("refuses URLs, missing files, directories, symlinks, empty files and corrupt media", async () => {
    const empty = join(directory, "empty.png"), corrupt = join(directory, "corrupt.png"), sym = join(directory, "source-symlink.png");
    writeFileSync(empty, ""); writeFileSync(corrupt, "not an image"); symlinkSync(source, sym);
    for (const path of ["https://example.invalid/private.png", join(directory, "missing.png"), directory, sym, empty]) {
      await expect(renderLocalCover(base("bad-source", { source: { kind: "image", path } }))).rejects.toMatchObject({ code: "LOCAL_COVER_SOURCE_INVALID" });
    }
    await expect(renderLocalCover(base("corrupt-source", { source: { kind: "image", path: corrupt } }))).rejects.toMatchObject({ code: "LOCAL_COVER_PROCESS_FAILED" });
    const parentAlias = join(directory, "symlink-parent"); symlinkSync(directory, parentAlias);
    await expect(renderLocalCover(base("parent-source", { source: { kind: "image", path: join(parentAlias, "source ' : with spaces.png") } }))).rejects.toMatchObject({ code: "LOCAL_COVER_SOURCE_INVALID" });
  });
  it("rejects animated image, excessive decoded pixels and excessive source file bytes", async () => {
    const animation = join(directory, "animated.png"), huge = join(directory, "huge-pixels.png"), sparse = join(directory, "huge-bytes.png");
    execute(["-f", "lavfi", "-i", "testsrc=s=96x96:r=2", "-frames:v", "2", "-f", "apng", "-threads", "1", animation]);
    execute(["-f", "lavfi", "-i", "color=s=5000x4000", "-frames:v", "1", "-threads", "1", huge]);
    writeFileSync(sparse, "x"); truncateSync(sparse, 64 * 1024 * 1024 + 1);
    for (const path of [animation, huge, sparse]) await expect(renderLocalCover(base("bound-source", { source: { kind: "image", path } }))).rejects.toMatchObject({ code: "LOCAL_COVER_SOURCE_INVALID" });
  });
  it("refuses a local playlist's nested HTTP transport before the media process contacts it", async () => {
    const segment = join(directory, "transport-fixture.ts"), manifest = join(directory, "local-playlist.m3u8");
    execute(["-i", video, "-c:v", "copy", "-bsf:v", "h264_mp4toannexb", "-f", "mpegts", segment]);
    let requests = 0;
    const server = createServer((_request, response) => { requests += 1; response.end(readFileSync(segment)); });
    await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture listener");
    writeFileSync(manifest, `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:2.0,\nhttp://127.0.0.1:${address.port}/segment.ts\n#EXT-X-ENDLIST\n`);
    let rejected = false;
    try { await renderLocalCover(base("nested-http", { source: { kind: "video-frame", path: manifest, timeSec: 0.5 } })); }
    catch { rejected = true; }
    finally { await new Promise<void>((accept, reject) => server.close((error) => error ? reject(error) : accept())); }
    expect(requests).toBe(0);
    expect(rejected).toBe(true);
    expectNoScratch();
  }, 20_000);
  it("refuses source/font hardlink and symlink output aliases, wrong extensions and directory targets", async () => {
    const sourceHard = join(directory, "source-hard.png"), fontHard = join(directory, "font-hard.png"), sym = join(directory, "output-sym.png"), folder = join(directory, "folder.png");
    // The repository and tmpdir can be separate CI mounts. Keep the real font
    // input and its hardlink on the fixture filesystem without changing its pin.
    const localFont = join(directory, "font-hardlink-input.otf");
    writeFileSync(localFont, readFileSync(FONT));
    expect(sha(readFileSync(localFont))).toBe(FONT_SHA);
    linkSync(source, sourceHard); linkSync(localFont, fontHard); symlinkSync(source, sym); mkdirSync(folder);
    expect(lstatSync(fontHard).dev).toBe(lstatSync(localFont).dev);
    expect(lstatSync(fontHard).ino).toBe(lstatSync(localFont).ino);
    expect(lstatSync(localFont).nlink).toBeGreaterThanOrEqual(2);
    for (const out of [source, sourceHard, fontHard, sym, folder, "relative.png", join(directory, "wrong.jpg")]) await expect(renderLocalCover(base("bad-target", { out, fontFile: localFont }))).rejects.toMatchObject({ code: "LOCAL_COVER_OUTPUT_INVALID" });
    expect(sha(readFileSync(localFont))).toBe(FONT_SHA);
    expect(sha(readFileSync(fontHard))).toBe(FONT_SHA);
    const parentAlias = join(directory, "output-parent-sym"); symlinkSync(directory, parentAlias);
    await expect(renderLocalCover(base("bad-parent", { out: join(parentAlias, "new-output.png") }))).rejects.toMatchObject({ code: "LOCAL_COVER_OUTPUT_INVALID" });
    await expect(renderLocalCover(base("bad-new-parent", { out: join(parentAlias, "must-not-create", "new-output.png") }))).rejects.toMatchObject({ code: "LOCAL_COVER_OUTPUT_INVALID" });
    expect(existsSync(join(directory, "must-not-create"))).toBe(false);
  });
  it("refuses missing/symlink/wrong-pin/corrupt fonts and unsupported or missing Unicode glyphs", async () => {
    const sym = join(directory, "font-sym.otf"), corrupt = join(directory, "font-bad.otf"), unsupported = join(directory, "font-unsupported.otf");
    symlinkSync(FONT, sym); writeFileSync(corrupt, "bad font");
    for (const patch of [{ fontFile: join(directory, "missing.otf") }, { fontFile: sym }, { fontSha256: "f".repeat(64) }, { fontSha256: "invalid" }, { fontFile: corrupt, fontSha256: sha(readFileSync(corrupt)) }]) {
      await expect(renderLocalCover(base("bad-font", patch))).rejects.toMatchObject({ code: "LOCAL_COVER_FONT_INVALID" });
    }
    const mutated = Buffer.from(readFileSync(FONT));
    for (let index = 0; index < mutated.readUInt16BE(4); index += 1) {
      const at = 12 + index * 16;
      if (mutated.toString("ascii", at, at + 4) === "cmap") {
        const table = mutated.readUInt32BE(at + 8), entries = mutated.readUInt16BE(table + 2);
        for (let sub = 0; sub < entries; sub += 1) { const entry = table + 4 + sub * 8; mutated.writeUInt16BE(1, entry); }
      }
    }
    writeFileSync(unsupported, mutated);
    await expect(renderLocalCover(base("unsupported-cmap", { fontFile: unsupported, fontSha256: sha(mutated) }))).rejects.toMatchObject({ code: "LOCAL_COVER_FONT_INVALID" });
    await expect(renderLocalCover(base("missing-glyph", { title: "缺" + String.fromCodePoint(0x10fffd) }))).rejects.toMatchObject({ code: "LOCAL_COVER_FONT_GLYPH_MISSING" });
  });
  it("rejects text which cannot fit instead of clipping at the minimum size", async () => {
    const options = base("cannot-fit", { title: "W".repeat(128), subtitle: undefined, platform: "tiktok" });
    const before = stale(options.out);
    await expect(renderLocalCover(options)).rejects.toMatchObject({ code: "LOCAL_COVER_TEXT_FIT_FAILED" });
    expect(readFileSync(options.out)).toEqual(before);
  });
});

describe("local-only cover renderer: process and concurrent publication", () => {
  it.each(["failure", "timeout", "corrupt", "wrong-size", "empty-text", "no-op"])("preserves a prior output on %s encoder behavior", async (kind) => {
    const options = base(`process-${kind}`), before = stale(options.out);
    const body = {
      failure: "process.stderr.write('fixture encoder failure');process.exit(7);",
      timeout: "setTimeout(()=>{},5000);return;",
      corrupt: "if(last==='cover.png'){fs.writeFileSync(last,'invalid PNG');process.exit(0);}",
      "wrong-size": `if(last==='cover.png'){const r=cp.spawnSync(${JSON.stringify(FFMPEG)},['-v','error','-y','-i','background.png','-vf','scale=90:160','-frames:v','1','-threads','1',last],{stdio:'inherit'});process.exit(r.status??8);}`,
      "empty-text": "const vf=args.indexOf('-vf');if(vf>=0&&args[vf+1].includes('drawtext=')){args.splice(vf,2);}",
      "no-op": "if(last==='cover.png'){fs.copyFileSync('background.png',last);process.exit(0);}"
    }[kind]!;
    options.ffmpeg = wrapper(`encoder-${kind}`, body);
    if (kind === "timeout") options.timeoutMs = 800;
    await expect(renderLocalCover(options)).rejects.toMatchObject({ code: ["empty-text", "no-op", "wrong-size", "corrupt"].includes(kind) ? "LOCAL_COVER_VERIFY_FAILED" : "LOCAL_COVER_PROCESS_FAILED" });
    expect(readFileSync(options.out)).toEqual(before);
    expectNoScratch();
  }, 15_000);
  it.each(["source", "font", "binary"])("rejects %s byte changes during rendering before publication", async (kind) => {
    const mutableSource = join(directory, `mutable-${kind}.png`), mutableFont = join(directory, `mutable-${kind}.otf`);
    writeFileSync(mutableSource, readFileSync(source)); writeFileSync(mutableFont, readFileSync(FONT));
    const options = base(`change-${kind}`, { source: { kind: "image", path: mutableSource }, fontFile: mutableFont });
    const before = stale(options.out);
    const changed = kind === "source" ? mutableSource : kind === "font" ? mutableFont : undefined;
    options.ffmpeg = wrapper(`mutator-${kind}`, `if(last==='cover.png')fs.appendFileSync(${changed ? JSON.stringify(changed) : "__filename"},${JSON.stringify(kind === "binary" ? "\n// fixture change\n" : "fixture change")});`);
    await expect(renderLocalCover(options)).rejects.toMatchObject({ code: "LOCAL_COVER_INPUT_CHANGED" });
    expect(readFileSync(options.out)).toEqual(before);
    expectNoScratch();
  });
  it("refuses a competing lock without deleting it or changing the old output", async () => {
    const options = base("busy"), before = stale(options.out), lock = `${options.out}.local-cover.lock`;
    writeFileSync(lock, "other writer");
    await expect(renderLocalCover(options)).rejects.toMatchObject({ code: "LOCAL_COVER_OUTPUT_BUSY" });
    expect(readFileSync(options.out)).toEqual(before);
    expect(readFileSync(lock, "utf8")).toBe("other writer");
    rmSync(lock);
  });
  it("serializes simultaneous writers with exactly one valid publication", async () => {
    const options = base("simultaneous");
    const results = await Promise.allSettled([renderLocalCover(options), renderLocalCover(options)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason).toMatchObject({ code: "LOCAL_COVER_OUTPUT_BUSY" });
    expectNoScratch();
  });
  it("preserves another writer's changed output and refuses a stale publication snapshot", async () => {
    const options = base("output-race"); stale(options.out);
    options.ffmpeg = wrapper("output-mutator", `if(last==='cover.png')fs.writeFileSync(${JSON.stringify(options.out)},'other current output');`);
    await expect(renderLocalCover(options)).rejects.toMatchObject({ code: "LOCAL_COVER_OUTPUT_CHANGED" });
    expect(readFileSync(options.out, "utf8")).toBe("other current output");
    expectNoScratch();
  });
  it("does not erase a replaced writer lock when refusing output publication", async () => {
    const options = base("lock-race"), before = stale(options.out), lock = `${options.out}.local-cover.lock`;
    options.ffmpeg = wrapper("lock-mutator", `if(last==='cover.png'){fs.unlinkSync(${JSON.stringify(lock)});fs.writeFileSync(${JSON.stringify(lock)},'other replacement lock');}`);
    await expect(renderLocalCover(options)).rejects.toMatchObject({ code: "LOCAL_COVER_OUTPUT_CHANGED" });
    expect(readFileSync(options.out)).toEqual(before);
    expect(readFileSync(lock, "utf8")).toBe("other replacement lock");
    rmSync(lock);
    expectNoScratch();
  });
});
