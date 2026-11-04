/** Read-only prompt delivery. This receipt cannot qualify, submit or render media. */
import { createHmac, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { archiveWorkDir } from "./archive-host.js";
import { canonicalRenderJson, renderSha256 } from "./gen/compiled-request.js";
import { scopedQuery, type AppPool, type Scope } from "./gen/db.js";
import { verifyMarketingFacts } from "./marketing-authority.js";

const SCHEMA = "workloom.studio-prompt-review/v1" as const;
const SHA = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9_-]{1,160}$/u;
const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024;
const DEFERRED_GATES = ["G5_PORTRAIT", "G7_FINAL"] as const;
type Pipeline = "marketing" | "narrative";
type FactReference = { ref: string; sha256: string };
type ReviewIdentity = Scope & { projectId: string; runId: string };
type StageRow = {
  id: string; run_id: string; attempt: number; status: string;
  output_ref: string | null; output_sha256: string | null; kind: Pipeline;
};
type ReviewStageQuery = { app: AppPool; scope: Scope; projectId: string; runId: string };
export type StudioPromptReviewShot = {
  shotId: string; durationSec: number; prompt: string; promptSha256: string; fields: unknown;
};
export type StudioPromptReview = ReviewIdentity & {
  schemaVersion: typeof SCHEMA; issuer: "workloom.studio-worker"; purpose: "prompt-review";
  state: "prompt_review_ready"; stageRunId: string; attempt: number; pipeline: Pipeline;
  targetSeconds: number; plannedSeconds: number; intentSha256: string;
  renderAuthorized: false; deferredGates: typeof DEFERRED_GATES;
  reviewModel: string; reviewReport: string; reviewReportSha256: string;
  promptsSha256: string; shots: StudioPromptReviewShot[]; marketingFacts: FactReference | null;
  signature: string;
};

export class StudioPromptReviewError extends Error {
  constructor(readonly code: "PROMPT_REVIEW_NOT_READY" | "PROMPT_REVIEW_UNVERIFIED" | "PROMPT_REVIEW_SIGNING_UNAVAILABLE", message: string) {
    super(`${code}: ${message}`);
    this.name = "StudioPromptReviewError";
  }
}
const unverified = (message: string): never => { throw new StudioPromptReviewError("PROMPT_REVIEW_UNVERIFIED", message); };
const notReady = (): never => { throw new StudioPromptReviewError("PROMPT_REVIEW_NOT_READY", "当前项目还没有已核实的 G6 提示词工作单"); };
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const targetValid = (seconds: unknown): seconds is number => typeof seconds === "number" && Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= 300;

export function assertStudioPromptReviewSigning(env = process.env): void {
  if (Buffer.byteLength(env.WORKLOOM_RENDER_SIGNING_SECRET ?? "") < 32) {
    throw new StudioPromptReviewError("PROMPT_REVIEW_SIGNING_UNAVAILABLE", "当前服务未配置有效的签发密钥");
  }
}
function mac(payload: Omit<StudioPromptReview, "signature">, env: NodeJS.ProcessEnv): Buffer {
  assertStudioPromptReviewSigning(env);
  return createHmac("sha256", env.WORKLOOM_RENDER_SIGNING_SECRET!)
    .update(SCHEMA).update("\0").update(canonicalRenderJson(payload)).digest();
}

export function captureStudioPromptReviewShots(rows: readonly Record<string, unknown>[]): StudioPromptReviewShot[] {
  if (rows.length < 1 || rows.length > 100) unverified("G6 镜头数无效");
  const seen = new Set<string>();
  return rows.map(row => {
    const shotId = row.shotId ?? row.shot_id;
    const durationSec = row.duration ?? row.durationSec;
    const prompt = typeof row.prompt === "string" ? row.prompt.trim() : "";
    if (typeof shotId !== "string" || !ID.test(shotId) || seen.has(shotId)
      || !targetValid(durationSec) || !prompt || row.degraded === true) {
      return unverified("G6 的镜头标识、时长或提示词无效");
    }
    seen.add(shotId);
    return { shotId, durationSec, prompt, promptSha256: renderSha256(prompt),
      fields: record(row.fields) ? structuredClone(row.fields) : null };
  });
}

