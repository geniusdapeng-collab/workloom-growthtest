/**
 * ai-video × 配乐工位 · 在线曲源层（sources.mjs）
 *
 * 定位：**在线优先、本地兜底**。按配乐简报（题材/情绪/BPM/时长）去已授权的在线曲源检索，
 * 命中且许可合规就下载到工位缓存与素材区；在线不可用（未配置/超时/无结果/许可不合规）时，
 * 回退到本地精选曲库，并把"为什么回退"写进回执。
 *
 * 纪律：
 * - **不抓取**：只对接公开 API 或客户自建源（`generic-http`），不做网页爬取、不绕过鉴权；
 * - **许可先行**：NC/ND/未知许可一律拒收（与围栏 G-BGM5 同口径），下载前先判许可；
 * - **凭据不进文件**：token 只从环境变量/受控秘密存储读，日志与回执里不回显；
 * - **不伪造**：未配置的源如实标 `not_configured`，绝不假装搜过。
 *
 * 已核验的源（2026-09-23）：
 * - Jamendo API v3.0 `GET /v3.0/tracks`：需 `client_id`；`audiodownload_allowed` 决定能否下载，
 *   许可在 `license_ccurl`，`include=licenses+musicinfo+stats` 可取标签（见 developer.jamendo.com/v3.0/tracks）。
 * - Freesound API v2 `GET /apiv2/search/`：需 API token；结果含 `previews`（可直接下载的 mp3 试听）
 *   与 `license` 字段（见 freesound.org/docs/api）。
 * - Mubert API v3 `POST https://music-api.mubert.com/api/v3/public/tracks`：需 `customer-id` + `access-token`
 *   （见 mubert.com/api），输出免版税可商用。
 * - `generic-http`：客户自建索引（本文档定义契约），便于接自托管曲库/CDN。
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { MeasureError, sha256File } from "./measure.mjs";

/* ============================ 许可归一 ============================ */

/** 把各家返回的许可 URL/文本归一成本仓 LICENSE_TABLE 的 key。 */
export function normalizeLicense(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return "unknown";
  if (/publicdomain\/zero|cc0/.test(text)) return "cc0-1.0";
  if (/by-nc-nd/.test(text)) return "cc-by-nc-nd-4.0";
  if (/by-nc/.test(text)) return "cc-by-nc-4.0";
  if (/by-nd/.test(text)) return "cc-by-nd-4.0";
  if (/by-sa/.test(text)) return "cc-by-sa-4.0";
  if (/licenses\/by\/|\bcc[- ]?by\b|attribution/.test(text)) return "cc-by-4.0";
  if (/royalty[- ]?free|免版税|mubert|jamendo pro/.test(text)) return "royalty-free";
  if (/workloom-self-generated/.test(text)) return "workloom-self-generated";
  return "unknown";
}

/** 是否可商用（不可商用/未知一律 false，与围栏 G-BGM5 同口径）。 */
export function commercialOk(licenseKey, table) {
  const entry = table?.[licenseKey];
  return entry?.commercial === true;
}

/* ============================ 源注册表 ============================ */

/** 各源需要的环境变量（键名会出现在回执里，值不回显）。 */
export const SOURCE_ENV = {
  jamendo: ["JAMENDO_CLIENT_ID"],
  freesound: ["FREESOUND_API_TOKEN"],
  mubert: ["MUBERT_CUSTOMER_ID", "MUBERT_ACCESS_TOKEN"],
  "generic-http": ["WORKLOOM_BGM_ONLINE_ENDPOINT"],
};

export const SOURCES = Object.keys(SOURCE_ENV);

/**
 * 目录预设（catalog）：把"想要什么风格"翻译成各曲源能理解的检索参数。
 *
 * **版权边界（必须如实告知用户）**：
 * - `western-pop` 指的是"欧美流行风格"，不是"某几首最新的商业热单"——商业热单受版权保护，
 *   不能随开源仓库分发、也不能直接用于客户商用交付；要它们必须走**已授权的商业曲库**
 *   （自建索引 `generic-http` 指过去，或把订阅下载的曲目放进 `WORKLOOM_BGM_LIBRARY_DIR` 本地曲库）。
 * - `chinese-classical` 同理：传统曲目（如《春江花月夜》《高山流水》）的**曲谱**多属公有领域，
 *   但**录音**几乎都带表演者/录音制作者权；因此走 CC0/CC BY 或已授权曲源，不自行抓取。
 */
