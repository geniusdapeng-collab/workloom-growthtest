/** Run the actual normal CLI voice, source selection and compose blocks. All external workstations are fixtures. */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { assertFilmAudioSource, decideFilmVoiceAction, resolveFilmAudioContract, type FilmAudioShot } from "./film-audio-policy.mjs";
import { assessVoiceArtifact, fingerprintFile, fingerprintText } from "./film-voice-artifact.js";
import { checkShotOrder } from "../../packages/video-studio/src/shot-order.js";
import { assertStandardPostTimeline, buildStandardPostContract } from "../../packages/video-studio/src/standard-post-contract.js";
import { assertStandardPostAudioClock } from "./film-standard-post.mjs";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
// An immutable prior official source is allowed only for the local RED regression run.
const CLI = process.env.WORKLOOM_NATIVE_POST_CLI_FIXTURE
  ? resolve(process.env.WORKLOOM_NATIVE_POST_CLI_FIXTURE) : join(REPO, "scripts/tools/full-chain-film.mts");
const source = readFileSync(CLI, "utf8");
const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const sourceSha256 = sha(source);
interface AstNode { name?: { text: string }; initializer?: AstNode; getText(source: AstSource): string; getFullText(source: AstSource): string }
interface AstSource { statements: readonly AstNode[] }
interface AstCompiler {
  ScriptTarget: { Latest: number; ES2022: number }; ModuleKind: { CommonJS: number };
  createSourceFile(path: string, source: string, target: number, setParentNodes: boolean): AstSource;
  isFunctionDeclaration(node: AstNode): boolean; isVariableDeclaration(node: AstNode): boolean;
  forEachChild(node: AstNode | AstSource, callback: (child: AstNode) => void): void;
  transpileModule(source: string, options: { compilerOptions: { target: number; module: number } }): { outputText: string };
}
const ts = createRequire(join(REPO, "packages/video-studio/package.json"))("typescript") as AstCompiler;
const parsed = ts.createSourceFile(CLI, source, ts.ScriptTarget.Latest, true);
function block(start: string, end: string): string {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  if (from < 0 || to <= from) throw new Error(`NATIVE_POST_FIXTURE_INVALID: ${start}`);
  return source.slice(from, to);
}
const mediaGuardSource = parsed.statements.filter((statement) => ts.isFunctionDeclaration(statement)
  && statement.name?.text === "assertOriginalRenderMedia").map((statement) => statement.getFullText(parsed)).join("\n");
const voiceSource = mediaGuardSource + "\n" + block("/* ---------- ③-2", "/* ---------- ④ 合成母版");
const composeSource = block("/* ---------- ④ 合成母版", "/* ---------- ⑤ 调色");
const defaultsSource = block("const ENHANCE_ENGINE_DIR", "const COVER_HERO");
const bgmClockSource = block("  if (existsSync(out)) scored = out;", "  record({\n    /**\n     * 声明关闭");
const durationSource = parsed.statements.filter((statement) => ts.isFunctionDeclaration(statement)
  && statement.name?.text === "renderSecondsFor").map((statement) => statement.getFullText(parsed)).join("\n");
if (!durationSource) throw new Error("NATIVE_POST_FIXTURE_INVALID: render duration declaration missing");
function evaluate<T>(body: string, context: Record<string, unknown>, returned: string): Promise<T> {
  const compiled = ts.transpileModule(`(async () => {\n${body}\nreturn ${returned};\n})()`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return runInNewContext(compiled, context) as Promise<T>;
}
interface Shot extends FilmAudioShot { duration: number; dialogue?: Array<{ speaker: string; text: string }> }
interface Row { stage: string; shotId: string | null; artifact: string | null; ok: boolean; degraded: boolean; evidence: Record<string, unknown> }
interface Facts { path: string; sha256: string; bytes: number; durationSeconds: number; fps: number; width: number; height: number;
  audio: { present: boolean; sampleRate: number; channels: number; durationSec: number } }
const tempRoots: string[] = [];
afterEach(() => { for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true }); });
afterAll(() => { expect(sha(readFileSync(CLI)), "actual CLI bytes remain stable during this suite").toBe(sourceSha256); });

