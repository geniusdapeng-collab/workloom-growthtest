/**
 * 曲库可见性回归（2026-09-24 真机缺陷）：
 *
 * 背景：`bgm-cli library` 走的是 `findTracks()`，而它早先只读**单目录** `library/bgm-library`；
 * 产品所有者的曲库落在 `~/.workloom-bgm/library`（工位本地）与 `library/bgm-library-curated`（随仓兜底），
 * 于是 CLI 恒报「曲库未接入（缺 tracks.json）」——库里 1000+ 首曲子，选曲入口却看不见，
 * 只能退回自算作曲（真机 VID-PJL01 配乐被迫用旧通路，产品所有者据此提出质疑）。
 *
 * 本测试用两个临时曲库根（客户自建 + 工位本地）验证：`findTracks` 必须**合并**多根，
 * 且按 trackId 取到的绝对路径要指向曲目真实所在的那个根目录。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findTracks, libraryRoots, loadAllLocalTracks } from "./core.mjs";

function writeLibrary(dir: string, tracks: Array<Record<string, unknown>>): void {
  mkdirSync(dir, { recursive: true });
  for (const track of tracks) {
    const file = String(track.file ?? `${track.id}.m4a`);
    writeFileSync(join(dir, file), Buffer.alloc(4096, 7));
  }
  writeFileSync(join(dir, "tracks.json"), `${JSON.stringify({ schemaVersion: "workloom.bgm-library/v1", tracks }, null, 2)}\n`, "utf8");
}

const track = (id: string, genre: string, mood: string, bpm: number) => ({
  id,
  title: id,
  genre,
  mood,
  bpm,
  durationSec: 90,
  license: "royalty-free",
  file: `${id}.m4a`,
});

describe("曲库多根合并（bgm-cli library 可见性）", () => {
  it("客户自建库 + 工位本地库同时可见，且路径指向各自根目录", () => {
    const root = mkdtempSync(join(tmpdir(), "wl-bgm-lib-"));
    const custom = join(root, "custom");
    const workbench = join(root, "workbench", "library");
    /**
     * 用**测试专属**的题材/情绪串，避免与随仓兜底曲库（`library/bgm-library-curated`，50 首）
     * 的既有标签撞车——那 50 首是 `libraryRoots()` 的固定成员，无法在测试里排除。
     */
    writeLibrary(custom, [track("calm-waters-01", "测试题材ALPHA", "测试情绪ALPHA", 60)]);
    writeLibrary(workbench, [track("travel-bed-02", "测试题材BETA", "测试情绪BETA", 96)]);
    const env = {
      ...process.env,
      WORKLOOM_BGM_LIBRARY_DIR: custom,
      WORKLOOM_BGM_HOME: join(root, "workbench"),
      WORKLOOM_BGM_DISCOVER: "0",
    };

    /** 根解析：两个根都在，且顺序是"客户自建优先" */
    const roots = libraryRoots(env).map((entry) => entry.kind);
    expect(roots).toContain("local-custom");
    expect(roots).toContain("local-workbench");
    expect(roots.indexOf("local-custom")).toBeLessThan(roots.indexOf("local-workbench"));

    /** 合并读取：两首都在（随仓兜底库同时在场，所以只断言"包含"） */
    const merged = loadAllLocalTracks(env);
    const ids = merged.tracks.map((t) => t.id);
    expect(ids).toContain("calm-waters-01");
    expect(ids).toContain("travel-bed-02");

    /** findTracks：合并后能按题材筛出工位本地那首（旧实现只读单目录 → 这里会是 0 条） */
    const found = findTracks({ genre: "测试题材BETA", commercialUse: true }, env);
    expect(found.matched).toBe(1);
    expect(found.items[0]!.id).toBe("travel-bed-02");
    expect(found.items[0]!.fileExists).toBe(true);
    expect(found.items[0]!.path).toBe(join(workbench, "travel-bed-02.m4a"));

    /** 按 id 点名曲目：要返回真实路径（--bgm-track 依赖它） */
    const byId = findTracks({ trackId: "calm-waters-01", commercialUse: true }, env);
    expect(byId.track?.id).toBe("calm-waters-01");
    expect(byId.track?.path).toBe(join(custom, "calm-waters-01.m4a"));

    /** 报告里要如实列出各根的曲目数（可见性可审计）：本次两个测试根各 1 首，随仓兜底库 50 首 */
    const presentCounts = (byId.sources ?? []).filter((s) => s.present).map((s) => s.tracks);
    expect(presentCounts).toContain(1);
    expect(presentCounts.filter((n) => n === 1)).toHaveLength(2);
    expect(presentCounts).toContain(50);
  });

  it("同名 id 以先出现的根为准（客户自建覆盖随仓/工位）", () => {
    const root = mkdtempSync(join(tmpdir(), "wl-bgm-lib-dup-"));
    const custom = join(root, "custom");
    const workbench = join(root, "workbench", "library");
    writeLibrary(custom, [track("same-id", "测试题材ALPHA", "测试情绪ALPHA", 60)]);
    writeLibrary(workbench, [track("same-id", "测试题材BETA", "测试情绪BETA", 120)]);
    const env = {
      ...process.env,
      WORKLOOM_BGM_LIBRARY_DIR: custom,
      WORKLOOM_BGM_HOME: join(root, "workbench"),
      WORKLOOM_BGM_DISCOVER: "0",
    };
    const merged = loadAllLocalTracks(env);
    const same = merged.tracks.filter((t) => t.id === "same-id");
    expect(same).toHaveLength(1);
    expect(same[0]!.genre).toBe("测试题材ALPHA");
    expect(same[0]!.libraryKind).toBe("local-custom");
  });
});
