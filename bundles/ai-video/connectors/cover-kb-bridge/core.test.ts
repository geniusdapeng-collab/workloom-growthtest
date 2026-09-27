/**
 * 封面知识库连接器回归（2026-09-27 平台化 + 知识库注入）
 *
 * 覆盖四件事：
 *   ① **全库可解析**：14 篇 / 每篇 §四 参数 + §六 映射齐全 / 索引无缺篇（缺篇必须显式报出）；
 *   ② **平台口径交叉核对**：KB §四 的数字与 `cover-platforms.ts` 一致（漂移即红）；
 *   ③ **注入纪律**：≤3 条、hint 与 trace 一一对应、矛盾闸以代码为准、未知平台退化为无 KB（不静默）；
 *   ④ **账号档案**：零依赖迷你解析器与仓库 `yaml` 包结果等价；hook_bias/fontId 越界只记 warning。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { parseAccountProfileYaml } from "./account-profile.mjs";
import {
  HOOK_FORMULA_IDS,
  PLATFORM_KB_IDS,
  crossCheckPlatformSpecs,
  enrichCoverHints,
  hookShortlist,
  inferTheme,
  kbStatus,
  listThemes,
  loadKb,
  normalizeAccountProfile,
  parsePlatformSpecsFromTs,
  platformParamsFromKb,
  platformProfile,
  recipe,
  searchKb
} from "./core.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../../../..");
const KB_DIR = resolve(here, "../../library/cover-kb");
const SPEC_TS = resolve(REPO_ROOT, "packages/video-studio/src/cover-platforms.ts");
const ACCOUNT_FILE = resolve(here, "../../library/account-profiles/chen-zhuo.yml");

const kb = loadKb(KB_DIR);
const specSource = readFileSync(SPEC_TS, "utf8");

describe("封面知识库：解析", () => {
  it("14 篇全部可解析，§四 参数与 §六 映射齐全，索引无缺篇/无未登记篇目", () => {
    const status = kbStatus(kb);
    expect(status.topics).toBe(14);
    expect(status.missingTopics).toEqual([]);
    expect(status.untrackedTopics).toEqual([]);
    expect(status.topicsWithEmptyMappings).toEqual([]);
    expect(status.topicsWithEmptyParams).toEqual([]);
    expect(status.duplicateIds).toEqual([]);
    expect(status.mappingRows).toBeGreaterThan(100);
    expect(status.paramRows).toBeGreaterThan(100);
    expect(status.ok).toBe(true);
  });

  it("八平台都有对应篇目（PLAT-001~006），且篇目里有安全区与画幅参数", () => {
    expect(Object.keys(PLATFORM_KB_IDS).sort()).toEqual(
      ["bilibili", "douyin", "instagram-reels", "kuaishou", "tiktok", "wechat-channels", "xiaohongshu", "youtube"]
    );
    for (const platformId of Object.keys(PLATFORM_KB_IDS)) {
      const profile = platformProfile(kb, platformId);
      expect(profile, `${platformId} 缺平台篇`).toBeTruthy();
      const keys = profile!.params.map((p: { key: string }) => p.key).join(" ");
      expect(keys, `${platformId} 缺画幅/安全区参数`).toContain("画幅");
      expect(keys).toContain("底部遮挡区");
      /** PLAT-006 是多平台矩阵表，同样要有标题带行（三列与代码规格一致） */
      expect(keys).toContain("标题带");
    }
  });

  it("PLAT-006 是多平台矩阵表：TikTok / YouTube / Instagram 三列互不串味", () => {
    const tiktok = platformParamsFromKb(kb, "tiktok")!;
    const youtube = platformParamsFromKb(kb, "youtube")!;
    const ig = platformParamsFromKb(kb, "instagram-reels")!;
    expect(tiktok.ratio!.ratio).toBe("9:16");
    expect(youtube.ratio!.ratio).toBe("16:9");
    expect(youtube.canvas!.size).toEqual({ width: 1920, height: 1080 });
    expect(tiktok.canvas!.size).toEqual({ width: 1080, height: 1920 });
    expect(ig.bottom!.percent).toBe(15);
    expect(youtube.bottom!.percent).toBe(8);
    expect(tiktok.bottom!.percent).toBe(17);
  });
});

