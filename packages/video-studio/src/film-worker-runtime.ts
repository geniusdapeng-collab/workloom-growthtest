/** Adapt the complete film CLI to a frozen, keyless server job. */
import { createHash } from "node:crypto";
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { FilmChannelError, FilmWorkerChannel, parseFilmWorkerJobContext, processIpcTransport,
  type FilmChannelTransport, type FilmWorkerJobContext } from "./film-worker-channel.js";
import type { ProducerGateOptions, ProducerVerdict } from "./producer-gate.js";

export const FILM_CLI_STAGES = Object.freeze(["cine-kb", "continuity", "micromotion", "spec", "plates", "material-gen", "videos", "voice", "compose", "color", "subtitle", "danmaku", "bgm", "sfx", "cover", "mux", "master", "deliver", "revise"]);
const valueOptions = new Set(["aspect", "resolution", "quality", "platform", "fps", "max-attempts", "xfade", "cut-transition", "cut-transition-duration", "cut-transition-at", "subtitle-mode", "subtitle-lang", "cover-platform", "cover-hero", "cover-hook", "theme", "account", "only", "review-policy", "route-kind", "assembly-mode", "assembly-reason", "revise-note", "revision-context", "narration-profile", "enhance-kind"]);
const flagOptions = new Set(["no-resume", "no-danmaku", "no-open-with-cover", "no-cover-kb", "unified-narration", "prompt-english-gloss", "material-post-only", "material-speed-ramp", "bgm-declared-program-mix"]);
const enumOptions: Record<string, readonly string[]> = {
  aspect: ["9:16", "16:9", "1:1", "4:5"], resolution: ["720p", "1080p", "2160p"], quality: ["hd", "uhd"],
  "subtitle-mode": ["sidecar", "burn", "both"], "review-policy": ["off", "advisory", "blocking"],
  "route-kind": ["narrative", "marketing"], "assembly-mode": ["post-only"], "enhance-kind": ["live-action", "animation"],
};
const numericOptions: Record<string, [number, number]> = { fps: [1, 120], "max-attempts": [1, 3], xfade: [0, 5], "cut-transition-duration": [0, 5] };
const stageAliases: Record<string, string[]> = { spec: ["prompt-review", "prompt-package"], plates: ["keyframe"], videos: ["shot"] };

/** The parent checks that requested work has evidence; a summary file alone is not a completed job. */
export function assertFilmStageCoverage(stages: string[], options: Record<string, unknown>, source: Record<string, unknown>, records: unknown): void {
  if (!Array.isArray(records)) throw new FilmChannelError("RESULT_INVALID", "工位结果缺阶段记录");
  const only = String(options.only ?? "").split(",").filter(Boolean);
  const selected = (Array.isArray(source.shots) ? source.shots : []).filter((shot) =>
    shot && typeof shot === "object" && (!only.length || only.includes(String((shot as Record<string, unknown>).shotId))));
  const notApplicable = (stage: string): boolean =>
    stage === "material-gen" && !selected.some((shot) => String((shot as Record<string, unknown>).photo ?? "").trim())
    || stage === "mux" && options["subtitle-mode"] === "burn"
    || stage === "danmaku" && options["no-danmaku"] === true
    || stage === "revise" && !String(options["revise-note"] ?? "").trim();
  for (const stage of stages) {
    if (notApplicable(stage)) continue;
    const aliases = stageAliases[stage] ?? [stage];
    const latest = new Map<string, Record<string, unknown>>();
    for (const raw of records) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new FilmChannelError("RESULT_INVALID", "阶段记录格式非法");
      const row = raw as Record<string, unknown>;
      if (aliases.includes(String(row.stage))) latest.set(`${row.stage}:${row.shotId ?? ""}`, row);
    }
    if (!latest.size) throw new FilmChannelError("RESULT_INVALID", `工位结果缺请求阶段：${stage}`);
    for (const row of latest.values()) {
      const declaredPostOnly = options["assembly-mode"] === "post-only" && row.assemblyMode === "post-only";
      if (row.ok !== true || row.degraded !== false && !declaredPostOnly || row.invoked !== true && row.cached !== true) {
        throw new FilmChannelError("RESULT_INVALID", `请求阶段没有通过：${stage}${row.shotId ? `:${row.shotId}` : ""}`);
      }
    }
  }
}
export function normalizeFilmJobRequest(stages: string[], options: Record<string, unknown>): { stages: string[]; options: Record<string, string | boolean> } {
  if (!Array.isArray(stages) || !stages.length || stages.some((stage) => !FILM_CLI_STAGES.includes(stage))) {
    throw new FilmChannelError("UNKNOWN_STAGE", "作业阶段必须来自固定影片管线");
  }
  const normalized: Record<string, string | boolean> = {};
  for (const [original, raw] of Object.entries(options)) {
    const key = original.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    if (Object.hasOwn(normalized, key)) throw new FilmChannelError("OPTION_INVALID", `重复选项 ${key}`);
    if (flagOptions.has(key)) {
      if (typeof raw !== "boolean") throw new FilmChannelError("OPTION_INVALID", `${key} 必须是布尔值`);
      normalized[key] = raw;
      continue;
    }
    if (!valueOptions.has(key)) throw new FilmChannelError("OPTION_NOT_ALLOWED", `工位不接受选项 ${original}`);
    const value = key === "only" && Array.isArray(raw) ? raw.join(",") : String(raw);
    if (!["string", "number"].includes(typeof raw) && !(key === "only" && Array.isArray(raw))) throw new FilmChannelError("OPTION_INVALID", `${key} 格式非法`);
    if (value.length > 5_000 || /[\0\r\n]/.test(value) || value.startsWith("--")) throw new FilmChannelError("OPTION_INVALID", `${key} 超限或含控制字符`);
    if (enumOptions[key] && !enumOptions[key]!.includes(value)) throw new FilmChannelError("OPTION_INVALID", `${key} 取值非法`);
    if (numericOptions[key]) {
      const [min, max] = numericOptions[key]!;
      const number = Number(value);
      if (!Number.isFinite(number) || number < min || number > max || (["fps", "max-attempts"].includes(key) && !Number.isInteger(number))) throw new FilmChannelError("OPTION_INVALID", `${key} 超出允许范围`);
    }
    normalized[key] = value;
  }
  const effective = [...new Set(stages)];
  if (effective.includes("deliver") && !effective.includes("master")) effective.push("master");
  if (normalized["assembly-mode"] === "post-only" && !effective.includes("spec")) effective.push("spec");
  return { stages: effective, options: normalized };
}
const within = (root: string, file: string): boolean => file === root || file.startsWith(`${root}${sep}`);
const digest = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");
interface WorkerArtifact { ref: string; sha256: string; bytes: number; hostedUrl?: string; taskId?: string }

