import { resolveScenePolicyForIntent, type ScenePolicyRouteDecision } from "./scene-policy-routing.js";
import { resolvePlatformForIntent } from "./platform-routing.js";

export const STUDIO_RESUME_INPUT_VERSION = "workloom.studio-resume-input/v1";
interface Scope { tenantId: string; workspaceId: string }
type SceneSelection = ReturnType<typeof resolveScenePolicyForIntent>;

export interface StudioResumeInput extends Scope {
  schemaVersion: typeof STUDIO_RESUME_INPUT_VERSION;
  projectId: string;
  projectCreatedAt: string | null;
  intent: string;
  rawIntent: string;
  metadata: Record<string, unknown>;
  isMarketing: boolean;
  requiresDelegation: boolean;
  scenePolicyDecision: ScenePolicyRouteDecision;
  scenePolicyInput: Record<string, unknown> | null;
  platformId: string;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** 只保存客户输入与受控选型，不把旧run的委托或已解析本机图片当作下一次运行的授权。 */
export function captureStudioResumeInput(
  scope: Scope,
  input: { projectId: string; intent: string; rawIntent?: string; metadata?: Record<string, unknown>; isMarketing?: boolean },
  context: { projectCreatedAt: string | null; requiresDelegation: boolean; scenePolicy: SceneSelection; platformId: string },
): StudioResumeInput {
  return JSON.parse(JSON.stringify({
    schemaVersion: STUDIO_RESUME_INPUT_VERSION,
    ...scope,
    projectId: input.projectId,
    projectCreatedAt: context.projectCreatedAt,
    intent: input.intent,
    rawIntent: input.rawIntent ?? input.intent,
    metadata: input.metadata ?? {},
    isMarketing: Boolean(input.isMarketing),
    requiresDelegation: context.requiresDelegation,
    scenePolicyDecision: context.scenePolicy.decision,
    scenePolicyInput: record(context.scenePolicy.metadata.scenePolicy),
    platformId: context.platformId,
  })) as StudioResumeInput;
}

export function restoreStudioResumeInput(
  value: unknown,
  scope: Scope,
  project: { projectId: string; createdAt: string | null; kind: "marketing" | "narrative" },
  intentOverride?: string,
): { ok: false; reason: string } | { ok: true; input: {
  projectId: string; intent: string; rawIntent: string; metadata: Record<string, unknown>; isMarketing: boolean;
  selectedScenePolicy: SceneSelection; selectedPlatform: ReturnType<typeof resolvePlatformForIntent>;
} } {
  const saved = record(value);
  if (!saved || saved.schemaVersion !== STUDIO_RESUME_INPUT_VERSION) {
    return { ok: false, reason: "恢复输入缺失或版本不可核实；请通过正式启动入口提供完整原需求与metadata，不能用项目标题代替。" };
  }
  if (saved.tenantId !== scope.tenantId || saved.workspaceId !== scope.workspaceId
    || saved.projectId !== project.projectId || saved.projectCreatedAt !== project.createdAt) {
    return { ok: false, reason: "恢复输入与当前项目身份不一致，拒绝复用其他项目或其他数据库代次的需求。" };
  }
  if (saved.requiresDelegation !== false) {
    return { ok: false, reason: "导演任务需要通过正式导演入口重新核验当前委托、身份和预算，不能在普通恢复入口降级为手工任务。" };
  }
  const metadata = record(saved.metadata);
  const decision = record(saved.scenePolicyDecision);
  if (!metadata || typeof saved.intent !== "string" || !saved.intent.trim()
    || typeof saved.rawIntent !== "string" || typeof saved.isMarketing !== "boolean"
    || saved.isMarketing !== (project.kind === "marketing") || !decision
    || !(decision.id === null || typeof decision.id === "string")
    || typeof decision.reason !== "string" || !Array.isArray(decision.evidence)
    || !decision.evidence.every((item) => typeof item === "string")
    || typeof saved.platformId !== "string") {
    return { ok: false, reason: "恢复输入不完整，原始约束与管线类型尚不可核实。" };
  }
  const scenePolicy = resolveScenePolicyForIntent("", decision.id === null ? undefined : {
    scenePolicy: record(saved.scenePolicyInput) ?? { id: decision.id },
  });
  if (scenePolicy.decision.id !== decision.id || scenePolicy.decision.version !== decision.version
    || scenePolicy.decision.sourceSha256 !== decision.sourceSha256) {
    return { ok: false, reason: "恢复输入绑定的片型知识版本已变化，需要重新确认原约束。" };
  }
  const platform = resolvePlatformForIntent("", { platform: saved.platformId });
  if (platform.decision.id !== saved.platformId) return { ok: false, reason: "恢复输入绑定的平台不再可解析。" };
  const intent = intentOverride ?? saved.intent;
  if (!intent.trim()) return { ok: false, reason: "恢复需求为空，拒绝启动。" };
  return { ok: true, input: {
    projectId: project.projectId,
    intent,
    rawIntent: intentOverride ?? saved.rawIntent,
    metadata,
    isMarketing: saved.isMarketing,
    selectedScenePolicy: { ...scenePolicy, decision: decision as unknown as ScenePolicyRouteDecision },
    selectedPlatform: platform,
  } };
}
