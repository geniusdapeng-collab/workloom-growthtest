/**
 * 音色档案降级可见性回归（T-2026-0926-0113 / GAP-0011）
 *
 * 背景：`listProfiles` 曾把损坏档案静默跳过（只留 count 差异），`health()` 又把整表失败吞成空数组——
 * 结果是"档案少了/读不出来"在健康检查里看不出来。本组测试锁定两条纪律：
 *   ① 损坏档案必须带 id 与原因出现在 skipped 里；
 *   ② health() 必须把 skipped / error 原样透出（不静默）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const core = require_("./core.mjs") as {
  listProfilesDetailed: (env: Record<string, string | undefined>) => Promise<{
    profiles: Array<{ profile_id: string }>;
    skipped: Array<{ profile_id: string; reason: string }>;
  }>;
  health: (options: Record<string, unknown>) => Promise<{
    profiles: { count: number; ids: string[]; skipped?: Array<{ profile_id: string }>; error?: string };
  }>;
};

const stations: string[] = [];
const makeStation = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "wl-voice-station-"));
  stations.push(dir);
  mkdirSync(join(dir, "profiles"), { recursive: true });
  return dir;
};

afterAll(() => {
  for (const dir of stations) rmSync(dir, { recursive: true, force: true });
});

describe("音色档案 · 降级可见性", () => {
  it("损坏档案出现在 skipped（带 id 与原因），好档案照常列出", async () => {
    const station = makeStation();
    const good = join(station, "profiles", "zh-good-v1");
    mkdirSync(good, { recursive: true });
    writeFileSync(join(good, "profile.json"), JSON.stringify({ kind: "cloned", speaker_label: "小织" }), "utf8");
    const broken = join(station, "profiles", "zh-broken-v1");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, "profile.json"), "{ 这不是 JSON", "utf8");

    const result = await core.listProfilesDetailed({ WORKLOOM_VOICE_STATION_DIR: station });
    expect(result.profiles.map((p) => p.profile_id)).toEqual(["zh-good-v1"]);
    expect(result.skipped.map((s) => s.profile_id)).toEqual(["zh-broken-v1"]);
    expect(result.skipped[0]!.reason.length).toBeGreaterThan(0);
  });

  it("health() 透出 skipped（不把降级伪装成 0 个档案）", { timeout: 20_000 }, async () => {
    const station = makeStation();
    const broken = join(station, "profiles", "zh-broken-v1");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, "profile.json"), "not-json", "utf8");

    // 让健康检查保持**离线且快速**：二进制路径指向不存在的位置，引擎探测用必然失败的 fetch。
    const report = await core.health({
      env: { WORKLOOM_VOICE_STATION_DIR: station },
      bins: { ffmpeg: "/nonexistent/ffmpeg", ffprobe: "/nonexistent/ffprobe" },
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    expect(report.profiles.count).toBe(0);
    expect(report.profiles.skipped?.map((s) => s.profile_id)).toEqual(["zh-broken-v1"]);
  });
});
