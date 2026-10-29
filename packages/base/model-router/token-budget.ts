/**
 * Official DeepSeek Flash window planning.
 *
 * DeepSeek documents 1,048,576 input/output shared context tokens and
 * 393,216 maximum output tokens. Images are independently capped at 1,024
 * tokens each, with at most 600 images and a 48 MiB chat request body.
 *
 * The token estimate helper remains only for explanatory UI copy. Production
 * dispatch and tests use the pinned official tokenizer.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Tokenizer } from "tokenizers";

export const DEEPSEEK_FLASH_MODEL_ID = "deepseek-flash" as const;
export const DEEPSEEK_FLASH_CONTEXT_TOKENS = 1_048_576 as const;
export const DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS = 393_216 as const;
export const DEEPSEEK_IMAGE_TOKEN_LIMIT = 1_024 as const;
export const DEEPSEEK_MAX_IMAGES = 600 as const;
export const DEEPSEEK_REQUEST_BODY_LIMIT_BYTES = 48 * 1024 * 1024;
export const DEEPSEEK_IMAGE_LIMIT_BYTES = 32 * 1024 * 1024;
export const DEEPSEEK_TOKENIZER_SHA256 =
  "89085f12ef79460ac5f66d1119325ddfc694b4ab209d80bbd81d35f081dc9614" as const;
export const TEXT_PRIMARY_REGISTRY_VERSION = "2026-10-30.1" as const;
export const TEXT_PRIMARY_POLICY_VERSION = "2026-10-30.1" as const;

/** @deprecated Legacy compatibility only. New dispatches use the maximum legal window. */
export const DEFAULT_JSON_OUTPUT_TOKENS = 16_384 as const;

const DEEPSEEK_TOKENIZER_URL = new URL("./assets/deepseek-v4-tokenizer.json", import.meta.url);
let tokenizerPromise: Promise<Tokenizer> | undefined;

export interface ImageUrlPart {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "low" | "high" | "original" | "auto";
  };
}

export interface FileImagePart {
  type: "file";
  file_id?: string;
  file_data?: string;
  filename?: string;
}

export interface TextPart {
  type: "text";
  text: string;
}

export type ModelContentPart = TextPart | ImageUrlPart | FileImagePart;
export type ModelMessageContent = string | ModelContentPart[];

export interface BudgetMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: ModelMessageContent;
}

export function isDeepSeekFlashModel(model: string | null | undefined): boolean {
  return model === DEEPSEEK_FLASH_MODEL_ID;
}

export function canonicalDeepSeekModel(model: string | null | undefined): typeof DEEPSEEK_FLASH_MODEL_ID {
  const normalized = String(model ?? "").trim();
  if (!normalized || isDeepSeekFlashModel(normalized)) return DEEPSEEK_FLASH_MODEL_ID;
  throw new Error(`MODEL_ID_NOT_ALLOWED: ${normalized}; use ${DEEPSEEK_FLASH_MODEL_ID}`);
}

/** @deprecated Explanatory estimate only; production planning uses the official tokenizer. */
export function estimateDeepSeekTokens(text: string): number {
  let cjk = 0;
  let textChars = 0;
  let symbols = 0;
  for (const char of text) {
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(char)) cjk += 1;
    else if (/[\p{L}\p{N}\s]/u.test(char)) textChars += 1;
    else symbols += 1;
  }
  return Math.ceil(cjk * 0.6 + textChars * 0.3 + symbols);
}

async function loadOfficialTokenizer(): Promise<Tokenizer> {
  let bytes: Buffer;
  try {
    bytes = await readFile(DEEPSEEK_TOKENIZER_URL);
  } catch (error) {
    throw new Error("DEEPSEEK_TOKENIZER_MISSING", { cause: error });
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== DEEPSEEK_TOKENIZER_SHA256) throw new Error("DEEPSEEK_TOKENIZER_CHANGED");
  try {
    return Tokenizer.fromString(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error("DEEPSEEK_TOKENIZER_INVALID", { cause: error });
  }
}

export function getDeepSeekTokenizer(): Promise<Tokenizer> {
  tokenizerPromise ??= loadOfficialTokenizer();
  return tokenizerPromise;
}

export async function countDeepSeekTokens(value: string): Promise<number> {
  const tokenizer = await getDeepSeekTokenizer();
  return (await tokenizer.encode(value)).getLength();
}

function dataUrlBytes(value: string): number {
  const comma = value.indexOf(",");
  if (comma < 0) return 0;
  const payload = value.slice(comma + 1);
  if (!/;base64(?:;|,)/i.test(value.slice(0, comma + 1))) return payload.length;
  return Math.floor((payload.length * 3) / 4)
    - (payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0);
}

function sanitizeForTokenizer(value: unknown): {
  value: unknown;
  imageCount: number;
  inlineImageBytes: number;
} {
  let imageCount = 0;
  let inlineImageBytes = 0;
  const visit = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(visit);
    if (!entry || typeof entry !== "object") return entry;
    const record = entry as Record<string, unknown>;
    if (record.type === "image_url" && record.image_url && typeof record.image_url === "object") {
      imageCount += 1;
      const image = record.image_url as Record<string, unknown>;
      const url = typeof image.url === "string" ? image.url : "";
      if (url.startsWith("data:")) inlineImageBytes += dataUrlBytes(url);
      return { ...record, image_url: { ...image, url: "<image>" } };
    }
    if (record.type === "file" && typeof record.file_data === "string") {
      imageCount += 1;
      inlineImageBytes += dataUrlBytes(record.file_data);
      return { ...record, file_data: "<image>" };
    }
    if (record.type === "file" && typeof record.file_id === "string") imageCount += 1;
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, visit(item)]));
  };
  return { value: visit(value), imageCount, inlineImageBytes };
}

