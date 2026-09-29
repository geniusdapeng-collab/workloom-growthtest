/**
 * product-archive —— 真实商品档案（T-2026-0929-0004）
 *
 * 产品口径（产品所有者 2026-09-29）：
 *   凡是涉及**具体公司名称或品牌名称**的片子，默认必须使用该公司/品牌的**真实产品**；
 *   系统里有商品档案（或客户上传的商品图）就用它；没有则**先检索、再用检索到的真实商品图与资料
 *   自动生成一份商品档案**，并打上"系统生成"标记——优先级低于客户上传的档案。
 *
 * 本模块是这套机制的**唯一事实源**：档案格式、优先级、校验与提示词口径都在这里；
 * 检索/建档的执行器在 `scripts/tools/product-archive.mts`，出片管线（full-chain-film）只消费本模块。
 *
 * 硬纪律：
 *   1 用户上传优先：`user-upload`(priority 10) > `system-generated`(priority 1)；同类多档命中即报歧义，要求显式 id；
 *   2 系统生成档案必须留下检索证据（query + 来源 URL）与免责声明，并标记 `pending-owner-review`；
 *     不把"检索到的图"当"已授权可商用"——正式投放前必须由客户核对外观、参数与授权；
 *   3 图片必须真实存在且可解析（sha256 一致、>50KB、有宽高），hero 必填；
 *   4 档案只做**忠实映射**：读不到的字段留空，绝不用模型补编外观或参数。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

export const PRODUCT_ARCHIVE_SCHEMA = "workloom.product-archive/v1" as const;
export const PRODUCT_ARCHIVE_POLICY_VERSION = "workloom.product-archive-policy/v1" as const;

/** 来源优先级（唯一事实源）：客户上传 > 系统检索生成 */
export const PRODUCT_ARCHIVE_SOURCE_PRIORITY = {
  "user-upload": 10,
  "system-generated": 1
} as const;
export type ProductArchiveSourceKind = keyof typeof PRODUCT_ARCHIVE_SOURCE_PRIORITY;

export interface ProductArchivePhoto {
  id: string;
  /** 相对档案目录的路径（posix 风格，禁止绝对路径与 .. 逃逸） */
  file: string;
  role?: "hero" | "detail" | "scene" | "packaging";
  sha256: string;
  bytes: number;
  width?: number;
  height?: number;
  note?: string;
}

export interface ProductArchiveEvidence {
  query: string;
  url: string;
  title?: string;
  site?: string;
  note?: string;
  /** 客户资料（PPT/PDF/图片包）内部的位置：幻灯片页码或文件名 */
  slide?: number;
  slideTitle?: string;
  /** 客户资料的 sha256（原件通常不进仓，只登记摘要与文件名） */
  deckSha256?: string;
  file?: string;
  /** 证据原文摘录（只摘录，不改写） */
  quote?: string;
}

export interface ProductArchiveSource {
  kind: ProductArchiveSourceKind;
  priority: number;
  generatedAt?: string;
  generator?: string;
  reviewStatus?: "pending-owner-review" | "owner-confirmed";
  searchedQueries?: string[];
  evidence?: ProductArchiveEvidence[];
  disclaimer?: string;
  /** 客户提供的原件说明（例如 "示例品牌智慧酒店生态产品解决方案.pptx"） */
  providedBy?: string;
  /** 机器抽取方式（幻灯片→商品/图片归属）：默认未人工复核，按软提示登记 */
  extraction?: { method: string; verified: boolean; note?: string };
}

export interface ProductArchiveSpecs {
  appearance?: string;
  features?: string[];
  material?: string;
  notes?: string[];
  /** 只登记能核实来源的参数；没有来源的一律留空（不许编） */
  parameters?: Array<{ name: string; value: string; source?: string }>;
}

