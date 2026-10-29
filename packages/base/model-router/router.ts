/**
 * WorkLoom text routing.
 *
 * Tier/plan information remains for billing and product analytics. It no
 * longer selects a model. Every text task uses `text.primary` ->
 * `deepseek-flash`, with scene policy controlling thinking, format and
 * evidence.
 */
import { OFF_PEAK_RATE_RATIO, OFF_PEAK_WINDOW } from "@workloom/shared";
import {
  canonicalDeepSeekModel,
  DEEPSEEK_FLASH_CONTEXT_TOKENS,
  DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS,
  DEEPSEEK_FLASH_MODEL_ID,
} from "./token-budget.js";
import {
  resolveTextScenePolicy,
  textScenePolicyReceipt,
  type TextScenePolicyOverride,
  type ThinkingEffort,
} from "./deepseek-policy.js";
import {
  mockCredits,
  ModelProviderError,
  type ChatGenerationOptions,
  type ChatMessage,
  type ChatResult,
  type ModelProvider,
} from "./providers.js";
import {
  DEFAULT_MODEL_POLICY,
  resolveScene,
  resolveTier,
  type ModelPolicy,
  type PlanId,
  type Tier3,
} from "./policy.js";
import { computeCredits } from "./credits.js";

export type Window = "peak" | "off-peak";

export function currentWindow(now = new Date()): Window {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")!.value);
  const minute = Number(parts.find((part) => part.type === "minute")!.value);
  const [startHour, startMinute] = OFF_PEAK_WINDOW.start.split(":").map(Number);
  const [endHour, endMinute] = OFF_PEAK_WINDOW.end.split(":").map(Number);
  const value = hour * 60 + minute;
  const start = startHour! * 60 + startMinute!;
  const end = endHour! * 60 + endMinute!;
  return start > end
    ? value >= start || value < end ? "off-peak" : "peak"
    : value >= start && value < end ? "off-peak" : "peak";
}

export type Tier = "standard" | "flagship";

const TASK_TIER_TABLE: Record<string, Tier> = {
  "price.adjust": "standard",
  "order.reconcile": "standard",
  "review.reply": "standard",
  "inspection.scan": "standard",
  "competitor.fetch": "standard",
  "content.publish": "flagship",
  "content.draft": "flagship",
};

export function classify(task: { action: string; depthHint?: "deep" | "normal" }): Tier {
  if (task.depthHint === "deep") return "flagship";
  return TASK_TIER_TABLE[task.action] ?? "standard";
}

export interface RouterPolicy {
  chains: Record<Tier, string[]>;
  taskCreditLimit: number;
}

export const DEFAULT_POLICY: RouterPolicy = {
  chains: {
    flagship: [DEEPSEEK_FLASH_MODEL_ID],
    standard: [DEEPSEEK_FLASH_MODEL_ID],
  },
  taskCreditLimit: 500,
};

export interface ModelTrace {
  model_id: string;
  tier: Tier | Tier3 | string;
  window: Window;
  credits: number;
  action: string;
  reused?: boolean;
  scene?: string;
  bill_to?: "tenant" | "platform";
  mode?: "enabled" | "disabled";
  effort?: "low" | "high" | "max";
  finishReason?: string;
  requestHash?: string;
  responseHash?: string;
  responseId?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  outputCeiling?: number;
  inputTokenEstimate?: number;
  imageCount?: number;
  policyVersion?: string;
  registryVersion?: string;
  attempts?: ChatResult["attempts"];
}

export interface EventSink {
  recordModelTrace(trace: ModelTrace): Promise<void>;
  recordDegradation(event: {
    from: string;
    to: string | null;
    reason: string;
    action: string;
  }): Promise<void>;
  recordCircuitBreak(event: {
    action: string;
    creditsUsed: number;
    limit: number;
  }): Promise<void>;
  recordFeedback?(feedback: {
    scene: string;
    action: string;
    thumbs: "up" | "down";
    original_tier: string;
    escalated_tier?: string;
    adopted?: boolean;
    signal?: string;
  }): Promise<void>;
}

export interface MemoryLookupHit {
  reusable: boolean;
  answer?: string;
  memoryId?: string;
}

export interface RouteTask {
  action: string;
  messages: ChatMessage[];
  depthHint?: "deep" | "normal";
  queueable?: boolean;
  memoryLookup?: () => Promise<MemoryLookupHit | null>;
  creditsUsedSoFar?: number;
}

export const DEFAULT_SCENE_TIMEOUTS: Record<string, number> = {
  "intent-classify": 8_000,
  "nl-translate": 8_000,
  "ask-synthesize": 45_000,
  "quest-plan": 120_000,
  "pipeline-route": 60_000,
  "producer-review": 600_000,
  "content-generate": 600_000,
  generic: 180_000,
};
export const DEFAULT_CALL_TIMEOUT_MS = 180_000;

