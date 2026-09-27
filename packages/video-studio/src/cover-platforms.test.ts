/**
 * 封面平台规格注册表回归（2026-09-27 平台化）
 *
 * 三条硬口径：
 *   ① **回归基线**：`douyin` 规格必须与 `cover-design.ts` 既有 `COVER_SAFE_AREA`
 *      （顶部 6% / 标题带 42% / 底部 12%）和 1080×1920 完全一致——抖音默认行为逐像素不变；
 *   ② **上游一致**：`COVER_PLATFORM_VENDOR_SOURCES` 的 px 与本表比例必须同源
 *      （直接读 vendor 蓝图逐项比对，避免"两个事实源各说各话"）；
 *   ③ **缺省安全**：未知平台名落 douyin 且不抛错（旧调用零影响）。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COVER_SAFE_AREA } from "./cover-design.js";
import {
  COVER_PLATFORM_IDS,
  COVER_PLATFORMS,
  COVER_PLATFORM_VENDOR_SOURCES,
  DEFAULT_COVER_PLATFORM,
  PLATFORM_ALIASES,
  getCoverSpec,
  headlineLimitLabel,
  headlineUnits,
  isEnglishCoverPlatform,
  isKnownCoverPlatform
} from "./cover-platforms.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const VENDOR_FILE = resolve(REPO_ROOT, "vendor/supermickey/hyperreality-system/config/platform-profiles.js");

describe("封面平台规格：登记完整性", () => {
  it("8 个平台齐备且字段完整（画幅/画布/安全区/标题带/语言/钩子/调性）", () => {
    expect(COVER_PLATFORM_IDS.sort()).toEqual([
      "bilibili", "douyin", "instagram-reels", "kuaishou", "tiktok", "wechat-channels", "xiaohongshu", "youtube"
    ]);
    for (const [key, spec] of Object.entries(COVER_PLATFORMS)) {
      expect(spec.id, `${key} 的 id 与键不一致`).toBe(key);
      expect(spec.canvas.width).toBeGreaterThan(0);
      expect(spec.canvas.height).toBeGreaterThan(0);
      expect(spec.safeArea.topMinRatio).toBeGreaterThan(0);
      expect(spec.safeArea.bottomReservedRatio).toBeGreaterThan(0);
      expect(spec.titleBand.topRatio).toBeGreaterThan(0);
      expect(spec.titleBand.bottomMaxRatio).toBeGreaterThan(spec.titleBand.topRatio);
      expect(spec.titleBand.bottomMaxRatio).toBeLessThan(1);
      expect(spec.headlineMaxChars).toBeGreaterThan(0);
      expect(spec.hookStyles.length).toBeGreaterThanOrEqual(2);
      expect(spec.copyTone.length).toBeGreaterThan(0);
      expect(spec.notes.length).toBeGreaterThan(0);
      expect(["vertical", "horizontal"]).toContain(spec.orientation);
      expect(spec.ratio).toMatch(/^\d+:\d+$/);
    }
  });

  it("横版/竖版方向与画幅一致（16:9 是横版，其余为竖版）", () => {
    for (const spec of Object.values(COVER_PLATFORMS)) {
      const horizontal = spec.ratio === "16:9";
      expect(spec.orientation, `${spec.id} 方向与画幅不符`).toBe(horizontal ? "horizontal" : "vertical");
      if (horizontal) expect(spec.canvas.width).toBeGreaterThan(spec.canvas.height);
      else expect(spec.canvas.height).toBeGreaterThan(spec.canvas.width);
    }
  });
});

describe("封面平台规格：抖音回归基线", () => {
  it("douyin 安全区与既有 COVER_SAFE_AREA 完全一致（0.06 / 0.42 / 0.12）", () => {
    const douyin = getCoverSpec("douyin");
    expect(douyin.safeArea.topMinRatio).toBe(COVER_SAFE_AREA.topMinRatio);
    expect(douyin.titleBand.bottomMaxRatio).toBe(COVER_SAFE_AREA.titleBottomMaxRatio);
    expect(douyin.safeArea.bottomReservedRatio).toBe(COVER_SAFE_AREA.bottomReservedRatio);
    expect(douyin.titleBand.topRatio).toBe(COVER_SAFE_AREA.topMinRatio);
    expect(douyin.canvas).toEqual({ width: 1080, height: 1920 });
    expect(douyin.ratio).toBe("9:16");
    expect(douyin.language).toBe("zh");
    expect(douyin.headlineMaxChars).toBe(12);
  });

  it("缺省/未知平台落 douyin 且不抛错（旧调用零影响）", () => {
    expect(getCoverSpec().id).toBe(DEFAULT_COVER_PLATFORM);
    expect(getCoverSpec(null).id).toBe("douyin");
    expect(getCoverSpec("").id).toBe("douyin");
    expect(getCoverSpec("某不存在的平台").id).toBe("douyin");
    expect(isKnownCoverPlatform("某不存在的平台")).toBe(false);
    expect(isKnownCoverPlatform("小红书")).toBe(true);
  });

  it("中文别名与历史默认值（抖音/快手）按抖音解析", () => {
    expect(getCoverSpec("抖音").id).toBe("douyin");
    expect(getCoverSpec("抖音/快手").id).toBe("douyin");
    expect(getCoverSpec("小红书").id).toBe("xiaohongshu");
    expect(getCoverSpec("B站").id).toBe("bilibili");
    expect(getCoverSpec("bilibili").id).toBe("bilibili");
    expect(getCoverSpec("IG").id).toBe("instagram-reels");
    for (const [alias, id] of Object.entries(PLATFORM_ALIASES)) {
      expect(COVER_PLATFORMS[id], `别名 ${alias} → ${id} 未登记`).toBeTruthy();
    }
    /** 大小写与空白归一 */
    expect(getCoverSpec("  Xiaohongshu ").id).toBe("xiaohongshu");
    expect(getCoverSpec("YOUTUBE").id).toBe("youtube");
  });
});

