#!/usr/bin/env node
/**
 * product-archive.mts —— 真实商品档案 检索 / 建档 / 校验 CLI（T-2026-0929-0004）
 *
 * 产品口径：涉及具体公司名或品牌名的片子，默认必须用该公司的**真实产品**。
 *   系统里有档案（客户上传）→ 直接用；
 *   没有 → 先检索公开资料与产品图，**自动生成一份带来源证据的商品档案**（标记 system-generated、priority 1）。
 *
 * 用法：
 *   tsx scripts/tools/product-archive.mts search --name "示例品牌" [--queries "a,b"] [--root <档案库>] [--max-images 6]
 *   tsx scripts/tools/product-archive.mts build  --name "示例品牌 酒店自助入住机" --photo a.jpg --photo b.jpg \
 *        [--company 示例企业] [--brand 示例品牌] [--aliases "示例品牌,weilaiqiantai"] [--specs specs.json] [--root <档案库>]
 *   tsx scripts/tools/product-archive.mts verify --root <档案库> [--id <档案id>]
 *   tsx scripts/tools/product-archive.mts list   --root <档案库>
 *
 * 纪律（与 `packages/video-studio/src/product-archive.ts` 同源）：
 *   · 客户上传档案 priority=10，系统检索档案 priority=1；同名冲突时客户上传优先；
 *   · 系统检索档案必须留证据（检索词 + 来源 URL）与免责声明，**不得声称已核实授权或参数**；
 *   · 检索不到产品图时**如实失败**并提示客户提供照片，不生成占位图、不用 AI 编产品。
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  PRODUCT_ARCHIVE_SCHEMA,
  PRODUCT_ARCHIVE_SOURCE_PRIORITY,
  loadProductArchive,
  loadProductArchives,
  productHeroPhoto,
  selectProductArchive,
  verifyProductArchive,
  type ProductArchive,
  type ProductArchiveEvidence,
  type ProductArchivePhoto
} from "../../packages/video-studio/src/product-archive.js";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const DEFAULT_ROOT = join(REPO_ROOT, "bundles/ai-video/library/products");
const SEARCH_ENDPOINT = process.env.PRODUCT_SEARCH_ENDPOINT ?? "https://www.bing.com/search";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
const MIN_IMAGE_BYTES = 50_000;
const MAX_IMAGE_BYTES = 8_000_000;
/**
 * 相关性硬闸（2026-09-29 真机事故）：检索"示例品牌"时 Bing 返回了蔚来汽车、3D 打印等无关页面，
 * 早期版本把页面里的 og:image 直接当"产品图"收进档案——**这比没有档案更危险**（会把别家的产品当客户产品）。
 * 因此：结果标题/摘要/URL 必须出现品牌或公司名的可判分子串，页面正文也必须出现，否则一律不收。
 */
const GENERIC_NAME_TOKENS = new Set([
  "官网", "产品图", "产品", "图片", "展示", "介绍", "价格", "型号", "酒店", "自助", "入住", "入住机", "自助入住机",
  "酒店自助入住机", "有限公司", "股份有限公司", "科技", "智能", "信息", "技术", "网络", "集团", "设备", "设备厂", "公司"
]);
export function relevanceTokens(name: string): string[] {
  const tokens = new Set<string>();
  const push = (value: string): void => {
    const norm = value.normalize("NFKC").trim();
    if (norm.length >= 2 && !GENERIC_NAME_TOKENS.has(norm)) tokens.add(norm);
  };
  push(name);
  const core = name.replace(/(股份有限公司|有限公司|科技|智能|信息|技术|网络|集团|设备|公司)+$/gu, "").trim();
  if (core && core !== name) push(core);
  // 中文品牌常见 2–4 字核心词（仅在整名较长时补，避免把通用词当品牌）
  if (!tokens.size && name.length >= 2) push(name.slice(0, 4));
  return [...tokens];
}
export function mentionsAny(text: string, tokens: readonly string[]): boolean {
  const norm = String(text ?? "").normalize("NFKC");
  return tokens.some((token) => norm.includes(token));
}

function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? "") : fallback;
}
function multi(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] === name && process.argv[i + 1]) out.push(String(process.argv[i + 1]));
  }
  return out;
}
const log = (line: string): void => { process.stdout.write(`${line}\n`); };
const slug = (value: string): string => value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "product";

/** 纯 JS 读图片宽高（PNG / JPEG / WebP / GIF），不引入依赖、不调用外部二进制 */
export function imageSize(buffer: Buffer): { width: number; height: number; format: string } | null {
  if (buffer.length > 24 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), format: "png" };
  }
  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue; }
      const marker = buffer[offset + 1]!;
      const length = buffer.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5), format: "jpeg" };
      }
      offset += 2 + length;
    }
    return null;
  }
  if (buffer.length > 30 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buffer.toString("ascii", 12, 16);
    if (chunk === "VP8X") return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3), format: "webp" };
    if (chunk === "VP8 ") return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff, format: "webp" };
    if (chunk === "VP8L") {
      const bits = buffer.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, format: "webp" };
    }
    return null;
  }
  if (buffer.length > 10 && buffer.toString("ascii", 0, 3) === "GIF") {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8), format: "gif" };
  }
  return null;
}

async function fetchText(url: string, timeoutMs = 20_000): Promise<{ ok: boolean; status: number; text: string; url: string }> {
  try {
    const res = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "text/html,*/*" }, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    const text = res.ok ? await res.text() : "";
    return { ok: res.ok, status: res.status, text, url: res.url || url };
  } catch (error) {
    return { ok: false, status: 0, text: error instanceof Error ? error.message : String(error), url };
  }
}

function decodeEntities(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#183;/g, "·").replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)));
}

export function parseBingResults(html: string): Array<{ title: string; url: string; snippet: string }> {
  const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/g) ?? [];
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  for (const block of blocks) {
    const link = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const snippet = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    results.push({
      url: decodeEntities(link[1]!),
      title: decodeEntities(link[2]!.replace(/<[^>]+>/g, "")).trim(),
      snippet: decodeEntities((snippet?.[1] ?? "").replace(/<[^>]+>/g, "")).trim()
    });
  }
  return results;
}

/**
 * 百度结果解析（2026-09-29 真机新增）：Bing 对部分中文 B2B 品牌返回"结果页与查询无关"，
 * 百度通道在同一次真机上命中官网。解析两条通道：
 *   ① `<a … mu="真实URL">标题</a>`（百度把真实地址放在 mu 属性里，href 是跳转壳）；
 *   ② `bds.comm.iaurl=[…]`（页面内嵌的权威结果地址列表，作为兜底）。
 * 百度自家域（推荐位/热榜）会被剔除，百科/官网/电商等保留。
 */
