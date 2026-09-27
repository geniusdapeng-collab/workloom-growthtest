/**
 * device-policy.ts —— **镜头内电子设备的硬约束**（2026-09-27 产品所有者口径）
 *
 * 产品所有者原话：凡是场景中出现的电子设备（笔记本电脑、台式机、手机、平板、显示器等），
 * **全部使用 2024 年之后的苹果设备**；这一条作为**硬约束写进系统底层**。
 *
 * 为什么做成"清单 + 声明 + 三处同源"而不是一句提示词：
 *   · 提示词一句话只能降低发生率，不能拦住"模型自己补了一台杂牌笔记本/旧机型"；
 *   · 机型世代是**会变的事实**（每年换新），所以清单必须集中一处、可核对（`verifiedAt` + `source`）、
 *     可扩展（新增机型只需加一条），并让审计、提示词、监制两侧都读到同一份事实。
 *
 * 三层机制（与 `scene-bible.ts` 的环境真实性机制同构）：
 *   ① **声明**：镜头卡用 `devices[]` 显式声明本镜出现的电子设备（category + model）；
 *   ② **审计**：`deviceDefects()` 确定性判红——文本里出现设备却没有声明 / 声明了裸词没有机型 /
 *      机型不在允许清单 / 出现其他品牌（渲染前 fail-closed）；
 *   ③ **提示词 + 监制**：`plate-prompt` 追加设备硬约束行；`producer-gate` rubric 有同名类目。
 *
 * 清单口径（重要）：以 **Apple 官网在售机型**为准，`verifiedAt` 记录核对日期。
 * 在售机型均晚于 2024 年世代（iPhone 16 / M 系列 M4 起）。仍在售但**世代偏早**的机型
 * （如 2022 年的 Studio Display）列入 `DEVICE_SOFT_ALLOWLIST`：不判红，但给软提示建议换新世代，
 * 避免"因为一条软约束把正常镜头全判死"。
 *
 * 边界（2026-09-27 实测后收窄）：**相机/云台/读卡器/硬盘盒**这类"Apple 没有对应品类"的设备
 * **不进声明判据**（否则规则不可满足）；它们只受提示词侧"无其他品牌标识"约束 + 监制视觉复核。
 */

export const DEVICE_POLICY_VERSION = "apple-2024plus/v1";

/** 清单核对日期（Apple 官网在售机型口径） */
export const DEVICE_POLICY_VERIFIED_AT = "2026-09-27";

export type DeviceCategory = "laptop" | "desktop" | "all-in-one" | "phone" | "tablet" | "display" | "wearable" | "audio" | "input";

export interface DeviceModelEntry {
  /** 机型名（写进镜头卡的就是它） */
  model: string;
  category: DeviceCategory;
  /** 其他可识别写法 */
  aliases?: string[];
  /** 该机型属于"2024 年后世代"的依据（世代口径，不逐年维护） */
  generation: string;
  /** 事实来源（Apple 官网机型页） */
  source: string;
}

/**
 * 允许清单：Apple 官网**在售**机型（2026-09-27 核对）。
 * 扩展方式：新增机型 → 在这里加一条（含 generation 与 source），审计与提示词自动生效。
 */
