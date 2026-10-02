/**
 * 本地模拟通道（离线可跑通全流程；**不是**真模型，输出仅供联调）
 *
 * 两个用途：
 *   ① 单测：注入 fetch，验证协议解析/重试/预算/分流，不产生任何外呼；
 *   ② CLI `--mock`：起一个 127.0.0.1 的真实 HTTP 服务，让"请求 → 协议头 → 响应 → 解析"
 *      整条链路是真机走通的（只有模型部分是规则模拟），用于无 key 环境下的端到端验证。
 *
 * 两条通道的**响应形状按请求路径**区分（与真实通道一致）：
 *   - `/v1/systemone`（官方直连）：answers 里 boolean 问题返回 `{"type":"noul","noul":…}`，
 *     choice/score 直接带 `confidence`；usage 为 `{input_tokens, output_tokens}`；
 *   - `/v4/ai/evaluation-model`（Vercel 网关）：boolean 返回 `{"type":"boolean","probability":…}`，
 *     置信度走 `providerMetadata.typesafe.confidence`；usage 为 `{inputTokens, outputTokens}`。
 *
 * 行为契约（确定性，便于断言）：
 *   - 概率按两位小数四舍五入后返回（复现网关的取整行为，协议层应重新归一化）；
 *   - comment-classify 在 providerMetadata.typesafe.confidence 提供置信度；
 *     lead-qualify 不提供（验证派生置信度路径）；
 *   - options.failFirstRequests 可注入前 N 次 429/529，用于重试验证。
 */
import { createServer, type Server } from "node:http";
import { GATEWAY_MODEL, TYPESAFE_PATH, TYPESAFE_MODEL } from "./client.js";
import type { JevProvider } from "./types.js";

/** 官方直连返回的是**具体版本号**（请求用别名 jev-latest，回答里是解析后的 id） */
export const TYPESAFE_RESPONSE_MODEL = "jev-1.13.0";

export interface MockGatewayOptions {
  /** 前 N 次请求返回限流/过载（按 statuses 轮转），用于重试与退避路径验证 */
  failFirstRequests?: number;
  failStatuses?: number[];
  model?: string;
  /** 响应形状；缺省按请求路径自动判定 */
  provider?: JevProvider;
}

