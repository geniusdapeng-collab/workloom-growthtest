/**
 * Factual identity and explicit wardrobe release contract. No paid I/O, face recognition,
 * ASR or RGB proxy runs here. The caller supplies current file fingerprints and preserves
 * receipts; a dedicated visual review may run through the existing producer-gate adapter.
 * General review policy and technical scores never grant identity release permission.
 */
import { createHash } from "node:crypto";
import { assetIdOf, referenceAssetRefs, verifyRealPersonAsset, type RealPersonAsset } from "./real-person-asset.js";

export const CHARACTER_RELEASE_SCHEMA = "workloom.character-release/v1" as const;
export const CHARACTER_IDENTITY_REVIEW_SCHEMA = "workloom.character-identity-review/v1" as const;
export type CharacterReleaseStatus = "passed" | "failed" | "unverified" | "not_applicable";
export interface CharacterReleaseIssue { code: string; shotId: string | null; status: "failed" | "unverified"; detail: string }
export interface CharacterArtifactFingerprint { path: string; sha256: string }
export interface CharacterIdentityAnchor extends CharacterArtifactFingerprint { assetId: string; source: string }
export interface CharacterWardrobeLock { id: string; description: string }
export interface CharacterWardrobeChange { declaredBy: string; source: string; reason: string }
export interface CharacterReleaseBindingInput {
  characterId: string; assetId: string; wardrobeLock: CharacterWardrobeLock; identityAnchor?: CharacterIdentityAnchor;
}
export interface CharacterReleaseShotInput {
  shotId: string; characterId: string; assetRef: string; referenceAssets?: string[];
  wardrobeLock?: CharacterWardrobeLock; wardrobeChange?: CharacterWardrobeChange;
}
export interface CharacterReleaseBinding extends CharacterReleaseBindingInput {
  assetGroupId: string; referenceAssets: string[]; assetProfileHash: string;
  authorization: RealPersonAsset["authorization"];
}
export interface CharacterReleaseShot extends CharacterReleaseShotInput {
  referenceAssets: string[]; wardrobeLock: CharacterWardrobeLock;
}
export interface CharacterReleaseContract {
  schemaVersion: typeof CHARACTER_RELEASE_SCHEMA; projectId: string; contractHash: string;
  status: CharacterReleaseStatus; characters: CharacterReleaseBinding[]; shots: CharacterReleaseShot[]; issues: CharacterReleaseIssue[];
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
/** Strings fingerprint exact UTF-8 bytes; objects use sorted JSON keys. */
export function characterReleaseHash(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(canonical(value)) ?? "undefined").digest("hex");
}
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const assetId = (value: unknown): boolean => text(value) && /^asset-[A-Za-z0-9][A-Za-z0-9_-]*$/.test(assetIdOf(value));
const fingerprint = (value: CharacterArtifactFingerprint | undefined): boolean => !!value && text(value.path) && sha(value.sha256);
const wardrobeValid = (value: CharacterWardrobeLock | undefined): boolean => !!value && text(value.id) && text(value.description);
const issue = (code: string, shotId: string | null, detail: string, status: CharacterReleaseIssue["status"] = "failed"): CharacterReleaseIssue => ({ code, shotId, status, detail });
const statusOf = (issues: CharacterReleaseIssue[]): CharacterReleaseStatus => issues.some((i) => i.status === "failed") ? "failed" : issues.length ? "unverified" : "passed";
const same = (a: unknown, b: unknown): boolean => characterReleaseHash(a) === characterReleaseHash(b);
function hashContract(contract: Omit<CharacterReleaseContract, "contractHash">): string { return characterReleaseHash(contract); }
function contractIssues(contract: CharacterReleaseContract, now: Date): CharacterReleaseIssue[] {
  if (!Number.isFinite(now.getTime())) return [issue("authorization-time-invalid", null, "授权核验时间无效，不能因NaN比较绕过到期检查")];
  const { contractHash, ...body } = contract;
  if (contract.schemaVersion !== CHARACTER_RELEASE_SCHEMA || !sha(contractHash) || hashContract(body) !== contractHash)
    return [issue("contract-fingerprint-invalid", null, "人物发布合同内容与摘要不一致")];
  const issues = [...contract.issues];
  for (const character of contract.characters) {
    const auth = character.authorization;
    if (auth.status !== "real-authorized" || !text(auth.scope) || !text(auth.evidence)) issues.push(issue("authorization-invalid", null, `${character.characterId} 授权未登记或已撤销`));
    if (auth.expiresAt && (!Number.isFinite(Date.parse(auth.expiresAt)) || Date.parse(auth.expiresAt) <= now.getTime())) issues.push(issue("authorization-expired", null, `${character.characterId} 授权无效或已过期`));
  }
  return issues;
}