export interface ProductArchive {
  schemaVersion: typeof PRODUCT_ARCHIVE_SCHEMA;
  id: string;
  displayName: string;
  /**
   * 档案类型（T-2026-0929-0005，多商品方案升级）：
   *   product  = 单个商品（默认）
   *   solution = 解决方案/套装（由多个商品组成，用 relations.includes 指向成员商品）
   *   company  = 公司/品牌档案（官方资料、品牌别名、成员商品与方案索引）
   */
  type?: "product" | "solution" | "company";
  /** 商品型号（例如 DEMO-02）；产品镜可以按型号点单 */
  model?: string;
  variants?: Array<{ name: string; model?: string; note?: string }>;
  relations?: {
    companyId?: string;
    products?: string[];
    solutions?: string[];
    /** 方案/套装的成员商品（role 说明它在方案里的角色，例如 "自助入住终端"） */
    includes?: Array<{ id: string; role?: string }>;
  };
  company?: string;
  brand?: string;
  aliases?: string[];
  source: ProductArchiveSource;
  photos: ProductArchivePhoto[];
  specs?: ProductArchiveSpecs;
  createdAt?: string;
  updatedAt?: string;
}

export interface ProductArchiveIssue {
  code: string;
  detail: string;
  hard: boolean;
}

export interface LoadedProductArchive {
  archive: ProductArchive;
  /** 档案目录（绝对路径） */
  dir: string;
  issues: ProductArchiveIssue[];
}

/** 名称归一：NFKC + 去空白/常见分隔符 + 小写；中英文混排也能命中 */
export function normalizeProductName(value: unknown): string {
  return String(value ?? "").normalize("NFKC").replace(/[\s\-_/·、，,（）()【】[\]]+/g, "").toLowerCase();
}

function isPosixRelative(file: string): boolean {
  return Boolean(file) && !file.startsWith("/") && !file.includes("\\") && !file.split("/").includes("..");
}