interface MockState {
  calls: number;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 中文三元组（去标点空白）：用于模拟"草稿是否被官方口径支撑"的粗粒度重叠判定 */
function trigrams(text: string): Set<string> {
  const clean = text.replace(/[\s，。；;,.!！?？、：:"'（）()【】\[\]]/g, "");
  const grams = new Set<string>();
  for (let index = 0; index + 3 <= clean.length; index += 1) {
    grams.add(clean.slice(index, index + 3));
  }
  return grams;
}

function normalizeWeights(weights: Record<string, number>): Record<string, number> {
  const total = Object.values(weights).reduce((sum, value) => sum + value, 0);
  const rounded: Record<string, number> = {};
  for (const [key, value] of Object.entries(weights)) {
    rounded[key] = round2(value / total);
  }
  return rounded;
}

function pickByRules(text: string): { intent: string; weights: Record<string, number> } {
  const weights: Record<string, number> = {
    inquiry: 0.1,
    booking_intent: 0.05,
    complaint: 0.05,
    smalltalk: 0.1,
    spam: 0.02,
  };
  if (/投诉|差评|太差|很差|退钱|赔偿|骗|恶心|垃圾/.test(text)) {
    weights["complaint"] = 0.9;
    return { intent: "complaint", weights };
  }
  if (/预订|订房|订一间|下单|怎么付|付款|留房|能不能订/.test(text)) {
    weights["booking_intent"] = 0.88;
    return { intent: "booking_intent", weights };
  }
  if (/多少钱|价格|有没有房|能住|咨询|问一下|怎么走|位置/.test(text)) {
    weights["inquiry"] = 0.84;
    return { intent: "inquiry", weights };
  }
  if (/加微|加v|广告|优惠券群|返现|代理/.test(text)) {
    weights["spam"] = 0.86;
    return { intent: "spam", weights };
  }
  weights["smalltalk"] = 0.7;
  return { intent: "smalltalk", weights };
}

function booleanAnswer(
  id: string,
  text: string,
  intent: string,
  officialClaims: string,
): { probability: number; confidence?: number } {
  if (id === "is_lead") {
    if (intent === "booking_intent") return { probability: 0.93, confidence: 0.9 };
    if (intent === "inquiry") return { probability: 0.72, confidence: 0.82 };
    if (intent === "spam") return { probability: 0.03, confidence: 0.95 };
    return { probability: 0.2, confidence: 0.7 };
  }
  if (id === "needs_human") {
    if (intent === "complaint") return { probability: 0.95, confidence: 0.93 };
    if (/隐私|身份证|护照号|银行卡/.test(text)) return { probability: 0.9, confidence: 0.9 };
    return { probability: 0.05, confidence: 0.88 };
  }
  if (id === "budget_stated") {
    return { probability: /预算|价格区间|人均|多少钱/.test(text) ? 0.88 : 0.12 };
  }
  if (id === "timeline_stated") {
    return { probability: /这周|下周|本月|下个月|假期|周末|月\s*\d|号|日/.test(text) ? 0.86 : 0.15 };
  }
  if (id === "decision_maker") {
    return { probability: /我来|我订|我要|怎么付|能留房/.test(text) ? 0.84 : 0.25 };
  }
  if (id === "premise_supported") {
    // 模拟口径：草稿与官方口径共享 ≥3 个三元组 → 视为有支撑（"本店提供"这类公共前缀不算）
    const draftGrams = trigrams(text);
    const claimGrams = trigrams(officialClaims);
    const shared = [...draftGrams].filter((gram) => claimGrams.has(gram)).length;
    const supported = shared >= 3;
    return { probability: supported ? 0.88 : 0.25, confidence: supported ? 0.82 : 0.7 };
  }
  if (id === "invented_specifics") {
    const digits = text.match(/\d+/g) ?? [];
    const unsupportedDigit = digits.some((digit) => !officialClaims.includes(digit));
    const superlative = /保证|第一|唯一|最好|最低价|认证|大奖/.test(text);
    const invented = unsupportedDigit || superlative;
    return { probability: invented ? 0.88 : 0.08, confidence: invented ? 0.8 : 0.85 };
  }
  if (id === "brand_stance_risk") {
    return { probability: /保证|承诺|绝不|独家|官方指定/.test(text) ? 0.85 : 0.1 };
  }
  return { probability: 0.5 };
}

function scoreAnswer(id: string, text: string): { score: number; probabilities: Record<string, number> } {
  if (id === "intent_strength") {
    const strong = /预订|订房|下单|怎么付|留房/.test(text);
    const vague = /多少钱|咨询|问一下|有没有房/.test(text);
    const raw = strong ? 2 : vague ? 1 : 0;
    const weights: Record<string, number> = { "0": 0, "1": 0, "2": 0 };
    weights[String(raw)] = 0.9;
    for (const key of Object.keys(weights)) {
      if (key !== String(raw)) weights[key] = 0.05;
    }
    return { score: raw, probabilities: normalizeWeights(weights) };
  }
  return { score: 0, probabilities: { "0": 1 } };
}

/** 纯函数响应体：与 HTTP 层解耦，便于单测直接调用 */
export function mockResponse(
  body: unknown,
  options: { provider?: JevProvider; model?: string } = {},
): Record<string, unknown> {
  if (typeof body !== "object" || body === null) throw new Error("mock: 请求体不是对象");
  const provider: JevProvider = options.provider ?? "typesafe";
  const record = body as Record<string, unknown>;
  const state = (record["state"] ?? {}) as Record<string, unknown>;
  const questions = (record["questions"] ?? {}) as Record<string, Record<string, unknown>>;
  const text = String(state["comment"] ?? state["message"] ?? state["draft"] ?? "");
  const officialClaims = Array.isArray(state["official_claims"])
    ? (state["official_claims"] as unknown[]).filter((item): item is string => typeof item === "string").join("，")
    : "";
  const { intent } = pickByRules(text);
  const answers: Record<string, unknown> = {};
  const confidence: Record<string, number> = {};
  const inputChars = JSON.stringify(body).length;
  const questionCount = Object.keys(questions).length;

  for (const [id, question] of Object.entries(questions)) {
    const type = question["type"];
    if (type === "choice" || type === "noul") {
      if (type === "noul") {
        const { probability, confidence: conf } = booleanAnswer(id, text, intent, officialClaims);
        answers[id] = { type: "noul", noul: round2(probability) };
        if (conf !== undefined) confidence[id] = conf;
        continue;
      }
      const criteria = (question["criteria"] ?? {}) as Record<string, string>;
      const keys = Object.keys(criteria);
      const chosen = keys.includes(intent) ? intent : (keys[0] ?? "unknown");
      const weights: Record<string, number> = {};
      for (const key of keys) weights[key] = key === chosen ? 0.9 : 0.1 / Math.max(1, keys.length - 1);
      const probabilities = normalizeWeights(weights);
      answers[id] = { type: "choice", choice: chosen, probabilities };
      confidence[id] = 0.9;
      continue;
    }
    if (type === "score") {
      const { score, probabilities } = scoreAnswer(id, text);
      answers[id] = { type: "score", score, probabilities };
      continue;
    }
    const { probability, confidence: conf } = booleanAnswer(id, text, intent, officialClaims);
    answers[id] = { type: "boolean", probability: round2(probability) };
    if (conf !== undefined) confidence[id] = conf;
  }

  if (provider === "typesafe") {
    // 官方直连形状：模型回具体的版本化 id；choice/score 的置信度直接挂在回答上；
    // Noul 没有置信度字段（协议层据此走派生置信度 → 分流更保守）。
    for (const [id, answer] of Object.entries(answers)) {
      const recordAnswer = answer as Record<string, unknown>;
      if (recordAnswer["type"] !== "noul" && confidence[id] !== undefined) {
        recordAnswer["confidence"] = confidence[id];
      }
    }
    return {
      model: options.model ?? (record["model"] === TYPESAFE_MODEL ? TYPESAFE_RESPONSE_MODEL : String(record["model"] ?? TYPESAFE_RESPONSE_MODEL)),
      answers,
      usage: {
        input_tokens: Math.max(1, Math.round(inputChars / 4)),
        output_tokens: questionCount * 12 + 6,
      },
    };
  }

  return {
    model: options.model ?? GATEWAY_MODEL,
    answers,
    providerMetadata: { typesafe: { confidence } },
    usage: { inputTokens: Math.max(1, Math.round(inputChars / 4)), outputTokens: 0 },
  };
}

/** 按请求路径判定通道（与真实世界的两条 URL 一一对应） */
function providerOf(url: string, fallback: JevProvider | undefined): JevProvider {
  if (url.includes(TYPESAFE_PATH)) return "typesafe";
  if (url.includes("/v4/ai/evaluation-model")) return "vercel-gateway";
  return fallback ?? "typesafe";
}

function makeFetch(options: MockGatewayOptions, state: MockState): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    state.calls += 1;
    const failCount = options.failFirstRequests ?? 0;
    if (state.calls <= failCount) {
      const statuses = options.failStatuses ?? [429];
      const status = statuses[(state.calls - 1) % statuses.length] ?? 429;
      return new Response(JSON.stringify({ error: { message: "mock rate limit", code: status } }), {
        status,
        headers: status === 429 ? { "retry-after": "0" } : {},
      });
    }
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const provider = options.provider ?? providerOf(String(input), undefined);
    return new Response(JSON.stringify(mockResponse(body, { provider, model: options.model })), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

/** fetch 形态的假网关（单测首选：不起端口、无 IO） */
export function createMockFetch(options: MockGatewayOptions = {}): { fetchImpl: typeof fetch; calls: () => number } {
  const state: MockState = { calls: 0 };
  const fetchImpl = makeFetch(options, state);
  return { fetchImpl, calls: () => state.calls };
}

export interface MockServer {
  url: string;
  close: () => Promise<void>;
}

/** 真 HTTP 形态的模拟网关（CLI --mock 用：整条协议链路真机走通） */
export async function startMockServer(options: MockGatewayOptions = {}): Promise<MockServer> {
  const state: MockState = { calls: 0 };
  const server: Server = createServer((request, response) => {
    const provider = options.provider ?? providerOf(request.url ?? "", undefined);
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      state.calls += 1;
      const failCount = options.failFirstRequests ?? 0;
      if (state.calls <= failCount) {
        const statuses = options.failStatuses ?? [429];
        const status = statuses[(state.calls - 1) % statuses.length] ?? 429;
        response.writeHead(status, { "content-type": "application/json", "retry-after": "0" });
        response.end(JSON.stringify({ error: { message: "mock rate limit", code: status } }));
        return;
      }
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(mockResponse(body, { provider, model: options.model })));
      } catch (error) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: String(error) } }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("mock server 启动失败：无端口");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
