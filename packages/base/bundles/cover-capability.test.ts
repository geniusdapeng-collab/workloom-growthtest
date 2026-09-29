/**
 * 封面链路 · 平台化与知识库（cover-platforms + cover-kb）交叉引用与语义回归。
 *
 * 为什么单独一组：封面链路的失败模式是"看起来出了一张图，其实平台不对"——
 *   · 岗位/技能/桥/知识库四层断链 → 运行时"知识库没人调用"，平台化形同虚设；
 *   · KB 条目没登记进 bundle.json → 换一台机器/装一次行业包就丢文件（签名索引不含它）；
 *   · 注入无 trace / 超条数 → 监制无法复核"这句话是从哪条知识来的"；
 *   · 未知平台静默落 9:16 → 小红书/B站 封面被平台裁切却没人报错。
 * 这些都能在磁盘与纯函数层面静态验出来，本组测试不触 DB、不依赖 ffmpeg、不调引擎。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { bundlesRoot } from "./assembly.js";
import { loadVerifiedBundleEvalQuestions } from "./eval-questions.js";
import { PLATFORM_KB_IDS, enrichCoverHints, kbStatus, loadKb, platformProfile } from "../../../bundles/ai-video/connectors/cover-kb-bridge/core.mjs";

const ROOT = bundlesRoot();
const REPO_ROOT = join(ROOT, "..");
const BUNDLE_DIR = join(ROOT, "ai-video");
const KB_DIR = join(BUNDLE_DIR, "library/cover-kb");
const ACCOUNT_DIR = join(BUNDLE_DIR, "library/account-profiles");
const BRIDGE_DIR = join(BUNDLE_DIR, "connectors/cover-kb-bridge");

const kb = loadKb(KB_DIR);

interface BundleManifestShape {
  workloom: {
    provides: {
      skills: string[];
      connectors: string[];
      presets: string[];
      library: string[];
      evalQuestions: string;
    };
  };
  integrity?: { assets: Record<string, string> };
}

const manifest = JSON.parse(readFileSync(join(BUNDLE_DIR, "bundle.json"), "utf8")) as BundleManifestShape;

const preset = YAML.parse(readFileSync(join(BUNDLE_DIR, "presets/cover-designer.yml"), "utf8")) as {
  preset_key: string;
  version: string;
  skills: string[];
  fence_bindings: string[];
  tools: Array<{ name: string; access: string }>;
  coverage: Array<{ eventPrefix: string }>;
  prompt: { constraints: string[] };
};

describe("封面能力：岗位 ↔ 技能 ↔ 知识库 ↔ 桥", () => {
  it("cover-designer 岗位绑定 cover-kb 技能与三条既有围栏（不新造围栏）", () => {
    expect(preset.preset_key).toBe("cover-designer");
    expect(preset.skills).toContain("cover-design");
    expect(preset.skills).toContain("cover-kb");
    expect(preset.fence_bindings).toEqual(["G-SUB2", "G-SUB3", "G-MAT1"]);
    expect(preset.coverage.some((c) => c.eventPrefix === "cover.")).toBe(true);
  });

  it("岗位约束写明平台规格单一事实源 / KB 注入纪律 / 账号视觉锤", () => {
    const constraints = preset.prompt.constraints.join("\n");
    expect(constraints).toContain("cover-platforms.ts");
    expect(constraints).toContain("≤3 条");
    expect(constraints).toContain("trace");
    expect(constraints).toContain("视觉锤");
    expect(constraints).toContain("干净母版");
  });

  it("技能文件与桥都在 bundle.json 里登记（换机器/装行业包不丢文件）", () => {
    expect(manifest.workloom.provides.skills).toContain("skills/cover-kb/SKILL.md");
    expect(manifest.workloom.provides.connectors).toContain("connectors/cover-kb-bridge/core.mjs");
    expect(manifest.workloom.provides.connectors).toContain("connectors/cover-kb-bridge/cli.mjs");
    expect(manifest.workloom.provides.connectors).toContain("connectors/cover-kb-bridge/account-profile.mjs");
    expect(manifest.workloom.provides.library).toContain("library/account-profiles/chen-zhuo.yml");
    for (const topic of kb.topics) {
      expect(manifest.workloom.provides.library, `${topic.id} 未登记进 provides.library`).toContain(`library/cover-kb/${topic.file}`);
    }
    expect(manifest.workloom.provides.library).toContain("library/cover-kb/_INDEX.md");
    /** 登记项必须在磁盘上真实存在，且在签名索引里有摘要 */
    for (const path of [...manifest.workloom.provides.library.filter((p) => p.includes("cover")), "skills/cover-kb/SKILL.md"]) {
      expect(existsSync(join(BUNDLE_DIR, path)), `${path} 不存在`).toBe(true);
      expect(manifest.integrity?.assets[path], `${path} 缺签名摘要`).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("知识库自检通过（14 篇 / 参数与映射行齐备 / 无缺篇）", () => {
    const status = kbStatus(kb);
    expect(status.ok).toBe(true);
    expect(status.topics).toBe(14);
    expect(status.missingTopics).toEqual([]);
    expect(status.untrackedTopics).toEqual([]);
    expect(status.topicsWithEmptyMappings).toEqual([]);
  });

  it("八个平台都能直取规范，且都指向已登记篇目", () => {
    for (const platformId of Object.keys(PLATFORM_KB_IDS)) {
      const profile = platformProfile(kb, platformId);
      expect(profile, `${platformId} 无对应篇目`).toBeTruthy();
      expect(kb.topics.some((t: { id: string }) => t.id === profile!.kbId), `${platformId} 指向的篇目不在库里`).toBe(true);
      expect(profile!.params.length, `${platformId} 平台参数为空`).toBeGreaterThan(0);
    }
  });
});