export function sha256FileSync(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * 档案校验：schema / 来源纪律 / 图片字节与哈希。
 * `hard: true` 的条目是**不可用**档（出片环节 fail-closed）；`hard: false` 是提醒（例如尚未客户确认）。
 */
export function verifyProductArchive(
  archive: ProductArchive,
  options: { dir: string; probeImage?: (file: string) => { width: number; height: number } | null }
): ProductArchiveIssue[] {
  const issues: ProductArchiveIssue[] = [];
  const push = (code: string, detail: string, hard = true): void => { issues.push({ code, detail, hard }); };
  if (archive.schemaVersion !== PRODUCT_ARCHIVE_SCHEMA) push("schema-version", `档案 schemaVersion=${String(archive.schemaVersion)}（应为 ${PRODUCT_ARCHIVE_SCHEMA}）`);
  if (!archive.id?.trim()) push("id-missing", "缺 id（档案目录名即稳定身份）");
  if (!archive.displayName?.trim()) push("name-missing", "缺 displayName（商品名称）");
  const type = archive.type ?? "product";
  if (!["product", "solution", "company"].includes(type)) push("type-invalid", `type=${String(archive.type)}（只允许 product / solution / company）`);
  if (type === "solution" && !(archive.relations?.includes ?? []).length) push("solution-includes", "方案档案必须用 relations.includes 登记成员商品（含 role 更好）");
  if (type === "company" && !(archive.relations?.products ?? archive.relations?.solutions ?? []).length) push("company-relations", "公司档案必须登记成员商品或方案（relations.products / relations.solutions）", false);
  for (const [index, parameter] of (archive.specs?.parameters ?? []).entries()) {
    if (!String(parameter?.name ?? "").trim() || !String(parameter?.value ?? "").trim()) push("parameter-incomplete", `specs.parameters[${index}] 缺 name/value`);
    else if (!String(parameter.source ?? "").trim()) push("parameter-source", `参数「${parameter.name}」缺来源（source，例如 slide 3）`, false);
  }
  if (!archive.company?.trim() && !archive.brand?.trim()) push("owner-missing", "缺 company/brand（至少一个，用于按公司/品牌解析）", false);
  const kind = archive.source?.kind;
  if (kind !== "user-upload" && kind !== "system-generated") push("source-kind", `source.kind=${String(kind)}（只允许 user-upload / system-generated）`);
  if (kind === "user-upload" || kind === "system-generated") {
    const expected = PRODUCT_ARCHIVE_SOURCE_PRIORITY[kind];
    if (archive.source.priority !== expected) push("source-priority", `source.priority=${String(archive.source.priority)} 与来源 ${kind} 的登记优先级 ${expected} 不一致`);
  }
  if (kind === "system-generated") {
    const evidence = archive.source.evidence ?? [];
    if (evidence.length === 0) push("system-evidence", "系统生成档案必须登记至少 1 条检索来源（source.evidence[].url）");
    if (evidence.some((entry) => !String(entry?.url ?? "").trim())) push("system-evidence", "检索来源缺 url");
    if (!(archive.source.searchedQueries ?? []).some((q) => String(q).trim())) push("system-queries", "系统生成档案必须登记实际用过的检索词（searchedQueries）");
    if (!String(archive.source.disclaimer ?? "").trim()) push("system-disclaimer", "系统生成档案必须带免责声明（disclaimer）");
    if (archive.source.reviewStatus !== "pending-owner-review") push("system-review-status", "系统生成档案的 reviewStatus 必须是 pending-owner-review（未经客户确认）", false);
  }
  const photos = archive.photos ?? [];
  /**
   * 图片要求按类型分流：**商品档案**必须有真实产品图（hero 必需）；
   * 公司/方案档案可以只挂证据与成员索引（图片来自成员商品或客户原件），没有主图不算不可用。
   */
  if (type === "product" && photos.length === 0) push("photos-empty", "商品档案至少需要 1 张真实产品图");
  if (type === "product" && photos.length > 0 && !photos.some((photo) => photo.role === "hero")) push("hero-missing", "缺 hero 主图（role=hero）");
  const seenIds = new Set<string>();
  for (const photo of photos) {
    if (!photo?.id?.trim()) push("photo-id", "图片缺 id");
    else if (seenIds.has(photo.id)) push("photo-id", `图片 id 重复：${photo.id}`);
    else seenIds.add(photo.id);
    if (!isPosixRelative(String(photo?.file ?? ""))) { push("photo-path", `图片路径必须是档案目录内的相对路径：${String(photo?.file ?? "(空)")}`); continue; }
    const abs = resolve(options.dir, photo.file);
    if (!abs.startsWith(resolve(options.dir) + "/")) { push("photo-path", `图片路径逃逸档案目录：${photo.file}`); continue; }
    if (!existsSync(abs)) { push("photo-missing", `图片文件不存在：${photo.file}`); continue; }
    const size = statSync(abs).size;
    if (size < 50_000) push("photo-size", `图片过小（疑似占位图）：${photo.file} ${(size / 1024).toFixed(0)}KB`);
    const actual = sha256FileSync(abs);
    if (!photo.sha256 || actual !== photo.sha256) push("photo-hash", `图片 sha256 与登记不一致：${photo.file}`);
    if (typeof photo.bytes === "number" && photo.bytes !== size) push("photo-bytes", `图片字节数与登记不一致：${photo.file}`, false);
    if (options.probeImage) {
      const dims = options.probeImage(abs);
      if (!dims || !dims.width || !dims.height) push("photo-unreadable", `图片无法解析尺寸：${photo.file}`);
      else {
        if (photo.width !== undefined && photo.width !== dims.width) push("photo-width", `图片宽度与登记不一致：${photo.file}`, false);
        if (photo.height !== undefined && photo.height !== dims.height) push("photo-height", `图片高度与登记不一致：${photo.file}`, false);
        if (Math.max(dims.width, dims.height) < 600) push("photo-resolution", `图片分辨率过低（最长边 ${Math.max(dims.width, dims.height)}px < 600px）：${photo.file}`, false);
      }
    }
  }
  return issues;
}

/** 从档案目录装载：读 profile.json → 校验 → 返回（校验失败的档案仍然返回，由调用方决定 fail-closed） */
export function loadProductArchive(dir: string, options: { probeImage?: (file: string) => { width: number; height: number } | null } = {}): LoadedProductArchive | null {
  const file = join(dir, "profile.json");
  if (!existsSync(file)) return null;
  const archive = JSON.parse(readFileSync(file, "utf8")) as ProductArchive;
  return { archive, dir: resolve(dir), issues: verifyProductArchive(archive, { dir: resolve(dir), probeImage: options.probeImage }) };
}

/** 装载整个档案库（每个子目录一个档案；缺 profile.json 的目录被忽略） */
export function loadProductArchives(root: string, options: { probeImage?: (file: string) => { width: number; height: number } | null } = {}): {
  root: string;
  archives: LoadedProductArchive[];
  byId: Map<string, LoadedProductArchive>;
  issues: Array<{ id: string; issues: ProductArchiveIssue[] }>;
} {
  const absRoot = resolve(root);
  const archives: LoadedProductArchive[] = [];
  if (existsSync(absRoot)) {
    for (const name of readdirSync(absRoot)) {
      const dir = join(absRoot, name);
      if (!statSync(dir).isDirectory()) continue;
      const loaded = loadProductArchive(dir, options);
      if (loaded) archives.push(loaded);
    }
  }
  const byId = new Map<string, LoadedProductArchive>();
  for (const entry of archives) {
    if (entry.archive.id && !byId.has(entry.archive.id)) byId.set(entry.archive.id, entry);
  }
  return {
    root: absRoot,
    archives,
    byId,
    issues: archives.filter((entry) => entry.issues.some((issue) => issue.hard)).map((entry) => ({ id: entry.archive.id, issues: entry.issues }))
  };
}

export interface ProductArchiveMatch {
  archive: ProductArchive | null;
  dir: string | null;
  matchedBy: "id" | "displayName" | "alias" | "company" | "brand" | "model" | null;
  reason: string;
  candidates: string[];
}

/**
 * 按"显式 id / 商品名 / 别名 / 公司 / 品牌"解析档案。
 * 命中多个来源时按 `PRODUCT_ARCHIVE_SOURCE_PRIORITY` 取高优先级（客户上传优先）；
 * 同优先级多档命中时判歧义并列出候选，要求调用方给显式 id（不猜）。
 */
export function selectProductArchive(archives: readonly LoadedProductArchive[], selector: string): ProductArchiveMatch {
  const wanted = normalizeProductName(selector);
  if (!wanted) return { archive: null, dir: null, matchedBy: null, reason: "商品选择器为空", candidates: [] };
  const usable = archives.filter((entry) => !entry.issues.some((issue) => issue.hard));
  const grouped: Array<{ matchedBy: ProductArchiveMatch["matchedBy"]; hits: LoadedProductArchive[] }> = [];
  const exact = usable.filter((entry) => normalizeProductName(entry.archive.id) === wanted);
  if (exact.length) grouped.push({ matchedBy: "id", hits: exact });
  const names = usable.filter((entry) => normalizeProductName(entry.archive.displayName) === wanted);
  if (names.length) grouped.push({ matchedBy: "displayName", hits: names });
  const aliases = usable.filter((entry) => (entry.archive.aliases ?? []).some((alias) => normalizeProductName(alias) === wanted));
  if (aliases.length) grouped.push({ matchedBy: "alias", hits: aliases });
  const companies = usable.filter((entry) => entry.archive.company && normalizeProductName(entry.archive.company) === wanted);
  if (companies.length) grouped.push({ matchedBy: "company", hits: companies });
  const brands = usable.filter((entry) => entry.archive.brand && normalizeProductName(entry.archive.brand) === wanted);
  if (brands.length) grouped.push({ matchedBy: "brand", hits: brands });
  /** 型号点单（例如镜头卡写 "DEMO-02"）：先看主型号，再看 variants 里的型号 */
  const models = usable.filter((entry) => entry.archive.model && normalizeProductName(entry.archive.model) === wanted);
  if (models.length) grouped.push({ matchedBy: "model", hits: models });
  const variantModels = usable.filter((entry) => (entry.archive.variants ?? []).some((variant) => variant.model && normalizeProductName(variant.model) === wanted));
  if (variantModels.length) grouped.push({ matchedBy: "model", hits: variantModels });
  const first = grouped[0];
  if (!first) {
    const all = archives.map((entry) => entry.archive.id).filter(Boolean);
    return { archive: null, dir: null, matchedBy: null, reason: `未找到与「${selector}」匹配的商品档案（档案库现有：${all.join("、") || "空"}）`, candidates: all };
  }
  const best = Math.max(...first.hits.map((entry) => PRODUCT_ARCHIVE_SOURCE_PRIORITY[entry.archive.source.kind] ?? 0));
  const winners = first.hits.filter((entry) => (PRODUCT_ARCHIVE_SOURCE_PRIORITY[entry.archive.source.kind] ?? 0) === best);
  if (winners.length > 1) {
    return {
      archive: null, dir: null, matchedBy: first.matchedBy,
      reason: `「${selector}」命中 ${winners.length} 份同优先级档案，判歧义：${winners.map((entry) => entry.archive.id).join("、")}（请用显式 id 指定）`,
      candidates: winners.map((entry) => entry.archive.id)
    };
  }
  const winner = winners[0]!;
  return {
    archive: winner.archive, dir: winner.dir, matchedBy: first.matchedBy,
    reason: `命中 ${winner.archive.id}（${winner.archive.source.kind}，priority=${winner.archive.source.priority}，matchedBy=${first.matchedBy}）`,
    candidates: first.hits.map((entry) => entry.archive.id)
  };
}

/** 主图：优先 role=hero，其次 role=scene/detail，最后任意一张 */
export function productHeroPhoto(archive: ProductArchive): ProductArchivePhoto | null {
  const photos = archive.photos ?? [];
  return photos.find((photo) => photo.role === "hero") ?? photos.find((photo) => photo.role === "scene")
    ?? photos.find((photo) => photo.role === "detail") ?? photos[0] ?? null;
}

export function productPhotoPath(entry: LoadedProductArchive, photo: ProductArchivePhoto): string {
  return resolve(entry.dir, photo.file);
}

/**
 * 提示词口径（只写**画面语言**）：产品外观以参考照片为准，不得改结构、按键布局与品牌标识；
 * 参数事实只在有来源时登记（不把检索页的宣传语当已核实参数）。
 */
export function productArchivePromptLines(archive: ProductArchive): string[] {
  const lines: string[] = [];
  const name = archive.displayName?.trim() || archive.id;
  lines.push(`真实商品：${name}${archive.brand ? `（品牌 ${archive.brand}）` : ""}${archive.company ? `，厂商 ${archive.company}` : ""}`);
  const appearance = archive.specs?.appearance?.trim();
  if (appearance) lines.push(`产品外观（以参考照片为准）：${appearance}`);
  const features = (archive.specs?.features ?? []).filter((item) => String(item).trim());
  if (features.length) lines.push(`可见结构与功能（只描述画面能看到的）：${features.join("；")}`);
  lines.push("产品一致性硬约束：机身轮廓、屏幕比例、按键与卡口布局、品牌标识位置必须与参考照片完全一致，不得重新设计外观、不得替换为相似机型");
  if (archive.source.kind === "system-generated") lines.push("素材来源声明：本商品资料由系统检索生成、未经客户确认，正式投放前须由客户核对产品外观与参数");
  return lines;
}