export const CATALOGS = {
  "western-pop": {
    label: "欧美流行风格（现代流行/电子/舞曲，非具体商业热单）",
    jamendoTags: ["pop", "dance", "electronic"],
    freesoundQuery: "pop music loop upbeat",
    mubertPlaylist: null,
    mubertText: "modern pop upbeat",
    bpmHint: 118,
    energyHint: "high",
  },
  "chinese-classical": {
    label: "中国古典/国风（古筝·二胡·琵琶·笛箫·民乐）",
    jamendoTags: ["traditional", "chinese", "world"],
    freesoundQuery: "guzheng erhu pipa dizi chinese traditional",
    mubertPlaylist: null,
    mubertText: "chinese traditional instrumental",
    bpmHint: 72,
    energyHint: "low",
  },
  "cinematic-score": {
    label: "影视配乐（管弦/氛围/推进）",
    jamendoTags: ["soundtrack", "classical", "cinematic"],
    freesoundQuery: "cinematic orchestral score",
    mubertPlaylist: null,
    mubertText: "cinematic orchestral",
    bpmHint: 90,
    energyHint: "medium",
  },
};

/** Jamendo 检索用的题材标签映射（中文题材 → Jamendo 英文标签/检索词）。 */
const JAMENDO_TAGS = {
  "product-ad": ["pop", "corporate"],
  interview: ["lounge", "acoustic"],
  food: ["lounge", "jazz"],
  tech: ["electronic", "ambient"],
  travel: ["world", "acoustic"],
  "night-city": ["electronic", "lounge"],
  beauty: ["ambient", "chillout"],
  family: ["acoustic", "pop"],
  auto: ["electronic", "rock"],
  realestate: ["lounge", "ambient"],
  "festival-promo": ["pop", "electronic"],
  documentary: ["soundtrack", "classical"],
  "premium-brand": ["classical", "soundtrack"],
  "drama-story": ["soundtrack", "piano"],
  suspense: ["soundtrack", "dark"],
  "comedy-light": ["pop", "funny"],
};

/** 报告哪些源可用（不联网、不回显凭据）。 */
export function listSources(env = process.env) {
  return SOURCES.map((name) => {
    const required = SOURCE_ENV[name];
    const missing = required.filter((key) => !String(env[key] ?? "").trim());
    return {
      name,
      configured: missing.length === 0,
      missingEnv: missing,
      note: missing.length ? `未配置 ${missing.join(" / ")}` : "已配置",
    };
  });
}

export function cacheDir(env = process.env) {
  const dir = (env.WORKLOOM_BGM_CACHE_DIR ?? "").trim();
  return dir ? path.resolve(dir) : path.join(os.homedir(), ".workloom-bgm", "cache");
}

/* ============================ HTTP 小工具 ============================ */

const MAX_DOWNLOAD_BYTES = Number(process.env.WORKLOOM_BGM_MAX_DOWNLOAD_BYTES ?? 80 * 1024 * 1024);

async function httpJson(url, { fetchImpl = fetch, headers = {}, timeoutMs = 20_000, method = "GET", body = null } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method,
      headers: { accept: "application/json", ...headers, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      redirect: "follow",
    });
    const text = await response.text();
    if (!response.ok) {
      throw new MeasureError(`HTTP ${response.status}：${text.slice(0, 160)}`, "network_error", true);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new MeasureError("在线源返回非 JSON", "bad_response", true);
    }
  } catch (error) {
    if (error instanceof MeasureError) throw error;
    if (error instanceof Error && error.name === "AbortError") throw new MeasureError("在线源请求超时", "timeout", true);
    throw new MeasureError(error instanceof Error ? error.message : String(error), "network_error", true);
  } finally {
    clearTimeout(timer);
  }
}

function assertHttpUrl(url, { allowHttpLocalhost = false } = {}) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new MeasureError(`在线源返回的下载地址非法：${String(url).slice(0, 80)}`, "bad_response");
  }
  const isLocalhost = ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
  if (parsed.protocol === "https:") return parsed;
  if (parsed.protocol === "http:" && (allowHttpLocalhost ? isLocalhost : true)) return parsed;
  throw new MeasureError(`拒绝非 http(s) 下载地址：${parsed.protocol}`, "bad_response");
}

