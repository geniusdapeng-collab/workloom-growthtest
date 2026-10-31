/**
 * llm-adapter.ts —— WorkLoom model-router ↔ SuperMickey LLMEngine 接口适配
 *
 * vendor 侧所有 LLM 调用点都期望 systems/llm-reasoning-engine.js 的接口：
 *   reason(prompt, opts)          → { success, content?, error?, retryable? }
 *   chat(system, user, temp)      → string（失败抛错）
 *   reasonRaw(prompt, opts)       → { success, content? ... }（不强制 JSON 提取）
 *   reasonStructured(prompt, schema, opts) → { success, data?/content? ... }
 * 本适配器用任意 OpenAI 兼容端点（底座 LLM_* 四环境变量）实现同一接口，
 * 不在 TS 层复制 vendor 的模型名等字面值——模型选择交由调用方/配置注入。
 *
 * v3.0 收口：配置 router 后，全部调用经 routeSmart（preproduction 场景，
 * 真实计量 + model.call 事件留痕 + 降级链），vendor 只读纪律不破。
 */
import {
  canonicalDeepSeekModel,
  OpenAiCompatibleProvider,
  routeSmart,
  type EventSink,
  type ModelPolicy,
  type ModelProvider,
  type PlanId,
} from "@workloom/base/model-router";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveOpenAiCompatibleBaseUrl,
  resolveVideoApiKey,
  resolveVideoModel,
} from "./llm-config.js";

export interface LLMReasonOptions {
  model?: string;
  systemPrompt?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  forceJson?: boolean;
  responseFormat?: { type: string };
  thinking?: Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Optional registered scene. Vendor callers may leave this unset. */
  scene?: string;
}

export interface LLMReasonResult {
  success: boolean;
  content?: string;
  data?: unknown;
  error?: string;
  retryable?: boolean;
  usage?: { promptTokens?: number; completionTokens?: number };
}

export interface WorkloomLLMEngineConfig {
  /** OpenAI 兼容端点，如 https://api.moonshot.cn/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  fastModel?: string;
  timeoutMs?: number;
  maxTokens?: number;
  /** Default scene for bridged vendor calls. */
  scene?: string;
  fetchImpl?: typeof fetch;
  /** Explicit provider setting retained for deployment compatibility. */
  thinking?: Record<string, unknown>;
  /**
   * v3.0 收口：注入路由配置后，全部 LLM 调用经 routeSmart
   * （场景 preproduction；opts.model===fastModel 的快速调用强制 L1 轻量档）——
   * 场景表 × 降级链 × 真实计量 × model.call 事件留痕，vendor 目录保持只读。
   */
  router?: {
    providers: Map<string, ModelProvider>;
    sink: EventSink;
    policy?: ModelPolicy;
    plan?: PlanId;
    /** 覆盖默认场景（默认 preproduction） */
    scene?: string;
    /** Legacy assembly receipt. Runtime still requires the canonical provider key. */
    modelChain?: string[];
    /** Deployment-level model pin. It bypasses tier substitution and fallback. */
    forceModel?: string;
    /** @deprecated Thinking is owned by scene policy. */
    nonThinking?: boolean;
  };
}

export class WorkloomLLMEngine {
  private readonly cfg: Required<Omit<WorkloomLLMEngineConfig, "router" | "thinking">> & {
    thinking?: Record<string, unknown>;
    router?: WorkloomLLMEngineConfig["router"];
  };
  readonly stats = { totalCalls: 0, totalFailures: 0 };

  get model(): string {
    return this.cfg.model;
  }

  get fastModel(): string {
    return this.cfg.fastModel;
  }

  constructor(config: WorkloomLLMEngineConfig) {
    this.cfg = {
      fastModel: config.model,
      timeoutMs: 180_000,
      maxTokens: config.maxTokens ?? 0,
      scene: config.scene ?? "video.preproduction.plan",
      fetchImpl: config.fetchImpl ?? fetch,
      ...config
    };
    this.cfg.model = canonicalDeepSeekModel(this.cfg.model);
  }

  /** v3.0 收口：装配后注入路由配置（宿主侧 seam；vendor 无感） */
  attachRouter(router: NonNullable<WorkloomLLMEngineConfig["router"]>): void {
    this.cfg.router = router;
  }

