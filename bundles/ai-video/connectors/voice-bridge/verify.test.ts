/** Actual FFmpeg/FFprobe media measurements; ASR content is explicitly controlled test data. */
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { engineConfig, textMatchRatio, TEXT_MATCH_MAX_CELLS, transcribe, verify } from "./core.mjs";
import { resolveBinaries, runBin } from "../bgm-bridge/measure.mjs";

const bins = resolveBinaries();
const mediaAvailable = [bins.ffmpeg, bins.ffprobe].every((bin) => spawnSync(bin, ["-version"], { timeout: 10_000 }).status === 0);
const config = { ...engineConfig({ WORKLOOM_VOICE_ENGINE: "openai", WORKLOOM_VOICE_UNLOAD_ASR: "never" }), timeoutMs: 100, requestRetries: 0 };
const text = "甲乙丙丁戊己";
const responseFor = (transcript: string | null) => vi.fn(async () => new Response(JSON.stringify({ text: transcript }), { status: 200 }));

describe("转写文本顺序判据", () => {
  it.each([
    ["你好，世界。", "你好世界", 1],
    ["一二三四", "一二四五", 0.75],
    ["ＡＢＣ１２３", "abc123", 1],
    ["CAFÉ", "cafe\u0301", 1],
    ["甲\u200b乙", "甲乙", 1],
    ["甲乙丙丁戊己", "己戊丁丙乙甲", 0.167],
    ["甲甲乙乙", "乙乙甲甲", 0.5],
    ["哈哈哈哈", "哈哈", 0.5],
    ["你好", "你好你好", 0.5],
    ["\u{20000}\u{20001}", "\u{20001}\u{20000}", 0.5],
    ["", "", 1], ["有内容", "", 0], ["", "有内容", 0],
  ] as const)("%s / %s = %s", (expected, actual, ratio) => {
    expect(textMatchRatio(expected, actual)).toBeCloseTo(ratio, 3);
    expect(textMatchRatio(actual, expected)).toBeCloseTo(ratio, 3);
  });
  it("计算上限以内保持精确 LCS，越界明确拒绝而不退回字符袋", () => {
    const side = Math.sqrt(TEXT_MATCH_MAX_CELLS);
    expect(textMatchRatio("甲".repeat(side), "乙".repeat(side))).toBe(0);
    expect(() => textMatchRatio("甲".repeat(side + 1), "乙".repeat(side + 1))).toThrow(/计算上限/);
  });
});

