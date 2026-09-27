/**
 * ai-video × 配音工位 bridge 内核（core.mjs）
 *
 * 定位：把「本地声音克隆 + TTS 播报 + 视频配音」做成可审计的确定性工具层——
 * 声纹与参考音频**只留在工位本机**，工位本地执行，零云端依赖
 * （node 内置模块 + 工位本地 ffmpeg/ffprobe + 工位本地 TTS/ASR 引擎）。
 *
 * 引擎口径（同一套工具面，可换引擎）：
 * - `mlx`    ：Apple Silicon 本机引擎（mlx-audio，MIT），OpenAI 兼容 `/v1/audio/speech`
 *              + `/v1/audio/transcriptions`，支持 `ref_audio` / `ref_text` 直传（零样本克隆）；
 * - `openai` ：任意 OpenAI 兼容端点（VoiceStudio :3900 / GPT-SoVITS :9880 等），
 *              音色以 profile 的 `engine_voice_id` 引用，参考音频注入能力按引擎声明；
 * - `mock`   ：CI 与干跑用的确定性占位引擎（ffmpeg lavfi 合成，不含任何模型）。
 *
 * 纪律（与 bgm-bridge / color-bridge 同构）：
 * - 原片只读：任何写入都落到新文件，覆盖原片或覆盖参考音频直接拒绝（overwrite_source_forbidden）；
 * - 路径监狱：只允许访问白名单根目录内的路径（WORKLOOM_VOICE_ALLOWED_ROOTS）；
 * - 无回执=未核实：产物必须给出 sha256 + 时长 + 响度/真峰值实测复检；
 * - 不伪造：引擎不可达/超时/解码失败一律抛带稳定 code 的 VoiceError，由上层决定重试或转人工；
 * - 声纹不出域：参考音频、音色档案与授权回执只写工位素材区，任何"上传声纹/导出档案"的调用一票否决；
 * - 授权优先：克隆前必须有明确的声音授权声明（`voicewrite.consent`），否则围栏 G-VOICE1 挂起人审。
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";

import {
  MeasureError, binaryVersion, detectVoiceBandSegments, measureLoudness, probeMedia,
  resolveBinaries, round, runBin, sha256File, tempDir,
} from "../bgm-bridge/measure.mjs";

/** 工位对外错误类型（与度量内核同源，统一 code 语义）。 */
export const VoiceError = MeasureError;

/* ============================ 工具面 ============================ */

/** 本连接器提供的工具面；不在表内的工具直接拒绝（与 bgm-bridge 同款白名单纪律）。 */
export const VOICE_TOOLS = [
  "voiceread.health",
  "voiceread.devices",
  "voiceread.voices",
  "voiceread.probe",
  "voicewrite.consent",
  "voicewrite.record",
  "voicewrite.register",
  "voicewrite.speak",
  "voicewrite.dub",
  "voicewrite.verify",
];

const TOOL_SET = new Set(VOICE_TOOLS);

export function isVoiceTool(name) {
  return TOOL_SET.has(name);
}

/** 可重试错误（网络/超时/引擎抖动）；其余为不可重试（参数、权限、许可、路径）。 */
export const VOICE_RETRYABLE_CODES = new Set([
  "network_error", "timeout", "ffmpeg_failed", "decode_failed", "engine_failed", "bad_response", "engine_busy",
]);

export const VOICE_NEVER_RETRY_CODES = new Set([
  "bad_request", "not_found", "not_provided", "not_configured", "path_not_allowed", "tenant_mismatch",
  "overwrite_source_forbidden", "disk_quota_exceeded", "ffmpeg_not_installed", "bad_media", "bad_reference",
  "ref_text_required", "mic_not_found", "mic_permission_denied", "platform_unsupported", "consent_required",
  "voiceprint_export_forbidden", "verify_failed", "segment_overflow", "no_speech", "quota_exceeded",
  "idempotency_conflict", "license_blocked",
]);

/* ============================ 路径监狱 ============================ */

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function realpathDeepest(target) {
  let current = path.resolve(target);
  const suffix = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    suffix.unshift(path.basename(current));
    current = parent;
  }
  const resolved = fs.existsSync(current) ? fs.realpathSync(current) : current;
  return suffix.length ? path.join(resolved, ...suffix) : resolved;
}

/** 工位目录：音色档案、授权回执、产物与任务台账都在这里，默认 ~/.workloom/voice-station。 */
export function stationDir(env = process.env) {
  return env.WORKLOOM_VOICE_STATION_DIR
    ? path.resolve(env.WORKLOOM_VOICE_STATION_DIR)
    : path.join(os.homedir(), ".workloom", "voice-station");
}

export function profilesDir(env = process.env) {
  return path.join(stationDir(env), "profiles");
}

export function jobsDir(env = process.env) {
  return path.join(stationDir(env), "jobs");
}

/**
 * 允许读写的根目录：工位目录 + 显式白名单（`WORKLOOM_VOICE_ALLOWED_ROOTS`，冒号分隔）。
 * 素材区（原片目录）由白名单显式放行；不在白名单内的路径一律拒绝。
 */
export function allowedRoots(env = process.env) {
  const explicit = (env.WORKLOOM_VOICE_ALLOWED_ROOTS ?? "")
    .split(":")
    .map((item) => item.trim())
    .filter(Boolean);
  // 工位目录 + 显式白名单 + 常见素材区；另加系统临时目录——分句合成/拼接/适配的中间产物都在
  // os.tmpdir() 下（每次调用结束即清理），不属于"用户素材"，但它必须能通过路径监狱。
  const roots = [
    stationDir(env),
    ...explicit,
    path.join(os.homedir(), "Movies"),
    path.join(os.homedir(), "Desktop"),
    os.tmpdir(),
  ];
  return roots.map((root) => realpathDeepest(root));
}

export function assertPathAllowed(target, roots = allowedRoots(), label = "path") {
  const resolved = realpathDeepest(target);
  if (!roots.some((root) => isInside(resolved, root))) {
    throw new VoiceError(
      `${label} 不在工位白名单内：${target}（白名单：${roots.join(" / ")}）`,
      "path_not_allowed",
    );
  }
  return resolved;
}

/** 原片只读：输出路径等于输入路径直接拒绝（并有围栏 G-VOICE2 一票否决）。 */
export function assertOutputWritable(input, output) {
  const from = realpathDeepest(input);
  const to = realpathDeepest(output);
  if (from === to) {
    throw new VoiceError("拒绝覆盖原片/参考音频：请给出新的输出路径", "overwrite_source_forbidden");
  }
  return to;
}

/* ============================ 引擎配置 ============================ */

export const ENGINE_KINDS = ["mlx", "openai", "mock"];

export const DEFAULT_TTS_MODEL = "mlx-community/OmniVoice-bf16";
export const DEFAULT_ASR_MODEL = "mlx-community/whisper-large-v3-turbo";

/**
 * 引擎配置：kind 决定协议细节，baseUrl 指向本机 sidecar（默认 127.0.0.1）。
 * `referenceInjection` = 该引擎是否支持在请求里直传参考音频（零样本克隆）。
 *  - mlx（mlx-audio server）：支持 `ref_audio` + `ref_text`；
 *  - openai（VoiceStudio / GPT-SoVITS 等）：音色以 engine_voice_id 引用，参考音频由引擎侧档案承载。
 */
export function engineConfig(env = process.env) {
  const kind = String(env.WORKLOOM_VOICE_ENGINE ?? "mlx").trim().toLowerCase();
  if (!ENGINE_KINDS.includes(kind)) {
    throw new VoiceError(`不支持的引擎类型：${kind}（可选 ${ENGINE_KINDS.join(" / ")}）`, "not_configured");
  }
  const fallbackUrl = kind === "mlx" ? "http://127.0.0.1:8099" : "http://127.0.0.1:3900";
  return {
    kind,
    baseUrl: String(env.WORKLOOM_VOICE_ENGINE_URL ?? fallbackUrl).replace(/\/+$/, ""),
    token: String(env.WORKLOOM_VOICE_ENGINE_TOKEN ?? "").trim(),
    ttsModel: String(env.WORKLOOM_VOICE_TTS_MODEL ?? DEFAULT_TTS_MODEL),
    asrModel: String(env.WORKLOOM_VOICE_ASR_MODEL ?? DEFAULT_ASR_MODEL),
    // ASR 语言固定为 zh：Whisper 的自动语种检测在中文短句上不稳定，且检测本身要多一次解码；
    // 参考音频与播报复核都是中文场景，显式指定更快更准。
    asrLanguage: String(env.WORKLOOM_VOICE_ASR_LANGUAGE ?? "zh"),
    language: String(env.WORKLOOM_VOICE_LANGUAGE ?? "Chinese"),
    referenceInjection: kind === "mlx",
    asr: kind !== "mock",
    // ASR 权重（whisper-large-v3-turbo ≈1.6GB）+ TTS 权重（OmniVoice ≈1.2GB）同时常驻会顶到
    // 8GB 统一内存的天花板（实测：8GB M3 上多段合成期间连接被对端关闭）。默认在 ≤16GB 机器上
    // 用完 ASR 即刻卸载，只留 TTS 常驻；内存富裕的机器可设 never 省下重复加载。
    unloadAsr: String(env.WORKLOOM_VOICE_UNLOAD_ASR ?? "auto"),
    requestRetries: Number(env.WORKLOOM_VOICE_REQUEST_RETRIES ?? 1),
    timeoutMs: Number(env.WORKLOOM_VOICE_ENGINE_TIMEOUT_MS ?? 900_000),
  };
}

/** 机器内存是否紧张（用于决定 ASR 卸载策略；读不到时按紧张处理，宁可多花加载时间也不冒险 OOM）。 */
export function lowMemoryHost({ totalBytes = os.totalmem() } = {}) {
  return totalBytes > 0 && totalBytes <= 16 * 1024 ** 3;
}

