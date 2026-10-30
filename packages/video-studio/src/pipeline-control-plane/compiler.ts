import { createHash } from "node:crypto";
import YAML from "yaml";
import { z } from "zod";
import {
  COMPILED_PIPELINE_SCHEMA_VERSION,
  CompiledPipelinePlanSchema,
  StageContractSchema,
  type CompiledPipelinePlan,
  type PipelineEdge,
  type StageContract,
  type StageInputContract,
  type StageOutputContract,
  type StageSideEffect,
} from "./contracts.js";

const NonEmptyText = z.string().trim().min(1).max(300);

const SourceInputSchema = z.object({
  role: NonEmptyText,
  schema: NonEmptyText,
  required_checks: z.array(NonEmptyText).max(100).optional(),
}).strict();

const SourceStepSchema = z.object({
  step_key: NonEmptyText,
  name: NonEmptyText,
  owner: NonEmptyText,
  outputs: z.array(NonEmptyText).min(1).max(100),
  gate: NonEmptyText.optional(),
  depends_on: z.array(NonEmptyText).max(100).optional(),
  inputs: z.array(SourceInputSchema).min(1).optional(),
  side_effect: z.enum(["none", "local", "paid", "public"]).optional(),
  reversible: z.boolean().optional(),
  invalidates: z.array(NonEmptyText).max(500).optional(),
}).passthrough();

const SourcePipelineSchema = z.object({
  quest: NonEmptyText,
  name: NonEmptyText,
  version: z.union([z.string(), z.number()]),
  description: z.string().max(10_000).optional(),
  steps: z.array(SourceStepSchema).min(1).max(500),
}).passthrough();

type SourceStep = z.infer<typeof SourceStepSchema>;

export interface StageAdapterRegistration {
  id: string;
  pipelineKeys: readonly string[];
  stepKeys?: readonly string[];
}

export interface CompilePipelineOptions {
  knownOwners?: ReadonlySet<string>;
  knownGates?: ReadonlySet<string>;
  stageVersion?: number;
  adapterRegistry?: readonly StageAdapterRegistration[];
}

export interface PipelineCompileIssue {
  code: string;
  path: string;
  message: string;
}

export class PipelineCompileError extends Error {
  constructor(readonly issues: readonly PipelineCompileIssue[]) {
    super(`PIPELINE_COMPILE_FAILED: ${issues.map((issue) => `${issue.path} ${issue.code} ${issue.message}`).join("; ")}`);
    this.name = "PipelineCompileError";
  }
}

export const DEFAULT_KNOWN_GATES: ReadonlySet<string> = new Set([
  "G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9", "G10", "G11", "G12", "G13",
  "G-DLV1", "G-DLV4", "G-DLV5", "G-DLV7", "G-MAT1",
  "G-GEO1", "G-GEO2", "G-VIS1",
  "G-COL0", "G-COL1", "G-COL2", "G-COL3", "G-COL4",
]);

export const LEGACY_STAGE_ADAPTERS: readonly StageAdapterRegistration[] = [
  {
    id: "vendor-preproduction",
    pipelineKeys: ["narrative-film", "marketing-film"],
    stepKeys: [
      "intel-collect", "intel-review", "intel-competitor", "intel-verify", "intel-bind",
      "g1-dossier-confirm", "creative", "g2-theme-confirm", "truth-check", "insight",
      "g3-insight-confirm", "prd", "g4-prd-confirm", "production",
      "script", "scene", "opening", "visual", "audio", "continuity", "prompt-fuse",
      "field-check", "g6-prompt-confirm", "micromotion", "portrait", "g5-portrait-confirm",
      "g7-preproduction",
    ],
  },
  {
    id: "render-post",
    pipelineKeys: ["narrative-film", "marketing-film"],
    stepKeys: [
      "render", "render-script", "material-generate", "g8-render-submit", "post", "color",
      "subtitle", "voice", "bgm", "deliver", "post-quality", "archive", "revise",
    ],
  },
  {
    id: "operations",
    pipelineKeys: ["marketing-film", "account-ops", "ads-creative-factory", "settlement-recon"],
    stepKeys: ["publish-plan", "g9-publish-confirm", "publish", "watch"],
  },
  {
    id: "explainer",
    pipelineKeys: ["explainer-film"],
  },
  {
    id: "operations",
    pipelineKeys: ["account-ops", "ads-creative-factory", "settlement-recon"],
  },
  {
    id: "whiteboard",
    pipelineKeys: ["whiteboard"],
  },
];