export const DEVICE_ALLOWLIST: DeviceModelEntry[] = [
  // —— Mac 笔记本 ——
  { model: "MacBook Neo", category: "laptop", generation: "2026 在售世代（Mac 新笔电线）", source: "https://www.apple.com.cn/mac/" },
  { model: "MacBook Air", category: "laptop", aliases: ["MacBook Air 13 英寸", "MacBook Air 15 英寸"], generation: "M4 起", source: "https://www.apple.com.cn/mac/" },
  { model: "MacBook Pro", category: "laptop", aliases: ["MacBook Pro 14 英寸", "MacBook Pro 16 英寸"], generation: "M4 起", source: "https://www.apple.com.cn/mac/" },
  // —— Mac 台式 ——
  { model: "iMac", category: "all-in-one", generation: "M4 起", source: "https://www.apple.com.cn/mac/" },
  { model: "Mac mini", category: "desktop", generation: "M4 起", source: "https://www.apple.com.cn/mac/" },
  { model: "Mac Studio", category: "desktop", generation: "2025 起在售世代", source: "https://www.apple.com.cn/mac/" },
  // —— 显示器 ——
  { model: "Studio Display XDR", category: "display", aliases: ["Studio Display XDR 5K"], generation: "XDR 世代（在售新机型）", source: "https://www.apple.com.cn/mac/" },
  // —— iPhone ——
  { model: "iPhone 16", category: "phone", generation: "A18 世代（2024）", source: "https://www.apple.com.cn/iphone/" },
  { model: "iPhone 17", category: "phone", generation: "A19 世代", source: "https://www.apple.com.cn/iphone/" },
  { model: "iPhone 17e", category: "phone", source: "https://www.apple.com.cn/iphone/", generation: "在售世代" },
  { model: "iPhone Air", category: "phone", generation: "在售世代", source: "https://www.apple.com.cn/iphone/" },
  { model: "iPhone 18 Pro", category: "phone", generation: "在售世代", source: "https://www.apple.com.cn/iphone/" },
  { model: "iPhone Duo", category: "phone", generation: "折叠双屏世代（在售）", source: "https://www.apple.com.cn/iphone/" },
  // —— iPad ——
  { model: "iPad Pro", category: "tablet", generation: "M4 起", source: "https://www.apple.com.cn/ipad/" },
  { model: "iPad Air", category: "tablet", generation: "M 系列世代", source: "https://www.apple.com.cn/ipad/" },
  { model: "iPad", category: "tablet", generation: "在售世代", source: "https://www.apple.com.cn/ipad/" },
  { model: "iPad mini", category: "tablet", generation: "在售世代", source: "https://www.apple.com.cn/ipad/" },
  // —— 配件（同属"电子设备"，品牌一致） ——
  { model: "Apple Watch", category: "wearable", generation: "在售世代", source: "https://www.apple.com.cn/watch/" },
  { model: "AirPods", category: "audio", aliases: ["AirPods Pro", "AirPods Max"], generation: "在售世代", source: "https://www.apple.com.cn/airpods/" },
  { model: "Magic Keyboard", category: "input", generation: "在售世代", source: "https://www.apple.com.cn/shop/mac/mac-accessories" },
  { model: "Magic Mouse", category: "input", generation: "在售世代", source: "https://www.apple.com.cn/shop/mac/mac-accessories" },
  { model: "Magic Trackpad", category: "input", generation: "在售世代", source: "https://www.apple.com.cn/shop/mac/mac-accessories" },
  { model: "Apple Pencil", category: "input", generation: "在售世代", source: "https://www.apple.com.cn/ipad/" },
];

/**
 * **在售但世代偏早**的 Apple 机型：不判红，给软提示（建议换到 2024 后世代）。
 * 例：Studio Display（2022 世代）——若客户坚持 2024+ 口径，用 `Studio Display XDR`。
 */
export const DEVICE_SOFT_ALLOWLIST: DeviceModelEntry[] = [
  { model: "Studio Display", category: "display", generation: "2022 世代（仍在售，早于 2024）", source: "https://www.apple.com.cn/mac/" },
];

/** 非 Apple 品牌（出现在镜头文本里即判红——"全部使用苹果设备"） */
export const FORBIDDEN_DEVICE_BRANDS = [
  "联想", "ThinkPad", "戴尔", "Dell", "惠普", "HP", "华硕", "ASUS", "宏碁", "Acer",
  "华为", "HUAWEI", "荣耀", "小米", "Xiaomi", "Redmi", "OPPO", "vivo", "一加", "OnePlus", "realme",
  "三星", "Samsung", "Galaxy", "索尼", "Sony", "LG", "微软", "Surface", "谷歌", "Google", "Pixel",
  "罗技", "Logitech", "雷蛇", "Razer", "海盗船", "Corsair", "博世", "Bose", "森海塞尔", "Sennheiser",
] as const;

