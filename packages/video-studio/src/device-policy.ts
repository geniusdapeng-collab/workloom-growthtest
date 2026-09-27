/**
 * Exact, dated device records for a frozen story. This is a historical catalog, not a live shop list.
 * A declaration never proves rendered appearance; the producer must still inspect the actual media.
 */
import { eraProfilePromptLines, isIsoStoryDate, resolveEraProfile, type EraProfile, type ResolvedEraProfile } from "./era-profile.js";
import { shotText, splitShotAssertions, type ShotIntentStatus } from "./shot-intent.js";
export { ERA_PROFILE_VERSION, eraProfilePromptLines, resolveEraProfile, validateEraProfile, type EraProfile, type ResolvedEraProfile } from "./era-profile.js";

export const DEVICE_POLICY_VERSION = "workloom.device-era/v2";
export const DEVICE_POLICY_VERIFIED_AT = "2026-09-28";
export type DeviceCategory = "laptop" | "desktop" | "all-in-one" | "phone" | "tablet" | "display" | "wearable" | "audio" | "input";

export interface DeviceModelEntry {
  model: string;
  brand: string;
  category: DeviceCategory;
  aliases?: readonly string[];
  generation: string;
  /** Earliest documented public availability. A launch announcement is not availability. */
  availableFrom: string;
  source: string;
}

const sources = {
  pro: "https://www.apple.com/uk/newsroom/2024/10/new-macbook-pro-features-m4-family-of-chips-and-apple-intelligence/",
  air: "https://www.apple.com/ca/newsroom/2025/03/apple-introduces-the-new-macbook-air-with-the-m4-chip-and-a-sky-blue-color/",
  imac: "https://www.apple.com/newsroom/2024/10/apple-introduces-new-imac-supercharged-by-m4-and-apple-intelligence/",
  mini: "https://www.apple.com/uk/newsroom/2024/10/apples-new-mac-mini-is-more-mighty-more-mini-and-built-for-apple-intelligence/",
  studio: "https://www.apple.com/uk/newsroom/2025/03/apple-unveils-new-mac-studio-the-most-powerful-mac-ever/",
  display: "https://www.apple.com/au/newsroom/2022/03/apple-unveils-all-new-mac-studio-and-studio-display/",
  mobile: "https://www.apple.com/newsroom/2024/09/the-iphone-16-lineup-airpods-4-apple-watch-series-10-arrive-around-the-world/",
  ipad: "https://www.apple.com/newsroom/2024/05/the-redesigned-ipad-air-and-new-ipad-pro-are-available-today/",
  samsung: "https://news.samsung.com/us/samsung-galaxy-s24-series-now-available-in-us/",
} as const;

