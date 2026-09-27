/** 最终供应商请求的唯一编译器：监制看到的 JSON 字节就是适配器 POST 的字节。 */
import { createHash } from "node:crypto";
import type { GenRequest } from "@workloom/base/model-router";
import type { MediaModel, VideoGenParams } from "./types.js";
import type { Scope } from "./db.js";
import type { RenderScriptLike } from "./submit.js";
import { SubmissionError, submissionRequestHash } from "./submission-ledger.js";
import { resolveProviderModel } from "./catalog.js";

export interface CompiledProviderRequest {
  schemaVersion: "workloom.provider-request/v1";
  provider: string;
  providerModel: string;
  endpoint: string;
  method: "POST";
  body: Record<string, unknown>;
  bodyJson: string;
  payloadHash: string;
}
export interface ProviderEndpointOptions { baseUrl?: string; webhookUrl?: string }

/** 数组保序、对象键排序；拒绝 JSON 不能忠实表达的输入。 */
export function canonicalRenderJson(value: unknown): string {
  submissionRequestHash(value); // 与幂等账本共享输入有效性规则。
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(entry => entry === undefined ? null : sort(entry));
    if (item && typeof item === "object") {
      const out: Record<string, unknown> = Object.create(null);
      for (const key of Object.keys(item).sort()) {
        const entry = (item as Record<string, unknown>)[key];
        if (entry !== undefined) out[key] = sort(entry);
      }
      return out;
    }
    return item;
  };
  return JSON.stringify(sort(value));
}
export function renderSha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
export function supportsCompiledRequest(provider: string): boolean { return ["seedance", "seedream", "higgsfield", "muapi"].includes(provider); }

export function providerEndpointOptions(provider: string, env: NodeJS.ProcessEnv): ProviderEndpointOptions {
  if (provider === "seedance") return { baseUrl: env.SEEDANCE_ENDPOINT?.trim() || undefined };
  if (provider === "seedream") return { baseUrl: env.SEEDREAM_ENDPOINT?.trim() || env.SEEDANCE_ENDPOINT?.trim() || undefined };
  if (provider === "higgsfield") return { baseUrl: env.HF_BASE_URL?.trim() || undefined, webhookUrl: env.HF_WEBHOOK_URL?.trim() || undefined };
  if (provider === "muapi") return { baseUrl: env.MUAPI_BASE_URL?.trim() || undefined };
  throw new SubmissionError("PROVIDER_COMPILER_UNAVAILABLE", "该供应商尚无正式生成请求编译器");
}

export function compileProviderRequest(provider: string, req: GenRequest, options: ProviderEndpointOptions = {}): CompiledProviderRequest {
  submissionRequestHash({ prompt: req.prompt, params: req.params ?? {} });
  const p = (req.params ?? {}) as VideoGenParams & { providerModel?: string };
  const model = p.providerModel?.trim();
  if (!model) throw new SubmissionError("REQUEST_INVALID", "缺少供应商模型标识");
  let endpoint: string;
  let body: Record<string, unknown>;
  if (provider === "seedance") {
    const content: Array<Record<string, unknown>> = [{ type: "text", text: req.prompt }];
    if (p.firstFrameUrl?.trim()) content.push({ type: "image_url", image_url: { url: p.firstFrameUrl.trim() }, role: "first_frame" });
    for (const [urls, type, role] of [
      [p.referenceImageUrls, "image_url", "reference_image"],
      [p.referenceVideoUrls, "video_url", "reference_video"],
      [p.referenceAudioUrls, "audio_url", "reference_audio"],
    ] as const) for (const url of urls ?? []) {
      if (url?.trim()) content.push({ type, [type]: { url }, role });
    }
    endpoint = `${(options.baseUrl ?? "https://ark.cn-beijing.volces.com/api/v3").replace(/\/$/, "")}/contents/generations/tasks`;
    body = {
      model, content,
      ...(p.durationSec ? { duration: Math.round(p.durationSec) } : {}),
      ...(p.frames ? { frames: Math.round(p.frames) } : {}),
      ...(p.aspectRatio ? { ratio: p.aspectRatio } : {}),
      ...(p.resolution ? { resolution: p.resolution } : {}),
      ...(p.generateAudio === undefined ? {} : { generate_audio: p.generateAudio }),
      ...(p.seed === undefined ? {} : { seed: p.seed }),
      watermark: p.watermark ?? false,
      ...(p.cameraFixed === undefined ? {} : { camera_fixed: p.cameraFixed }),
      ...(p.returnLastFrame === undefined ? {} : { return_last_frame: p.returnLastFrame }),
      ...(p.serviceTier ? { service_tier: p.serviceTier } : {}),
      ...(p.priority === undefined ? {} : { priority: p.priority }),
      ...(p.executionExpiresAfter === undefined ? {} : { execution_expires_after: p.executionExpiresAfter }),
      ...(p.outputFormat ? { output_format: p.outputFormat } : {}),
      ...(p.callbackUrl ? { callback_url: p.callbackUrl } : {}),
      ...(p.extra ?? {}),
    };
  } else if (provider === "seedream") {
    endpoint = `${(options.baseUrl ?? "https://ark.cn-beijing.volces.com/api/v3").replace(/\/$/, "")}/images/generations`;
    body = { model, prompt: req.prompt, response_format: "url", ...(p.resolution ? { size: p.resolution } : {}),
      ...(p.seed === undefined ? {} : { seed: p.seed }), ...(p.extra ?? {}) };
  } else if (provider === "higgsfield" || provider === "muapi") {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(model) || model.split("/").includes("..")) throw new SubmissionError("REQUEST_INVALID", "供应商模型路径非法");
    const base = (options.baseUrl ?? (provider === "higgsfield" ? "https://api.higgsfield.ai" : "https://api.muapi.ai")).replace(/\/$/, "");
    endpoint = provider === "higgsfield"
      ? `${base}/${model}${options.webhookUrl ? `?hf_webhook=${encodeURIComponent(options.webhookUrl)}` : ""}`
      : `${base}/api/v1/${model}`;
    body = { prompt: req.prompt,
      ...(p.durationSec ? { duration: Math.round(p.durationSec) } : {}),
      ...(p.resolution ? { resolution: p.resolution } : {}),
      ...(p.aspectRatio ? { aspect_ratio: p.aspectRatio } : {}),
      ...(p.firstFrameUrl ? { image_url: p.firstFrameUrl } : {}),
      ...(provider === "higgsfield" ? {
        ...(p.generateAudio === undefined ? {} : { generate_audio: p.generateAudio }),
        ...(p.referenceImageUrls?.length ? { reference_images: p.referenceImageUrls } : {}),
        ...(p.seed === undefined ? {} : { seed: p.seed }),
      } : {}), ...(p.extra ?? {}),
    };
  } else throw new SubmissionError("PROVIDER_COMPILER_UNAVAILABLE", "该供应商尚无正式生成请求编译器");
  const target = new URL(endpoint);
  if (!["https:", "http:"].includes(target.protocol) || target.username || target.password || target.hash) throw new SubmissionError("REQUEST_INVALID", "供应商地址非法或含秘密");
  const bodyJson = canonicalRenderJson(body);
  return { schemaVersion: "workloom.provider-request/v1", provider, providerModel: model, endpoint, method: "POST",
    body: JSON.parse(bodyJson) as Record<string, unknown>, bodyJson,
    payloadHash: renderSha256(canonicalRenderJson({ provider, providerModel: model, endpoint, method: "POST", body: JSON.parse(bodyJson) })) };
}

