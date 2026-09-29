/**
 * 服务预生产到供应商资格签发之间的片型证据校验。
 * 调用方负责从当前 PG preproduction 回执读取 output 和 prompts 的原始字节，
 * 并按 output 里的摘要读取 report/shotlist；本函数只对这些已验字节做确定性复核。
 */
import {
  auditScenePolicy,
  type ScenePolicy,
  type ScenePolicyReport,
  type ScenePolicyShot,
  type ScenePolicyException,
} from "@hyperreality/video-studio";

type JsonRecord = Record<string, unknown>;

export interface ScenePolicySourceDecision {
  id: string | null;
  version: string | null;
  sourceSha256: string | null;
  reason: string;
  evidence: string[];
}

export interface ScenePolicyProductionSource {
  /** 服务在客户原始需求选型时写入事件账本的最新决策，由调用方按租户作用域读取。 */
  decision: ScenePolicySourceDecision;
  /** 从当前 bundle 知识目录读取；id 为 null 时传 null。 */
  policy: ScenePolicy | null;
  projectId: string;
  attempt: number;
  shotId: string;
  output: JsonRecord;
  prompts: JsonRecord;
  /** 按 output.scenePolicyReportSha256 验过原始字节的 JSON；缺失时传 null。 */
  report: ScenePolicyReport | null;
  /** 按 output.shotlistSha256 验过原始字节的 JSON；缺失时传 null。 */
  shotlist: JsonRecord | null;
}

export interface ScenePolicyProductionEvidence {
  policyId: string;
  policyVersion: string;
  policySourceSha256: string;
  attempt: number;
  shotId: string;
  reportRef: string;
  reportSha256: string;
  shotlistRef: string;
  shotlistSha256: string;
}

export class ScenePolicyRenderGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenePolicyRenderGateError";
  }
}