function canonicalValue(value: unknown, seen = new Set<object>()): unknown {
  if (value === undefined) return null;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("PIPELINE_NON_FINITE_NUMBER");
    return value;
  }
  if (typeof value !== "object") throw new Error(`PIPELINE_UNSUPPORTED_VALUE: ${typeof value}`);
  if (seen.has(value)) throw new Error("PIPELINE_CYCLIC_VALUE");
  seen.add(value);
  const normalized = Array.isArray(value)
    ? value.map((entry) => canonicalValue(entry, seen))
    : Object.fromEntries(Object.keys(value as Record<string, unknown>)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined).sort()
      .map((key) => [key, canonicalValue((value as Record<string, unknown>)[key], seen)]));
  seen.delete(value);
  return normalized;
}

export function canonicalPipelineJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function pipelineSha256(value: unknown): string {
  return createHash("sha256").update(canonicalPipelineJson(value), "utf8").digest("hex");
}

export function stageContractHash(contract: StageContract): string {
  return pipelineSha256(contract);
}

function planVersion(value: string | number): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  const match = /^v?(\d+)$/u.exec(String(value).trim());
  const parsed = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`PIPELINE_VERSION_INVALID: ${String(value)}`);
  return parsed;
}

function artifactSchema(role: string): string {
  const normalized = role.toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  if (!normalized) throw new Error(`PIPELINE_OUTPUT_ROLE_INVALID: ${role}`);
  return `workloom.artifact/${normalized}/legacy-v1`;
}

function inferSideEffect(pipelineKey: string, step: SourceStep): StageSideEffect {
  if (step.side_effect) return step.side_effect;
  if (["publish", "comment-reply", "g10-dispatch"].includes(step.step_key)) return "public";
  if (["render", "material-generate", "portrait"].includes(step.step_key)) return "paid";
  if (["post", "color", "subtitle", "voice", "bgm", "deliver", "archive", "revise", "assemble",
    "render-script", "preflight", "hook-variants", "creative-shelve"].includes(step.step_key)) return "local";
  if (pipelineKey === "explainer-film" && step.step_key === "render") return "local";
  return "none";
}

function inferReversible(sideEffect: StageSideEffect, explicit?: boolean): boolean {
  if (typeof explicit === "boolean") return explicit;
  return sideEffect !== "paid" && sideEffect !== "public";
}

function resolveLegacyAdapter(
  pipelineKey: string,
  stepKey: string,
  registry: readonly StageAdapterRegistration[],
): string | null {
  const match = registry.find((entry) =>
    entry.pipelineKeys.includes(pipelineKey)
    && (!entry.stepKeys || entry.stepKeys.includes(stepKey)));
  return match?.id ?? null;
}

function descendantsByStep(steps: readonly SourceStep[], dependencies: Map<string, string[]>): Map<string, string[]> {
  const descendants = new Map(steps.map((step) => [step.step_key, [] as string[]]));
  for (const step of steps) {
    const stack = [...(dependencies.get(step.step_key) ?? [])];
    const seen = new Set<string>();
    while (stack.length) {
      const current = stack.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      descendants.get(current)?.push(step.step_key);
      stack.push(...(dependencies.get(current) ?? []));
    }
  }
  for (const [key, values] of descendants) descendants.set(key, [...new Set(values)]);
  return descendants;
}

