/**
 * 手绘白板引擎单测（T-2026-0926-0020）
 *
 * 覆盖口径：
 *   · 分幕算法与**上游 `parse_srt.py` 同构**（真跑 python 逐字比对，不是"看起来一样"）；
 *   · annotation 契约校验（上游 SKILL.md 的遮罩不变量与质量检查的可机检部分）；
 *   · 分句规则、时间轴铺满（Σ 幕长 = 配音总长）、图片尺寸解析（PNG/JPEG）；
 *   · 引擎就绪判定与开关语义（`WHITEBOARD_ENABLED=0` 必须判为不可用）。
 *
 * 纪律：不 mock 被测逻辑本身；需要外部解释器的一例（parse_srt 比对）在缺 python 时**显式跳过**
 * 并在断言里写明跳过原因，而不是静默通过。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSrt, groupScenes, parseSrt, srtTime, tileScenes } from "./srt.js";
import { validateAnnotation, visibleArea } from "./annotate.js";
import { pipelineKindOf } from "../render-poller.js";
import { reusableSegment, splitSentences, type SegmentManifest } from "./narration.js";
import { resumableScene } from "./store.js";
import { projectedWhiteboardSize, readImageSize, whiteboardEngineReady, whiteboardEnv } from "./engine.js";
import { readWhiteboardParams } from "./provider.js";

describe("白板输出画布契约", () => {
  it("UHD 线稿按引擎网格对齐后为原生 3840×2160", () => {
    expect(projectedWhiteboardSize({ width: 1672, height: 941 }, 3840))
      .toEqual({ width: 3840, height: 2160 });
    expect(projectedWhiteboardSize({ width: 1024, height: 1024 }, 3840))
      .toEqual({ width: 3840, height: 3840 });
  });

  it("provider 拒绝 UHD 档位与 HD 长边混用", () => {
    const req = { prompt: "", estimatedUnits: 1,
      params: { extra: { whiteboard: { projectId: "p", scenes: [{ sceneNo: 1 }], quality: "uhd", capLongEdge: 1280 } } } };
    expect(() => readWhiteboardParams(req as Parameters<typeof readWhiteboardParams>[0])).toThrow(/长边参数非法/);
  });
});

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../..");

/** 一份覆盖"整句 / 断句 / 跨幕"的示例字幕（11 句，约 96s，按 30s 目标应切成 3–4 幕） */
const SRT = [
  "1", "00:00:00,000 --> 00:00:08,400", "做过生意的人都懂这三笔账：流量越来越贵，询盘接不住，利润被平台抽走。", "",
  "2", "00:00:08,600 --> 00:00:16,200", "还有一笔正在发生的新账：越来越多客户先问 AI，再决定买谁。", "",
  "3", "00:00:16,500 --> 00:00:24,000", "AI 的答案里没有你，你就少了一个正在爆发的入口。", "",
  "4", "00:00:24,300 --> 00:00:32,100", "通用 AI 是单线工具：一次只干一件事，交付的是内容。", "",
  "5", "00:00:32,400 --> 00:00:40,000", "WorkLoom 是系统化班组：老板一句话，系统自动分工、协作、交付。", "",
  "6", "00:00:40,300 --> 00:00:48,000", "它交付的不是内容，而是这一轮宣传带来了多少销售额。", "",
  "7", "00:00:48,200 --> 00:00:56,400", "这家正在运行的公司里有四支专业团队：情报策略、影视制作、社媒运营、经营转化。", "",
  "8", "00:00:56,700 --> 00:01:04,000", "获客五环每一天都在自动运转，每一环都能度量到钱。", "",
  "9", "00:01:04,300 --> 00:01:12,000", "断点档案让超长链路永不白跑，媒资库让素材越攒越值钱。", "",
  "10", "00:01:12,300 --> 00:01:20,000", "围栏治理、人审、事件账本，把信任焊死在系统里。", "",
  "11", "00:01:20,300 --> 00:01:28,000", "免费体检、影子试用、正式托管——三步把 AI 班组请进门。", "",
].join("\n");

