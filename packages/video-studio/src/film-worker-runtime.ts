/** Adapt the complete film CLI to a frozen, keyless server job. */
import { createHash } from "node:crypto";
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { FilmChannelError, FilmWorkerChannel, parseFilmWorkerJobContext, processIpcTransport,
  type FilmChannelTransport, type FilmWorkerJobContext } from "./film-worker-channel.js";
import type { ProducerGateOptions, ProducerVerdict } from "./producer-gate.js";
import { POST_RENDER_STAGES } from "./post-render-acceptance.js";
import { assertFilmVideoSubmissionReceipt, type FilmVideoReferenceInput, type FilmVideoSubmissionReceipt } from "./film-worker-provenance.js";
import { adaptCharacterVisualVerdict, characterReleaseHash, type CharacterIdentityEvidence, type CharacterIdentityReviewRequest } from "./character-release-contract.js";

export const FILM_CLI_STAGES = Object.freeze(["cine-kb", "continuity", "micromotion", "spec", "plates", "material-gen", "videos", "voice", "compose", "color", "subtitle", "danmaku", "bgm", "sfx", "cover", "mux", "master", "deliver", "revise"]);
const valueOptions = new Set(["aspect", "resolution", "quality", "platform", "fps", "max-attempts", "xfade", "cut-transition", "cut-transition-duration", "cut-transition-at", "subtitle-mode", "subtitle-lang", "cover-platform", "cover-hero", "cover-hook", "theme", "account", "only", "review-policy", "route-kind", "assembly-mode", "assembly-reason", "revise-note", "revision-context", "narration-profile", "enhance-kind", "opening-title"]);
const flagOptions = new Set(["no-resume", "no-danmaku", "no-open-with-cover", "no-cover-kb", "narration-unified", "no-title-card", "prompt-english-gloss", "material-post-only", "material-speed-ramp", "bgm-declared-program-mix"]);
const enumOptions: Record<string, readonly string[]> = {
  aspect: ["9:16", "16:9", "1:1", "4:5"], resolution: ["720p", "1080p", "2160p"], quality: ["hd", "uhd"],
  "subtitle-mode": ["sidecar", "burn", "both"], "review-policy": ["off", "advisory", "blocking"],
  "route-kind": ["narrative", "marketing"], "assembly-mode": ["post-only"], "enhance-kind": ["live-action", "animation"],
};
const numericOptions: Record<string, [number, number]> = { fps: [1, 120], "max-attempts": [1, 3], xfade: [0, 5], "cut-transition-duration": [0, 5] };
const stageAliases: Record<string, string> = { keyframe: "plates", shot: "videos" };
const perShotStages = new Set(["spec", "plates", "material-gen", "videos", "voice"]);
const preRenderStages = new Set(["cine-kb", "continuity", "micromotion", "spec", "plates", "material-gen", "videos"]);

function normalizeOnly(raw: unknown): string {
  if (typeof raw !== "string" && !Array.isArray(raw)) throw new FilmChannelError("OPTION_INVALID", "only 必须是镜号字符串或字符串数组");
  const values: unknown[] = Array.isArray(raw) ? raw : raw.split(",");
  if (!values.length || values.some((value) => typeof value !== "string" || !value.trim() || /[\x00-\x1f\x7f,]/.test(value) || value.trim().startsWith("--"))) {
    throw new FilmChannelError("OPTION_INVALID", "only 必须包含非空镜号，不得含控制字符或选项");
  }
  const value = [...new Set((values as string[]).map((item) => item.trim()))].join(",");
  if (value.length > 5_000) throw new FilmChannelError("OPTION_INVALID", "only 超出长度上限");
  return value;
}