describe.skipIf(!mediaAvailable)("真实媒体测量与显式替身 ASR 的核验合同", () => {
  let station: string;
  let input: string;
  let silent: string;
  let clipped: string;
  let sourceHash: string;
  let env: Record<string, string>;
  beforeAll(async () => {
    station = mkdtempSync(join(tmpdir(), "voice-verify-contract-"));
    input = join(station, "中文 核验音轨.wav");
    silent = join(station, "silent.wav");
    clipped = join(station, "clipped.wav");
    env = { WORKLOOM_VOICE_STATION_DIR: station, WORKLOOM_VOICE_ALLOWED_ROOTS: station };
    await runBin(bins.ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1.2:sample_rate=24000", "-af", "volume=0.5", "-ac", "1", "-y", input]);
    await runBin(bins.ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono", "-t", "1.2", "-y", silent]);
    await runBin(bins.ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1.2:sample_rate=24000", "-af", "volume=8", "-ac", "1", "-y", clipped]);
    sourceHash = createHash("sha256").update(readFileSync(input)).digest("hex");
  }, 30_000);
  afterAll(() => { if (station) rmSync(station, { recursive: true, force: true }); });
  const check = (params: Record<string, unknown> = {}, options: Record<string, unknown> = {}) => verify(
    { input, expect_text: text, strict: false, ...params },
    { bins, env, config, fetchImpl: responseFor(text), ...options },
  );

  it("匹配的实际回读返回 passed，保留测量、阈值与源文件哈希", async () => {
    const fetchImpl = responseFor(text);
    const result = await check({}, { fetchImpl });
    expect(result.result).toMatchObject({ ok: true, status: "passed", failures: [], unverified: [] });
    expect(result.result.checked).toMatchObject({ text_match_status: "passed", match_ratio: 1, asr_text: text, speech_expected: true, asr_error: null, text_match_threshold: 0.6, text_match_method: "normalized-codepoint-lcs/max-length" });
    expect(result.result.checked.duration_sec).toBeGreaterThan(1);
    expect(Number.isFinite(result.result.checked.lufs)).toBe(true);
    expect(Number.isFinite(result.result.checked.true_peak_dbtp)).toBe(true);
    expect(result.receipt).toMatchObject({ synced: true, sha256: sourceHash });
    expect(createHash("sha256").update(readFileSync(input)).digest("hex")).toBe(sourceHash);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("同一字符反序不合格；strict=true 拒绝而 strict=false 保留失败证据", async () => {
    const options = { fetchImpl: responseFor("己戊丁丙乙甲") };
    const report = await check({}, options);
    expect(report.result).toMatchObject({ ok: false, status: "failed" });
    expect(report.result.checked).toMatchObject({ text_match_status: "failed", match_ratio: 0.167 });
    expect(report.result.failures.join()).toContain("match_ratio");
    expect(report.receipt.synced).toBe(false);
    await expect(check({ strict: true }, options)).rejects.toMatchObject({ code: "verify_failed", retryable: false });
  });

  it.each([
    { params: { round_trip: false }, options: {}, reason: "asr_round_trip_disabled" },
    { params: {}, options: { config: { ...config, asr: false } }, reason: "asr_not_supported" },
    { params: { expect_text: undefined }, options: {}, reason: "expected_text_missing" },
    { params: { expect_text: "  ，。 " }, options: {}, reason: "expected_text_missing" },
  ])("$reason 不调用 ASR、不批准缺测", async ({ params, options, reason }) => {
    const fetchImpl = responseFor(text);
    const report = await check(params, { ...options, fetchImpl });
    expect(report.result).toMatchObject({ ok: false, status: "unverified" });
    expect(report.result.checked).toMatchObject({ text_match_status: "unverified", match_ratio: null });
    expect(report.result.unverified).toContain(reason);
    expect(report.receipt.synced).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(check({ ...params, strict: true }, { ...options, fetchImpl })).rejects.toMatchObject({ code: "verify_failed" });
  });

  it.each(["", " ， 。 ", null])("空转写 %s 是 unverified，不当作没有人声或通过", async (transcript) => {
    const report = await check({}, { fetchImpl: responseFor(transcript) });
    expect(report.result.status).toBe("unverified");
    expect(report.result.checked.match_ratio).toBeNull();
    expect(report.result.checked.text_match_status).toBe("unverified");
    expect(report.result.unverified).toContain("asr_empty_transcript");
    expect(report.receipt.synced).toBe(false);
  });

  it("明确无台词才 text_match_status=not_applicable；非空原稿与声明冲突拒绝", async () => {
    const fetchImpl = responseFor(text);
    const report = await check({ expect_text: undefined, speech_expected: false, strict: true }, { fetchImpl });
    expect(report.result).toMatchObject({ ok: true, status: "passed" });
    expect(report.result.checked).toMatchObject({ text_match_status: "not_applicable", speech_expected: false, match_ratio: null, asr_text: null });
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(check({ speech_expected: false })).rejects.toMatchObject({ code: "bad_request" });
  });

  it.each([
    { code: "network_error", fetchImpl: async () => { throw new Error("ECONNREFUSED test transport"); } },
    { code: "engine_failed", fetchImpl: async () => new Response("test engine failure", { status: 503 }) },
    { code: "bad_response", fetchImpl: async () => new Response(text, { status: 200 }) },
    { code: "bad_response", fetchImpl: async () => new Response(JSON.stringify({ message: "no transcript" }), { status: 200 }) },
    { code: "bad_response", fetchImpl: async () => new Response(JSON.stringify({ text: [text] }), { status: 200 }) },
  ])("$code 留结构化 unverified 并清理临时 WAV；strict 保留重试分类", async ({ code, fetchImpl }) => {
    const created = vi.spyOn(fsp, "mkdtemp");
    try {
      const report = await check({}, { fetchImpl });
      expect(report.result).toMatchObject({ ok: false, status: "unverified" });
      expect(report.result.checked.asr_error).toMatchObject({ code, retryable: true });
      expect(report.receipt.synced).toBe(false);
      await expect(check({ strict: true }, { fetchImpl })).rejects.toMatchObject({ code, retryable: true });
      const paths = await Promise.all(created.mock.results.filter((entry) => entry.type === "return").map((entry) => entry.value));
      expect(paths.length).toBeGreaterThanOrEqual(2);
      for (const path of paths) expect(existsSync(String(path))).toBe(false);
    } finally { created.mockRestore(); }
  });

  it("台词通过但音量削波保留独立文本状态，不能当成没有人声", async () => {
    const report = await check({ input: clipped });
    expect(report.result).toMatchObject({ ok: false, status: "failed", unverified: [] });
    expect(report.result.checked).toMatchObject({ text_match_status: "passed", match_ratio: 1, clipping: true, asr_error: null });
    expect(report.result.failures.join()).toContain("clipping");
    expect(report.receipt.synced).toBe(false);
  });

  it("并发转写使用独立临时文件，成功与失败都清理且不相互改写", async () => {
    const created = vi.spyOn(fsp, "mkdtemp");
    try {
      const reports = await Promise.all([
        check({}, { fetchImpl: responseFor(text) }),
        check({}, { fetchImpl: responseFor("己戊丁丙乙甲") }),
      ]);
      expect(reports.map((report) => report.result.status)).toEqual(["passed", "failed"]);
      const paths = await Promise.all(created.mock.results.filter((entry) => entry.type === "return").map((entry) => entry.value));
      expect(new Set(paths).size).toBe(2);
      for (const path of paths) expect(existsSync(String(path))).toBe(false);
      expect(createHash("sha256").update(readFileSync(input)).digest("hex")).toBe(sourceHash);
    } finally { created.mockRestore(); }
  });

  it("本地 HTTP 成功回读上传实际 WAV，收到的转写才进入比较", async () => {
    const requests: Buffer[] = [];
    const server = createServer((request, response) => {
      request.on("data", (chunk) => requests.push(Buffer.from(chunk)));
      request.on("end", () => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ text: "己戊丁丙乙甲" })); });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing local test port");
    try {
      const report = await check({}, { config: { ...config, baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 5_000 }, fetchImpl: globalThis.fetch });
      expect(report.result.status).toBe("failed");
      expect(report.result.checked.asr_text).toBe("己戊丁丙乙甲");
      const requestBody = Buffer.concat(requests).toString("latin1");
      expect(requestBody).toContain('filename="asr-input.wav"');
      expect(requestBody).toContain("RIFF");
      expect(requestBody).toContain("WAVE");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("真实本地 HTTP 超时仍为 unverified，并删除转写临时文件", async () => {
    const server = createServer((_request, _response) => { /* Deliberately never reply: exercise the real HTTP timeout. */ });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing local test port");
    const created = vi.spyOn(fsp, "mkdtemp");
    try {
      const report = await check({}, { config: { ...config, baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 25 }, fetchImpl: globalThis.fetch });
      expect(report.result.status).toBe("unverified");
      expect(report.result.checked.asr_error).toMatchObject({ code: "timeout", retryable: true });
      const paths = await Promise.all(created.mock.results.filter((entry) => entry.type === "return").map((entry) => entry.value));
      expect(paths).toHaveLength(1);
      expect(existsSync(String(paths[0]))).toBe(false);
    } finally {
      created.mockRestore(); server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("转写预处理失败也清理临时目录，二进制注入沿调用链生效", async () => {
    const created = vi.spyOn(fsp, "mkdtemp");
    try {
      await expect(transcribe(config, { input, bins: { ...bins, ffmpeg: "/nonexistent/ffmpeg" } })).rejects.toMatchObject({ code: "engine_failed" });
      const paths = await Promise.all(created.mock.results.filter((entry) => entry.type === "return").map((entry) => entry.value));
      expect(paths).toHaveLength(1);
      expect(existsSync(String(paths[0]))).toBe(false);
    } finally { created.mockRestore(); }
  });

  it("静音音轨的缺失物理测量不能借无台词声明变成通过", async () => {
    const report = await check({ input: silent, expect_text: undefined, speech_expected: false });
    expect(report.result.checked.text_match_status).toBe("not_applicable");
    expect(report.result.status).toBe("unverified");
    expect(report.result.unverified.join()).toContain("measurement_unavailable");
    expect(report.receipt.synced).toBe(false);
  });

  it.each([
    { min_match_ratio: NaN }, { min_match_ratio: -0.1 }, { min_match_ratio: 1.1 },
    { min_match_ratio: false }, { min_match_ratio: "" }, { min_active_ratio: Infinity },
    { lufs: null }, { true_peak: "invalid" }, { round_trip: "false" }, { speech_expected: "false" },
    { expect_text: 1 }, { input: "" },
  ])("无效参数 %j 直接拒绝且不发转写请求", async (params) => {
    const fetchImpl = responseFor(text);
    await expect(check(params, { fetchImpl })).rejects.toMatchObject({ code: "bad_request" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("不存在文件与越界软链在解码和 ASR 前拒绝", async () => {
    const fetchImpl = responseFor(text);
    const link = join(station, "outside.wav");
    symlinkSync("/etc/hosts", link);
    await expect(check({ input: join(station, "missing.wav") }, { fetchImpl })).rejects.toMatchObject({ code: "not_found" });
    await expect(check({ input: link }, { fetchImpl })).rejects.toMatchObject({ code: "path_not_allowed" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("CLI 明确无台词与缺少原稿采用相同合同", () => {
    const cli = join(dirname(fileURLToPath(import.meta.url)), "cli.mjs");
    const runtimeEnv = { ...process.env, ...env, WORKLOOM_VOICE_ENGINE: "mock", FFMPEG_PATH: bins.ffmpeg, FFPROBE_PATH: bins.ffprobe };
    const run = (args: string[]) => spawnSync(process.execPath, [cli, "verify", "--in", input, ...args], { env: runtimeEnv, encoding: "utf8", timeout: 15_000 });
    const absent = run([]);
    expect(absent.status).toBe(3); expect(absent.stderr).toContain("expected_text_missing");
    const declared = run(["--no-speech-expected"]);
    expect(declared.status).toBe(0); expect(JSON.parse(declared.stdout).result.checked.text_match_status).toBe("not_applicable");
    const disabled = run(["--expect-text", text, "--no-strict"]);
    expect(disabled.status).toBe(0); expect(JSON.parse(disabled.stdout).result.status).toBe("unverified");
    expect(JSON.parse(disabled.stdout).receipt.synced).toBe(false);
    const malformed = run(["--no-speech-expected", "--min-match", "invalid"]);
    expect(malformed.status).toBe(3); expect(malformed.stderr).toContain("bad_request");
  }, 30_000);

  it("真实 HTTP 桥核验不缓存缺测或旧文件证据，恢复与内容变化必须重新测量", async () => {
    let unavailable = true;
    let transcriptions = 0;
    const asr = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        transcriptions += 1;
        response.writeHead(unavailable ? 503 : 200, { "content-type": "application/json" });
        response.end(unavailable ? JSON.stringify({ error: "test-unavailable" }) : JSON.stringify({ text }));
      });
    });
    await new Promise<void>((resolve, reject) => { asr.once("error", reject); asr.listen(0, "127.0.0.1", resolve); });
    const asrAddress = asr.address();
    if (!asrAddress || typeof asrAddress === "string") throw new Error("missing local ASR port");
    const reservation = createServer();
    await new Promise<void>((resolve, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", resolve); });
    const bridgeAddress = reservation.address();
    if (!bridgeAddress || typeof bridgeAddress === "string") throw new Error("missing local bridge port");
    await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
    const bridgeUrl = `http://127.0.0.1:${bridgeAddress.port}`;
    const bridge = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "server.mjs")], {
      env: {
        ...process.env, ...env,
        FFMPEG_PATH: bins.ffmpeg, FFPROBE_PATH: bins.ffprobe,
        WORKLOOM_VOICE_BRIDGE_PORT: String(bridgeAddress.port), WORKLOOM_VOICE_BRIDGE_HOST: "127.0.0.1",
        WORKLOOM_VOICE_BRIDGE_TOKEN: "test-only-verify-contract", WORKLOOM_VOICE_BRIDGE_TENANT: "test-only-tenant",
        WORKLOOM_VOICE_ENGINE: "openai", WORKLOOM_VOICE_UNLOAD_ASR: "never",
        WORKLOOM_VOICE_ENGINE_URL: `http://127.0.0.1:${asrAddress.port}`, WORKLOOM_VOICE_REQUEST_RETRIES: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let diagnostics = "";
    bridge.stdout.on("data", (chunk) => { diagnostics += String(chunk); });
    bridge.stderr.on("data", (chunk) => { diagnostics += String(chunk); });
    const exited = new Promise<void>((resolve) => bridge.once("exit", () => resolve()));
    try {
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try { ready = (await fetch(`${bridgeUrl}/tools`)).ok; } catch { ready = false; }
        if (ready) break;
        if (bridge.exitCode !== null) throw new Error(`test bridge exited: ${diagnostics}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(ready, diagnostics).toBe(true);
      const mutable = join(station, "same-path-different-content.wav");
      await fsp.copyFile(input, mutable);
      const invoke = async (tenant = "test-only-tenant", token = "test-only-verify-contract") => fetch(`${bridgeUrl}/action`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ tool: "voicewrite.verify", params: { tenant_id: tenant, input: mutable, expect_text: text, strict: false, idempotency_key: "test-only-reverify" } }),
      });
      expect((await invoke("wrong-tenant")).status).toBe(403);
      expect((await invoke("test-only-tenant", "wrong-token")).status).toBe(401);
      expect(transcriptions).toBe(0);
      const missing = await (await invoke()).json();
      expect(missing.result.status).toBe("unverified");
      expect(missing.receipt.synced).toBe(false);
      unavailable = false;
      const restored = await (await invoke()).json();
      expect(restored.result.status).toBe("passed");
      expect(restored.receipt.synced).toBe(true);
      expect(restored.receipt.sha256).toBe(sourceHash);
      await fsp.copyFile(clipped, mutable);
      const changed = await (await invoke()).json();
      expect(changed.result.status).toBe("failed");
      expect(changed.result.checked).toMatchObject({ text_match_status: "passed", clipping: true });
      expect(changed.receipt.synced).toBe(false);
      expect(changed.receipt.sha256).not.toBe(restored.receipt.sha256);
      expect(transcriptions).toBe(3);
    } finally {
      bridge.kill("SIGTERM"); await exited;
      asr.closeAllConnections();
      await new Promise<void>((resolve, reject) => asr.close((error) => error ? reject(error) : resolve()));
    }
  }, 20_000);
});
