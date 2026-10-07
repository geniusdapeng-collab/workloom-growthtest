/** Successful source renders enter post directly. These receipts describe processing, never creative quality. */
import { statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { ProducerGateOptions, ProducerStage, ProducerVerdict } from "./producer-gate.js";

export const POST_RENDER_STAGES: ReadonlySet<ProducerStage> = new Set([
  "shot", "compose", "color", "subtitle", "mux", "danmaku", "bgm", "sfx", "cover", "master",
]);
const technicalIds: Readonly<Record<string, ReadonlySet<string>>> = {
  shot: new Set(["provider-success", "source-bytes", "source-file"]),
  compose: new Set(["tool-exit", "master-produced", "duration", "resolution", "original-timeline"]),
  color: new Set(["tool-exit", "color-tool-exit", "graded-produced", "grade-produced"]),
  subtitle: new Set(["tool-exit", "subtitle-produced", "sidecar-produced", "srt-produced", "timeline-readback", "master-untouched"]),
  mux: new Set(["softsub-produced", "tool-exit", "video-unchanged", "subtitle-files"]),
  danmaku: new Set(["tool-exit", "rendered", "danmaku-produced"]),
  bgm: new Set(["tool-exit", "mix-produced", "scored-produced", "scored"]),
  sfx: new Set(["tool-exit", "sfx-produced"]),
  cover: new Set(["cover-produced", "platform-dimensions", "visible-copy", "safe-area"]),
  master: new Set(["duration", "resolution", "fps", "subtitle-delivery", "deliverable-naming", "required-files"]),
};

export function postProcessingVerdict(options: Pick<ProducerGateOptions, "stage" | "artifacts" | "deterministic" | "env">): ProducerVerdict {
  const failures: string[] = [];
  let sourceVideo = false;
  for (const artifact of options.artifacts) {
    try {
      const file = statSync(artifact.path);
      if (!file.isFile() || file.size === 0) failures.push(`ARTIFACT_MISSING: ${artifact.path}`);
      if (options.stage === "shot" && artifact.kind === "video" && file.isFile() && file.size > 0) {
        const env = options.env ?? process.env;
        const probe = spawnSync(env.WORKLOOM_POST_FFPROBE_PATH ?? env.WL_FFPROBE ?? "ffprobe",
          ["-v", "error", "-show_streams", "-show_format", "-of", "json", artifact.path],
          { encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
        if (probe.error || probe.status !== 0) {
          failures.push(`SOURCE_MEDIA_UNREADABLE: ${artifact.path}: ${probe.error?.message ?? probe.stderr.trim()}`);
        } else {
          try {
            const metadata = JSON.parse(probe.stdout) as { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> };
            const video = metadata.streams?.find((stream) => stream.codec_type === "video");
            const duration = Number(video?.duration ?? metadata.format?.duration);
            if (video && Number(video.width) > 0 && Number(video.height) > 0 && Number.isFinite(duration) && duration > 0) sourceVideo = true;
            else failures.push(`SOURCE_VIDEO_MISSING: ${artifact.path}`);
          } catch (error) {
            failures.push(`SOURCE_METADATA_INVALID: ${artifact.path}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    } catch (error) {
      failures.push(`ARTIFACT_UNREADABLE: ${artifact.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!options.artifacts.length) failures.push("ARTIFACT_MISSING: no actual processing source or output");
  if (options.stage === "shot" && !sourceVideo) failures.push("SOURCE_VIDEO_MISSING: successful render adoption requires an actual readable video");
  for (const check of options.deterministic) {
    if (technicalIds[options.stage]?.has(check.id) && check.status !== "not_applicable"
      && (check.pass !== true || check.status === "failed" || check.status === "unverified")) failures.push(`${check.id}: ${check.detail}`);
  }
  return { stage: options.stage, approved: failures.length === 0, status: failures.length ? "failed" : "passed",
    score: null, qualityReviewed: false, hardFailures: failures, issues: failures, suggestions: [], rerun: false,
    via: "deterministic", ms: 0, degraded: false, evidence: [],
    reason: failures.length ? "Actual file processing or requested export failed; no generation retry is authorized"
      : "Successful rendered sources enter official post by default; no quality, identity, clothing, motion, audio, lipsync, model or human review was performed" };
}