/** 是否需要在使用后卸载 ASR 模型。 */
export function shouldUnloadAsr(config, { totalBytes = os.totalmem() } = {}) {
  const policy = String(config.unloadAsr ?? "auto").toLowerCase();
  if (policy === "never" || policy === "false" || policy === "0") return false;
  if (policy === "always" || policy === "true" || policy === "1") return true;
  return lowMemoryHost({ totalBytes });
}

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

/**
 * 引擎 HTTP 调用：**直接用 node:http，而不是全局 fetch**。两个原因都是实测踩出来的：
 *
 * ① undici 的 `bodyTimeout` 默认 300 秒（fetch 的隐式硬上限）：本地大模型逐段合成时，单段耗时
 *    可能超过 5 分钟（8GB M3 上多段配音实测跨过 5 分钟），undici 会掐断响应体并报 `terminated`，
 *    而服务端其实还在正常生成——用 fetch 就永远修不掉这个"看起来像引擎崩溃"的假故障；
 * ② keep-alive 复用：合成分句之间有数十秒客户端处理（拼接/核验），uvicorn 按 keep-alive 超时
 *    关掉空闲连接；复用这条已关闭连接的请求会在发出前就失败。
 *
 * 本实现：每请求独立连接（connection: close）+ 绝对超时（从发起计时，不按 socket 空闲计时）+
 * 连接层错误重试一次。合成与转写都是输入的纯函数（同输入 → 同输出），重试不产生副作用；
 * 业务错误（HTTP 非 2xx）照原样抛出，不重试。
 */
function httpRequestRaw(urlString, { method = "GET", headers = {}, body = null, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlString);
    } catch (error) {
      reject(new VoiceError(`引擎地址不合法：${urlString}`, "not_configured"));
      return;
    }
    const mod = url.protocol === "https:" ? https : http;
    const request = mod.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method,
      headers: { connection: "close", ...headers },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
      response.on("error", reject);
    });
    const timer = setTimeout(() => {
      request.destroy(new VoiceError(`引擎请求超时（${Math.round(timeoutMs / 1000)}s）`, "timeout", true));
    }, timeoutMs);
    request.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.on("close", () => clearTimeout(timer));
    if (body) request.write(body);
    request.end();
  });
}

async function engineHttp(config, urlPath, options = {}) {
  const {
    method = "GET", headers = {}, body = null, fetchImpl = null,
    timeoutMs = config.timeoutMs, retries = Number(config.requestRetries ?? 1), label = "引擎",
  } = options;
  // 只有"测试注入的假 fetch"才走 fetch 通道；全局 fetch 会被显式忽略——它带 300s bodyTimeout，
  // 长合成必被掐断（实测：多段配音第 2 段起必失败，且服务端日志显示它其实成功返回了 200）。
  // callTool 的默认参数会把全局 fetch 透传进来，所以这里必须按身份判断，而不是按"是否传了 fetchImpl"。
  if (typeof fetchImpl === "function" && fetchImpl !== globalThis.fetch) {
    try {
      const response = await fetchImpl(`${config.baseUrl}${urlPath}`, {
        method,
        headers: { ...headers, connection: "close" },
        body: body ?? undefined,
      });
      return { status: response.status, headers: {}, body: Buffer.from(await response.arrayBuffer()) };
    } catch (error) {
      throw new VoiceError(
        `${label}不可达：${error instanceof Error ? error.message : String(error)}`,
        "network_error",
        true,
      );
    }
  }
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await httpRequestRaw(`${config.baseUrl}${urlPath}`, {
        method,
        headers: { ...(config.token ? { authorization: `Bearer ${config.token}` } : {}), ...headers },
        body,
        timeoutMs,
      });
    } catch (error) {
      lastError = error;
      if (error instanceof VoiceError) throw error;
      const message = error instanceof Error ? `${error.message} ${error.code ?? ""}` : String(error);
      const transient = /ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|other side closed|terminated|timeout/i.test(message);
      if (!transient || attempt === retries) {
        throw new VoiceError(`${label}不可达：${message.trim()}`, /timeout/i.test(message) ? "timeout" : "network_error", true);
      }
    }
  }
  throw new VoiceError(`${label}不可达：${lastError instanceof Error ? lastError.message : String(lastError)}`, "network_error", true);
}

/** 手搓 multipart（避免为 ASR 引入依赖；字段少、边界固定，够用且可测）。 */
export function buildMultipart(fields, file) {
  const boundary = `----workloomvoice${createHash("sha1").update(`${Date.now()}-${file.filename}`).digest("hex").slice(0, 16)}`;
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, "utf8"));
  }
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
    "utf8",
  ));
  parts.push(file.data);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function fetchJson(url, { token, timeoutMs = 15_000, fetchImpl = fetch } = {}) {
  const guard = withTimeout(timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: guard.signal,
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
    return { ok: response.ok, status: response.status, payload, text };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    throw new VoiceError(
      aborted ? `引擎请求超时：${url}` : `引擎不可达：${error instanceof Error ? error.message : String(error)}`,
      aborted ? "timeout" : "network_error",
      true,
    );
  } finally {
    guard.done();
  }
}