describe("srt：解析 / 生成 / 分幕", () => {
  it("解析 SRT（含 BOM、CRLF、点号毫秒分隔）", () => {
    const dirty = `\uFEFF${SRT.replace(/\n/g, "\r\n").replace(",000 -->", ".000 -->")}`;
    const cues = parseSrt(dirty);
    expect(cues).toHaveLength(11);
    expect(cues[0]!.startMs).toBe(0);
    expect(cues[0]!.endMs).toBe(8400);
    expect(cues[10]!.text.startsWith("免费体检")).toBe(true);
  });

  it("分幕：目标 30s / 最短 25s / 最长 35s → 3–4 幕，且幕内字幕连续", () => {
    const cues = parseSrt(SRT);
    const scenes = groupScenes(cues, { targetSec: 30, minSec: 25, maxSec: 35 });
    expect(scenes.length).toBeGreaterThanOrEqual(3);
    expect(scenes.length).toBeLessThanOrEqual(4);
    scenes.forEach((scene, i) => {
      expect(scene.sceneIndex).toBe(i + 1);
      expect(scene.sceneDurationMs).toBeLessThanOrEqual(35_000 + 1);
    });
    // 相邻幕首尾相接（不重叠、不留洞）
    for (let i = 1; i < scenes.length; i += 1) {
      expect(scenes[i]!.cueRange[0]).toBe(scenes[i - 1]!.cueRange[1] + 1);
    }
  });

  it("与上游 parse_srt.py 的分幕结果逐字段一致（真跑 python 比对）", () => {
    const python = whichPython();
    if (!python) {
      // 显式跳过：CI 镜像无 python 时不比，但绝不用"假通过"掩盖
      console.warn("[whiteboard.test] 跳过上游分幕比对：环境无 python3/python 解释器");
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "wb-srt-"));
    const srtPath = join(dir, "input.srt");
    writeFileSync(srtPath, SRT, "utf8");
    const script = join(REPO_ROOT, "vendor/srt-whiteboard/scripts/parse_srt.py");
    const out = execFileSync(python, [
      script, srtPath, "--target-sec", "30", "--min-sec", "25", "--max-sec", "35",
    ], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    const upstream = JSON.parse(out) as {
      cues: Array<{ startMs: number; endMs: number; text: string }>;
      scenes: Array<{ sceneIndex: number; startMs: number; endMs: number; sceneDurationMs: number; cueRange: number[] }>;
    };
    const ours = groupScenes(parseSrt(SRT), { targetSec: 30, minSec: 25, maxSec: 35 });
    expect(ours.length).toBe(upstream.scenes.length);
    ours.forEach((scene, i) => {
      const ref = upstream.scenes[i]!;
      expect(scene.sceneIndex).toBe(ref.sceneIndex);
      expect(scene.startMs).toBe(ref.startMs);
      expect(scene.endMs).toBe(ref.endMs);
      expect(scene.sceneDurationMs).toBe(ref.sceneDurationMs);
      expect(scene.cueRange).toEqual(ref.cueRange);
    });
  });

  it("tileScenes 把幕长铺满到音频总长（Σ 幕长 == 总长，混流不需要补偿）", () => {
    const cues = parseSrt(SRT);
    const totalMs = cues[cues.length - 1]!.endMs + 300; // 末尾还有 300ms 余音
    const scenes = tileScenes(groupScenes(cues, { targetSec: 30, minSec: 25, maxSec: 35 }), totalMs);
    const sum = scenes.reduce((acc, s) => acc + s.sceneDurationMs, 0);
    expect(sum).toBe(totalMs);
    for (let i = 1; i < scenes.length; i += 1) {
      expect(scenes[i]!.startMs).toBe(scenes[i - 1]!.endMs);
    }
  });

  it("SRT 时间戳格式与内边距", () => {
    expect(srtTime(0)).toBe("00:00:00,000");
    expect(srtTime(65.4)).toBe("00:01:05,400");
    expect(srtTime(3661.007)).toBe("01:01:01,007");
    expect(buildSrt(parseSrt(SRT))).toContain("00:00:00,000 --> 00:00:08,400");
  });
});