  /** Keep the director/customer assembly seam while enforcing the canonical provider. */
  attachConfiguredRouter(
    router: Omit<NonNullable<WorkloomLLMEngineConfig["router"]>, "providers" | "modelChain">,
  ): void {
    this.cfg.router = {
      ...router,
      providers: new Map<string, ModelProvider>([[
        this.cfg.model,
        new OpenAiCompatibleProvider(this.cfg.model, {
          baseUrl: this.cfg.baseUrl,
          apiKey: this.cfg.apiKey,
          fetchImpl: this.cfg.fetchImpl,
        }),
      ]]),
      modelChain: [this.cfg.model],
    };
  }

  /** 从底座变量构建；DEEPSEEK_* is accepted for OpenAI-compatible CLI/server deployments. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): WorkloomLLMEngine | null {
    const baseUrl = resolveOpenAiCompatibleBaseUrl(env);
    const apiKey = resolveVideoApiKey(env);
    const model = resolveVideoModel(env);
    if (!baseUrl || !apiKey || !model) return null;
    return new WorkloomLLMEngine({
      baseUrl,
      apiKey,
      model,
    });
  }

  private async callChat(prompt: string, opts: LLMReasonOptions): Promise<LLMReasonResult> {
    return this.requestChat(prompt, opts);
  }

  private async requestChat(prompt: string, opts: LLMReasonOptions): Promise<LLMReasonResult> {
    const activeModel = canonicalDeepSeekModel(opts.model ?? this.cfg.model);
    const scene = opts.scene
      ?? this.cfg.router?.scene
      ?? this.cfg.scene;
    const providers = this.cfg.router?.providers ?? new Map<string, ModelProvider>([[
      activeModel,
      new OpenAiCompatibleProvider(activeModel, {
        baseUrl: this.cfg.baseUrl,
        apiKey: this.cfg.apiKey,
        fetchImpl: this.cfg.fetchImpl,
      }),
    ]]);
    const sink: EventSink = this.cfg.router?.sink ?? {
      recordModelTrace: async () => undefined,
      recordDegradation: async () => undefined,
      recordCircuitBreak: async () => undefined,
    };
    try {
      const result = await routeSmart(
        {
          action: scene,
          scene,
          plan: this.cfg.router?.plan,
          ...(this.cfg.router?.forceModel
            ? { forceModel: canonicalDeepSeekModel(this.cfg.router.forceModel) }
            : {}),
          timeoutMs: opts.timeoutMs ?? this.cfg.timeoutMs,
          signal: opts.signal,
          // Vendor max-token values are historical product guesses. The
          // dispatcher calculates the complete legal window instead.
          generation: {
            temperature: opts.temperature,
            topP: opts.topP,
          },
          messages: [
            {
              role: "system",
              content: opts.systemPrompt
                ?? (opts.forceJson
                  ? "你是一个严格输出 JSON 的助手。除合法 JSON 外不要输出任何额外文字。"
                  : "你是一个可靠的助手。"),
            },
            { role: "user", content: prompt },
          ],
        },
        providers,
        sink,
        { policy: this.cfg.router?.policy },
      );
      if ((result.kind === "answered" || result.kind === "circuit_broken" || result.kind === "reused")
        && result.text) {
        return {
          success: true,
          content: result.text,
          usage: result.providerResult
            ? {
                promptTokens: result.providerResult.promptTokens,
                completionTokens: result.providerResult.completionTokens,
              }
            : undefined,
        };
      }
      return {
        success: false,
        error: result.failure?.reason
          ?? result.degraded?.at(-1)?.reason
          ?? `模型路由不可用（${result.kind}）`,
        retryable: false,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        retryable: false,
      };
    }
  }

  private static extractJson(text: string): unknown {
    return JSON.parse(text.trim());
  }

  async reason(prompt: string, options: LLMReasonOptions = {}): Promise<LLMReasonResult> {
    this.stats.totalCalls++;
    const result = await this.callChat(prompt, options);
    if (!result.success) this.stats.totalFailures++;
    if (result.success && options.forceJson && result.content) {
      try {
        result.data = WorkloomLLMEngine.extractJson(result.content);
      } catch (err) {
        this.stats.totalFailures++;
        return {
          ...result,
          success: false,
          error: `JSON 解析失败: ${err instanceof Error ? err.message : String(err)}`,
          retryable: false
        };
      }
    }
    return result;
  }

  async generate(prompt: string, options: LLMReasonOptions = {}): Promise<LLMReasonResult> {
    return this.reason(prompt, options);
  }

  async reasonRaw(prompt: string, options: LLMReasonOptions = {}): Promise<LLMReasonResult> {
    return this.callChat(prompt, { ...options, forceJson: false });
  }

  async chat(systemPrompt: string, userPrompt: string, temperature = 1): Promise<string> {
    const forceJson = /(?:只输出|严格输出|严格返回|仅返回|结构化).{0,32}(?:JSON|json)|(?:JSON|json).{0,32}(?:只输出|不要解释|不得解释|结构化)/u.test(systemPrompt);
    const result = await this.reason(userPrompt, { systemPrompt, temperature, ...(forceJson ? { forceJson: true } : {}) });
    if (!result.success || !result.content) {
      throw new Error(result.error ?? "LLM chat 调用失败");
    }
    return result.content;
  }

  async reasonStructured(
    prompt: string,
    schema: unknown,
    options: LLMReasonOptions = {}
  ): Promise<LLMReasonResult> {
    let schemaText: string | undefined;
    try {
      schemaText = JSON.stringify(schema, null, 2);
    } catch (error) {
      return {
        success: false,
        error: `结构化输出结构不可序列化: ${error instanceof Error ? error.message : String(error)}`,
        retryable: false,
      };
    }
    // Match the vendor interface: its caller supplies the actual IDs and field
    // template here, independently of any illustrative examples in the prompt.
    const structuredPrompt = [
      prompt,
      "",
      "【硬性输出要求】",
      "1. 只输出合法 JSON",
      "2. 不要输出 markdown 代码块",
      "3. 不要输出解释、前言、结尾",
      "4. 所有字段必须存在",
      "5. 输出必须能被 JSON.parse 直接解析",
      "",
      "【目标JSON结构示例】",
      schemaText,
    ].join("\n");
    const result = await this.reason(structuredPrompt, { ...options, forceJson: false });
    if (!result.success || !result.content) return result;
    const extracted = this._extractJsonObject(result.content);
    if (!extracted) {
      this.stats.totalFailures++;
      return {
        ...result,
        success: false,
        error: "JSON 解析失败: 未找到首个完整 JSON",
        retryable: false,
      };
    }
    try {
      return { ...result, data: JSON.parse(extracted) };
    } catch (error) {
      this.stats.totalFailures++;
      return {
        ...result,
        success: false,
        error: `JSON 解析失败: ${error instanceof Error ? error.message : String(error)}`,
        retryable: false,
      };
    }
  }

  /**
   * vendor 内部助手方法（2026-09-22 真机修复）
   *
   * `engines/requirement-discovery-engine.js:260` 直接调 `llmEngine._extractJsonObject(content)`；
   * 注入的是本适配器时该方法不存在 → `SceneArchitect` 连续两次失败 →
   * 日志出现「❌ 全部失败，使用兜底规则」→ 场景设计整段退化为规则模板（下游再补齐）。
   * 这里补上与 vendor `systems/llm-reasoning-engine.js:106` 同语义的实现（失败返回 null，不抛）。
   */
  _extractJsonObject(text: unknown): string | null {
    /**
     * 与 vendor `systems/llm-reasoning-engine.js#_extractJsonObject` **同语义**：
     * 返回**JSON 文本字符串**（调用方自己 `JSON.parse`），非字符串输入返回 null。
     *
     * 真机教训（VID-1022）：首版实现返回已解析对象，而
     * `requirement-discovery-engine.js:262` 是 `return JSON.parse(extracted)` →
     * `JSON.parse(对象)` 走 `String(对象)` → `"[object Object]" is not valid JSON`，
     * SceneArchitect 仍然全失败。此实现含输入截断与扫描预算，避免大响应冻结事件循环。
     */
    if (!text || typeof text !== "string") return null;
    const MAX_INPUT_LEN = 200_000;
    const input = text.length > MAX_INPUT_LEN ? text.slice(0, MAX_INPUT_LEN) : text;

    const fenced = input.match(/```json\s*([\s\S]*?)\s*```/i);
    if (fenced?.[1]) {
      const candidate = fenced[1].trim();
      try {
        JSON.parse(candidate);
        return candidate;
      } catch {
        /* 继续 */
      }
    }
    const whole = input.trim();
    if (whole) {
      try {
        JSON.parse(whole);
        return whole;
      } catch {
        /* 继续 */
      }
    }
    // 单次栈扫描找"顶层完整 JSON"候选（与 vendor 同算法，带 300ms 预算、不阻塞事件循环）
    const stack: Array<"{" | "["> = [];
    let inString = false;
    let escaped = false;
    let start = -1;
    const budgetStart = Date.now();
    let ops = 0;
    for (let i = 0; i < input.length; i += 1) {
      if ((++ops & 0x3fff) === 0 && Date.now() - budgetStart > 300) break;
      const ch = input[i]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === "{" || ch === "[") {
        if (stack.length === 0) start = i;
        stack.push(ch);
        continue;
      }
      if (ch === "}" || ch === "]") {
        const open = stack.pop();
        const matches = (open === "{" && ch === "}") || (open === "[" && ch === "]");
        if (!matches) {
          stack.length = 0;
          start = -1;
          continue;
        }
        if (stack.length === 0 && start >= 0) {
          const candidate = input.slice(start, i + 1);
          try {
            JSON.parse(candidate);
            return candidate;
          } catch {
            start = -1;
          }
        }
      }
    }
    return null;
  }

  /** vendor 调用点清理钩子（无持久连接，空实现保持接口一致） */
  async close(): Promise<void> {
    return undefined;
  }

  /** vendor 调用点统计钩子（返回本适配器的真实统计） */
  getStats(): { totalCalls: number; totalFailures: number; model: string } {
    return { ...this.stats, model: this.cfg.model };
  }
}