/** 引擎健康探针（不抛异常）：模型清单 + 可达性，供 voiceread.health 使用。 */
export async function probeEngine(config = engineConfig(), { fetchImpl = fetch } = {}) {
  if (config.kind === "mock") {
    return { reachable: true, kind: "mock", base_url: config.baseUrl, models: ["mock-tts"], note: "占位引擎：仅用于 CI 与干跑" };
  }
  try {
    const { ok, status, payload } = await fetchJson(`${config.baseUrl}/v1/models`, {
      token: config.token,
      timeoutMs: 8_000,
      fetchImpl,
    });
    const models = Array.isArray(payload?.data)
      ? payload.data.map((item) => item?.id).filter((id) => typeof id === "string")
      : [];
    return { reachable: ok, kind: config.kind, base_url: config.baseUrl, status, models };
  } catch (error) {
    return {
      reachable: false,
      kind: config.kind,
      base_url: config.baseUrl,
      error: error instanceof VoiceError ? error.code : "network_error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/* ============================ 合成与转写 ============================ */

/** 文本 → 语音：返回落盘音频的实测指标（时长/RTF/sha256）。 */
export async function synthesize(config, {
  text, outPath, refAudio = null, refText = null, engineVoiceId = null, language = null,
  speed = 1.0, instruct = null, bins = resolveBinaries(), fetchImpl = fetch,
} = {}) {
  const clean = String(text ?? "").trim();
  if (!clean) throw new VoiceError("合成文本为空", "bad_request");
  if (!outPath) throw new VoiceError("缺少输出路径", "bad_request");
  const out = assertPathAllowed(outPath, allowedRoots(), "output");
  await fsp.mkdir(path.dirname(out), { recursive: true });
  const started = Date.now();

  if (config.kind === "mock") {
    const seconds = Math.max(0.6, Math.min(30, clean.replace(/\s+/g, "").length * 0.18));
    await runBin(bins.ffmpeg, [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", `sine=frequency=196:duration=${round(seconds, 3)}:sample_rate=24000`,
      "-af", "volume=0.12,tremolo=f=6:d=0.6",
      "-ac", "1", "-ar", "24000", "-y", out,
    ], { label: "ffmpeg(mock-tts)" });
  } else {
    if (config.kind === "mlx" && !refAudio && !engineVoiceId) {
      // 引擎允许无参考音色的"设计声线"，但本工位的交付口径要求每个音色可追溯，
      // 因此这里只提示不改行为：调用方（岗位/围栏）决定是否接受无档案音色。
    }
    const body = {
      model: config.ttsModel,
      input: clean,
      response_format: "wav",
      speed,
      lang_code: language ?? config.language,
      ...(instruct ? { instruct } : {}),
      ...(engineVoiceId ? { voice: engineVoiceId } : {}),
      ...(config.referenceInjection && refAudio ? { ref_audio: refAudio } : {}),
      ...(config.referenceInjection && refText ? { ref_text: refText } : {}),
    };
    const response = await engineHttp(config, "/v1/audio/speech", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: Buffer.from(JSON.stringify(body), "utf8"),
      fetchImpl,
      label: "合成引擎",
    });
    if (response.status < 200 || response.status >= 300) {
      throw new VoiceError(
        `引擎合成失败（HTTP ${response.status}）：${response.body.toString("utf8").slice(0, 300)}`,
        "engine_failed",
        response.status >= 500,
      );
    }
    if (response.body.length < 128) throw new VoiceError("引擎返回的音频为空或过短", "bad_response", true);
    await fsp.writeFile(out, response.body);
  }

  const media = await probeMedia(out, { bins });
  const elapsedMs = Date.now() - started;
  return {
    path: out,
    engine: config.kind,
    model: config.ttsModel,
    durationSec: round(media.duration, 3),
    elapsedMs,
    rtf: media.duration > 0 ? round(elapsedMs / 1000 / media.duration, 3) : null,
    sha256: await sha256File(out),
    usedReference: Boolean(config.referenceInjection && refAudio),
    engineVoiceId: engineVoiceId ?? null,
  };
}

/**
 * 参考音频转写（克隆需要的 ref_text）；引擎不支持转写时如实返回 supported=false。
 * @param {ReturnType<typeof engineConfig>} config
 * @param {{input?:string, language?:string|null, context?:string|null, fetchImpl?:typeof fetch, bins?:ReturnType<typeof resolveBinaries>}} options
 */
export async function transcribe(config, { input, language = null, context = null, fetchImpl = fetch, bins = resolveBinaries() } = {}) {
  if (!input) throw new VoiceError("缺少待转写音频", "bad_request");
  if (!config.asr) {
    return { supported: false, text: null, note: "当前引擎未声明 ASR 能力（WORKLOOM_VOICE_ENGINE=mock）" };
  }
  /**
   * 转写前统一转成 **16kHz 单声道 WAV**（2026-09-25 真机修复）：
   * 事故现象——对 mp4/m4a 直接调 /v1/audio/transcriptions 会 **HTTP 500**，
   * 因为引擎（mlx-audio server，launchd 托管）在解码 AAC/M4A 时要依赖**它自己 PATH 里的 ffmpeg**，
   * 而 launchd 进程没有登录 shell 的 PATH → 引擎报 `ffmpeg not found!`。
   * 早先的实现还把 mp4 的字节按 `contentType: audio/wav` 硬标成 wav（字段与实际不符）。
   * 现在由桥在本地用**工位自己的 ffmpeg** 转好 WAV 再上传：既不依赖引擎的 PATH，也不再谎报类型。
   */
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), "workloom-asr-"));
  try {
    let audio;
    const wav = path.join(workDir, "asr-input.wav");
    try {
      await runBin(bins.ffmpeg, [
        "-hide_banner", "-loglevel", "error", "-y", "-i", input,
        "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav,
      ], { label: "ffmpeg(asr)" });
      audio = { bytes: await fsp.readFile(wav), name: "asr-input.wav" };
    } catch (error) {
      throw new VoiceError(
        `转写预处理失败（转 16kHz 单声道 WAV）：${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
        "engine_failed",
        true,
      );
    }
    const effectiveLanguage = language ?? config.asrLanguage ?? null;
    const multipart = buildMultipart(
      {
        model: config.asrModel,
        response_format: "json",
        ...(effectiveLanguage ? { language: effectiveLanguage } : {}),
        /** 预期台词仅作为热词上下文，实际匹配基于引擎返回的转写，不用原稿填补空转写。 */
        ...(context ? { context: String(context).slice(0, 400) } : {}),
      },
      { name: "file", filename: audio.name, contentType: "audio/wav", data: audio.bytes },
    );
    const response = await engineHttp(config, "/v1/audio/transcriptions", {
      method: "POST",
      headers: { "content-type": multipart.contentType },
      body: multipart.body,
      fetchImpl,
      timeoutMs: Math.min(config.timeoutMs, 600_000),
      label: "转写引擎",
    });
    const text = response.body.toString("utf8");
    if (response.status < 200 || response.status >= 300) {
      throw new VoiceError(`转写失败（HTTP ${response.status}）：${text.slice(0, 200)}`, "engine_failed", response.status >= 500);
    }
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new VoiceError("转写引擎返回非 JSON 响应，无法核实台词", "bad_response", true);
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)
      || (payload.text !== null && typeof payload.text !== "string")) {
      throw new VoiceError("转写引擎缺少有效的 text 字段，无法核实台词", "bad_response", true);
    }
    return {
      supported: true,
      text: typeof payload?.text === "string" ? payload.text.trim() : null,
      model: config.asrModel,
      language: effectiveLanguage,
      unloaded: await unloadModel(config, config.asrModel, { fetchImpl }),
    };
  } finally {
    // 网络异常、超时、非成功 HTTP 和正常返回都必须清理带用户声音的临时 WAV。
    await fsp.rm(workDir, { recursive: true, force: true });
  }
}

/**
 * 让引擎释放某个模型的常驻内存（mlx-audio: DELETE /v1/models?model_name=<id>）。
 * 失败不抛：卸载是内存优化，不是业务正确性条件；返回 {ok, reason} 供回执留痕。
 */
export async function unloadModel(config, modelName, { fetchImpl = fetch } = {}) {
  if (!modelName || config.kind === "mock") return { ok: false, reason: "not_applicable" };
  if (!shouldUnloadAsr(config)) return { ok: false, reason: "policy_keep_resident" };
  try {
    const response = await engineHttp(config, `/v1/models?model_name=${encodeURIComponent(modelName)}`, {
      method: "DELETE",
      fetchImpl,
      timeoutMs: 30_000,
      retries: 0,
      label: "卸载引擎",
    });
    if (response.status === 204) return { ok: true, model: modelName };
    return { ok: false, reason: `http_${response.status}` };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.name : "error" };
  }
}

/* ============================ 麦克风与录音 ============================ */

/** 采集进程输出（设备清单需要完整 stderr，runBin 只回尾部三行，故单独实现）。 */
async function captureProcess(bin, args, { timeoutMs = 30_000, label = "ffmpeg" } = {}) {
  return await new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve({ code: -1, stdout: "", stderr: "", spawnFailed: true });
      return;
    }
    const stdout = [];
    const stderr = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ code: -1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), timedOut: true });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout: "", stderr: "", spawnFailed: true });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), label });
    });
  });
}

/**
 * 本机音频输入设备清单（macOS AVFoundation）。
 * 非 macOS 平台如实返回 platform_unsupported —— 工位录音能力只在装了麦克风的 Mac 上成立。
 */
export async function listInputDevices({ bins = resolveBinaries(), env = process.env } = {}) {
  if (process.platform !== "darwin") {
    return {
      platform: process.platform,
      supported: false,
      devices: [],
      error: "platform_unsupported",
      note: "本工位录音走 macOS AVFoundation；Windows/Linux 需要各自平台的采集后端",
    };
  }
  const result = await captureProcess(bins.ffmpeg, [
    "-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", "",
  ], { timeoutMs: 20_000, label: "ffmpeg(list-devices)" });
  const devices = [];
  let inAudio = false;
  for (const line of result.stderr.split("\n")) {
    if (/AVFoundation audio devices:/.test(line)) {
      inAudio = true;
      continue;
    }
    if (/AVFoundation video devices:/.test(line)) {
      inAudio = false;
      continue;
    }
    if (!inAudio) continue;
    const match = /\[(\d+)\]\s+(.+?)\s*$/.exec(line);
    if (match) devices.push({ index: Number(match[1]), name: match[2] });
  }
  const configured = String(env.WORKLOOM_VOICE_MIC_DEVICE ?? "").trim();
  const byName = configured ? devices.find((device) => device.name === configured) : null;
  const byIndex = configured && /^\d+$/.test(configured)
    ? devices.find((device) => device.index === Number(configured))
    : null;
  const preferred = byName ?? byIndex ?? devices[0] ?? null;
  return {
    platform: "darwin",
    supported: devices.length > 0,
    devices: devices.map((device) => ({ ...device, default: preferred ? device.index === preferred.index : false })),
    configured: configured || null,
    default: preferred,
    note: devices.length === 0 ? "未发现音频输入设备：检查系统设置 → 隐私与安全性 → 麦克风授权" : null,
  };
}

/**
 * 本机麦克风录音 → 参考音频。
 * - 原始采集写 `out`；默认再做「静音裁剪 + 参考电平归一」得到 `<out 基名>.prepared.wav`；
 * - 质量门：时长 3–20s、语音活动占比 ≥0.35、信噪比 ≥8dB、无削波，不达标如实返回 gate 结果（不伪造 ok）。
 * - 采集后端：默认 ffmpeg(avfoundation)；设 `WORKLOOM_VOICE_RECORDER` 时改用该可执行文件
 *   （形如 `vrec --out <file> --seconds <n>`）。为什么需要：从"双击打开的应用"里调 ffmpeg 采集时，
 *   macOS 会把请求判给 ffmpeg 这个没有用途说明的普通二进制并**静默拒绝**（不弹权限框、录到数字静音），
 *   而应用包内的原生录音器会把权限请求归属到应用本身；因此 GUI 路径固定使用 recorder。
 */
export async function record(params = {}, { bins = resolveBinaries(), env = process.env } = {}) {
  const out = assertPathAllowed(params.out ?? path.join(stationDir(env), "captures", `mic-${Date.now()}.wav`), allowedRoots(env), "out");
  await fsp.mkdir(path.dirname(out), { recursive: true });
  const seconds = Math.max(1, Math.min(Number(params.seconds ?? 12), Number(env.WORKLOOM_VOICE_MAX_RECORD_SEC ?? 60)));
  const devices = await listInputDevices({ bins, env });
  if (!devices.supported) {
    throw new VoiceError(devices.note ?? "本机不可用录音设备", devices.error === "platform_unsupported" ? "platform_unsupported" : "mic_not_found");
  }
  const wanted = params.device ?? env.WORKLOOM_VOICE_MIC_DEVICE ?? null;
  const target = wanted === null || wanted === undefined || wanted === ""
    ? devices.default
    : devices.devices.find((device) => device.name === wanted)
      ?? devices.devices.find((device) => String(device.index) === String(wanted));
  if (!target) throw new VoiceError(`找不到麦克风设备：${wanted}`, "mic_not_found");

  const recorder = String(env.WORKLOOM_VOICE_RECORDER ?? "").trim();
  const useRecorder = recorder && fs.existsSync(recorder);
  const result = useRecorder
    ? await captureProcess(recorder, ["--out", out, "--seconds", String(seconds)], {
      timeoutMs: (seconds + 40) * 1000, label: "vrec(record)",
    })
    : await captureProcess(bins.ffmpeg, [
      "-hide_banner", "-loglevel", "error",
      "-f", "avfoundation", "-i", `:${target.index}`,
      "-t", String(seconds), "-ac", "1", "-ar", "24000", "-y", out,
    ], { timeoutMs: (seconds + 20) * 1000, label: "ffmpeg(record)" });
  if (result.code !== 0 || !fs.existsSync(out) || fs.statSync(out).size < 1024) {
    const denied = /Permission|not authorized|denied/i.test(result.stderr);
    throw new VoiceError(
      denied
        ? "麦克风权限被拒：请在 系统设置 → 隐私与安全性 → 麦克风 中授权运行本工位的程序"
        : `录音失败（退出码 ${result.code}）：${result.stderr.split("\n").filter(Boolean).slice(-2).join(" | ") || "无输出"}`,
      denied ? "mic_permission_denied" : "engine_failed",
    );
  }

  const media = await probeMedia(out, { bins });
  const activity = await detectVoiceBandSegments({
    input: out, duration: media.duration, noiseDb: Number(params.noise_db ?? -38), bins,
  });
  const raw = {
    path: out,
    seconds: round(media.duration, 3),
    activeRatio: activity.activeRatio,
    speechSegments: activity.segments.length,
    device: target,
  };

  const payload = { raw, prepared: null, gate: null };
  const shouldPrepare = params.prepare !== false;
  if (shouldPrepare && activity.segments.length > 0) {
    const first = activity.segments[0];
    const last = activity.segments[activity.segments.length - 1];
    const pad = Number(params.pad_sec ?? 0.15);
    const start = Math.max(0, round(first.start - pad, 3));
    const end = Math.min(media.duration, round(last.end + pad, 3));
    const prepared = assertPathAllowed(
      params.prepared_out ?? out.replace(/\.wav$/i, "") + ".prepared.wav",
      allowedRoots(env),
      "prepared_out",
    );
    await runBin(bins.ffmpeg, [
      "-hide_banner", "-loglevel", "error",
      "-ss", String(start), "-to", String(end), "-i", out,
      "-af", `highpass=f=80,lowpass=f=12000,loudnorm=I=-20:TP=-2:LRA=11`,
      "-ac", "1", "-ar", "24000", "-y", prepared,
    ], { label: "ffmpeg(prepare-reference)" });
    const preparedMedia = await probeMedia(prepared, { bins });
    const preparedLoudness = await measureLoudness(prepared, { bins, targetLufs: -20, truePeak: -2 });
    payload.prepared = {
      path: prepared,
      seconds: round(preparedMedia.duration, 3),
      trimmedFrom: { start, end },
      integratedLufs: preparedLoudness.integratedLufs,
      truePeakDbtp: preparedLoudness.truePeakDbtp,
      sha256: await sha256File(prepared),
    };
  }

  const reference = payload.prepared ?? payload.raw;
  const refActivity = await detectVoiceBandSegments({
    input: reference.path, duration: reference.seconds, noiseDb: Number(params.noise_db ?? -38), bins,
  });
  const gate = evaluateReferenceGate({
    seconds: reference.seconds,
    activeRatio: refActivity.activeRatio,
    truePeakDbtp: payload.prepared?.truePeakDbtp ?? null,
    minSeconds: Number(params.min_seconds ?? 3),
    maxSeconds: Number(params.max_seconds ?? 20),
    minActiveRatio: Number(params.min_active_ratio ?? 0.35),
    maxTruePeak: Number(params.max_true_peak ?? -0.3),
  });
  payload.gate = gate;
  payload.reference = reference.path;
  payload.sha256 = await sha256File(reference.path);
  return payload;
}

/** 参考音频质量门（纯函数，便于单测）。 */
export function evaluateReferenceGate({
  seconds, activeRatio, truePeakDbtp = null, minSeconds = 3, maxSeconds = 20,
  minActiveRatio = 0.35, maxTruePeak = -0.3,
} = {}) {
  const reasons = [];
  if (!Number.isFinite(seconds) || seconds < minSeconds) reasons.push(`too_short（${round(seconds ?? 0, 2)}s < ${minSeconds}s）`);
  if (Number.isFinite(seconds) && seconds > maxSeconds) reasons.push(`too_long（${round(seconds, 2)}s > ${maxSeconds}s）`);
  if (!Number.isFinite(activeRatio) || activeRatio < minActiveRatio) reasons.push(`no_speech（语音活动占比 ${round(activeRatio ?? 0, 2)} < ${minActiveRatio}）`);
  if (truePeakDbtp !== null && Number.isFinite(truePeakDbtp) && truePeakDbtp > maxTruePeak) {
    reasons.push(`clipping（真峰值 ${round(truePeakDbtp, 2)} dBTP > ${maxTruePeak}）`);
  }
  return {
    ok: reasons.length === 0,
    reasons,
    thresholds: { minSeconds, maxSeconds, minActiveRatio, maxTruePeak },
  };
}

/* ============================ 文本切分 ============================ */

export const SENTENCE_SPLIT_RE = /(?<=[。！？!?；;…])\s*/;

/** 长文本按句切分并合并到 maxChars 以内（播报/配音都走这一条，保证分句策略一致）。 */
export function chunkText(text, { maxChars = 300 } = {}) {
  const normalized = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];
  const rough = normalized.split(SENTENCE_SPLIT_RE).flatMap((line) => line.split("\n")).map((line) => line.trim()).filter(Boolean);
  const chunks = [];
  let current = "";
  for (const piece of rough) {
    if (!current) {
      current = piece;
    } else if ((current + piece).length <= maxChars) {
      current += piece;
    } else {
      chunks.push(current);
      current = piece;
    }
    while (current.length > maxChars) {
      chunks.push(current.slice(0, maxChars));
      current = current.slice(maxChars);
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/* ============================ 音色档案与授权 ============================ */

export function profileDir(profileId, env = process.env) {
  const safe = String(profileId ?? "").trim();
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(safe)) {
    throw new VoiceError(`音色 id 不合法（只允许字母数字 . _ -，≤64 字符）：${profileId}`, "bad_request");
  }
  return path.join(profilesDir(env), safe);
}

/**
 * 档案清单（带降级明细）：损坏档案不再"静默少一条"。
 * 返回 `{ profiles, skipped:[{profile_id, reason}] }`——调用方（health / voices）必须把 skipped 显示出来，
 * 否则"少了几个档案"在界面上看不出来（GAP-0011 静默降级）。
 */
export async function listProfilesDetailed(env = process.env) {
  const dir = profilesDir(env);
  if (!fs.existsSync(dir)) return { profiles: [], skipped: [] };
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const profiles = [];
  const skipped = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifest = path.join(dir, entry.name, "profile.json");
    if (!fs.existsSync(manifest)) continue;
    try {
      const parsed = JSON.parse(await fsp.readFile(manifest, "utf8"));
      const consentPath = path.join(dir, entry.name, "consent.json");
      const consent = fs.existsSync(consentPath) ? JSON.parse(await fsp.readFile(consentPath, "utf8")) : null;
      profiles.push({
        profile_id: entry.name,
        kind: parsed.kind ?? "cloned",
        speaker_label: parsed.speaker_label ?? null,
        reference_seconds: parsed.reference_seconds ?? null,
        has_transcript: Boolean(parsed.ref_text),
        engine_voice_id: parsed.engine_voice_id ?? null,
        created_at: parsed.created_at ?? null,
        consent: consent
          ? { declared: consent.declared === true, scope: consent.scope ?? null, expires_at: consent.expires_at ?? null }
          : { declared: false, scope: null, expires_at: null },
      });
    } catch (error) {
      // 档案损坏跳过，但**不静默**：把 id 与原因记进 skipped，由 health/voices 显式展示
      skipped.push({ profile_id: entry.name, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  profiles.sort((a, b) => String(a.profile_id).localeCompare(String(b.profile_id)));
  return { profiles, skipped };
}

export async function listProfiles(env = process.env) {
  return (await listProfilesDetailed(env)).profiles;
}

/** 授权声明（声音肖像权）：这是克隆的前置条件，写进档案目录并作为围栏 G-VOICE1 的判据。 */
export async function consent(params = {}, { env = process.env } = {}) {
  const id = String(params.profile ?? params.profile_id ?? "").trim();
  const dir = profileDir(id, env);
  await fsp.mkdir(dir, { recursive: true });
  const declared = params.declared !== false;
  const record = {
    profile_id: id,
    declared,
    speaker_type: String(params.speaker_type ?? "self"),
    scope: String(params.scope ?? "internal"),
    declared_by: params.declared_by ?? null,
    evidence: params.evidence ?? null,
    expires_at: params.expires_at ?? null,
    note: params.note ?? null,
    recorded_at: new Date().toISOString(),
  };
  const file = path.join(dir, "consent.json");
  await fsp.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return {
    result: { consent: record, consent_file: file },
    receipt: { synced: true, verified_at: record.recorded_at, sha256: await sha256File(file) },
  };
}

/** 注册音色档案：参考音频入库 + 可选自动转写 + 授权绑定。 */
export async function register(params = {}, { bins = resolveBinaries(), env = process.env, config = engineConfig(env), fetchImpl = fetch } = {}) {
  const id = String(params.profile ?? params.profile_id ?? "").trim();
  if (!id) throw new VoiceError("缺少音色 id（profile）", "bad_request");
  const dir = profileDir(id, env);
  const reference = assertPathAllowed(params.reference ?? "", allowedRoots(env), "reference");
  if (!fs.existsSync(reference)) throw new VoiceError(`参考音频不存在：${reference}`, "not_found");

  const media = await probeMedia(reference, { bins });
  const activity = await detectVoiceBandSegments({ input: reference, duration: media.duration, bins });
  const loudness = await measureLoudness(reference, { bins, targetLufs: -20, truePeak: -2 });
  const gate = evaluateReferenceGate({
    seconds: media.duration,
    activeRatio: activity.activeRatio,
    truePeakDbtp: loudness.truePeakDbtp,
    minSeconds: Number(params.min_seconds ?? 3),
    maxSeconds: Number(params.max_seconds ?? 20),
    minActiveRatio: Number(params.min_active_ratio ?? 0.3),
    maxTruePeak: Number(params.max_true_peak ?? -0.3),
  });
  if (!gate.ok && params.allow_low_quality !== true) {
    throw new VoiceError(`参考音频不达标：${gate.reasons.join("；")}`, "bad_reference");
  }

  let refText = typeof params.ref_text === "string" && params.ref_text.trim() ? params.ref_text.trim() : null;
  let transcriptSource = refText ? "provided" : null;
  if (!refText && params.auto_transcribe !== false) {
    const result = await transcribe(config, { input: reference, language: params.language ?? null, fetchImpl });
    refText = result.text;
    transcriptSource = result.supported ? "asr" : null;
  }
  if (!refText) {
    throw new VoiceError(
      "缺少参考音频转写（ref_text）：克隆质量依赖逐字转写；请显式提供，或让工位启用 ASR（WORKLOOM_VOICE_ENGINE=mlx）",
      "ref_text_required",
    );
  }

  await fsp.mkdir(dir, { recursive: true });
  const stored = path.join(dir, "reference.wav");
  if (realpathDeepest(reference) !== realpathDeepest(stored)) {
    await runBin(bins.ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-i", reference,
      "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", "-y", stored,
    ], { label: "ffmpeg(store-reference)" });
  }
  const refSha = await sha256File(stored);
  const manifest = {
    profile_id: id,
    kind: String(params.kind ?? "cloned"),
    speaker_label: params.speaker_label ?? null,
    engine_voice_id: params.engine_voice_id ?? null,
    ref_text: refText,
    transcript_source: transcriptSource,
    language: params.language ?? null,
    reference_seconds: round(media.duration, 3),
    reference_sha256: refSha,
    metrics: {
      activeRatio: activity.activeRatio,
      integratedLufs: loudness.integratedLufs,
      truePeakDbtp: loudness.truePeakDbtp,
      gate,
    },
    created_at: new Date().toISOString(),
  };
  const manifestPath = path.join(dir, "profile.json");
  const previous = fs.existsSync(manifestPath) ? JSON.parse(await fsp.readFile(manifestPath, "utf8")) : null;
  await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return {
    result: {
      profile_id: id,
      profile_dir: dir,
      reference: stored,
      reference_seconds: manifest.reference_seconds,
      transcript_source: transcriptSource,
      ref_text: refText,
      metrics: manifest.metrics,
      replay: previous?.reference_sha256 === refSha,
    },
    receipt: { synced: true, verified_at: manifest.created_at, sha256: refSha },
  };
}

/* ============================ 播报（speak） ============================ */

async function concatWithGaps(parts, gapMs, out, bins) {
  if (parts.length === 1) {
    await runBin(bins.ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", parts[0], "-c", "copy", "-y", out], { label: "ffmpeg(copy)" });
    return;
  }
  const dir = await tempDir("voice-concat-");
  try {
    const silent = path.join(dir, "gap.wav");
    await runBin(bins.ffmpeg, [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", `anullsrc=r=24000:cl=mono:d=${round(gapMs / 1000, 3)}`,
      "-c:a", "pcm_s16le", "-y", silent,
    ], { label: "ffmpeg(gap)" });
    const listFile = path.join(dir, "concat.txt");
    const lines = [];
    parts.forEach((part, index) => {
      lines.push(`file '${part.replace(/'/g, "'\\''")}'`);
      if (index < parts.length - 1) lines.push(`file '${silent.replace(/'/g, "'\\''")}'`);
    });
    await fsp.writeFile(listFile, `${lines.join("\n")}\n`, "utf8");
    await runBin(bins.ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listFile,
      "-c:a", "pcm_s16le", "-ar", "24000", "-ac", "1", "-y", out,
    ], { label: "ffmpeg(concat)" });
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