describe("annotation 契约校验（上游遮罩不变量）", () => {
  const size = { width: 1672, height: 941 };
  const base = () => ({
    sceneId: "scene-01",
    canvas: { width: 1672, height: 941 },
    storyBasis: "示例",
    sceneDurationMs: 6000,
    elements: [
      {
        id: "e1", label: "场景", sequence: 1, narrativeRole: "场景铺垫" as const, subtitle: "第一句",
        type: "structure",
        region: { x: 20, y: 120, width: 540, height: 400 },
        reveal: { direction: "top_to_bottom" as const, startMs: 0, durationMs: 2400, maskPaddingPx: 22, protectedRegions: [] },
        handPath: { start: [290, 130] as [number, number], end: [290, 500] as [number, number], easing: "easeInOut" as const },
      },
      {
        id: "e2", label: "主体", sequence: 2, narrativeRole: "关键主体" as const, subtitle: "第二句",
        type: "object",
        region: { x: 600, y: 160, width: 500, height: 400 },
        reveal: { direction: "left_to_right" as const, startMs: 2520, durationMs: 2400, maskPaddingPx: 22, protectedRegions: [] },
        handPath: { start: [606, 360] as [number, number], end: [1094, 360] as [number, number], easing: "easeInOut" as const },
      },
    ],
  });

  it("合法标注零问题", () => {
    expect(validateAnnotation(base(), size)).toEqual([]);
  });

  it("画布不一致 / 区域越界 / sequence 断裂 / 时长越界 / 串行重叠 都被拦下", () => {
    const canvas = base();
    canvas.canvas = { width: 100, height: 100 };
    expect(validateAnnotation(canvas, size).join("；")).toContain("不一致");

    const outOfBounds = base();
    outOfBounds.elements[1]!.region = { x: 1600, y: 160, width: 500, height: 400 };
    expect(validateAnnotation(outOfBounds, size).join("；")).toContain("越界");

    const brokenSeq = base();
    brokenSeq.elements[1]!.sequence = 3;
    expect(validateAnnotation(brokenSeq, size).join("；")).toContain("sequence 不连续");

    const tooShort = base();
    tooShort.elements[0]!.reveal.durationMs = 200;
    expect(validateAnnotation(tooShort, size).join("；")).toContain("durationMs");

    const overlapping = base();
    overlapping.elements[1]!.reveal.startMs = 1000; // 与 e1（0–2400）重叠
    expect(validateAnnotation(overlapping, size).join("；")).toContain("应为串行");
  });

  it("重叠区域未用 protectedRegions 保护 → 拦下", () => {
    const ann = base();
    ann.elements[1]!.region = { x: 100, y: 200, width: 400, height: 300 }; // 与 e1 交叠
    expect(validateAnnotation(ann, size).join("；")).toContain("protectedRegions");
  });

  it("结尾未留 0.5s 完整画面 → 拦下", () => {
    const ann = base();
    ann.sceneDurationMs = 5000; // 元素画完于 4920ms
    expect(validateAnnotation(ann, size).join("；")).toContain("0.5s");
  });

  it("区域被后续区域完全覆盖 → 拦下（空掩码：上游渲染器画不出线，打补丁前还会整幕崩）", () => {
    const ann = base();
    // e2 的区域把 e1 完全盖住 → e1 的允许掩码为空
    ann.elements[1]!.region = { x: 0, y: 0, width: 1672, height: 941 };
    expect(validateAnnotation(ann, size).join("；")).toContain("完全覆盖");
  });
});