export function parseBaiduResults(html: string): Array<{ title: string; url: string; snippet: string }> {
  const out = new Map<string, { title: string; url: string; snippet: string }>();
  const strip = (value: string): string => decodeEntities(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  const push = (url: string, title: string, snippet = ""): void => {
    if (!/^https?:\/\//i.test(url)) return;
    if (/^https?:\/\/[^/]*(baidu\.com|bdstatic\.com|baidustatic\.com)/i.test(url) && !/baike\.baidu\.com/i.test(url)) return;
    if (out.has(url)) return;
    out.set(url, { url, title: title.slice(0, 120), snippet: snippet.slice(0, 200) });
  };
  for (const match of html.matchAll(/<a[^>]*\bmu="(https?:\/\/[^"]+)"[^>]*>([\s\S]{0,600}?)<\/a>/g)) {
    push(match[1]!, strip(match[2]!));
  }
  /**
   * 兜底：百度把真实地址放在 `mu` 属性上，但不少结果块的标题文本在属性**之后**的兄弟节点里
   * （真机 2026-09-29：只取 `mu` 会拿到空标题 → 相关性过滤把官网也误杀）。这里把 `mu` 后 400 字内的文本兜住。
   */
  for (const match of html.matchAll(/\bmu="(https?:\/\/[^"]+)"([\s\S]{0,400})/g)) {
    push(match[1]!, strip(match[2]!).slice(0, 120), strip(match[2]!).slice(0, 200));
  }
  const iaurl = html.match(/bds\.comm\.iaurl\s*=\s*(\[[^\]]+\])/);
  if (iaurl) {
    try {
      for (const url of JSON.parse(iaurl[1]!) as string[]) push(String(url), "");
    } catch { /* 该内嵌数组不是合法 JSON 时忽略（不影响 ① 通道） */ }
  }
  return [...out.values()];
}

export function extractImageUrls(html: string, pageUrl: string, limit = 12): string[] {
  const urls: string[] = [];
  const push = (raw: string): void => {
    const value = decodeEntities(raw.trim());
    if (!value || /^data:/i.test(value) || /\.svg(\?|$)/i.test(value)) return;
    try {
      const abs = new URL(value, pageUrl).toString();
      if (!/^https?:/i.test(abs)) return;
      if (!urls.includes(abs)) urls.push(abs);
    } catch { /* 非法 URL 直接跳过 */ }
  };
  for (const meta of html.matchAll(/<meta[^>]+(?:property|name)=["'](?:og:image|og:image:secure_url|twitter:image)["'][^>]*>/gi)) {
    const content = meta[0].match(/content=["']([^"']+)["']/i);
    if (content) push(content[1]!);
  }
  for (const img of html.matchAll(/<img[^>]+>/gi)) {
    const tag = img[0];
    const src = tag.match(/(?:data-src|data-original|data-lazy-src|src)=["']([^"']+)["']/i);
    if (!src) continue;
    const hint = tag.match(/(?:alt|title|class)=["']([^"']*)["']/i)?.[1] ?? "";
    if (/logo|icon|qrcode|二维码|avatar|banner-ad/i.test(`${src[1]!} ${hint}`)) continue;
    push(src[1]!);
    if (urls.length >= limit) break;
  }
  return urls.slice(0, limit);
}

/** 抓图：只收 50KB–8MB、可解析宽高的图片；失败原因逐条记录（不静默丢弃） */
async function downloadImage(url: string, outFile: string): Promise<{ ok: true; photo: Omit<ProductArchivePhoto, "id" | "role">; } | { ok: false; reason: string }> {
  try {
    const res = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "image/*,*/*" }, redirect: "follow", signal: AbortSignal.timeout(25_000) });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const type = String(res.headers.get("content-type") ?? "");
    if (!/^image\//i.test(type)) return { ok: false, reason: `content-type=${type || "(空)"}` };
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length < MIN_IMAGE_BYTES) return { ok: false, reason: `文件过小 ${(bytes.length / 1024).toFixed(0)}KB` };
    if (bytes.length > MAX_IMAGE_BYTES) return { ok: false, reason: `文件过大 ${(bytes.length / 1024 / 1024).toFixed(1)}MB` };
    const size = imageSize(bytes);
    if (!size) return { ok: false, reason: "无法解析图片尺寸（可能不是真实图片）" };
    if (Math.max(size.width, size.height) < 600) return { ok: false, reason: `分辨率过低 ${size.width}x${size.height}` };
    writeFileSync(outFile, bytes);
    return {
      ok: true,
      photo: { file: `photos/${basename(outFile)}`, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, width: size.width, height: size.height }
    };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function writeArchive(dir: string, archive: ProductArchive): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "profile.json"), `${JSON.stringify(archive, null, 2)}\n`, "utf8");
}