async function normalizeLoudness({ input, output, targetLufs, truePeak, bins }) {
  // 标准两遍法 loudnorm：先测量（input_i/input_tp/thresh/target_offset），再带测量值线性归一。
  // 为什么不用 volume+alimiter：实测（2026-09-23，M3）单遍 volume+alimiter 的真峰值仍会到
  // 0.02 dBTP（超过 -1.5 上限），因为 alimiter 的 attack 窗口压不住瞬态；两遍法 loudnorm 自带
  // 真峰值限制，再用 alimiter 兜底，才能既到响度目标又不削顶。
  const measured = await measureLoudness(input, { bins, targetLufs, truePeak });
  const raw = measured.raw ?? {};
  const linearLimit = round(Math.pow(10, truePeak / 20), 4);
  if (measured.integratedLufs === null || raw.input_i === undefined) {
    throw new VoiceError("响度归一失败：测量通道无有效读数（无法核验交付响度）", "engine_failed", true);
  }
  const chain = [
    `loudnorm=I=${targetLufs}:TP=${truePeak}:LRA=11`,
    `measured_I=${raw.input_i}:measured_TP=${raw.input_tp}:measured_LRA=${raw.input_lra}`,
    `measured_thresh=${raw.input_thresh}:offset=${raw.target_offset ?? 0}:linear=true:print_format=summary`,
  ].join(":");
  await runBin(bins.ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-i", input,
    "-af", `${chain},alimiter=limit=${linearLimit}:attack=5:release=50`,
    "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", "-y", output,
  ], { label: "ffmpeg(normalize)" });

  let after = await measureLoudness(output, { bins, targetLufs, truePeak });
  let appliedOffsetDb = round(targetLufs - measured.integratedLufs, 2);
  // 闭环校正响度：loudnorm 的线性模式在 16bit 量化 + 后续 alimiter 之后仍可能偏离目标
  // （实测：目标 -16，输出 -14.49，偏 +1.5dB）。按实测差值再走一次 volume，只走一次。
  if (after.integratedLufs !== null && Math.abs(after.integratedLufs - targetLufs) > 1.0) {
    const levelFix = round(targetLufs - after.integratedLufs, 2);
    await runBin(bins.ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-i", output,
      "-af", `volume=${levelFix}dB`,
      "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", "-y", `${output}.lvl.wav`,
    ], { label: "ffmpeg(normalize-level-fix)" });
    await fsp.rename(`${output}.lvl.wav`, output);
    after = await measureLoudness(output, { bins, targetLufs, truePeak });
    appliedOffsetDb = round(appliedOffsetDb + levelFix, 2);
  }
  // 兜底：若编码量化后真峰值仍越线，按超出量降一次电平并复测（只降一次，避免来回震荡）。
  if (after.truePeakDbtp !== null && after.truePeakDbtp > truePeak) {
    const correction = round(truePeak - after.truePeakDbtp - 0.3, 2);
    await runBin(bins.ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-i", output,
      "-af", `volume=${correction}dB`,
      "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", "-y", `${output}.fix.wav`,
    ], { label: "ffmpeg(normalize-fix)" });
    await fsp.rename(`${output}.fix.wav`, output);
    after = await measureLoudness(output, { bins, targetLufs, truePeak });
    appliedOffsetDb = round(appliedOffsetDb + correction, 2);
  }
  return { before: measured.integratedLufs, after: after.integratedLufs, truePeakDbtp: after.truePeakDbtp, appliedOffsetDb };
}