/**
 * vendor 自建 LLMEngine 的「原型桥」（2026-09-21 真机修复）
 *
 * 问题：vendor 多条链路（剧本引擎、需求洞察子引擎、提示词/微动作…）会**自己** `new LLMEngine({...})`，
 * 读的是 vendor 自己的旧环境变量与历史模型名。
 * 宿主注入的适配器只在主流水线生效，于是这些环节全部失败：
 *   `[ScriptGenerator] LLM引擎返回失败: API Key 未配置` → 剧本生成重试 3 次 → 预生产 pipeline.failed。
 *
 * 做法：**不改 vendor 目录**（只读纪律），在运行时把 vendor LLMEngine 原型的四个调用点
 * （reason / reasonRaw / reasonStructured / chat）重定向到宿主适配器 —— 这些方法被整体替换，
 * 构造函数里那句 `_noApiKey` 判断自然失效，模型/端点/计量/事件留痕全部走 WorkLoom 模型路由。
 *
 * 幂等：重复调用只覆盖一次；返回摘除函数（恢复原方法），便于测试与热重载。
 */
export function installVendorEngineBridge(engine: WorkloomLLMEngine): () => void {
  try {
    // 仓库根按**本模块位置**解析（服务进程 cwd 是 apps/server，用 cwd 会找不到 vendor）
    const repoRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "../../..");
    const vendorRequire = createRequire(resolvePath(repoRoot, "package.json"));
    const enginePath = resolvePath(repoRoot, "vendor/supermickey/systems/llm-reasoning-engine.js");
    if (!existsSync(enginePath)) return () => undefined;
    const mod = vendorRequire(enginePath) as { LLMEngine?: { prototype: Record<string, unknown> } };
    const prototype = mod?.LLMEngine?.prototype;
    if (!prototype) return () => undefined;
    const patched: Array<[string, unknown]> = [];
    const redirect = (name: string, impl: (...args: unknown[]) => unknown) => {
      if (typeof prototype[name] !== "function") return;
      patched.push([name, prototype[name]]);
      prototype[name] = impl;
    };
    redirect("reason", (prompt: unknown, options: unknown = {}) =>
      engine.reason(String(prompt ?? ""), options as LLMReasonOptions));
    redirect("reasonRaw", (prompt: unknown, options: unknown = {}) =>
      engine.reasonRaw(String(prompt ?? ""), options as LLMReasonOptions));
    redirect("reasonStructured", (prompt: unknown, schema: unknown, options: unknown = {}) =>
      engine.reasonStructured(String(prompt ?? ""), schema, options as LLMReasonOptions));
    redirect("chat", (systemPrompt: unknown, userPrompt: unknown, temperature: unknown = 1) => {
      const parsedTemperature = Number(temperature);
      return engine.chat(String(systemPrompt ?? ""), String(userPrompt ?? ""), Number.isFinite(parsedTemperature) ? parsedTemperature : 1);
    });
    redirect("generate", (prompt: unknown, options: unknown = {}) =>
      engine.generate(String(prompt ?? ""), options as LLMReasonOptions));
    return () => {
      for (const [name, original] of patched) prototype[name] = original;
    };
  } catch {
    // vendor 不在（例如只跑单测）时静默：桥接是增强，不是启动前置
    return () => undefined;
  }
}
