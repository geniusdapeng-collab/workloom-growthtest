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
import { assertStandardPostTimeline, buildStandardPostContract, validateStandardNativeClock } from "../../packages/video-studio/src/standard-post-contract.js";
import { assertStandardPostExportClock } from "./film-standard-post.mjs";
import { executeRhythmEdit, rhythmFileSha256, rhythmMediaFacts } from "./rhythm-edit.mjs";
import { dialogueLines } from "../../packages/video-studio/src/dialogue-contract.js";

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
const originalSource = parsed.statements.filter(statement => ts.isFunctionDeclaration(statement)
  && ["originalForShot", "originalFactsForShot"].includes(statement.name?.text ?? "")).map(statement => statement.getFullText(parsed)).join("\n");
const voiceSource = mediaGuardSource + "\n" + originalSource + "\n" + block("/* ---------- ③-2", "/* ---------- ④ 合成母版");
const composeSource = block("/* ---------- ④ 合成母版", "/* ---------- ⑤ 调色");
const defaultsSource = block("const ENHANCE_ENGINE_DIR", "const COVER_REQUESTED_HERO");
const bgmClockSource = block('  if (!originalPostContract) throw new Error("STANDARD_NATIVE_MANIFEST_REQUIRED: final audio export', "  bgmManifestInfo = { layer:");
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
    originalPostContract: { ...structuredClone(originalContract), manifestSha256, contract: originalContract },
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
    expectedMasterSeconds: 30, totalSeconds: 30, transitionLoss: 0, ALLOW_FALLBACK_APPROVE: false, CUT_GRID: [],
    RENDER_SECONDS_MIN: 4, RENDER_SECONDS_MAX: 12, ENHANCE_KIND: "live-action", ENHANCE_ENGINE_DIR: "",
    arg: (_name: string, fallback = "") => fallback, flag: (_name: string) => false,
    join, resolve, existsSync, statSync, writeFileSync, readFileSync, fingerprintFile, fingerprintText, sha256FileSync: fingerprintFile,
    dialogueText, resolveFilmAudioContract, assertFilmAudioSource, decideFilmVoiceAction, assessVoiceArtifact, checkShotOrder, validateStandardNativeClock,
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
    // AST-only provenance fixtures expose their declared media facts above;
    // real full-CLI generation quality tests exercise the physical native probe.
    pinGenerationSources: (files: string[], ids: string[]) => {
      if (files.length !== ids.length || files.some((file, index) => !existsSync(file) || fingerprintFile(file) !== facts.get(ids[index]!)?.sha256)) throw new Error("GENERATION_SOURCE_BINDINGS_MISSING");
    },
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
      const fps = Number(args[args.indexOf("--fps") + 1]), width = Number(args[args.indexOf("--width") + 1]), height = Number(args[args.indexOf("--height") + 1]);
      const originals = (context.originalPostContract as { originals: typeof originalContract.originals }).originals;
      const counts = originals.map(original => Math.ceil(original.media.videoFrames / original.media.fps * fps - 1e-8));
      const videoFrames = counts.reduce((sum, frames) => sum + frames, 0), duration = videoFrames / fps;
      const hasAudio = originals.some(original => original.media.audioChannels > 0);
      writeFileSync(out.replace(/\.mp4$/i, ".av-sync.json"), JSON.stringify({ schemaVersion: "workloom.composition-process/v1",
        outputSha256: fingerprintFile(out), nativeClock: true, retimeFactor: 1, sourceFilesUnchanged: true,
        qualityReviewPerformed: false, audioAlignmentMeasured: false,
        outputMedia: { videoFrames, duration, fps, width, height, hasAudio }, target: { shotFrames: counts, fps, width, height, durationSec: duration },
        sources: originals.map((original, index) => ({ path: original.path, sha256: original.sha256,
          source: { videoFrames: original.media.videoFrames, fps: original.media.fps, hasAudio: original.media.audioChannels > 0 },
          normalized: { videoFrames: counts[index], fps, width, height, hasAudio: original.media.audioChannels > 0 } })) }));
      return { ok: true, out: "official compose fixture exit0" };
    },
    reviewStage: async () => ({ approved: true, degraded: false, ms: 0, score: null, qualityReviewPerformed: false }),
    probe: (file: string) => {
      const item = [...facts.values()].find((entry) => entry.path === file);
      if (!item) {
        const receipt = JSON.parse(readFileSync(file.replace(/\.mp4$/i, ".av-sync.json"), "utf8"));
        return { ...receipt.outputMedia, videoDurationSec: receipt.outputMedia.duration };
      }
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
  it("explicit fast-cut production trims actual pinned sources, composes their native 1x sound, and retains the complete original files", async () => {
    const f = fixture(), ffmpeg = process.env.WL_FFMPEG ?? "ffmpeg", ffprobe = process.env.WL_FFPROBE ?? "ffprobe";
    const media = join(f.dir, "real-source.mp4");
    const made = spawnSync(ffmpeg, ["-v", "error", "-nostdin", "-n", "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=24:d=4",
      "-f", "lavfi", "-i", "sine=frequency=733:sample_rate=48000:duration=4", "-map", "0:v:0", "-map", "1:a:0",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2", media], { encoding: "utf8", timeout: 60_000 });
    expect(made.status, made.stderr).toBe(0);
    const bytes = readFileSync(media), originals = (f.context.originalPostContract as { originals: Array<Record<string, any>> }).originals;
    for (const [index, shot] of f.shots.entries()) {
      const facts = f.facts.get(shot.shotId)!; writeFileSync(facts.path, bytes);
      Object.assign(facts, { sha256: fingerprintFile(facts.path), bytes: bytes.length, durationSeconds: 4, width: 160, height: 90,
        audio: { present: true, sampleRate: 48000, channels: 2, durationSec: 4 } });
      Object.assign(originals[index]!, { sha256: facts.sha256, bytes: facts.bytes,
        media: { fps: 24, width: 160, height: 90, videoFrames: 96, videoDurationSec: 4, audioDurationSec: 4, audioSampleRate: 48000, audioChannels: 2 } });
    }
    const ranges = [0.5, 2, 3, 0.5, 2, 3], before = f.shots.map(shot => fingerprintFile(f.facts.get(shot.shotId)!.path));
    Object.assign(f.context, { FFMPEG: ffmpeg, FFPROBE: ffprobe, executeRhythmEdit, rhythmFileSha256, rhythmMediaFacts, dialogueLines,
      OUTPUT_SIZE: { width: 160, height: 90 }, sourceDocument: { shots: f.shots, rhythmPlan: { profile: "fast-cut",
        segments: f.shots.map((shot, index) => ({ id: shot.shotId, sourceId: shot.shotId, inSeconds: 0, outSeconds: ranges[index],
          role: index % 3 === 0 ? "fast" : index % 3 === 1 ? "hold" : "breath", cutReason: "authored action/story cut",
          protectedRanges: [{ inSeconds: 0, outSeconds: 0.4, kind: "speech", reason: "complete source sentence" }] })) } },
      runCli: (cli: string, args: string[]) => {
        f.calls.push({ cli, args });
        const result = spawnSync(process.execPath, ["--import", "tsx", cli, ...args], { cwd: REPO, encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
        return { ok: result.status === 0, out: result.stdout + result.stderr };
      }, probe: (file: string) => ({ ...rhythmMediaFacts(file, ffprobe), hasAudio: true }) });
    await compose(f);
    const row = f.rows.find(entry => entry.stage === "compose")!;
    expect(row).toMatchObject({ ok: true, evidence: { mode: "explicit-fast-cut", originalSpeed: 1, qualityReviewPerformed: false, actualBodyDurationSec: 11 } });
    expect(f.calls).toHaveLength(1); expect(f.calls[0]!.args).toContain("--native-clock"); expect(f.calls[0]!.args).not.toContain("--retime-to");
    expect(f.shots.map(shot => fingerprintFile(f.facts.get(shot.shotId)!.path))).toEqual(before);
    expect(f.forbiddenCalls).toEqual([]);
  }, 120_000);
  it("explicit fast-cut production rejects a reordered frozen storyboard before any media tool runs", async () => {
    const f = fixture(); f.context.sourceDocument = { rhythmPlan: { profile: "fast-cut" } };
    f.context.shots = [...f.shots].reverse(); await expect(compose(f)).rejects.toThrow(/RHYTHM_ORIGINAL_SEQUENCE_CONFLICT/);
    expect(f.calls).toEqual([]); expect(f.forbiddenCalls).toEqual([]);
  });
  it.each([1, 0.8])("BGM finalization reads requested export clock for real %ss audio without PCM inspection", async (audioSeconds) => {
    const f = fixture(), ffmpeg = process.env.WL_FFMPEG ?? "ffmpeg", ffprobe = process.env.WL_FFPROBE ?? "ffprobe";
    const out = join(f.dir, "mock-real-bgm.mp4");
    const encoded = spawnSync(ffmpeg, ["-v", "error", "-nostdin", "-n", "-f", "lavfi", "-i", "color=s=160x288:r=24:d=1",
      "-f", "lavfi", "-i", `sine=frequency=733:sample_rate=48000:duration=${audioSeconds}`, "-map", "0:v:0", "-map", "1:a:0",
      "-c:v", "libx264", "-c:a", "aac", "-ar", "48000", "-ac", "2", out], { encoding: "utf8", timeout: 60_000 });
    expect(encoded.status, encoded.stderr).toBe(0); const before = fingerprintFile(out), rewrites: unknown[] = [], metadataReads: string[] = [];
    Object.assign(f.context, { out, scored: out, danmakuOut: out, FFMPEG: ffmpeg, FFPROBE: ffprobe,
      originalPostContract: { durationSec: 1 }, expectedMasterSeconds: 1, probe: () => ({ duration: 1 }),
      run: (...args: unknown[]) => { rewrites.push(args); return { ok: true }; }, execFileSync: (...args: unknown[]) => { rewrites.push(args); },
      assertStandardPostExportClock: async (file: string, seconds: number, options: Parameters<typeof assertStandardPostExportClock>[2]) => {
        metadataReads.push(file); return assertStandardPostExportClock(file, seconds, { ...options, ffmpeg: "must-not-be-invoked" });
      } });
    const actual = evaluate<{ nativeAudioClock: { actualDurationSec: number; videoFrames: number } }>(bgmClockSource, f.context,
      "{ nativeAudioClock: typeof nativeAudioClock === 'undefined' ? null : nativeAudioClock }");
    const result = await actual; expect(result.nativeAudioClock).toMatchObject({ actualDurationSec: 1, requestedDurationSec: 1, present: true });
    expect(metadataReads).toEqual([out]); expect(rewrites).toEqual([]); expect(fingerprintFile(out)).toBe(before);
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
  it.each(["on-camera", "voice-over", "none"])("a legacy TTS receipt cannot replace the pinned raw source for %s semantics", async (mode) => {
    const f = fixture(), index = mode === "on-camera" ? 0 : mode === "voice-over" ? 1 : 4;
    const shot = f.shots[index]!, row = f.rows[index]!;
    row.artifact = join(f.dir, `${shot.shotId}.voiced.mp4`); row.evidence.source = "tts-narration";
    row.evidence.voicedSha256 = fingerprintFile(row.artifact); row.evidence.profile = "zh-xiaozhi";
    const selected = await selection(f);
    expect(selected.clipFor(shot)).toBe(f.facts.get(shot.shotId)!.path);
  });
  it.each(["manifest", "verification", "policy", "text", "artifact", "failed"])("an obsolete %s voice receipt does not veto an independently pinned original", async (field) => {
    const f = fixture(), row = f.rows[1]!;
    if (field === "manifest") row.evidence.originalManifestSha256 = sha("other manifest");
    if (field === "verification") delete row.evidence.verification;
    if (field === "policy") row.evidence.audioPolicyHash = sha("other policy");
    if (field === "text") row.evidence.textSha256 = sha("other text");
    if (field === "artifact") row.artifact = join(f.dir, "GT-02.voiced.mp4");
    if (field === "failed") f.rows.push({ ...row, ok: false, degraded: true });
    const selected = await selection(f);
    expect(selected.clipFor(f.shots[1]!)).toBe(f.facts.get("GT-02")!.path);
  });
  it("changed original bytes cannot be washed by an old native receipt", async () => {
    const f = fixture(), selected = await selection(f);
    writeFileSync(f.facts.get("GT-02")!.path, "changed original bytes");
    expect(() => selected.clipFor(f.shots[1]!)).toThrow();
  });
  it.each(["missing", "hash"])("native source rejects %s pinned bytes and makes no synthesis call", async defect => {
    const f = fixture(), item = f.facts.get("GT-02")!;
    if (defect === "missing") rmSync(item.path);
    if (defect === "hash") writeFileSync(item.path, "changed bytes");
    await expect(voice(f)).rejects.toThrow(); expect(f.forbiddenCalls).toEqual([]);
  });
  it.each(["no-audio", "duration", "fps", "dimensions", "audio-gap"])("native source accepts %s media for official normalization without synthesis", async defect => {
    const f = fixture();
    const originals = (f.context.originalPostContract as { originals: Array<{ media: Record<string, number> }> }).originals;
    const media = originals[1]!.media;
    if (defect === "no-audio") Object.assign(media, { audioDurationSec: 0, audioChannels: 0, audioSampleRate: 0 });
    if (defect === "duration") { media.videoFrames = 145; media.videoDurationSec = 145 / 24; }
    if (defect === "fps") { media.fps = 29.97; media.videoDurationSec = media.videoFrames! / media.fps; }
    if (defect === "dimensions") media.width = 321;
    if (defect === "audio-gap") media.audioDurationSec = 4;
    await voice(f); expect(f.forbiddenCalls).toEqual([]);
    expect(f.rows.filter(row => row.stage === "voice").at(-1)!.ok).toBe(true);
  });
  it("contradictory measured frames and video duration remain a factual source error", () => {
    const f = fixture(), original = f.context.originalPostContract as { contract: ReturnType<typeof buildStandardPostContract> };
    const input = { projectId: original.contract.projectId, submitted: structuredClone(original.contract.submitted), originals: structuredClone(original.contract.originals) };
    input.originals[1]!.media.videoDurationSec = 6.04;
    expect(() => buildStandardPostContract(input)).toThrow(/STANDARD_POST_MEDIA_INVALID/); expect(f.forbiddenCalls).toEqual([]);
  });
  it("AAC four-millisecond metadata difference remains factual and does not produce narration", async () => {
    const f = fixture(); await voice(f);
    const row = f.rows.filter((entry) => entry.stage === "voice" && entry.shotId === "GT-04").at(-1)!;
    expect(row.evidence.nativeAudio).toMatchObject({ durationSec: 3.996, sampleRate: 48000, channels: 2 });
    expect(f.forbiddenCalls).toEqual([]);
  });
  it("a missing original manifest cannot issue native voice certificates", async () => {
    const f = fixture(); f.context.originalPostContract = undefined;
    await expect(voice(f)).rejects.toThrow(/ORIGINAL_CHANGED/); expect(f.forbiddenCalls).toEqual([]);
    expect(f.rows.slice(6).some((row) => row.stage === "voice" && row.ok)).toBe(false);
  });
  it("composition submits six full originals in submitted order at native fps with fade0 and no retime", async () => {
    const f = fixture(); await compose(f);
    expect(f.calls).toHaveLength(1);
    const args = f.calls[0]!.args;
    expect(args[args.indexOf("--clips") + 1]!.split(",")).toEqual(f.shots.map((shot) => f.facts.get(shot.shotId)!.path));
    expect(args[args.indexOf("--fps") + 1]).toBe("24"); expect(args[args.indexOf("--fade") + 1]).toBe("0");
    expect(args).toContain("--native-clock");
    for (const flag of ["--retime-to", "--transition", "--transition-at", "--transition-duration"]) expect(args).not.toContain(flag);
    expect(f.forbiddenCalls).toEqual([]);
  });
  it.each(["reorder", "drop", "add", "reuse", "fade", "transition"])("composition refuses %s before calling the compose workstation", async (edit) => {
    const f = fixture();
    if (edit === "reorder") f.context.COMPOSE_ORDER = [...f.shots].reverse().map((shot) => shot.shotId).join(",");
    if (edit === "drop") f.context.shots = f.shots.slice(1);
    if (edit === "add") f.context.shots = [...f.shots, f.shots[0]];
    if (edit === "reuse") { f.context.ORDER_POLICY = "reuse-assembly"; f.context.REUSE_PLAN = "fixture reorder rationale"; }
    if (edit === "fade") f.context.XFADE = 0.5;
    if (edit === "transition") f.context.EFFECTIVE_CUT_TRANSITION = "hblur";
    await expect(compose(f)).rejects.toThrow(); expect(f.calls).toEqual([]);
  });
  it.each(["fps", "upscale"])("composition permits requested export %s without rejecting raw media", async edit => {
    const f = fixture();
    if (edit === "fps") f.context.FPS = 30;
    else f.context.OUTPUT_SIZE = { width: 2160, height: 3840 };
    await compose(f); expect(f.calls).toHaveLength(1); expect(f.forbiddenCalls).toEqual([]);
  });
  it("normal UHD composition scales all source pictures locally and preserves copied native audio packets", () => {
    const f = fixture(), ffmpeg = process.env.WL_FFMPEG ?? "ffmpeg", ffprobe = process.env.WL_FFPROBE ?? "ffprobe";
    const clip = join(f.dir, "complete UHD source.mp4"), out = join(f.dir, "uhd-local-complete.mp4");
    const made = spawnSync(ffmpeg, ["-v", "error", "-nostdin", "-n", "-f", "lavfi", "-i",
      "color=c=blue:s=160x288:r=24:d=0.3333333333,drawbox=color=red:t=fill:enable='eq(n,7)'",
      "-f", "lavfi", "-i", "sine=frequency=733:sample_rate=48000:duration=0.3333333333",
      "-map", "0:v:0", "-map", "1:a:0", "-frames:v", "8", "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-ar", "48000", "-ac", "2", clip], { encoding: "utf8", timeout: 60_000 });
    expect(made.status, made.stderr).toBe(0); const before = fingerprintFile(clip);
    const result = spawnSync(process.execPath, ["--import", "tsx", join(REPO, "scripts/tools/compose-film.mts"),
      "--clips", clip, "--out", out, "--width", "2160", "--height", "3840", "--fps", "24", "--fade", "0",
      "--color", "none", "--native-clock", "--durations", "0.1"], { cwd: REPO, encoding: "utf8", timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024 });
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const receipt = JSON.parse(readFileSync(out.replace(/\.mp4$/, ".av-sync.json"), "utf8"));
    expect(receipt).toMatchObject({ nativeClock: true, retimeFactor: 1, sourceFilesUnchanged: true,
      qualityReviewPerformed: false, audioAlignmentMeasured: false, target: { width: 2160, height: 3840, fps: 24, shotFrames: [8] },
      outputMedia: { width: 2160, height: 3840, videoFrames: 8, fps: 24, duration: 8 / 24, hasAudio: true } });
    expect(receipt.sources).toHaveLength(1);
    expect(receipt.sources[0]).toMatchObject({ path: clip, sha256: before, normalizationPerformed: true,
      source: { videoFrames: 8, fps: 24 }, normalized: { width: 2160, height: 3840, videoFrames: 8, fps: 24 } });
    for (const [index, channel] of [[0, 2], [7, 0]] as const) {
      const decoded = spawnSync(ffmpeg, ["-v", "error", "-nostdin", "-i", out, "-vf", `select=eq(n\\,${index}),scale=1:1`,
        "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { timeout: 60_000 });
      expect(decoded.status, decoded.stderr.toString()).toBe(0); expect(decoded.stdout.length).toBe(3);
      expect(decoded.stdout[channel]).toBeGreaterThan(230);
    }
    const packets = (file: string) => {
      const probed = spawnSync(ffprobe, ["-v", "error", "-select_streams", "a:0", "-show_packets", "-show_data_hash", "sha256",
        "-show_entries", "packet=pts,duration,data_hash", "-of", "json", file], { encoding: "utf8", timeout: 60_000 });
      expect(probed.status, probed.stderr).toBe(0); return JSON.parse(probed.stdout).packets;
    };
    expect(packets(out)).toEqual(packets(clip)); expect(fingerprintFile(clip)).toBe(before);
    expect(f.forbiddenCalls).toEqual([]);
  }, 180_000);
  it("composition preserves an entirely silent original set without inventing an audio requirement", async () => {
    const f = fixture(), previous = f.context.originalPostContract as { contract: ReturnType<typeof buildStandardPostContract> };
    const originals = structuredClone(previous.contract.originals);
    for (const original of originals) Object.assign(original.media, { audioDurationSec: 0, audioChannels: 0, audioSampleRate: 0 });
    const contract = buildStandardPostContract({ projectId: previous.contract.projectId, submitted: structuredClone(previous.contract.submitted), originals });
    f.context.originalPostContract = { ...structuredClone(contract), manifestSha256: f.manifestSha256, contract };
    await compose(f); expect(f.calls).toHaveLength(1); expect(f.forbiddenCalls).toEqual([]);
    const row = f.rows.find(record => record.stage === "compose")!;
    expect(row.ok).toBe(true); expect(row.evidence.hasAudio).toBe(false); expect(row.evidence.qualityReviewPerformed).toBe(false);
  });
  it.each(["missing", "source-hash", "source-frames", "normalized-frames", "normalized-fps", "normalized-canvas", "target-frame-allocation", "dropped-frame", "added-frame"])("composition refuses a %s process receipt and keeps pinned source bytes", async defect => {
    const f = fixture(), run = f.context.runCli as (cli: string, args: string[]) => { ok: boolean; out: string };
    const before = [...f.facts].map(([id, value]) => [id, fingerprintFile(value.path)]);
    f.context.runCli = (cli: string, args: string[]) => {
      const result = run(cli, args), file = args[args.indexOf("--out") + 1]!.replace(/\.mp4$/i, ".av-sync.json");
      if (defect === "missing") rmSync(file);
      else {
        const receipt = JSON.parse(readFileSync(file, "utf8"));
        if (defect === "source-hash") receipt.sources[1].sha256 = sha("wrong source");
        if (defect === "source-frames") receipt.sources[1].source.videoFrames--;
        if (defect === "normalized-frames") receipt.sources[1].normalized.videoFrames--;
        if (defect === "normalized-fps") receipt.sources[1].normalized.fps = 30;
        if (defect === "normalized-canvas") receipt.sources[1].normalized.width = 720;
        if (defect === "target-frame-allocation") { receipt.target.shotFrames[0]++; receipt.target.shotFrames[1]--; }
        if (defect === "dropped-frame" || defect === "added-frame") {
          const delta = defect === "dropped-frame" ? -1 : 1;
          receipt.sources[1].normalized.videoFrames += delta; receipt.target.shotFrames[1] += delta;
          receipt.outputMedia.videoFrames += delta; receipt.outputMedia.duration = receipt.outputMedia.videoFrames / receipt.outputMedia.fps;
        }
        writeFileSync(file, JSON.stringify(receipt));
      }
      return result;
    };
    await expect(compose(f)).rejects.toThrow(); expect(f.forbiddenCalls).toEqual([]);
    expect([...f.facts].map(([id, value]) => [id, fingerprintFile(value.path)])).toEqual(before);
  });
  it.each(["tool", "output-fps", "output-fps-fractional", "output-frames", "output-duration", "output-duration-fractional", "output-audio", "input-change"])("composition stops on %s instead of approving a partial or changed result", async (defect) => {
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
        if (defect === "output-fps-fractional") info.fps = 24.0001;
        if (defect === "output-frames") info.videoFrames = 719;
        if (defect === "output-duration") info.videoDurationSec = 29.5;
        if (defect === "output-duration-fractional") info.videoDurationSec = 30.01;
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
  it("ordinary UHD defaults keep the complete native clock without calling an enhancement model", async () => {
    const f = fixture(); Object.assign(f.context, { QUALITY: "uhd", OUTPUT_RESOLUTION: "2160p", OUTPUT_SIZE: { width: 2160, height: 3840 } });
    const result = await evaluate<Record<string, unknown>>(defaultsSource, f.context, "{ FPS, XFADE, ORDER_POLICY }");
    expect(result).toMatchObject({ FPS: 24, XFADE: 0, ORDER_POLICY: "storyboard" });
    await compose(f); expect(f.calls).toHaveLength(1);
    const args = f.calls[0]!.args;
    expect(args[args.indexOf("--width") + 1]).toBe("2160"); expect(args[args.indexOf("--height") + 1]).toBe("3840");
    expect(args).toContain("--native-clock"); expect(f.forbiddenCalls).toEqual([]);
  });
  it.each(["--enhance-kind", "--enhance-engine-dir"])("unsupported explicit %s fails before a workstation or model call", async name => {
    const f = fixture(); f.context.flag = (option: string) => option === name;
    f.context.arg = (option: string, fallback = "") => option === name ? name === "--enhance-kind" ? "live-action" : "/no-connected-adapter" : fallback;
    await expect(evaluate(defaultsSource, f.context, "{ FPS }")).rejects.toThrow(/STANDARD_ENHANCEMENT_OPTION_UNSUPPORTED/);
    expect(f.calls).toEqual([]); expect(f.forbiddenCalls).toEqual([]);
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