/** 播报：长文本分句 → 逐句合成 → 拼接 → 响度归一到交付口径 → 复检回执。 */
export async function speak(params = {}, { bins = resolveBinaries(), env = process.env, config = engineConfig(env), fetchImpl = fetch } = {}) {
  const textFile = typeof params.text_file === "string" && params.text_file ? params.text_file : null;
  const text = textFile
    ? (await fsp.readFile(assertPathAllowed(textFile, allowedRoots(env), "text_file"), "utf8")).trim()
    : String(params.text ?? "").trim();
  if (!text) throw new VoiceError("缺少待合成文本", "bad_request");
  const out = assertPathAllowed(params.out ?? path.join(stationDir(env), "deliveries", `speak-${Date.now()}.wav`), allowedRoots(env), "out");
  const targetLufs = Number(params.lufs ?? env.WORKLOOM_VOICE_BROADCAST_LUFS ?? -16);
  const truePeak = Number(params.true_peak ?? -1.5);
  const gapMs = Number(params.gap_ms ?? 180);
  const maxChars = Number(params.max_chunk_chars ?? 300);

  const profile = params.profile ? await loadProfile(String(params.profile), env) : null;
  const chunks = chunkText(text, { maxChars });
  if (chunks.length === 0) throw new VoiceError("文本切分后为空", "bad_request");

  // 内存预清场：先让引擎释放 ASR 权重，再开始逐句合成（8GB 机器上这是"能跑完"与"中途断连"的分界）。
  const freedAsr = await unloadModel(config, config.asrModel, { fetchImpl });
  const dir = await tempDir("voice-speak-");
  const started = Date.now();
  const parts = [];
  try {
    for (let index = 0; index < chunks.length; index += 1) {
      const partPath = path.join(dir, `part-${String(index).padStart(3, "0")}.wav`);
      await synthesize(config, {
        text: chunks[index],
        outPath: partPath,
        refAudio: config.referenceInjection ? profile?.reference ?? null : null,
        refText: config.referenceInjection ? profile?.ref_text ?? null : null,
        engineVoiceId: profile?.engine_voice_id ?? params.voice ?? null,
        language: params.language ?? profile?.language ?? null,
        speed: Number(params.speed ?? 1.0),
        instruct: params.instruct ?? null,
        bins,
        fetchImpl,
      });
      parts.push(partPath);
    }
    await fsp.mkdir(path.dirname(out), { recursive: true });
    const joined = path.join(dir, "joined.wav");
    await concatWithGaps(parts, gapMs, joined, bins);
    if (params.normalize === false) {
      await runBin(bins.ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", joined, "-c:a", "pcm_s16le", "-y", out], { label: "ffmpeg(copy)" });
    } else {
      await normalizeLoudness({ input: joined, output: out, targetLufs, truePeak, bins });
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }

  const media = await probeMedia(out, { bins });
  const loudness = await measureLoudness(out, { bins, targetLufs, truePeak });
  const elapsedMs = Date.now() - started;
  const clipped = loudness.truePeakDbtp !== null && loudness.truePeakDbtp > truePeak + 0.2;
  if (params.verify !== false && (clipped || !(media.duration > 0))) {
    throw new VoiceError(
      `播报产物复检未通过：真峰值 ${loudness.truePeakDbtp} dBTP（上限 ${truePeak}）/ 时长 ${media.duration}s`,
      "verify_failed",
    );
  }
  return {
    result: {
      out,
      profile: profile?.profile_id ?? null,
      engine: config.kind,
      model: config.ttsModel,
      chunks: chunks.length,
      duration_sec: round(media.duration, 3),
      lufs: loudness.integratedLufs,
      true_peak_dbtp: loudness.truePeakDbtp,
      elapsed_ms: elapsedMs,
      rtf: round(elapsedMs / 1000 / Math.max(media.duration, 0.001), 3),
      asr_unloaded_before_synthesis: freedAsr.ok,
      void_notice: profile ? null : "未绑定音色档案：本产物来自引擎内置声线，不构成任何人声克隆",
    },
    receipt: { synced: true, verified_at: new Date().toISOString(), sha256: await sha256File(out) },
  };
}

export async function loadProfile(profileId, env = process.env) {
  const dir = profileDir(profileId, env);
  const manifestPath = path.join(dir, "profile.json");
  if (!fs.existsSync(manifestPath)) throw new VoiceError(`音色档案不存在：${profileId}`, "not_found");
  const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
  const consentPath = path.join(dir, "consent.json");
  const consentRecord = fs.existsSync(consentPath) ? JSON.parse(await fsp.readFile(consentPath, "utf8")) : null;
  return {
    ...manifest,
    reference: path.join(dir, "reference.wav"),
    consent: consentRecord,
  };
}

/* ============================ 视频配音（dub） ============================ */

/** 时间轴片段解析：显式 segments 优先；否则按文本句数在时间轴上均分。 */
export function planSegments({ text, segments, durationSec, maxChars = 300 }) {
  if (Array.isArray(segments) && segments.length > 0) {
    const planned = segments.map((segment) => ({
      start: round(Number(segment.start ?? 0), 3),
      end: round(Number(segment.end ?? 0), 3),
      text: String(segment.text ?? "").trim(),
    }));
    for (const segment of planned) {
      if (!segment.text) throw new VoiceError("片段文本为空", "bad_request");
      if (!(segment.end > segment.start)) throw new VoiceError(`片段时窗非法：${segment.start} → ${segment.end}`, "bad_request");
    }
    return planned;
  }
  const chunks = chunkText(text ?? "", { maxChars });
  if (chunks.length === 0) throw new VoiceError("缺少配音文本或片段", "bad_request");
  if (!(durationSec > 0)) throw new VoiceError("缺少可用时长（duration_sec）", "bad_request");
  const weights = chunks.map((chunk) => Math.max(chunk.length, 1));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let cursor = 0;
  return chunks.map((chunk, index) => {
    const span = (weights[index] / total) * durationSec;
    const start = round(cursor, 3);
    const end = index === chunks.length - 1 ? round(durationSec, 3) : round(cursor + span, 3);
    cursor += span;
    return { start, end, text: chunk };
  });
}

/** 时窗适配：超出时窗用 atempo 压缩（限幅内），仍放不下则如实报 segment_overflow。 */
export function fitTempo({ audioSeconds, windowSeconds, maxSpeed = 1.25, minSpeed = 0.85 }) {
  if (!(windowSeconds > 0) || !(audioSeconds > 0)) return { tempo: 1, fits: true, overflowSec: 0 };
  const needed = audioSeconds / windowSeconds;
  if (needed <= 1.0) return { tempo: 1, fits: true, overflowSec: 0 };
  if (needed <= maxSpeed) return { tempo: round(needed, 4), fits: true, overflowSec: 0 };
  const best = Math.min(needed, maxSpeed);
  const remaining = audioSeconds / best - windowSeconds;
  return {
    tempo: round(Math.max(best, minSpeed), 4),
    fits: false,
    overflowSec: round(Math.max(0, remaining), 3),
  };
}

const DUB_POLICIES = ["keep-dialogue", "keep-all", "replace-bed", "music-only"];

/** 视频配音：逐段合成 → 时窗适配 → 铺到时间轴 → 与原声按策略混音 → 视频轨 copy 出片。 */
export async function dub(params = {}, { bins = resolveBinaries(), env = process.env, config = engineConfig(env), fetchImpl = fetch } = {}) {
  const video = assertPathAllowed(params.video ?? params.input ?? "", allowedRoots(env), "video");
  if (!fs.existsSync(video)) throw new VoiceError(`原片不存在：${video}`, "not_found");
  const out = assertOutputWritable(video, params.out ?? path.join(stationDir(env), "deliveries", `dub-${Date.now()}.mp4`));
  assertPathAllowed(out, allowedRoots(env), "out");

  const policy = String(params.policy ?? "keep-dialogue");
  if (!DUB_POLICIES.includes(policy)) {
    throw new VoiceError(`未知配音策略：${policy}（可选 ${DUB_POLICIES.join(" / ")}）`, "bad_request");
  }
  if (policy === "music-only" && params.allow_discard_original !== true) {
    throw new VoiceError("music-only 会丢弃原声（含人声）：必须显式 allow_discard_original=true", "bad_request");
  }

  const media = await probeAnyMedia(video, { bins });
  if (!media.video) throw new VoiceError("输入不含视频轨，配音工位只处理成片/素材视频", "bad_media");
  const segments = planSegments({
    text: params.text ?? params.script ?? "",
    segments: params.segments,
    durationSec: media.duration,
    maxChars: Number(params.max_chunk_chars ?? 300),
  });

  const profile = params.profile ? await loadProfile(String(params.profile), env) : null;
  const targetLufs = Number(params.lufs ?? env.WORKLOOM_VOICE_DUB_LUFS ?? -14);
  const truePeak = Number(params.true_peak ?? -1.0);
  const freedAsr = await unloadModel(config, config.asrModel, { fetchImpl });
  const dir = await tempDir("voice-dub-");
  const started = Date.now();
  const report = [];
  try {
    const voiceParts = [];
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      const rawPart = path.join(dir, `seg-${String(index).padStart(3, "0")}-raw.wav`);
      const fittedPart = path.join(dir, `seg-${String(index).padStart(3, "0")}.wav`);
      const synthesized = await synthesize(config, {
        text: segment.text,
        outPath: rawPart,
        refAudio: config.referenceInjection ? profile?.reference ?? null : null,
        refText: config.referenceInjection ? profile?.ref_text ?? null : null,
        engineVoiceId: profile?.engine_voice_id ?? params.voice ?? null,
        language: params.language ?? profile?.language ?? null,
        speed: Number(params.speed ?? 1.0),
        instruct: params.instruct ?? null,
        bins,
        fetchImpl,
      });
      const window = segment.end - segment.start;
      const fit = fitTempo({
        audioSeconds: synthesized.durationSec,
        windowSeconds: window,
        maxSpeed: Number(params.max_tempo ?? 1.25),
        minSpeed: Number(params.min_tempo ?? 0.85),
      });
      if (!fit.fits && params.allow_overflow !== true) {
        throw new VoiceError(
          `片段 ${index + 1} 超出时窗 ${fit.overflowSec}s（时窗 ${round(window, 2)}s / 语音 ${synthesized.durationSec}s）：请改写文案或允许溢出`,
          "segment_overflow",
        );
      }
      const args = ["-hide_banner", "-loglevel", "error", "-i", rawPart];
      if (fit.tempo !== 1) args.push("-af", `atempo=${fit.tempo}`);
      args.push("-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", "-y", fittedPart);
      await runBin(bins.ffmpeg, args, { label: "ffmpeg(fit)" });
      voiceParts.push({ path: fittedPart, startSec: segment.start, windowSec: window, tempo: fit.tempo, text: segment.text });
      report.push({
        index: index + 1,
        start: segment.start,
        end: segment.end,
        window_sec: round(window, 3),
        voice_sec: synthesized.durationSec,
        tempo: fit.tempo,
        rtf: synthesized.rtf,
        chars: segment.text.length,
      });
    }

    const voiceTrack = path.join(dir, "voice-track.wav");
    await buildVoiceTrack(voiceParts, media.duration, voiceTrack, bins);
    await fsp.mkdir(path.dirname(out), { recursive: true });
    await muxDub({
      video, voiceTrack, out, policy, media,
      originalGainDb: Number(params.original_gain_db ?? 0),
      duckDepthDb: Number(params.duck_db ?? (policy === "keep-all" ? 6 : 12)),
      voiceGainDb: Number(params.voice_gain_db ?? 0),
      targetLufs, truePeak, bins,
    });
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }

  const outMedia = await probeAnyMedia(out, { bins });
  let loudness = await measureLoudness(out, { bins, targetLufs, truePeak });
  // 响度闭环：画面外挂 audio 的 loudnorm 是单遍的，实测能偏到 -12.87（目标 -14）。超出 ±1.5 LUFS
  // 容差时按实测差值重挂一次音轨（视频轨仍然 copy，代价只是一次音频编码）。
  let loudnessFixDb = 0;
  if (loudness.integratedLufs !== null && Math.abs(loudness.integratedLufs - targetLufs) > 1.5) {
    loudnessFixDb = round(targetLufs - loudness.integratedLufs, 2);
    const fixedVideo = `${out}.lvl.mp4`;
    await runBin(bins.ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-i", out,
      "-map", "0:v:0", "-map", "0:a:0",
      "-c:v", "copy", "-af", `volume=${loudnessFixDb}dB`, "-c:a", "aac", "-b:a", "192k",
      "-movflags", "+faststart", "-y", fixedVideo,
    ], { label: "ffmpeg(dub-loudness-fix)", timeoutMs: 900_000 });
    await fsp.rename(fixedVideo, out);
    loudness = await measureLoudness(out, { bins, targetLufs, truePeak });
  }
  /**
   * 真峰值闭环（2026-09-25 真机）：单遍 loudnorm 只保证响度目标，**不管真峰值**。
   * 事故：SC-04 补旁白后 `verify` 直接判 `clipping（-0.69 dBTP）`——旁白与配乐 / 原声叠加时
   * 峰值可以比目标高 1dB 以上。音频超峰是交付硬伤（平台会削波），所以这里按实测差值再压一次：
   * 视频轨仍 copy，只重编一次音频；留 0.2dB 余量，避免 AAC 编码后再次越线。
   */
  let peakFixDb = 0;
  if (loudness.truePeakDbtp !== null && loudness.truePeakDbtp > truePeak) {
    peakFixDb = round(truePeak - 0.2 - loudness.truePeakDbtp, 2);
    const fixedPeakVideo = `${out}.peak.mp4`;
    await runBin(bins.ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-i", out,
      "-map", "0:v:0", "-map", "0:a:0",
      "-c:v", "copy", "-af", `volume=${peakFixDb}dB`, "-c:a", "aac", "-b:a", "192k",
      "-movflags", "+faststart", "-y", fixedPeakVideo,
    ], { label: "ffmpeg(dub-peak-fix)", timeoutMs: 900_000 });
    await fsp.rename(fixedPeakVideo, out);
    loudness = await measureLoudness(out, { bins, targetLufs, truePeak });
  }
  const driftSec = round(outMedia.duration - media.duration, 3);
  const syncOk = Math.abs(driftSec) <= Number(params.max_drift_sec ?? 0.25);
  if (params.verify !== false && !syncOk) {
    throw new VoiceError(`音画时长漂移 ${driftSec}s 超出容差（原片 ${media.duration}s / 成片 ${outMedia.duration}s）`, "verify_failed");
  }
  const elapsedMs = Date.now() - started;
  return {
    result: {
      out,
      video: media.path,
      policy,
      profile: profile?.profile_id ?? null,
      engine: config.kind,
      model: config.ttsModel,
      segments: report,
      original_duration_sec: round(media.duration, 3),
      out_duration_sec: round(outMedia.duration, 3),
      drift_sec: driftSec,
      lufs: loudness.integratedLufs,
      true_peak_dbtp: loudness.truePeakDbtp,
      loudness_fix_db: loudnessFixDb,
      peak_fix_db: peakFixDb,
      elapsed_ms: elapsedMs,
      rtf: round(elapsedMs / 1000 / Math.max(outMedia.duration, 0.001), 3),
      discarded_original: policy === "music-only" || policy === "replace-bed",
      asr_unloaded_before_synthesis: freedAsr.ok,
    },
    receipt: { synced: true, verified_at: new Date().toISOString(), sha256: await sha256File(out) },
  };
}

