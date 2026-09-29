/**
 * 在线曲源层真机测试：起一个**本地 mock 音乐站**（真实 HTTP），验证
 *   ① 在线优先：能检索、能下载、能落缓存（第二次调用命中缓存不重复下载）；
 *   ② 许可闸：NC 许可候选被拒收，绝不落盘；
 *   ③ 降级链：在线无合规候选 / 站点不可达 → 回退本地精选曲库，并如实记录 attempts；
 *   ④ 安全：非 http(s) 下载地址被拒。
 */
import { createServer } from "node:http";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { analyzePromptBrief } from "./brief.mjs";
import { resolveTrackForBrief } from "./core.mjs";
import { downloadToFile, listSources, normalizeLicense } from "./sources.mjs";

/** 一段 1 秒的静音 WAV（32 字节头 + 16 位 8kHz 单声道），够走完下载/缓存路径。 */
function silentWav() {
  const sampleRate = 8000;
  const samples = sampleRate;
  const dataBytes = samples * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

const workDir = mkdtempSync(join(tmpdir(), "bgm-online-"));
const audio = silentWav();
let mode: "mixed" | "nc-only" | "empty" = "mixed";

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/index") {
    // nc-only 模式**只**返回 NC 曲目（此前写成"去掉 NC"，导致该用例实际测的是合规曲目——夹具 bug）
    const tracks = mode === "empty"
      ? []
      : mode === "nc-only"
        ? [{
          id: "blocked-nc", title: "Night Drive", artist: "Mock Artist", license: "cc-by-nc-4.0",
          url: "/audio/blocked-nc.wav", durationSec: 180, bpm: 92, genre: "夜景 / 都市", mood: "戏剧现代",
          tags: ["night"], energy: 0.8,
        }]
        : [
          {
            id: "ok-by", title: "Warm Bed", artist: "Mock Artist", license: "cc-by-4.0",
            url: "/audio/ok-by.wav", durationSec: 60, bpm: 96, genre: "美食 / 餐饮", mood: "诱人温暖",
            tags: ["美食", "warm"], energy: 0.5,
          },
          {
            id: "blocked-nc", title: "Night Drive", artist: "Mock Artist", license: "cc-by-nc-4.0",
            url: "/audio/blocked-nc.wav", durationSec: 180, bpm: 92, genre: "夜景 / 都市", mood: "戏剧现代",
            tags: ["night"], energy: 0.8,
          },
        ];
    const body = JSON.stringify({ tracks });
    res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    res.end(body);
    return;
  }
  if (url.pathname.startsWith("/audio/")) {
    res.writeHead(200, { "content-type": "audio/wav", "content-length": audio.length });
    res.end(audio);
    return;
  }
  res.writeHead(404).end();
});

let port = 0;

describe("在线曲源层（真实 HTTP mock 音乐站）", () => {
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(workDir, { recursive: true, force: true });
  });

  const env = () => ({
    WORKLOOM_BGM_ONLINE_ENDPOINT: `http://127.0.0.1:${port}/index`,
    WORKLOOM_BGM_LIBRARY_DIR: join(workDir, "empty-library"),
  });

  it("许可归一：CC 系 URL / 免版税 / 未知分别落到白名单 key", () => {
    expect(normalizeLicense("http://creativecommons.org/licenses/by/4.0/")).toBe("cc-by-4.0");
    expect(normalizeLicense("https://creativecommons.org/publicdomain/zero/1.0/")).toBe("cc0-1.0");
    expect(normalizeLicense("http://creativecommons.org/licenses/by-nc/4.0/")).toBe("cc-by-nc-4.0");
    expect(normalizeLicense("royalty-free (Mubert API v3)")).toBe("royalty-free");
    expect(normalizeLicense("")).toBe("unknown");
  });

  it("未配置任何在线源时如实报告，而不是假装搜过", () => {
    const sources = listSources({});
    expect(sources.every((entry) => entry.configured === false)).toBe(true);
    expect(sources.find((entry) => entry.name === "jamendo")!.missingEnv).toContain("JAMENDO_CLIENT_ID");
  });

  it("在线优先：命中 CC BY 曲目 → 下载落盘 + sha256 + 缓存复用；NC 曲目被拒收", async () => {
    mode = "mixed";
    const cacheDir = join(workDir, "cache-ok");
    const brief = analyzePromptBrief({ promptText: "美食探店，温柔治愈，火锅特写", durationSec: 30 }).brief;
    const first = await resolveTrackForBrief({
      brief, recipe: { id: "food", genre: "美食 / 餐饮", bpm: 96 }, policy: "online-first",
      durationSec: 30, env: env(), destDir: cacheDir,
    });
    expect(first.layer).toBe("online");
    expect(first.track!.license).toBe("cc-by-4.0");
    expect(first.track!.localPath && existsSync(first.track!.localPath)).toBe(true);
    expect(first.track!.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.track!.cached).toBe(false);
    // NC 候选必须被拒收（attempts 里有 license_rejected）
    expect(first.attempts.some((attempt) => attempt.status === "license_rejected")).toBe(true);

    const second = await resolveTrackForBrief({
      brief, recipe: { id: "food", genre: "美食 / 餐饮", bpm: 96 }, policy: "online-first",
      durationSec: 30, env: env(), destDir: cacheDir,
    });
    expect(second.track!.cached).toBe(true);
    expect(statSync(second.track!.localPath!).size).toBeGreaterThan(44);
  });

  it("在线只有 NC 候选 → 拒收并回退本地曲库（降级链），attempts 如实记录", async () => {
    mode = "nc-only";
    const brief = analyzePromptBrief({ promptText: "夜景都市，霓虹车流，戏剧感", durationSec: 30 }).brief;
    const result = await resolveTrackForBrief({
      brief, recipe: { id: "night-city", genre: "夜景 / 都市", bpm: 92 }, policy: "online-first",
      durationSec: 30, env: env(), destDir: join(workDir, "cache-nc"),
    });
    // 随仓曲库已按产品要求清理：此时应如实降级（本地无匹配 → 自算作曲兜底），而不是假装命中
    expect(result.layer === "local" || result.fallbackToCompose === true).toBe(true);
    expect(result.attempts.some((attempt) => attempt.status === "no_compliant_match" || attempt.status === "license_rejected")).toBe(true);
    mode = "mixed";
  });

  it("在线站点不可达 → 回退本地曲库并记录网络错误（不抛异常、不伪造在线命中）", async () => {
    const brief = analyzePromptBrief({ promptText: "产品广告，快节奏卡点", durationSec: 20 }).brief;
    const result = await resolveTrackForBrief({
      brief, recipe: { id: "product-ad", genre: "产品广告", bpm: 112 }, policy: "online-first",
      durationSec: 20,
      env: { WORKLOOM_BGM_ONLINE_ENDPOINT: "http://127.0.0.1:9/index", WORKLOOM_BGM_LIBRARY_DIR: join(workDir, "empty-library") },
      destDir: join(workDir, "cache-down"),
    });
    expect(result.layer === "local" || result.fallbackToCompose === true).toBe(true);
    expect(result.degraded).toBe(true);
    expect(result.attempts.some((attempt) => attempt.layer === "online" && ["network_error", "timeout"].includes(String(attempt.status)))).toBe(true);
  });

  it("安全：非 http(s) 下载地址被拒绝", async () => {
    await expect(downloadToFile("file:///etc/passwd", join(workDir, "evil.bin"))).rejects.toThrow(/非 http/);
  });
});
