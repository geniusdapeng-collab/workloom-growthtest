/** Real offline processing regressions for default rendered-source acceptance. */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  best, callTool, exportSidecars, parseSrt, plan, renderDanmaku, renderKaraoke,
  renderSticker, renderTitle, renderWithSubtitles, softMux,
} from "./core.mjs";
import { resolveBinaries } from "./measure.mjs";

const actualBins = resolveBinaries();
const hasMedia = [actualBins.ffmpeg, actualBins.ffprobe]
  .every((bin) => spawnSync(bin, ["-version"], { stdio: "ignore" }).status === 0);
const mediaSuite = hasMedia ? describe : describe.skip;
const sha = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const cues = parseSrt("1\n00:00:00,100 --> 00:00:01,100\n测试\n");
let root = "", source = "", silent = "", srt = "", trace = "", initialHash = "";
let bins: { ffmpeg: string; ffprobe: string };
const brief = { 语言: "zh", 平台: "默认" };
const traces = () => fs.existsSync(trace)
  ? fs.readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[])
  : [];
const decode = (file: string) => execFileSync(actualBins.ffmpeg,
  ["-v", "error", "-i", file, "-map", "0:v:0", "-f", "null", "-"], { stdio: "pipe", timeout: 30000 });

mediaSuite("subtitle production uses one real transform without source quality review", () => {
  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "subtitle-rendered-")));
    source = path.join(root, "黑片 连续原声.mp4");
    silent = path.join(root, "无音轨 奇数帧率.mp4");
    srt = path.join(root, "字幕.srt");
    trace = path.join(root, "ffmpeg-argv.jsonl");
    const encode = (args: string[]) => execFileSync(actualBins.ffmpeg,
      ["-hide_banner", "-v", "error", "-n", ...args], { stdio: "pipe", timeout: 30000 });
    encode(["-f", "lavfi", "-i", "color=c=black:s=640x360:r=24000/1001:d=1.25",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1.25", "-map", "0:v", "-map", "1:a",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source]);
    encode(["-f", "lavfi", "-i", "color=c=black:s=640x360:r=17:d=1.617",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", silent]);
    fs.writeFileSync(srt, "1\n00:00:00,100 --> 00:00:01,100\n测试\n");
    initialHash = sha(source);
    const proxy = path.join(root, "ffmpeg-proxy.mjs");
    fs.writeFileSync(proxy, `#!${process.execPath}\nimport fs from 'node:fs';\nimport { spawnSync } from 'node:child_process';\nconst argv = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify(argv) + '\\n');\nconst result = spawnSync(${JSON.stringify(actualBins.ffmpeg)}, argv, { stdio: 'inherit' });\nif (result.error) { process.stderr.write(String(result.error)); process.exit(70); }\nprocess.exit(result.status ?? 71);\n`);
    fs.chmodSync(proxy, 0o755);
    bins = { ffmpeg: proxy, ffprobe: actualBins.ffprobe };
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("default plan and sidecars keep source bytes and never run source-frame diagnosis", async () => {
    const planned = await plan({ input: source, cues, brief, bins, outputDir: path.join(root, "plan") });
    expect(planned.diagnosis).toBeNull();
    const sidecars = await exportSidecars({ input: source, outputDir: path.join(root, "sidecars"), name: "film", cues, brief, bins });
    expect(sidecars.passed).toBe(true);
    expect(sidecars.manifest.source.untouched).toBe(true);
    expect(sidecars.manifest.source.sha256).toBe(initialHash);
    expect(sha(source)).toBe(initialHash);
    const sourceCommands = traces().filter((argv) => argv.includes(source));
    expect(sourceCommands).toEqual([]);
  }, 30000);

  it("burn accepts black continuous-audio source without a presence threshold or legacy review toggle", async () => {
    const output = path.join(root, "burn.mp4");
    const before = traces().length;
    const report = await renderWithSubtitles({ input: source, output, cues, brief, bins, skipVerify: true, presenceMinDelta: 99 });
    expect(report.qualityReviewed).toBe(false);
    expect(report.qualityScore).toBeNull();
    expect(report.presence).toMatchObject({ reviewed: false, delta: null, ok: null });
    expect(report.checks).not.toHaveProperty("presence_ok");
    expect(report.evidence).toEqual([]);
    expect(report.timeline.ok).toBe(true);
    expect(report.fontResolution.allFromFontsDir).toBe(true);
    expect(report.output.hash).toBe(sha(output));
    expect(traces().slice(before).filter((argv) => argv.includes(source))).toHaveLength(1);
    decode(output);
    expect(sha(source)).toBe(initialHash);
  }, 30000);

  it("subtitles and danmaku share one ASS and one medium/CRF16 encode", async () => {
    const output = path.join(root, "combined-text.mp4");
    const before = traces().length;
    const report = await renderWithSubtitles({
      input: source,
      output,
      cues,
      danmakuItems: [
        { at: 0.1, text: "弹幕合并", mode: "top" },
        { at: 0.2, text: "只编码一次", mode: "scroll" },
      ],
      brief,
      bins,
    });
    expect(report.mode).toBe("subtitle+danmaku");
    expect(report.pipeline).toMatchObject({
      textLayers: ["subtitles", "danmaku"],
      textEncodingPasses: 1,
      sourceEncodingPolicy: "single-pass-combined-ass",
    });
    expect(report.danmaku.timeline).toMatchObject({ ok: true, events: 2, sourceEvents: 2 });
    expect(report.checks.danmaku_timeline_ok).toBe(true);
    expect(report.output.hash).toBe(sha(output));
    const commands = traces().slice(before).filter((argv) => argv.includes(source));
    expect(commands).toHaveLength(1);
    expect(commands[0]).toEqual(expect.arrayContaining(["-preset", "medium", "-crf", "16"]));
    const ass = fs.readFileSync(report.assPath, "utf8");
    expect(ass).toContain("测试");
    expect(ass).toContain("弹幕合并");
    expect(ass.split("\n").filter((line) => line.startsWith("Dialogue:"))).toHaveLength(3);
    decode(output);
    expect(sha(source)).toBe(initialHash);
  }, 30000);

  it.each(["core", "tool", "cli"])("%s burn retains the full requested long cue when layout advice fails", async (entry) => {
    const text = "成功原片的完整用户文字不因建议行宽被删减".repeat(4);
    const longSrt = `1\n00:00:00,100 --> 00:00:01,100\n${text}\n`;
    const output = path.join(root, `long-${entry}.mp4`);
    const before = traces().length;
    let report: any;
    if (entry === "core") {
      report = await renderWithSubtitles({ input: silent, output, cues: parseSrt(longSrt), brief, bins });
    } else if (entry === "tool") {
      const outcome = await callTool("subtitlewrite.burn", { input_path: silent, output_path: output, srt_text: longSrt },
        { env: { ...process.env, WORKLOOM_SUBTITLE_ALLOWED_ROOTS: root }, bins });
      report = outcome.result;
      expect(outcome.receipt.sha256).toBe(sha(output));
    } else {
      const file = path.join(root, "long-cli.srt"); fs.writeFileSync(file, longSrt);
      const result = spawnSync(process.execPath, [fileURLToPath(new URL("./cli.mjs", import.meta.url)), "burn",
        "--in", silent, "--out", output, "--srt", file], {
        env: { ...process.env, WORKLOOM_SUBTITLE_FFMPEG_PATH: bins.ffmpeg, WORKLOOM_SUBTITLE_FFPROBE_PATH: bins.ffprobe },
        encoding: "utf8", timeout: 30000,
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("1/1 条（一致）");
      expect(result.stdout).toContain("line_width=fail");
      expect(result.stdout).toContain(sha(output));
    }
    const commands = traces().slice(before).filter((argv) => argv.includes(silent));
    expect(commands).toHaveLength(1);
    const filter = commands[0][commands[0].indexOf("-vf") + 1];
    const assPath = /^ass='([^']+)':fontsdir=/.exec(filter)?.[1];
    expect(assPath).toBeTruthy();
    expect(fs.readFileSync(assPath!, "utf8")).toContain(text);
    if (report) {
      expect(report.checks.layout_ok).toBe(false);
      expect(report.layoutChecks.find((check: any) => check.kind === "line_width")).toMatchObject({ ok: false, hard: false });
      expect(report.timeline.ok).toBe(true);
      expect(report.fontResolution.allFromFontsDir).toBe(true);
      expect(report.qualityReviewed).toBe(false);
      expect(report.output.hash).toBe(sha(output));
    }
    decode(output);
    expect(sha(source)).toBe(initialHash);
  }, 30000);

  it("best ignores quality score thresholds and performs one deterministic real encode", async () => {
    const before = traces().length;
    const output = path.join(root, "best.mp4");
    const result = await best({ input: silent, output, cues, brief, bins, minScore: 10000 });
    expect(result.verdict).toBe("rendered");
    expect(result.qualityReviewed).toBe(false);
    expect(result.winner.score).toBeNull();
    expect(result.minScore).toBeNull();
    expect(result.report.checks.audio_preserved).toBe(true);
    expect(result.sha256).toBe(sha(output));
    expect(traces().slice(before).filter((argv) => argv.includes(silent))).toHaveLength(1);
    decode(output);
  }, 30000);

  it("title, danmaku, sticker and karaoke encode requested ASS events without source-frame samples", async () => {
    const before = traces().length;
    const title = await renderTitle({ input: silent, output: path.join(root, "title.mp4"), titleText: "标题", titleDurationSec: 1, brief, bins });
    const danmaku = await renderDanmaku({ input: silent, output: path.join(root, "danmaku.mp4"), items: [{ at: 0.1, text: "弹幕" }], brief, bins });
    const sticker = await renderSticker({ input: silent, output: path.join(root, "sticker.mp4"), stickers: [{ text: "贴纸", start: 0, end: 1.5, x: 0.5, y: 0.5 }], brief, bins });
    const karaoke = await renderKaraoke({ input: silent, output: path.join(root, "karaoke.mp4"), cues, brief, bins });
    for (const report of [title, danmaku, sticker, karaoke]) {
      expect(report.presence.reviewed).toBe(false);
      expect(report.evidence).toEqual([]);
      expect(report.checks).not.toHaveProperty("presence_ok");
      expect(report.output.hash).toBe(sha(report.output.path));
      decode(report.output.path);
    }
    const commands = traces().slice(before).filter((argv) => argv.includes(silent));
    expect(commands).toHaveLength(4);
    expect(commands.every((argv) => !argv.includes("-frames:v"))).toBe(true);
  }, 60000);

  it("softmux keeps complete encoded video/audio packet hashes and accepts verify=false", async () => {
    const result = await softMux({ input: source, output: path.join(root, "soft.mp4"), subtitles: [{ path: srt, lang: "chi" }], bins, verify: false });
    expect(result.checks.every((check: { ok: boolean }) => check.ok)).toBe(true);
    const video = result.checks.find((check: { kind: string }) => check.kind === "video_unchanged");
    expect(video.detail.before.packetSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(video.detail.after.packetSha256).toBe(video.detail.before.packetSha256);
    expect(video.detail.before.frames).toEqual([]);
    expect(sha(source)).toBe(initialHash);
  }, 30000);

  it("default danmaku preserves a long cue and all nine simultaneous entries in core, tool and actual CLI", async () => {
    const longText = "成功渲染后的完整用户文字不因默认二十字上限而被删减或拒收";
    const items = Array.from({ length: 9 }, (_, index) => ({ at: 0.1, text: index === 0 ? longText : `完整条目${index}` }));
    const expected = (report: any) => {
      expect(report.maxChars).toBeNull();
      expect(report.density).toMatchObject({ total: 9, kept: 9, trimmed: 0, maxConcurrent: null, requested: false });
      expect(report.tracks.map((item: any) => item.text)).toEqual(items.map((item) => item.text));
      expect(fs.readFileSync(report.assPath, "utf8")).toContain(longText);
      expect(report.output.hash).toBe(sha(report.output.path));
    };
    expected(await renderDanmaku({ input: silent, output: path.join(root, "dense-core.mp4"), items, brief, bins }));
    const outcome = await callTool("subtitlewrite.danmaku", { input_path: silent, output_path: path.join(root, "dense-tool.mp4"), items },
      { env: { ...process.env, WORKLOOM_SUBTITLE_ALLOWED_ROOTS: root }, bins });
    expected(outcome.result);
    const input = path.join(root, "nine-items.json"); fs.writeFileSync(input, JSON.stringify(items));
    const evidence = path.join(root, "dense-cli-evidence");
    const cli = spawnSync(process.execPath, [fileURLToPath(new URL("./cli.mjs", import.meta.url)), "danmaku", "--in", silent,
      "--out", path.join(root, "dense-cli.mp4"), "--items", input, "--evidence-dir", evidence], {
      env: { ...process.env, WORKLOOM_SUBTITLE_FFMPEG_PATH: bins.ffmpeg, WORKLOOM_SUBTITLE_FFPROBE_PATH: bins.ffprobe },
      encoding: "utf8", timeout: 30000,
    });
    expect(cli.status, cli.stdout + cli.stderr).toBe(0);
    expect(cli.stdout).toContain("9/9"); expect(cli.stdout).toContain("未请求限制");
    const ass = fs.readFileSync(path.join(evidence, "danmaku-plan.ass"), "utf8");
    expect(ass).toContain(longText);
    expect(ass.split("\n").filter((line) => line.startsWith("Dialogue:"))).toHaveLength(9);
    expect(sha(source)).toBe(initialHash);
  }, 60000);

  it("explicit danmaku limits remain real request constraints and malformed limits fail before encoding", async () => {
    const items = Array.from({ length: 9 }, (_, index) => ({ at: 0.1, text: `条目${index}` }));
    const result = await renderDanmaku({ input: silent, output: path.join(root, "explicit-cap.mp4"), items, maxConcurrent: 8, brief, bins });
    expect(result.density).toMatchObject({ total: 9, kept: 8, trimmed: 1, maxConcurrent: 8, requested: true });
    expect(result.checks.density_within_cap).toBe(true);
    for (const params of [{ max_chars: 0 }, { max_chars: true }, { max_concurrent: false }, { max_concurrent: "invalid" }, { items: {} }]) {
      const before = traces().length;
      await expect(callTool("subtitlewrite.danmaku", { input_path: silent, output_path: path.join(root, "bad-limit.mp4"), items, ...params },
        { env: { ...process.env, WORKLOOM_SUBTITLE_ALLOWED_ROOTS: root }, bins })).rejects.toThrow();
      expect(traces().length).toBe(before);
    }
    const input = path.join(root, "limit-items.json"); fs.writeFileSync(input, JSON.stringify(items));
    const before = traces().length;
    const resultCli = spawnSync(process.execPath, [fileURLToPath(new URL("./cli.mjs", import.meta.url)), "danmaku", "--in", silent,
      "--out", path.join(root, "bad-cli-limit.mp4"), "--items", input, "--max-concurrent", "invalid"], {
      env: { ...process.env, WORKLOOM_SUBTITLE_FFMPEG_PATH: bins.ffmpeg, WORKLOOM_SUBTITLE_FFPROBE_PATH: bins.ffprobe }, encoding: "utf8", timeout: 30000 });
    expect(resultCli.status).not.toBe(0); expect(resultCli.stderr).toContain("bad_request");
    expect(traces().length).toBe(before);
  }, 30000);

  it("actual CLI sidecar and best use production defaults and return real files", () => {
    const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));
    const env = { ...process.env, WORKLOOM_SUBTITLE_FFMPEG_PATH: bins.ffmpeg, WORKLOOM_SUBTITLE_FFPROBE_PATH: bins.ffprobe };
    for (const args of [
      ["sidecar", "--in", source, "--srt", srt, "--out-dir", path.join(root, "cli-sidecar")],
      ["best", "--in", source, "--srt", srt, "--out", path.join(root, "cli-best.mp4"), "--min-score", "10000"],
    ]) {
      const result = spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8", timeout: 30000 });
      expect(result.status, result.stdout + result.stderr).toBe(0);
    }
    expect(sha(source)).toBe(initialHash);
  }, 60000);

  it("tool path retains allowed-root authority and cannot disable technical processing checks", async () => {
    const env = { ...process.env, WORKLOOM_SUBTITLE_ALLOWED_ROOTS: root };
    const outcome = await callTool("subtitlewrite.burn", { input_path: source, output_path: path.join(root, "tool.mp4"), srt_path: srt, verify: false, tenant_id: "owner" }, { env, bins });
    expect(outcome.receipt.synced).toBe(true);
    expect(outcome.receipt.sha256).toBe(sha(outcome.result.output_path));
    await expect(callTool("subtitlewrite.burn", { input_path: path.resolve(root, "..", "outside.mp4"), output_path: path.join(root, "outside-output.mp4"), srt_path: srt }, { env, bins })).rejects.toMatchObject({ code: "path_not_allowed" });
  }, 30000);

  it("real HTTP boundary rejects invalid credentials and tenant before any media work", async () => {
    const allocator = http.createServer();
    await new Promise<void>((resolve, reject) => {
      allocator.once("error", reject);
      allocator.listen(0, "127.0.0.1", resolve);
    });
    const address = allocator.address();
    if (!address || typeof address === "string") throw new Error("fixture port was not allocated");
    const port = address.port;
    await new Promise<void>((resolve, reject) => allocator.close((error) => error ? reject(error) : resolve()));
    const server = fileURLToPath(new URL("./server.mjs", import.meta.url));
    const child = spawn(process.execPath, [server], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, WORKLOOM_SUBTITLE_BRIDGE_PORT: String(port), WORKLOOM_SUBTITLE_BRIDGE_HOST: "127.0.0.1",
        WORKLOOM_SUBTITLE_BRIDGE_TOKEN: "test-only-token", WORKLOOM_SUBTITLE_BRIDGE_TENANT: "owner",
        WORKLOOM_SUBTITLE_ALLOWED_ROOTS: root, WORKLOOM_SUBTITLE_JOBS_DIR: path.join(root, "http-jobs"),
        WORKLOOM_SUBTITLE_FFMPEG_PATH: bins.ffmpeg, WORKLOOM_SUBTITLE_FFPROBE_PATH: bins.ffprobe },
    });
    let diagnostics = "";
    child.stderr.on("data", (chunk) => { diagnostics += String(chunk); });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("HTTP bridge startup timed out: " + diagnostics)), 3000);
        child.once("error", (error) => { clearTimeout(timer); reject(error); });
        child.once("exit", (code) => { clearTimeout(timer); reject(new Error("HTTP bridge exited " + code + ": " + diagnostics)); });
        child.stdout.on("data", (chunk) => {
          if (String(chunk).includes("listening on")) { clearTimeout(timer); resolve(); }
        });
      });
      const request = (tenant: string, token: string, name: string) => fetch(`http://127.0.0.1:${port}/action`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ tool: "subtitlewrite.burn", params: { input_path: source, output_path: path.join(root, name), srt_path: srt, verify: false, tenant_id: tenant } }),
      });
      const before = traces().length;
      expect((await request("owner", "test-wrong-token", "invalid-auth.mp4")).status).toBe(401);
      expect((await request("other", "test-only-token", "invalid-tenant.mp4")).status).toBe(403);
      expect(traces().length).toBe(before);
      expect(fs.existsSync(path.join(root, "invalid-auth.mp4"))).toBe(false);
      expect(fs.existsSync(path.join(root, "invalid-tenant.mp4"))).toBe(false);
      const response = await request("owner", "test-only-token", "http-valid.mp4");
      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload.ok).toBe(true);
      expect(payload.receipt.sha256).toBe(sha(payload.result.output_path));
    } finally {
      child.kill("SIGTERM");
      if (child.exitCode === null) await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
  }, 30000);

  it("missing, corrupt, overwritten and unavailable-font inputs fail without a quality retry", async () => {
    const corrupt = path.join(root, "corrupt.mp4"); fs.writeFileSync(corrupt, "not media");
    const noFonts = path.join(root, "no-fonts"); fs.mkdirSync(noFonts);
    for (const changed of [{ input: source + ".missing" }, { input: corrupt }, { output: source }, { fontsDir: noFonts }]) {
      const before = traces().length;
      await expect(renderWithSubtitles({ input: source, output: path.join(root, "failed.mp4"), cues, brief, bins, ...changed })).rejects.toThrow();
      expect(traces().length).toBe(before);
    }
    expect(sha(source)).toBe(initialHash);
  }, 30000);
});