describe("封面知识库：与代码规格交叉核对（矛盾闸）", () => {
  it("cover-platforms.ts 的 8 平台规格都能从 TS 文本解析出来", () => {
    const specs = parsePlatformSpecsFromTs(specSource);
    expect(Object.keys(specs).sort()).toEqual(
      ["bilibili", "douyin", "instagram-reels", "kuaishou", "tiktok", "wechat-channels", "xiaohongshu", "youtube"]
    );
    expect(specs.douyin!.bottom).toBeCloseTo(0.12, 5);
    expect(specs.xiaohongshu!.width).toBe(1080);
    expect(specs.xiaohongshu!.height).toBe(1440);
    expect(specs.bilibili!.language).toBe("zh");
    expect(specs.tiktok!.language).toBe("en");
  });

  it("KB §四 与代码规格零漂移（含 PLAT-006 的三列）", () => {
    const rows = crossCheckPlatformSpecs(kb, specSource);
    expect(rows.length).toBe(8);
    for (const row of rows) {
      expect(row.diffs, `${row.platformId}（${row.kbId}）漂移：${row.diffs.join("；")}`).toEqual([]);
    }
  });
});

describe("封面知识库：注入载荷", () => {
  const platformSpec = {
    id: "xiaohongshu",
    ratio: "3:4",
    canvas: { width: 1080, height: 1440 },
    safeArea: { topMinRatio: 0.07, bottomReservedRatio: 0.17, rightRailRatio: 0 },
    titleBand: { topRatio: 0.07, bottomMaxRatio: 0.45 },
    language: "zh",
    headlineMaxChars: 14
  };

  it("≤3 条、hint 与 trace 一一对应、平台条目必有", () => {
    const payload = enrichCoverHints(kb, {
      platformId: "xiaohongshu",
      spec: platformSpec,
      theme: "美食",
      accountType: "种草号",
      hookBias: ["value-preview", "contrast"]
    });
    expect(payload.fallback).toBe(false);
    expect(payload.source).toBe("code");
    expect(payload.hints.length).toBeLessThanOrEqual(3);
    expect(payload.hints.length).toBe(payload.trace.length);
    expect(payload.hints[0]).toContain("【封面知识库·PLAT-003§4】");
    expect(payload.hints[0]).toContain("1080×1440");
    expect(payload.trace[0]).toEqual({ kbId: "PLAT-003", section: "§4", reason: "platform=xiaohongshu" });
    for (const pick of payload.trace) expect(pick.kbId).toMatch(/^[A-Z]+-\d{3}/);
  });

  it("矛盾闸：代码规格与 KB 不一致时以代码为准并把差异写进 conflicts", () => {
    const payload = enrichCoverHints(kb, {
      platformId: "douyin",
      spec: { ...platformSpec, id: "douyin", ratio: "9:16", canvas: { width: 1080, height: 1920 }, safeArea: { topMinRatio: 0.06, bottomReservedRatio: 0.2, rightRailRatio: 0.11 }, titleBand: { topRatio: 0.06, bottomMaxRatio: 0.42 } }
    });
    expect(payload.conflicts.join(" ")).toContain("底部遮挡");
    expect(payload.hints[0]).toContain("20%"); // 提示词里带的是代码规格（20%），不是 KB 的 12%
  });

  it("未知平台退化为无注入（fallback=true，且如实说明），不抛错", () => {
    const payload = enrichCoverHints(kb, { platformId: "my-space" });
    expect(payload.fallback).toBe(true);
    expect(payload.hints).toEqual([]);
    expect(payload.notes.join(" ")).toContain("没有对应篇目");
  });

  it("题材未收录时不硬凑近似条目（如实报缺）", () => {
    const payload = enrichCoverHints(kb, { platformId: "douyin", theme: "荒野求生" });
    expect(payload.hints.some((h: string) => h.includes("THEME-001"))).toBe(false);
    expect(payload.notes.join(" ")).toContain("未收录题材");
  });

  it("账号钩子偏好过滤生效：只注入偏好内的公式", () => {
    const hooks = hookShortlist(kb, ["value-preview"]);
    expect(hooks.length).toBeGreaterThan(0);
    expect(hooks.every((h: { id: string }) => h.id === "value-preview")).toBe(true);
    const payload = enrichCoverHints(kb, { platformId: "bilibili", hookBias: ["curiosity-gap"] });
    const hookHint = payload.hints.find((h: string) => h.includes("HOOK-001"));
    expect(hookHint).toContain("curiosity-gap");
  });

  it("7 个钩子公式 ID 与 KB §四 表一致（不新增第八个公式）", () => {
    const rows = kb.byId["HOOK-001"].params.filter((p) => /^[a-z-]+$/.test(p.key)).map((p) => p.key);
    expect(new Set(rows)).toEqual(new Set(HOOK_FORMULA_IDS));
  });
});