export class FullChainFilmWorker {
  readonly channel: FilmWorkerChannel;
  readonly args: string[];
  readonly inputPath: string;
  private readonly artifacts = new Map<string, WorkerArtifact>();
  constructor(readonly context: FilmWorkerJobContext, readonly repoRoot: string, transport: FilmChannelTransport = processIpcTransport()) {
    if (Date.parse(context.deadlineAt) <= Date.now()) throw new FilmChannelError("JOB_DEADLINE_EXCEEDED", "作业已过截止时间");
    const archive = realpathSync(context.archiveRoot);
    const work = realpathSync(context.workDir);
    if (!within(archive, work) || work === archive) throw new FilmChannelError("PATH_INVALID", "工位目录必须位于项目档案内");
    const input = resolve(archive, context.inputRef);
    if (isAbsolute(context.inputRef) || !within(archive, input) || !within(archive, realpathSync(input))) throw new FilmChannelError("PATH_INVALID", "冻结原稿引用越出项目档案");
    if (!statSync(input).isFile() || digest(input) !== context.inputSha256) throw new FilmChannelError("INPUT_CHANGED", "冻结原稿摘要不符");
    const normalized = normalizeFilmJobRequest(context.stages, context.options);
    if (JSON.stringify(normalized.stages) !== JSON.stringify(context.stages)) throw new FilmChannelError("CONTEXT_INVALID", "工位不得自行增加阶段");
    this.inputPath = join(work, "inputs", "source.json");
    mkdirSync(dirname(this.inputPath), { recursive: true });
    copyFileSync(input, this.inputPath);
    if (digest(this.inputPath) !== context.inputSha256) throw new FilmChannelError("INPUT_CHANGED", "原稿复制时发生变化");
    this.args = ["--shots", this.inputPath, "--project", context.projectId, "--work-dir", join(work, "work"), "--out", join(work, "delivery"), "--stages", context.stages.join(",")];
    for (const [key, value] of Object.entries(normalized.options)) {
      if (typeof value === "boolean") { if (value) this.args.push(`--${key}`); }
      else this.args.push(`--${key}`, value);
    }
    this.channel = new FilmWorkerChannel({ transport });
  }
  static fromEnvironment(repoRoot: string): FullChainFilmWorker {
    if (typeof process.send !== "function") throw new FilmChannelError("CHANNEL_UNAVAILABLE", "固定工位需要服务父通道");
    return new FullChainFilmWorker(parseFilmWorkerJobContext(), repoRoot);
  }
  ref(file: string): string {
    const path = resolve(file);
    if (!within(this.context.workDir, path) || path === this.context.workDir) throw new FilmChannelError("PATH_INVALID", "工位只能写入本次作业目录");
    return relative(this.context.workDir, path).split(sep).join("/");
  }
  reference(file: string): string {
    if (/^asset:\/\/[A-Za-z0-9._-]+$/.test(file)) return file;
    const source = realpathSync(file);
    const allowed = [this.context.archiveRoot, join(this.repoRoot, "bundles", "ai-video", "library"), join(this.repoRoot, "var", "media")];
    if (!allowed.some((root) => within(root, source)) || !statSync(source).isFile() || statSync(source).size > 12 * 1024 * 1024) throw new FilmChannelError("REFERENCE_INVALID", "参考图不在项目档案或受控素材库内，或超过上限");
    const extension = extname(source).toLowerCase();
    if (![".jpg", ".jpeg", ".png", ".webp"].includes(extension)) throw new FilmChannelError("REFERENCE_INVALID", "参考图格式非法");
    const ref = `references/${digest(source)}${extension}`;
    const target = join(this.context.workDir, ref);
    mkdirSync(dirname(target), { recursive: true });
    if (!existsSync(target)) copyFileSync(source, target, constants.COPYFILE_EXCL);
    if (digest(target) !== digest(source)) throw new FilmChannelError("REFERENCE_CHANGED", "参考图复制时发生变化");
    return ref;
  }
  private async call(method: Parameters<FilmWorkerChannel["call"]>[0], stage: string, shotId: string | null, params: unknown): Promise<unknown> {
    if (!this.context.allowedMethods.includes(method)) throw new FilmChannelError("METHOD_NOT_ALLOWED", `作业未授予 ${method}`);
    if (!this.context.stages.includes(stage)) throw new FilmChannelError("STEP_OUT_OF_SCOPE", `阶段 ${stage} 不在冻结范围内`);
    if (Date.parse(this.context.deadlineAt) <= Date.now()) throw new FilmChannelError("JOB_DEADLINE_EXCEEDED", "作业已过截止时间");
    return this.channel.call(method, { stepKey: shotId ? `${stage}:${shotId}` : stage, shotId, params });
  }
  private accept(result: unknown): WorkerArtifact {
    const artifact = result as WorkerArtifact;
    if (!artifact || typeof artifact.ref !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256) || !(artifact.bytes > 0)) throw new FilmChannelError("ARTIFACT_UNVERIFIED", "父服务没有给出有效产物回执");
    const file = join(this.context.workDir, artifact.ref);
    this.ref(file);
    if (!within(this.context.workDir, realpathSync(file)) || statSync(file).size !== artifact.bytes || digest(file) !== artifact.sha256) throw new FilmChannelError("ARTIFACT_CHANGED", "产物字节与父服务回执不符");
    this.artifacts.set(`film-artifact:${artifact.ref}`, artifact);
    if (artifact.hostedUrl && !this.artifacts.has(artifact.hostedUrl)) this.artifacts.set(artifact.hostedUrl, artifact);
    return artifact;
  }
  async image(prompt: string, anchors: string[], size: string, shotId: string, target: string): Promise<string> {
    const artifact = this.accept(await this.call("image.generate", "plates", shotId, { prompt, anchors: anchors.map((file) => this.reference(file)), size, targetRef: this.ref(target) }));
    return artifact.hostedUrl ?? `film-artifact:${artifact.ref}`;
  }
  async video(options: { prompt: string; firstFrame?: string; refs: string[]; seconds: number; generateAudio: boolean; seed?: number; stage: string; shotId: string; target: string }): Promise<{ taskId: string; url: string; lastFrame: null }> {
    const first = options.firstFrame;
    const firstFrame = first ? (/^https:\/\//.test(first) ? { hostedUrl: first } : { ref: first.replace(/^film-ref:/, "") }) : undefined;
    const artifact = this.accept(await this.call("video.generate", options.stage, options.shotId, {
      prompt: options.prompt, firstFrame, refs: options.refs.map((ref) => ref.replace(/^film-ref:/, "")), seconds: options.seconds,
      generateAudio: options.generateAudio, seed: options.seed, targetRef: this.ref(options.target),
    }));
    if (!artifact.taskId) throw new FilmChannelError("ARTIFACT_UNVERIFIED", "父服务未返回视频任务回执");
    return { taskId: artifact.taskId, url: `film-artifact:${artifact.ref}`, lastFrame: null };
  }
  async download(url: string, target: string): Promise<string> {
    const artifact = this.artifacts.get(url);
    if (!artifact) throw new FilmChannelError("URL_NOT_ISSUED", "工位不得直接下载未签发的地址");
    this.accept(artifact);
    if (this.ref(target) !== artifact.ref) {
      const stage = url.startsWith("film-artifact:") && target.endsWith(".mp4") ? (this.context.stages.includes("videos") ? "videos" : "material-gen") : "plates";
      this.accept(await this.call("media.fetch", stage, null, { ref: artifact.ref, targetRef: this.ref(target) }));
    }
    return target;
  }
  async review(options: Omit<ProducerGateOptions, "contracts">): Promise<ProducerVerdict> {
    const aliases: Record<string, string> = { script: "spec", prompt: "spec", keyframe: "plates", shot: "videos" };
    let stage = aliases[options.stage] ?? options.stage;
    if (options.stage === "shot") {
      if (options.context?.sourceStage === "material-gen") stage = "material-gen";
      else if (!this.context.stages.includes("videos") && this.context.stages.includes("material-gen")) stage = "material-gen";
    }
    const shotId = typeof options.context?.shotId === "string" ? options.context.shotId : null;
    const params = { stage: options.stage, projectId: options.projectId, artifacts: options.artifacts.map((artifact) => ({ ref: this.ref(artifact.path), kind: artifact.kind, note: artifact.note, probe: artifact.probe })),
      referenceImages: options.referenceImages?.map((file) => this.reference(file)), deterministic: options.deterministic,
      requiredCheckIds: options.requiredCheckIds, minScore: options.minScore, rubric: options.rubric, context: options.context };
    const verdict = await this.call("gate.review", stage, shotId, params) as ProducerVerdict;
    if (!verdict || verdict.stage !== options.stage || typeof verdict.approved !== "boolean" || !verdict.contractHash) throw new FilmChannelError("REVIEW_UNVERIFIED", "父服务裁决未绑定作者合同");
    return verdict;
  }
  async design(prompt: string): Promise<string> {
    const result = await this.call("llm.chat", "cover", null, { prompt, system: "你是封面设计师，只输出严格合法的 JSON 设计稿。", scene: "video-film-cover" }) as { content?: unknown };
    if (typeof result?.content !== "string" || !result.content.trim()) throw new FilmChannelError("LLM_UNVERIFIED", "父服务未返回设计稿");
    return result.content;
  }
  async speech(file: string, expected: string, shotId: string): Promise<{ ok: boolean; out: string }> {
    const result = await this.call("voice.verify", "voice", shotId, { inputRef: this.ref(file), expectText: expected });
    return { ok: true, out: JSON.stringify({ result }) };
  }
  async dub(input: string, output: string, text: string, profile: string, policy: string, shotId: string): Promise<{ ok: boolean; out: string }> {
    const artifact = this.accept(await this.call("voice.dub", "voice", shotId, { inputRef: this.ref(input), outputRef: this.ref(output), text, profile, policy, lufs: -16 }));
    return { ok: true, out: JSON.stringify(artifact) };
  }
  finish(records: Array<{ stage: string; shotId: string | null; ok: boolean; artifact: string | null; degraded: boolean; invoked: boolean; cached?: boolean; evidence?: Record<string, unknown> }>, complete: boolean): void {
    const stageRecords = records.map(({ stage, shotId, ok, degraded, invoked, cached, evidence }) => ({ stage, shotId, ok, degraded, invoked, cached: cached === true,
      ...(evidence?.assemblyMode === "post-only" ? { assemblyMode: "post-only" } : {}) }));
    if (complete) assertFilmStageCoverage(this.context.stages, this.context.options, JSON.parse(readFileSync(this.inputPath, "utf8")), stageRecords);
    const artifacts = [...new Set([...records.flatMap((row) => row.artifact ? [row.artifact] : []), join(this.context.workDir, "work", "logs", this.context.projectId, "stage-summary.json")])]
      .map((file) => ({ ref: this.ref(file), sha256: digest(file), bytes: statSync(file).size }));
    const result = { schemaVersion: "workloom.film-result/v1", jobId: this.context.jobId, projectId: this.context.projectId,
      runId: this.context.runId, attempt: this.context.attempt, inputSha256: this.context.inputSha256, stages: this.context.stages,
      complete, artifacts, records: stageRecords };
    writeFileSync(join(this.context.workDir, "film-result.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
    this.channel.dispose();
    if (process.connected) process.disconnect();
  }
}