export interface CircuitState {
  failures: number;
  openUntil: number;
}

const sceneCircuits = new Map<string, CircuitState>();
export const CIRCUIT_FAILURE_THRESHOLD = 3;
export const CIRCUIT_COOLDOWN_MS = 60_000;

export function circuitSnapshot(scene: string): CircuitState | undefined {
  const state = sceneCircuits.get(scene);
  return state ? { ...state } : undefined;
}

export function resetCircuit(scene?: string): void {
  if (scene) sceneCircuits.delete(scene);
  else sceneCircuits.clear();
}

export type RouteFailureKind =
  | "timeout"
  | "network"
  | "http"
  | "protocol"
  | "empty"
  | "unhealthy"
  | "circuit"
  | "cancelled"
  | "unknown";

export interface RouteFailure {
  kind: RouteFailureKind;
  reason: string;
  retryable: boolean;
  attempted: string[];
}

export interface RouteResult {
  kind: "answered" | "reused" | "queued" | "circuit_broken" | "unavailable";
  text?: string;
  modelTrace?: {
    model_id: string;
    tier: Tier;
    window: Window;
    credits: number;
  };
  reusedMemoryId?: string;
  degraded?: Array<{ from: string; to: string | null; reason: string }>;
  budgetExceeded?: boolean;
  failure?: RouteFailure;
  providerResult?: ChatResult;
}

function canonicalProvider(providers: Map<string, ModelProvider>): ModelProvider {
  const provider = providers.get(DEEPSEEK_FLASH_MODEL_ID);
  if (!provider) throw new Error("TEXT_PRIMARY_PROVIDER_MISSING");
  canonicalDeepSeekModel(provider.modelId);
  return provider;
}

function providerFailure(error: unknown): ModelProviderError {
  if (error instanceof ModelProviderError) return error;
  return new ModelProviderError(
    error instanceof Error ? error.message : String(error),
    "unknown",
    { retryable: false, cause: error },
  );
}

function traceFromResult(
  result: ChatResult,
  tier: Tier | Tier3,
  window: Window,
  credits: number,
  task: RouteTask,
  scene: string,
  billTo: "tenant" | "platform",
): ModelTrace {
  return {
    model_id: result.modelId,
    tier,
    window,
    credits,
    action: task.action,
    scene,
    bill_to: billTo,
    mode: result.mode,
    effort: result.effort,
    finishReason: result.finishReason,
    requestHash: result.requestHash,
    responseHash: result.responseHash,
    responseId: result.responseId,
    inputTokens: result.promptTokens,
    outputTokens: result.completionTokens,
    reasoningTokens: result.reasoningTokens,
    outputCeiling: result.outputCeiling,
    inputTokenEstimate: result.inputTokenEstimate,
    imageCount: result.imageCount,
    policyVersion: result.policyVersion,
    registryVersion: result.registryVersion,
    attempts: result.attempts,
  };
}

export async function route(
  task: RouteTask,
  providers: Map<string, ModelProvider>,
  sink: EventSink,
  policy: RouterPolicy = DEFAULT_POLICY,
  now = new Date(),
): Promise<RouteResult> {
  if (task.memoryLookup) {
    const hit = await task.memoryLookup();
    if (hit?.reusable && hit.answer !== undefined) {
      await sink.recordModelTrace({
        model_id: "memory-reuse",
        tier: "standard",
        window: currentWindow(now),
        credits: 0,
        action: task.action,
        reused: true,
      });
      return { kind: "reused", text: hit.answer, reusedMemoryId: hit.memoryId };
    }
  }
  const used = task.creditsUsedSoFar ?? 0;
  if (used >= policy.taskCreditLimit) {
    await sink.recordCircuitBreak({
      action: task.action,
      creditsUsed: used,
      limit: policy.taskCreditLimit,
    });
    return { kind: "circuit_broken" };
  }
  const tier = classify(task);
  const window = currentWindow(now);
  try {
    const provider = canonicalProvider(providers);
    const result = await provider.chat(task.messages, {
      scene: "generic",
      thinking: { type: "disabled" },
      responseFormat: { type: "text" },
    });
    const credits = window === "off-peak" && tier === "flagship"
      ? Math.max(1, Math.round(mockCredits(result.modelId, result) * OFF_PEAK_RATE_RATIO))
      : mockCredits(result.modelId, result);
    const modelTrace = {
      model_id: result.modelId,
      tier,
      window,
      credits,
    };
    await sink.recordModelTrace({
      ...modelTrace,
      action: task.action,
      mode: result.mode,
      finishReason: result.finishReason,
      requestHash: result.requestHash,
      responseHash: result.responseHash,
      inputTokens: result.promptTokens,
      outputTokens: result.completionTokens,
      reasoningTokens: result.reasoningTokens,
    });
    return {
      kind: "answered",
      text: result.text,
      modelTrace,
      providerResult: result,
    };
  } catch (error) {
    const failure = providerFailure(error);
    const degradation = {
      from: DEEPSEEK_FLASH_MODEL_ID,
      to: null,
      reason: failure.message,
    };
    await sink.recordDegradation({ ...degradation, action: task.action });
    return {
      kind: task.queueable ? "queued" : "unavailable",
      degraded: [degradation],
      failure: {
        kind: failure.kind === "unknown" ? "unknown" : failure.kind,
        reason: failure.message,
        retryable: failure.retryable,
        attempted: [DEEPSEEK_FLASH_MODEL_ID],
      },
    };
  }
}

