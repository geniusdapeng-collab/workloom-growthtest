/**
 * 字幕标点口径回归（2026-09-25 产品所有者口径：正规字幕不带标点）
 *
 * 事故：成片字幕把台词里的逗号/句号原样打在画面上（「南昌滕王阁，江南名楼之首」），
 * 与平台头部账号的版面口径不符。这里把"去标点"钉在**入站口**（parseSrt），
 * 因此四条出口（旁挂 srt/vtt/ass、烧录、软轨）自动一致。
 *
 * 同时钉住三条不许误伤的细则：数字分隔符保留、纯西文不强制、整行只剩标点时不产出空字幕。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findSubtitlePunctuation,
  isCjkText,
  parseSrt,
  stripSubtitlePunctuation,
  cuesToSrt, callTool, plan
} from "./core.mjs";

const cue = (text: string, start = "0:00:00.00", end = "0:00:05.00") => [{ start, end, text }];
const srtOf = (text: string): string => `1\n00:00:00,000 --> 00:00:05,000\n${text}\n`;

describe("字幕去标点", () => {
  it("中文台词里的标点全部去掉（逗号/句号/顿号/引号/书名号/省略号/破折号）", () => {
    expect(stripSubtitlePunctuation("南昌滕王阁，江南名楼之首。")).toBe("南昌滕王阁江南名楼之首");
    expect(stripSubtitlePunctuation("落霞与孤鹜齐飞、秋水共长天一色……")).toBe("落霞与孤鹜齐飞秋水共长天一色");
    expect(stripSubtitlePunctuation("「滕王阁」——江南三大名楼之一！")).toBe("滕王阁江南三大名楼之一");
    expect(stripSubtitlePunctuation("《滕王阁序》火了 1300 年")).toBe("滕王阁序火了 1300 年");
  });

  it("数字里的分隔符保留：小数、时间、日期、比例、区间都不动", () => {
    expect(stripSubtitlePunctuation("语速 3.5 字/秒，9:16 竖屏")).toBe("语速 3.5 字/秒9:16 竖屏");
    expect(stripSubtitlePunctuation("2026-09-25 首发")).toBe("2026-09-25 首发");
    expect(stripSubtitlePunctuation("门票 50-80 元")).toBe("门票 50-80 元");
  });

  it("纯西文字幕不强制去标点（英文句读是阅读标准）", () => {
    const english = "Hello, welcome to Tengwang Pavilion.";
    expect(isCjkText(english)).toBe(false);
    expect(stripSubtitlePunctuation(english)).toBe(english);
    expect(findSubtitlePunctuation(english)).toEqual([]);
  });

  it("整行只剩标点时不产出空字幕（退回原文）", () => {
    expect(stripSubtitlePunctuation("……")).toBe("……");
  });

  it("多行（\\N）逐行去标点，行结构保留", () => {
    expect(stripSubtitlePunctuation("落霞与孤鹜齐飞，\\N秋水共长天一色。")).toBe("落霞与孤鹜齐飞\\N秋水共长天一色");
  });

  it("findSubtitlePunctuation 与去标点同一套规则（查得到=清得掉）", () => {
    expect(findSubtitlePunctuation("南昌滕王阁，江南名楼之首。")).toEqual(["，", "。"]);
    expect(findSubtitlePunctuation("语速 3.5 字/秒")).toEqual([]);
    expect(findSubtitlePunctuation("干净的一句字幕")).toEqual([]);
  });
});

describe("parseSrt 入口接管去标点", () => {
  it("从 SRT 读进来的 cues 已经没有标点（四条出口同源）", () => {
    const cues = parseSrt(srtOf("南昌滕王阁，江南名楼之首。"));
    expect(cues[0].text).toBe("南昌滕王阁江南名楼之首");
  });

  it("导出的 SRT 同样干净（不会出现画面干净、文件带标点）", () => {
    const out = cuesToSrt(cue("今晚的滕王阁，赣江边最亮的楼。"));
    expect(out).toContain("今晚的滕王阁赣江边最亮的楼");
    expect(out).not.toContain("，");
  });

  it("非法块仍然显式失败（不因为去标点而静默吞条）", () => {
    expect(() => parseSrt("1\n00:00:00,000 --> 00:00:05,000\n……\n")).not.toThrow();
    expect(() => parseSrt("1\n没有时间轴\n随便一句\n")).toThrow();
  });
});


/** These actual FFmpeg regressions run in the existing test:scripts entry, not a detached fixture-only suite. */
describe("成功镜头的字幕默认实际处理", () => {
  let dir: string;
  let source: string;
  let originalHash: string;
  let bins: { ffmpeg: string; ffprobe: string };
  let log: string;
  const fileHash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
  const cuesText = "1\n00:00:00,100 --> 00:00:01,300\n这句很长的中文字幕按原请求完整输出不因安全区像素与可现度投票失败\n";
  const env = () => ({ ...process.env, WORKLOOM_SUBTITLE_ALLOWED_ROOTS: dir });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "subtitle-default-processing-"));
    source = join(dir, "black-no-audio.mp4");
    const generated = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "color=black:s=320x240:r=24:d=2", "-an", "-c:v", "libx264", "-threads", "1", source], { encoding: "utf8" });
    expect(generated.status, generated.stderr).toBe(0);
    originalHash = fileHash(source);
    log = join(dir, "actual-commands.jsonl");
    const wrapper = (name: "ffmpeg" | "ffprobe") => {
      const file = join(dir, `${name}-default-only`);
      writeFileSync(file, `#!${process.execPath}\nimport { spawnSync } from 'node:child_process';\nimport fs from 'node:fs';\nconst args = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({bin:${JSON.stringify(name)},args})+'\\n');\nif(args.some(arg=>/signalstats|edgedetect|bbox=|framemd5|silencedetect|ebur128|astats/.test(arg)) || args.includes('-frames:v') || args.includes('-count_frames') || args.includes('-xerror')) {process.stderr.write('forbidden default quality analysis');process.exit(87);}\nconst result=spawnSync(${JSON.stringify(name)},args,{stdio:'inherit'});\nif(result.error) {process.stderr.write(result.error.message);process.exit(86);}\nprocess.exit(result.status??85);\n`);
      chmodSync(file, 0o755);
      return file;
    };
    bins = { ffmpeg: wrapper("ffmpeg"), ffprobe: wrapper("ffprobe") };
  });
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("默认 plan 不抽帧、不渲染墨迹样本；版式诊断没有被伪报通过", async () => {
    const result = await plan({ input: source, cues: parseSrt(cuesText), scenes: ["字幕"], bins, outputDir: join(dir, "plan") });
    expect(result.diagnosis).toBeNull();
    expect(result.checks.some((entry: { kind: string }) => entry.kind === "ink_extent")).toBe(false);
    expect(fileHash(source)).toBe(originalHash);
  });

  it.each([
    ["subtitlewrite.burn", { srt_text: cuesText }],
    ["subtitlewrite.title", { title_text: "字幕标题测试" }],
    ["subtitlewrite.danmaku", { items: Array.from({ length: 12 }, (_, index) => ({ at: .1 + index * .005, text: `这是长度超出旧二十字门槛但必须保持完整的测试弹幕第${index}条` })) }],
    ["subtitlewrite.sticker", { stickers: [{ text: "指定位置", start: .1, end: .5, x: .96, y: .96 }] }],
    ["subtitlewrite.karaoke", { srt_text: "1\n00:00:00,100 --> 00:00:01,300\n测试字幕\n" }],
    ["subtitlewrite.best", { srt_text: cuesText, min_score: 99999, candidates: 20 }],
  ])("%s 真实处理黑片无音轨，旧质量开关不挡默认路径", async (tool, options) => {
    const output = join(dir, `${tool.split(".")[1]}.mp4`);
    const outcome = await callTool(tool as string, { input_path: source, output_path: output, ...options,
      skip_verify: true, verify: false, ignore_safe_area: true, allow_ui_overlap: true }, { bins, env: env() });
    expect(outcome.receipt.synced).toBe(true);
    expect(existsSync(output)).toBe(true);
    expect(fileHash(output)).toBe(outcome.receipt.sha256);
    expect(fileHash(source)).toBe(originalHash);
    const result = outcome.result.report ?? outcome.result;
    expect(result.qualityReviewed).toBe(false);
    expect(result.presence.delta).toBeNull();
    expect(result.evidence).toEqual([]);
    if (tool === "subtitlewrite.danmaku") {
      expect(result.density.kept).toBe(12);
      expect(result.density.trimmed).toBe(0);
    }
    if (tool === "subtitlewrite.best") {
      expect(outcome.result.candidates).toEqual([]);
      expect(outcome.result.winner.score).toBeNull();
    }
  }, 30_000);

  it("sidecar + softmux 真正写全部文件和字幕轨，无质量抽帧", async () => {
    const sidecar = await callTool("subtitlewrite.sidecar", { input_path: source, output_dir: join(dir, "sidecars"), srt_text: cuesText }, { bins, env: env() });
    expect(sidecar.result.passed).toBe(true);
    expect(sidecar.result.files.map((file: { format: string }) => file.format).sort()).toEqual(["ass", "srt", "vtt"]);
    const srt = sidecar.result.files.find((file: { format: string }) => file.format === "srt");
    const output = join(dir, "softsub.mp4");
    const soft = await callTool("subtitlewrite.softmux", { input_path: source, output_path: output, subtitles: [{ path: srt.path, lang: "chi" }], verify: false }, { bins, env: env() });
    expect(soft.result.qualityReviewed).toBe(false);
    expect(soft.result.tracks).toHaveLength(1);
    expect(soft.result.checks.every((check: { ok: boolean }) => check.ok)).toBe(true);
    expect(fileHash(output)).toBe(soft.receipt.sha256);
    expect(fileHash(source)).toBe(originalHash);
    const commands = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(commands.filter(row => row.args.some((arg: string) => /signalstats|edgedetect|bbox=|framemd5/.test(arg)))).toEqual([]);
  }, 30_000);

  it("错误、越界、源覆盖和缺字体仍真实失败，不伪造成功回执", async () => {
    const input = { input_path: source, output_path: join(dir, "failed.mp4"), srt_text: cuesText };
    await expect(callTool("subtitlewrite.burn", { ...input, srt_text: "invalid SRT" }, { bins, env: env() })).rejects.toMatchObject({ code: "bad_srt" });
    await expect(callTool("subtitlewrite.burn", { ...input, output_path: source }, { bins, env: env() })).rejects.toMatchObject({ code: "overwrite_source_forbidden" });
    await expect(callTool("subtitlewrite.burn", { ...input, output_path: join(tmpdir(), "outside.mp4") }, { bins, env: env() })).rejects.toMatchObject({ code: "path_not_allowed" });
    await expect(callTool("subtitlewrite.burn", { ...input, fonts_dir: dir }, { bins, env: env() })).rejects.toMatchObject({ code: "font_not_found" });
    const broken = join(dir, "broken-ffmpeg");
    writeFileSync(broken, "#!/bin/sh\nexit 21\n"); chmodSync(broken, 0o755);
    await expect(callTool("subtitlewrite.burn", input, { bins: { ...bins, ffmpeg: broken }, env: env() })).rejects.toMatchObject({ code: "ffmpeg_failed" });
    expect(fileHash(source)).toBe(originalHash);
  });
});
