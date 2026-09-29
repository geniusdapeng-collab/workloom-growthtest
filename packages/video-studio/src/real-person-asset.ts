/**
 * real-person-asset —— 认证真人素材主档与一致性门（T-2026-0929-0007）
 *
 * 【事故复盘｜2026-09-29 真机】客户提供了平台已认证的真人素材 ID（`asset://asset-…`），
 * 但系统里**只有"这个引用能不能提交"的技术校验**（格式 + 隐私闸），没有任何地方记录
 * "这位真人是谁"（性别/年龄段/外观/授权范围）。人物描述全部来自镜头卡文案，于是
 * "文案写男性、素材是女性"时模型跟了文案 → 6 镜渲成男性 → 全部被监制以"身份与合同不符"拒收，
 * 白烧 6 镜 × 2 次渲染。
 *
 * 因此本模块把"认证真人"变成**一等公民**：主档是人物属性与授权的唯一事实源，
 * 出片前必须过一致性门，花钱前必须先出小样（canary），出片后必须做身份比对。
 *
 * 硬纪律：
 *   1 没有主档不放行：镜头卡写 `asset://` 但库里没有对应主档 → fail-closed（禁止临时编属性）；
 *   2 属性冲突不放行：主档说 female/三十岁上下，镜头卡写"男士/四十岁上下" → **硬阻断**；
 *   3 不能猜：主档缺 gender 等关键属性时，**停下来问**，不许"先生成再看看"；
 *   4 先小样后全片：多镜真人片必须先渲 1 镜 canary 并通过身份比对，再渲其余镜头；
 *   5 授权有效期内：过期/未授权 → fail-closed；每次使用都留资产 ID 与授权证据。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export const REAL_PERSON_ASSET_SCHEMA = "workloom.real-person-asset/v1" as const;
export const REAL_PERSON_POLICY_VERSION = "workloom.real-person-consistency/v1" as const;

export type CertifiedGender = "female" | "male" | "unspecified";

export interface RealPersonAsset {
  schemaVersion: typeof REAL_PERSON_ASSET_SCHEMA;
  /** 平台素材 ID（形如 asset-20260101000000-demo）；镜头卡的 assetRef 必须指向它 */
  assetId: string;
  displayName: string;
  /** 客户/平台认证时声明的属性（唯一事实源，禁止从上下文猜） */
  certified: {
    gender: CertifiedGender;
    ageBand?: string;
    hair?: string;
    appearance?: string;
    wardrobeBaseline?: string;
    source: string;
    verifiedAt?: string;
    evidence?: string;
  };
  authorization: {
    status: "real-authorized" | "pending" | "revoked";
    scope?: string;
    expiresAt?: string;
    evidence?: string;
  };
  role?: string;
  notes?: string[];
}

export interface RealPersonIssue { code: string; detail: string; hard: boolean }

export function realPersonAssetRef(assetId: string): string { return `asset://${assetId}`; }

export function isRealPersonAssetRef(value: unknown): boolean {
  return typeof value === "string" && /^asset:\/\/[A-Za-z0-9][A-Za-z0-9_-]*$/.test(String(value).trim());
}