export function assertStudioPromptReviewText(report: string, shots: readonly StudioPromptReviewShot[]): void {
  const blocks = [...report.matchAll(/^```markdown\r?\n([\s\S]*?)\r?\n```[ \t]*$/gmu)];
  if (!shots.length || blocks.length !== shots.length || shots.some((shot, index) => blocks[index]?.[1] !== shot.prompt
    || !report.includes(`| ${shot.shotId} | ${shot.durationSec}s |`)
    || shot.promptSha256 !== renderSha256(shot.prompt))) {
    unverified("提示词原文、时长或顺序与送审的完整 G6 正文不一致");
  }
}

export function studioPromptReviewRef(attempt: number): string {
  return `stages/prompt_review/attempt-${attempt}.prompt-review.json`;
}
function latestStage({ app, scope, projectId }: ReviewStageQuery): Promise<StageRow[]> {
  return scopedQuery<StageRow>(app, scope, `SELECT r.id,r.run_id,r.attempt,r.status,r.output_ref,r.output_sha256,p.kind
    FROM production_stage_runs r JOIN video_projects p ON p.id=r.project_id AND p.workspace_id=r.workspace_id
    JOIN workspaces w ON w.id=p.workspace_id AND w.tenant_id=$1
    WHERE r.tenant_id=$1 AND r.workspace_id=$2 AND r.project_id=$3 AND r.stage_id='prompt_review'
      AND r.pipeline_run_id IS NULL ORDER BY r.attempt DESC LIMIT 1`, [scope.tenantId, scope.workspaceId, projectId]);
}

export async function isStudioPromptReviewProject(input: { app: AppPool; scope: Scope; projectId: string }): Promise<boolean> {
  const rows = await scopedQuery<{ prompt_only: boolean }>(input.app, input.scope, `SELECT (
      EXISTS (SELECT 1 FROM production_stage_runs r WHERE r.tenant_id=$1 AND r.workspace_id=$2
        AND r.project_id=$3 AND r.stage_id='prompt_review' AND r.pipeline_run_id IS NULL)
      OR EXISTS (SELECT 1 FROM biz_events e WHERE e.tenant_id=$1 AND e.workspace_id=$2
        AND e.payload->'object'->>'type'='video_project' AND e.payload->'object'->>'id'=$3
        AND e.payload->'decision'->>'action'='video.project.create'
        AND e.payload->'decision'->'after'->>'purpose'='prompt-review')
    ) AS prompt_only
    FROM video_projects p JOIN workspaces w ON w.id=p.workspace_id AND w.tenant_id=$1
    WHERE p.workspace_id=$2 AND p.id=$3`, [input.scope.tenantId, input.scope.workspaceId, input.projectId]);
  return rows[0]?.prompt_only === true;
}

export async function issueStudioPromptReview(input: ReviewStageQuery & {
  attempt: number; pipeline: Pipeline; targetSeconds: number; rawIntent: string;
  reviewReport: string; reviewModel: string; shots: StudioPromptReviewShot[];
  marketingFacts: FactReference | null; env?: NodeJS.ProcessEnv;
}): Promise<StudioPromptReview> {
  const [row] = await latestStage(input);
  if (!row || row.run_id !== input.runId || row.attempt !== input.attempt || row.kind !== input.pipeline
    || row.status !== "running" || !ID.test(row.id) || !targetValid(input.targetSeconds)
    || !input.reviewModel.trim() || input.reviewModel.length > 200 || !input.rawIntent.trim()
    || (input.pipeline === "marketing") !== Boolean(input.marketingFacts)) {
    return unverified("G6 回执没有绑定当前执行或缺少本轮事实证据");
  }
  assertStudioPromptReviewText(input.reviewReport, input.shots);
  const payload: Omit<StudioPromptReview, "signature"> = {
    schemaVersion: SCHEMA, issuer: "workloom.studio-worker", purpose: "prompt-review",
    state: "prompt_review_ready", ...input.scope, projectId: input.projectId, runId: input.runId,
    stageRunId: row.id, attempt: row.attempt, pipeline: input.pipeline, targetSeconds: input.targetSeconds,
    plannedSeconds: input.shots.reduce((total, shot) => total + shot.durationSec, 0),
    intentSha256: renderSha256(input.rawIntent), renderAuthorized: false, deferredGates: DEFERRED_GATES,
    reviewModel: input.reviewModel, reviewReport: input.reviewReport, reviewReportSha256: renderSha256(input.reviewReport),
    promptsSha256: renderSha256(canonicalRenderJson(input.shots)), shots: input.shots, marketingFacts: input.marketingFacts,
  };
  return { ...payload, signature: mac(payload, input.env ?? process.env).toString("base64url") };
}

