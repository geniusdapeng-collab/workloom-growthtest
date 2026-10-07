/**
 * Exercises the actual director worker-to-picture bridge with local synthetic media.
 * It extracts the real private worker/audio/post functions without editing them.
 * Only asset/DB/audio-authority boundaries are fixtures; picture normalization,
 * EDL generation, ffmpeg frame trim/concat and frame readback are real.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const requireForRepo = createRequire(path.join(REPO, "packages/video-studio/package.json"));
const ts = requireForRepo("typescript") as any;
const WORKER = path.join(REPO, "apps/server/src/video/director-worker.ts");
const SOURCES = path.join(REPO, "apps/server/src/video/director-sources.ts");
const DELIVERY = path.join(REPO, "bundles/ai-video/connectors/post-bridge/director-delivery.mjs");
const SCOPE = Object.freeze({ tenantId: "bridge-fixture-tenant", workspaceId: "bridge-fixture-workspace" });
const PROJECT_ID = "bridge-fixture-project";
const FRAME_RATE = 30;
const SOURCE_FRAMES = 180;
const SOURCE_SECONDS = 6;
const trackedSources = new Map<string, string>();
const tempRoots: string[] = [];
let director: any, post: any, measure: any;
const bins = {
  ffmpeg: process.env.WL_FFMPEG ?? process.env.FFMPEG_PATH ?? "ffmpeg",
  ffprobe: process.env.WL_FFPROBE ?? process.env.FFPROBE_PATH ?? "ffprobe",
};

const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
function readTracked(file: string): string {
  const source = fs.readFileSync(file, "utf8"), fingerprint = hash(source);
  const prior = trackedSources.get(file);
  if (prior && prior !== fingerprint) throw new Error(`BRIDGE_SOURCE_CHANGED: ${file}`);
  trackedSources.set(file, fingerprint);
  return source;
}

/** Raw AST statements are retained. No field propagation or source body is rewritten. */
function actualFunctions<T>(file: string, names: string[], exported: string[], injected: Record<string, unknown>): T {
  const source = readTracked(file);
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const wanted = new Set(names), found = new Set<string>(), statements: string[] = [];
  for (const statement of parsed.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && wanted.has(statement.name.text)) {
      if (found.has(statement.name.text)) throw new Error(`BRIDGE_AST_AMBIGUOUS: ${statement.name.text}`);
      found.add(statement.name.text); statements.push(statement.getFullText(parsed));
    } else if (ts.isVariableStatement(statement)) {
      const selected = statement.declarationList.declarations.filter((entry: any) => wanted.has(entry.name?.text));
      if (!selected.length) continue;
      if (selected.length !== statement.declarationList.declarations.length) {
        throw new Error("BRIDGE_AST_UNSAFE: selected variable shares a statement with another declaration");
      }
      for (const entry of selected) {
        if (found.has(entry.name.text)) throw new Error(`BRIDGE_AST_AMBIGUOUS: ${entry.name.text}`);
        found.add(entry.name.text);
      }
      statements.push(statement.getFullText(parsed));
    }
  }
  if (found.size !== wanted.size) {
    throw new Error(`BRIDGE_AST_MISSING: ${[...wanted].filter(name => !found.has(name)).join(",")}`);
  }
  const compiled = ts.transpileModule(statements.join("\n")
    + `\nexports.__bridge = { ${exported.join(", ")} };`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const context = { ...injected, exports: {} as { __bridge: T }, structuredClone, Buffer };
  runInNewContext(compiled, context, { filename: file, timeout: 5_000 });
  return context.exports.__bridge;
}

class FixtureJobError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(`${code}: ${message}`); this.code = code; }
}
interface FixtureClip {
  shotId: string; assetId: string; path: string; sha256: string; durationSec: number;
  role: string; dialogue: string; lockTrim?: boolean; audio: Record<string, string>;
  audioStems?: Record<string, unknown>;
}
interface WorkerApi {
  loadClips(scope: typeof SCOPE, projectId: string, refs: Array<{ shotId: string; assetId: string }>,
    plan: any, media: any, binaries: typeof bins): Promise<FixtureClip[]>;
}
interface AudioApi {
  prepareDirectorAudio(scope: typeof SCOPE, input: Record<string, unknown>): Promise<FixtureClip[]>;
}
interface PictureApi {
  prepareSources(input: Record<string, unknown>): Promise<any>;
  executePicture(plan: any, normalised: any[], outputDir: string, binaries: typeof bins,
    env: Record<string, string>): Promise<any>;
  exactFrames(file: string, binaries: typeof bins): Promise<number>;
}