/** Compile before paid rendering. The registered real-person asset group owns asset references. */
export function buildCharacterReleaseContract(input: {
  projectId: string; assets: readonly RealPersonAsset[]; characters: readonly CharacterReleaseBindingInput[];
  shots: readonly CharacterReleaseShotInput[]; now?: Date;
}): CharacterReleaseContract {
  const issues: CharacterReleaseIssue[] = []; const now = input.now ?? new Date();
  if (!text(input.projectId) || !Number.isFinite(now.getTime())) issues.push(issue("project-or-time-invalid", null, "项目或授权核验时间无效"));
  const assets = new Map<string, RealPersonAsset>();
  for (const asset of input.assets) {
    const id = assetIdOf(asset.assetId);
    if (assets.has(id)) issues.push(issue("asset-duplicate", null, `主档 ${id} 重复，禁止选择最后一份`));
    else assets.set(id, asset);
  }
  const characters: CharacterReleaseBinding[] = []; const ids = new Set<string>();
  for (const binding of input.characters) {
    if (!text(binding.characterId) || ids.has(binding.characterId)) issues.push(issue("character-duplicate-or-missing", null, "人物标识缺失或重复"));
    ids.add(binding.characterId);
    const asset = assets.get(assetIdOf(binding.assetId));
    if (!asset) { issues.push(issue("asset-unregistered", null, `${binding.characterId} 的真人主档未登记`)); continue; }
    for (const defect of verifyRealPersonAsset(asset, { now }).filter((i) => i.hard)) issues.push(issue(defect.code, null, defect.detail));
    if (!text(asset.authorization?.scope) || !text(asset.authorization?.evidence)) issues.push(issue("authorization-evidence-missing", null, `${binding.characterId} 缺授权范围或证据`));
    if (!assetId(asset.assetId) || (asset.referenceAssets ?? []).some((ref) => !assetId(ref))) issues.push(issue("asset-reference-invalid", null, `${binding.characterId} 主档含非法官方asset引用`));
    if ((asset.referenceAssets?.length ?? 0) && !text(asset.assetGroupId)) issues.push(issue("asset-group-missing", null, `${binding.characterId} 同组引用缺组ID`));
    if (!wardrobeValid(binding.wardrobeLock)) issues.push(issue("wardrobe-lock-missing", null, `${binding.characterId} 缺显式服饰锁`));
    if (binding.identityAnchor && (!fingerprint(binding.identityAnchor) || !text(binding.identityAnchor.source)
      || assetIdOf(binding.identityAnchor.assetId) !== assetIdOf(asset.assetId))) issues.push(issue("identity-anchor-invalid", null, `${binding.characterId} 基准图没有绑定主授权素材与来源`));
    characters.push({ ...structuredClone(binding), assetId: assetIdOf(asset.assetId), assetGroupId: asset.assetGroupId ?? "",
      referenceAssets: referenceAssetRefs(asset, 3), assetProfileHash: characterReleaseHash(asset), authorization: structuredClone(asset.authorization) });
  }
  const byCharacter = new Map(characters.map((c) => [c.characterId, c])); const seen = new Set<string>();
  const shots: CharacterReleaseShot[] = [];
  for (const shot of input.shots) {
    if (!text(shot.shotId) || seen.has(shot.shotId)) issues.push(issue("shot-duplicate-or-missing", shot.shotId || null, "镜头标识缺失或重复"));
    seen.add(shot.shotId);
    const character = byCharacter.get(shot.characterId);
    if (!character) { issues.push(issue("character-unregistered", shot.shotId, "镜头人物没有授权人物绑定")); continue; }
    if (!/^asset:\/\//.test(shot.assetRef) || assetIdOf(shot.assetRef) !== character.assetId) issues.push(issue("shot-asset-mismatch", shot.shotId, "镜头主素材与授权绑定不一致"));
    const allowed = new Set([character.assetId, ...(assets.get(character.assetId)?.referenceAssets ?? []).map(assetIdOf)]);
    if ((shot.referenceAssets ?? []).some((ref) => !/^asset:\/\//.test(ref) || !allowed.has(assetIdOf(ref)))) issues.push(issue("reference-not-authorized", shot.shotId, "镜头引用含未登记同组素材或角色档案旧ID"));
    const lock = shot.wardrobeLock ?? character.wardrobeLock;
    if (!wardrobeValid(lock)) issues.push(issue("wardrobe-lock-missing", shot.shotId, "镜头服饰锁缺失"));
    if (!same(lock, character.wardrobeLock) && (!shot.wardrobeChange || !text(shot.wardrobeChange.declaredBy)
      || !text(shot.wardrobeChange.source) || !text(shot.wardrobeChange.reason))) issues.push(issue("wardrobe-change-undeclared", shot.shotId, "跨镜换装没有逐镜声明、来源与理由"));
    shots.push({ ...structuredClone(shot), referenceAssets: [...character.referenceAssets], wardrobeLock: structuredClone(lock) });
  }
  const body = { schemaVersion: CHARACTER_RELEASE_SCHEMA, projectId: input.projectId, characters, shots, issues,
    status: issues.length ? "failed" as const : shots.length ? "passed" as const : "not_applicable" as const };
  return { ...body, contractHash: hashContract(body) };
}

export function generationIdentityLock(contract: CharacterReleaseContract, shotId: string, now = new Date()): {
  referenceAssets: string[]; promptFragment: string; contractHash: string; wardrobeHash: string;
} {
  const errors = contractIssues(contract, now);
  if (errors.length) throw new Error(`CHARACTER_CONTRACT_INVALID: ${errors.map((i) => i.detail).join("；")}`);
  const shot = contract.shots.find((s) => s.shotId === shotId);
  const character = shot && contract.characters.find((c) => c.characterId === shot.characterId);
  if (!shot || !character) throw new Error(`CHARACTER_SHOT_UNKNOWN: ${shotId}`);
  return { referenceAssets: [...character.referenceAssets], contractHash: contract.contractHash, wardrobeHash: characterReleaseHash(shot.wardrobeLock),
    promptFragment: `【授权人物合同】镜头 ${shotId} 只出现角色 ${character.characterId}；身份仅以同一授权素材组 ${character.assetGroupId || character.assetId} 的参考为准，不替换模特、不换脸、不添加第二个人。\n`
      + `【服饰锁定合同】${shot.wardrobeLock.id}：${shot.wardrobeLock.description}。${shot.wardrobeChange ? `本镜明确换装，来源：${shot.wardrobeChange.source}。` : "本镜沿用全片同一造型，禁止自行换装。"}` };
}
export function assessCharacterGenerationInput(input: { contract: CharacterReleaseContract; shotId: string; prompt: string; referenceAssets: readonly string[]; now?: Date }): {
  status: CharacterReleaseStatus; issues: CharacterReleaseIssue[];
} {
  const now = input.now ?? new Date(); const issues = contractIssues(input.contract, now);
  if (!issues.length) {
    try {
      const lock = generationIdentityLock(input.contract, input.shotId, now);
      if (!same(input.referenceAssets, lock.referenceAssets)) issues.push(issue("generation-references-differ", input.shotId, "生成输入必须逐镜使用相同的注册主素材与同组参考，不混入旧ID或未经验证的本地人像"));
      if (!input.prompt.includes(lock.promptFragment)) issues.push(issue("generation-lock-missing", input.shotId, "生成提示词没有实际写入完整身份与本镜服饰锁"));
    } catch (error) { issues.push(issue("generation-contract-invalid", input.shotId, error instanceof Error ? error.message : String(error))); }
  }
  return { status: statusOf(issues), issues };
}

export interface CharacterReviewFrame extends CharacterArtifactFingerprint { atSec: number }
export interface CharacterIdentityReviewRequest {
  schemaVersion: typeof CHARACTER_IDENTITY_REVIEW_SCHEMA; purpose: "identity-and-explicit-wardrobe";
  requestHash: string; projectId: string; shotId: string; characterId: string; assetId: string;
  contractHash: string; producerContractHash: string; clip: CharacterArtifactFingerprint;
  promptSha256: string; frames: CharacterReviewFrame[]; referenceImage: CharacterIdentityAnchor;
  wardrobeLock: CharacterWardrobeLock; rubric: string[]; context: Record<string, unknown>;
}
/** Caller must invoke producer-gate.reviewStage directly, independently of general review off. */
export function buildCharacterIdentityReviewRequest(input: {
  contract: CharacterReleaseContract; shotId: string; clip: CharacterArtifactFingerprint; promptSha256: string;
  frames: readonly CharacterReviewFrame[]; producerContractHash: string; now?: Date;
}): CharacterIdentityReviewRequest {
  const errors = contractIssues(input.contract, input.now ?? new Date());
  if (errors.length) throw new Error(`CHARACTER_REVIEW_CONTRACT_INVALID: ${errors.map((i) => i.detail).join("；")}`);
  const shot = input.contract.shots.find((s) => s.shotId === input.shotId);
  const character = shot && input.contract.characters.find((c) => c.characterId === shot.characterId);
  if (!shot || !character) throw new Error("CHARACTER_REVIEW_SHOT_UNKNOWN");
  if (!character.identityAnchor) throw new Error("CHARACTER_IDENTITY_UNVERIFIED: 缺登记的认证基准图，不能用生成首镜自行证明身份");
  if (!fingerprint(input.clip) || !sha(input.promptSha256) || !sha(input.producerContractHash)) throw new Error("CHARACTER_REVIEW_INPUT_INVALID: 视频、提示词或原稿合同摘要缺失");
  if (input.frames.length < 2 || input.frames.some((f) => !fingerprint(f) || !Number.isFinite(f.atSec) || f.atSec < 0)
    || new Set(input.frames.map((f) => f.path)).size !== input.frames.length
    || new Set(input.frames.map((f) => f.atSec)).size < 2) throw new Error("CHARACTER_REVIEW_FRAMES_INVALID: 至少两个不同时间的实际帧及摘要");
  const rubric = [
    "身份事实检查：把登记基准图与本镜各时间抽帧对比，逐帧检查脸型、眼型、鼻型、唇形及五官比例是否支持同一授权人物；换脸、替代模特或额外清晰人脸即拒绝。看不清、背影或证据不足只能未验证，不能靠肤色、衣服颜色或台词猜身份。",
    `显式服饰合同检查：本镜必须符合 ${shot.wardrobeLock.id}：${shot.wardrobeLock.description}。这项检查仅核对本片显式约定，不能把通用审美、发型偏好或品牌配饰偏好当硬闸。`,
    "本次只核验同一授权人物与本镜显式服饰合同。两项证据都充足且成立才approved=true；不支持或未验证均approved=false，reason说明哪项证据不足或违反合同。抽帧检查不代表逐帧身份认证、口型或听音通过。",
  ];
  const body = { schemaVersion: CHARACTER_IDENTITY_REVIEW_SCHEMA, purpose: "identity-and-explicit-wardrobe" as const,
    projectId: input.contract.projectId, shotId: input.shotId, characterId: character.characterId, assetId: character.assetId,
    contractHash: input.contract.contractHash, producerContractHash: input.producerContractHash, clip: { ...input.clip },
    promptSha256: input.promptSha256, frames: input.frames.map((f) => ({ ...f })), referenceImage: { ...character.identityAnchor },
    wardrobeLock: { ...shot.wardrobeLock }, rubric,
    context: { purpose: "identity-and-explicit-wardrobe", identityContractHash: input.contract.contractHash,
      characterId: character.characterId, assetId: character.assetId, assetGroupId: character.assetGroupId,
      checks: ["same-authorized-person", "explicit-wardrobe-contract"], wardrobeLock: shot.wardrobeLock,
      evidenceScope: "registered-reference-and-temporal-samples; not-biometric-certification" } };
  return { ...body, requestHash: characterReleaseHash(body) };
}

/** Minimal structural facade for the real producer-gate return, including its actual byte receipts. */
export interface CharacterVisualVerdict {
  stage: string; status: string; approved: boolean; via: string; model?: string; degraded: boolean;
  contractHash?: string; reason: string; score?: number; evidence?: Array<{ path: string; sha256: string; scope: string }>;
}
export interface CharacterIdentityEvidence {
  schemaVersion: "workloom.character-identity-evidence/v1"; method: "visual-identity" | "human-receipt" | "visual-observation";
  shotId: string; assetId: string; contractHash: string; clipSha256: string; promptSha256: string;
  checks: { identity: CharacterReleaseStatus; wardrobe: CharacterReleaseStatus }; reason: string;
  /** Joint review rejected; without structured per-check output this does not identify a changed face. */
  rejected?: boolean;
  receiptHash: string; visualReview?: { request: CharacterIdentityReviewRequest; verdict: CharacterVisualVerdict };
  reviewer?: string; source?: string; at?: string; frames?: CharacterReviewFrame[]; referenceImage?: CharacterIdentityAnchor;
}
function hashEvidence(evidence: Omit<CharacterIdentityEvidence, "receiptHash">): string { return characterReleaseHash(evidence); }
/** Pure adaptation at a trusted call boundary; a general score or asserted boolean is insufficient. */
export function adaptCharacterVisualVerdict(input: { request: CharacterIdentityReviewRequest; verdict: CharacterVisualVerdict }): CharacterIdentityEvidence {
  const { requestHash, ...requestBody } = input.request; const verdict = input.verdict;
  const receipts = Array.isArray(verdict.evidence) ? verdict.evidence.filter((receipt) =>
    !!receipt && text(receipt.path) && sha(receipt.sha256) && text(receipt.scope)) : [];
  const has = (f: CharacterArtifactFingerprint, scope: string): boolean => receipts.some((r) => r.path === f.path && r.sha256 === f.sha256 && r.scope === scope);
  const video = receipts.some((r) => r.path === input.request.clip.path && r.sha256 === input.request.clip.sha256
    && /^temporal-sample:(?:\d+(?:\.\d+)?,){1,}\d+(?:\.\d+)?; audio-not-reviewed$/.test(r.scope));
  const frameSetValid = Array.isArray(input.request.frames) && input.request.frames.length >= 2
    && input.request.frames.every((f) => fingerprint(f) && Number.isFinite(f.atSec) && f.atSec >= 0)
    && new Set(input.request.frames.map((f) => f.path)).size === input.request.frames.length
    && new Set(input.request.frames.map((f) => f.atSec)).size >= 2;
  const valid = requestHash === characterReleaseHash(requestBody) && input.request.schemaVersion === CHARACTER_IDENTITY_REVIEW_SCHEMA
    && input.request.purpose === "identity-and-explicit-wardrobe" && verdict.stage === "shot" && verdict.via === "llm"
    && text(verdict.model) && verdict.degraded === false && verdict.contractHash === input.request.producerContractHash
    && video && frameSetValid && has(input.request.referenceImage, "reference-image")
    && input.request.frames.every((frame) => has(frame, "image")) && text(verdict.reason);
  const state: CharacterReleaseStatus = valid && verdict.status === "passed" && verdict.approved === true ? "passed" : "unverified";
  const rejected = valid && verdict.status === "failed" && verdict.approved === false;
  const body = { schemaVersion: "workloom.character-identity-evidence/v1" as const, method: "visual-identity" as const,
    shotId: input.request.shotId, assetId: input.request.assetId, contractHash: input.request.contractHash,
    clipSha256: input.request.clip.sha256, promptSha256: input.request.promptSha256,
    checks: { identity: state, wardrobe: state }, rejected, reason: valid ? verdict.reason : "缺少可信专用视觉模型与完整字节绑定证据；技术分数不证明身份",
    visualReview: structuredClone(input) };
  return { ...body, receiptHash: hashEvidence(body) };
}

/** Agent/frame inspection may record a visible wardrobe contradiction, never positive face identity. */
export function createCharacterVisualObservation(input: {
  contract: CharacterReleaseContract; shotId: string; clip: CharacterArtifactFingerprint; promptSha256: string;
  frames: readonly CharacterReviewFrame[]; observedWardrobe: string; reviewer: string; source: string; at?: string;
}): CharacterIdentityEvidence {
  const shot = input.contract.shots.find((s) => s.shotId === input.shotId);
  const at = input.at ?? new Date().toISOString();
  if (!shot || !fingerprint(input.clip) || !sha(input.promptSha256) || !text(input.observedWardrobe)
    || !text(input.reviewer) || !text(input.source) || !Number.isFinite(Date.parse(at)) || input.frames.length < 2
    || input.frames.some((f) => !fingerprint(f) || !Number.isFinite(f.atSec) || f.atSec < 0)
    || new Set(input.frames.map((f) => f.path)).size !== input.frames.length || new Set(input.frames.map((f) => f.atSec)).size < 2)
    throw new Error("CHARACTER_OBSERVATION_INVALID: 需当前视频、提示词、两个实际时间帧及服饰观察来源");
  const body = { schemaVersion: "workloom.character-identity-evidence/v1" as const, method: "visual-observation" as const,
    shotId: shot.shotId, assetId: assetIdOf(shot.assetRef), contractHash: input.contract.contractHash,
    clipSha256: input.clip.sha256, promptSha256: input.promptSha256,
    checks: { identity: "unverified" as const, wardrobe: "failed" as const },
    reason: `实际可见服饰「${input.observedWardrobe}」违反本镜显式合同 ${shot.wardrobeLock.id}「${shot.wardrobeLock.description}」；本观察不认证人脸身份`,
    reviewer: input.reviewer, source: input.source, at, frames: input.frames.map((f) => ({ ...f })) };
  return { ...body, receiptHash: hashEvidence(body) };
}

export interface CharacterReleaseArtifact {
  shotId: string; clip: CharacterArtifactFingerprint; promptSha256: string; referenceAssets: string[]; evidence: CharacterIdentityEvidence[];
}
export interface CharacterReleaseReport {
  schemaVersion: "workloom.character-release-report/v1"; contractHash: string; status: CharacterReleaseStatus;
  releaseAllowed: boolean; continuePaidRendering: boolean; internalCandidateAllowed: boolean;
  authorizationScope: "registered-local-evidence-not-provider-verified";
  shots: Array<{ shotId: string; identity: CharacterReleaseStatus; wardrobe: CharacterReleaseStatus }>;
  issues: CharacterReleaseIssue[];
}
function validatedEvidence(evidence: CharacterIdentityEvidence, contract: CharacterReleaseContract, shot: CharacterReleaseShot,
  artifact: CharacterReleaseArtifact): { identity: CharacterReleaseStatus; wardrobe: CharacterReleaseStatus; rejected?: boolean } | null {
  if (!evidence || typeof evidence !== "object") return null;
  const { receiptHash, ...body } = evidence;
  if (evidence.schemaVersion !== "workloom.character-identity-evidence/v1" || !sha(receiptHash) || hashEvidence(body) !== receiptHash
    || evidence.shotId !== shot.shotId || evidence.contractHash !== contract.contractHash
    || evidence.assetId !== assetIdOf(shot.assetRef) || evidence.clipSha256 !== artifact.clip.sha256
    || evidence.promptSha256 !== artifact.promptSha256 || !text(evidence.reason)) return null;
  if (evidence.method === "visual-identity") {
    if (!evidence.visualReview || typeof evidence.visualReview !== "object") return null;
    const request = evidence.visualReview.request; const verdict = evidence.visualReview.verdict;
    if (!request || typeof request !== "object" || !verdict || typeof verdict !== "object"
      || !fingerprint(request.clip) || !fingerprint(request.referenceImage) || !Array.isArray(request.frames)
      || !Array.isArray(verdict.evidence)) return null;
    const adapted = adaptCharacterVisualVerdict(evidence.visualReview);
    if (adapted.receiptHash !== evidence.receiptHash) return null;
    const binding = contract.characters.find((c) => c.characterId === shot.characterId);
    if (!same(evidence.visualReview.request.wardrobeLock, shot.wardrobeLock)
      || !same(evidence.visualReview.request.referenceImage, binding?.identityAnchor)) return null;
    return { ...adapted.checks, rejected: adapted.rejected };
  }
  if (!text(evidence.reviewer) || !text(evidence.source) || !evidence.at || !Number.isFinite(Date.parse(evidence.at))
    || !evidence.checks || !evidence.frames || !Array.isArray(evidence.frames) || evidence.frames.length < 2
    || evidence.frames.some((f) => !fingerprint(f) || !Number.isFinite(f.atSec) || f.atSec < 0)
    || new Set(evidence.frames.map((f) => f.path)).size !== evidence.frames.length
    || new Set(evidence.frames.map((f) => f.atSec)).size < 2) return null;
  if (evidence.method === "visual-observation") return evidence.checks.wardrobe === "failed" ? { identity: "unverified", wardrobe: "failed" } : null;
  if (evidence.method !== "human-receipt") return null;
  const binding = contract.characters.find((c) => c.characterId === shot.characterId);
  if (!same(evidence.referenceImage, binding?.identityAnchor) || !fingerprint(evidence.referenceImage)) return null;
  if (!["passed", "failed", "unverified"].includes(evidence.checks.identity) || !["passed", "failed", "unverified"].includes(evidence.checks.wardrobe)) return null;
  return evidence.checks;
}

/** Missing identity evidence stops further paid rendering; existing clips can remain internal candidates. */
export function assessCharacterRelease(input: {
  contract: CharacterReleaseContract; shots: readonly CharacterReleaseArtifact[]; phase: "canary" | "release";
  canaryShotId?: string; canaryShotIds?: string[]; now?: Date;
}): CharacterReleaseReport {
  const issues = contractIssues(input.contract, input.now ?? new Date()); const contract = input.contract;
  const firstPerCharacter = contract.characters.map((c) => contract.shots.find((s) => s.characterId === c.characterId)?.shotId).filter((s): s is string => !!s);
  const canaries = input.canaryShotIds ?? (input.canaryShotId ? [input.canaryShotId] : firstPerCharacter);
  if (input.phase === "canary" && contract.characters.some((c) => !contract.shots.some((s) => s.characterId === c.characterId && canaries.includes(s.shotId))))
    issues.push(issue("canary-character-missing", null, "每个授权人物都需要独立canary身份回执", "unverified"));
  const expected = input.phase === "canary" ? contract.shots.filter((s) => canaries.includes(s.shotId)) : contract.shots;
  if (input.phase === "canary" && contract.shots.length && !expected.length) issues.push(issue("canary-shot-unknown", null, "canary镜头不属于当前人物合同", "unverified"));
  const byShot = new Map<string, CharacterReleaseArtifact>();
  for (const artifact of input.shots) {
    if (byShot.has(artifact.shotId)) issues.push(issue("artifact-duplicate", artifact.shotId, "同一镜头存在多个产物，禁止选择最后一份"));
    byShot.set(artifact.shotId, artifact);
  }
  const shots = expected.map((shot) => {
    const artifact = byShot.get(shot.shotId);
    let identity: CharacterReleaseStatus = "unverified"; let wardrobe: CharacterReleaseStatus = "unverified";
    if (!artifact || !fingerprint(artifact.clip) || !sha(artifact.promptSha256)) issues.push(issue("identity-artifact-missing", shot.shotId, "缺当前视频或提示词摘要，人物身份保持未验证", "unverified"));
    else {
      if (!same(artifact.referenceAssets, shot.referenceAssets)) issues.push(issue("generation-references-unbound", shot.shotId, "实际生成参考未绑定统一授权组，不能正式发布"));
      const evidence = (artifact.evidence ?? []).map((e) => validatedEvidence(e, contract, shot, artifact)).filter((e): e is NonNullable<typeof e> => !!e);
      if (evidence.some((e) => e.rejected)) issues.push(issue("dedicated-visual-review-rejected", shot.shotId, "专用人物/服饰联合评审未通过；没有逐项结构化结果，不宣称已证明换脸"));
      const fold = (key: "identity" | "wardrobe"): CharacterReleaseStatus => evidence.some((e) => e[key] === "failed") ? "failed"
        : evidence.some((e) => e[key] === "passed") ? "passed" : "unverified";
      identity = fold("identity"); wardrobe = fold("wardrobe");
      for (const [key, status] of [["identity", identity], ["wardrobe", wardrobe]] as const) if (status !== "passed")
        issues.push(issue(`${key}-${status}`, shot.shotId, key === "identity" ? "同一授权人物未验证或不成立；技术score、ASR和颜色都不能替代身份证据"
          : "本镜显式服饰合同未验证或不成立；通用审美review off不能豁免显式合同", status === "failed" ? "failed" : "unverified"));
    }
    return { shotId: shot.shotId, identity, wardrobe };
  });
  const status = contract.shots.length ? statusOf(issues) : issues.length ? statusOf(issues) : "not_applicable";
  return { schemaVersion: "workloom.character-release-report/v1", contractHash: contract.contractHash, status,
    releaseAllowed: input.phase === "release" && (status === "passed" || status === "not_applicable"),
    continuePaidRendering: input.phase === "canary" && (status === "passed" || status === "not_applicable"),
    internalCandidateAllowed: input.shots.some((s) => fingerprint(s.clip)), authorizationScope: "registered-local-evidence-not-provider-verified", shots, issues };
}