/**
 * "电子设备"出现判据（只收**有设备语义**的词）：
 * 「屏幕」单独出现不算（"屏幕内容不可辨"是内容审查口径，不是设备）；「笔记本」按电脑语境收窄，
 * 避免把纸质笔记本/笔记本便签误判成设备（真机实测：商务场景里"笔记本"一半指纸本）。
 */
export const DEVICE_PRESENCE_PATTERNS: Array<{ category: DeviceCategory; pattern: RegExp; label: string }> = [
  { category: "laptop", label: "笔记本电脑", pattern: /(笔记本电脑|手提电脑|MacBook|笔记本(?:电脑|屏幕|键盘|金属外壳|机身|盒盖|立起|张开))/ },
  { category: "desktop", label: "台式机/主机", pattern: /(台式机|台式电脑|主机箱|Mac\s?mini|Mac\s?Studio)/i },
  { category: "all-in-one", label: "一体机", pattern: /(一体机|iMac)/i },
  { category: "phone", label: "手机", pattern: /(手机|iPhone)/i },
  { category: "tablet", label: "平板", pattern: /(平板电脑|平板|iPad)/i },
  { category: "display", label: "显示器", pattern: /(显示器|显示屏|大屏|Studio\s?Display|Pro\s?Display)/i },
  { category: "audio", label: "耳机/音频", pattern: /(耳机|耳麦|AirPods)/i },
  { category: "input", label: "键鼠/触控", pattern: /(键盘|鼠标|触控板|数位板|Magic\s?(?:Keyboard|Mouse|Trackpad))/i },
  { category: "wearable", label: "手表", pattern: /(智能手表|Apple\s?Watch)/i },
];

/** 逐镜设备声明（镜头卡 `devices[]`） */
export interface DeviceDeclaration {
  /** 设备类别（与清单 category 对齐） */
  category: DeviceCategory;
  /** 机型（必须命中允许清单，如 "MacBook Pro" / "iPhone 16"） */
  model: string;
  /** 在画面里的作用（可选，进证据） */
  role?: string;
  /** 摆放与朝向（可选；屏幕类设备仍受 propInteraction 规则约束） */
  placement?: string;
}

export interface DeviceShotFields {
  shotId?: string;
  scene?: string;
  sceneDescription?: string;
  props?: string;
  composition?: string;
  action?: string;
  envNarrative?: string;
  devices?: DeviceDeclaration | DeviceDeclaration[];
}

export interface DeviceDefect {
  rule: string;
  shotId: string;
  detail: string;
  hard: boolean;
}

function textOf(shot: DeviceShotFields): string {
  return [shot.scene, shot.sceneDescription, shot.props, shot.composition, shot.action, shot.envNarrative]
    .map((value) => String(value ?? ""))
    .join(" ");
}

function devicesOf(shot: DeviceShotFields): DeviceDeclaration[] {
  const raw = shot.devices;
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.filter((entry): entry is DeviceDeclaration => Boolean(entry && typeof entry === "object"));
}

/** 机型是否命中允许清单（支持 aliases；大小写与空格不敏感） */
export function isAllowedDeviceModel(model: string): boolean {
  const normalized = String(model ?? "").replace(/\s+/g, "").toLowerCase();
  if (!normalized) return false;
  return DEVICE_ALLOWLIST.some((entry) => [entry.model, ...(entry.aliases ?? [])]
    .some((candidate) => {
      const value = candidate.replace(/\s+/g, "").toLowerCase();
      return value === normalized || normalized.includes(value);
    }));
}

/** 是否命中"在售但世代偏早"的软清单 */
export function isSoftAllowedDeviceModel(model: string): boolean {
  const normalized = String(model ?? "").replace(/\s+/g, "").toLowerCase();
  if (!normalized) return false;
  return DEVICE_SOFT_ALLOWLIST.some((entry) => normalized.includes(entry.model.replace(/\s+/g, "").toLowerCase()));
}