describe("封面平台规格：与 vendor 蓝图同源", () => {
  const vendorText = readFileSync(VENDOR_FILE, "utf8");
  /** 从 vendor 源码里抠出某个 profile 的 safeArea 三个 px（避免加载 CJS vendor 模块） */
  const vendorSafeArea = (vendorKey: string): { topPx: number; bottomPx: number; rightRailPx: number } => {
    const escaped = vendorKey.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
    const block = new RegExp(`(?:^|\\n)\\s*'?${escaped}'?:\\s*\\{[\\s\\S]*?safeArea:\\s*\\{([^}]*)\\}`).exec(vendorText)?.[1];
    expect(block, `vendor 未找到 ${vendorKey} 的 safeArea`).toBeTruthy();
    const pick = (key: string): number => Number(new RegExp(`${key}:\\s*(\\d+)`).exec(block!)?.[1]);
    return { topPx: pick("topPx"), bottomPx: pick("bottomPx"), rightRailPx: pick("rightRailPx") };
  };

  it("vendor 原文 px 与登记索引一致（漂移即红）", () => {
    for (const [platformId, source] of Object.entries(COVER_PLATFORM_VENDOR_SOURCES)) {
      const actual = vendorSafeArea(source.vendorKey);
      expect(actual, `${platformId} 与 vendor ${source.vendorKey} 的 px 不一致`).toEqual({
        topPx: source.topPx, bottomPx: source.bottomPx, rightRailPx: source.rightRailPx
      });
    }
    /** vendor 新增平台时必须同步评估封面侧是否登记（本用例只保证已登记项不失配） */
    expect(Object.keys(COVER_PLATFORM_VENDOR_SOURCES).sort()).toEqual(
      ["bilibili", "douyin", "instagram-reels", "kuaishou", "tiktok", "wechat-channels", "xiaohongshu"]
    );
  });

  /**
   * 容差 1 个百分点：本表把 px 比例**取整到整百分点**（如 B站 90/1080=8.33% 取 9%），
   * 方向一律取"更保守"（预留多、可用区少），不允许出现比 vendor 更激进的口径。
   */
  it("比例 = px ÷ 画布高/宽（取整到整百分点，方向保守），douyin 底部按真机口径例外", () => {
    for (const [platformId, source] of Object.entries(COVER_PLATFORM_VENDOR_SOURCES)) {
      const spec = COVER_PLATFORMS[platformId]!;
      expect(spec.canvas, `${platformId} 画布与 px 换算基准不一致`).toEqual(source.canvas);
      const bottom = source.bottomPx / source.canvas.height;
      const top = source.topPx / source.canvas.height;
      const rail = source.canvas.width > 0 ? source.rightRailPx / source.canvas.width : 0;
      if (platformId === "douyin") {
        /** 抖音底部是**真机口径例外**（12% vs vendor 16.7%），其余三项仍须同源 */
        expect(spec.safeArea.bottomReservedRatio).toBe(0.12);
        expect(spec.vendorNote).toContain("12%");
      } else {
        expect(Math.abs(spec.safeArea.bottomReservedRatio - bottom), `${platformId} 底部比例偏离 vendor`)
          .toBeLessThanOrEqual(0.01);
        expect(spec.safeArea.bottomReservedRatio, `${platformId} 底部遮挡区不得比 vendor 更激进`)
          .toBeGreaterThanOrEqual(bottom - 0.005);
      }
      expect(Math.abs(spec.safeArea.topMinRatio - top), `${platformId} 顶部比例偏离 vendor`)
        .toBeLessThanOrEqual(0.01);
      expect(Math.abs(spec.safeArea.rightRailRatio - rail), `${platformId} 右侧栏比例偏离 vendor`)
        .toBeLessThanOrEqual(0.005);
    }
  });
});

describe("封面平台规格：标题长度口径", () => {
  it("中文平台按视觉字计，英文平台按词计", () => {
    const douyin = getCoverSpec("douyin");
    const tiktok = getCoverSpec("tiktok");
    const youtube = getCoverSpec("youtube");
    expect(isEnglishCoverPlatform(douyin)).toBe(false);
    expect(isEnglishCoverPlatform(tiktok)).toBe(true);
    expect(headlineUnits("落霞秋水\n滕王阁", douyin)).toBe(7);
    expect(headlineUnits("THIS $10 FIND BLEW UP", tiktok)).toBe(5);
    expect(headlineUnits("3 MISTAKES", youtube)).toBe(2);
    expect(headlineLimitLabel(douyin)).toContain("12 个字");
    expect(headlineLimitLabel(tiktok)).toContain("5 个英文单词");
  });

  it("英文平台词数上限 ≤5，中文平台字数上限在合理区间（12–16）", () => {
    for (const spec of Object.values(COVER_PLATFORMS)) {
      if (isEnglishCoverPlatform(spec)) expect(spec.headlineMaxChars).toBeLessThanOrEqual(5);
      else expect(spec.headlineMaxChars).toBeGreaterThanOrEqual(12);
    }
  });
});