beforeAll(async () => {
  // No provider/voice/model call is allowed. Real credential variables are never read.
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("BRIDGE_NETWORK_FORBIDDEN"); }));
  for (const ref of ["bundles/ai-video/library/director-system/core.mjs",
    "bundles/ai-video/library/director-system/recipes.json",
    "bundles/ai-video/connectors/post-bridge/core.mjs",
    "bundles/ai-video/connectors/subtitle-bridge/measure.mjs"]) readTracked(path.join(REPO, ref));
  [director, post, measure] = await Promise.all([
    import(pathToFileURL(path.join(REPO, "bundles/ai-video/library/director-system/core.mjs")).href),
    import(pathToFileURL(path.join(REPO, "bundles/ai-video/connectors/post-bridge/core.mjs")).href),
    import(pathToFileURL(path.join(REPO, "bundles/ai-video/connectors/subtitle-bridge/measure.mjs")).href),
  ]);
}, 30_000);
afterEach(async () => {
  for (const root of tempRoots.splice(0)) await fsp.rm(root, { recursive: true, force: true });
});
afterAll(() => {
  try {
    for (const [file, fingerprint] of trackedSources) {
      expect(hash(fs.readFileSync(file)), `Actual source must remain unchanged: ${file}`).toBe(fingerprint);
    }
  } finally { vi.unstubAllGlobals(); }
});

async function fixture(lockTrim: boolean) {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), "director-worker-bridge-"));
  const root = await fsp.realpath(temporary); tempRoots.push(root);
  const input = path.join(root, "source.mp4");
  await measure.runBin(bins.ffmpeg, ["-hide_banner", "-v", "error", "-n", "-filter_threads", "1",
    "-f", "lavfi", "-i", "testsrc2=s=160x288:r=30:d=6",
    "-f", "lavfi", "-i", "sine=frequency=733:sample_rate=48000:duration=6",
    "-map", "0:v:0", "-map", "1:a:0", "-frames:v", String(SOURCE_FRAMES),
    "-c:v", "libx264", "-preset", "veryfast", "-threads", "2", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-ar", "48000", "-ac", "2", input],
  { label: "bridge(synthetic-six-second-source)", timeoutMs: 90_000 });
  const originalHash = await measure.sha256File(input);
  const asset = { id: "fixture-asset", kind: "clip", path: input, sha256: originalHash,
    license_risk: "none", project_id: PROJECT_ID };
  // This is input data for the real frozen-plan reconstruction. It is never copied
  // by the test into a clip, prepared source manifest or EDL.
  const planned = Object.freeze({ shotId: "SC-1", durationSec: SOURCE_SECONDS, role: "action",
    dialogue: "", lockTrim, audio: Object.freeze({ dialogue: "none", ambience: "none", foley: "none", music: "post-only" }) });
  const filmPlan = { shots: [planned] };
  const boundaryCalls = { assets: 0, connectors: 0, describeAudio: 0, issueAudio: 0, renderAudio: 0,
    forbidden: [] as string[], audioIssueInputs: [] as any[], audioRenderInputs: [] as any[] };
  const forbidden = (name: string): never => {
    boundaryCalls.forbidden.push(name); throw new Error(`BRIDGE_FORBIDDEN: ${name}`);
  };
  const worker = actualFunctions<WorkerApi>(WORKER, ["loadClips"], ["loadClips"], {
    DirectorJobError: FixtureJobError,
    resolveDirectorAsset: async (scope: typeof SCOPE, assetId: string, options: any) => {
      boundaryCalls.assets++;
      expect(scope).toEqual(SCOPE); expect(assetId).toBe(asset.id);
      expect(options).toEqual({ projectId: PROJECT_ID, kinds: ["clip", "upload_video"] });
      return { ...asset };
    },
  });
  let nextAudioJob = 0;
  const env = { WORKLOOM_POST_ALLOWED_ROOTS: JSON.stringify([root]),
    // Synthetic fixture sentinel solely for the producer's length guard. It is
    // not a real key, and no HMAC/audio authority certification is exercised.
    WORKLOOM_AUDIO_STEM_SIGNING_SECRET: "bridge-fixture-sentinel-0000000000000000" };
  const audio = actualFunctions<AudioApi>(SOURCES, ["prepareDirectorAudio"], ["prepareDirectorAudio"], {
    path, mkdir: fsp.mkdir, DirectorJobError: FixtureJobError, directorHash: director.directorHash,
    directorWorkRoot: () => root,
    safeSegment: (value: string) => {
      if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("BRIDGE_FIXTURE_UNSAFE_ID");
      return value;
    },
    newId: (prefix: string) => `${prefix}-${++nextAudioJob}`,
    sha256File: measure.sha256File,
    directorTx: () => forbidden("database"), directorEvent: () => forbidden("database-event"),
    buildSfxArgs: () => forbidden("sfx"),
    directorConnectors: async () => {
      boundaryCalls.connectors++;
      return { env, bins, measure,
        voice: { engineConfig: () => forbidden("voice-config"), speak: () => forbidden("voice") },
        stems: { describeAudioStemSources: () => {
          boundaryCalls.describeAudio++;
          // No auth/DB certificate is claimed. The real audio producer still
          // builds its four not-applicable role records and performs its map.
          return [];
        } },
        authority: { issueAudioSourceReceipts: async (input: any) => {
          boundaryCalls.issueAudio++; boundaryCalls.audioIssueInputs.push(structuredClone(input.shots));
          expect(input.scope).toEqual({ ...SCOPE, projectId: PROJECT_ID, revision: 1 });
          return structuredClone(input.shots);
        } },
      };
    },
  });
  const picture = actualFunctions<PictureApi>(DELIVERY,
    ["scopeOf", "prepareSources", "executePicture", "exactFrames", "verifyFile",
      "fail", "writeJson", "portablePath", "descriptor"],
    ["prepareSources", "executePicture", "exactFrames"], {
      path, fsp, randomUUID, PostError: post.PostError,
      normaliseShots: post.normaliseShots,
      assertPathAllowed: post.assertPathAllowed, allowedRoots: post.allowedRoots,
      normaliseSourceManifest: director.normaliseSourceManifest,
      runBin: measure.runBin, sha256File: measure.sha256File,
      createAudioStemReceiptVerifier: () => () => forbidden("audio-certificate-verification"),
      renderAudioStems: async (input: any) => {
        boundaryCalls.renderAudio++; boundaryCalls.audioRenderInputs.push(structuredClone(input.shots));
        return { fixtureOnly: true, scope: input.scope, shots: structuredClone(input.shots) };
      },
    });
  expect(await picture.exactFrames(input, bins)).toBe(SOURCE_FRAMES);
  return { root, input, originalHash, asset, planned, filmPlan, env, worker, audio, picture, boundaryCalls };
}

