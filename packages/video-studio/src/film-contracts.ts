/** Persist author facts once and carry the same scoped contract into every film review. */
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveEraProfile, type ResolvedEraProfile } from "./era-profile.js";
import { buildProducerReviewContract, reviewStage, REVIEW_CONTEXT_BUDGET, type ProducerGateOptions, type ProducerReviewContracts, type ProducerVerdict } from "./producer-gate.js";
import type { SceneBible } from "./scene-bible.js";

export interface FilmAuthorContext {
  schemaVersion: "workloom.film-author-context/v1";
  projectId: string;
  eraProfile: ResolvedEraProfile;
}
const validProject = (id: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) && !id.includes("..");
export function storyDateAt(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new Error("FILM_DATE_INVALID");
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  return ["year", "month", "day"].map((name) => parts.find((part) => part.type === name)!.value).join("-");
}
/** Atomic create-only publication means two first authors never read a partial context. */
export function loadOrCreateFilmAuthorContext(input: { path: string; projectId: string; eraProfile?: unknown; now?: Date }): FilmAuthorContext {
  if (!validProject(input.projectId)) throw new Error("FILM_PROJECT_INVALID");
  const explicit = input.eraProfile === undefined ? undefined : resolveEraProfile(input.eraProfile);
  const parent = dirname(input.path);
  mkdirSync(parent, { recursive: true });
  if (lstatSync(parent).isSymbolicLink()) throw new Error("FILM_CONTEXT_PATH_INVALID: context directory is a symbolic link");
  const read = (): FilmAuthorContext => {
    const fd = openSync(input.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size === 0 || stat.size > 16_384) throw new Error("FILM_CONTEXT_INVALID: invalid context file");
      const value = JSON.parse(readFileSync(fd, "utf8")) as FilmAuthorContext;
      if (value.schemaVersion !== "workloom.film-author-context/v1" || value.projectId !== input.projectId) throw new Error("FILM_CONTEXT_SCOPE_MISMATCH");
      const era = resolveEraProfile(value.eraProfile);
      if (explicit && JSON.stringify(era) !== JSON.stringify(explicit)) throw new Error("FILM_ERA_CONFLICT: source era differs from the frozen project; author a new project revision explicitly");
      return { schemaVersion: value.schemaVersion, projectId: value.projectId, eraProfile: era };
    } finally { closeSync(fd); }
  };
  try { return read(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const value: FilmAuthorContext = { schemaVersion: "workloom.film-author-context/v1", projectId: input.projectId,
    eraProfile: explicit ?? resolveEraProfile({ storyDate: storyDateAt(input.now ?? new Date()) }) };
  const temp = join(parent, `.film-context-${randomUUID()}.tmp`);
  const fd = openSync(temp, "wx", 0o600);
  try {
    try { writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fsyncSync(fd); }
    finally { closeSync(fd); }
    try { linkSync(temp, input.path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally { unlinkSync(temp); }
  return read();
}

export interface FilmContractSource {
  projectId: string;
  shots: Array<Record<string, unknown>>;
  eraProfile: ResolvedEraProfile;
  sceneBible?: SceneBible;
}
/** Clone source facts, never enhanced/mutating working cards; a local era overrides the whole project profile. */
export function filmReviewContracts(source: FilmContractSource, shotId?: string): ProducerReviewContracts {
  const selected = shotId === undefined ? source.shots : source.shots.filter((shot) => shot.shotId === shotId);
  if (!selected.length || (shotId !== undefined && selected.length !== 1)) throw new Error("FILM_REVIEW_SCOPE_INVALID");
  return structuredClone({ shots: selected, eraProfile: source.eraProfile, ...(source.sceneBible === undefined ? {} : { sceneBible: source.sceneBible }) });
}
/** A passed review without the exact author contract cannot become a stage receipt. */
export async function reviewFilmStage(source: FilmContractSource, options: Omit<ProducerGateOptions, "contracts">,
  reviewer: (options: ProducerGateOptions) => Promise<ProducerVerdict> = reviewStage): Promise<ProducerVerdict> {
  if (options.projectId !== source.projectId) throw new Error("FILM_REVIEW_PROJECT_MISMATCH");
  const requested = options.context?.shotId;
  if (requested !== undefined && (typeof requested !== "string" || !requested)) throw new Error("FILM_REVIEW_SCOPE_INVALID");
  const contracts = filmReviewContracts(source, requested as string | undefined);
  // reviewStage performs structured validation and returns failed/unverified with the cause.
  /**
   * 原稿合同（authorContracts）与结构化合同（reviewStage 里的 contractText）会同时进入评审上下文，
   * 同一份事实被投递两遍。短合同没问题；**长合同会把单次评审预算直接翻倍**（真机 2026-09-29：
   * 6 镜富字段片的连续性评审 57k > 30k 预算，环节无法运行）。
   *
   * 口径：装得下就照旧带原稿；装不下则**不静默截断**——省略原稿并在上下文里写明省略原因，
   * 完整原稿仍由调用方以产物正文送审（continuity 环节送审的就是镜头卡文件本身）。
   */
  const built = buildProducerReviewContract(contracts);
  const withAuthorContracts = { ...options.context, authorContracts: contracts };
  const fitsBudget = JSON.stringify(withAuthorContracts).length + JSON.stringify(built).length <= REVIEW_CONTEXT_BUDGET;
  const context = fitsBudget
    ? withAuthorContracts
    : { ...options.context, authorContractsOmitted: "原稿合同超出单次评审预算：未在上下文里重复投递；完整原稿见本环节送审产物正文" };
  const verdict = await reviewer({ ...options, contracts, context });
  if (!verdict.approved) return verdict;
  /**
   * 合同哈希必须在评审**之后**重算：源稿在评审期间被改动时（TOCTOU），裁决不得被采信。
   */
  const expected = buildProducerReviewContract(filmReviewContracts(source, requested as string | undefined)).contractHash;
  if (verdict.contractHash !== expected) return { ...verdict, status: "unverified", approved: false, degraded: true, rerun: true,
    reason: "FILM_REVIEW_CONTRACT_MISMATCH", issues: [...verdict.issues, "监制裁决没有绑定当前完整源合同"] };
  return verdict;
}