/** Records verified from the above dated first-party articles, frozen with this policy version. */
export const DEVICE_ALLOWLIST: readonly DeviceModelEntry[] = Object.freeze(([
  ...["M4", "M4 Pro", "M4 Max"].map((chip): DeviceModelEntry => ({
    model: `MacBook Pro (${chip}, 2024)`, brand: "Apple", category: "laptop", generation: `${chip}, 2024`,
    aliases: [`MacBook Pro ${chip}`, `MacBook Pro（${chip} 世代）`], availableFrom: "2024-11-08", source: sources.pro,
  })),
  { model: "MacBook Air (M4, 2025)", brand: "Apple", category: "laptop", generation: "M4, 2025", aliases: ["MacBook Air M4", "MacBook Air（M4 世代）"], availableFrom: "2025-03-12", source: sources.air },
  { model: "iMac (M4, 2024)", brand: "Apple", category: "all-in-one", generation: "M4, 2024", aliases: ["iMac M4"], availableFrom: "2024-11-08", source: sources.imac },
  ...["M4", "M4 Pro"].map((chip): DeviceModelEntry => ({
    model: `Mac mini (${chip}, 2024)`, brand: "Apple", category: "desktop", generation: `${chip}, 2024`,
    aliases: [`Mac mini ${chip}`], availableFrom: "2024-11-08", source: sources.mini,
  })),
  ...["M4 Max", "M3 Ultra"].map((chip): DeviceModelEntry => ({
    model: `Mac Studio (${chip}, 2025)`, brand: "Apple", category: "desktop", generation: `${chip}, 2025`,
    aliases: [`Mac Studio ${chip}`], availableFrom: "2025-03-12", source: sources.studio,
  })),
  { model: "Studio Display (2022)", brand: "Apple", category: "display", generation: "2022", aliases: ["Studio Display 2022"], availableFrom: "2022-03-18", source: sources.display },
  ...["iPhone 16", "iPhone 16 Plus", "iPhone 16 Pro", "iPhone 16 Pro Max"].map((model): DeviceModelEntry => ({
    model, brand: "Apple", category: "phone", generation: "2024", availableFrom: "2024-09-20", source: sources.mobile,
  })),
  { model: "iPad Pro (M4, 2024)", brand: "Apple", category: "tablet", generation: "M4, 2024", aliases: ["iPad Pro M4", "iPad Pro（M4 世代）"], availableFrom: "2024-05-15", source: sources.ipad },
  { model: "iPad Air (M2, 2024)", brand: "Apple", category: "tablet", generation: "M2, 2024", aliases: ["iPad Air M2"], availableFrom: "2024-05-15", source: sources.ipad },
  { model: "Apple Watch Series 10", brand: "Apple", category: "wearable", generation: "2024", availableFrom: "2024-09-20", source: sources.mobile },
  { model: "AirPods 4", brand: "Apple", category: "audio", generation: "2024", availableFrom: "2024-09-20", source: sources.mobile },
  { model: "Apple Pencil Pro", brand: "Apple", category: "input", generation: "2024", availableFrom: "2024-05-15", source: sources.ipad },
  ...["Magic Keyboard", "Magic Mouse", "Magic Trackpad"].map((model): DeviceModelEntry => ({
    model: `${model} (USB-C, 2024)`, brand: "Apple", category: "input", generation: "USB-C, 2024",
    aliases: [`${model} USB-C`], availableFrom: "2024-11-08", source: sources.imac,
  })),
  ...["Galaxy S24", "Galaxy S24+", "Galaxy S24 Ultra"].map((model): DeviceModelEntry => ({
    model: `Samsung ${model}`, brand: "Samsung", category: "phone", generation: "2024", aliases: [model],
    availableFrom: "2024-01-31", source: sources.samsung,
  })),
] satisfies DeviceModelEntry[]).map((entry) => Object.freeze({ ...entry, ...("aliases" in entry && entry.aliases ? { aliases: Object.freeze([...entry.aliases]) } : {}) })));

/** Kept for old imports; an old generation is never silently exempt from an explicit minimum year. */
export const DEVICE_SOFT_ALLOWLIST: readonly DeviceModelEntry[] = Object.freeze([]);
export const FORBIDDEN_DEVICE_BRANDS = ["联想", "ThinkPad", "戴尔", "Dell", "惠普", "HP", "华硕", "ASUS", "宏碁", "Acer", "华为", "HUAWEI", "荣耀", "小米", "Xiaomi", "Redmi", "OPPO", "vivo", "一加", "OnePlus", "realme", "三星", "Samsung", "Galaxy", "索尼", "Sony", "LG", "微软", "Surface", "谷歌", "Google", "Pixel", "罗技", "Logitech", "雷蛇", "Razer", "Bose", "森海塞尔", "Sennheiser"] as const;

export const DEVICE_PRESENCE_PATTERNS: ReadonlyArray<{ category: DeviceCategory; pattern: RegExp; label: string }> = [
  { category: "laptop", label: "笔记本电脑", pattern: /笔记本电脑|手提电脑|MacBook|ThinkPad|笔记本(?:屏幕|键盘|金属外壳|机身|合盖|立起|张开)/i },
  { category: "desktop", label: "台式机", pattern: /台式机|台式电脑|主机箱|Mac\s?mini|Mac\s?Studio/i },
  { category: "all-in-one", label: "一体机", pattern: /一体机|iMac/i },
  { category: "phone", label: "手机", pattern: /手机|iPhone|Galaxy\s?S\d+/i },
  { category: "tablet", label: "平板", pattern: /平板电脑|平板|iPad/i },
  { category: "display", label: "显示器", pattern: /显示器|显示屏|外接大屏|Studio\s?Display|Pro\s?Display/i },
  { category: "audio", label: "耳机", pattern: /耳机|耳麦|AirPods/i },
  { category: "input", label: "独立输入设备", pattern: /独立键盘|外接键盘|鼠标|触控板|数位板|Magic\s?(?:Keyboard|Mouse|Trackpad)|Apple\s?Pencil/i },
  { category: "wearable", label: "智能手表", pattern: /智能手表|Apple\s?Watch/i },
];