export function buildRenderPrompt(script: Pick<RenderScriptLike, "md">, model: MediaModel): string {
  const prompt = script.md;
  const max = model.limits?.maxPromptChars ?? 4000;
  if (!prompt.trim()) throw new SubmissionError("REQUEST_INVALID", "镜头提示词为空");
  if (prompt.length > max) throw new SubmissionError("PROMPT_TOO_LONG", `完整提示词 ${prompt.length} 字符超过模型上限 ${max}，必须重新编译并审核，禁止截断`);
  return prompt;
}

/** 正式参数不得用 extra 替换源提示词、模型、素材或渲染身份。所有剩余值仍进入完整审核。 */
export function validateProductionParams(params: VideoGenParams): void {
  submissionRequestHash(params);
  if (params.prompt !== undefined) throw new SubmissionError("REQUEST_INVALID", "正式提示词只能来自服务预生产档案");
  const reserved = new Set(["model", "prompt", "content", "duration", "frames", "ratio", "aspect_ratio", "resolution", "size", "seed", "generate_audio", "image_url", "reference_images", "image", "video", "audio", "providerModel", "jobDir", "__proto__", "constructor", "prototype"]);
  if (params.extra) for (const key of Object.keys(params.extra)) {
    if (reserved.has(key)) throw new SubmissionError("REQUEST_INVALID", `extra.${key} 不能覆盖已绑定的生成内容`);
  }
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "number" && !Number.isFinite(value)) throw new SubmissionError("REQUEST_INVALID", `参数 ${key} 不是有限数`);
  }
  if (params.durationSec !== undefined && (!Number.isFinite(params.durationSec) || params.durationSec <= 0)) throw new SubmissionError("REQUEST_INVALID", "时长必须为正数");
}

export function compileRenderRequest(input: {
  script: RenderScriptLike; model: MediaModel; params: VideoGenParams; scope: Scope;
  mode: "manual" | "batch" | "auto"; env: NodeJS.ProcessEnv;
}): { compiled: CompiledProviderRequest; requestHash: string; prompt: string } {
  validateProductionParams(input.params);
  const prompt = buildRenderPrompt(input.script, input.model);
  const compiled = compileProviderRequest(input.model.provider, {
    prompt, estimatedUnits: input.params.durationSec ?? 5, refId: input.script.id,
    params: { ...input.params, providerModel: resolveProviderModel(input.model, input.env) },
  }, providerEndpointOptions(input.model.provider, input.env));
  const script = input.script;
  const requestHash = submissionRequestHash({ version: 2, scope: input.scope,
    script: { id: script.id, projectId: script.project_id, shotId: script.shot_id, key: script.script_key,
      version: script.version, md: script.md, fields: script.fields ?? {} },
    modelId: input.model.id, compiled, params: input.params, mode: input.mode, mock: false });
  return { compiled, requestHash, prompt };
}
