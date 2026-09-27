/** A story's date is author data. Never replace it with today's date or a live shop page. */
export const ERA_PROFILE_VERSION = "workloom.era-profile/v1";
export type DevicePolicyName = "story-compatible" | "apple-2024plus";

export interface EraProfile {
  schemaVersion?: typeof ERA_PROFILE_VERSION;
  /** Earliest date in this shot's story, ISO calendar date. Explicit flashbacks use their own profile. */
  storyDate: string;
  /** Default is story-compatible; a brand requirement is always explicit. */
  devicePolicy?: DevicePolicyName;
}

export interface ResolvedEraProfile {
  readonly schemaVersion: typeof ERA_PROFILE_VERSION;
  readonly storyDate: string;
  readonly devicePolicy: DevicePolicyName;
}

export class EraProfileError extends Error {
  readonly status = "unverified";
  constructor(readonly code: "ERA_PROFILE_MISSING" | "ERA_PROFILE_INVALID", message: string) {
    super(message);
    this.name = "EraProfileError";
  }
}

/** Calendar arithmetic is explicit so invalid dates never normalize into a different story date. */
export function isIsoStoryDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
}

export function validateEraProfile(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["eraProfile 必须为对象"];
  const profile = value as Record<string, unknown>;
  const issues: string[] = [];
  if (profile.schemaVersion !== undefined && profile.schemaVersion !== ERA_PROFILE_VERSION) issues.push("eraProfile.schemaVersion 不受支持");
  if (!isIsoStoryDate(profile.storyDate)) issues.push("eraProfile.storyDate 必须为真实日历日期 YYYY-MM-DD；不能省略或使用 today/latest");
  if (profile.devicePolicy !== undefined && profile.devicePolicy !== "story-compatible" && profile.devicePolicy !== "apple-2024plus") {
    issues.push("eraProfile.devicePolicy 必须为 story-compatible 或 apple-2024plus");
  }
  const keys = new Set(["schemaVersion", "storyDate", "devicePolicy"]);
  for (const key of Object.keys(profile)) if (!keys.has(key)) issues.push(`eraProfile 未知字段 ${key}，不能静默忽略策略拼写错误`);
  return issues;
}

/** Whole-shot override permits deliberate flashbacks; fields are never mixed across two profiles. */
export function resolveEraProfile(local?: unknown, inherited?: unknown): ResolvedEraProfile {
  const raw = local === undefined ? inherited : local;
  if (raw === undefined) throw new EraProfileError("ERA_PROFILE_MISSING", "设备年代未验证：缺少冻结的 eraProfile.storyDate");
  const issues = validateEraProfile(raw);
  if (issues.length) throw new EraProfileError("ERA_PROFILE_INVALID", issues.join("；"));
  const value = raw as EraProfile;
  return Object.freeze({ schemaVersion: ERA_PROFILE_VERSION, storyDate: value.storyDate, devicePolicy: value.devicePolicy ?? "story-compatible" });
}

export function eraProfilePromptLines(profile?: unknown, inherited?: unknown): string[] {
  if (profile === undefined && inherited === undefined) return [];
  const era = resolveEraProfile(profile, inherited);
  return [
    `故事年代：${era.storyDate}（冻结日期；服装、器物与场景细节按此年代呈现，不自动更新到现在）。`,
    era.devicePolicy === "apple-2024plus"
      ? "设备档案：本片显式采用 apple-2024plus；已核实型号须同时满足 Apple 品牌、2024-01-01 起的世代及故事日期前已上市。"
      : "设备档案：按故事日期与镜头声明的具体品牌、型号和世代呈现；旧设备或其他品牌是否适用取决于本镜合同。",
  ];
}