function topologicallySort(
  steps: readonly SourceStep[],
  dependencies: Map<string, string[]>,
  issues: PipelineCompileIssue[],
): string[] {
  const byKey = new Map(steps.map((step) => [step.step_key, step]));
  const index = new Map(steps.map((step, position) => [step.step_key, position]));
  const indegree = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const step of steps) {
    const deps = dependencies.get(step.step_key) ?? [];
    indegree.set(step.step_key, deps.length);
    for (const dependency of deps) {
      if (!byKey.has(dependency)) {
        issues.push({
          code: "UNKNOWN_DEPENDENCY",
          path: `steps.${step.step_key}.depends_on`,
          message: `依赖节点 ${dependency} 不存在`,
        });
        continue;
      }
      children.set(dependency, [...(children.get(dependency) ?? []), step.step_key]);
    }
  }
  const queue = steps.filter((step) => (indegree.get(step.step_key) ?? 0) === 0)
    .map((step) => step.step_key)
    .sort((left, right) => (index.get(left) ?? 0) - (index.get(right) ?? 0));
  const sorted: string[] = [];
  while (queue.length) {
    const key = queue.shift()!;
    sorted.push(key);
    for (const child of children.get(key) ?? []) {
      const next = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, next);
      if (next === 0) {
        queue.push(child);
        queue.sort((left, right) => (index.get(left) ?? 0) - (index.get(right) ?? 0));
      }
    }
  }
  if (sorted.length !== steps.length) {
    const cycleMembers = steps.map((step) => step.step_key).filter((key) => !sorted.includes(key));
    issues.push({
      code: "DEPENDENCY_CYCLE",
      path: "steps",
      message: `依赖图有环：${cycleMembers.join(", ")}`,
    });
  }
  return sorted;
}

function compileStep(input: {
  pipelineKey: string;
  pipelineVersion: number;
  source: SourceStep;
  position: number;
  previous: SourceStep | null;
  dependencies: string[];
  stepByKey: Map<string, SourceStep>;
  descendants: Map<string, string[]>;
  options: CompilePipelineOptions;
  issues: PipelineCompileIssue[];
}): StageContract {
  const { source, options, issues } = input;
  if (options.knownOwners && !options.knownOwners.has(source.owner)) {
    issues.push({
      code: "UNKNOWN_OWNER",
      path: `steps.${source.step_key}.owner`,
      message: `岗位 ${source.owner} 未在已安装 presets 中登记`,
    });
  }
  if (source.gate && options.knownGates && !options.knownGates.has(source.gate)) {
    issues.push({
      code: "UNKNOWN_GATE",
      path: `steps.${source.step_key}.gate`,
      message: `门 ${source.gate} 未在已登记 Gate Registry 中`,
    });
  }
  const sideEffect = inferSideEffect(input.pipelineKey, source);
  const adapterId = resolveLegacyAdapter(
    input.pipelineKey,
    source.step_key,
    options.adapterRegistry ?? LEGACY_STAGE_ADAPTERS,
  );
  if (!adapterId) {
    issues.push({
      code: "UNKNOWN_ADAPTER",
      path: `steps.${source.step_key}.adapter`,
      message: `${input.pipelineKey}/${source.step_key} 没有登记的 StageAdapter`,
    });
  }
  const inputContract: StageInputContract[] = source.inputs
    ? source.inputs.map((entry) => ({
        role: entry.role,
        schema: entry.schema,
        requiredChecks: entry.required_checks ?? [],
      }))
    : input.dependencies.length
      ? input.dependencies.flatMap((dependency) =>
          (input.stepByKey.get(dependency)?.outputs ?? []).map((role) => ({
            role,
            schema: artifactSchema(role),
            requiredChecks: [`${dependency}:completed`],
          })))
      : [{
          role: "intent",
          schema: "workloom.video-intent/v1",
          requiredChecks: ["intent:frozen"],
        }];
  const outputContract: StageOutputContract[] = source.outputs.map((role) => ({
    role,
    schema: artifactSchema(role),
    requiredFields: [],
  }));
  return StageContractSchema.parse({
    stageKey: source.step_key,
    version: options.stageVersion ?? input.pipelineVersion,
    owner: source.owner,
    sideEffect,
    reversible: inferReversible(sideEffect, source.reversible),
    inputContract,
    outputContract,
    verify: {
      deterministic: ["schema", "adapter-output"],
      gate: source.gate ?? null,
    },
    dependencies: input.dependencies,
    invalidates: source.invalidates ?? input.descendants.get(source.step_key) ?? [],
    repairPolicy: {
      classes: [],
      ownerStage: null,
      maxAttempts: 0,
      requiresNewInputHash: true,
      forbiddenChanges: ["intent_contract", "product_facts", "confirmed_prd"],
      onSuccess: "continue-from-dirty-frontier",
    },
    adapterId: adapterId ?? "__unresolved__",
    executionStatus: "pending",
    verificationStatus: "not_run",
    disposition: "stop",
  });
}