async function commandSearch(): Promise<number> {
  const name = arg("--name").trim();
  if (!name) throw new Error("search 需要 --name \"<公司/品牌/商品>\"");
  const root = resolve(arg("--root", DEFAULT_ROOT));
  const maxImages = Number(arg("--max-images", "6"));
  const queries = (arg("--queries") ? arg("--queries").split(",") : [`${name} 产品图`, `${name} 官网`, `${name} 酒店自助入住机`]).map((q) => q.trim()).filter(Boolean);
  const dir = join(root, slug(name));
  log(`检索商品档案：${name}\n档案库：${root}\n检索词：${queries.join(" / ")}`);
  const tokens = relevanceTokens(name);
  log(`相关性判据（结果标题/摘要/URL 与页面正文必须出现）：${tokens.join(" / ") || "（无可用判据：名称过泛，拒绝自动建档）"}`);
  if (tokens.length === 0) {
    log("名称过于泛化，无法判定检索结果是否属于该品牌：请改用更具体的公司名/品牌名，或由客户提供照片后 build。");
    return 2;
  }

  const results: Array<{ query: string; title: string; url: string; snippet: string }> = [];
  let filtered = 0;
  for (const query of queries) {
    /**
     * 多引擎检索（2026-09-29 真机）：中文 B2B 品牌优先走百度（Bing 对这类查询会返回无关结果页），
     * 两路都跑、合并去重；相关性硬闸在合并后统一执行，不因引擎不同放宽。
     */
    const engines: Array<{ name: string; url: string; parse: (html: string) => Array<{ title: string; url: string; snippet: string }> }> = [
      { name: "baidu", url: `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`, parse: parseBaiduResults },
      { name: "bing", url: `${SEARCH_ENDPOINT}?q=${encodeURIComponent(query)}&mkt=zh-CN`, parse: parseBingResults }
    ];
    const hits: Array<{ title: string; url: string; snippet: string }> = [];
    for (const engine of engines) {
      const page = await fetchText(engine.url);
      if (!page.ok) { log(`  ⚠ 检索「${query}」（${engine.name}）失败：HTTP ${page.status}`); continue; }
      const parsed = engine.parse(page.text).slice(0, 10);
      log(`  ${engine.name}「${query}」→ ${parsed.length} 条`);
      for (const hit of parsed) if (!hits.some((item) => item.url === hit.url)) hits.push(hit);
    }
    /**
     * 相关性判定以**页面正文**为准（结果标题/摘要只作线索）：检索页里标题经常被反爬脚本打散，
     * 只用标题过滤会把官网（如 xiezhuwang.com）也误杀。页面级复核放在抓图循环里执行。
     */
    log(`  合并去重 ${hits.length} 条 → 待页面级相关性复核`);
    for (const hit of hits) results.push({ query, ...hit });
  }
  if (results.length === 0) {
    writeFileSync(join(root, `${slug(name)}.search-report.json`), `${JSON.stringify({ name, queries, tokens, results, filtered, at: new Date().toISOString() }, null, 2)}\n`, "utf8");
    log(`未检索到与该品牌**相关**的公开页面（已剔除 ${filtered} 条无关结果）：按纪律不建档、不拿别家产品冒充。`);
    log("请客户提供产品照片后执行 build（客户上传优先于系统检索）。");
    return 2;
  }

  mkdirSync(join(dir, "photos"), { recursive: true });
  const evidence: ProductArchiveEvidence[] = [];
  const photos: ProductArchivePhoto[] = [];
  const rejected: Array<{ url: string; reason: string }> = [];
  const seenPages = new Set<string>();
  for (const hit of results) {
    if (photos.length >= maxImages) break;
    if (seenPages.has(hit.url)) continue;
    seenPages.add(hit.url);
    const page = await fetchText(hit.url);
    if (!page.ok) { rejected.push({ url: hit.url, reason: `页面读取失败 HTTP ${page.status}` }); continue; }
    const pageTitle = page.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
    const pageProbe = `${pageTitle} ${page.text.slice(0, 60_000)}`;
    if (!mentionsAny(pageProbe, tokens)) {
      rejected.push({ url: hit.url, reason: `页面正文未出现品牌/公司名（相关性复核未过）：${tokens.join("/")}` });
      log(`  ✗ 跳过无关页面（正文未提到 ${tokens.join("/")}）：${hit.url.slice(0, 80)}`);
      continue;
    }
    log(`  ✓ 相关页面：${(pageTitle || hit.title || page.url).replace(/\s+/g, " ").slice(0, 60)} ← ${page.url.slice(0, 80)}`);
    const candidates = extractImageUrls(page.text, page.url, 8);
    let used = false;
    for (const imageUrl of candidates) {
      if (photos.length >= maxImages) break;
      const index = photos.length + 1;
      const outFile = join(dir, "photos", `${String(index).padStart(2, "0")}-${slug(hit.title).slice(0, 24)}.${/png/i.test(imageUrl) ? "png" : "jpg"}`);
      const downloaded = await downloadImage(imageUrl, outFile);
      if (!downloaded.ok) { rejected.push({ url: imageUrl, reason: downloaded.reason }); continue; }
      photos.push({ id: `p${index}`, role: photos.length === 0 ? "hero" : "detail", ...downloaded.photo });
      used = true;
      log(`  ✓ 收图 ${downloaded.photo.width}x${downloaded.photo.height} ${(downloaded.photo.bytes / 1024).toFixed(0)}KB ← ${imageUrl.slice(0, 90)}`);
    }
    if (used) {
      evidence.push({ query: hit.query, url: page.url, title: hit.title, site: (() => { try { return new URL(page.url).hostname; } catch { return undefined; } })(), note: hit.snippet.slice(0, 160) });
    }
  }
  writeFileSync(join(dir, "sources.json"), `${JSON.stringify({ name, queries, results, rejected, photos, at: new Date().toISOString() }, null, 2)}\n`, "utf8");
  if (photos.length === 0) {
    log(`检索到 ${results.length} 条结果，但**没有抓到可用的真实产品图**（${rejected.length} 条被拒）。`);
    log("按纪律不生成占位图：请客户提供产品照片后执行 build（客户上传优先于系统检索）。");
    return 2;
  }
  const now = new Date().toISOString();
  const archive: ProductArchive = {
    schemaVersion: PRODUCT_ARCHIVE_SCHEMA,
    id: slug(name),
    displayName: name,
    brand: name,
    aliases: [name],
    source: {
      kind: "system-generated",
      priority: PRODUCT_ARCHIVE_SOURCE_PRIORITY["system-generated"],
      generatedAt: now,
      generator: "scripts/tools/product-archive.mts@search",
      reviewStatus: "pending-owner-review",
      searchedQueries: queries,
      evidence,
      disclaimer: "本档案由系统检索公开网页自动生成：产品图与资料来自第三方页面，**版权、商用授权与参数准确性均未由客户确认**；正式投放前必须由客户核对外观、参数与素材授权。"
    },
    photos,
    specs: { notes: ["外观以 photos/ 下的真实产品图为准；未核实的参数一律不登记。"] },
    createdAt: now,
    updatedAt: now
  };
  writeArchive(dir, archive);
  const issues = verifyProductArchive(archive, { dir, probeImage: null });
  log(`\n已生成商品档案（系统检索）：${join(dir, "profile.json")}`);
  log(`  图片 ${photos.length} 张 · 来源 ${evidence.length} 个页面 · 校验硬问题 ${issues.filter((i) => i.hard).length} 条`);
  log("  标记：source.kind=system-generated（priority=1，低于客户上传的 10）· reviewStatus=pending-owner-review");
  return issues.some((issue) => issue.hard) ? 1 : 0;
}

