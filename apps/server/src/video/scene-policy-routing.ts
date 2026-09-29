/** 服务端原始需求选型：在建档及调用制片供应商前锁定片型知识条目。 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadScenePolicies,
  selectScenePolicy,
  type ScenePolicy,
} from "@hyperreality/video-studio";

const here = path.dirname(fileURLToPath(import.meta.url));
const POLICY_DIR = path.resolve(here, "../../../../bundles/ai-video/library/scene-policies");

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

export interface ScenePolicyRouteDecision {
  id: string | null;
  version: string | null;
  sourceSha256: string | null;
  reason: string;
  /** 字段路径与命中词，不存客户原文。 */
  evidence: string[];
}

export class ScenePolicyRouteError extends Error {
  constructor(message: string, readonly kind: "selection" | "catalog") {
    super(message);
    this.name = "ScenePolicyRouteError";
  }
}

/** 本仓随包安装的政策目录为唯一事实源；缺失/损坏时停止运行，不按无政策继续生成。 */
export function resolveScenePolicyForIntent(
  rawIntent: string,
  metadata?: Record<string, unknown>,
): { decision: ScenePolicyRouteDecision; policy: ScenePolicy | null; metadata: Record<string, unknown> } {
  let policies: ScenePolicy[];
  try {
    policies = loadScenePolicies(POLICY_DIR);
    if (policies.length === 0) throw new Error("片型知识目录为空");
  } catch (error) {
    throw new ScenePolicyRouteError(`片型知识库不可用：${error instanceof Error ? error.message : String(error)}`, "catalog");
  }

  const requested = record(metadata?.scenePolicy);
  if (metadata?.scenePolicy !== undefined && !requested) {
    throw new ScenePolicyRouteError("scenePolicy 必须是含 id 的对象", "selection");
  }
  const explicit = requested?.id ?? metadata?.scenePolicyId;
  const brief = record(metadata?.brief) ?? (typeof metadata?.brief === "string" ? { text: metadata.brief } : null);
  const briefPolicy = record(brief?.scenePolicy);
  if (brief?.scenePolicy !== undefined && !briefPolicy) {
    throw new ScenePolicyRouteError("brief.scenePolicy 必须是含 id 的对象", "selection");
  }
  if ((requested && Object.hasOwn(requested, "id") && (typeof requested.id !== "string" || !requested.id.trim()))
    || (metadata && Object.hasOwn(metadata, "scenePolicyId") && (typeof metadata.scenePolicyId !== "string" || !metadata.scenePolicyId.trim()))
    || (brief && Object.hasOwn(brief, "scenePolicyId") && (typeof brief.scenePolicyId !== "string" || !brief.scenePolicyId.trim()))
    || (briefPolicy && Object.hasOwn(briefPolicy, "id") && (typeof briefPolicy.id !== "string" || !briefPolicy.id.trim()))) {
    throw new ScenePolicyRouteError("scenePolicy.id 必须是非空片型 ID", "selection");
  }
  const exceptions = requested?.exceptions ?? briefPolicy?.exceptions;
  if (exceptions !== undefined && (!Array.isArray(exceptions) || exceptions.some((item) => !record(item)))) {
    throw new ScenePolicyRouteError("scenePolicy.exceptions 必须是例外对象数组", "selection");
  }
  let selected: ReturnType<typeof selectScenePolicy>;
  try {
    selected = selectScenePolicy({
      title: rawIntent,
      shots: [],
      ...(typeof explicit === "string" ? { scenePolicy: { id: explicit } } : {}),
    }, brief, policies);
  } catch (error) {
    throw new ScenePolicyRouteError(error instanceof Error ? error.message : String(error), "selection");
  }
  const decision: ScenePolicyRouteDecision = {
    id: selected.policy?.id ?? null,
    version: selected.policy?.version ?? null,
    sourceSha256: selected.policy?.sourceSha256 ?? null,
    reason: selected.reason,
    evidence: selected.evidence.slice(0, 30).map((item) => item.slice(0, 240)),
  };
  const next: Record<string, unknown> = { ...(metadata ?? {}), scenePolicySelection: decision };
  if (selected.policy) {
    next.scenePolicy = {
      ...(briefPolicy ?? {}),
      ...(requested ?? {}),
      id: selected.policy.id,
      version: selected.policy.version,
      sourceSha256: selected.policy.sourceSha256 ?? null,
    };
  }
  return { decision, policy: selected.policy, metadata: next };
}

/** 将被选中的政策写进供应商能看到的需求正文，避免 metadata 被旧 vendor 忽略。 */
export function appendScenePolicyGuidance(intent: string, policy: ScenePolicy | null): string {
  if (!policy) return intent;
  const ratios = Object.entries(policy.ratios).map(([tag, bound]) =>
    `${tag}${bound.min === undefined ? "" : `≥${Math.round(bound.min * 100)}%`}${bound.max === undefined ? "" : `≤${Math.round(bound.max * 100)}%`}`,
  ).join("、");
  const planCues = Object.keys(policy.requiredPlanCues ?? {}).join("、");
  return `${intent}\n[片型制作规范 ${policy.id}@${policy.version}] ${policy.prompt.scene} ${policy.prompt.speech}`
    + ` 全片镜头时长配比：${ratios}。每镜须标注 policyTags；全片须呈现：${planCues}。`
    + ` 视觉复核：${policy.prompt.visualReview}`;
}