/** 铺时间轴：每段按起点 adelay 后叠加成一条配音轨。 */
async function buildVoiceTrack(parts, totalSec, out, bins) {
  const inputs = [];
  parts.forEach((part) => {
    inputs.push("-i", part.path);
  });
  const filters = parts.map((part, index) => {
    const delayMs = Math.max(0, Math.round(part.startSec * 1000));
    return `[${index}:a]adelay=${delayMs}|${delayMs},apad[a${index}]`;
  });
  const mixInputs = parts.map((_, index) => `[a${index}]`).join("");
  const filter = `${filters.join(";")};${mixInputs}amix=inputs=${parts.length}:duration=longest:normalize=0,atrim=0:${round(totalSec, 3)},asetpts=N/SR/TB[out]`;
  await runBin(bins.ffmpeg, [
    "-hide_banner", "-loglevel", "error", ...inputs,
    "-filter_complex", filter, "-map", "[out]",
    "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", "-y", out,
  ], { label: "ffmpeg(voice-track)", timeoutMs: 900_000 });
}

/** 混音出片：按策略处理原声（保留/让位/替换），视频轨一律 copy。 */
async function muxDub({
  video, voiceTrack, out, policy, media, originalGainDb, duckDepthDb, voiceGainDb, targetLufs, truePeak, bins,
}) {
  const hasOriginal = media.hasAudio && policy !== "replace-bed" && policy !== "music-only";
  const loudnessChain = `loudnorm=I=${targetLufs}:TP=${truePeak}:LRA=11`;
  // 增益一律用线性系数而不是 `0dB` 后缀：实测 `volume=0dB[voice]` 会被 ffmpeg 的滤镜参数解析
  // 当成取值的一部分，随后把 `[voice]` 读成"输入流说明符"，报 Invalid stream specifier（退出码 1）。
  const lin = (db) => round(Math.pow(10, Number(db ?? 0) / 20), 4);
  let filter;
  const args = ["-hide_banner", "-loglevel", "error", "-i", video, "-i", voiceTrack];
  if (hasOriginal) {
    const duckRatio = policy === "keep-all" ? 3 : 8;
    // 注意：同一个滤镜输出标签不能被消费两次（实测报 "Stream specifier 'voice' ... matches no streams"），
    // 因此配音轨要先 asplit 成两条：一条做侧链键，一条进混音。
    filter = [
      `[0:a]volume=${lin(originalGainDb)},aformat=sample_fmts=fltp:channel_layouts=stereo[orig]`,
      `[1:a]volume=${lin(voiceGainDb)},aformat=sample_fmts=fltp:channel_layouts=stereo,asplit=2[voice][voice_sc]`,
      `[orig][voice_sc]sidechaincompress=threshold=0.03:ratio=${duckRatio}:attack=20:release=400:makeup=1[ducked]`,
      `[ducked][voice]amix=inputs=2:duration=first:normalize=0[mixed]`,
      `[mixed]${loudnessChain}[aout]`,
    ].join(";");
  } else {
    filter = `[1:a]volume=${lin(voiceGainDb)},aformat=sample_fmts=fltp:channel_layouts=stereo,${loudnessChain}[aout]`;
  }
  args.push(
    "-filter_complex", filter, "-map", "0:v:0", "-map", "[aout]",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart", "-shortest", "-y", out,
  );
  await runBin(bins.ffmpeg, args, { label: "ffmpeg(dub-mux)", timeoutMs: 1_800_000 });
  void duckDepthDb;
}

