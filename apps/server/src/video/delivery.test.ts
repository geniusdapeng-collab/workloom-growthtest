/**
 * 交付包宿主侧接线单测（T-2026-0924-0071）
 *
 * 覆盖"界面能点、但底层必须守住"的几件事：
 *  · 路径监狱：交付包只能是交付根下的单个目录名，`../`、嵌套路径、非交付包目录一律拒绝；
 *  · 读模型：清单里的变体/差异/检查/返修历史被正确投影，媒体给签名 URL（不暴露裸目录）；
 *  · 选择与返修单：选择写入 selection.json + selections.jsonl；返修单按时间戳落 revision-requests/；
 *  · 返修指令纪律：空 patch 与模板占位符（`<...>`）必须在启动工位前被拒——系统不替用户猜要改成什么；
 *  · 连续返修基线：有 versions/vN 时以最新工程文件为基线（版本链 v3、v4…）。
 *
 * 不依赖数据库、不调用 ffmpeg：全部在临时目录里读写真实清单与文件。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DeliveryError, buildVariantPreferenceContent, deliveryPreferenceConfidence, deliveryPreferenceMemoryId,
  latestFilmProjectPath, listDeliveryPackages, readDeliveryPackage, readDeliveryArtifact,
  recordRevisionRequest, resolvePackageDir, selectDeliveryVariant, startDeliveryRevision,
} from "./delivery.js";

let root: string;
let packageDir: string;

function writeJson(file: string, value: unknown): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function seedPackage(name: string, manifest: Record<string, unknown>, project: Record<string, unknown> = {}): string {
  const dir = join(root, name);
  mkdirSync(join(dir, "variants", "warm-story"), { recursive: true });
  mkdirSync(join(dir, "subtitles"), { recursive: true });
  mkdirSync(join(dir, "master"), { recursive: true });
  writeJson(join(dir, "delivery-manifest.json"), manifest);
  writeJson(join(dir, "film-project.json"), {
    schemaVersion: "workloom.film-project/v1",
    projectId: manifest.projectId,
    version: 1,
    resolution: [1080, 1920],
    fps: 30,
    layers: { shots: [{ shotId: "SC-01" }], variants: [{ id: "warm-story" }] },
    ...project,
  });
  writeFileSync(join(dir, "variants", "warm-story", "warm-story.mp4"), "fake-video", "utf8");
  // 产物文件真实存在，读模型才会给出签名 URL（缺件时 URL 应为 null —— 这也是被断言的行为）
  writeFileSync(join(dir, "master", "master-clean.mp4"), "fake-master", "utf8");
  writeFileSync(join(dir, "variants", "warm-story", "large.mp4"), Buffer.alloc(4096, 7));
  writeFileSync(join(dir, "variants", "warm-story", "cover.png"), "fake-cover", "utf8");
  writeFileSync(join(dir, "subtitles", "VID-TEST-001.zh.srt"), "1\n00:00:00,000 --> 00:00:01,000\n测\n", "utf8");
  return dir;
}

const baseManifest = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: "workloom.delivery-package/v1",
  projectId: "VID-TEST-001",
  title: "测试片",
  createdAt: "2026-09-24T00:00:00.000Z",
  platform: "抖音/快手",
  resolution: [1080, 1920],
  fps: 30,
  master: { path: "master/master-clean.mp4", sha256: "a".repeat(64), duration: 27.03, subtitles: "none" },
  subtitles: { files: [{ path: "subtitles/VID-TEST-001.zh.srt", role: "subtitle", lang: "chi", format: "srt", sha256: "b".repeat(64) }] },
  variants: [
    {
      id: "warm-story",
      name: "暖调故事版",
      positioning: "情感/文旅",
      video: { path: "variants/warm-story/warm-story.mp4", sha256: "c".repeat(64), duration: 27.03 },
      cover: { path: "variants/warm-story/cover.png", sha256: "d".repeat(64), text: "标题 / 钩子" },
      copy: { path: "variants/warm-story/copy.md", title: "标题", hashtags: ["#a", "#b", "#c"], checks: [{ kind: "title_length", ok: true }] },
      audio: {
        path: "variants/warm-story/audio.json",
        trackId: "acoustic-warm-x",
        trackTitle: "Warm",
        loudness: { after: { integratedLufs: -14.1 } },
        mixing: { requestedMusicLevelDb: -21, appliedMusicLevelDb: -24, autoTrimDb: -3, note: "自动降档" },
      },
      style: {
        color: { profile: "warm-film", lut: "look-warm-film.cube", intensity: 0.75 },
        transitions: { mode: "fade", fadeSec: 0.6 },
        copyTone: "温暖克制",
      },
    },
  ],
  divergence: [{ a: "warm-story", b: "clean-tech", visual: { meanAbsDiff: 16.71, verdict: "visible" }, audio: { differs: true } }],
  checks: [{ kind: "master_no_burn_in", ok: true }, { kind: "variants_distinct", ok: true }],
  filmProject: "film-project.json",
  cost: { shotGeneration: "reused", tokenCostDelta: 0, note: "变体只在后期派生" },
  ...overrides,
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "workloom-delivery-"));
  // 签名密钥（读模型里的媒体 URL 需要它；缺省时 URL 会安全降级为 null）
  process.env.MEDIA_SIGNING_SECRET = "test-media-secret";
  packageDir = seedPackage("VID-TEST-001", baseManifest());
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const env = (): NodeJS.ProcessEnv => ({ WORKLOOM_DELIVERY_DIR: root });

describe("交付包路径监狱", () => {
  it("只接受交付根下的单个目录名（拒绝穿越与嵌套）", () => {
    expect(resolvePackageDir("VID-TEST-001", env())).toBe(packageDir);
    expect(() => resolvePackageDir("../VID-TEST-001", env())).toThrow(DeliveryError);
    expect(() => resolvePackageDir("a/b", env())).toThrow(/非法/);
    expect(() => resolvePackageDir(".hidden", env())).toThrow(/非法/);
    expect(() => resolvePackageDir("no-such-package", env())).toThrow(/不存在/);
  });

  it("目录存在但不是交付包（缺 delivery-manifest.json）→ 明确报错", () => {
    mkdirSync(join(root, "not-a-package"), { recursive: true });
    expect(() => resolvePackageDir("not-a-package", env())).toThrow(/不是交付包/);
  });

  it("交付物取件：路径监狱 + 体积上限", () => {
    const artifact = readDeliveryArtifact({ dir: "VID-TEST-001", ref: "master/master-clean.mp4", env: env() });
    expect(artifact.contentType).toBe("video/mp4");
    expect(Buffer.from(artifact.base64, "base64").toString("utf8")).toBe("fake-master");
    // 穿越与绝对路径一律拒绝
    expect(() => readDeliveryArtifact({ dir: "VID-TEST-001", ref: "../../etc/passwd", env: env() })).toThrow(/非法/);
    expect(() => readDeliveryArtifact({ dir: "VID-TEST-001", ref: "/etc/passwd", env: env() })).toThrow(/非法/);
    // 超出上限 → 明确提示"用本地播放器打开"，不硬搬（上限本身有 1KB 的下限保护）
    expect(() => readDeliveryArtifact({ dir: "VID-TEST-001", ref: "variants/warm-story/large.mp4", maxBytes: 1024, env: env() }))
      .toThrow(/超过页内取件上限|本地播放器/);
  });
});

describe("交付包读模型", () => {
  it("列出交付包并投影检查结论与选择状态", () => {
    const rows = listDeliveryPackages({ env: env() });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dir).toBe("VID-TEST-001");
    expect(rows[0]!.passed).toBe(true);
    expect(rows[0]!.variantIds).toEqual(["warm-story"]);
    expect(rows[0]!.selectedVariantId).toBeNull();
  });

  it("详情包含变体/差异实测/配乐降档记录/签名媒体 URL", () => {
    const detail = readDeliveryPackage("VID-TEST-001", env());
    expect(detail.variants).toHaveLength(1);
    expect(detail.variants[0]!.audio?.autoTrimDb).toBe(-3);
    expect(detail.divergence[0]!.meanAbsDiff).toBe(16.71);
    expect(detail.checks.map((check) => check.kind)).toEqual(["master_no_burn_in", "variants_distinct"]);
    // 交付物给**包内相对引用**（页内取件走 video.delivery.artifact 的路径监狱），不暴露绝对路径
    expect(detail.master.ref).toBe("master/master-clean.mp4");
    expect(detail.variants[0]!.videoRef).toBe("variants/warm-story/warm-story.mp4");
    expect(detail.variants[0]!.coverRef).toBe("variants/warm-story/cover.png");
    expect(detail.subtitleFiles[0]!.ref).toBe("subtitles/VID-TEST-001.zh.srt");
    expect(detail.cost?.tokenCostDelta).toBe(0);
  });

  it("清单缺变体时列表仍可读，失败项如实统计", () => {
    seedPackage("VID-BAD-002", baseManifest({ variants: [], checks: [{ kind: "variants_distinct", ok: false }] }));
    const rows = listDeliveryPackages({ env: env() });
    const bad = rows.find((row) => row.dir === "VID-BAD-002")!;
    expect(bad.passed).toBe(false);
    expect(bad.failedChecks).toEqual(["variants_distinct"]);
  });
});

describe("选择变体与返修单", () => {
  it("选择写 selection.json + selections.jsonl；未知变体拒绝", () => {
    const selection = selectDeliveryVariant({
      dir: "VID-TEST-001", variantId: "warm-story", note: "客户喜欢暖调", by: "MEM-V01", env: env(),
    });
    expect(selection.variantId).toBe("warm-story");
    const latest = JSON.parse(readFileSync(join(packageDir, "selection.json"), "utf8")) as { variantId: string; note: string };
    expect(latest.variantId).toBe("warm-story");
    expect(latest.note).toBe("客户喜欢暖调");
    expect(readFileSync(join(packageDir, "selections.jsonl"), "utf8")).toContain("warm-story");
    expect(() => selectDeliveryVariant({ dir: "VID-TEST-001", variantId: "no-such", env: env() })).toThrow(/没有变体/);
  });

  it("返修单按时间戳落 revision-requests/，内容含意见与分诊", () => {
    const { requestPath, request } = recordRevisionRequest({
      dir: "VID-TEST-001",
      feedback: "配乐太吵了",
      triage: { kinds: ["audio"], attributions: ["rev.audio.mix"], layers: ["audio"] },
      patchHint: { bgm: { style: "<风格关键词>" } },
      by: "MEM-V01",
      env: env(),
    });
    expect(existsSync(requestPath)).toBe(true);
    expect(request.feedback).toBe("配乐太吵了");
    const stored = JSON.parse(readFileSync(requestPath, "utf8")) as { triage: { layers: string[] }; by: string };
    expect(stored.triage.layers).toEqual(["audio"]);
    expect(stored.by).toBe("MEM-V01");
  });
});

describe("选择结果 → 组织偏好池（evolve 写入侧）", () => {
  it("偏好内容带齐风格轴与来源项目，措辞可被下一轮注入直接使用", () => {
    const content = buildVariantPreferenceContent({
      projectId: "VID-TEST-001",
      variantId: "warm-story",
      variantName: "暖调故事版",
      positioning: "情感/文旅/民宿",
      style: {
        color: { profile: "warm-film", lut: "look-warm-film.cube", intensity: 0.75 },
        bgm: { mood: "温暖自在", style: "acoustic-warm", policy: "keep-dialogue" },
        transitions: { mode: "fade", fadeSec: 0.6 },
        copyTone: "温暖克制",
      },
      note: "客户说这套更高级",
    });
    expect(content).toContain("【交付口味】");
    expect(content).toContain("VID-TEST-001");
    expect(content).toContain("暖调故事版");
    // 不能写成 profile@强度：会被 PII 脱敏当邮箱（真机实测），用「（强度 …）」
    expect(content).toContain("温暖自在");
    expect(content).toContain("warm-film（强度 0.75）");
    expect(content).not.toMatch(/[\w.-]+@[\w.-]+/);
    expect(content).toContain("fade 0.6s");
    expect(content).toContain("温暖克制");
    expect(content).toContain("客户说这套更高级");
    // 缺省轴兜底不伪造数值
    const bare = buildVariantPreferenceContent({ projectId: "P", variantId: "clean-tech" });
    expect(bare).toContain("不调色");
    expect(bare).toContain("原声");
    expect(bare).toContain("默认");
  });

  it("偏好记忆 id 按（工作区 × 变体）稳定：反复选同一风格是更新同一条，不堆新行", () => {
    const a = deliveryPreferenceMemoryId("ws-video", "warm-story");
    const b = deliveryPreferenceMemoryId("ws-video", "warm-story");
    const c = deliveryPreferenceMemoryId("ws-other", "warm-story");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^mem-pref-delivery-ws-video-warm-story$/);
    // 非法字符收敛，避免脏 id 落库
    expect(deliveryPreferenceMemoryId("ws/../x", "warm story")).toBe("mem-pref-delivery-ws----x-warm-story");
  });

  it("置信度随选择次数单调上调且有上限（留出人审上调空间）", () => {
    expect(deliveryPreferenceConfidence(1)).toBe(0.5);
    expect(deliveryPreferenceConfidence(3)).toBe(0.6);
    expect(deliveryPreferenceConfidence(20)).toBe(0.9);
    expect(deliveryPreferenceConfidence(0)).toBe(0.5);
    expect(deliveryPreferenceConfidence(Number.NaN)).toBe(0.5);
  });

  it("selectDeliveryVariant 回传风格元数据与选择次数（供偏好写入用）", () => {
    const first = selectDeliveryVariant({ dir: "VID-TEST-001", variantId: "warm-story", env: env() });
    expect(first.projectId).toBe("VID-TEST-001");
    expect(first.variant?.style?.color?.profile).toBe("warm-film");
    expect(first.selectionCount).toBe(1);
    const second = selectDeliveryVariant({ dir: "VID-TEST-001", variantId: "warm-story", env: env() });
    expect(second.selectionCount).toBe(2);
  });
});

describe("返修指令纪律（不在请求里烧钱、不替用户猜）", () => {
  it("空 patch 与模板占位符都在启动工位前被拒", async () => {
    await expect(startDeliveryRevision({ dir: "VID-TEST-001", patch: {}, env: env() })).rejects.toThrow(/patch 为空/);
    await expect(
      startDeliveryRevision({ dir: "VID-TEST-001", patch: { bgm: { style: "<风格关键词>" } }, env: env() }),
    ).rejects.toThrow(/占位符/);
  });

  it("点名画面内容（需要重生成镜头）→ 拒绝执行并指向人审", async () => {
    await expect(
      startDeliveryRevision({ dir: "VID-TEST-001", patch: { shots: { regenerate: ["SC-01"] } }, env: env() }),
    ).rejects.toThrow(/画面内容|G8/);
  });
});

describe("连续返修的版本基线", () => {
  it("有 versions/vN 时以最新一轮工程文件为基线（版本链不断）", () => {
    expect(latestFilmProjectPath(packageDir)).toBe(join(packageDir, "film-project.json"));
    writeJson(join(packageDir, "versions", "v2", "film-project.json"), { schemaVersion: "workloom.film-project/v1" });
    writeJson(join(packageDir, "versions", "v3", "film-project.json"), { schemaVersion: "workloom.film-project/v1" });
    expect(latestFilmProjectPath(packageDir)).toBe(join(packageDir, "versions", "v3", "film-project.json"));
    writeJson(join(packageDir, "versions", "v4", "revision.json"), { version: 4 });
    expect(latestFilmProjectPath(packageDir)).toBe(join(packageDir, "versions", "v3", "film-project.json"));
  });
});