async function actualBridge(f: Awaited<ReturnType<typeof fixture>>) {
  const clips = await f.worker.loadClips(SCOPE, PROJECT_ID,
    [{ shotId: "SC-001", assetId: f.asset.id }], f.filmPlan, measure, bins);
  const withAudio = await f.audio.prepareDirectorAudio(SCOPE, { projectId: PROJECT_ID, revision: 1,
    clips, filmPlan: f.filmPlan, by: "fixture-user", deadlineMs: Date.now() + 120_000 });
  const workDir = path.join(f.root, "prepared"), outputDir = path.join(f.root, "picture");
  await fsp.mkdir(outputDir, { recursive: true });
  const project = { ...SCOPE, projectId: PROJECT_ID, revision: 1,
    audioScope: { ...SCOPE, projectId: PROJECT_ID, revision: 1 },
    fps: FRAME_RATE, resolution: [160, 288], quality: "hd", chronologyLocked: false };
  const prepared = await f.picture.prepareSources({ project, shots: withAudio, workDir, bins, env: f.env });
  const targetPlan = director.resolveDeliveryTargets("只出1版抖音", {
    platforms: ["douyin"], versionCount: 1, includeSurprise: false,
  });
  expect(targetPlan.targets).toHaveLength(1); expect(targetPlan.targets[0].recipeId).toBe("impact");
  const plans = director.buildPostVariantPlans({ sourceManifest: prepared.sourceManifest,
    targetPlan, scope: { ...SCOPE, projectId: PROJECT_ID, revision: 1 } });
  expect(plans).toHaveLength(1);
  const result = await f.picture.executePicture(plans[0], prepared.normalised, outputDir, bins, f.env);
  const frames = await f.picture.exactFrames(result.picture, bins);
  expect(await measure.sha256File(f.input), "Original generated source must not be rewritten").toBe(f.originalHash);
  // Runtime logs bind both RED and GREEN to the actual reconstructed stages.
  console.info(JSON.stringify({ fixture: "director-worker-real-picture-bridge", workerSource: WORKER,
    workerSha256: trackedSources.get(WORKER), plannedLockTrim: f.planned.lockTrim,
    loadedLockTrim: clips[0]?.lockTrim ?? null, audioLockTrim: withAudio[0]?.lockTrim ?? null,
    manifestLockTrim: prepared.sourceManifest.shots[0]?.lockTrim ?? null,
    sourceFrames: SOURCE_FRAMES, edl: plans[0].pictureEdl, actualFrames: frames }));
  return { clips, withAudio, prepared, plan: plans[0], result, frames };
}