/** 下载到目标文件并给出 sha256（流式写盘 + 体积上限，避免把磁盘写满）。 */
export async function downloadToFile(url, destPath, { fetchImpl = fetch, timeoutMs = 120_000, maxBytes = MAX_DOWNLOAD_BYTES } = {}) {
  const parsed = assertHttpUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(parsed.toString(), { signal: controller.signal, redirect: "follow" });
    if (!response.ok) throw new MeasureError(`下载失败 HTTP ${response.status}`, "network_error", true);
    const length = Number(response.headers?.get?.("content-length") ?? 0);
    if (length && length > maxBytes) {
      throw new MeasureError(`文件过大（${(length / 1024 / 1024).toFixed(1)}MB > ${(maxBytes / 1024 / 1024).toFixed(0)}MB 上限）`, "bad_request");
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) throw new MeasureError("下载到 0 字节文件", "bad_response", true);
    if (buffer.length > maxBytes) {
      throw new MeasureError(`文件过大（${(buffer.length / 1024 / 1024).toFixed(1)}MB 超上限）`, "bad_request");
    }
    await fsp.mkdir(path.dirname(destPath), { recursive: true });
    const tmp = `${destPath}.part`;
    await fsp.writeFile(tmp, buffer);
    await fsp.rename(tmp, destPath);
    return { path: destPath, bytes: buffer.length, sha256: await sha256File(destPath) };
  } catch (error) {
    if (error instanceof MeasureError) throw error;
    if (error instanceof Error && error.name === "AbortError") throw new MeasureError("下载超时", "timeout", true);
    throw new MeasureError(error instanceof Error ? error.message : String(error), "network_error", true);
  } finally {
    clearTimeout(timer);
  }
}

/* ============================ 各源检索 ============================ */

function pickQuery({ brief, recipe, catalog = null }) {
  const preset = catalog && CATALOGS[catalog] ? CATALOGS[catalog] : null;
  const englishTags = preset
    ? preset.jamendoTags
    : recipe?.id ? JAMENDO_TAGS[recipe.id] ?? [] : [];
  return {
    tags: englishTags,
    mood: brief?.mood?.length ? brief.mood.join(" ") : (preset ? preset.mubertText : ""),
    bpmTarget: preset?.bpmHint ?? (recipe?.bpm ? Math.round(recipe.bpm * (brief?.bpmScale ?? 1)) : null),
    catalog,
    preset,
  };
}

async function searchJamendo({ brief, recipe, limit, env, fetchImpl, catalog = null }) {
  const clientId = String(env.JAMENDO_CLIENT_ID ?? "").trim();
  if (!clientId) throw new MeasureError("未配置 JAMENDO_CLIENT_ID", "not_configured");
  const query = pickQuery({ brief, recipe, catalog });
  const params = new URLSearchParams({
    client_id: clientId,
    format: "json",
    limit: String(Math.max(1, Math.min(50, limit))),
    include: "licenses+musicinfo+stats",
    audiodownload_allowed: "true",
    order: "popularity_total",
    boost: "popularity_total",
    groupby: "artist_id",
  });
  if (query.tags.length) params.set("fuzzytags", query.tags.join("+"));
  if (query.bpmTarget) {
    params.set("speed", "medium");
  }
  const json = await httpJson(`https://api.jamendo.com/v3.0/tracks/?${params.toString()}`, { fetchImpl });
  const results = Array.isArray(json?.results) ? json.results : [];
  return results.map((item) => ({
    source: "jamendo",
    id: `jamendo-${item.id}`,
    title: item.name ?? null,
    artist: item.artist_name ?? null,
    url: item.audiodownload_allowed === false ? null : (item.audiodownload || null),
    pageUrl: item.shareurl ?? null,
    license: normalizeLicense(item.license_ccurl),
    licenseRaw: item.license_ccurl ?? null,
    durationSec: Number(item.duration ?? 0) || null,
    bpm: null,
    mood: Array.isArray(item.musicinfo?.tags?.genres) ? item.musicinfo.tags.genres.join("/") : null,
    genre: Array.isArray(item.musicinfo?.tags?.genres) ? item.musicinfo.tags.genres[0] ?? null : null,
    tags: [
      ...(item.musicinfo?.tags?.instruments ?? []),
      ...(item.musicinfo?.tags?.vartags ?? []),
      ...(item.musicinfo?.tags?.genres ?? []),
    ].slice(0, 12),
    downloaded: false,
  }));
}