describe("可见面积（容斥）——空掩码的机检依据", () => {
  it("无重叠 → 等于自身面积", () => {
    const r = { x: 0, y: 0, width: 100, height: 50 };
    expect(visibleArea(r, [{ x: 200, y: 200, width: 10, height: 10 }])).toBe(5000);
  });

  it("被完全覆盖 → 0", () => {
    const r = { x: 10, y: 10, width: 50, height: 50 };
    expect(visibleArea(r, [{ x: 0, y: 0, width: 100, height: 100 }])).toBe(0);
  });

  it("两个后续区域分别盖住一半 → 剩余 0（并且不会因重复扣减变成负数）", () => {
    const r = { x: 0, y: 0, width: 100, height: 100 };
    expect(visibleArea(r, [
      { x: 0, y: 0, width: 100, height: 50 },
      { x: 0, y: 50, width: 100, height: 50 },
    ])).toBe(0);
  });

  it("部分重叠 → 精确扣减（含交集加回）", () => {
    const r = { x: 0, y: 0, width: 100, height: 100 };
    // 两块各盖 30×100，彼此不重叠 → 剩 40×100
    expect(visibleArea(r, [
      { x: 0, y: 0, width: 30, height: 100 },
      { x: 70, y: 0, width: 30, height: 100 },
    ])).toBe(4000);
    // 第二块完全落在第一块内（各 30×100 与 30×50，并集仍是 30×100）
    // → 容斥必须把重复扣减加回来：10000 − 3000 − 1500 + 1500 = 7000
    expect(visibleArea(r, [
      { x: 0, y: 0, width: 30, height: 100 },
      { x: 0, y: 50, width: 30, height: 50 },
    ])).toBe(7000);
  });
});

describe("narration 分句", () => {
  it("按句末标点切分：标题丢弃、列表符号剥掉、正文保留", () => {
    const script = [
      "# 开场",
      "做过生意的人都懂这三笔账。",
      "还有一笔新账！你知道吗？",
      "",
      "- 第一点：流量越来越贵；",
      "1. 第二点：询盘接不住。",
    ].join("\n");
    const sentences = splitSentences(script);
    expect(sentences[0]).toBe("做过生意的人都懂这三笔账。");
    expect(sentences.some((s) => s.includes("还有一笔新账！"))).toBe(true);
    // 标题是脚本结构标签，不进配音（否则会读出"开场"两个字）
    expect(sentences.some((s) => s.includes("开场"))).toBe(false);
    expect(sentences.some((s) => s.startsWith("第一点：流量越来越贵；"))).toBe(true);
    expect(sentences.some((s) => s.startsWith("第二点：询盘接不住。"))).toBe(true);
  });

  it("过短碎片并入前一句（不产生'好了！'这类独立元素位）", () => {
    const sentences = splitSentences("这是一句完整的话。好了！");
    expect(sentences).toHaveLength(1);
    expect(sentences[0]).toBe("这是一句完整的话。好了！");
  });

  it("文档脚手架不进配音：引用/表格/分隔线/注释行 + 行内 Markdown 全部处理", () => {
    const script = [
      "> 用途：跑出片工具（元数据，不该被朗读）",
      "| 字段 | 说明 |",
      "| --- | --- |",
      "---",
      "<!-- 内部备注 -->",
      "这是正文第一句，带 **加粗** 与 `代码`。",
      "参考 [官方文档](https://example.com) 里的说明。",
    ].join("\n");
    const sentences = splitSentences(script);
    expect(sentences).toHaveLength(2);
    expect(sentences[0]).toBe("这是正文第一句，带 加粗 与 代码。");
    expect(sentences[1]).toBe("参考 官方文档 里的说明。");
  });
});

