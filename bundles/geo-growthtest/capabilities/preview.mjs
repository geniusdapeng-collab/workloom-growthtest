/**
 * 获客增长 C 前台的合作需求预览。
 *
 * 本函数只校验和归一化调用方提供的 JSON；它不读取 C 会话、活动 Bundle 或服务端工单。
 * 成功返回的预览因此不是权限、可提交性或通知送达证明。
 */

const INQUIRY_KINDS = new Set(["consult", "service_request"]);
const INPUT_KEYS = new Set(["kind", "title", "payload", "conversationId", "idempotencyKey"]);
const MAX_TITLE_CHARS = 120;
const MAX_PAYLOAD_JSON_CHARS = 10 * 1024;
const MAX_OPTIONAL_CHARS = 200;

export class InquiryPreviewError extends Error {
  constructor(message) {
    super(message);
    this.name = "InquiryPreviewError";
    this.code = "BAD_REQUEST";
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function optionalText(value, key, minChars = 1) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length < minChars || value.length > MAX_OPTIONAL_CHARS) {
    throw new InquiryPreviewError(`${key} 须为 ${minChars}–${MAX_OPTIONAL_CHARS} 字符的非空字符串`);
  }
  return value.trim();
}

export function previewInquiry(input) {
  if (!isPlainObject(input)) throw new InquiryPreviewError("输入须为 JSON 对象");
  for (const key of Object.keys(input)) {
    if (!INPUT_KEYS.has(key)) throw new InquiryPreviewError(`不支持字段 ${key}`);
  }
  if (!INQUIRY_KINDS.has(input.kind)) {
    throw new InquiryPreviewError("kind 须为 consult 或 service_request");
  }
  if (typeof input.title !== "string") throw new InquiryPreviewError("title 须为非空字符串");
  const title = input.title.trim();
  if (!title || title.length > MAX_TITLE_CHARS) {
    throw new InquiryPreviewError(`title 去空白后须为 1–${MAX_TITLE_CHARS} 字符`);
  }
  const payload = input.payload === undefined ? {} : input.payload;
  if (!isPlainObject(payload)) throw new InquiryPreviewError("payload 须为 JSON 对象");
  let payloadJson;
  try {
    payloadJson = JSON.stringify(payload);
  } catch {
    throw new InquiryPreviewError("payload 不能转换为 JSON");
  }
  if (typeof payloadJson !== "string" || payloadJson.length > MAX_PAYLOAD_JSON_CHARS) {
    throw new InquiryPreviewError(`payload JSON 不得超过 ${MAX_PAYLOAD_JSON_CHARS} 字符`);
  }
  const conversationId = optionalText(input.conversationId, "conversationId");
  const idempotencyKey = optionalText(input.idempotencyKey, "idempotencyKey", 8);

  return {
    previewOnly: true,
    request: {
      kind: input.kind,
      title,
      payload,
      ...(conversationId ? { conversationId } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    },
    payloadJsonChars: payloadJson.length,
    serverChecksPending: ["C 会话", "工作区", "行业归口或通用兜底", "幂等归属", "工单落库与事件回执"],
    notificationDelivery: "simulated",
  };
}
