/** Whole Director post entry with real FFmpeg: native audio, cache, revision and actual errors. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Bundle modules are runtime JavaScript assets rather than this package's TypeScript sources.
const directorModule = new URL("../../../bundles/ai-video/connectors/post-bridge/director-delivery.mjs", import.meta.url).href;
const { buildDirectorDelivery, reviseDirectorDelivery } = await import(directorModule);
import { resolveDeliveryTargets } from "../../../bundles/ai-video/library/director-system/core.mjs";

const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const json = (file: string) => JSON.parse(readFileSync(file, "utf8"));

describe("Director 已完成镜头默认后期（真实本地处理）", () => {
  let root: string, source: string, sourceHash: string, commands: string;
  let bins: { ffmpeg: string; ffprobe: string }, env: Record<string, string>;
  let delivered: Awaited<ReturnType<typeof buildDirectorDelivery>>;
  let revised: Awaited<ReturnType<typeof reviseDirectorDelivery>>;
  const project = { projectId: "LOCAL-DIRECTOR-DEFAULT", title: "黑帧仍正式交付", resolution: [320, 240], fps: 24,
    chronologyLocked: true, copy: { title: "实际交付", body: "本地处理", cta: "查看" } };
  const targetPlan = resolveDeliveryTargets("视频号只要一个版本", { platforms: ["wechat-channels"], versionCount: 1, includeSurprise: false });
  const subtitles = { zhText: "1\n00:00:00,100 --> 00:00:01,200\n实际处理完整字幕\n\n" };
  const shots = () => [{ shotId: "SC-1", path: source, lockTrim: true, dialogue: "保留已有生成结果" }];

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "director-native-default-")));
    source = join(root, "black-odd-silent-source.mp4");
    execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "color=black:s=162x122:r=24",
      "-vf", "crop=161:121:exact=1", "-frames:v", "55", "-an", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv444p", source], { timeout: 30_000 });
    sourceHash = hash(source); commands = join(root, "processing-commands.jsonl");
    const wrap = (name: "ffmpeg" | "ffprobe") => {
      const file = join(root, `${name}-default-only`);
      writeFileSync(file, `#!${process.execPath}\nimport { spawnSync } from 'node:child_process';\nimport fs from 'node:fs';\nconst args=process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(commands)},JSON.stringify({bin:${JSON.stringify(name)},args})+'\\n');\nif(args.includes('-count_frames')||args.includes('-xerror')||args.some(arg=>/signalstats|psnr|framemd5|edgedetect|ebur128|astats|blurdetect|bbox=/.test(arg))){process.stderr.write('forbidden default quality review');process.exit(87);}\nconst result=spawnSync(${JSON.stringify(name)},args,{stdio:'inherit'});\nif(result.error){process.stderr.write(result.error.message);process.exit(86);}\nprocess.exit(result.status??85);\n`);
      chmodSync(file, 0o755); return file;
    };
    bins = { ffmpeg: wrap("ffmpeg"), ffprobe: wrap("ffprobe") };
    env = { PATH: process.env.PATH ?? "", WORKLOOM_POST_ALLOWED_ROOTS: [root, resolve("bundles/ai-video/library")].join(delimiter),
      WORKLOOM_BGM_ALLOWED_ROOTS: [root, resolve("bundles/ai-video/library")].join(delimiter),
      WORKLOOM_BGM_DISCOVER: "0", WORKLOOM_BGM_LIBRARY_DIR: join(root, "empty-custom-library"), WORKLOOM_BGM_HOME: join(root, "empty-bgm-home") };
    expect(env.WORKLOOM_AUDIO_STEM_SIGNING_SECRET).toBeUndefined();
  });
  afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  it("黑帧、奇数原始画布和无音轨无需签名密钥/品质审查即可实际交付", async () => {
    delivered = await buildDirectorDelivery({ project, shots: shots(), subtitles, targetPlan, outDir: join(root, "delivery"), bins, env });
    expect(delivered.status, JSON.stringify(delivered.failures)).toBe("complete");
    expect(delivered.passed).toBe(true); expect(delivered.revision).toBe(1);
    expect(delivered.sourceGenerationCalls).toBe(0); expect(delivered.renderApiCalls).toBe(0);
    expect(delivered.difference.status).toBe("not-reviewed");
    expect(delivered.variants).toHaveLength(1);
    const variant = delivered.variants[0];
    for (const artifact of [variant.video, variant.cover, variant.copy, variant.softsub, variant.burned]) {
      expect(artifact).toBeTruthy(); expect(existsSync(artifact.path)).toBe(true); expect(hash(artifact.path)).toBe(artifact.sha256);
    }
    expect(variant.personQc.status).toBe("not-reviewed");
    expect(variant.personQc.samples).toEqual([]); expect(variant.personQc.identityVerified).toBe(false);
    expect(variant.audio.sourceAuthority).toBe("frozen-source-audio"); expect(variant.audio.embeddedAudioUsed).toBe(false);
    expect(variant.audio.measured).toBeNull(); expect(variant.audio.qualityReview).toBe("not-run");
    const snapshot = json(delivered.projectPath);
    expect(snapshot.scope).toBeNull(); expect(snapshot.prepared.sourceStems.schemaVersion).toBe("workloom.native-program/v1");
    expect(snapshot.prepared.sourceStems.program.silenceInsertedForSources).toEqual(["SC-1"]);
    expect(snapshot.prepared.sourceStems.musicExcluded).toBe(false); expect(snapshot.prepared.sourceStems.sources).toEqual([]);
    expect(hash(source)).toBe(sourceHash);
  }, 120_000);

  it("同输入回放核对真实字节后复用；文案返修与幂等回放保留实际成片", async () => {
    const cached = await buildDirectorDelivery({ project, shots: shots(), subtitles, targetPlan, outDir: delivered.outDir, bins, env });
    expect(cached.reused).toBe(true); expect(cached.variants[0].video.sha256).toBe(delivered.variants[0].video.sha256);
    const request = { projectPath: delivered.projectPath, feedback: "只修改这版文案", patch: { copy: { cta: "新提示" } },
      variantId: delivered.variants[0].id, expectedVersion: 1, expectedProjectSha256: hash(delivered.projectPath), idempotencyKey: "native-copy-revision", bins, env };
    revised = await reviseDirectorDelivery(request);
    expect(revised.status, JSON.stringify(revised.failures)).toBe("complete"); expect(revised.newVersion).toBe(2);
    expect(revised.regeneratedSourceShots).toBe(0);
    expect(revised.variants[0].video.sha256).toBe(delivered.variants[0].video.sha256);
    expect(revised.variants[0].reusedVideo).toBe(true);
    const replay = await reviseDirectorDelivery(request);
    expect(replay.idempotentReplay).toBe(true); expect(replay.variants[0].video.sha256).toBe(revised.variants[0].video.sha256);
    expect(hash(source)).toBe(sourceHash);
    const rows = readFileSync(commands, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(rows.filter(row => row.args.includes('-count_frames') || row.args.some((arg: string) => /signalstats|psnr|framemd5|edgedetect|ebur128|astats|blurdetect|bbox=/.test(arg)))).toEqual([]);
  }, 120_000);

  it("源字节漂移、错误版本和实际 FFmpeg 故障仍失败，不能伪造完整交付", async () => {
    await expect(reviseDirectorDelivery({ projectPath: revised.projectPath, feedback: "改文案", patch: { copy: { cta: "变化" } },
      expectedVersion: 1, expectedProjectSha256: hash(revised.projectPath), idempotencyKey: "stale-version", bins, env })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    const original = readFileSync(source);
    try {
      writeFileSync(source, Buffer.concat([original, Buffer.from('source-drift')]));
      await expect(buildDirectorDelivery({ project, shots: shots(), subtitles, targetPlan, outDir: delivered.outDir, bins, env })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
      await expect(reviseDirectorDelivery({ projectPath: delivered.projectPath, feedback: "只修改这版文案", patch: { copy: { cta: "新提示" } },
        variantId: delivered.variants[0].id, expectedVersion: 1, expectedProjectSha256: hash(delivered.projectPath), idempotencyKey: "native-copy-revision", bins, env })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    } finally { writeFileSync(source, original); }
    const broken = join(root, "ffmpeg-mix-failure");
    writeFileSync(broken, `#!${process.execPath}\nimport {spawnSync} from 'node:child_process';\nconst args=process.argv.slice(2);\nif(args.some(arg=>arg.includes('sidechaincompress'))){process.stderr.write('fixture actual mixing failure');process.exit(51);}\nconst r=spawnSync('ffmpeg',args,{stdio:'inherit'});\nprocess.exit(r.status??52);\n`); chmodSync(broken, 0o755);
    const failed = await buildDirectorDelivery({ project: { ...project, projectId: "LOCAL-ACTUAL-MIX-ERROR" }, shots: shots(), subtitles,
      targetPlan, outDir: join(root, "processing-failed"), bins: { ...bins, ffmpeg: broken }, env });
    expect(failed.passed).toBe(false); expect(failed.status).toBe("partial"); expect(failed.failures).toHaveLength(1);
    expect(failed.failures[0].code).toBe("ffmpeg_failed");
    expect(existsSync(join(root, "processing-failed", "delivery-manifest.json"))).toBe(true);
    expect(failed.variants[0].status).toBe("failed"); expect(hash(source)).toBe(sourceHash);
  }, 120_000);
});