function commandBuild(): number {
  const name = arg("--name").trim();
  const photoArgs = multi("--photo");
  if (!name || photoArgs.length === 0) throw new Error("build 需要 --name \"<商品名>\" 与至少一张 --photo <文件>");
  const root = resolve(arg("--root", DEFAULT_ROOT));
  const dir = join(root, slug(name));
  mkdirSync(join(dir, "photos"), { recursive: true });
  const photos: ProductArchivePhoto[] = [];
  for (const [index, file] of photoArgs.entries()) {
    const abs = resolve(file);
    if (!existsSync(abs)) throw new Error(`产品图不存在：${file}`);
    const bytes = readFileSync(abs);
    const size = imageSize(bytes);
    const ext = (size?.format === "png" ? ".png" : size?.format === "webp" ? ".webp" : size?.format === "gif" ? ".gif" : ".jpg");
    const target = `photos/${String(index + 1).padStart(2, "0")}-${slug(basename(abs, extname(abs))).slice(0, 24)}${ext}`;
    copyFileSync(abs, join(dir, target));
    photos.push({
      id: index === 0 ? "hero" : `p${index + 1}`,
      file: target,
      role: index === 0 ? "hero" : "detail",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      ...(size ? { width: size.width, height: size.height } : {})
    });
    log(`  ✓ ${target}（${(bytes.length / 1024).toFixed(0)}KB${size ? ` · ${size.width}x${size.height}` : ""}）`);
  }
  const specsFile = arg("--specs");
  const specs = specsFile && existsSync(resolve(specsFile)) ? JSON.parse(readFileSync(resolve(specsFile), "utf8")) as ProductArchive["specs"] : undefined;
  const aliases = arg("--aliases").split(",").map((item) => item.trim()).filter(Boolean);
  const now = new Date().toISOString();
  const archive: ProductArchive = {
    schemaVersion: PRODUCT_ARCHIVE_SCHEMA,
    id: slug(name),
    displayName: name,
    ...(arg("--company") ? { company: arg("--company") } : {}),
    ...(arg("--brand") ? { brand: arg("--brand") } : {}),
    aliases: aliases.length ? aliases : [name],
    source: { kind: "user-upload", priority: PRODUCT_ARCHIVE_SOURCE_PRIORITY["user-upload"], generatedAt: now, generator: "scripts/tools/product-archive.mts@build", reviewStatus: "owner-confirmed" },
    photos,
    ...(specs ? { specs } : {}),
    createdAt: now,
    updatedAt: now
  };
  writeArchive(dir, archive);
  const issues = verifyProductArchive(archive, { dir });
  log(`\n已生成商品档案（客户上传）：${join(dir, "profile.json")}（priority=${PRODUCT_ARCHIVE_SOURCE_PRIORITY["user-upload"]}）`);
  for (const issue of issues) log(`  ${issue.hard ? "✗" : "⚠"} [${issue.code}] ${issue.detail}`);
  return issues.some((issue) => issue.hard) ? 1 : 0;
}

function commandVerify(): number {
  const root = resolve(arg("--root", DEFAULT_ROOT));
  const id = arg("--id");
  const library = loadProductArchives(root);
  const targets = id ? library.archives.filter((entry) => entry.archive.id === id) : library.archives;
  if (targets.length === 0) { log(`档案库 ${root} 下没有${id ? ` id=${id} 的档案` : "任何档案"}`); return 1; }
  let failed = 0;
  for (const entry of targets) {
    const hard = entry.issues.filter((issue) => issue.hard);
    failed += hard.length ? 1 : 0;
    log(`${hard.length ? "✗" : "✓"} ${entry.archive.id}（${entry.archive.source.kind}，priority=${entry.archive.source.priority}）图片 ${entry.archive.photos?.length ?? 0} 张`);
    for (const issue of entry.issues) log(`    ${issue.hard ? "✗" : "⚠"} [${issue.code}] ${issue.detail}`);
  }
  return failed ? 1 : 0;
}

function commandList(): number {
  const root = resolve(arg("--root", DEFAULT_ROOT));
  const library = loadProductArchives(root);
  if (library.archives.length === 0) { log(`档案库为空：${root}`); return 0; }
  for (const entry of library.archives) {
    const hero = productHeroPhoto(entry.archive);
    log(`- ${entry.archive.id}｜${entry.archive.displayName}｜${entry.archive.source.kind}（priority=${entry.archive.source.priority}）｜主图 ${hero ? `${hero.file} ${hero.width ?? "?"}x${hero.height ?? "?"}` : "无"}`);
  }
  return 0;
}

/* ================= import-pptx：客户方案 PPT → 公司 / 方案 / 多商品档案 ================= */

/**
 * 多商品方案 PPT 的档案化口径（T-2026-0929-0005）：
 *   一份对外方案 PPT 通常 = **1 个公司/品牌** + **N 个商品** + **若干个方案/套装**；
 *   因此不把整份 PPT 塞进"一个商品档案"，而是拆成三类档案：
 *     · company  公司档案（品牌、别名、成员商品与方案索引、官方原件摘要与逐页证据）
 *     · solution 方案档案（例如"示例品牌智慧酒店生态方案"：成员商品 + 角色 + 多商品页素材）
 *     · product  商品档案（按型号/名称建档：真实产品图 + 从原文摘录的可见参数，参数必须带 slide 来源）
 *   归属由文案关键词机器判定，**标记 extraction.verified=false**（软提示），客户抽查后可改为 true。
 */
interface DeckImage { file: string; rel: string; bytes: Buffer; width: number; height: number }
interface DeckSlide { slide: number; title: string; texts: string[]; images: DeckImage[] }

const PRODUCT_RULES: Array<{ id: string; name: string; model?: string; keywords: RegExp; role?: string }> = [
  /* —— 2026 全系列产品 PDF 里的机型（型号与页面文案逐条对应） —— */
  { id: "demo-t001", name: "示例品牌 台式双屏自助机", model: "DEMO-T001", keywords: /CXZ-?\s*T0\s*0\s*1|台式双屏自助机|双屏模式/ },
  { id: "tablet-butler", name: "移动平板管家", keywords: /移动平板管家|平板管家/ },
  { id: "hotel-ai-agent", name: "酒店 AI 智能体", keywords: /酒店AI智能体|酒店 AI 智能体/ },
  { id: "ble-checkin", name: "碰一下住酒店", keywords: /碰一下住酒店|碰一下入住/ },
  { id: "embedded-desktop", name: "桌面嵌入式自助机", keywords: /桌面嵌入式自助机|嵌入式自助机/ },
  { id: "simple-vertical", name: "示例品牌简约立式机", keywords: /简约立式机|示例品牌简约立式/ },
  { id: "premium-vertical", name: "国际酒店高端立式机", keywords: /高端立式机|国际酒店高端/ },
  { id: "face-checkin", name: "未来酒店刷脸入住", keywords: /刷脸入住|未来酒店刷脸/ },
  { id: "demo-frontdesk", name: "示例品牌 AI 智慧前台（自助机 + 小程序）", keywords: /AI\s*智慧前台|AI前台|自助机|自助入住|小程序/, role: "自助入住终端" },
  { id: "demo-03", name: "示例品牌桌面型自助机", model: "DEMO-03", keywords: /DEMO-03|桌面型|桌面款|21\.5\s*寸/ },
  { id: "demo-01", name: "示例品牌台式机", model: "DEMO-01", keywords: /DEMO-01|台式机|15\.6\s*寸/ },
  { id: "demo-02", name: "示例品牌立式机", model: "DEMO-02", keywords: /DEMO-02|立式机|27\s*寸/ },
  { id: "pms-agent", name: "畅想云智能体（PMS / 订单直连 / 手机报表）", keywords: /畅享云|畅想云|智能体|PMS|订单直连|手机报表|全渠道直连|自动排房/, role: "云端经营系统" },
  { id: "ble-door", name: "碰一下开门（蓝牙密码锁）", keywords: /碰一下|蓝牙密码锁|蓝牙锁/, role: "客房门锁" },
  { id: "face-door", name: "刷脸开门（刷脸门禁屏）", keywords: /刷脸|门禁屏/, role: "门禁终端" },
  { id: "cardless-power", name: "无卡取电（蓝牙取电开关）", keywords: /无卡取电|蓝牙取电/, role: "客房取电" },
  { id: "visual-ip", name: "酒店视觉美化与 IP 打造", keywords: /视觉美化|IP打造|店铺重装|店铺升星/, role: "运营服务" },
  { id: "ota-ops", name: "OTA 数字化运营", keywords: /OTA|数字化运营|一价全包|店铺优化|实时调价|竞对分析/, role: "运营服务" },
  { id: "geo-promo", name: "GEO 推广（让酒店被 AI 看见）", keywords: /GEO|AI搜索|豆包|DeepSeek|元宝|Kimi|文小言|通义|推荐卡片/, role: "获客服务" },
  { id: "locker-cooler", name: "生态产品：行李寄存柜 / 早餐保温柜", keywords: /寄存柜|保温柜/, role: "生态设备" }
];