function fail(detail: string): never {
  throw new ScenePolicyRenderGateError(`片型渲染硬闸：${detail}`);
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function exactPolicy(value: unknown, policy: ScenePolicy): boolean {
  const candidate = record(value);
  return candidate?.id === policy.id && candidate.version === policy.version
    && candidate.sourceSha256 === policy.sourceSha256;
}

function exactSelection(value: unknown, decision: ScenePolicySourceDecision): boolean {
  const candidate = record(value);
  return candidate?.id === decision.id && candidate.version === decision.version
    && candidate.sourceSha256 === decision.sourceSha256 && candidate.reason === decision.reason
    && Array.isArray(candidate.evidence) && JSON.stringify(candidate.evidence) === JSON.stringify(decision.evidence);
}

function nonemptyHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

/**
 * 即便只签发一镜，也必须从完整 shotlist 重算时长加权比例；一份旧 report 的 passed:true
 * 和一个单镜 prompt 均不构成放行。已签发后的 sourceForShot 重验也必须调用本函数。
 */
export function verifyScenePolicyProductionSource(
  source: ScenePolicyProductionSource,
): ScenePolicyProductionEvidence | null {
  const { decision, policy, output, prompts, report, shotlist, attempt, shotId } = source;
  if (!Number.isSafeInteger(attempt) || attempt < 1 || !shotId.trim() || !source.projectId.trim())
    fail("项目、执行编号或镜头号无效");
  if (decision.id === null) {
    if (decision.version !== null || decision.sourceSha256 !== null) fail("空片型决策仍携带知识版本");
    if (policy || report || shotlist || output.scenePolicyPassed !== undefined
      || output.scenePolicyReportRef !== undefined || output.scenePolicyReportSha256 !== undefined
      || output.shotlistRef !== undefined || output.shotlistSha256 !== undefined || record(prompts.scenePolicy)?.id)
      fail("客户需求决策为无片型，但预生产带有片型产物，须重新选型和预生产");
    if (prompts.scenePolicy !== undefined && !exactSelection(prompts.scenePolicy, decision))
      fail("空片型提示词包与本次选型事件不一致");
    return null;
  }
  if (!policy || !nonemptyHash(policy.sourceSha256) || !exactPolicy(decision, policy))
    fail("客户原始需求的片型决策与当前知识条目不一致");
  if (output.success !== true || output.scenePolicyPassed !== true)
    fail(`${policy.id} 当前预生产未通过片型审计`);
  const base = `stages/preproduction/attempt-${attempt}`;
  const reportRef = `${base}.scene-policy-report.json`;
  const shotlistRef = `${base}.shotlist.json`;
  if (output.scenePolicyReportRef !== reportRef || !nonemptyHash(output.scenePolicyReportSha256)
    || output.shotlistRef !== shotlistRef || !nonemptyHash(output.shotlistSha256))
    fail(`${policy.id} 缺少本次完整片型审计报告或镜头表的摘要引用`);
  if (!report || report.schemaVersion !== "workloom.scene-policy-report/v1" || report.passed !== true
    || !Array.isArray(report.defects) || report.defects.length !== 0 || !exactPolicy(report.policy, policy)
    || report.policy.selection !== decision.reason)
    fail(`${policy.id} 审计报告不是当前通过的知识版本`);
  const sheetPolicy = record(shotlist?.scenePolicy);
  if (!shotlist || !exactPolicy(sheetPolicy, policy)
    || !exactSelection(shotlist.scenePolicySelection, decision)
    || !Array.isArray(shotlist.shots) || !shotlist.shots.length)
    fail(`${policy.id} 完整镜头表缺失或政策身份不一致`);
  const exceptions = sheetPolicy?.exceptions;
  if (exceptions !== undefined && (!Array.isArray(exceptions) || exceptions.some((item) => !record(item))))
    fail(`${policy.id} 客户场景例外格式无效`);
  const shots = shotlist.shots as ScenePolicyShot[];
  const replay = auditScenePolicy({
    title: typeof shotlist.title === "string" ? shotlist.title : "",
    scenePolicy: { id: policy.id, exceptions: (exceptions ?? []) as ScenePolicyException[] },
    shots,
  }, policy);
  if (!replay.passed || JSON.stringify({ totalSeconds: replay.totalSeconds, ratios: replay.ratios,
    planCues: replay.planCues, exceptionsApplied: replay.exceptionsApplied, defects: replay.defects })
    !== JSON.stringify({ totalSeconds: report.totalSeconds, ratios: report.ratios,
      planCues: report.planCues, exceptionsApplied: report.exceptionsApplied, defects: report.defects }))
    fail(`${policy.id} 镜头表重算与审计报告不一致，须重新预生产`);
  if (prompts.attempt !== attempt || prompts.stageId !== "preproduction"
    || !exactSelection(prompts.scenePolicy, decision) || !Array.isArray(prompts.shots)
    || prompts.shots.length !== shots.length)
    fail(`${policy.id} 本次完整提示词包与审计片单不一致`);
  const promptShots = prompts.shots as JsonRecord[];
  const promptById = new Map<string, JsonRecord>();
  for (const item of promptShots) {
    if (!record(item) || typeof item.shotId !== "string" || promptById.has(item.shotId))
      fail(`${policy.id} 本次提示词包有空号或重复镜头`);
    promptById.set(item.shotId, item);
  }
  for (const card of shots) {
    if (typeof card?.shotId !== "string" || typeof card.prompt !== "string"
      || !card.prompt.trim() || promptById.get(card.shotId)?.prompt !== card.prompt
      || promptById.get(card.shotId)?.durationSec !== Number(card.duration))
      fail(`${policy.id} 提示词包与完整镜头表的镜头/时长/提示词未逐一对应`);
  }
  const audited = shots.filter((item) => item?.shotId === shotId);
  const produced = promptShots.filter((item) => item?.shotId === shotId);
  if (audited.length !== 1 || produced.length !== 1)
    fail(`${policy.id} 镜头 ${shotId} 不在本次唯一完整片单中`);
  const card = audited[0]!;
  const prompt = produced[0]?.prompt;
  if (typeof prompt !== "string" || !prompt.trim() || card.prompt !== prompt)
    fail(`${policy.id} 镜头 ${shotId} 的实际供应商提示词与已审镜头卡不一致`);
  const primary = (card.policyTags ?? []).filter((tag) => policy.primaryTags.includes(tag));
  const required = [policy.prompt.scene, primary.length === 1 ? policy.prompt.byTag[primary[0]!] : "",
    card.speechMode === "on-camera" ? policy.prompt.speech : ""]
    .filter((item): item is string => typeof item === "string" && item.length > 0);
  if (required.some((text) => !prompt.includes(text)))
    fail(`${policy.id} 镜头 ${shotId} 的供应商提示词未包含片型/景别/口播约束`);
  return {
    policyId: policy.id,
    policyVersion: policy.version,
    policySourceSha256: policy.sourceSha256,
    attempt,
    shotId,
    reportRef,
    reportSha256: output.scenePolicyReportSha256,
    shotlistRef,
    shotlistSha256: output.shotlistSha256,
  };
}