export interface DeviceDeclaration {
  category: DeviceCategory;
  model: string;
  role?: string;
  placement?: string;
}
export interface DeviceShotFields {
  shotId?: string;
  scene?: string;
  sceneDescription?: string;
  props?: unknown;
  composition?: string;
  action?: string;
  envNarrative?: string;
  devices?: DeviceDeclaration | DeviceDeclaration[];
  eraProfile?: EraProfile;
}
export interface DeviceDefect {
  rule: string;
  shotId: string;
  detail: string;
  hard: boolean;
  status?: "failed" | "unverified";
}
export interface DevicePolicyOptions { eraProfile?: EraProfile }

function normalizedName(value: string): string { return value.normalize("NFKC").replace(/[\s(),，]/g, "").toLowerCase(); }
export function findDeviceModel(model: string): DeviceModelEntry | undefined {
  if (typeof model !== "string" || !model.trim()) return undefined;
  const normalized = normalizedName(model);
  return DEVICE_ALLOWLIST.find((entry) => [entry.model, ...(entry.aliases ?? [])].some((candidate) => normalizedName(candidate) === normalized));
}
/** Exact catalog membership only; era/profile/category checks are performed by deviceDefects. */
export function isAllowedDeviceModel(model: string): boolean { return Boolean(findDeviceModel(model)); }
export function isSoftAllowedDeviceModel(_model: string): boolean { return false; }

export function allowedModelSummary(category?: DeviceCategory, profile?: ResolvedEraProfile): string {
  const entries = DEVICE_ALLOWLIST.filter((entry) => (!category || entry.category === category)
    && (!profile || (entry.availableFrom <= profile.storyDate && (profile.devicePolicy !== "apple-2024plus" || (entry.brand === "Apple" && entry.availableFrom >= "2024-01-01")))));
  return entries.slice(0, 6).map((entry) => entry.model).join(" / ") || "当前冻结目录没有匹配机型；须先核实官方年代与型号资料，不能用泛型号替代";
}