async function searchFreesound({ brief, recipe, limit, env, fetchImpl, catalog = null }) {
  const token = String(env.FREESOUND_API_TOKEN ?? "").trim();
  if (!token) throw new MeasureError("未配置 FREESOUND_API_TOKEN", "not_configured");
  const query = pickQuery({ brief, recipe, catalog });
  const words = query.preset
    ? query.preset.freesoundQuery
    : [query.tags.join(" "), query.mood, "loop music bed"].filter(Boolean).join(" ");
  const params = new URLSearchParams({
    query: words || "music loop",
    fields: "id,name,previews,license,duration,tags,username",
    page_size: String(Math.max(1, Math.min(50, limit))),
    filter: "duration:[20 TO 300]",
  });
  const json = await httpJson(`https://freesound.org/apiv2/search/text/?${params.toString()}`, {
    fetchImpl,
    headers: { authorization: `Token ${token}` },
  });
  const results = Array.isArray(json?.results) ? json.results : [];
  return results.map((item) => ({
    source: "freesound",
    id: `freesound-${item.id}`,
    title: item.name ?? null,
    artist: item.username ?? null,
    url: item.previews?.["preview-hq-mp3"] ?? item.previews?.["preview-lq-mp3"] ?? null,
    pageUrl: `https://freesound.org/s/${item.id}/`,
    license: normalizeLicense(item.license),
    licenseRaw: item.license ?? null,
    durationSec: Number(item.duration ?? 0) || null,
    bpm: null,
    mood: null,
    genre: null,
    tags: Array.isArray(item.tags) ? item.tags.slice(0, 12) : [],
    downloaded: false,
  }));
}

async function searchMubert({ brief, recipe, limit, env, fetchImpl, catalog = null }) {
  const customerId = String(env.MUBERT_CUSTOMER_ID ?? "").trim();
  const accessToken = String(env.MUBERT_ACCESS_TOKEN ?? "").trim();
  if (!customerId || !accessToken) throw new MeasureError("未配置 MUBERT_CUSTOMER_ID / MUBERT_ACCESS_TOKEN", "not_configured");
  const query = pickQuery({ brief, recipe, catalog });
  const duration = Math.max(15, Math.min(25 * 60, Math.round(brief?.durationSec ?? 60)));
  const intensity = brief?.energyLevel === "high" ? "high" : brief?.energyLevel === "low" ? "low" : "medium";
  const json = await httpJson("https://music-api.mubert.com/api/v3/public/tracks", {
    fetchImpl,
    method: "POST",
    headers: { "customer-id": customerId, "access-token": accessToken },
    body: {
      playlist_index: String(env.MUBERT_PLAYLIST_INDEX ?? "1.0.0"),
      duration,
      bitrate: 128,
      format: "mp3",
      intensity,
      mode: "track",
      ...(query.preset?.mubertText || query.mood ? { text: query.preset?.mubertText || query.mood } : {}),
    },
    timeoutMs: 120_000,
  });
  const items = Array.isArray(json?.data) ? json.data : Array.isArray(json?.tracks) ? json.tracks : [];
  return items.slice(0, Math.max(1, limit)).map((item, index) => ({
    source: "mubert",
    id: `mubert-${item.id ?? index}-${Date.now().toString(36)}`,
    title: item.title ?? `Mubert ${intensity} #${index + 1}`,
    artist: "Mubert AI",
    url: item.url ?? item.audio_url ?? item.track_url ?? null,
    pageUrl: null,
    license: "royalty-free",
    licenseRaw: item.license ?? "royalty-free (Mubert API v3)",
    durationSec: Number(item.duration ?? duration) || null,
    bpm: Number(item.bpm ?? 0) || null,
    mood: query.mood || null,
    genre: item.genre ?? null,
    tags: ["mubert", intensity],
    downloaded: false,
  }));
}