function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "native-film-cli-"))); tempRoots.push(dir);
  const durations = [5, 6, 5, 4, 5, 5];
  const shots: Shot[] = durations.map((duration, index) => ({ shotId: `GT-0${index + 1}`, duration,
    constraint: `1080x1920，24fps，单镜${duration}秒`,
    ...(index === 4 ? {} : { speechMode: index % 2 ? "voice-over" as const : "on-camera" as const,
      dialogue: [{ speaker: index % 2 ? "旁白" : "CEO", text: `当前镜头${index + 1}的台词。` }] }),
  }));
  const manifestSha256 = sha("trusted frozen original manifest fixture"), rows: Row[] = [], facts = new Map<string, Facts>();
  for (const shot of shots) {
    // These bytes test provenance only; media metadata is the explicit deterministic probe fixture below.
    const raw = join(dir, `${shot.shotId}${shot.shotId === "GT-04" ? ".raw" : ""}.mp4`);
    writeFileSync(raw, `actual native fixture bytes for ${shot.shotId}`);
    writeFileSync(join(dir, `${shot.shotId}.voiced.mp4`), `different old TTS bytes for ${shot.shotId}`);
    facts.set(shot.shotId, { path: raw, sha256: fingerprintFile(raw), bytes: statSync(raw).size,
      durationSeconds: shot.duration, fps: 24, width: 1080, height: 1920,
      audio: { present: true, sampleRate: 48000, channels: 2, durationSec: shot.duration === 4 ? 3.996 : shot.duration } });
    const contract = resolveFilmAudioContract(shot);
    rows.push({ stage: "voice", shotId: shot.shotId, artifact: raw, ok: true, degraded: false,
      evidence: { projectId: "NATIVE-CLI-FIXTURE", source: "clip-audio", verification: "native-audio-source-verified",
        originalManifestSha256: manifestSha256, rawSha256: fingerprintFile(raw), textSha256: fingerprintText(dialogueText(shot)),
        audioPolicyHash: contract.policyHash, nativeAudio: facts.get(shot.shotId)!.audio,
        profile: "zh-xiaozhi", spokenTextVerified: false, lipSyncVerified: false } });
  }
  const calls: Array<{ cli: string; args: string[] }> = [], forbiddenCalls: string[] = [];
  const submittedJson = JSON.stringify({ projectId: "NATIVE-CLI-FIXTURE", durationSeconds: 30, shots });
  const originalContract = buildStandardPostContract({ projectId: "NATIVE-CLI-FIXTURE",
    submitted: { json: submittedJson, sha256: sha(submittedJson), bytes: Buffer.byteLength(submittedJson) },
    originals: shots.map((shot) => { const item = facts.get(shot.shotId)!; return {
      shotId: shot.shotId, role: "original-render" as const, path: item.path, sha256: item.sha256, bytes: item.bytes,
      media: { fps: item.fps, width: item.width, height: item.height, videoFrames: item.durationSeconds * item.fps,
        videoDurationSec: item.durationSeconds, audioDurationSec: item.audio.durationSec,
        audioSampleRate: item.audio.sampleRate, audioChannels: item.audio.channels },
      authority: { kind: "local-fixture-not-provider-proof", evidenceId: "fixture", evidenceSha256: sha("fixture evidence") },
    }; }),
  });
  function dialogueText(shot: Shot): string { return (shot.dialogue ?? []).map((row) => row.text).join(" "); }
  const context: Record<string, unknown> = {
    PROJECT: "NATIVE-CLI-FIXTURE", CLIP_DIR: dir, POST_DIR: dir, REPO_ROOT: REPO,
    ENV: {}, sourceDocument: { shots, aspect: "9:16", resolution: "1080p" }, sourceFileHash: sha("original submission fixture"),
    originalPostContract: { ...originalContract, manifestSha256, contract: originalContract },
    originalForShot: (shot: Shot): string => {
      const item = facts.get(shot.shotId);
      if (!item) throw new Error(`STANDARD_ORIGINAL_MISSING: ${shot.shotId}`);
      if (!existsSync(item.path) || statSync(item.path).size !== item.bytes || fingerprintFile(item.path) !== item.sha256) {
        throw new Error(`STANDARD_ORIGINAL_CHANGED: ${shot.shotId}`);
      }
      return item.path;
    },
    originalFactsForShot: (shot: Shot) => facts.get(shot.shotId),
    shots, shotlist: { shots, durationSeconds: 30 },
    STAGES: new Set<string>(), DRY_RUN: false, UNIFIED_NARRATION: false,
    SOURCE_SIZE: { width: 1080, height: 1920 }, OUTPUT_SIZE: { width: 1080, height: 1920 },
    FPS: 24, QUALITY: "hd", SOURCE_RESOLUTION: "1080p", OUTPUT_RESOLUTION: "1080p",
    XFADE: 0, CUT_TRANSITION: "", CUT_TRANSITION_DURATION: 0, CUT_TRANSITION_AT: "",
    EFFECTIVE_CUT_TRANSITION: "", EFFECTIVE_CUT_TRANSITION_AT: "", ORDER_POLICY: "storyboard", COMPOSE_ORDER: "", REUSE_PLAN: "",
    POST_ONLY_ASSEMBLY: false, POST_ONLY_REASON: "", postOnlyMissingReceipts: [],
    expectedMasterSeconds: 30, totalSeconds: 30, transitionLoss: 0, ALLOW_FALLBACK_APPROVE: false,
    RENDER_SECONDS_MIN: 4, RENDER_SECONDS_MAX: 12, ENHANCE_KIND: "live-action", ENHANCE_ENGINE_DIR: "",
    arg: (_name: string, fallback = "") => fallback, flag: (_name: string) => false,
    join, resolve, existsSync, statSync, writeFileSync, fingerprintFile, fingerprintText, sha256FileSync: fingerprintFile,
    dialogueText, resolveFilmAudioContract, assertFilmAudioSource, decideFilmVoiceAction, assessVoiceArtifact, checkShotOrder,
    // VM objects use a different Object.prototype; clone into the validator's realm without changing data.
    assertStandardPostTimeline: (contract: unknown, actual: unknown) => assertStandardPostTimeline(contract, structuredClone(actual)),
    readStageHistory: () => rows,
    stageApproved: (stage: string, ids: Array<string | null> = [null]) => ids.every((id) => {
      if (stage !== "voice") return true;
      const last = rows.filter((row) => row.stage === stage && row.shotId === id).at(-1);
      return last?.ok === true && !last.degraded;
    }),
    artifactReusable: (_stage: string, _candidate: string) => true,
    isMaterialShot: (shot: Shot) => shot.shotId === "GT-04",
    rememberInputs: (_stage: string, _files: string[], _shotId?: string) => {},
    record: (row: Row) => { rows.push(row); }, recordGate: (_row: Record<string, unknown>) => ({ approved: true }),
    log: (_line: string) => {},
    VOICE_CLI: join(REPO, "bundles/ai-video/connectors/voice-bridge/cli.mjs"),
    WORKER_RUNTIME: { speech: async () => { forbiddenCalls.push("ASR"); throw new Error("FORBIDDEN_ASR_CALL"); },
      dub: async () => { forbiddenCalls.push("TTS"); throw new Error("FORBIDDEN_TTS_CALL"); } },
    runCli: (cli: string, args: string[]) => {
      calls.push({ cli, args });
      if (!cli.endsWith("compose-film.mts")) { forbiddenCalls.push(cli); throw new Error("FORBIDDEN_WORKSTATION_CALL"); }
      const out = args[args.indexOf("--out") + 1]; if (!out) throw new Error("COMPOSE_OUTPUT_MISSING");
      writeFileSync(out, "new composed fixture bytes");
      return { ok: true, out: "official compose fixture exit0" };
    },
    reviewStage: async () => ({ approved: true, degraded: false, ms: 0, score: 100 }),
    probe: (file: string) => {
      const item = [...facts.values()].find((entry) => entry.path === file);
      if (!item) return { duration: 30, videoDurationSec: 30, videoFrames: 720, fps: 24, width: 1080, height: 1920, hasAudio: true };
      return { duration: item.durationSeconds + 0.016, videoDurationSec: item.durationSeconds,
        videoFrames: item.durationSeconds * 24, fps: item.fps, width: item.width, height: item.height,
        hasAudio: item.audio.present, acodec: "aac", audioDurationSec: item.audio.durationSec,
        audioSampleRate: item.audio.sampleRate, audioChannels: item.audio.channels, bytes: statSync(file).size };
    },
  };
  return { dir, shots, facts, rows, calls, forbiddenCalls, context, manifestSha256 };
}
async function selection(f: ReturnType<typeof fixture>) {
  return evaluate<{ clipFor: (shot: Shot) => string; nativeAudioFactsForShot?: (shot: Shot) => unknown }>(voiceSource, f.context,
    "{ clipFor, nativeAudioFactsForShot: typeof nativeAudioFactsForShot === 'function' ? nativeAudioFactsForShot : undefined }");
}
function voice(f: ReturnType<typeof fixture>) {
  f.context.STAGES = new Set(["voice"]);
  return evaluate<{ clipFor: (shot: Shot) => string }>(voiceSource, f.context, "{ clipFor }");
}
async function compose(f: ReturnType<typeof fixture>) {
  const selected = await selection(f);
  f.context.clipFor = selected.clipFor;
  f.context.nativeAudioFactsForShot = selected.nativeAudioFactsForShot;
  f.context.STAGES = new Set(["compose"]);
  return evaluate<Record<string, unknown>>(composeSource, f.context, "{ master }");
}