/** 视频/音频通用探测（配音输入可能没有音轨，不能复用只认音轨的 probeMedia）。 */
export async function probeAnyMedia(input, { bins = resolveBinaries() } = {}) {
  const { stdout } = await runBin(bins.ffprobe, [
    "-v", "error", "-print_format", "json", "-show_format", "-show_streams", input,
  ], { label: "ffprobe", timeoutMs: 60_000 });
  let parsed;
  try {
    parsed = JSON.parse(stdout.toString("utf8"));
  } catch {
    throw new VoiceError("ffprobe 返回无法解析的 JSON", "bad_media");
  }
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const video = streams.find((stream) => stream.codec_type === "video") ?? null;
  const audio = streams.find((stream) => stream.codec_type === "audio") ?? null;
  const parseRate = (value) => {
    if (typeof value !== "string" || !value.includes("/")) return null;
    const [a, b] = value.split("/").map(Number);
    return b ? round(a / b, 3) : null;
  };
  return {
    path: input,
    duration: Number(parsed.format?.duration ?? audio?.duration ?? video?.duration ?? 0),
    sizeBytes: Number(parsed.format?.size ?? 0),
    hasAudio: Boolean(audio),
    video: video
      ? {
        codec: video.codec_name ?? null,
        width: Number(video.width ?? 0),
        height: Number(video.height ?? 0),
        fps: parseRate(video.r_frame_rate),
      }
      : null,
    audio: audio
      ? {
        codec: audio.codec_name ?? null,
        channels: Number(audio.channels ?? 0),
        sampleRate: Number(audio.sample_rate ?? 0),
      }
      : null,
  };
}

/* ============================ 核验（verify） ============================ */