function textOf(shot: DeviceShotFields): string {
  return splitShotAssertions([shot.scene, shot.sceneDescription, shot.props, shot.composition, shot.action, shot.envNarrative].map(shotText).join("；")).positive;
}
function rawDevices(shot: DeviceShotFields): unknown[] {
  const raw = shot.devices;
  return raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

/** Every mentioned category needs a matching declaration; declaring one phone cannot cover a laptop. */
export function deviceDefects(shots: readonly DeviceShotFields[], options: DevicePolicyOptions = {}): DeviceDefect[] {
  const defects: DeviceDefect[] = [];
  const push = (rule: string, shotId: string, detail: string, status: "failed" | "unverified" = "failed") => defects.push({ rule, shotId, detail, hard: true, status });
  for (const shot of shots) {
    if (!isRecord(shot)) { push("device-input", "?", "镜头必须为对象", "unverified"); continue; }
    const shotId = typeof shot.shotId === "string" ? shot.shotId : "?";
    const text = textOf(shot);
    const present = DEVICE_PRESENCE_PATTERNS.filter((entry) => entry.pattern.test(text));
    const declared = rawDevices(shot);
    if (!present.length && !declared.length) continue;
    let profile: ResolvedEraProfile | undefined;
    try { profile = resolveEraProfile(shot.eraProfile, options.eraProfile); }
    catch (error) { push("device-era", shotId, error instanceof Error ? error.message : String(error), "unverified"); }
    const categories = new Set(DEVICE_PRESENCE_PATTERNS.map((entry) => entry.category));
    const validDeclarations: Array<{ raw: Record<string, unknown>; model: DeviceModelEntry }> = [];
    for (const [index, device] of declared.entries()) {
      if (!isRecord(device)) { push("device-declaration", shotId, `devices[${index}] 必须为对象`, "unverified"); continue; }
      if (!categories.has(device.category as DeviceCategory)) { push("device-category", shotId, `devices[${index}] 类别未声明或不受支持`, "unverified"); continue; }
      if (typeof device.model !== "string" || !device.model.trim()) { push("device-model", shotId, `devices[${index}] 缺具体 model，裸词不能替代机型`, "unverified"); continue; }
      for (const key of ["placement", "role"]) if (device[key] !== undefined && (typeof device[key] !== "string" || !device[key].trim())) push("device-declaration", shotId, `devices[${index}].${key} 必须为非空文字`, "unverified");
      const model = findDeviceModel(device.model);
      if (!model) {
        push("device-model", shotId, `机型「${device.model}」未在冻结目录精确核实；需型号与世代，不能子串匹配。候选：${allowedModelSummary(device.category as DeviceCategory, profile)}`, "unverified");
        continue;
      }
      validDeclarations.push({ raw: device, model });
      if (model.category !== device.category) push("device-category", shotId, `机型「${device.model}」目录类别为 ${model.category}，不能声明为 ${String(device.category)}`);
      if (!isIsoStoryDate(model.availableFrom)) { push("device-catalog", shotId, `目录日期非法：${model.model}`, "unverified"); continue; }
      if (profile && model.availableFrom > profile.storyDate) push("device-era", shotId, `机型「${model.model}」${model.availableFrom} 才上市，晚于冻结故事日期 ${profile.storyDate}（${model.source}）`);
      if (profile?.devicePolicy === "apple-2024plus") {
        if (model.brand !== "Apple") push("device-brand", shotId, `当前明确采用 apple-2024plus，「${model.model}」品牌为 ${model.brand}`);
        if (model.availableFrom < "2024-01-01") push("device-generation", shotId, `当前明确采用 apple-2024plus，「${model.model}」为 ${model.availableFrom} 世代；不存在软清单豁免`);
      }
    }
    for (const mention of present) {
      if (!validDeclarations.some((entry) => entry.model.category === mention.category && entry.raw.category === mention.category)) {
        push("device-declaration", shotId, `画面含${mention.label}，但没有该类别的有效 devices[] 声明；其他类别不能代替`, "unverified");
      }
    }
    // Brand mentions count only in a positive, device-bearing assertion, not a company/location name.
    if (profile?.devicePolicy === "apple-2024plus") {
      const clauses = text.split(/[；。！？]/).filter((clause) => DEVICE_PRESENCE_PATTERNS.some((entry) => entry.pattern.test(clause)));
      const brands = FORBIDDEN_DEVICE_BRANDS.filter((brand) => clauses.some((clause) => {
        const at = clause.toLowerCase().indexOf(brand.toLowerCase());
        return at >= 0 && (!/^[a-z]+$/i.test(brand) || !/[a-z]/i.test(clause[at - 1] ?? "") && !/[a-z]/i.test(clause[at + brand.length] ?? ""));
      }));
      if (brands.length) push("device-brand", shotId, `当前明确采用 apple-2024plus，设备肯定描述含其他品牌：${brands.join("、")}`);
    }
  }
  return defects;
}

export function summarizeDeviceDefects(defects: readonly DeviceDefect[]): { hard: number; soft: number; byRule: Record<string, number> } {
  const byRule: Record<string, number> = {};
  let hard = 0; let soft = 0;
  for (const defect of defects) { byRule[defect.rule] = (byRule[defect.rule] ?? 0) + 1; if (defect.hard) hard += 1; else soft += 1; }
  return { hard, soft, byRule };
}
export function devicePolicyStatus(shots: readonly DeviceShotFields[], options: DevicePolicyOptions = {}): ShotIntentStatus {
  const defects = deviceDefects(shots, options);
  if (defects.some((entry) => entry.status === "failed")) return "failed";
  if (defects.length) return "unverified";
  return shots.some((shot) => rawDevices(shot).length || DEVICE_PRESENCE_PATTERNS.some((entry) => entry.pattern.test(textOf(shot)))) ? "passed" : "not_applicable";
}
export function deviceDeclarationSummary(shot: DeviceShotFields): string {
  return rawDevices(shot).filter(isRecord).map((entry) => [entry.model, entry.placement, entry.role].filter((value) => typeof value === "string" && value.trim()).join(" · ")).join("；");
}
/** The actual model declaration, date and policy all enter the prompt; never a generic Apple slogan. */
export function devicePolicyPromptLines(shot: DeviceShotFields, options: DevicePolicyOptions = {}): string[] {
  const present = rawDevices(shot).length || DEVICE_PRESENCE_PATTERNS.some((entry) => entry.pattern.test(textOf(shot)));
  if (!present) return eraProfilePromptLines(shot.eraProfile, options.eraProfile);
  const defects = deviceDefects([shot], options);
  if (defects.length) {
    const error = new Error(defects.map((entry) => entry.detail).join("；"));
    Object.assign(error, { code: "DEVICE_CONTRACT_UNVERIFIED", status: defects.some((entry) => entry.status === "failed") ? "failed" : "unverified" });
    throw error;
  }
  return [...eraProfilePromptLines(shot.eraProfile, options.eraProfile), `设备声明：${deviceDeclarationSummary(shot)}。逐台保持型号、外观与摆放关系；不得生成未声明的替代机型。`];
}
