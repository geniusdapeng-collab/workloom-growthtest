/** 营销事实来源：只抓取逐跳核验后的公网正文，固定 DNS，保存完整字节而非搜索摘要。 */
import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingHttpHeaders, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { createHash } from "node:crypto";

export const SOURCE_MAX_BYTES = 2 * 1024 * 1024;
export const SOURCE_MAX_TEXT_CHARS = 24_000;
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
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port) {
    throw new Error("SOURCE_URL_INVALID：来源只接受无凭据的标准 HTTP/HTTPS 公网页面");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || /\.(localhost|local|internal|test|invalid)$/.test(host)) throw new Error("SOURCE_URL_PRIVATE：内部或测试域名不能作正式来源");
  if (isIP(host) && !publicSourceAddress(host)) throw new Error("SOURCE_URL_PRIVATE：来源不能使用非公网IP");
  url.hash = "";
  return url;
}

/** 低层传输独立导出供真实本地HTTP回归；生产只能由fetchMarketingSource在校验后调用。 */
export const requestSource: SourceTransport = (url, address, signal) => new Promise((resolve, reject) => {
  const options: RequestOptions = {
    method: "GET", agent: false, signal, family: address.family,
    headers: { "user-agent": "WorkLoom-FactSource/1.0", accept: "text/html,text/plain,application/json", "accept-encoding": "identity" },
    lookup: ((_hostname: string, options: { all?: boolean }, done: (...args: unknown[]) => void) => {
      if (options.all) done(null, [address]); else done(null, address.address, address.family);
    }) as RequestOptions["lookup"],
  };
  const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, options, response => {
    response.once("error", reject);
    if (Number(response.headers["content-length"] ?? 0) > SOURCE_MAX_BYTES) { response.destroy(new Error("SOURCE_TOO_LARGE：来源响应超过读取上限")); return; }
    const chunks: Buffer[] = []; let bytes = 0;
    response.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > SOURCE_MAX_BYTES) { response.destroy(new Error("SOURCE_TOO_LARGE：来源响应超过读取上限")); return; }
      chunks.push(Buffer.from(chunk));
    });
    response.once("aborted", () => reject(new Error("SOURCE_ABORTED：来源响应中途断开")));
    response.once("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
  });
  request.once("error", reject);
  request.end();
});

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
export function sourceDocument(raw: string, contentType: string, finalUrl: string): { text: string; assetUrls: string[] } {
  const html = /(?:html|xhtml)/i.test(contentType);
  const assetUrls = new Set<string>();
  if (html) for (const match of raw.matchAll(/<(?:img|source)\b[^>]*\b(?:src|data-src)\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    try { const url = sourceUrl(new URL(decodeEntities(match[1]!), finalUrl).href); assetUrls.add(url.href); } catch { /* 非公网图片不进入候选 */ }
  }
  const visible = html ? raw.replace(/<!--[\s\S]*?-->/g, " ").replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, "\n").replace(/<[^>]*>/g, " ") : raw;
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

export async function fetchMarketingSource(rawUrl: string, options: {
  resolver?: SourceResolver; transport?: SourceTransport; timeoutMs?: number;
} = {}): Promise<{ snapshot: SourceSnapshot; rawBytes: Buffer }> {
  const signal = AbortSignal.timeout(options.timeoutMs ?? 15_000);
  const resolve = options.resolver ?? (async hostname => lookup(hostname, { all: true, verbatim: true }));
  const transport = options.transport ?? requestSource;
  const requested = sourceUrl(rawUrl); let current = requested;
  const chain: string[] = [];
  for (let hop = 0; hop <= 4; hop++) {
    signal.throwIfAborted();
    const hostname = current.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await abortable(resolve(hostname), signal);
    signal.throwIfAborted();
    if (addresses.length === 0 || addresses.some(address => !publicSourceAddress(address.address))) throw new Error("SOURCE_URL_PRIVATE：来源解析到非公网地址");
    const result = await abortable(transport(current, addresses[0]!, signal), signal);
    if (result.body.length > SOURCE_MAX_BYTES) throw new Error("SOURCE_TOO_LARGE：来源响应超过读取上限");
    if ([301, 302, 303, 307, 308].includes(result.status)) {
      if (hop === 4 || !result.headers.location) throw new Error("SOURCE_REDIRECT_INVALID：来源重定向过多或缺目标");
      chain.push(current.href); current = sourceUrl(new URL(result.headers.location, current).href); continue;
    }
    if (result.status !== 200) throw new Error(`SOURCE_HTTP_FAILED：来源HTTP ${result.status}`);
    const contentType = String(result.headers["content-type"] ?? "");
    if (!/^(text\/(?:html|plain)|application\/(?:json|xhtml\+xml))(?:;|$)/i.test(contentType)) throw new Error("SOURCE_TYPE_UNSUPPORTED：来源不是可读取的HTML、文本或JSON正文");
    let decoded = result.body;
    const encoding = result.headers["content-encoding"];
    if (encoding && encoding !== "identity") {
      const decode = encoding === "gzip" ? gunzipSync : encoding === "deflate" ? inflateSync : encoding === "br" ? brotliDecompressSync : null;
      if (!decode) throw new Error("SOURCE_ENCODING_UNSUPPORTED：来源压缩格式不支持");
      decoded = decode(decoded, { maxOutputLength: SOURCE_MAX_BYTES });
    }
    if (!decoded.length || decoded.length > SOURCE_MAX_BYTES) throw new Error("SOURCE_TOO_LARGE：来源字节为空或超过上限");
    const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(contentType)?.[1] ?? "utf-8";
    const raw = new TextDecoder(charset, { fatal: true }).decode(decoded);
    const document = sourceDocument(raw, contentType, current.href);
    const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
    const rawSha256 = hash(decoded), textSha256 = hash(document.text);
    return { snapshot: { sourceId: `SRC-${hash(`${current.href}\n${textSha256}`).slice(0, 24)}`, requestedUrl: requested.href,
      finalUrl: current.href, redirectChain: chain, fetchedAt: new Date().toISOString(), contentType,
      rawSha256, textSha256, bytes: decoded.length, ...document }, rawBytes: decoded };
  }
  throw new Error("SOURCE_REDIRECT_INVALID：来源重定向未完成");
}