describe("封面能力：注入纪律（≤3 条 / trace 一一对应 / 矛盾闸 / 未知平台不静默）", () => {
  it("八个平台各出一份注入载荷：≤3 条、hint 与 trace 一一对应、首条是平台规范", () => {
    for (const platformId of Object.keys(PLATFORM_KB_IDS)) {
      const payload = enrichCoverHints(kb, { platformId, theme: "知识科普", accountType: "知识号" });
      expect(payload.fallback, `${platformId} 不应 fallback`).toBe(false);
      expect(payload.hints.length, `${platformId} 注入超限`).toBeLessThanOrEqual(3);
      expect(payload.hints.length).toBe(payload.trace.length);
      expect(payload.hints[0], `${platformId} 首条不是平台规范`).toContain(`【封面知识库·${PLATFORM_KB_IDS[platformId as keyof typeof PLATFORM_KB_IDS]}§4】`);
      for (const pick of payload.trace) expect(pick.kbId).toMatch(/^[A-Z]+-\d{3}$/);
    }
  });

  it("矛盾闸：KB 数字与代码规格不一致时以代码为准并留痕", () => {
    const payload = enrichCoverHints(kb, {
      platformId: "bilibili",
      spec: {
        id: "bilibili", ratio: "16:9", canvas: { width: 1920, height: 1080 },
        safeArea: { topMinRatio: 0.06, bottomReservedRatio: 0.2, rightRailRatio: 0 },
        titleBand: { topRatio: 0.06, bottomMaxRatio: 0.55 }, language: "zh", headlineMaxChars: 16
      }
    });
    expect(payload.conflicts.join(" ")).toContain("底部遮挡");
    expect(payload.hints[0]).toContain("20%");
  });

  it("未知平台：明确 fallback（不静默套 9:16），链路可退化为无 KB 出稿", () => {
    const payload = enrichCoverHints(kb, { platformId: "zhihu" });
    expect(payload.fallback).toBe(true);
    expect(payload.hints).toEqual([]);
  });
});

describe("封面能力：账号档案与考试院题集", () => {
  it("样例账号档案可解析，四件套/钩子偏好/禁区齐备", () => {
    const profile = YAML.parse(readFileSync(join(ACCOUNT_DIR, "chen-zhuo.yml"), "utf8")) as {
      account_id: string;
      account_type: string;
      visual_hammer: { fontId: string; palette: string[]; archetype_bias: string; badge_series: string };
      hook_bias: string[];
      taboo: string[];
    };
    expect(profile.account_id).toBe("chen-zhuo");
    expect(["ip", "brand", "seeding", "knowledge", "local"]).toContain(profile.account_type);
    expect(profile.visual_hammer.fontId).toMatch(/^(smiley-sans|source-han-heavy|zcool-qingke|noto-serif)$/);
    expect(profile.visual_hammer.palette.every((c) => /^#[0-9A-Fa-f]{6}$/.test(c))).toBe(true);
    expect(["person-led", "subject-led"]).toContain(profile.visual_hammer.archetype_bias);
    expect(profile.hook_bias.length).toBeGreaterThan(0);
    expect(profile.taboo.length).toBeGreaterThan(0);
  });

  it("账号档案说明、检索桥与口径文档同在（避免有样例没规矩）", () => {
    expect(existsSync(join(ACCOUNT_DIR, "README.md"))).toBe(true);
    expect(existsSync(join(BRIDGE_DIR, "core.mjs"))).toBe(true);
    expect(existsSync(join(REPO_ROOT, "docs/cover-platformization.md"))).toBe(true);
  });

  it("考试院题集含 ≥6 道封面题，且题题有硬断言与评分口径", () => {
    const set = loadVerifiedBundleEvalQuestions("ai-video");
    const coverQuestions = set.questions.filter((q) => (q.tags ?? []).includes("cover"));
    expect(coverQuestions.length).toBeGreaterThanOrEqual(6);
    for (const question of coverQuestions) {
      expect(question.assertions.length).toBeGreaterThan(0);
      expect(question.judgeRubric?.fullMarks).toBeTruthy();
      expect(question.judgeRubric?.zeroMarks).toBeTruthy();
    }
    /** 覆盖到"平台规格 / 版式 / 账号视觉锤 / 知识库纪律"四个考核面 */
    const tags = new Set(coverQuestions.flatMap((q) => q.tags ?? []));
    for (const tag of ["cover-platforms", "archetype", "account", "cover-kb"]) {
      expect(tags.has(tag), `封面题集缺考核面：${tag}`).toBe(true);
    }
  });
});