/** 产物核验：物理测量 + 顺序敏感的台词回读；缺测不能通过，明确无台词才不适用。 */
export async function verify(params = {}, { bins = resolveBinaries(), env = process.env, config = engineConfig(env), fetchImpl = fetch } = {}) {
  if (typeof (params.input ?? params.path) !== "string" || !(params.input ?? params.path).trim()) {
    throw new VoiceError("缺少待核验产物 input", "bad_request");
  }
  if (params.expect_text !== undefined && typeof params.expect_text !== "string") {
    throw new VoiceError("expect_text 必须是字符串", "bad_request");
  }
  for (const key of ["speech_expected", "round_trip", "strict"]) {
    if (params[key] !== undefined && typeof params[key] !== "boolean") {
      throw new VoiceError(`${key} 必须是布尔值`, "bad_request");
    }
  }
  const expectedText = normalizedMatchText(params.expect_text);
  if (params.speech_expected === false && expectedText) {
    throw new VoiceError("speech_expected=false 与非空 expect_text 冲突", "bad_request");
  }
  for (const key of ["min_match_ratio", "min_active_ratio", "lufs", "true_peak"]) {
    const value = params[key];
    if (value !== undefined && (typeof value !== "number" && (typeof value !== "string" || !value.trim()))) {
      throw new VoiceError(`${key} 必须是数值`, "bad_request");
    }
  }
  const minMatchRatio = Number(params.min_match_ratio ?? 0.6);
  const minActiveRatio = params.min_active_ratio === undefined ? null : Number(params.min_active_ratio);
  const targetLufs = Number(params.lufs ?? -16);
  const truePeak = Number(params.true_peak ?? -1.0);
  if (!Number.isFinite(minMatchRatio) || minMatchRatio < 0 || minMatchRatio > 1
    || (minActiveRatio !== null && (!Number.isFinite(minActiveRatio) || minActiveRatio < 0 || minActiveRatio > 1))
    || !Number.isFinite(targetLufs) || !Number.isFinite(truePeak)) {
    throw new VoiceError("核验阈值必须为有限数值；文本匹配和活动占比须在 0–1 范围内", "bad_request");
  }
  const input = assertPathAllowed(params.input ?? params.path ?? "", allowedRoots(env), "input");
  if (!fs.existsSync(input)) throw new VoiceError(`产物不存在：${input}`, "not_found");
  const media = await probeAnyMedia(input, { bins });
  const loudness = await measureLoudness(input, { bins, targetLufs, truePeak });
  const activity = await detectVoiceBandSegments({ input, duration: media.duration, bins });
  const clipping = loudness.truePeakDbtp !== null && loudness.truePeakDbtp > truePeak + 0.2;

  let asr = null;
  let matchRatio = null;
  let asrError = null;
  let textMatchStatus = "unverified";
  const unverified = [];
  const failures = [];
  if (params.speech_expected === false) {
    textMatchStatus = "not_applicable";
  } else if (!expectedText) {
    unverified.push("expected_text_missing");
  } else if (params.round_trip === false) {
    unverified.push("asr_round_trip_disabled");
  } else if (!config.asr) {
    unverified.push("asr_not_supported");
  } else {
    try {
      const result = await transcribe(config, {
        input,
        language: params.language ?? null,
        context: params.context ?? params.expect_text ?? null,
        fetchImpl,
        bins,
      });
      asr = result.text;
      if (!result.supported || !normalizedMatchText(asr)) {
        unverified.push(result.supported ? "asr_empty_transcript" : "asr_not_supported");
      } else {
        matchRatio = textMatchRatio(params.expect_text, asr);
        textMatchStatus = matchRatio >= minMatchRatio ? "passed" : "failed";
        if (textMatchStatus === "failed") failures.push(`match_ratio ${matchRatio} < ${minMatchRatio}`);
      }
    } catch (error) {
      asrError = error instanceof VoiceError
        ? error
        : new VoiceError(`转写无法核实：${error instanceof Error ? error.message : String(error)}`, "engine_failed", true);
      unverified.push(`asr_error:${asrError.code}`);
    }
  }

  const checked = {
    duration_sec: round(media.duration, 3),
    lufs: loudness.integratedLufs,
    true_peak_dbtp: loudness.truePeakDbtp,
    lra: loudness.lra,
    active_ratio: activity.activeRatio,
    speech_segments: activity.segments.length,
    clipping,
    asr_text: asr,
    match_ratio: matchRatio,
    text_match_status: textMatchStatus,
    text_match_method: "normalized-codepoint-lcs/max-length",
    text_match_threshold: minMatchRatio,
    speech_expected: params.speech_expected ?? (expectedText ? true : null),
    asr_error: asrError ? { code: asrError.code, message: asrError.message, retryable: asrError.retryable } : null,
  };
  if (clipping) failures.push(`clipping（${loudness.truePeakDbtp} dBTP）`);
  if (!(media.duration > 0)) failures.push("zero_duration");
  for (const [name, value] of Object.entries({ duration_sec: media.duration, lufs: loudness.integratedLufs, true_peak_dbtp: loudness.truePeakDbtp, active_ratio: activity.activeRatio })) {
    if (!Number.isFinite(value)) unverified.push(`measurement_unavailable:${name}`);
  }
  if (minActiveRatio !== null && activity.activeRatio < minActiveRatio) {
    failures.push(`active_ratio ${activity.activeRatio} < ${minActiveRatio}`);
  }
  const status = failures.length ? "failed" : unverified.length ? "unverified" : "passed";
  if (status !== "passed" && params.strict !== false) {
    if (asrError) throw asrError;
    throw new VoiceError(`核验${status === "unverified" ? "未核实" : "未通过"}：${[...failures, ...unverified].join("；")}`, "verify_failed");
  }
  return {
    result: { input, ok: status === "passed", status, failures, unverified, checked, method: "ffmpeg-loudnorm+band-activity+asr" },
    receipt: { synced: status === "passed", verified_at: new Date().toISOString(), sha256: await sha256File(input) },
  };
}

function normalizedMatchText(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}\p{Cf}]/gu, "");
}

/** 最多计算 1600 万个 DP 单元；超出边界必须显式处理，不能退回忽略词序的字符袋。 */
export const TEXT_MATCH_MAX_CELLS = 16_000_000;

/** 顺序敏感字符 LCS / 较长文本长度；NFKC、忽略大小写/标点/空白，按 Unicode 码点计数。 */
export function textMatchRatio(expected, actual) {
  const expectedClean = normalizedMatchText(expected);
  const actualClean = normalizedMatchText(actual);
  if (expectedClean === actualClean) return 1;
  if (!expectedClean || !actualClean) return 0;
  let a = Array.from(expectedClean);
  let b = Array.from(actualClean);
  if (a.length * b.length > TEXT_MATCH_MAX_CELLS) {
    throw new VoiceError(`文本顺序核验超出计算上限（${a.length}×${b.length} > ${TEXT_MATCH_MAX_CELLS}），请按台词段核验`, "bad_request");
  }
  if (a.length < b.length) [a, b] = [b, a];
  const row = new Uint32Array(b.length + 1);
  for (const expectedChar of a) {
    let diagonal = 0;
    for (let index = 1; index <= b.length; index += 1) {
      const previous = row[index];
      row[index] = expectedChar === b[index - 1] ? diagonal + 1 : Math.max(row[index], row[index - 1]);
      diagonal = previous;
    }
  }
  return round(row[b.length] / a.length, 3);
}

/* ============================ 健康检查 ============================ */

export async function health({ bins = resolveBinaries(), env = process.env, config = engineConfig(env), fetchImpl = fetch } = {}) {
  const profilesSettled = await listProfilesDetailed(env)
    .then((result) => ({ ...result, error: null }))
    .catch((error) => ({ profiles: [], skipped: [], error: error instanceof Error ? error.message : String(error) }));
  const [ffmpeg, engine, devices, profiles] = await Promise.all([
    binaryVersion(bins.ffmpeg),
    probeEngine(config, { fetchImpl }),
    listInputDevices({ bins, env }).catch(() => ({ supported: false, devices: [], error: "network_error" })),
    Promise.resolve(profilesSettled.profiles),
  ]);
  const skipped = profilesSettled.skipped ?? [];
  const station = stationDir(env);
  return {
    service: "workloom-voice-bridge",
    version: "1.0.0",
    station,
    ffmpeg,
    ffprobe: await binaryVersion(bins.ffprobe),
    engine,
    mic: { supported: devices.supported, default: devices.default ?? null, device_count: devices.devices?.length ?? 0 },
    profiles: {
      count: profiles.length,
      ids: profiles.map((profile) => profile.profile_id),
      ...(skipped.length > 0 ? { skipped } : {}),
      ...(profilesSettled.error ? { error: profilesSettled.error } : {}),
    },
    licenses: {
      "mlx-audio": "MIT（Apple Silicon 本机引擎）",
      "mlx-community/OmniVoice-bf16": "见模型卡上游许可",
      "mlx-community/whisper-large-v3-turbo": "MIT（OpenAI Whisper 权重衍生）",
      voicestudio: "AGPL-3.0（可选 GUI 工位，内部使用）",
      "GPT-SoVITS": "MIT（中文克隆备选引擎）",
      "fish-speech": "Fish Audio Research License（研究用途，商用需授权，本机不支持）",
    },
  };
}

/* ============================ 工具分发 ============================ */

/** 稳定的 JSON（键排序）用于幂等键与请求哈希。 */
export function STABLE_JSON(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = sortValue(value[key]);
      return acc;
    }, {});
  }
  return value;
}

export function hashKey(text) {
  return createHash("sha256").update(String(text)).digest("hex").slice(0, 16);
}

export async function jobAppend(dir, record) {
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
  await fsp.appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
}

export async function callTool(name, params = {}, options = {}) {
  const { bins = resolveBinaries(), env = process.env, config = engineConfig(env), fetchImpl = fetch } = options;
  switch (name) {
    case "voiceread.health": {
      const info = await health({ bins, env, config, fetchImpl });
      return { result: info, receipt: { synced: true, verified_at: new Date().toISOString() } };
    }
    case "voiceread.devices": {
      const devices = await listInputDevices({ bins, env });
      return { result: devices, receipt: { synced: true, verified_at: new Date().toISOString() } };
    }
    case "voiceread.voices": {
      const profiles = await listProfiles(env);
      return { result: { count: profiles.length, profiles }, receipt: { synced: true, verified_at: new Date().toISOString() } };
    }
    case "voiceread.probe": {
      const media = await probeAnyMedia(params.input ?? params.path, { bins });
      return { result: media, receipt: { synced: true, verified_at: new Date().toISOString() } };
    }
    case "voicewrite.consent":
      return await consent(params, { env });
    case "voicewrite.record": {
      const recorded = await record(params, { bins, env });
      return {
        result: recorded,
        receipt: { synced: true, verified_at: new Date().toISOString(), sha256: recorded.sha256 },
      };
    }
    case "voicewrite.register":
      return await register(params, { bins, env, config, fetchImpl });
    case "voicewrite.speak":
      return await speak(params, { bins, env, config, fetchImpl });
    case "voicewrite.dub":
      return await dub(params, { bins, env, config, fetchImpl });
    case "voicewrite.verify":
      return await verify(params, { bins, env, config, fetchImpl });
    default:
      throw new VoiceError(`配音工位不提供工具 ${name}`, "not_provided");
  }
}