export function assetIdOf(value: unknown): string {
  return String(value ?? "").trim().replace(/^asset:\/\//, "");
}

const FEMALE_WORDS = /女士|女性|女人|她|妈妈|姐姐|阿姨|女/;
const MALE_WORDS = /男士|男性|男人|他|爸爸|哥哥|叔叔|男/;
const AGE_PATTERNS: Array<{ band: string; pattern: RegExp }> = [
  { band: "二十岁上下", pattern: /二十(岁|出头)|2[0-9]\s*岁/ },
  { band: "三十岁上下", pattern: /三十(岁|上下|出头)|3[0-9]\s*岁/ },
  { band: "四十岁上下", pattern: /四十(岁|上下|出头)|4[0-9]\s*岁/ },
  { band: "五十岁上下", pattern: /五十(岁|上下|出头)|5[0-9]\s*岁/ }
];

/** 从文本里抽取性别词（"她/他"也算，中文代词是强信号） */
export function gendersInText(text: string): Set<"female" | "male"> {
  const found = new Set<"female" | "male">();
  if (FEMALE_WORDS.test(text)) found.add("female");
  if (MALE_WORDS.test(text)) found.add("male");
  return found;
}

export function ageBandInText(text: string): string | null {
  for (const entry of AGE_PATTERNS) if (entry.pattern.test(text)) return entry.band;
  return null;
}

/** 主档校验：属性齐全 + 授权有效 + schema 正确 */
export function verifyRealPersonAsset(asset: RealPersonAsset, options: { now?: Date } = {}): RealPersonIssue[] {
  const issues: RealPersonIssue[] = [];
  const push = (code: string, detail: string, hard = true): void => { issues.push({ code, detail, hard }); };
  if (asset.schemaVersion !== REAL_PERSON_ASSET_SCHEMA) push("schema-version", `schemaVersion=${String(asset.schemaVersion)}（应为 ${REAL_PERSON_ASSET_SCHEMA}）`);
  if (!asset.assetId?.trim()) push("asset-id-missing", "缺 assetId");
  if (!asset.displayName?.trim()) push("name-missing", "缺 displayName（出镜人姓名/称呼）");
  const gender = asset.certified?.gender;
  if (!gender) push("gender-missing", "主档缺 certified.gender：**必须向客户确认后补**，禁止先拍后猜（本门 fail-closed）");
  else if (!["female", "male", "unspecified"].includes(gender)) push("gender-invalid", `certified.gender=${String(gender)}`);
  if (!String(asset.certified?.source ?? "").trim()) push("source-missing", "缺 certified.source（属性从哪来：平台认证/客户确认/授权文件）");
  if (asset.authorization?.status !== "real-authorized") push("authorization", `authorization.status=${String(asset.authorization?.status)}（必须 real-authorized）`);
  const expiresAt = asset.authorization?.expiresAt;
  if (expiresAt) {
    const now = options.now ?? new Date();
    const at = new Date(expiresAt);
    if (Number.isNaN(at.getTime())) push("expiry-invalid", `expiresAt 非法：${expiresAt}`);
    else if (at.getTime() < now.getTime()) push("expiry-passed", `授权已过期：${expiresAt}`);
  }
  return issues;
}

export function loadRealPersonAssets(root: string, options: { now?: Date } = {}): {
  root: string;
  assets: Array<{ asset: RealPersonAsset; dir: string; issues: RealPersonIssue[] }>;
  byAssetId: Map<string, { asset: RealPersonAsset; dir: string; issues: RealPersonIssue[] }>;
} {
  const absRoot = resolve(root);
  const assets: Array<{ asset: RealPersonAsset; dir: string; issues: RealPersonIssue[] }> = [];
  if (existsSync(absRoot)) {
    for (const name of readdirSync(absRoot)) {
      const file = join(absRoot, name, "profile.json");
      if (!existsSync(file)) continue;
      const asset = JSON.parse(readFileSync(file, "utf8")) as RealPersonAsset;
      assets.push({ asset, dir: join(absRoot, name), issues: verifyRealPersonAsset(asset, options) });
    }
  }
  const byAssetId = new Map<string, { asset: RealPersonAsset; dir: string; issues: RealPersonIssue[] }>();
  for (const entry of assets) if (entry.asset.assetId) byAssetId.set(assetIdOf(entry.asset.assetId), entry);
  return { root: absRoot, assets, byAssetId };
}

/**
 * 出片前一致性门：镜头卡里所有可能被模型当成人物质感的文本，必须与主档属性一致。
 * 冲突即 **hard**（真机事故形态：文案写男性、素材认证为女性）。
 */
export function assertShotMatchesCertifiedAsset(shot: Record<string, unknown>, asset: RealPersonAsset): RealPersonIssue[] {
  const issues: RealPersonIssue[] = [];
  const push = (code: string, detail: string, hard = true): void => { issues.push({ code, detail, hard }); };
  const gender = asset.certified?.gender;
  const shotId = String(shot.shotId ?? "?");
  const fields = ["character", "sceneDescription", "action", "composition", "costume", "makeup", "props", "mood", "director_instruction"]
    .map((key) => String(shot[key] ?? "")).filter(Boolean);
  const text = fields.join("；");
  const declared = gendersInText(text);
  if (gender === "female" && declared.has("male") && !declared.has("female")) {
    push("gender-conflict", `${shotId}：主档认证为**女性**（${asset.displayName}），镜头卡却写男性（${fields.find((f) => MALE_WORDS.test(f))!.slice(0, 40)}…）——这会把素材里的人物顶掉`);
  } else if (gender === "male" && declared.has("female") && !declared.has("male")) {
    push("gender-conflict", `${shotId}：主档认证为**男性**，镜头卡却写女性`);
  } else if (gender === "unspecified") {
    push("gender-unspecified", `${shotId}：主档性别未确认 → 先向客户确认（本门 fail-closed）`);
  }
  const certifiedAge = asset.certified?.ageBand;
  const declaredAge = ageBandInText(text);
  if (certifiedAge && declaredAge && certifiedAge !== declaredAge) {
    push("age-conflict", `${shotId}：主档年龄段为 ${certifiedAge}，镜头卡写 ${declaredAge}`);
  }
  const assetRef = String(shot.assetRef ?? "").trim();
  if (assetRef && assetIdOf(assetRef) !== assetIdOf(asset.assetId)) {
    push("asset-mismatch", `${shotId}：镜头卡 assetRef=${assetRef} 与主档 ${asset.assetId} 不一致`);
  }
  return issues;
}

/** 出片后身份比对的判据文本（交给监制模型按主档属性核对抽帧，缺证据必须拒绝） */
export function identityReviewContext(asset: RealPersonAsset): Record<string, unknown> {
  return {
    policy: REAL_PERSON_POLICY_VERSION,
    assetId: assetIdOf(asset.assetId),
    displayName: asset.displayName,
    certified: asset.certified,
    discipline: "本镜出镜人必须是该平台认证真人的本人：先看性别与年龄段是否与主档一致（不一致直接判不合格），"
      + "再看是否有身份漂移（换脸/多人/第二张清晰人脸）。只有抽帧可见证据不足时才标未验证，不得猜测。"
  };
}

/** 人物使用清单（审计导出）：谁、哪个素材、用在哪几支片 */
export function realPersonUsageReceipt(input: { asset: RealPersonAsset; projectId: string; shots: string[]; at?: string }): Record<string, unknown> {
  return {
    at: input.at ?? new Date().toISOString(),
    policy: REAL_PERSON_POLICY_VERSION,
    assetId: assetIdOf(input.asset.assetId),
    displayName: input.asset.displayName,
    authorization: input.asset.authorization,
    projectId: input.projectId,
    shots: [...input.shots].sort(),
    note: "认证真人素材使用留痕：授权有效期与归属由平台侧管理，本工具不向平台核验（external-asset-id-not-provider-verified）"
  };
}
