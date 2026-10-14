/** Executable photography/art/sound decisions preserve the source story; labels alone are not quality evidence. */
import { createHash } from "node:crypto";
import { sanitizeAudioField } from "./shot-spec.js";
export const CINEMATIC_CONTRACT_VERSION = "cinematic-contract/v1";
type Card = Record<string, unknown>;
export interface CinematicContinuity {
  axis: string; screenDirection: string; entryState: string; exitState: string;
  matchPreviousShotId?: string; transitionReason?: string;
}
export interface CinematicContract {
  version: typeof CINEMATIC_CONTRACT_VERSION; shotId: string; sourceSha256: string;
  purpose: string; framing: string; depth: string; lighting: string; action: string; camera: string; artDirection: string; sound: string;
  continuity: CinematicContinuity | null; explicit: boolean;
  rejectedSoundInstructions: string[];
}
export interface CinematicContractIssue { shotId: string; code: string; severity: "error" | "advisory"; detail: string }
export interface CinematicContractAudit {
  version: typeof CINEMATIC_CONTRACT_VERSION; pass: boolean; required: boolean;
  contracts: CinematicContract[]; issues: CinematicContractIssue[];
  evidence: { contract: "declared"; pictureQuality: "unverified"; soundQuality: "unverified" };
}
const text = (value: unknown): string => {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join("；");
  if (value && typeof value === "object") return Object.entries(value as Card).filter(([key]) => !key.startsWith("_")).map(([key, item]) => text(item) ? `${key}：${text(item)}` : "").filter(Boolean).join("；");
  return "";
};
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function cinematicStyleRequested(document: Card): boolean {
  return [document.productionStyle, document.editingProfile, document.filmStyle].some((value) => /^(?:cinematic|cinema|blockbuster|电影|电影感|电影叙事|大片|大片感|电影大片)$/i.test(text(value))) || document.requireCinematicContract === true;
}

/** Recover existing declared decisions without inventing lens, light source, people or musical score. */
export function buildCinematicContract(shot: Card): CinematicContract {
  const declared = shot.cinematic && typeof shot.cinematic === "object" && !Array.isArray(shot.cinematic) ? shot.cinematic as Card : {};
  const fields = shot.fields && typeof shot.fields === "object" && !Array.isArray(shot.fields) ? shot.fields as Card : {};
  const pick = (...keys: string[]): string => keys.map((key) => text(declared[key] ?? shot[key] ?? fields[key])).find(Boolean) ?? "";
  const continuityValue = declared.continuity ?? shot.continuity;
  const continuityRecord = continuityValue && typeof continuityValue === "object" && !Array.isArray(continuityValue) ? continuityValue as Card : null;
  const continuity = continuityRecord ? {
    axis: text(continuityRecord.axis), screenDirection: text(continuityRecord.screenDirection),
    entryState: text(continuityRecord.entryState), exitState: text(continuityRecord.exitState),
    ...(text(continuityRecord.matchPreviousShotId) ? { matchPreviousShotId: text(continuityRecord.matchPreviousShotId) } : {}),
    ...(text(continuityRecord.transitionReason) ? { transitionReason: text(continuityRecord.transitionReason) } : {}),
  } : null;
  const artDirection = pick("artDirection") || [pick("scene", "sceneDescription"), pick("props"), pick("costume"), pick("color_palette")].filter(Boolean).join("；");
  const sound = sanitizeAudioField(pick("sound", "audio", "backgroundSound", "background_sound"));
  return { version: CINEMATIC_CONTRACT_VERSION, shotId: text(shot.shotId ?? shot.id), sourceSha256: hash(shot), explicit: Object.keys(declared).length > 0,
    purpose: pick("purpose", "narrativePurpose", "director_instruction"), framing: pick("framing", "composition"),
    depth: pick("depth", "depth_of_field"), lighting: pick("lighting"), action: pick("action"),
    camera: pick("camera", "camera_movement", "cameraMovement"), artDirection, sound: text(sound.value), continuity, rejectedSoundInstructions: sound.stripped };
}

