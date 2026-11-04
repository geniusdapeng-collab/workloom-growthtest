/** 营销事实来源：只抓取逐跳核验后的公网正文，固定 DNS，保存完整字节而非搜索摘要。 */
import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingHttpHeaders, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { createHash } from "node:crypto";

export const SOURCE_MAX_BYTES = 2 * 1024 * 1024;
export const SOURCE_MAX_TEXT_CHARS = 24_000;
export const PUBLIC_RESOURCE_MAX_BYTES = 15 * 1024 * 1024;
export interface SourceSnapshot {
  sourceId: string; requestedUrl: string; finalUrl: string; redirectChain: string[];
  fetchedAt: string; contentType: string; rawSha256: string; textSha256: string;
  bytes: number; text: string; assetUrls: string[];
}
export interface SourceResponse { status: number; headers: IncomingHttpHeaders; body: Buffer }
export type SourceResolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;
export type SourceTransport = (url: URL, address: { address: string; family: number }, signal: AbortSignal) => Promise<SourceResponse>;

export function publicSourceAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 100 && b >= 64 && b <= 127
      || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0)
      || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  // 只准许全球单播 2000::/3；映射IPv4、ULA、链路本地、组播和隧道/文档地址均不进入网络。
  if (family === 6) {
    const groups = address.toLowerCase().split(":"); const first = parseInt(groups[0]!, 16), second = parseInt(groups[1] || "0", 16);
    return first >= 0x2000 && first <= 0x3fff && first !== 0x2002
      && !(first === 0x2001 && (second === 0 || second === 0xdb8 || second >= 0x10 && second <= 0x2f));
  }
  return false;
}

export function sourceUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("SOURCE_URL_INVALID：来源不是有效网址"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("SOURCE_URL_INVALID：来源只接受无凭据的标准 HTTP/HTTPS 公网页面");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || /\.(localhost|local|internal|test|invalid)$/.test(host)) throw new Error("SOURCE_URL_PRIVATE：内部或测试域名不能作正式来源");
  if (isIP(host) && !publicSourceAddress(host)) throw new Error("SOURCE_URL_PRIVATE：来源不能使用非公网IP");
  if (url.port) throw new Error("SOURCE_URL_INVALID：来源只接受标准 HTTP/HTTPS 端口");
  url.hash = "";
  return url;
}

/** 低层传输供来源/图片共用；生产必须在逐跳公网校验后调用。 */
export function createSourceTransport(maxBytes = SOURCE_MAX_BYTES, accept = "text/html,text/plain,application/json"): SourceTransport {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > PUBLIC_RESOURCE_MAX_BYTES) throw new Error("SOURCE_LIMIT_INVALID：来源读取上限非法");
  return (url, address, signal) => new Promise((resolve, reject) => {
    const options: RequestOptions = {
      method: "GET", agent: false, signal, family: address.family,
      headers: {
        "user-agent": "WorkLoom-FactSource/1.0",
        accept,
        "accept-encoding": "identity",
        // 部分官方只读 API 会拒绝空来源。固定为当前 URL 的同源根，不携带搜索页或其它站点信息。
        referer: `${url.protocol}//${url.host}/`,
      },
      lookup: ((_hostname: string, options: { all?: boolean }, done: (...args: unknown[]) => void) => {
        if (options.all) done(null, [address]); else done(null, address.address, address.family);
      }) as RequestOptions["lookup"],
    };
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, options, response => {
      response.once("error", reject);
      if (Number(response.headers["content-length"] ?? 0) > maxBytes) { response.destroy(new Error("SOURCE_TOO_LARGE：来源响应超过读取上限")); return; }
      const chunks: Buffer[] = []; let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxBytes) { response.destroy(new Error("SOURCE_TOO_LARGE：来源响应超过读取上限")); return; }
        chunks.push(Buffer.from(chunk));
      });
      response.once("aborted", () => reject(new Error("SOURCE_ABORTED：来源响应中途断开")));
      response.once("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.once("error", reject);
    request.end();
  });
}
export const requestSource: SourceTransport = createSourceTransport();

function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, entity: string) => {
    if (entity.startsWith("#")) {
      const value = parseInt(entity.slice(/^#x/i.test(entity) ? 2 : 1), /^#x/i.test(entity) ? 16 : 10);
      return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : all;
    }
    return named[entity.toLowerCase()] ?? all;
  });
}

/**
 * Some search engines return a 200 HTML interstitial whose visible body is empty and whose
 * only navigation is a meta refresh in `<noscript>`. Treat that as an ordinary redirect hop
 * before extracting source text; JavaScript-only navigation is deliberately not executed.
 */