describe("narration 分句复用（断点续跑的**正确性**凭据）", () => {
  const manifest = (over: Partial<SegmentManifest> = {}): SegmentManifest => ({
    schema: "workloom.whiteboard-narration/v1",
    scriptSha256: "script",
    profile: "chen-zhuo-film",
    segments: [
      { index: 0, sha256: "aaaaaaaaaaaaaaaa", profile: "chen-zhuo-film", file: "seg-01.wav", seconds: 6 },
    ],
    ...over,
  });

  it("文件在 + 文本一致 + 音色一致 → 复用", () => {
    // 用真实哈希路径：先按同一算法生成（sha256(text).slice(0,16) 由被测代码计算，这里只验证一致性）
    const text = "大家好，我是陈卓。";
    const self: SegmentManifest = {
      ...manifest(),
      segments: [{ index: 0, sha256: hash16(text), profile: "chen-zhuo-film", file: "seg-01.wav", seconds: 6 }],
    };
    expect(reusableSegment({ manifest: self, index: 0, text, profile: "chen-zhuo-film", fileExists: true })).toBe(true);
  });

  it("**改了稿子**（同一句下标、文本变了）→ 不复用（这是修掉的真实缺陷：曾经会静默复用旧音频）", () => {
    const oldText = "大家好，我是陈卓。";
    const newText = "这次我们换个说法。";
    const self: SegmentManifest = {
      ...manifest(),
      segments: [{ index: 0, sha256: hash16(oldText), profile: "chen-zhuo-film", file: "seg-01.wav", seconds: 6 }],
    };
    expect(reusableSegment({ manifest: self, index: 0, text: newText, profile: "chen-zhuo-film", fileExists: true })).toBe(false);
  });

  it("换了音色档案 → 不复用（同文本不同音色不是同一个产物）", () => {
    const text = "大家好，我是陈卓。";
    const self: SegmentManifest = {
      ...manifest(),
      segments: [{ index: 0, sha256: hash16(text), profile: "zh-myvoice", file: "seg-01.wav", seconds: 6 }],
    };
    expect(reusableSegment({ manifest: self, index: 0, text, profile: "chen-zhuo-film", fileExists: true })).toBe(false);
  });

  it("文件丢了 / 没有清单 → 不复用（宁可重合成，也不赌）", () => {
    const text = "大家好，我是陈卓。";
    const self: SegmentManifest = {
      ...manifest(),
      segments: [{ index: 0, sha256: hash16(text), profile: "chen-zhuo-film", file: "seg-01.wav", seconds: 6 }],
    };
    expect(reusableSegment({ manifest: self, index: 0, text, profile: "chen-zhuo-film", fileExists: false })).toBe(false);
    expect(reusableSegment({ manifest: null, index: 0, text, profile: "chen-zhuo-film", fileExists: true })).toBe(false);
  });

  it("一次性迁移路径：清单由已有文件推导（derivedFrom=assumed）时，文件在即复用", () => {
    const assumed = manifest({ segments: [], derivedFrom: "assumed-from-existing-files" });
    expect(reusableSegment({ manifest: assumed, index: 3, text: "任意", profile: "chen-zhuo-film", fileExists: true })).toBe(true);
    expect(reusableSegment({ manifest: assumed, index: 3, text: "任意", profile: "chen-zhuo-film", fileExists: false })).toBe(false);
  });

  it("迁移条目一旦被真实哈希登记，assumed 兜底立即失效（防止旧文件被无限期信任）", () => {
    const text = "大家好，我是陈卓。";
    const partlyPinned = manifest({
      derivedFrom: "assumed-from-existing-files",
      segments: [{ index: 3, sha256: hash16(text), profile: "chen-zhuo-film", file: "seg-04.wav", seconds: 6 }],
    });
    // 已登记且一致 → 复用
    expect(reusableSegment({ manifest: partlyPinned, index: 3, text, profile: "chen-zhuo-film", fileExists: true })).toBe(true);
    // 已登记但文本变了 → 即使 derivedFrom 仍是 assumed，也不再兜底（按哈希判否）
    expect(reusableSegment({ manifest: partlyPinned, index: 3, text: "改过的句子。", profile: "chen-zhuo-film", fileExists: true })).toBe(false);
  });
});

describe("渲染任务断点续跑（provider 的接管判据）", () => {
  it("已 rendered 且产物仍在 → 跳过重渲", () => {
    const file = join(mkdtempSync(join(tmpdir(), "wb-resume-")), "scene-01.mp4");
    writeFileSync(file, "x");
    expect(resumableScene({ sceneNo: 1, sceneId: "scene-01", status: "rendered", annotationPath: "a", outputPath: file })).toBe(true);
  });

  it("状态是 rendered 但产物被删了 → 必须重渲（不能把「文件没了」当成功）", () => {
    expect(resumableScene({
      sceneNo: 1, sceneId: "scene-01", status: "rendered",
      annotationPath: "a", outputPath: "/definitely/not/here.mp4",
    })).toBe(false);
  });

  it("rendering / pending / failed → 都要重跑（上一轮死在渲染中的幕没有终结态）", () => {
    for (const status of ["rendering", "pending", "failed"] as const) {
      expect(resumableScene({ sceneNo: 2, sceneId: "scene-02", status, annotationPath: "a", outputPath: "/tmp/x.mp4" })).toBe(false);
    }
  });
});