describe("actual director worker -> audio -> prepared source -> EDL -> ffmpeg picture bridge", () => {
  it("keeps all 180 frames of the frozen silent six-second action through the actual worker bridge", async () => {
    const f = await fixture(true), actual = await actualBridge(f);
    // Run the complete bridge before this assertion: original loadClips reaches
    // real executePicture with 104 frames, rather than failing at a mocked flag check.
    expect(actual.frames, "Complete action may not be cropped by the impact recipe").toBe(SOURCE_FRAMES);
    expect(actual.clips[0]).toMatchObject({ shotId: "SC-1", lockTrim: true });
    expect(actual.withAudio[0]).toMatchObject({ shotId: "SC-1", lockTrim: true });
    expect(actual.prepared.sourceManifest.shots[0]).toMatchObject({ shotId: "SC-1", lockTrim: true });
    expect(actual.plan.pictureEdl).toHaveLength(1);
    expect(actual.plan.pictureEdl[0]).toMatchObject({ sourceId: "SC-1", inFrame: 0, outFrame: 180, dialogueProtected: true });
    expect(actual.plan.durationFrames).toBe(SOURCE_FRAMES);
    expect(actual.result.readback.segments[0].frames).toBe(SOURCE_FRAMES);
    expect(f.boundaryCalls).toMatchObject({ connectors: 1, describeAudio: 1, issueAudio: 1, renderAudio: 1, forbidden: [] });
    expect(f.boundaryCalls.audioIssueInputs[0][0].stems.dialogue.status).toBe("not_applicable");
    expect(f.boundaryCalls.audioRenderInputs[0][0].durationSec).toBe(SOURCE_SECONDS);
  }, 120_000);

  it("retains an unlocked legacy control that really renders the 104-frame recipe interval", async () => {
    // Explicit legacy/control input, outside new planner's always-locked output.
    // It traverses the same real bridge, so the locked test cannot pass because
    // the test bypasses the recipe or replaces every EDL with a full interval.
    const f = await fixture(false), actual = await actualBridge(f);
    expect(actual.frames).toBe(104); expect(actual.frames).toBeLessThan(SOURCE_FRAMES);
    expect(actual.plan.pictureEdl[0].outFrame - actual.plan.pictureEdl[0].inFrame).toBe(104);
    expect(actual.plan.pictureEdl[0].dialogueProtected).toBe(false);
    expect(f.boundaryCalls.forbidden).toEqual([]);
  }, 120_000);

  it.each(["empty", "unknown", "canonical-duplicate", "missing", "license"])(
    "actual source reconstruction rejects %s before audio or picture work", async defect => {
      const f = await fixture(true);
      let refs = [{ shotId: "SC-001", assetId: f.asset.id }], plan: any = f.filmPlan;
      const expectedCodes: Record<string, string> = { empty: "SOURCE_REFS_INVALID", unknown: "SOURCE_SHOT_UNKNOWN",
        "canonical-duplicate": "SOURCE_REFS_INVALID", missing: "SOURCE_SHOT_MISSING", license: "SOURCE_LICENSE_REQUIRED" };
      const expected = expectedCodes[defect];
      if (defect === "empty") refs = [];
      if (defect === "unknown") refs = [{ shotId: "SC-2", assetId: f.asset.id }];
      if (defect === "canonical-duplicate") refs.push({ shotId: "SC-1", assetId: f.asset.id });
      if (defect === "missing") plan = { shots: [f.planned, { ...f.planned, shotId: "SC-2" }] };
      if (defect === "license") f.asset.license_risk = "unknown";
      await expect(f.worker.loadClips(SCOPE, PROJECT_ID, refs, plan, measure, bins)).rejects.toMatchObject({ code: expected });
      expect(f.boundaryCalls).toMatchObject({ connectors: 0, issueAudio: 0, renderAudio: 0, forbidden: [] });
    }, 120_000);
});