/** 允许机型建议（判红时给可执行清单） */
export function allowedModelSummary(category?: DeviceCategory): string {
  const entries = category ? DEVICE_ALLOWLIST.filter((entry) => entry.category === category) : DEVICE_ALLOWLIST;
  const list = (entries.length > 0 ? entries : DEVICE_ALLOWLIST).slice(0, 6).map((entry) => `${entry.model}（${entry.generation}）`);
  return list.join(" / ");
}

/**
 * 设备硬约束审计（确定性，零 token）。
 * 判据：
 *   `device-declaration` 文本里出现电子设备但没有 `devices[]` 声明 → 硬红；
 *   `device-model`       声明的机型不在允许清单（或只写了裸词如"笔记本电脑"）→ 硬红；
 *   `device-brand`       文本里出现非 Apple 品牌 → 硬红；
 *   `device-generation`  命中软清单（在售但早于 2024 世代）→ 软提示。
 * 纪律：**允许清单是唯一事实源**——改清单即改全链路（审计 / 提示词 / 监制）。
 */
export function deviceDefects(shots: readonly DeviceShotFields[]): DeviceDefect[] {
  const defects: DeviceDefect[] = [];
  const push = (rule: string, shotId: string, detail: string, hard = true) => defects.push({ rule, shotId, detail, hard });
  for (const shot of shots) {
    const shotId = String(shot.shotId ?? "?");
    const text = textOf(shot);
    const present = DEVICE_PRESENCE_PATTERNS.filter((entry) => entry.pattern.test(text));
    const declared = devicesOf(shot);
    if (present.length > 0 && declared.length === 0) {
      push(
        "device-declaration",
        shotId,
        `画面含电子设备（${present.map((entry) => entry.label).join("、")}）但未声明 devices[]：机型必须写进镜头卡，才能保证是 2024 年后的 Apple 设备（可用：${allowedModelSummary(present[0]!.category)}）`
      );
    }
    for (const device of declared) {
      const model = String(device.model ?? "").trim();
      if (!model) {
        push("device-model", shotId, `devices[] 里有条目缺 model（类别 ${String(device.category ?? "?")}）——裸词不算机型`);
        continue;
      }
      if (isAllowedDeviceModel(model)) continue;
      if (isSoftAllowedDeviceModel(model)) {
        push("device-generation", shotId, `机型「${model}」在售但世代早于 2024（建议换成 2024 后世代：${allowedModelSummary(device.category)}）`, false);
        continue;
      }
      push("device-model", shotId, `机型「${model}」不在允许清单（2024 年后的 Apple 设备）：可用 ${allowedModelSummary(device.category)}`);
    }
    const brands = FORBIDDEN_DEVICE_BRANDS.filter((brand) => text.includes(brand));
    if (brands.length > 0) {
      push("device-brand", shotId, `画面里出现非 Apple 品牌：${brands.join("、")}（硬口径：全部使用 Apple 设备）`);
    }
  }
  return defects;
}

/** 审计摘要（与 `summarizeDefects` 同形，便于报告合并） */
export function summarizeDeviceDefects(defects: readonly DeviceDefect[]): { hard: number; soft: number; byRule: Record<string, number> } {
  const byRule: Record<string, number> = {};
  let hard = 0;
  let soft = 0;
  for (const defect of defects) {
    byRule[defect.rule] = (byRule[defect.rule] ?? 0) + 1;
    if (defect.hard) hard += 1;
    else soft += 1;
  }
  return { hard, soft, byRule };
}

/** 镜头卡里的设备声明摘要（进提示词/证据） */
export function deviceDeclarationSummary(shot: DeviceShotFields): string {
  const entries = devicesOf(shot);
  if (entries.length === 0) return "";
  return entries.map((entry) => [entry.model, entry.placement, entry.role].map((value) => String(value ?? "").trim()).filter(Boolean).join("·")).join("；");
}

/** 提示词补充行（供需要显式成行的调用方使用） */
export function devicePolicyPromptLines(shot: DeviceShotFields): string[] {
  const summary = deviceDeclarationSummary(shot);
  return summary ? [`设备口径：${summary}（2024 年后 Apple 在售机型，机身无其他品牌标识）`] : [];
}