describe("actual normal film CLI preserves every original native shot", () => {
  it.each([1, 0.8])("BGM finalization checks real %ss audio against the original clock without rewriting it", async (audioSeconds) => {
    const f = fixture(), ffmpeg = process.env.WL_FFMPEG ?? "ffmpeg", ffprobe = process.env.WL_FFPROBE ?? "ffprobe";
    const out = join(f.dir, "mock-real-bgm.mp4");
    const encoded = spawnSync(ffmpeg, ["-v", "error", "-nostdin", "-n", "-f", "lavfi", "-i", "color=s=160x288:r=24:d=1",
      "-f", "lavfi", "-i", `sine=frequency=733:sample_rate=48000:duration=${audioSeconds}`, "-map", "0:v:0", "-map", "1:a:0",
      "-c:v", "libx264", "-c:a", "aac", "-ar", "48000", "-ac", "2", out], { encoding: "utf8", timeout: 60_000 });
    expect(encoded.status, encoded.stderr).toBe(0); const before = fingerprintFile(out), rewrites: unknown[] = [], decodes: string[] = [];
    Object.assign(f.context, { out, scored: out, danmakuOut: out, FFMPEG: ffmpeg, FFPROBE: ffprobe,
      originalPostContract: { durationSec: 1 }, probe: () => ({ duration: 1 }),
      run: (...args: unknown[]) => { rewrites.push(args); return { ok: true }; }, execFileSync: (...args: unknown[]) => { rewrites.push(args); },
      assertStandardPostAudioClock: async (file: string, seconds: number, options: Parameters<typeof assertStandardPostAudioClock>[2]) => {
        decodes.push(file); return assertStandardPostAudioClock(file, seconds, options);
      } });
    const actual = evaluate<{ nativeAudioClock: { requiredSamples: number; samplesPerChannel: number } }>(bgmClockSource, f.context,
      "{ nativeAudioClock: typeof nativeAudioClock === 'undefined' ? null : nativeAudioClock }");
    if (audioSeconds === 1) {
      const result = await actual; expect(result.nativeAudioClock?.requiredSamples).toBe(48000);
      expect(result.nativeAudioClock?.samplesPerChannel).toBeGreaterThanOrEqual(48000);
    } else await expect(actual).rejects.toThrow(/STANDARD_POST_NATIVE_CLOCK_INCOMPLETE/);
    expect(decodes).toEqual([out]); expect(rewrites).toEqual([]); expect(fingerprintFile(out)).toBe(before);
  });
  it("BGM finalization cannot substitute output duration for a missing original clock", async () => {
    const f = fixture(), out = f.facts.get("GT-01")!.path;
    Object.assign(f.context, { out, scored: out, danmakuOut: out, originalPostContract: undefined,
      run: () => { throw new Error("UNEXPECTED_MEDIA_REWRITE"); }, execFileSync: () => { throw new Error("UNEXPECTED_MEDIA_REWRITE"); } });
    await expect(evaluate(bgmClockSource, f.context, "{ scored }")).rejects.toThrow(/STANDARD_NATIVE_MANIFEST_REQUIRED/);
  });
  it("on-camera, offscreen and ambient shots select the exact trusted original path", async () => {
    const f = fixture(), selected = await selection(f);
    expect(f.shots.map(selected.clipFor)).toEqual(f.shots.map((shot) => f.facts.get(shot.shotId)!.path));
    expect(f.forbiddenCalls).toEqual([]);
  });
  it("all six voice-stage receipts verify original source bytes without ASR, TTS or a local voice tool", async () => {
    const f = fixture(), before = new Map(f.shots.map((shot) => [shot.shotId, f.facts.get(shot.shotId)!.sha256]));
    await voice(f);
    const current = f.rows.slice(6).filter((row) => row.stage === "voice");
    expect(current).toHaveLength(6);
    for (const row of current) {
      expect(row.ok).toBe(true); expect(row.evidence.source).toBe("clip-audio");
      expect(row.evidence.verification).toBe("native-audio-source-verified");
      expect(row.evidence.originalManifestSha256).toBe(f.manifestSha256);
      expect(row.evidence.spokenTextVerified).toBe(false); expect(row.evidence.lipSyncVerified).toBe(false);
      expect(fingerprintFile(row.artifact!)).toBe(before.get(row.shotId!));
    }
    expect(f.forbiddenCalls).toEqual([]); expect(f.calls).toEqual([]);
  });
  it.each(["on-camera", "voice-over", "none"])("a legacy TTS receipt is rejected for %s semantics", async (mode) => {
    const f = fixture(), index = mode === "on-camera" ? 0 : mode === "voice-over" ? 1 : 4;
    const shot = f.shots[index]!, row = f.rows[index]!;
    row.artifact = join(f.dir, `${shot.shotId}.voiced.mp4`); row.evidence.source = "tts-narration";
    row.evidence.voicedSha256 = fingerprintFile(row.artifact); row.evidence.profile = "zh-xiaozhi";
    const selected = await selection(f);
    expect(() => selected.clipFor(shot)).toThrow();
  });
  it.each(["manifest", "verification", "policy", "text", "artifact", "failed"])("an invalid %s voice receipt cannot authorize original selection", async (field) => {
    const f = fixture(), row = f.rows[1]!;
    if (field === "manifest") row.evidence.originalManifestSha256 = sha("other manifest");
    if (field === "verification") delete row.evidence.verification;
    if (field === "policy") row.evidence.audioPolicyHash = sha("other policy");
    if (field === "text") row.evidence.textSha256 = sha("other text");
    if (field === "artifact") row.artifact = join(f.dir, "GT-02.voiced.mp4");
    if (field === "failed") f.rows.push({ ...row, ok: false, degraded: true });
    const selected = await selection(f);
    expect(() => selected.clipFor(f.shots[1]!)).toThrow();
  });
  it("changed original bytes cannot be washed by an old native receipt", async () => {
    const f = fixture(), selected = await selection(f);
    writeFileSync(f.facts.get("GT-02")!.path, "changed original bytes");
    expect(() => selected.clipFor(f.shots[1]!)).toThrow();
  });
  it.each(["missing", "no-audio", "hash", "duration", "fps", "dimensions", "channels", "sample-rate", "audio-gap"])("native voice rejects %s source evidence and makes no synthesis call", async (defect) => {
    const f = fixture(), item = f.facts.get("GT-02")!;
    if (defect === "missing") rmSync(item.path);
    if (defect === "no-audio") item.audio.present = false;
    if (defect === "hash") item.sha256 = sha("wrong original");
    if (defect === "duration") item.durationSeconds += 0.5;
    if (defect === "fps") item.fps = 30;
    if (defect === "dimensions") item.width = 720;
    if (defect === "channels") item.audio.channels = 0;
    if (defect === "sample-rate") item.audio.sampleRate = 0;
    if (defect === "audio-gap") item.audio.durationSec -= 0.1;
    await expect(voice(f)).rejects.toThrow();
    expect(f.forbiddenCalls).toEqual([]);
  });
  it("AAC four-millisecond metadata difference remains factual and does not produce narration", async () => {
    const f = fixture(); await voice(f);
    const row = f.rows.filter((entry) => entry.stage === "voice" && entry.shotId === "GT-04").at(-1)!;
    expect(row.evidence.nativeAudio).toMatchObject({ durationSec: 3.996, sampleRate: 48000, channels: 2 });
    expect(f.forbiddenCalls).toEqual([]);
  });
  it("a missing original manifest cannot issue native voice certificates", async () => {
    const f = fixture(); f.context.originalPostContract = undefined;
    await expect(voice(f)).rejects.toThrow(/MANIFEST_REQUIRED/); expect(f.forbiddenCalls).toEqual([]);
    expect(f.rows.slice(6).some((row) => row.stage === "voice" && row.ok)).toBe(false);
  });
  it("composition submits six full originals in submitted order at native fps with fade0 and no retime", async () => {
    const f = fixture(); await compose(f);
    expect(f.calls).toHaveLength(1);
    const args = f.calls[0]!.args;
    expect(args[args.indexOf("--clips") + 1]!.split(",")).toEqual(f.shots.map((shot) => f.facts.get(shot.shotId)!.path));
    expect(args[args.indexOf("--fps") + 1]).toBe("24"); expect(args[args.indexOf("--fade") + 1]).toBe("0");
    for (const flag of ["--retime-to", "--transition", "--transition-at", "--transition-duration"]) expect(args).not.toContain(flag);
    expect(f.forbiddenCalls).toEqual([]);
  });
  it.each(["reorder", "drop", "add", "reuse", "fade", "transition", "fps", "upscale"])("composition refuses %s before calling the compose workstation", async (edit) => {
    const f = fixture();
    if (edit === "reorder") f.context.COMPOSE_ORDER = [...f.shots].reverse().map((shot) => shot.shotId).join(",");
    if (edit === "drop") f.context.shots = f.shots.slice(1);
    if (edit === "add") f.context.shots = [...f.shots, f.shots[0]];
    if (edit === "reuse") { f.context.ORDER_POLICY = "reuse-assembly"; f.context.REUSE_PLAN = "fixture reorder rationale"; }
    if (edit === "fade") f.context.XFADE = 0.5;
    if (edit === "transition") f.context.EFFECTIVE_CUT_TRANSITION = "hblur";
    if (edit === "fps") f.context.FPS = 30;
    if (edit === "upscale") f.context.OUTPUT_SIZE = { width: 2160, height: 3840 };
    await expect(compose(f)).rejects.toThrow(); expect(f.calls).toEqual([]);
  });
  it.each(["tool", "output-fps", "output-frames", "output-duration", "output-audio", "input-change"])("composition stops on %s instead of approving a partial or changed result", async (defect) => {
    const f = fixture(), run = f.context.runCli as (cli: string, args: string[]) => { ok: boolean; out: string };
    const probe = f.context.probe as (file: string) => Record<string, unknown>;
    if (defect === "tool" || defect === "input-change") f.context.runCli = (cli: string, args: string[]) => {
      const result = run(cli, args);
      if (defect === "input-change") writeFileSync(f.facts.get("GT-02")!.path, "changed source during compose");
      return defect === "tool" ? { ok: false, out: "actual fixture compose failure" } : result;
    };
    f.context.probe = (file: string) => {
      const info = probe(file);
      if (file.endsWith("master-raw.mp4")) {
        if (defect === "output-fps") info.fps = 30;
        if (defect === "output-frames") info.videoFrames = 719;
        if (defect === "output-duration") info.videoDurationSec = 29.99;
        if (defect === "output-audio") info.hasAudio = false;
      }
      return info;
    };
    await expect(compose(f)).rejects.toThrow(); expect(f.forbiddenCalls).toEqual([]);
  });
  it("provider request seconds preserve valid integer durations and reject clamp/round cases", async () => {
    const f = fixture(), result = await evaluate<{ renderSecondsFor: (seconds: number) => number }>(durationSource, f.context, "{ renderSecondsFor }");
    for (const seconds of [4, 5, 6, 12]) expect(result.renderSecondsFor(seconds)).toBe(seconds);
    for (const seconds of [0, 1.8, 3.999, 4.5, 12.01, 15, NaN, Infinity]) expect(() => result.renderSecondsFor(seconds)).toThrow();
  });
  it("defaults derive authored24fps and never enable fade, transitions or a reuse timeline", async () => {
    const f = fixture(), result = await evaluate<Record<string, unknown>>(defaultsSource, f.context, "{ FPS, XFADE, CUT_TRANSITION, CUT_TRANSITION_AT, ORDER_POLICY, COMPOSE_ORDER, REUSE_PLAN }");
    expect(result).toMatchObject({ FPS: 24, XFADE: 0, CUT_TRANSITION: "", CUT_TRANSITION_AT: "", ORDER_POLICY: "storyboard", COMPOSE_ORDER: "", REUSE_PLAN: "" });
  });
  it.each(["--fps", "--xfade", "--cut-transition", "--cut-transition-duration", "--cut-transition-at", "--order-policy", "--compose-order", "--reuse-plan", "--material-speed-ramp", "--material-post-camera-move", "--material-photo-tail-trim", "--retime-to"])("legacy %s is rejected by defaults before any workstation runs", async (name) => {
    const f = fixture(), values: Record<string, string> = { "--fps": "30", "--xfade": "0.5", "--cut-transition": "hblur",
      "--cut-transition-duration": "0.18", "--cut-transition-at": "2", "--order-policy": "reuse-assembly", "--compose-order": "GT-02,GT-01",
      "--reuse-plan": "old free timeline", "--retime-to": "29" };
    f.context.arg = (flag: string, fallback = "") => flag === name ? values[name] ?? "true" : fallback;
    f.context.flag = (flag: string) => flag === name;
    await expect(evaluate(defaultsSource, f.context, "{ FPS }")).rejects.toThrow(); expect(f.calls).toEqual([]);
  });
  it("conflicting authored frame clocks fail rather than guessing a common fps", async () => {
    const f = fixture(); f.shots[1]!.constraint = "30fps";
    await expect(evaluate(defaultsSource, f.context, "{ FPS }")).rejects.toThrow();
  });
});
