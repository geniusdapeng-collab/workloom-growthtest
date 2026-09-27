/** Authenticated CLI adapter. Only the service can compile, qualify and submit a production request. */
import { createHash } from "node:crypto";
export interface ServiceShot { shotId: string; durationSec: number; prompt: string; fields: Record<string, unknown>; promptSha256: string }
export interface ServiceShotList { projectId: string; sourceStageRunId: string; sourceAttempt: number; promptsSha256: string; shots: ServiceShot[] }
export interface QualifiedShot {
  qualificationId: string; qualificationToken: string; scriptId: string; scriptVersion: number; modelId: string;
  params: Record<string, unknown>; mode: "auto"; requestHash: string; payloadHash: string; promptSha256: string; expiresAt: string;
}
export interface ProductionShotResult {
  shotId: string; seconds: number; status: "ready" | "submitted" | "rendering" | "done" | "failed" | "unknown" | "unverified";
  sourceStageRunId: string; sourceAttempt: number; promptSha256: string;
  scriptId?: string; scriptVersion?: number; qualificationId?: string; requestHash?: string; payloadHash?: string;
  jobId?: string; taskId?: string; assetId?: string | null; localPath?: string | null; resultUrl?: string | null;
  estimatedCny?: number; actualCny?: number | null; mock?: boolean; error?: string;
}
export interface ProductionProjectResult {
  mode: "service-production"; projectId: string; modelId: string; sourceStageRunId: string; sourceAttempt: number;
  estimatedCny: number; status: "running" | "done" | "failed" | "unverified"; shots: ProductionShotResult[];
}
export class ProductionClientError extends Error {
  constructor(readonly code: string, message: string) { super(`${code}: ${message}`); this.name = "ProductionClientError"; }
}
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const obj = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (obj(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export class ProductionClient {
  private readonly url: string;
  private readonly secrets: Set<string>;
  constructor(private readonly options: { api: string; token: string; fetchImpl?: typeof fetch; timeoutMs?: number }) {
    const api = new URL(options.api);
    if (api.username || api.password || api.search || api.hash || (api.protocol !== "https:" && !(api.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(api.hostname)))) {
      throw new ProductionClientError("API_ENDPOINT_INVALID", "Use HTTPS or a local loopback service without URL credentials");
    }
    if (!options.token.trim() || /[\r\n]/.test(options.token)) throw new ProductionClientError("AUTH_REQUIRED", "Set WORKLOOM_TOKEN for the authorized workspace");
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) throw new ProductionClientError("TIMEOUT_INVALID", "Request timeout must be positive");
    this.url = api.toString().replace(/\/$/, ""); this.secrets = new Set([options.token]);
  }
  safeError(error: unknown): string {
    let message = error instanceof Error ? error.message : String(error);
    for (const secret of this.secrets) message = message.split(secret).join("[redacted]");
    return message.slice(0, 1200);
  }
  async request<T>(route: string, input: unknown, method: "GET" | "POST" = "POST"): Promise<T> {
    if (!/^video\.(production|render|gen)\.[A-Za-z]+$/.test(route)) throw new ProductionClientError("ROUTE_INVALID", "Only production service routes are permitted");
    const suffix = method === "GET" ? `?input=${encodeURIComponent(JSON.stringify(input))}` : "";
    let response: Response;
    try {
      response = await (this.options.fetchImpl ?? fetch)(`${this.url}/trpc/${route}${suffix}`, { method, redirect: "error",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.options.token}` },
        ...(method === "POST" ? { body: JSON.stringify(input) } : {}), signal: AbortSignal.timeout(this.options.timeoutMs ?? 180_000) });
    } catch (error) { throw new ProductionClientError("SERVICE_OUTCOME_UNKNOWN", this.safeError(error)); }
    const bytes = await response.text();
    if (bytes.length > 8_000_000) throw new ProductionClientError("SERVICE_RESPONSE_INVALID", "Response exceeds the complete parsing budget");
    let envelope: unknown;
    try { envelope = JSON.parse(bytes); } catch { throw new ProductionClientError("SERVICE_RESPONSE_INVALID", `HTTP ${response.status}: invalid JSON response`); }
    if (!response.ok || !obj(envelope) || envelope.error) {
      const detail = obj(envelope) && obj(envelope.error) && typeof envelope.error.message === "string" ? envelope.error.message : `HTTP ${response.status}`;
      throw new ProductionClientError("SERVICE_REJECTED", this.safeError(detail));
    }
    if (!obj(envelope.result) || !("data" in envelope.result)) throw new ProductionClientError("SERVICE_RESPONSE_INVALID", "Missing tRPC result.data");
    return envelope.result.data as T;
  }
  async shots(projectId: string): Promise<ServiceShotList> {
    const value = await this.request<ServiceShotList>("video.production.shots", { projectId }, "GET");
    if (!obj(value) || value.projectId !== projectId || typeof value.sourceStageRunId !== "string" || !value.sourceStageRunId
      || !Number.isInteger(value.sourceAttempt) || value.sourceAttempt <= 0 || !hash(value.promptsSha256) || !Array.isArray(value.shots) || !value.shots.length) {
      throw new ProductionClientError("SOURCE_INVALID", "Service archive identity or shot registry is invalid");
    }
    const seen = new Set<string>();
    for (const shot of value.shots) {
      if (!obj(shot) || typeof shot.shotId !== "string" || !shot.shotId || seen.has(shot.shotId) || !Number.isInteger(shot.durationSec) || shot.durationSec <= 0
        || typeof shot.prompt !== "string" || !shot.prompt.trim() || !obj(shot.fields) || sha(shot.prompt) !== shot.promptSha256) throw new ProductionClientError("SOURCE_INVALID", "Shot identity, planned duration or original bytes are invalid");
      seen.add(shot.shotId);
    }
    return value;
  }
  async qualify(projectId: string, shot: ServiceShot, modelId: string, params: Record<string, unknown>): Promise<QualifiedShot> {
    const finalParams = { ...params, durationSec: shot.durationSec };
    const q = await this.request<QualifiedShot>("video.production.qualifyShot", { projectId, shotId: shot.shotId, modelId, params: finalParams, mode: "auto" });
    if (typeof q?.qualificationToken === "string" && q.qualificationToken) this.secrets.add(q.qualificationToken);
    if (!q || typeof q.qualificationToken !== "string" || !q.qualificationToken || typeof q.qualificationId !== "string" || !q.qualificationId
      || typeof q.scriptId !== "string" || !q.scriptId || !Number.isInteger(q.scriptVersion) || q.scriptVersion <= 0
      || q.modelId !== modelId || q.mode !== "auto" || q.promptSha256 !== shot.promptSha256 || !hash(q.requestHash) || !hash(q.payloadHash)
      || stable(q.params) !== stable(finalParams) || !Number.isFinite(Date.parse(q.expiresAt))) {
      throw new ProductionClientError("QUALIFICATION_MISMATCH", "The service qualified different source bytes or generation parameters");
    }
    return q;
  }
}

/** No automatic re-submit after timeout, rejection or malformed response; resume through the same service archive. */
export async function renderServiceProject(input: {
  client: ProductionClient; projectId: string; modelId: string; only?: string[]; params?: Record<string, unknown>;
  maxEstimatedCny?: number; pollRounds?: number; pollIntervalMs?: number;
  onProgress?: (result: ProductionProjectResult) => void | Promise<void>; wait?: (ms: number) => Promise<void>;
}): Promise<ProductionProjectResult> {
  if (!input.projectId.trim() || !input.modelId.trim()) throw new ProductionClientError("REQUEST_INVALID", "Project and model are required");
  const rounds = input.pollRounds ?? 80, interval = input.pollIntervalMs ?? 15_000;
  if (!Number.isInteger(rounds) || rounds < 0 || rounds > 240 || !Number.isFinite(interval) || interval < 0 || interval > 60_000
    || (input.maxEstimatedCny !== undefined && (!Number.isFinite(input.maxEstimatedCny) || input.maxEstimatedCny < 0))) throw new ProductionClientError("LIMIT_INVALID", "Polling and budget limits are invalid");
  if (input.params?.durationSec !== undefined) throw new ProductionClientError("DURATION_SOURCE_REQUIRED", "Duration is loaded from the service archive");
  const source = await input.client.shots(input.projectId);
  const only = input.only ?? [];
  if (new Set(only).size !== only.length || only.some(id => !source.shots.some(shot => shot.shotId === id))) throw new ProductionClientError("SHOT_SCOPE_INVALID", "Selected shots are missing or repeated");
  const shots = only.length ? source.shots.filter(shot => only.includes(shot.shotId)) : source.shots;
  if (shots.length > 100) throw new ProductionClientError("SHOT_SCOPE_TOO_LARGE", "Run at most 100 registered shots per batch with --only");
  const result: ProductionProjectResult = { mode: "service-production", projectId: input.projectId, modelId: input.modelId,
    sourceStageRunId: source.sourceStageRunId, sourceAttempt: source.sourceAttempt, estimatedCny: 0, status: "running",
    shots: shots.map(shot => ({ shotId: shot.shotId, seconds: shot.durationSec, status: "ready", sourceStageRunId: source.sourceStageRunId,
      sourceAttempt: source.sourceAttempt, promptSha256: shot.promptSha256 })) };
  const persist = async (): Promise<void> => { await input.onProgress?.(structuredClone(result)); };
  // Quote every selected shot before the first review or generation side effect.
  for (const row of result.shots) {
    const quote = await input.client.request<{ allowed: boolean; estimate: { cny: number }; reason?: string }>("video.gen.estimate", { modelId: input.modelId, seconds: row.seconds }, "GET");
    if (quote?.allowed !== true || !Number.isFinite(quote.estimate?.cny) || quote.estimate.cny < 0) throw new ProductionClientError("BUDGET_UNVERIFIED", quote?.reason || "Service estimate is absent or blocked");
    row.estimatedCny = quote.estimate.cny; result.estimatedCny += quote.estimate.cny;
  }
  if (input.maxEstimatedCny !== undefined && result.estimatedCny > input.maxEstimatedCny) throw new ProductionClientError("BUDGET_EXCEEDED", `Estimate ${result.estimatedCny} exceeds ${input.maxEstimatedCny}`);
  await persist();
  for (const [index, shot] of shots.entries()) {
    const row = result.shots[index]!; let submitting = false;
    try {
      const q = await input.client.qualify(input.projectId, shot, input.modelId, input.params ?? {});
      const current = await input.client.shots(input.projectId);
      if (current.sourceStageRunId !== source.sourceStageRunId || current.sourceAttempt !== source.sourceAttempt || current.promptsSha256 !== source.promptsSha256
        || stable(current.shots) !== stable(source.shots)) throw new ProductionClientError("SOURCE_CHANGED", "Service preproduction changed after the batch was quoted; no new generation was submitted");
      Object.assign(row, { scriptId: q.scriptId, scriptVersion: q.scriptVersion, qualificationId: q.qualificationId, requestHash: q.requestHash, payloadHash: q.payloadHash });
      await persist(); submitting = true;
      const reply = await input.client.request<{ jobId: string; taskId: string; mock: boolean; durationSec: number }>("video.render.submit", { qualificationToken: q.qualificationToken });
      if (!reply || typeof reply.jobId !== "string" || !reply.jobId || typeof reply.taskId !== "string" || !reply.taskId
        || typeof reply.mock !== "boolean" || reply.durationSec !== shot.durationSec) throw new ProductionClientError("SUBMISSION_RECEIPT_INVALID", "Submission receipt is incomplete or duration changed");
      Object.assign(row, { jobId: reply.jobId, taskId: reply.taskId, mock: reply.mock, status: reply.mock ? "unverified" : "submitted" });
      if (reply.mock) { row.error = "MOCK_RESULT: no real generation was accepted"; result.status = "unverified"; await persist(); return result; }
      await persist();
    } catch (error) {
      row.status = submitting ? "unknown" : "unverified"; row.error = input.client.safeError(error); result.status = "unverified"; await persist(); return result;
    }
  }
  const wait = input.wait ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  for (let round = 0; round < rounds && result.shots.some(row => ["submitted", "rendering"].includes(row.status)); round++) {
    await wait(interval);
    try {
      await input.client.request("video.render.poll", { limit: 100 });
      const jobs = await input.client.request<Array<Record<string, unknown>>>("video.gen.jobs", { projectId: input.projectId, limit: 100 }, "GET");
      if (!Array.isArray(jobs)) throw new ProductionClientError("JOB_RESPONSE_INVALID", "Service jobs response is not an array");
      for (const row of result.shots) {
        if (!["submitted", "rendering"].includes(row.status)) continue;
        const matches = jobs.filter(job => job.id === row.jobId); if (!matches.length) continue;
        const job = matches[0]!;
        if (matches.length !== 1 || job.project_id !== input.projectId || job.script_id !== row.scriptId || job.script_version !== row.scriptVersion || job.task_id !== row.taskId || job.mock !== false) throw new ProductionClientError("JOB_IDENTITY_MISMATCH", "Job receipt does not match the submitted service revision");
        if (job.status === "done") {
          if (typeof job.asset_id !== "string" || !job.asset_id || typeof job.local_path !== "string" || !job.local_path) throw new ProductionClientError("MEDIA_UNVERIFIED", "Generation has no persisted media receipt");
          row.status = "done"; row.assetId = job.asset_id; row.localPath = job.local_path; row.resultUrl = typeof job.result_url === "string" ? job.result_url : null;
          row.actualCny = typeof job.actual_cny === "number" && Number.isFinite(job.actual_cny) ? job.actual_cny : null;
        } else if (job.status === "failed") { row.status = "failed"; row.error = "SERVICE_GENERATION_FAILED: inspect the service job receipt before retry"; }
        else if (["submitted", "rendering"].includes(String(job.status))) row.status = job.status as "submitted" | "rendering";
        else throw new ProductionClientError("JOB_STATUS_UNVERIFIED", `Unrecognized service job state ${String(job.status)}`);
      }
      await persist();
    } catch (error) {
      for (const row of result.shots.filter(row => ["submitted", "rendering"].includes(row.status))) { row.status = "unknown"; row.error = input.client.safeError(error); }
      result.status = "unverified"; await persist(); return result;
    }
  }
  const unresolved = result.shots.filter(row => ["submitted", "rendering"].includes(row.status));
  for (const row of unresolved) { row.status = "unknown"; row.error = "POLL_LIMIT: generation may still be running; inspect its existing job, do not re-submit"; }
  result.status = result.shots.every(row => row.status === "done") ? "done" : result.shots.some(row => row.status === "failed") ? "failed" : "unverified";
  await persist(); return result;
}