/** A continuity match is checked only when explicitly declared; story cuts may deliberately change state. */
export function auditCinematicContracts(shots: Card[], options: { required?: boolean; previousContracts?: CinematicContract[]; requiredShotIds?: string[] } = {}): CinematicContractAudit {
  const required = options.required ?? false;
  const issues: CinematicContractIssue[] = [];
  const issue = (shotId: string, code: string, detail: string): void => { issues.push({ shotId, code, detail, severity: required && (!options.requiredShotIds || options.requiredShotIds.includes(shotId)) ? "error" : "advisory" }); };
  const contracts = shots.map(buildCinematicContract);
  const known = new Map((options.previousContracts ?? []).map((contract) => [contract.shotId, contract]));
  const seen = new Set<string>();
  for (const contract of contracts) {
    if (!contract.shotId || seen.has(contract.shotId)) issues.push({ shotId: contract.shotId, code: "CINEMATIC_SHOT_ID_INVALID", severity: "error", detail: "Shot ids must be nonempty and unique" });
    seen.add(contract.shotId);
    const missing = (["purpose", "framing", "depth", "lighting", "action", "camera", "artDirection", "sound"] as const).filter((key) => !contract[key]);
    if (missing.length) issue(contract.shotId, "CINEMATIC_DECISIONS_MISSING", `Undeclared photography/art/sound decisions: ${missing.join(", ")}`);
    if (contract.rejectedSoundInstructions.length) issue(contract.shotId, "CINEMATIC_SOUND_BGM_CONFLICT", `Generation sound contract contains non-diegetic music instructions: ${contract.rejectedSoundInstructions.join("; ")}; choose picture-world action/ambient sound and leave score to postproduction`);
    if (!contract.continuity || [contract.continuity.axis, contract.continuity.screenDirection, contract.continuity.entryState, contract.continuity.exitState].some((value) => !value)) issue(contract.shotId, "CINEMATIC_CONTINUITY_MISSING", "Declare axis, screen direction and subject/prop entry/exit state; mark nonapplicable explicitly when appropriate");
    const relation = contract.continuity?.matchPreviousShotId;
    if (relation) {
      const previous = known.get(relation);
      if (!previous || !previous.continuity) issue(contract.shotId, "CINEMATIC_PREVIOUS_SHOT_UNKNOWN", `Continuity reference ${relation} does not name an earlier declared shot`);
      else if (previous.continuity.exitState !== contract.continuity!.entryState && !contract.continuity!.transitionReason) issue(contract.shotId, "CINEMATIC_STATE_JUMP", `Previous exit state and current entry state differ; declare the story transition reason`);
      else if ((previous.continuity.axis !== contract.continuity!.axis || previous.continuity.screenDirection !== contract.continuity!.screenDirection) && !contract.continuity!.transitionReason) issue(contract.shotId, "CINEMATIC_AXIS_JUMP", "Matching consecutive shots change axis/screen direction without a declared crossing/cutaway reason");
    }
    known.set(contract.shotId, contract);
  }
  return { version: CINEMATIC_CONTRACT_VERSION, pass: !issues.some((entry) => entry.severity === "error"), required, contracts, issues,
    evidence: { contract: "declared", pictureQuality: "unverified", soundQuality: "unverified" } };
}

/** Inject actual decisions into each generation route, with an idempotent source-bound section. */
export function appendCinematicContract(prompt: string, contract: CinematicContract, mode: "video" | "plate" = "video"): string {
  const clean = prompt.replace(/(?:\n| \| )?【摄影执行合同 [a-f0-9]{64}】[\s\S]*?【摄影执行合同结束】/g, "");
  const entries: Array<[string, string]> = [["叙事用途", contract.purpose], ["构图与主体比例", contract.framing], ["空间层次与清晰范围", contract.depth],
    ["动机光源与光向", contract.lighting], [mode === "plate" ? "关键帧动作状态" : "动作进程与完整性", contract.action],
    ...(mode === "video" ? [["运镜及叙事理由", contract.camera] as [string, string]] : []), ["美术与材质关系", contract.artDirection],
    ...(mode === "video" ? [["画内环境与动作声音", contract.sound] as [string, string]] : [])];
  if (contract.continuity) entries.push(["连续性", `轴线：${contract.continuity.axis}；屏幕方向：${contract.continuity.screenDirection}；进入：${contract.continuity.entryState}；离开：${contract.continuity.exitState}${contract.continuity.transitionReason ? `；转变依据：${contract.continuity.transitionReason}` : ""}`]);
  // Existing 25-field prompts already carry many decisions; duplicate prose wastes the vendor character budget.
  const lines = entries.filter(([, value]) => value && !clean.includes(value)).map(([label, value]) => `${label}：${value}`);
  if (!lines.length) return clean;
  return `${clean}\n【摄影执行合同 ${contract.sourceSha256}】\n${lines.join("\n")}\n已声明主体、道具、光源和故事意图优先；执行以上具体关系，不以电影感、滤镜、浅景深或大全景替代内容。声音仍遵守本镜音频纪律，配乐由后期处理。\n【摄影执行合同结束】`;
}