/** The parent checks that requested work has evidence; a summary file alone is not a completed job. */
export function assertFilmStageCoverage(stages: string[], options: Record<string, unknown>, source: Record<string, unknown>, records: unknown,
  verifiedAdoptedShotIds: readonly string[] = []): void {
  if (!Array.isArray(records)) throw new FilmChannelError("RESULT_INVALID", "工位结果缺阶段记录");
  const normalized = normalizeFilmJobRequest(stages, options).options;
  if (!source || typeof source !== "object" || !Array.isArray(source.shots) || !source.shots.length) throw new FilmChannelError("RESULT_INVALID", "冻结原稿缺非空镜头清单");
  const all = new Map<string, Record<string, unknown>>();
  for (const raw of source.shots) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new FilmChannelError("RESULT_INVALID", "冻结原稿镜头格式非法");
    const shot = raw as Record<string, unknown>;
    if (typeof shot.shotId !== "string" || !shot.shotId.trim() || shot.shotId !== shot.shotId.trim() || /[\x00-\x1f\x7f]/.test(shot.shotId) || all.has(shot.shotId)) throw new FilmChannelError("RESULT_INVALID", "冻结原稿镜号为空、重复或格式非法");
    if (shot.dialogue != null && (!Array.isArray(shot.dialogue) || shot.dialogue.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry)))) throw new FilmChannelError("RESULT_INVALID", `冻结原稿台词格式非法：${shot.shotId}`);
    all.set(shot.shotId, shot);
  }
  const only = typeof normalized.only === "string" ? normalized.only.split(",") : [];
  if (only.some((shotId) => !all.has(shotId))) throw new FilmChannelError("RESULT_INVALID", "only 含冻结原稿中不存在的镜号");
  if (!Array.isArray(verifiedAdoptedShotIds) || verifiedAdoptedShotIds.some(id => typeof id !== "string" || !all.has(id))
    || new Set(verifiedAdoptedShotIds).size !== verifiedAdoptedShotIds.length) throw new FilmChannelError("RESULT_INVALID", "已采用原片必须来自本次官方任务和字节验证");
  const verifiedAdopted = new Set(verifiedAdoptedShotIds);
  const adopted = new Set<string>();
  for (const raw of records) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || (raw as Record<string, unknown>).stage !== "render-adopted") continue;
    const row = raw as Record<string, unknown>;
    if (typeof row.shotId !== "string" || !verifiedAdopted.has(row.shotId) || row.ok !== true || row.degraded !== false
      || row.invoked !== false || row.cached !== true) throw new FilmChannelError("RESULT_INVALID", "已采用原片记录缺本次官方验证，不能用标签跳过生成前工作");
    adopted.add(row.shotId);
  }
  const selected = new Map([...all].filter(([shotId]) => !only.length || only.includes(shotId)));
  if (stages.some(stage => preRenderStages.has(stage))) for (const [shotId, shot] of selected) {
    if (adopted.has(shotId)) continue;
    if (shot.assetRef != null && String(shot.assetRef).trim() && (typeof shot.assetRef !== "string" || !/^asset:\/\/[A-Za-z0-9][A-Za-z0-9_-]*$/.test(shot.assetRef.trim()))) throw new FilmChannelError("RESULT_INVALID", `冻结原稿授权素材引用非法：${shotId}`);
  }
  const material = (shot: Record<string, unknown>): boolean => String(shot.photo ?? "").trim().length > 0;
  const appliesToShot = (stage: string, shot: Record<string, unknown>): boolean =>
    stage === "spec" ? !material(shot)
      : stage === "plates" ? !material(shot) && !String(shot.assetRef ?? "").trim()
        : stage === "material-gen" ? material(shot)
          : stage === "voice" ? ((shot.dialogue ?? []) as Record<string, unknown>[]).map((entry) => String(entry.text ?? "")).filter(Boolean).join(" ").length > 0
            : true;
  const globalNotApplicable = (stage: string): boolean =>
    stage === "mux" && normalized["subtitle-mode"] === "burn"
    || stage === "danmaku" && normalized["no-danmaku"] === true
    || stage === "revise" && !String(normalized["revise-note"] ?? "").trim();
  const latest = new Map<string, Record<string, unknown>>();
  for (const raw of records) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new FilmChannelError("RESULT_INVALID", "阶段记录格式非法");
    const row = raw as Record<string, unknown>;
    if (typeof row.stage !== "string" || !row.stage.trim() || /[\x00-\x1f\x7f]/.test(row.stage)
      || row.shotId !== null && typeof row.shotId !== "string" || typeof row.ok !== "boolean" || typeof row.degraded !== "boolean" || typeof row.invoked !== "boolean"
      || row.cached !== undefined && typeof row.cached !== "boolean") throw new FilmChannelError("RESULT_INVALID", "阶段记录字段格式非法");
    if (typeof row.shotId === "string" && !all.has(row.shotId)) throw new FilmChannelError("RESULT_INVALID", `阶段记录镜号不在冻结原稿：${row.shotId}`);
    if (typeof row.shotId === "string" && row.stage !== "render-adopted" && !selected.has(row.shotId)) throw new FilmChannelError("RESULT_INVALID", `阶段记录越出 only 范围：${row.shotId}`);
    const stage = Object.hasOwn(stageAliases, row.stage) ? stageAliases[row.stage]! : row.stage;
    if (stages.includes(stage) || stages.includes("spec") && ["prompt-review", "prompt-package"].includes(stage)) {
      if (perShotStages.has(stage) && row.shotId === null) throw new FilmChannelError("RESULT_INVALID", `逐镜阶段缺镜号：${stage}`);
      if (!perShotStages.has(stage) && row.shotId !== null) throw new FilmChannelError("RESULT_INVALID", `全片阶段不得指定镜号：${stage}`);
    }
    latest.set(`${stage}:${row.shotId ?? ""}`, row);
  }
  const requirePassed = (stage: string, row: Record<string, unknown>, notApplicable = false): void => {
    const declaredPostOnly = normalized["assembly-mode"] === "post-only" && row.assemblyMode === "post-only";
    if (row.ok !== true || row.degraded !== false && !declaredPostOnly || !notApplicable && row.invoked !== true && row.cached !== true) {
      throw new FilmChannelError("RESULT_INVALID", `请求阶段没有通过：${stage}${row.shotId ? `:${row.shotId}` : ""}`);
    }
  };
  for (const stage of new Set(stages)) {
    if (perShotStages.has(stage)) {
      for (const [shotId, shot] of selected) {
        if (preRenderStages.has(stage) && adopted.has(shotId)) continue;
        const applicable = appliesToShot(stage, shot);
        const row = latest.get(`${stage}:${shotId}`);
        if (!row && applicable) throw new FilmChannelError("RESULT_INVALID", `工位结果缺请求阶段：${stage}:${shotId}`);
        if (row) requirePassed(stage, row, !applicable);
      }
      if (stage === "spec") {
        const pendingSelected = [...selected].filter(([shotId]) => !adopted.has(shotId));
        const hasPrompts = pendingSelected.some(([, shot]) => appliesToShot("spec", shot));
        const review = latest.get("prompt-review:");
        const emptyPackage = latest.get("prompt-package:");
        if (hasPrompts && emptyPackage) throw new FilmChannelError("RESULT_INVALID", "非全素材原稿不能声明 prompt-package 不适用");
        if (hasPrompts && !review) throw new FilmChannelError("RESULT_INVALID", "工位结果缺请求阶段：prompt-review");
        if (review) requirePassed("prompt-review", review);
        if (emptyPackage) requirePassed("prompt-package", emptyPackage, true);
      }
    } else {
      const row = latest.get(`${stage}:`);
      const notApplicable = globalNotApplicable(stage) || preRenderStages.has(stage) && [...selected.keys()].every(shotId => adopted.has(shotId));
      if (!row && !notApplicable) throw new FilmChannelError("RESULT_INVALID", `工位结果缺请求阶段：${stage}`);
      if (row) requirePassed(stage, row, notApplicable);
    }
  }
}
export function normalizeFilmJobRequest(stages: string[], options: Record<string, unknown>): { stages: string[]; options: Record<string, string | boolean> } {
  if (!Array.isArray(stages) || !stages.length || stages.some((stage) => !FILM_CLI_STAGES.includes(stage))) {
    throw new FilmChannelError("UNKNOWN_STAGE", "作业阶段必须来自固定影片管线");
  }
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new FilmChannelError("OPTION_INVALID", "作业选项格式非法");
  const normalized: Record<string, string | boolean> = {};
  for (const [original, raw] of Object.entries(options)) {
    const hyphenated = original.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    const key = hyphenated === "unified-narration" ? "narration-unified" : hyphenated;
    if (Object.hasOwn(normalized, key)) throw new FilmChannelError("OPTION_INVALID", `重复选项 ${key}`);
    if (flagOptions.has(key)) {
      if (typeof raw !== "boolean") throw new FilmChannelError("OPTION_INVALID", `${key} 必须是布尔值`);
      normalized[key] = raw;
      continue;
    }
    if (!valueOptions.has(key)) throw new FilmChannelError("OPTION_NOT_ALLOWED", `工位不接受选项 ${original}`);
    if (key === "only") { normalized[key] = normalizeOnly(raw); continue; }
    if (!["string", "number"].includes(typeof raw)) throw new FilmChannelError("OPTION_INVALID", `${key} 格式非法`);
    const value = String(raw);
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
  private readonly artifactStages = new Map<string, { stage: string; shotId: string }>();
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
  private accept(result: unknown, register = true): WorkerArtifact {
    const artifact = result as WorkerArtifact;
    if (!artifact || typeof artifact.ref !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256) || !(artifact.bytes > 0)) throw new FilmChannelError("ARTIFACT_UNVERIFIED", "父服务没有给出有效产物回执");
    const file = join(this.context.workDir, artifact.ref);
    this.ref(file);
    if (!within(this.context.workDir, realpathSync(file)) || statSync(file).size !== artifact.bytes || digest(file) !== artifact.sha256) throw new FilmChannelError("ARTIFACT_CHANGED", "产物字节与父服务回执不符");
    if (register) {
      this.artifacts.set(`film-artifact:${artifact.ref}`, artifact);
      if (artifact.hostedUrl && !this.artifacts.has(artifact.hostedUrl)) this.artifacts.set(artifact.hostedUrl, artifact);
    }
    return artifact;
  }
  async image(prompt: string, anchors: string[], size: string, shotId: string, target: string): Promise<string> {
    const artifact = this.accept(await this.call("image.generate", "plates", shotId, { prompt, anchors: anchors.map((file) => this.reference(file)), size, targetRef: this.ref(target) }));
    this.artifactStages.set(artifact.ref, { stage: "plates", shotId });
    return artifact.hostedUrl ?? `film-artifact:${artifact.ref}`;
  }
  private frozenSource(): Record<string, unknown> {
    if (digest(this.inputPath) !== this.context.inputSha256) throw new FilmChannelError("INPUT_CHANGED", "当前工位原稿字节与冻结输入不符");
    const input: unknown = JSON.parse(readFileSync(this.inputPath, "utf8"));
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new FilmChannelError("INPUT_INVALID", "影片冻结原稿必须是对象");
    return input as Record<string, unknown>;
  }
  private videoReference(ref: string, role: FilmVideoReferenceInput["role"]): FilmVideoReferenceInput {
    if (/^asset:\/\/[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(ref) && role === "reference-image") {
      return { role, ref, sha256: createHash("sha256").update(ref).digest("hex"), hashKind: "asset-uri" };
    }
    const file = resolve(this.context.workDir, ref);
    if (isAbsolute(ref) || this.ref(file) !== ref || !within(this.context.workDir, realpathSync(file)) || !statSync(file).isFile() || statSync(file).size <= 0) {
      throw new FilmChannelError("REFERENCE_INVALID", "影片参考必须绑定本次作业中的非空真实字节");
    }
    return { role, ref, sha256: digest(file), hashKind: "bytes" };
  }
  async video(options: { prompt: string; firstFrame?: string; refs: string[]; seconds: number; generateAudio: boolean; seed?: number; aspect?: string; resolution?: string; stage: string; shotId: string; target: string }): Promise<{ taskId: string; url: string; lastFrame: null; resumed: false; requestInputVerified: true; submissionReceipt: FilmVideoSubmissionReceipt }> {
    const frozen = this.frozenSource();
    if (!Array.isArray(options.refs) || options.refs.length > 3 || options.refs.some((ref) => typeof ref !== "string" || !ref)) throw new FilmChannelError("REFERENCE_INVALID", "影片参考图最多三张，不得静默截断");
    const refs = options.refs.map((ref) => ref.replace(/^film-ref:/, ""));
    const referenceInputs = refs.map((ref) => this.videoReference(ref, "reference-image"));
    const first = options.firstFrame;
    let firstFrame: { hostedUrl: string } | { ref: string } | undefined;
    if (first) {
      if (/^https:\/\//.test(first)) {
        const issued = this.artifacts.get(first);
        if (!issued || issued.hostedUrl !== first) throw new FilmChannelError("URL_NOT_ISSUED", "首帧地址必须由本次父服务签发并绑定产物字节");
        this.accept(issued);
        firstFrame = { hostedUrl: first };
        referenceInputs.unshift({ ...this.videoReference(issued.ref, "first-frame"), requestUriSha256: createHash("sha256").update(first).digest("hex") });
      } else {
        const issued = this.artifacts.get(first);
        const ref = issued?.ref ?? first.replace(/^film-ref:/, "");
        if (issued) this.accept(issued);
        firstFrame = { ref };
        referenceInputs.unshift(this.videoReference(ref, "first-frame"));
      }
    }
    const aspect = options.aspect ?? String(this.context.options.aspect ?? frozen.aspect ?? "9:16");
    const requestedResolution = options.resolution ?? String(this.context.options.resolution ?? frozen.resolution ?? "1080p");
    // 2160p is the local UHD delivery target, not the provider source format.
    const resolution = requestedResolution === "2160p" ? "1080p" : requestedResolution;
    if (!enumOptions.aspect!.includes(aspect) || !enumOptions.resolution!.includes(resolution)) throw new FilmChannelError("OPTION_INVALID", "影片画幅或清晰度非法");
    const params = { prompt: options.prompt, firstFrame, refs, seconds: options.seconds, generateAudio: options.generateAudio,
      seed: options.seed, aspect, resolution, targetRef: this.ref(`${options.target}.provider.mp4`) };
    const result = await this.call("video.generate", options.stage, options.shotId, params);
    const artifact = this.accept(result, false);
    if (!artifact.taskId) throw new FilmChannelError("ARTIFACT_UNVERIFIED", "父服务未返回视频任务回执");
    // A receipt is authority only at this current parent-channel response boundary.
    // Independently retained input/reference hashes and actual sent params prevent
    // an old receipt or a caller-asserted verified flag from granting provenance.
    for (const reference of referenceInputs) {
      if (this.videoReference(reference.ref, reference.role).sha256 !== reference.sha256) throw new FilmChannelError("REFERENCE_CHANGED", "参考字节在视频提交期间发生变化");
    }
    if (digest(this.inputPath) !== this.context.inputSha256) throw new FilmChannelError("INPUT_CHANGED", "原稿字节在视频提交期间发生变化");
    const submissionReceipt = assertFilmVideoSubmissionReceipt((result as { submissionReceipt?: unknown }).submissionReceipt, {
      jobId: this.context.jobId, projectId: this.context.projectId, inputSha256: this.context.inputSha256,
      shotId: options.shotId, stepKey: `${options.stage}:${options.shotId}`, taskId: artifact.taskId,
      artifact: { ref: artifact.ref, sha256: artifact.sha256, bytes: artifact.bytes }, promptSha256: createHash("sha256").update(options.prompt).digest("hex"),
      referenceInputs, aspect, resolution, seconds: options.seconds, generateAudio: options.generateAudio, requestParams: params,
    });
    this.accept(artifact);
    this.artifactStages.set(artifact.ref, { stage: options.stage, shotId: options.shotId });
    return { taskId: artifact.taskId, url: `film-artifact:${artifact.ref}`, lastFrame: null, resumed: false, requestInputVerified: true, submissionReceipt };
  }
  async download(url: string, target: string): Promise<string> {
    const artifact = this.artifacts.get(url);
    if (!artifact) throw new FilmChannelError("URL_NOT_ISSUED", "工位不得直接下载未签发的地址");
    this.accept(artifact);
    if (this.ref(target) !== artifact.ref) {
      const origin = this.artifactStages.get(artifact.ref);
      const stage = origin?.stage ?? (url.startsWith("film-artifact:") && target.endsWith(".mp4") ? (this.context.stages.includes("videos") ? "videos" : "material-gen") : "plates");
      const copied = this.accept(await this.call("media.fetch", stage, origin?.shotId ?? null, { ref: artifact.ref, targetRef: this.ref(target) }), false);
      if (copied.ref !== this.ref(target) || copied.sha256 !== artifact.sha256 || copied.bytes !== artifact.bytes) throw new FilmChannelError("ARTIFACT_CHANGED", "复制产物没有保留父服务签发的原始字节");
      this.accept(copied);
      if (origin) this.artifactStages.set(copied.ref, origin);
    }
    return target;
  }
  /** Compatibility entry point: standard production preserves original native clocks and bytes. */
  async normalizeVideo(_target: string, _targetSec: number, _stage: string, _shotId: string): Promise<{ factor: number; from: number; to: number }> {
    throw new FilmChannelError("STANDARD_NATIVE_RETIME_FORBIDDEN", "标准制作必须保留原始渲染时长，不接受变速或时长归一化");
  }
  get identityVisionAvailable(): boolean { return this.context.characterVisionAvailable === true; }
  async identityReview(request: CharacterIdentityReviewRequest): Promise<CharacterIdentityEvidence> {
    if (!this.identityVisionAvailable) throw new FilmChannelError("IDENTITY_VISION_UNAVAILABLE", "父服务未声明专用人物视觉评审可用");
    const frozen = this.frozenSource();
    const retained = JSON.parse(JSON.stringify(request)) as CharacterIdentityReviewRequest;
    const { requestHash, ...body } = retained;
    if (retained.schemaVersion !== "workloom.character-identity-review/v1" || retained.purpose !== "identity-and-explicit-wardrobe"
      || requestHash !== characterReleaseHash(body) || retained.projectId !== this.context.projectId || !Array.isArray(retained.frames) || retained.frames.length < 2
      || retained.frames.some((frame) => !Number.isFinite(frame.atSec) || frame.atSec < 0)
      || new Set(retained.frames.map((frame) => frame.path)).size !== retained.frames.length || new Set(retained.frames.map((frame) => frame.atSec)).size < 2) {
      throw new FilmChannelError("IDENTITY_REVIEW_INVALID", "专用人物评审请求未绑定本次项目及完整合同");
    }
    const check = (fingerprint: { path: string; sha256: string }): string => {
      const ref = this.ref(fingerprint.path);
      const file = resolve(this.context.workDir, ref);
      if (!within(this.context.workDir, realpathSync(file)) || !statSync(file).isFile() || statSync(file).size <= 0 || digest(file) !== fingerprint.sha256) {
        throw new FilmChannelError("IDENTITY_REVIEW_CHANGED", "专用人物评审视频或抽帧字节与当前请求不符");
      }
      return ref;
    };
    const clipRef = check(retained.clip);
    const frames = retained.frames.map((frame) => ({ ref: check(frame), sha256: frame.sha256, atSec: frame.atSec }));
    const referenceRef = this.reference(retained.referenceImage.path);
    if (digest(join(this.context.workDir, referenceRef)) !== retained.referenceImage.sha256) throw new FilmChannelError("IDENTITY_REVIEW_CHANGED", "登记人物基准图字节与评审请求不符");
    const origin = this.artifactStages.get(clipRef);
    if (origin && origin.shotId !== retained.shotId) throw new FilmChannelError("IDENTITY_REVIEW_INVALID", "人物评审产物来自另一个镜头");
    const shot = (Array.isArray(frozen.shots) ? frozen.shots : []).find((raw) => raw && typeof raw === "object" && !Array.isArray(raw) && raw.shotId === retained.shotId) as Record<string, unknown> | undefined;
    if (!shot) throw new FilmChannelError("IDENTITY_REVIEW_INVALID", "人物评审镜号不在冻结原稿内");
    const stage = origin?.stage ?? (String(shot.photo ?? "").trim() || retained.context?.sourceStage === "material-gen"
      || !this.context.stages.includes("videos") && this.context.stages.includes("material-gen") ? "material-gen" : "videos");
    const result = await this.call("gate.review", stage, retained.shotId, { stage: "shot", projectId: retained.projectId,
      identityReview: { purpose: "identity-and-explicit-wardrobe", request: retained, clipRef, frames, referenceRef, requestHash },
      context: { shotId: retained.shotId, purpose: "identity-and-explicit-wardrobe" } }) as { identityEvidence?: CharacterIdentityEvidence };
    this.frozenSource(); check(retained.clip); for (const frame of retained.frames) check(frame);
    if (digest(join(this.context.workDir, referenceRef)) !== retained.referenceImage.sha256) throw new FilmChannelError("IDENTITY_REVIEW_CHANGED", "专用评审期间基准图复制字节发生变化");
    const evidence = result?.identityEvidence;
    if (!evidence?.visualReview?.request || !evidence.visualReview.verdict || characterReleaseHash(evidence.visualReview.request) !== characterReleaseHash(retained)) {
      throw new FilmChannelError("IDENTITY_REVIEW_UNVERIFIED", "父服务没有给出绑定本次专用请求的身份评审证据");
    }
    const recomputed = adaptCharacterVisualVerdict({ request: retained, verdict: evidence.visualReview.verdict });
    if (characterReleaseHash(evidence) !== characterReleaseHash(recomputed)) throw new FilmChannelError("IDENTITY_REVIEW_UNVERIFIED", "父服务身份评审证据与当前请求重算不符");
    return recomputed;
  }
  async review(options: Omit<ProducerGateOptions, "contracts">): Promise<ProducerVerdict> {
    const aliases: Record<string, string> = { script: "spec", prompt: "spec", keyframe: "plates", shot: "videos" };
    let stage = aliases[options.stage] ?? options.stage;
    if (options.stage === "shot") {
      if (options.context?.sourceStage === "material-gen") stage = "material-gen";
      else if (!this.context.stages.includes("videos") && this.context.stages.includes("material-gen")) stage = "material-gen";
    }
    const shotId = typeof options.context?.shotId === "string" ? options.context.shotId : null;
    const post = POST_RENDER_STAGES.has(options.stage);
    if (post) this.frozenSource();
    const retained = post ? options.artifacts.map((artifact) => {
      const ref = this.ref(artifact.path), file = resolve(this.context.workDir, ref), info = statSync(file);
      if (!within(this.context.workDir, realpathSync(file)) || !info.isFile() || info.size <= 0) throw new FilmChannelError("ARTIFACT_UNVERIFIED", "后期源或输出必须是本次作业中的非空文件");
      return { file, sha256: digest(file), bytes: info.size };
    }) : [];
    const params = { stage: options.stage, projectId: options.projectId, artifacts: options.artifacts.map((artifact) => ({ ref: this.ref(artifact.path), kind: artifact.kind, note: artifact.note, probe: artifact.probe })),
      deterministic: options.deterministic, context: options.context,
      ...(!post ? { referenceImages: options.referenceImages?.map((file) => this.reference(file)), requiredCheckIds: options.requiredCheckIds,
        minScore: options.minScore, rubric: options.rubric } : {}) };
    const verdict = await this.call("gate.review", stage, shotId, params) as ProducerVerdict;
    if (!verdict || verdict.stage !== options.stage || typeof verdict.approved !== "boolean") throw new FilmChannelError("REVIEW_UNVERIFIED", "父服务裁决未绑定本次请求阶段");
    if (post) {
      this.frozenSource();
      for (const artifact of retained) {
        if (statSync(artifact.file).size !== artifact.bytes || digest(artifact.file) !== artifact.sha256) throw new FilmChannelError("ARTIFACT_CHANGED", "后期接收期间源或输出字节发生变化");
      }
      if (verdict.qualityReviewed !== false || verdict.score !== null || verdict.via !== "deterministic" || verdict.rerun !== false
        || !Array.isArray(verdict.hardFailures) || !verdict.hardFailures.every((failure) => typeof failure === "string")
        || verdict.status !== (verdict.approved ? "passed" : "failed") || verdict.approved !== (verdict.hardFailures.length === 0)) {
        throw new FilmChannelError("REVIEW_UNVERIFIED", "父服务后期回执缺实际加工终态或仍声明品质裁决");
      }
    } else if (!verdict.contractHash) throw new FilmChannelError("REVIEW_UNVERIFIED", "父服务裁决未绑定作者合同");
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
  finish(records: Array<{ stage: string; shotId: string | null; ok: boolean; artifact: string | null; degraded: boolean; invoked: boolean; cached?: boolean; evidence?: Record<string, unknown> }>, complete: boolean, verifiedAdoptedShotIds: readonly string[] = []): void {
    const stageRecords = records.map(({ stage, shotId, ok, degraded, invoked, cached, evidence }) => ({ stage, shotId, ok, degraded, invoked, cached: cached === true,
      ...(evidence?.assemblyMode === "post-only" ? { assemblyMode: "post-only" } : {}) }));
    if (complete) assertFilmStageCoverage(this.context.stages, this.context.options, JSON.parse(readFileSync(this.inputPath, "utf8")), stageRecords, verifiedAdoptedShotIds);
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