function validateImages(
  messages: BudgetMessage[],
  imageCount: number,
  inlineImageBytes: number,
): void {
  if (imageCount > DEEPSEEK_MAX_IMAGES) throw new Error("DEEPSEEK_IMAGE_COUNT_EXCEEDED");
  if (inlineImageBytes > DEEPSEEK_IMAGE_LIMIT_BYTES) throw new Error("DEEPSEEK_IMAGE_TOO_LARGE");
  for (const message of messages) {
    if (message.role !== "user" && Array.isArray(message.content)
      && message.content.some((part) => part.type === "image_url" || part.type === "file")) {
      throw new Error("DEEPSEEK_IMAGE_ROLE_INVALID");
    }
  }
}

export interface DeepSeekWindowPlan {
  inputTokens: number;
  imageTokens: number;
  outputCeiling: number;
  productConstrained: boolean;
  requestBytes: number;
  imageCount: number;
}

export async function planDeepSeekWindow(input: {
  messages: BudgetMessage[];
  tools?: unknown;
  responseFormat?: unknown;
  contextTokens?: number;
  maxOutputTokens?: number;
  productOutputCap?: number;
}): Promise<DeepSeekWindowPlan> {
  const contextTokens = input.contextTokens ?? DEEPSEEK_FLASH_CONTEXT_TOKENS;
  const maxOutputTokens = input.maxOutputTokens ?? DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS;
  if (!Number.isSafeInteger(contextTokens) || contextTokens < 1) throw new Error("DEEPSEEK_CONTEXT_INVALID");
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) {
    throw new Error("DEEPSEEK_OUTPUT_BUDGET_INVALID");
  }

  const requestEnvelope = {
    messages: input.messages,
    tools: input.tools ?? [],
    responseFormat: input.responseFormat ?? null,
  };
  const requestBytes = Buffer.byteLength(JSON.stringify(requestEnvelope), "utf8");
  if (requestBytes > DEEPSEEK_REQUEST_BODY_LIMIT_BYTES) throw new Error("DEEPSEEK_REQUEST_BODY_TOO_LARGE");

  const sanitized = sanitizeForTokenizer(requestEnvelope);
  validateImages(input.messages, sanitized.imageCount, sanitized.inlineImageBytes);
  const textTokens = await countDeepSeekTokens(JSON.stringify(sanitized.value));
  const framingTokens = 32 + Math.max(1, input.messages.length) * 8;
  const imageTokens = sanitized.imageCount * DEEPSEEK_IMAGE_TOKEN_LIMIT;
  const inputTokens = textTokens + framingTokens + imageTokens;
  const legalRemaining = contextTokens - inputTokens;
  if (legalRemaining < 1) throw new Error("DEEPSEEK_CONTEXT_EXCEEDED");

  const mathematical = Math.min(maxOutputTokens, legalRemaining);
  const requested = input.productOutputCap ?? mathematical;
  if (!Number.isSafeInteger(requested) || requested < 1) throw new Error("DEEPSEEK_OUTPUT_BUDGET_INVALID");
  return {
    inputTokens,
    imageTokens,
    outputCeiling: Math.min(mathematical, requested),
    productConstrained: requested < mathematical,
    requestBytes,
    imageCount: sanitized.imageCount,
  };
}

/** @deprecated The dispatcher uses the complete request window. */
export function deepSeekInputTokenBudget(
  maxOutputTokens: number = DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS,
): number {
  if (!Number.isInteger(maxOutputTokens)
    || maxOutputTokens < 1
    || maxOutputTokens > DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS) {
    throw new Error("DEEPSEEK_OUTPUT_BUDGET_INVALID");
  }
  return DEEPSEEK_FLASH_CONTEXT_TOKENS - maxOutputTokens;
}