/**
 * 把 YAML 声明编译成只读执行计划。编译器只生成数据和校验结果，不执行任何视频任务。
 *
 * 兼容策略：
 * - 旧 YAML 未写 depends_on 时，按声明顺序形成线性边；
 * - 未写 inputs 时，上游 outputs 是输入；
 * - 未写 invalidates 时，所有语义后代保守失效；
 * - 未写 side_effect 时按已知步骤做确定性分类；
 * - adapter、owner、gate 不做静默兜底，无法解析即编译失败。
 */
export function compilePipeline(input: unknown, options: CompilePipelineOptions = {}): CompiledPipelinePlan {
  const parsed = SourcePipelineSchema.safeParse(input);
  if (!parsed.success) {
    throw new PipelineCompileError(parsed.error.issues.map((issue) => ({
      code: "SOURCE_SCHEMA",
      path: issue.path.join("."),
      message: issue.message,
    })));
  }
  const source = parsed.data;
  const issues: PipelineCompileIssue[] = [];
  let version = 1;
  try {
    version = planVersion(source.version);
  } catch (error) {
    issues.push({ code: "VERSION_INVALID", path: "version", message: (error as Error).message });
  }
  const seen = new Set<string>();
  const stepByKey = new Map<string, SourceStep>();
  for (const [position, step] of source.steps.entries()) {
    if (seen.has(step.step_key)) {
      issues.push({
        code: "DUPLICATE_STEP",
        path: `steps.${position}.step_key`,
        message: `步骤 ${step.step_key} 重复`,
      });
    }
    seen.add(step.step_key);
    stepByKey.set(step.step_key, step);
  }
  const dependencies = new Map<string, string[]>();
  for (const [position, step] of source.steps.entries()) {
    const explicit = step.depends_on ?? [];
    const fallback = position > 0 ? [source.steps[position - 1]!.step_key] : [];
    const values = [...new Set((explicit.length ? explicit : fallback))];
    if (values.includes(step.step_key)) {
      issues.push({
        code: "SELF_DEPENDENCY",
        path: `steps.${step.step_key}.depends_on`,
        message: "步骤不能依赖自身",
      });
    }
    dependencies.set(step.step_key, values);
  }
  const order = topologicallySort(source.steps, dependencies, issues);
  const descendants = descendantsByStep(source.steps, dependencies);
  const contracts = source.steps.map((step, position) => compileStep({
    pipelineKey: source.quest,
    pipelineVersion: version,
    source: step,
    position,
    previous: position > 0 ? source.steps[position - 1]! : null,
    dependencies: dependencies.get(step.step_key) ?? [],
    stepByKey,
    descendants,
    options,
    issues,
  }));
  const edges: PipelineEdge[] = [];
  for (const contract of contracts) {
    for (const dependency of contract.dependencies) {
      const parent = contracts.find((candidate) => candidate.stageKey === dependency);
      const inputRoles = parent?.outputContract.map((entry) => entry.role) ?? [];
      for (const role of inputRoles.length ? inputRoles : ["output"]) {
        edges.push({ parent: dependency, child: contract.stageKey, inputRole: role });
      }
    }
  }
  if (issues.length) throw new PipelineCompileError(issues);
  const body = {
    schemaVersion: COMPILED_PIPELINE_SCHEMA_VERSION,
    pipelineKey: source.quest,
    name: source.name,
    version,
    steps: contracts,
    edges,
    topologicalOrder: order,
    sourceDigest: pipelineSha256(source),
  };
  const planHash = pipelineSha256(body);
  return CompiledPipelinePlanSchema.parse({ ...body, planHash });
}

export function parseAndCompilePipeline(source: string, options: CompilePipelineOptions = {}): CompiledPipelinePlan {
  let parsed: unknown;
  try {
    parsed = YAML.parse(source);
  } catch (error) {
    throw new PipelineCompileError([{
      code: "YAML_PARSE",
      path: "yaml",
      message: error instanceof Error ? error.message : String(error),
    }]);
  }
  return compilePipeline(parsed, options);
}

export function initialFrontier(plan: CompiledPipelinePlan): string[] {
  return plan.topologicalOrder.filter((key) => plan.steps.find((step) => step.stageKey === key)?.dependencies.length === 0);
}