function unzipDeck(file: string, target: string): void {
  const result = spawnSync("unzip", ["-o", "-q", file, "-d", target], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(`解压 PPT 失败（需要系统 unzip）：${result.error?.message ?? result.stderr ?? `exit ${result.status}`}`);
  }
}

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

/** 逐页解析：文本 + 该页引用的图片（含宽高），不用第三方依赖、不改写原文 */
export function parseDeckSlides(root: string): DeckSlide[] {
  const slidesDir = join(root, "ppt/slides");
  if (!existsSync(slidesDir)) throw new Error("这不是标准 PPTX：缺 ppt/slides 目录");
  const files = readdirSync(slidesDir).filter((name) => /^slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  const slides: DeckSlide[] = [];
  for (const name of files) {
    const xml = readFileSync(join(slidesDir, name), "utf8");
    const texts: string[] = [];
    for (const para of xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)) {
      const line = stripTags([...para[1]!.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => m[1]!).join(""));
      if (line) texts.push(line);
    }
    const images: DeckImage[] = [];
    const relsFile = join(slidesDir, "_rels", `${name}.rels`);
    if (existsSync(relsFile)) {
      const rels = readFileSync(relsFile, "utf8");
      for (const rel of rels.matchAll(/<Relationship[^>]+Type="[^"]*\/image"[^>]*>/g)) {
        const target = rel[0].match(/Target="([^"]+)"/)?.[1] ?? "";
        if (!target) continue;
        /** rels 里的 Target 相对 slide 文件目录：`../media/imageN.png` → `ppt/media/imageN.png`（不要再剥 `../`，否则路径错位、图片全部读不到） */
        const abs = resolve(join(slidesDir, target));
        if (!existsSync(abs)) continue;
        const bytes = readFileSync(abs);
        const size = imageSize(bytes);
        if (!size) continue;
        images.push({ file: abs, rel: target, bytes, width: size.width, height: size.height });
      }
    }
    slides.push({ slide: Number(name.match(/\d+/)![0]), title: texts[0] ?? "", texts, images });
  }
  return slides;
}

/** 从原文摘录参数（只摘录、必须带 slide 来源）；不符合格式的一律不写 */
export function extractSpecs(slide: DeckSlide): { features: string[]; parameters: Array<{ name: string; value: string; source: string }>; notes: string[] } {
  const features: string[] = [];
  const parameters: Array<{ name: string; value: string; source: string }> = [];
  const notes: string[] = [];
  const source = `slide ${slide.slide}`;
  for (const line of slide.texts) {
    const model = line.match(/型号[:：]?\s*([A-Za-z0-9][A-Za-z0-9-]{1,15})/);
    if (model) parameters.push({ name: "型号", value: model[1]!, source });
    const inch = line.match(/(\d+(?:\.\d+)?)\s*(?:寸|英寸)/);
    if (inch && /屏|触摸/.test(line)) parameters.push({ name: "屏幕尺寸", value: `${inch[1]}英寸`, source });
    if (/^[①②③④⑤⑥⑦⑧⑨⑩]/.test(line)) features.push(line.replace(/^[①②③④⑤⑥⑦⑧⑨⑩]\s*/, ""));
    else if (/支持|具备|可以|可享|配备/.test(line) && line.length <= 40) features.push(line);
    const claim = line.match(/(\d+(?:\.\d+)?)\s*(万|家酒店|%|倍)/);
    if (claim && /节省|提升|已加入|出租率|转化率|评分/.test(line)) notes.push(`${line}（原文摘录，未经核验）`);
  }
  return { features: [...new Set(features)].slice(0, 12), parameters: parameters.slice(0, 12), notes: [...new Set(notes)].slice(0, 8) };
}