/** 与 narration.ts#textSha 同算法（测试里独立实现一次，避免"用被测代码验证被测代码"） */
function hash16(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

describe("engine 环境与开关", () => {
  it("WHITEBOARD_ENABLED=0 时一律判为不可用（即使 venv 在）", () => {
    expect(whiteboardEngineReady({ WHITEBOARD_ENABLED: "0" } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("开启但 venv 缺失 → 判为不可用并给出安装命令建议", () => {
    const env = {
      WHITEBOARD_ENABLED: "1",
      WHITEBOARD_PYTHON: "/definitely/not/here/python",
    } as unknown as NodeJS.ProcessEnv;
    expect(whiteboardEngineReady(env)).toBe(false);
    expect(whiteboardEnv(env).python).toBe("/definitely/not/here/python");
  });

  it("默认引擎目录指向仓库内 vendor（不入库 venv，路径口径稳定）", () => {
    expect(whiteboardEnv({} as NodeJS.ProcessEnv).engineDir.endsWith("vendor/srt-whiteboard")).toBe(true);
  });
});

describe("render-poller 片型映射（0042 新增 explainer）", () => {
  it("narrative / marketing / explainer / 未知值", () => {
    expect(pipelineKindOf("narrative")).toBe("narrative");
    expect(pipelineKindOf("marketing")).toBe("marketing");
    expect(pipelineKindOf("explainer")).toBe("explainer");
    expect(pipelineKindOf("account_ops")).toBe("narrative");
    expect(pipelineKindOf(null)).toBe("narrative");
  });
});

describe("readImageSize：PNG/JPEG 头解析", () => {
  it("读 PNG IHDR 尺寸", () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-png-"));
    // 1×1 透明 PNG（手写最小合法文件，避免依赖图形库）
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const file = join(dir, "one.png");
    writeFileSync(file, png);
    expect(readImageSize(file)).toEqual({ width: 1, height: 1 });
  });

  it("不存在的文件返回 null（调用方据此报错，不猜尺寸）", () => {
    expect(readImageSize("/definitely/not/here.png")).toBeNull();
  });
});

/** 找可用的 python 解释器（只用于跑上游 parse_srt.py，无需第三方依赖） */
function whichPython(): string | null {
  for (const candidate of ["python3", "python"]) {
    try {
      execFileSync(candidate, ["-c", "print(1)"], { stdio: "ignore" });
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}


describe("白板 render 路由提交脚本的数据库版本", () => {
  let caller: any;
  const scope = { tenantId: "tenant-wb", workspaceId: "workspace-wb" };
  const persisted = () => ({ id: "script-v7", project_id: "project-wb", shot_id: "WHITEBOARD",
    script_key: "whiteboard-project-wb", version: 7, status: "approved", md: "数据库精确正文及备注", fields: { durationMs: 5000, engine: "whiteboard-local" } });
  let current: ReturnType<typeof persisted> | null;
  let filmCapLongEdge = 1280;
  let fence = "auto";
  const submitted = vi.fn();
  const created = vi.fn();
  const query = vi.fn(async (sql: string) => ({ rows: [], rowCount: 0 }));
  const pool = { connect: async () => ({ query, release: vi.fn() }) };
  beforeAll(async () => {
    const { initTRPC } = await import("@trpc/server");
    const t = initTRPC.context<any>().create();
    vi.doMock("../../trpc/context.js", () => ({ router: t.router, protectedProcedure: t.procedure,
      writeProcedure: t.procedure, scopeOf: (identity: any) => ({ tenantId: identity.tenantId, workspaceId: identity.workspaceId }) }));
    vi.doMock("@workloom/db", () => ({ getAppPool: () => pool, getGatewayPool: () => pool }));
    vi.doMock("../gen/submit.js", () => ({ submitGenJob: submitted }));
    vi.doMock("@workloom/base/asset-cms", () => ({ create: created }));
    vi.doMock("@workloom/base/fence-engine", () => ({ loadActiveRulesInTx: async () => [], judge: () => ({ level: fence, impacts: [], triggeredBy: [] }) }));
    vi.doMock("./engine.js", async () => ({ ...await vi.importActual<any>("./engine.js"),
      whiteboardEngineReady: () => true, readImageSize: () => ({ width: 1672, height: 941 }) }));
    vi.doMock("../gen/db.js", () => ({ scopedQuery: async (_pool: unknown, actualScope: unknown, sql: string, params: unknown[]) => {
      expect(actualScope).toEqual(scope);
      if (sql.includes("FROM whiteboard_films")) return [{ id: "film-wb", project_id: "project-wb", script_md: "口播原文", render_fps: 30, cap_long_edge: filmCapLongEdge }];
      if (sql.includes("FROM whiteboard_scenes")) return [{ scene_no: 1, lineart_path: "lineart.png", annotation: { elements: [{}] }, duration_ms: 5000 }];
      if (sql.includes("SELECT s.* FROM render_scripts")) {
        expect(params).toEqual([scope.workspaceId, "whiteboard-project-wb", scope.tenantId, "project-wb"]);
        return current ? [current] : [];
      }
      if (sql.includes("SELECT status FROM render_scripts")) return [{ status: current?.status ?? "draft" }];
      throw new Error(`unexpected query ${sql}`);
    } }));
    caller = (await import("./router.js")).whiteboardRouter.createCaller({ identity: { ...scope, memberId: "MEM-WB" } } as any);
  });
  beforeEach(() => {
    current = persisted(); filmCapLongEdge = 1280; fence = "auto"; submitted.mockReset().mockResolvedValue({ taskId: "task" }); created.mockReset();
    created.mockImplementation(async (_a, _g, _scope, input) => ({ ...persisted(), id: "script-v1", version: 1, status: "draft", md: input.md, fields: input.fields }));
  });
  it("已有 v7 的正文、字段、状态原样交给唯一提交入口，不伪造 v1", async () => {
    await caller.render({ filmId: "film-wb" });
    expect(submitted.mock.calls[0]?.[0].script).toEqual(persisted());
    expect(created).not.toHaveBeenCalled();
  });
  it("首次创建使用 create 实际回传正文与字段，能够通过账本内容校验", async () => {
    current = null;
    await caller.render({ filmId: "film-wb" });
    const actual = submitted.mock.calls[0]?.[0].script;
    expect(actual.version).toBe(1); expect(actual.md).toContain("手绘白板片");
    expect(actual.fields).toEqual({ engine: "whiteboard-local", scenes: 1, durationMs: 5000 });
    expect(actual.md).not.toBe("口播原文");
  });
  it("UHD 首次创建保留画质与分辨率证据，并提交同一脚本版本", async () => {
    current = null;
    filmCapLongEdge = 3840;
    await caller.render({ filmId: "film-wb" });
    const actual = submitted.mock.calls[0]?.[0];
    expect(actual.script.fields).toEqual({
      engine: "whiteboard-local", scenes: 1, durationMs: 5000,
      quality: "uhd", resolution: "3840x2160",
    });
    expect(actual.params.resolution).toBe("3840x2160");
    expect(actual.params.extra.whiteboard).toMatchObject({ quality: "uhd", capLongEdge: 3840 });
  });
  it("review 未批准时仍在唯一提交入口前拒绝", async () => {
    fence = "review"; current!.status = "draft";
    await expect(caller.render({ filmId: "film-wb" })).rejects.toThrow("须先经");
    expect(submitted).not.toHaveBeenCalled();
  });
});