function metaRefreshTarget(raw: string): string | null {
  for (const match of raw.matchAll(/<meta\b[^>]*>/giu)) {
    const tag = match[0];
    if (!/\bhttp-equiv\s*=\s*["']?refresh\b/iu.test(tag)) continue;
    const content = /\bcontent\s*=\s*(["'])([\s\S]*?)\1/iu.exec(tag)?.[2];
    if (!content) continue;
    const target = /(?:^|;)\s*url\s*=\s*(?:(["'])(.*?)\1|([^"';\s>]+))/iu.exec(content);
    const value = decodeEntities((target?.[2] ?? target?.[3] ?? "").trim());
    if (value) return value;
  }
  return null;
}

/** Read visible HTML text without promoting hidden dialog/summary UI into article evidence. */
function visibleHtmlText(raw: string): string {
  const document = raw.replace(/<!--[\s\S]*?-->/g, " ").replace(/<!doctype\b[^>]*>/gi, " ")
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  const stack: Array<{ tag: string; hidden: boolean }> = [];
  const voidElements = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  const blockElements = new Set(["p", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "article", "section"]);
  const hidden = () => stack.at(-1)?.hidden === true;
  let text = "", previous = 0;
  for (const match of document.matchAll(/<\/?([a-z][\w:-]*)\b(?:"[^"]*"|'[^']*'|[^'">])*?>/giu)) {
    if (!hidden()) text += document.slice(previous, match.index);
    previous = match.index + match[0].length;
    const token = match[0], tag = match[1]!.toLowerCase();
    if (token.startsWith("</")) {
      const wasHidden = hidden();
      let index = stack.length - 1;
      while (index >= 0 && stack[index]!.tag !== tag) index--;
      if (index >= 0) stack.length = index;
      if (!wasHidden && blockElements.has(tag)) text += "\n";
      continue;
    }
    const attributes = new Map<string, string>();
    const attributeText = token.slice(token.indexOf(match[1]!) + tag.length, -1);
    for (const attribute of attributeText.matchAll(/([^\s=\/"'<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu)) {
      attributes.set(attribute[1]!.toLowerCase(), decodeEntities(attribute[2] ?? attribute[3] ?? attribute[4] ?? ""));
    }
    const style = attributes.get("style") ?? "";
    const inlineHidden = attributes.has("hidden")
      || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|content-visibility\s*:\s*hidden)\s*(?:!important\s*)?(?:;|$)/iu.test(style);
    const excluded = hidden() || inlineHidden;
    if (!excluded && tag === "br") text += "\n";
    else if (!excluded) text += " ";
    if (!voidElements.has(tag) && !/\/\s*>$/u.test(token)) stack.push({ tag, hidden: excluded });
  }
  if (!hidden()) text += document.slice(previous);
  return text;
}

export function sourceDocument(raw: string, contentType: string, finalUrl: string): { text: string; assetUrls: string[] } {
  const html = /(?:html|xhtml)/i.test(contentType);
  const assetUrls = new Set<string>();
  if (html) for (const match of raw.matchAll(/<(?:img|source)\b[^>]*\b(?:src|data-src)\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    try { const url = sourceUrl(new URL(decodeEntities(match[1]!), finalUrl).href); assetUrls.add(url.href); } catch { /* 非公网图片不进入候选 */ }
  }
  const visible = html ? visibleHtmlText(raw) : raw;
  const text = decodeEntities(visible).replace(/\r\n?/g, "\n").replace(/[\t \f]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!text || /(?:请输入验证码|访问过于频繁|请完成安全验证|verify you are human|checking your browser)/i.test(text)) throw new Error("SOURCE_UNAVAILABLE：页面为空或是访问验证页");
  if (text.length > SOURCE_MAX_TEXT_CHARS) throw new Error("SOURCE_TEXT_TOO_LARGE：完整正文超过单来源审核上限，不能截断后作为证据");
  return { text, assetUrls: [...assetUrls] };
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

async function checkedSourceResponse(current: URL, options: {
  resolver: SourceResolver; transport: SourceTransport; signal: AbortSignal; maxBytes: number;
}): Promise<SourceResponse> {
  const { resolver, transport, signal, maxBytes } = options;
  signal.throwIfAborted();
  const hostname = current.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await abortable(resolver(hostname), signal);
  signal.throwIfAborted();
  if (addresses.length === 0 || addresses.some(address => !publicSourceAddress(address.address))) throw new Error("SOURCE_URL_PRIVATE：来源解析到非公网地址");
  const result = await abortable(transport(current, addresses[0]!, signal), signal);
  if (result.body.length > maxBytes) throw new Error("SOURCE_TOO_LARGE：来源响应超过读取上限");
  return result;
}

function decodedSourceBytes(result: SourceResponse, maxBytes: number): Buffer {
  let decoded = result.body;
  const encoding = result.headers["content-encoding"];
  if (encoding && encoding !== "identity") {
    const decode = encoding === "gzip" ? gunzipSync : encoding === "deflate" ? inflateSync : encoding === "br" ? brotliDecompressSync : null;
    if (!decode) throw new Error("SOURCE_ENCODING_UNSUPPORTED：来源压缩格式不支持");
    decoded = decode(decoded, { maxOutputLength: maxBytes });
  }
  if (!decoded.length || decoded.length > maxBytes) throw new Error("SOURCE_TOO_LARGE：来源字节为空或超过上限");
  return decoded;
}

export interface PublicResourceOptions {
  resolver?: SourceResolver; transport?: SourceTransport; timeoutMs?: number; maxBytes?: number;
}

/** 非文本公开资源使用与事实正文相同的逐跳DNS固定/超时/字节围栏，不执行页面脚本。 */
export async function fetchPublicResource(rawUrl: string, options: PublicResourceOptions = {}): Promise<{
  body: Buffer; requestedUrl: string; finalUrl: string; redirectChain: string[]; contentType: string;
}> {
  const maxBytes = options.maxBytes ?? SOURCE_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > PUBLIC_RESOURCE_MAX_BYTES) throw new Error("SOURCE_LIMIT_INVALID：来源读取上限非法");
  const signal = AbortSignal.timeout(options.timeoutMs ?? 15_000);
  const resolver = options.resolver ?? (async hostname => lookup(hostname, { all: true, verbatim: true }));
  const transport = options.transport ?? createSourceTransport(maxBytes, "image/*,application/octet-stream;q=0.9,*/*;q=0.1");
  const requested = sourceUrl(rawUrl); let current = requested;
  const chain: string[] = [];
  for (let hop = 0; hop <= 4; hop++) {
    const result = await checkedSourceResponse(current, { resolver, transport, signal, maxBytes });
    if ([301, 302, 303, 307, 308].includes(result.status)) {
      if (hop === 4 || !result.headers.location) throw new Error("SOURCE_REDIRECT_INVALID：来源重定向过多或缺目标");
      chain.push(current.href); current = sourceUrl(new URL(result.headers.location, current).href); continue;
    }
    if (result.status !== 200) throw new Error(`SOURCE_HTTP_FAILED：来源HTTP ${result.status}`);
    return { body: decodedSourceBytes(result, maxBytes), requestedUrl: requested.href, finalUrl: current.href,
      redirectChain: chain, contentType: String(result.headers["content-type"] ?? "") };
  }
  throw new Error("SOURCE_REDIRECT_INVALID：来源重定向未完成");
}

export async function fetchMarketingSource(rawUrl: string, options: {
  resolver?: SourceResolver; transport?: SourceTransport; timeoutMs?: number;
} = {}): Promise<{ snapshot: SourceSnapshot; rawBytes: Buffer }> {
  const signal = AbortSignal.timeout(options.timeoutMs ?? 15_000);
  const resolve = options.resolver ?? (async hostname => lookup(hostname, { all: true, verbatim: true }));
  const transport = options.transport ?? requestSource;
  const requested = sourceUrl(rawUrl); let current = requested;
  const chain: string[] = [];
  for (let hop = 0; hop <= 4; hop++) {
    const result = await checkedSourceResponse(current, { resolver: resolve, transport, signal, maxBytes: SOURCE_MAX_BYTES });
    if ([301, 302, 303, 307, 308].includes(result.status)) {
      if (hop === 4 || !result.headers.location) throw new Error("SOURCE_REDIRECT_INVALID：来源重定向过多或缺目标");
      chain.push(current.href); current = sourceUrl(new URL(result.headers.location, current).href); continue;
    }
    if (result.status !== 200) throw new Error(`SOURCE_HTTP_FAILED：来源HTTP ${result.status}`);
    const contentType = String(result.headers["content-type"] ?? "");
    if (!/^(text\/(?:html|plain)|application\/(?:json|xhtml\+xml))(?:;|$)/i.test(contentType)) throw new Error("SOURCE_TYPE_UNSUPPORTED：来源不是可读取的HTML、文本或JSON正文");
    const decoded = decodedSourceBytes(result, SOURCE_MAX_BYTES);
    const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(contentType)?.[1] ?? "utf-8";
    const raw = new TextDecoder(charset, { fatal: true }).decode(decoded);
    const metaTarget = /(?:html|xhtml)/i.test(contentType) ? metaRefreshTarget(raw) : null;
    if (metaTarget) {
      if (hop === 4) throw new Error("SOURCE_REDIRECT_INVALID：来源重定向过多");
      chain.push(current.href);
      current = sourceUrl(new URL(metaTarget, current).href);
      continue;
    }
    const document = sourceDocument(raw, contentType, current.href);
    const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
    const rawSha256 = hash(decoded), textSha256 = hash(document.text);
    // 同一正文可由不同搜索跳转抵达。来源快照还包含 requestedUrl/redirectChain；
    // 身份必须保留请求路径，避免归档去重把另一站已审核的抓取快照替换掉。
    return { snapshot: { sourceId: `SRC-${hash(`${requested.href}\n${current.href}\n${textSha256}`).slice(0, 24)}`, requestedUrl: requested.href,
      finalUrl: current.href, redirectChain: chain, fetchedAt: new Date().toISOString(), contentType,
      rawSha256, textSha256, bytes: decoded.length, ...document }, rawBytes: decoded };
  }
  throw new Error("SOURCE_REDIRECT_INVALID：来源重定向未完成");
}