function commandImportPptx(): number {
  const deckFile = resolve(arg("--file"));
  if (!existsSync(deckFile)) throw new Error(`PPT 不存在：${deckFile}`);
  const company = arg("--company").trim();
  const brand = arg("--brand").trim() || company;
  if (!company && !brand) throw new Error("import-pptx 需要 --company \"<公司名>\"（或 --brand）");
  const root = resolve(arg("--root", DEFAULT_ROOT));
  const minPx = Number(arg("--min-px", "600"));
  const maxPhotos = Number(arg("--max-photos-per-product", "6"));
  const deckBytes = readFileSync(deckFile);
  const deckSha256 = createHash("sha256").update(deckBytes).digest("hex");
  const tmp = mkdtempSync(join(tmpdir(), "product-archive-pptx-"));
  log(`导入客户方案 PPT：${basename(deckFile)}（sha256 ${deckSha256.slice(0, 12)}…，${(deckBytes.length / 1024 / 1024).toFixed(1)}MB）`);
  try {
    unzipDeck(deckFile, tmp);
    const slides = parseDeckSlides(tmp);
    log(`逐页解析：${slides.length} 页；开始按文案把页码归到商品/方案`);
    const matches = new Map<string, number[]>();
    /** 每页的"主商品"：标题命中 > 正文命中最多者；判不出就留空（多商品页的图只进方案档案） */
    const primaryOf = new Map<number, string>();
    let multiProductSlides = 0;
    for (const slide of slides) {
      const text = slide.texts.join("\n");
      const hit = PRODUCT_RULES.filter((rule) => rule.keywords.test(text));
      if (hit.length > 1) multiProductSlides += 1;
      for (const rule of hit) matches.set(rule.id, [...(matches.get(rule.id) ?? []), slide.slide]);
      const byTitle = hit.filter((rule) => rule.keywords.test(slide.title));
      if (byTitle.length === 1) primaryOf.set(slide.slide, byTitle[0]!.id);
      else if (hit.length === 1) primaryOf.set(slide.slide, hit[0]!.id);
      else if (hit.length > 1) {
        const scored = hit.map((rule) => ({ id: rule.id, score: slide.texts.filter((line) => rule.keywords.test(line)).length }))
          .sort((a, b) => b.score - a.score);
        if (scored[0] && scored[1] && scored[0].score > scored[1].score) primaryOf.set(slide.slide, scored[0].id);
      }
    }
    log(`命中商品 ${matches.size} 个（其中多商品页 ${multiProductSlides} 页：这类页面的图只进"方案档案"，不硬塞给单个商品）`);

    const companyId = slug(company || brand);
    const solutionId = slug(`${brand || company}-智慧酒店生态方案`);
    const productIds: string[] = [];
    const now = new Date().toISOString();
    const isPhotoLike = (image: DeckImage): boolean => {
      const longest = Math.max(image.width, image.height);
      const shortest = Math.min(image.width, image.height);
      /** 与模块的硬规则对齐：≥50KB（低于此值在 verify 里就是 hard 的"疑似占位图"） */
      return longest >= minPx && image.bytes.length >= MIN_IMAGE_BYTES && shortest > 120 && longest / shortest < 4;
    };
    const writePhotos = (dir: string, images: DeckImage[], prefix: string): ProductArchivePhoto[] => {
      mkdirSync(join(dir, "photos"), { recursive: true });
      const photos: ProductArchivePhoto[] = [];
      const seen = new Set<string>();
      for (const image of images) {
        if (photos.length >= maxPhotos) break;
        const sha256 = createHash("sha256").update(image.bytes).digest("hex");
        if (seen.has(sha256)) continue;
        seen.add(sha256);
        const index = photos.length + 1;
        const target = `photos/${prefix}-${String(index).padStart(2, "0")}.png`;
        writeFileSync(join(dir, target), image.bytes);
        photos.push({ id: `${prefix}${index}`, file: target, role: photos.length === 0 ? "hero" : "detail", sha256, bytes: image.bytes.length, width: image.width, height: image.height });
      }
      return photos;
    };

    /* ---- 商品档案（只吃"单商品页"的图，避免把别的商品图算进来） ---- */
    for (const rule of PRODUCT_RULES) {
      const pages = matches.get(rule.id) ?? [];
      if (pages.length === 0) continue;
      const singlePages = pages.filter((page) => {
        const slide = slides.find((item) => item.slide === page)!;
        const text = slide.texts.join("\n");
        return PRODUCT_RULES.filter((item) => item.keywords.test(text)).length === 1;
      });
      /** 该镜的取图页 = 单商品页 ∪ 该镜作为"主商品"的多商品页（真机：型号同页时靠主商品判定） */
      const photoPages = [...new Set([...singlePages, ...pages.filter((page) => primaryOf.get(page) === rule.id)])];
      const dir = join(root, rule.id);
      const photos = writePhotos(dir, slides.filter((slide) => photoPages.includes(slide.slide)).flatMap((slide) => slide.images.filter(isPhotoLike)), rule.id);
      const evidence: ProductArchiveEvidence[] = pages.map((page) => {
        const slide = slides.find((item) => item.slide === page)!;
        return {
          query: `客户方案 PPT 第 ${page} 页`, url: `pptx://${basename(deckFile)}#slide=${page}`,
          title: slide.title, slide: page, slideTitle: slide.title, deckSha256, file: basename(deckFile),
          quote: slide.texts.filter((line) => rule.keywords.test(line)).slice(0, 2).join(" / ").slice(0, 200),
          note: singlePages.includes(page) ? "单商品页（机器归属判定）" : "多商品页：仅登记证据，图片未归入本商品"
        };
      });
      const specsSource = slides.filter((slide) => pages.includes(slide.slide)).map(extractSpecs);
      const specs = {
        features: [...new Set(specsSource.flatMap((item) => item.features))].slice(0, 12),
        parameters: [...new Map(specsSource.flatMap((item) => item.parameters).map((item) => [`${item.name}:${item.value}`, item])).values()].slice(0, 12),
        notes: [...new Set(specsSource.flatMap((item) => item.notes))].slice(0, 8),
        ...(photos.length ? {} : { appearance: "" })
      };
      const archive: ProductArchive = {
        schemaVersion: PRODUCT_ARCHIVE_SCHEMA,
        id: rule.id,
        displayName: rule.name,
        type: "product",
        ...(rule.model ? { model: rule.model } : {}),
        company: company || undefined,
        brand: brand || undefined,
        aliases: [rule.name, ...(rule.model ? [rule.model] : []), rule.id],
        relations: { companyId },
        source: {
          kind: "user-upload", priority: PRODUCT_ARCHIVE_SOURCE_PRIORITY["user-upload"],
          generatedAt: now, generator: "scripts/tools/product-archive.mts@import-pptx",
          reviewStatus: "owner-confirmed", providedBy: `${basename(deckFile)}（客户提供的对外合作方案 PPT）`,
          evidence,
          extraction: {
            method: "pptx-slide-keyword-mapping", verified: false,
            note: "页码→商品→图片为机器判定：图片是否确为该商品请客户抽查；参数均为原文摘录并带 slide 来源，未核验的宣传性数字只进 notes"
          },
          disclaimer: "素材与参数来自客户提供的对外方案 PPT：可在本客户项目内使用，对外投放前请客户确认图片素材的授权范围与参数口径。"
        },
        photos,
        specs,
        createdAt: now, updatedAt: now
      };
      writeArchive(dir, archive);
      productIds.push(rule.id);
      log(`  ✓ 商品档案 ${rule.id}：页 ${pages.join(",")}（单商品页 ${singlePages.join(",") || "无"}）· 图 ${photos.length} 张 · 参数 ${specs.parameters.length} 条`);
      const issues = verifyProductArchive(archive, { dir, probeImage: (file) => { const bytes = readFileSync(file); const size = imageSize(bytes); return size ? { width: size.width, height: size.height } : null; } });
      for (const issue of issues.filter((item) => item.hard)) log(`      ✗ [${issue.code}] ${issue.detail}`);
    }

    /* ---- 方案档案（多商品页的图 + 成员索引，避免多商品图被错挂到单个商品） ---- */
    const solutionDir = join(root, solutionId);
    /** 方案档案收"多商品页"的图；已被某个主商品领走的页面不重复收（同图两处挂容易造成归属混淆） */
    const multiSlides = slides.filter((slide) => PRODUCT_RULES.filter((rule) => rule.keywords.test(slide.texts.join("\n"))).length > 1)
      .filter((slide) => !primaryOf.has(slide.slide) || PRODUCT_RULES.filter((rule) => rule.keywords.test(slide.title + slide.texts.join("\n"))).length === 0);
    const solutionPhotos = writePhotos(solutionDir, multiSlides.flatMap((slide) => slide.images.filter(isPhotoLike)), "solution");
    const solutionEvidence: ProductArchiveEvidence[] = slides.map((slide) => ({
      query: `客户方案 PPT 第 ${slide.slide} 页`, url: `pptx://${basename(deckFile)}#slide=${slide.slide}`,
      title: slide.title, slide: slide.slide, slideTitle: slide.title, deckSha256, file: basename(deckFile),
      quote: slide.texts.slice(0, 3).join(" / ").slice(0, 200)
    }));
    const solution: ProductArchive = {
      schemaVersion: PRODUCT_ARCHIVE_SCHEMA,
      id: solutionId,
      displayName: `${brand || company} 智慧酒店生态方案`,
      type: "solution",
      company: company || undefined, brand: brand || undefined,
      aliases: [`${brand || company}智慧酒店产品方案`, `${brand || company} 酒店方案`],
      relations: { companyId, includes: PRODUCT_RULES.filter((rule) => productIds.includes(rule.id)).map((rule) => ({ id: rule.id, role: rule.role })) },
      source: {
        kind: "user-upload", priority: PRODUCT_ARCHIVE_SOURCE_PRIORITY["user-upload"],
        generatedAt: now, generator: "scripts/tools/product-archive.mts@import-pptx",
        reviewStatus: "owner-confirmed", providedBy: `${basename(deckFile)}（客户提供的对外合作方案 PPT）`,
        evidence: solutionEvidence,
        extraction: { method: "pptx-slide-keyword-mapping", verified: false, note: "整份方案页证据齐备；成员商品由关键词判定" },
        disclaimer: "方案级素材（含案例页）来自客户方 PPT，主图可能包含案例酒店场景照；投放前请客户确认可用范围。"
      },
      photos: solutionPhotos,
      specs: { notes: ["方案 = 会员商品索引 + 多商品页素材；单商品外观请以对应商品档案为准。"] },
      createdAt: now, updatedAt: now
    };
    writeArchive(solutionDir, solution);
    writeFileSync(join(solutionDir, "deck-outline.json"), `${JSON.stringify({ deck: basename(deckFile), deckSha256, slides: slides.map((slide) => ({ slide: slide.slide, title: slide.title, texts: slide.texts, images: slide.images.map((image) => ({ file: basename(image.file), width: image.width, height: image.height, bytes: image.bytes.length })) })) }, null, 2)}\n`, "utf8");
    log(`  ✓ 方案档案 ${solutionId}：页 ${slides.length} 页证据 · 图 ${solutionPhotos.length} 张 · 成员商品 ${solution.relations!.includes!.length} 个`);

    /* ---- 公司档案（品牌/成员索引/原件摘要；不复制大文件进仓） ---- */
    const companyDir = join(root, companyId);
    mkdirSync(companyDir, { recursive: true });
    const companyArchive: ProductArchive = {
      schemaVersion: PRODUCT_ARCHIVE_SCHEMA,
      id: companyId,
      displayName: company || brand,
      type: "company",
      company: company || undefined, brand: brand || undefined,
      aliases: [company, brand].filter(Boolean),
      relations: { products: productIds, solutions: [solutionId] },
      source: {
        kind: "user-upload", priority: PRODUCT_ARCHIVE_SOURCE_PRIORITY["user-upload"],
        generatedAt: now, generator: "scripts/tools/product-archive.mts@import-pptx",
        reviewStatus: "owner-confirmed", providedBy: `${basename(deckFile)}（${(deckBytes.length / 1024 / 1024).toFixed(1)}MB，未随仓入库）`,
        evidence: [{ query: "客户方案 PPT 全文", url: `pptx://${basename(deckFile)}`, title: basename(deckFile), slide: 1, deckSha256, file: basename(deckFile), note: "原件摘要：大小与 sha256 已登记，原件保留在客户/本地" }],
        disclaimer: "公司档案只登记品牌与成员索引；原件与对外口径以客户正式资料为准。"
      },
      photos: [],
      specs: { notes: ["本档案由客户方案 PPT 自动拆分生成（company/solution/product 三层）。"] },
      createdAt: now, updatedAt: now
    };
    writeArchive(companyDir, companyArchive);
    log(`  ✓ 公司档案 ${companyId}：成员商品 ${productIds.length} 个 · 方案 ${1} 个`);
    log(`\n导入完成：${root}`);
    return 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const command = process.argv[2] ?? "";
/**
 * import-pdf：客户产品 PDF（逐页文本 + 内嵌图）→ 商品档案
 * 前置解析：`python3 scripts/tools/pdf-deck-extract.py --file <pdf> --out <work>`（产出 pages.json + images/）
 * 与 import-pptx 共用产品规则与建档口径（公司/方案/商品三层、页码级证据、参数带来源、extraction.verified=false）。
 */
function commandImportPdf(): number {
  const file = resolve(arg("--file"));
  const work = resolve(arg("--work"));
  if (!existsSync(file)) throw new Error(`PDF 不存在：${file}`);
  const sidecar = join(work, "pages.json");
  if (!existsSync(sidecar)) throw new Error(`缺逐页解析结果：${sidecar}（先跑 scripts/tools/pdf-deck-extract.py）`);
  const parsed = JSON.parse(readFileSync(sidecar, "utf8")) as {
    source: string;
    pages: Array<{ page: number; text: string; images: Array<{ file: string; width: number; height: number; bytes: number }> }>;
  };
  const company = arg("--company").trim() || "示例企业";
  const brand = arg("--brand").trim() || "示例品牌";
  const root = resolve(arg("--root", DEFAULT_ROOT));
  const deckBytes = readFileSync(file);
  const deckSha256 = createHash("sha256").update(deckBytes).digest("hex");
  const now = new Date().toISOString();
  const compact = (value: string): string => value.normalize("NFKC").replace(/\s+/g, "");
  log(`导入产品 PDF：${basename(file)}（sha256 ${deckSha256.slice(0, 12)}…）· ${parsed.pages.length} 页`);

  const matches = new Map<string, number[]>();
  const primaryOf = new Map<number, string>();
  for (const page of parsed.pages) {
    const text = compact(page.text);
    const hit = PRODUCT_RULES.filter((rule) => rule.keywords.test(text) || rule.keywords.test(page.text));
    for (const rule of hit) matches.set(rule.id, [...(matches.get(rule.id) ?? []), page.page]);
    const title = compact(String(page.text.split("\n")[0] ?? ""));
    const byTitle = hit.filter((rule) => rule.keywords.test(title));
    if (byTitle.length === 1) primaryOf.set(page.page, byTitle[0]!.id);
    else if (hit.length === 1) primaryOf.set(page.page, hit[0]!.id);
  }
  const productIds: string[] = [];
  const productsDir = root;
  for (const rule of PRODUCT_RULES) {
    const pages = [...new Set(matches.get(rule.id) ?? [])].sort((a, b) => a - b);
    if (pages.length === 0) continue;
    const dir = join(productsDir, rule.id);
    mkdirSync(join(dir, "photos"), { recursive: true });
    const photos: ProductArchivePhoto[] = [];
    const seen = new Set<string>();
    const evidence: ProductArchiveEvidence[] = [];
    for (const pageNo of pages) {
      const page = parsed.pages.find((item) => item.page === pageNo)!;
      evidence.push({
        query: `客户产品资料 PDF 第 ${pageNo} 页`, url: `pdf://${basename(file)}#page=${pageNo}`,
        title: String(page.text.split("\n")[0] ?? "").slice(0, 60), slide: pageNo, slideTitle: String(page.text.split("\n")[0] ?? "").slice(0, 60),
        deckSha256, file: basename(file),
        quote: page.text.split("\n").filter((line) => rule.keywords.test(compact(line)) || rule.keywords.test(line)).slice(0, 2).join(" / ").slice(0, 200),
        note: primaryOf.get(pageNo) === rule.id ? "该页主商品（机器判定）" : "同页关联页"
      });
      for (const image of page.images) {
        const sha256 = createHash("sha256").update(readFileSync(join(work, image.file))).digest("hex");
        if (seen.has(sha256)) continue;
        seen.add(sha256);
        const ext = image.file.endsWith(".jpg") || image.file.endsWith(".jpeg") ? "jpg" : "png";
        const target = `photos/${rule.id}-${String(photos.length + 1).padStart(2, "0")}.${ext}`;
        copyFileSync(join(work, image.file), join(dir, target));
        photos.push({ id: `p${photos.length + 1}`, file: target, role: photos.length === 0 ? "hero" : "detail", sha256, bytes: image.bytes, width: image.width, height: image.height });
      }
    }
    const text = pages.map((pageNo) => parsed.pages.find((item) => item.page === pageNo)!.text).join("\n");
    const parameters: Array<{ name: string; value: string; source: string }> = [];
    for (const match of text.matchAll(/(型号|尺寸|屏幕|摄像头|打印机|发卡)[：:\s]*([^\n，。；]{2,40})/g)) {
      if (parameters.length >= 12) break;
      parameters.push({ name: match[1]!, value: compact(match[2]!).slice(0, 40), source: `page ${pages[0]}` });
    }
    const features = [...new Set(text.split("\n").map((line) => line.trim()).filter((line) => /^[•·\-]|支持|可|具备/.test(line)).map((line) => line.replace(/^[•·\-]\s*/, "")).filter((line) => line.length >= 4 && line.length <= 40))].slice(0, 10);
    const archive: ProductArchive = {
      schemaVersion: PRODUCT_ARCHIVE_SCHEMA,
      id: rule.id, displayName: rule.name, type: "product",
      ...(rule.model ? { model: rule.model } : {}),
      company, brand,
      aliases: [rule.name, ...(rule.model ? [rule.model] : []), rule.id],
      source: {
        kind: "user-upload", priority: PRODUCT_ARCHIVE_SOURCE_PRIORITY["user-upload"],
        generatedAt: now, generator: "scripts/tools/product-archive.mts@import-pdf",
        reviewStatus: "owner-confirmed", providedBy: `${basename(file)}（客户提供的全系列产品介绍）`,
        evidence,
        extraction: { method: "pdf-page-keyword-mapping", verified: false, note: "页码→商品→图片为机器判定：图片是否确为该商品请客户抽查；参数为原文摘录并带 page 来源" },
        disclaimer: "素材与参数来自客户提供的产品资料：可在本客户项目内使用；对外投放前请客户确认素材授权与参数口径。"
      },
      photos,
      specs: { features, parameters, notes: [] },
      createdAt: now, updatedAt: now
    };
    writeArchive(dir, archive);
    productIds.push(rule.id);
    const issues = verifyProductArchive(archive, { dir, probeImage: null });
    log(`  ✓ ${rule.id}｜${rule.name}：页 ${pages.join(",")} · 图 ${photos.length} 张 · 参数 ${parameters.length} 条${issues.some((i) => i.hard) ? ` · 硬问题 ${issues.filter((i) => i.hard).map((i) => i.code).join(",")}` : ""}`);
  }
  // 公司/方案档案：合并既有（PPT 导入的）+ 本次 PDF 解析出的成员
  const companyDir = join(root, slug(company));
  const solutionDir = join(root, slug(`${brand}-智慧酒店生态方案`));
  const mergeRelations = (dir: string, extraProducts: string[]): void => {
    if (!existsSync(join(dir, "profile.json"))) return;
    const archive = JSON.parse(readFileSync(join(dir, "profile.json"), "utf8")) as ProductArchive;
    archive.relations = archive.relations ?? {};
    if (archive.type === "company") archive.relations.products = [...new Set([...(archive.relations.products ?? []), ...extraProducts])];
    if (archive.type === "solution") archive.relations.includes = [...new Map([...(archive.relations.includes ?? []), ...extraProducts.map((id) => ({ id, role: PRODUCT_RULES.find((r) => r.id === id)?.role }))].map((item) => [item.id, item])).values()];
    archive.updatedAt = now;
    writeArchive(dir, archive);
    log(`  ✓ 更新 ${archive.type} 档案 ${archive.id}（成员 ${extraProducts.length} 个）`);
  };
  mergeRelations(companyDir, productIds);
  mergeRelations(solutionDir, productIds);
  log(`\nPDF 导入完成：${root}（商品 ${productIds.length} 个）`);
  return 0;
}

const run = async (): Promise<number> => {
  if (command === "search") return commandSearch();
  if (command === "build") return commandBuild();
  if (command === "import-pptx") return commandImportPptx();
  if (command === "import-pdf") return commandImportPdf();
  if (command === "verify") return commandVerify();
  if (command === "list") return commandList();
  log("用法：product-archive.mts search|build|import-pptx|import-pdf|verify|list …（详见文件头注释）");
  return 1;
};
run().then((code) => { process.exitCode = code; }).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