describe("封面知识库：检索与配方", () => {
  it("意图检索能按关键词命中对应平台篇", () => {
    const hit = searchKb(kb, "小红书 3:4 封面", { top: 3 });
    expect(hit.hits[0]!.kbId).toBe("PLAT-003");
    const douyin = searchKb(kb, "抖音 大字钩子", { top: 3 });
    expect(douyin.hits.some((h: { kbId: string }) => h.kbId === "PLAT-001")).toBe(true);
  });

  it("组合配方给出平台参数 + 题材版式 + 钩子短名单", () => {
    const result = recipe(kb, { platform: "douyin", theme: "知识科普", accountType: "知识号" });
    expect(result.platform!.kbId).toBe("PLAT-001");
    expect(result.theme!.value).toContain("subject-led");
    expect(result.hooks.length).toBeGreaterThanOrEqual(4);
    expect(result.accountType).toBe("knowledge");
  });

  it("题材清单来自 THEME-001 参数表（含八大题材）", () => {
    const themes = listThemes(kb);
    for (const theme of ["知识科普", "美食", "旅行风光", "剧情", "带货", "Vlog", "测评", "母婴"]) {
      expect(themes.some((t: string) => t.startsWith(theme)), `缺题材 ${theme}（现有：${themes.join("/")}）`).toBe(true);
    }
  });

  it("题材启发式匹配（--theme 缺省时按片名/目标猜）", () => {
    expect(inferTheme(kb, "滕王阁城市人文旅行片")!.theme).toContain("旅行");
    expect(inferTheme(kb, "三款获客系统测评对比")!.theme).toContain("测评");
    /** 匹配不到题材时**如实返回 null**（此时 enrich 走钩子分支，不硬凑题材条目） */
    expect(inferTheme(kb, "AI 班组销售口播")).toBeNull();
    expect(inferTheme(kb, "")).toBeNull();
  });
});

describe("账号档案：解析与归一", () => {
  const text = readFileSync(ACCOUNT_FILE, "utf8");

  it("零依赖迷你解析器与仓库 yaml 包结果等价（同一份档案）", () => {
    expect(parseAccountProfileYaml(text)).toEqual(YAML.parse(text));
  });

  it("账号类型归一（中文标签 → ID）与 hook_bias 越界告警", () => {
    const normalized = normalizeAccountProfile(parseAccountProfileYaml(text));
    expect(normalized.accountType).toBe("ip");
    expect(normalized.hookBias).toEqual(["question", "contrast"]);
    expect(normalized.notes).toEqual([]);

    const drifted = normalizeAccountProfile({
      account_id: "x",
      account_type: "养生号",
      hook_bias: ["question", "震惊式"],
      visual_hammer: { fontId: "comic-sans" }
    });
    expect(drifted.accountType).toBeNull();
    expect(drifted.hookBias).toEqual(["question"]);
    expect(drifted.notes.join(" ")).toContain("养生号");
    expect(drifted.notes.join(" ")).toContain("震惊式");
  });
});