async function readArchiveJson(root: string, ref: string, expected: string): Promise<unknown> {
  const file = path.join(root, ref);
  if (await realpath(file) !== file) unverified("提示词工作单路径不可核验");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    const { size } = stat;
    if (!stat.isFile() || !size || size > MAX_ARCHIVE_BYTES) unverified("提示词工作单文件为空或过大");
    const bytes = Buffer.alloc(size + 1);
    let read = 0;
    while (read < bytes.length) {
      const { bytesRead } = await handle.read(bytes, read, bytes.length - read, read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    const data = bytes.subarray(0, read);
    if (data.length !== size || renderSha256(data) !== expected) unverified("提示词工作单字节与服务台账摘要不一致");
    return JSON.parse(data.toString("utf8")) as unknown;
  } finally { await handle.close(); }
}

export async function readStudioPromptReview(input: ReviewStageQuery & {
  env?: NodeJS.ProcessEnv; workDir?: string;
}): Promise<StudioPromptReview> {
  const { scope, projectId, runId } = input;
  const env = input.env ?? process.env;
  if (![scope.workspaceId, projectId, runId].every(value => ID.test(value))) return notReady();
  const [row] = await latestStage(input);
  if (!row || row.status !== "done" || row.run_id !== runId) return notReady();
  const outputRef = `stages/prompt_review/attempt-${row.attempt}.output.json`;
  if (row.output_ref !== outputRef || !row.output_sha256 || !SHA.test(row.output_sha256)) return unverified("G6 档案台账摘要无效");
  try {
    const base = await realpath(input.workDir ?? archiveWorkDir(env));
    const root = path.join(base, "archive", scope.workspaceId, projectId);
    if (await realpath(root) !== root) return unverified("G6 项目档案路径不可核验");
    const output = await readArchiveJson(root, outputRef, row.output_sha256);
    const ref = studioPromptReviewRef(row.attempt);
    if (!record(output) || output.state !== "prompt_review_ready" || output.renderAuthorized !== false
      || output.promptReviewRef !== ref || typeof output.promptReviewSha256 !== "string"
      || !SHA.test(output.promptReviewSha256)) return unverified("G6 归档引用与当前执行不符");
    const value = await readArchiveJson(root, ref, output.promptReviewSha256);
    if (!record(value) || typeof value.signature !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value.signature)) {
      return unverified("G6 提示词签名结构无效");
    }
    const signed = value as unknown as StudioPromptReview;
    const { signature, ...payload } = signed;
    if (payload.schemaVersion !== SCHEMA || payload.issuer !== "workloom.studio-worker" || payload.purpose !== "prompt-review"
      || payload.state !== "prompt_review_ready" || payload.renderAuthorized !== false || payload.projectId !== projectId
      || payload.runId !== runId || payload.stageRunId !== row.id || payload.attempt !== row.attempt
      || payload.tenantId !== scope.tenantId || payload.workspaceId !== scope.workspaceId || payload.pipeline !== row.kind
      || canonicalRenderJson(payload.deferredGates) !== canonicalRenderJson(DEFERRED_GATES)
      || !timingSafeEqual(mac(payload, env), Buffer.from(signature, "base64url"))) {
      return unverified("G6 提示词签名或项目身份不匹配");
    }
    if (payload.reviewReportSha256 !== renderSha256(payload.reviewReport)
      || payload.promptsSha256 !== renderSha256(canonicalRenderJson(payload.shots))) return unverified("G6 正文摘要不符");
    assertStudioPromptReviewText(payload.reviewReport, payload.shots);
    if (payload.pipeline === "marketing") {
      if (!payload.marketingFacts) return unverified("营销提示词缺少本轮事实证据");
      await verifyMarketingFacts({ root, ...payload.marketingFacts, scope: { ...scope, projectId, runId, attempt: row.attempt },
        stageId: "prompt_review", intentSha256: payload.intentSha256, shots: payload.shots });
    }
    const [current] = await latestStage(input);
    if (current?.id !== row.id || current.output_sha256 !== row.output_sha256 || current.status !== "done") return notReady();
    return signed;
  } catch (error) {
    if (error instanceof StudioPromptReviewError) throw error;
    return unverified("当前 G6 提示词归档缺失或无法完整核验");
  }
}
