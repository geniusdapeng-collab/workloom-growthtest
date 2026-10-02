/**
 * GEO 获客 · Jev 决策模型接入 · 类型定义（单一事实源）
 *
 * 为什么是「决策模型」而不是「聊天模型」：Jev 不生成文本，只对同一份 state 回答若干
 * 类型化问题（boolean / choice / score），回答带概率与置信度。本目录是 growth 仓对该能力的
 * 唯一实现，落在行业侧（apps/server/src/industry/**，base-sync 排除路径），不改基座契约。
 *
 * 证据与边界（详见 README.md）：
 *   - 接入通道：① TypeSafe 官方直连（`POST /v1/systemone`，默认）；② Vercel AI Gateway
 *     （`typesafe-ai/jev`，evaluation 协议 v4，备选）；
 *   - 官方 jaggedness（docs.typesafe.ai/model-jaggedness/jev-1.13）：字面理解、不做算术与日期比较、
 *     对抗性内容可移动答案、CJK 支持弱于英文 —— 因此 instructions 一律用英文短句直述，
 *     state 只放决策必需的字段，任何算术/日期/逐字比对留在代码里；
 *   - 本模块只产出「决策 + 置信度 + 分流建议」，**不执行任何业务动作**，也不改变围栏判定。
 */

/**
 * 通道（provider）：
 *   - `typesafe`：TypeSafe 官方直连（官方 API v1，`/v1/systemone`；问题原语用官方名 `noul`）；
 *   - `vercel-gateway`：Vercel AI Gateway（evaluation 协议 v4，模型 id `typesafe-ai/jev`）。
 * 两条通道共用同一解析/校验/分流层，只有「URL + 鉴权头 + 请求体 + 问题类型名」不同。
 */
export type JevProvider = "typesafe" | "vercel-gateway";

/** 问题类型：与 TypeSafe 三种原语（boolean≈Noul / choice≈Choice / score≈Score）一一对应 */
export type QuestionType = "boolean" | "choice" | "score";

export interface BooleanQuestion {
  type: "boolean";
  /** 一句话直述要判断什么（英文；官方明确「字面理解」，不要写双关或双重否定） */
  instructions: string;
  /** 可选：true/false 各自的含义，边界情况写在这里 */
  criteria?: { true?: string; false?: string };
}

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  /** 选项键 → 该选项的含义（键是机器可读 id，含义用英文短句写清边界） */
  criteria: Record<string, string>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: string;
  /** 有序档位（低 → 高），至少两级 */
  criteria: string[];
}

export type JevQuestion = BooleanQuestion | ChoiceQuestion | ScoreQuestion;
export type JevQuestionSet = Record<string, JevQuestion>;

/** 发给网关的请求体（state + questions；协议头由 client.ts 负责） */
export interface JevRequest {
  state: unknown;
  questions: JevQuestionSet;
}

/** 单个问题的回答（已归一化；probabilities 之和在解析后保证为 1） */
export interface AnswerView {
  id: string;
  type: QuestionType;
  /** boolean：为真的概率；choice：被选项的概率；score：加权分 */
  probability?: number;
  /** choice / score：每个选项（档位）的概率 */
  probabilities?: Record<string, number>;
  /** choice：选中的键 */
  choice?: string;
  /** score：加权分（可为小数） */
  score?: number;
  /** 0~1；网关未回传时为派生值（见 confidenceDerived） */
  confidence: number;
  /** 置信度是派生值（取最大概率）而非模型自报 */
  confidenceDerived: boolean;
  /** 概率被重新归一化（网关按两位小数四舍五入，官方 PR #15 记录该行为） */
  probabilitiesRenormalized: boolean;
}

export interface JevCallResult {
  byId: Record<string, AnswerView>;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  /** 网关回传的模型 id（缺失时用请求时的 model） */
  model: string;
  /** 原始响应，便于钉死解析口径（--capture-raw / 首次接真 key 时使用） */
  raw: unknown;
}

/** 场景（一个业务判断的完整定义：怎么问、怎么读、中文怎么标注） */
export interface Scene {
  key: SceneKey;
  version: string;
  description: string;
  /** 主决策所在的问题 id 与类型 */
  primary: { id: string; type: QuestionType };
  /** 机器可读决策 → 中文标签（报告用） */
  labelsZh?: Record<string, string>;
  /** 由输入构造请求（state 只放决策必需字段） */
  build: (input: SceneInput) => JevRequest;
  /** 读取主决策 + 置信度 */
  decide: (result: JevCallResult) => SceneDecision;
}

export type SceneKey = "comment-classify" | "lead-qualify" | "fact-precheck";

/** 场景输入：三种场景共用 text 字段；其余字段按场景可选 */
export interface SceneInput {
  text: string;
  context?: Record<string, unknown>;
  /** fact-precheck 用：官方口径清单（事实判断的参照，必须由调用方从权威文档注入） */
  officialClaims?: string[];
}

export interface SceneDecision {
  /** 机器可读决策：choice 键 / 档位键 / "true"|"false" */
  decision: string;
  /** 中文标签（无映射时回退 decision） */
  decisionZh: string;
  confidence: number;
  confidenceDerived: boolean;
  /** 其它问题的答案（id → 取值），供分流与报告使用 */
  details: Record<string, number | string>;
}

/** 分流结果：shadow 恒为 true —— 本模块在任何情况下都不授予写权限 */
export type Route = "auto" | "review" | "human";

export interface GateDecision {
  route: Route;
  reasons: string[];
  shadow: true;
}

/** 数据集一行（JSONL） */
export interface ShadowRow {
  id: string;
  text: string;
  /** 人工/既有系统给出的期望标签（可选；有则可算准确率与校准） */
  expected?: string;
  context?: Record<string, unknown>;
  officialClaims?: string[];
}

export interface RowOutcome {
  id: string;
  scene: SceneKey;
  decision: string;
  decisionZh: string;
  confidence: number;
  confidenceDerived: boolean;
  route: Route;
  reasons: string[];
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  expected?: string;
  correct?: boolean;
  details: Record<string, number | string>;
  error?: string;
}

export interface ShadowReport {
  scene: SceneKey;
  sceneVersion: string;
  /** 接入通道（typesafe=官方直连 / vercel-gateway=网关）；同一份报告口径下必须可区分 */
  provider: JevProvider;
  /** 请求时使用的模型 id（可能是别名，如 jev-latest） */
  model: string;
  /** 响应里模型自报的 id（版本化，如 jev-1.13.0）；别名漂移时这里会变，是阈值失效的第一信号 */
  responseModels: string[];
  baseUrlHost: string;
  startedAt: string;
  durationMs: number;
  total: number;
  succeeded: number;
  failed: number;
  labeled: number;
  accuracy: number | null;
  macroF1: number | null;
  ece: number | null;
  eceBins: Array<{ lo: number; hi: number; n: number; avgConfidence: number | null; accuracy: number | null }>;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  latency: { p50: number; p95: number; max: number };
  routes: Record<Route, number>;
  autoRate: number;
  humanReviewRate: number;
  errors: Array<{ id: string; error: string }>;
}