async function searchGenericHttp({ brief, recipe, limit, env, fetchImpl, catalog = null }) {
  const endpoint = String(env.WORKLOOM_BGM_ONLINE_ENDPOINT ?? "").trim();
  if (!endpoint) throw new MeasureError("未配置 WORKLOOM_BGM_ONLINE_ENDPOINT", "not_configured");
  const query = pickQuery({ brief, recipe, catalog });
  const url = new URL(endpoint);
  if (recipe?.genre) url.searchParams.set("genre", recipe.genre);
  if (query.mood) url.searchParams.set("mood", query.mood);
  if (query.bpmTarget) {
    url.searchParams.set("bpm_min", String(Math.round(query.bpmTarget * 0.8)));
    url.searchParams.set("bpm_max", String(Math.round(query.bpmTarget * 1.25)));
  }
  url.searchParams.set("limit", String(Math.max(1, Math.min(50, limit))));
  url.searchParams.set("commercial_only", "true");
  if (query.catalog) url.searchParams.set("catalog", query.catalog);
  const json = await httpJson(url.toString(), { fetchImpl });
  const items = Array.isArray(json?.tracks) ? json.tracks : Array.isArray(json) ? json : [];
  // 自建索引常用相对路径（"/audio/x.mp3"）：按索引自身的 origin 解析成绝对地址
  const resolveUrl = (value) => {
    if (!value) return null;
    try {
      return new URL(String(value), url).toString();
    } catch {
      return null;
    }
  };
  return items.map((item, index) => ({
    source: "generic-http",
    id: item.id ? `generic-${item.id}` : `generic-${index}`,
    title: item.title ?? null,
    artist: item.artist ?? null,
    url: resolveUrl(item.url ?? item.download_url),
    pageUrl: resolveUrl(item.page_url),
    license: normalizeLicense(item.license ?? item.license_url),
    licenseRaw: item.license ?? item.license_url ?? null,
    durationSec: Number(item.durationSec ?? item.duration ?? 0) || null,
    bpm: Number(item.bpm ?? 0) || null,
    mood: item.mood ?? null,
    genre: item.genre ?? null,
    tags: Array.isArray(item.tags) ? item.tags : [],
    energyScore: Number.isFinite(item.energy) ? Number(item.energy) : null,
    instrumentation: Array.isArray(item.instrumentation) ? item.instrumentation : [],
    structure: item.structure ?? null,
    downloaded: false,
  }));
}

const SEARCHERS = {
  jamendo: searchJamendo,
  freesound: searchFreesound,
  mubert: searchMubert,
  "generic-http": searchGenericHttp,
};

/**
 * 按简报在**已配置**的在线源检索（在线优先的第一跳）。
 * @returns {Promise<{candidates:Array, attempts:Array}>}
 */
export async function searchOnline({ brief, recipe, limit = 8, env = process.env, fetchImpl = fetch, sources = null, catalog = null }) {
  const configured = listSources(env).filter((entry) => entry.configured);
  const wanted = sources?.length ? configured.filter((entry) => sources.includes(entry.name)) : configured;
  const attempts = [];
  const candidates = [];
  for (const entry of wanted) {
    try {
      const found = await SEARCHERS[entry.name]({ brief, recipe, limit, env, fetchImpl, catalog });
      const usable = found.filter((item) => item.url);
      attempts.push({ source: entry.name, status: "ok", found: found.length, downloadable: usable.length });
      candidates.push(...usable);
    } catch (error) {
      attempts.push({
        source: entry.name,
        status: error instanceof MeasureError ? error.code : "error",
        message: error instanceof Error ? error.message.slice(0, 200) : String(error),
      });
    }
  }
  if (!configured.length) {
    attempts.push({ source: "-", status: "not_configured", message: "没有任何在线源被配置（见 listSources）" });
  }
  return { candidates, attempts, configuredSources: configured.map((entry) => entry.name) };
}

/** 下载候选并写许可/归属信息（返回可交给 mix 的曲目对象）。 */
export async function fetchCandidate({ candidate, destDir, env = process.env, fetchImpl = fetch }) {
  if (!candidate?.url) throw new MeasureError(`候选 ${candidate?.id ?? "?"} 没有可下载地址`, "bad_response");
  const dir = destDir ?? cacheDir(env);
  const ext = (() => {
    const match = /\.(mp3|wav|m4a|aac|ogg|flac)(?:$|\?)/i.exec(String(candidate.url));
    return match ? `.${match[1].toLowerCase()}` : ".mp3";
  })();
  const file = path.join(dir, candidate.source, `${candidate.id}${ext}`);
  if (fs.existsSync(file)) {
    const stat = await fsp.stat(file);
    if (stat.size > 0) {
      return {
        ...candidate,
        localPath: file,
        bytes: stat.size,
        sha256: await sha256File(file),
        cached: true,
        downloaded: false,
      };
    }
  }
  const result = await downloadToFile(candidate.url, file, { fetchImpl });
  return { ...candidate, localPath: result.path, bytes: result.bytes, sha256: result.sha256, cached: false, downloaded: true };
}