export interface BillRow {
  model_id: string;
  tier: string;
  window: string;
  calls: number;
  credits: number;
}

export function projectBill(events: Array<{
  model_trace?: {
    model_id: string;
    tier?: string;
    window?: string;
    credits?: number;
  };
}>): BillRow[] {
  const rows = new Map<string, BillRow>();
  for (const event of events) {
    const trace = event.model_trace;
    if (!trace) continue;
    const key = `${trace.model_id}|${trace.tier ?? ""}|${trace.window ?? ""}`;
    const row = rows.get(key) ?? {
      model_id: trace.model_id,
      tier: trace.tier ?? "",
      window: trace.window ?? "",
      calls: 0,
      credits: 0,
    };
    row.calls += 1;
    row.credits += trace.credits ?? 0;
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => b.credits - a.credits);
}

export const TIER_TOKEN_CEILING: Record<Tier3, number> = {
  L1: DEEPSEEK_FLASH_CONTEXT_TOKENS - DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS,
  L2: DEEPSEEK_FLASH_CONTEXT_TOKENS - DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS,
  L3: DEEPSEEK_FLASH_CONTEXT_TOKENS - DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS,
};

export interface SmartTask extends RouteTask {
  generation?: ChatGenerationOptions;
  scene?: string;
  plan?: PlanId;
  forceTier?: Tier3;
  forceModel?: string;
  complexityClassifier?: (text: string) => Promise<"simple" | "medium" | "complex" | null>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export function heuristicComplexity(text: string): "simple" | "medium" | "complex" {
  const value = text.trim();
  if (value.length > 200) return "complex";
  if (/(分析|归因|对比|方案|策略|预测|推理|复盘|诊断)/.test(value)) return "complex";
  if (value.length <= 30 || /^(查询|查一下|看看|几点|多少|是不是|有没有)/.test(value)) return "simple";
  return "medium";
}

export interface SmartModelTrace extends ModelTrace {
  tier: Tier3;
}

export interface SmartRouteResult extends Omit<RouteResult, "modelTrace"> {
  modelTrace?: SmartModelTrace;
  tier?: Tier3;
  scene?: string;
  billTo?: "tenant" | "platform";
  passthrough?: boolean;
}

function sceneOverride(policy: ModelPolicy, scene: string): TextScenePolicyOverride {
  const value = resolveScene(policy, scene);
  return {
    ...(value.type ? { type: value.type } : {}),
    ...(value.thinking ? { thinking: { ...value.thinking } } : {}),
    ...(value.responseFormat ? { responseFormat: value.responseFormat } : {}),
    ...(value.outputBudget ? { outputBudget: value.outputBudget } : {}),
    ...(value.generationReviewGroup ? { generationReviewGroup: value.generationReviewGroup } : {}),
    ...(value.sameModelAs ? { sameModelAs: value.sameModelAs } : {}),
  };
}

function cancelResult(
  task: SmartTask,
  scene: string,
  tier: Tier3,
  passthrough: boolean,
  previous: Array<{ from: string; to: string | null; reason: string }> = [],
): SmartRouteResult {
  return {
    kind: "unavailable",
    degraded: [
      ...previous,
      { from: DEEPSEEK_FLASH_MODEL_ID, to: null, reason: "模型调用已取消（调用方 abort）" },
    ],
    tier,
    scene,
    passthrough,
  };
}

export async function routeSmart(
  task: SmartTask,
  providers: Map<string, ModelProvider>,
  sink: EventSink,
  options: { policy?: ModelPolicy; taskCreditLimit?: number; modelChain?: string[] } = {},
  now = new Date(),
): Promise<SmartRouteResult> {
  if (options.modelChain !== undefined) {
    if (!options.modelChain.length
      || new Set(options.modelChain).size !== options.modelChain.length
      || options.modelChain.some((model) => !providers.has(model))) {
      throw new Error("registered providers required");
    }
  }
  const policy = options.policy ?? DEFAULT_MODEL_POLICY;
  const limit = options.taskCreditLimit ?? 500;
  const scene = task.scene ?? "generic";
  const plan = task.plan ?? "standard";
  const scenePolicy = resolveTextScenePolicy(scene, sceneOverride(policy, scene));
  if (task.forceModel) canonicalDeepSeekModel(task.forceModel);
  const tier = task.forceTier ?? resolveTier(policy, scene, plan);
  const timeoutMs = task.timeoutMs && task.timeoutMs > 0
    ? task.timeoutMs
    : DEFAULT_SCENE_TIMEOUTS[scene] ?? DEFAULT_CALL_TIMEOUT_MS;
  const passthrough = resolveScene(policy, scene).fallback === "passthrough-disclose";

  if (task.signal?.aborted) return cancelResult(task, scene, tier, passthrough);
  const circuit = sceneCircuits.get(scene);
  if (circuit
    && circuit.failures >= CIRCUIT_FAILURE_THRESHOLD
    && circuit.openUntil > now.getTime()) {
    return {
      kind: "unavailable",
      degraded: [{ from: scene, to: null, reason: "circuit-open" }],
      tier,
      scene,
      passthrough,
      failure: {
        kind: "circuit",
        reason: "模型场景熔断冷却中",
        retryable: false,
        attempted: [DEEPSEEK_FLASH_MODEL_ID],
      },
    };
  }

  if (task.memoryLookup) {
    const hit = await task.memoryLookup();
    if (hit?.reusable && hit.answer !== undefined) {
      await sink.recordModelTrace({
        model_id: "memory-reuse",
        tier,
        window: currentWindow(now),
        credits: 0,
        action: task.action,
        reused: true,
        scene,
        bill_to: resolveScene(policy, scene).billTo ?? "tenant",
      });
      return {
        kind: "reused",
        text: hit.answer,
        reusedMemoryId: hit.memoryId,
        tier,
        scene,
        billTo: resolveScene(policy, scene).billTo ?? "tenant",
      };
    }
  }
  const used = task.creditsUsedSoFar ?? 0;
  if (used >= limit) {
    await sink.recordCircuitBreak({ action: task.action, creditsUsed: used, limit });
    return { kind: "circuit_broken", tier, scene };
  }

  const provider = canonicalProvider(providers);
  const window = currentWindow(now);
  try {
    const result = await provider.chat(task.messages, {
      scene,
      signal: task.signal,
      timeoutMs,
      responseFormat: { type: scenePolicy.responseFormat },
      thinking: { ...scenePolicy.thinking },
      ...(scenePolicy.thinking.type === "enabled"
        ? {
            reasoningEffort: scenePolicy.thinking.effort as ThinkingEffort,
            topP: task.generation?.topP,
          }
        : {
            temperature: task.generation?.temperature ?? scenePolicy.temperature,
            topP: task.generation?.topP,
          }),
      retries: task.generation?.maxTokens === undefined ? 0 : 0,
    });
    sceneCircuits.delete(scene);
    const credits = computeCredits({
      tier,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      window,
    });
    const trace = traceFromResult(
      result,
      tier,
      window,
      credits,
      task,
      scene,
      resolveScene(policy, scene).billTo ?? "tenant",
    ) as SmartModelTrace;
    await sink.recordModelTrace(trace);
    if (used + credits >= limit) {
      await sink.recordCircuitBreak({
        action: task.action,
        creditsUsed: used + credits,
        limit,
      });
      return {
        kind: "circuit_broken",
        text: result.text,
        modelTrace: trace,
        budgetExceeded: true,
        tier,
        scene,
        billTo: trace.bill_to,
        providerResult: result,
      };
    }
    return {
      kind: "answered",
      text: result.text,
      modelTrace: trace,
      tier,
      scene,
      billTo: trace.bill_to,
      providerResult: result,
    };
  } catch (error) {
    if (task.signal?.aborted) return cancelResult(task, scene, tier, passthrough);
    const failure = providerFailure(error);
    await sink.recordDegradation({
      from: DEEPSEEK_FLASH_MODEL_ID,
      to: null,
      reason: failure.message,
      action: task.action,
    });
    const state = sceneCircuits.get(scene) ?? { failures: 0, openUntil: 0 };
    state.failures += 1;
    if (state.failures >= CIRCUIT_FAILURE_THRESHOLD) {
      state.openUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
    }
    sceneCircuits.set(scene, state);
    return {
      kind: "unavailable",
      degraded: [{ from: DEEPSEEK_FLASH_MODEL_ID, to: null, reason: failure.message }],
      tier,
      scene,
      passthrough,
      failure: {
        kind: failure.kind,
        reason: failure.message,
        retryable: failure.retryable,
        attempted: [DEEPSEEK_FLASH_MODEL_ID],
      },
    };
  }
}

export { textScenePolicyReceipt };
