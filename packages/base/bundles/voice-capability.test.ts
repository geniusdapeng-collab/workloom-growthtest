/**
 * 本地声音克隆 / 配音能力（岗位 / 技能 / 围栏 / 管线 / 对象 / 工位桥）交叉引用与语义回归测试。
 *
 * 为什么单独一组：配音链路的失败模式是**静默且不可逆**的——
 *  · 围栏 when 表达式写反 → 要么无授权也能克隆、要么所有合法配音都被熔断（DSL 求值异常按 block）；
 *  · 岗位/技能/管线/对象四层断链 → 运行时"某一步没人执行"；
 *  · 参考音频质量门写松 → 音色不像、发飘，事后无法复现；
 *  · 时窗适配不设上限 → 配音被硬拉成 1.4 倍速，观众一听就出戏。
 * 这些都能在磁盘与纯函数层面静态验出来，所以本组测试不触 DB、不依赖 ffmpeg、不调引擎。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { evalCondition } from "../fence-engine/expr.js";
import { bundlesRoot } from "./assembly.js";
import {
  VOICE_TOOLS, assertPathAllowed, buildMultipart, chunkText, engineConfig, evaluateReferenceGate,
  fitTempo, planSegments, textMatchRatio,
} from "../../../bundles/ai-video/connectors/voice-bridge/core.mjs";
import { VOICE_BRIDGE_TOOLS, isVoiceBridgeTool } from "../../../bundles/ai-video/connectors/voice-bridge/executor.ts";

const ROOT = bundlesRoot();
const REPO_ROOT = dirname(ROOT);
const BUNDLE_DIR = join(ROOT, "ai-video");
const BRIDGE_DIR = join(BUNDLE_DIR, "connectors/voice-bridge");

interface FenceRule {
  rule_id: string;
  name: string;
  level: "auto" | "review" | "block";
  is_baseline: boolean;
  match: { object_types: string[]; actions: string[] };
  when: string;
  note?: string;
}

const fencePack = YAML.parse(readFileSync(join(BUNDLE_DIR, "fences/ai-video-voice.yml"), "utf8")) as {
  version: string;
  default_level: string;
  rules: FenceRule[];
};
const when = (ruleId: string): string => fencePack.rules.find((rule) => rule.rule_id === ruleId)!.when;
const evaluate = (ruleId: string, params: Record<string, unknown> = {}, context: Record<string, unknown> = {}): boolean =>
  evalCondition(when(ruleId), { params, context } as never);

const preset = YAML.parse(readFileSync(join(BUNDLE_DIR, "presets/voice-artist.yml"), "utf8")) as {
  preset_key: string;
  name: string;
  fence_bindings: string[];
  skills: string[];
  tools: Array<{ name: string; access: string }>;
  write_back: string[];
  coverage: Array<{ eventPrefix: string }>;
};

describe("配音围栏（G-VOICE0..G-VOICE6）语义", () => {
  it("七条规则齐备，级别与基线口径正确", () => {
    expect(fencePack.version).toBe("ai-video-voice/v1");
    expect(fencePack.rules.map((rule) => rule.rule_id)).toEqual([
      "G-VOICE0", "G-VOICE1", "G-VOICE2", "G-VOICE3", "G-VOICE4", "G-VOICE5", "G-VOICE6",
    ]);
    expect(fencePack.rules.every((rule) => rule.is_baseline === true)).toBe(true);
    expect(Object.fromEntries(fencePack.rules.map((rule) => [rule.rule_id, rule.level]))).toEqual({
      "G-VOICE0": "auto",
      "G-VOICE1": "review",
      "G-VOICE2": "block",
      "G-VOICE3": "block",
      "G-VOICE4": "block",
      "G-VOICE5": "block",
      "G-VOICE6": "review",
    });
  });

  it("常规本地配音直通：干净调用不被挂起", () => {
    expect(evaluate("G-VOICE0", { profile: "zh-xiaozhi", out: "/station/deliveries/a.wav" })).toBe(true);
  });

  it("G-VOICE1：没有授权声明就挂起；本人内部播报放行；商用未复核挂起", () => {
    expect(evaluate("G-VOICE1", {})).toBe(true); // 字段缺失 → fail-closed
    expect(evaluate("G-VOICE1", { consent_declared: false })).toBe(true);
    expect(evaluate("G-VOICE1", { consent_declared: true, consent_scope: "internal" })).toBe(false);
    expect(evaluate("G-VOICE1", { consent_declared: true, consent_scope: "commercial", consent_reviewed: false })).toBe(true);
    expect(evaluate("G-VOICE1", { consent_declared: true, consent_scope: "commercial", consent_reviewed: true })).toBe(false);
  });

  it("G-VOICE2：覆盖原片 / 覆盖参考音频一票否决", () => {
    expect(evaluate("G-VOICE2", { overwrite_source: true })).toBe(true);
    expect(evaluate("G-VOICE2", { output_path: "/a.mp4", input_path: "/a.mp4" })).toBe(true);
    expect(evaluate("G-VOICE2", { out: "/a.mp4", video: "/a.mp4" })).toBe(true);
    expect(evaluate("G-VOICE2", { out: "/x.wav", reference: "/x.wav" })).toBe(true);
    expect(evaluate("G-VOICE2", { out: "/out.mp4", video: "/in.mp4" })).toBe(false);
  });

  it("G-VOICE3：关闭校验禁止执行", () => {
    expect(evaluate("G-VOICE3", { skip_verify: true })).toBe(true);
    expect(evaluate("G-VOICE3", { verify: false })).toBe(true);
    expect(evaluate("G-VOICE3", { verify: true })).toBe(false);
  });

  it("G-VOICE4：单租户日配额熔断（1 小时音频）", () => {
    expect(evaluate("G-VOICE4", {}, { tenant_daily_voice_seconds: 3599 })).toBe(false);
    expect(evaluate("G-VOICE4", {}, { tenant_daily_voice_seconds: 3600 })).toBe(true);
  });

  it("G-VOICE5：声纹与参考音频不得出域（fail-closed）", () => {
    for (const flag of ["upload_voiceprint", "export_profile", "share_reference", "allow_nonlocal_engine"]) {
      expect(evaluate("G-VOICE5", { [flag]: true })).toBe(true);
    }
    expect(evaluate("G-VOICE5", {})).toBe(false);
  });

  it("G-VOICE6：对外发布但授权未覆盖 external-publish 时挂起", () => {
    expect(evaluate("G-VOICE6", { publish_external: true, consent_scope: "internal" })).toBe(true);
    expect(evaluate("G-VOICE6", { publish_external: true, consent_scope: "external-publish" })).toBe(false);
    expect(evaluate("G-VOICE6", { publish_external: false, consent_scope: "internal" })).toBe(false);
  });

  it("围栏动作面覆盖工位全部写工具（漏一个就是治理缺口）", () => {
    const covered = new Set(fencePack.rules.flatMap((rule) => rule.match.actions));
    for (const tool of VOICE_TOOLS) {
      expect(covered.has(tool), `${tool} 未被任何 G-VOICE 规则覆盖`).toBe(true);
    }
  });
});

describe("配音师岗位与技能包", () => {
  it("岗位绑定七条围栏、工具箱与桥的工具面一致", () => {
    expect(preset.preset_key).toBe("voice-artist");
    expect(preset.fence_bindings).toEqual([
      "G-VOICE0", "G-VOICE1", "G-VOICE2", "G-VOICE3", "G-VOICE4", "G-VOICE5", "G-VOICE6",
    ]);
    const bound = new Set(fencePack.rules.map((rule) => rule.rule_id));
    for (const fence of preset.fence_bindings) expect(bound.has(fence)).toBe(true);
    expect(preset.tools.map((tool) => tool.name).sort()).toEqual([...VOICE_TOOLS].sort());
    expect(preset.tools.every((tool) => tool.access === "read" || tool.access === "write")).toBe(true);
    expect(VOICE_BRIDGE_TOOLS.length).toBe(VOICE_TOOLS.length);
    for (const tool of VOICE_TOOLS) expect(isVoiceBridgeTool(tool)).toBe(true);
    expect(preset.write_back).toContain("voicewrite.dub");
    expect(preset.coverage[0]!.eventPrefix).toBe("voice.");
  });

  it("五件套技能齐备、frontmatter 与目录同名、且点名围栏绑定", () => {
    expect(preset.skills).toEqual([
      "voice-clone-consent",
      "voice-reference-craft",
      "voice-profile-craft",
      "voice-dubbing-sync",
      "voice-delivery-spec",
    ]);
    for (const skill of preset.skills) {
      const file = join(BUNDLE_DIR, "skills", skill, "SKILL.md");
      expect(existsSync(file), `缺少技能文件 ${skill}`).toBe(true);
      const raw = readFileSync(file, "utf8");
      const front = YAML.parse(raw.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "{}") as { name?: string; description?: string };
      expect(front.name).toBe(skill);
      expect(String(front.description)).toContain("G-VOICE");
      expect(raw).toContain("## 输出契约");
    }
  });

  it("bundle.json 已登记新岗位/围栏/技能，且目录里没有漏登记的产物", () => {
    const manifest = JSON.parse(readFileSync(join(BUNDLE_DIR, "bundle.json"), "utf8")) as {
      workloom: { provides: { presets: string[]; fences: string[]; skills: string[] } };
    };
    expect(manifest.workloom.provides.presets).toContain("presets/voice-artist.yml");
    expect(manifest.workloom.provides.fences).toContain("fences/ai-video-voice.yml");
    for (const skill of preset.skills) {
      expect(manifest.workloom.provides.skills).toContain(`skills/${skill}/SKILL.md`);
    }
    const onDisk = readdirSync(join(BUNDLE_DIR, "presets")).filter((file) => file.endsWith(".yml")).map((file) => `presets/${file}`);
    expect(new Set(onDisk)).toEqual(new Set(manifest.workloom.provides.presets));
  });

  it("叙事片管线在调色之后、配乐之前插入配音步（owner=voice-artist）", () => {
    const pipeline = YAML.parse(readFileSync(join(BUNDLE_DIR, "pipelines/narrative-film.yml"), "utf8")) as {
      steps: Array<{ step_key: string; owner: string; outputs: string[] }>;
    };
    const keys = pipeline.steps.map((step) => step.step_key);
    expect(keys.indexOf("voice")).toBeGreaterThan(keys.indexOf("color"));
    expect(keys.indexOf("voice")).toBeLessThan(keys.indexOf("bgm"));
    const step = pipeline.steps.find((item) => item.step_key === "voice")!;
    expect(step.owner).toBe("voice-artist");
    expect(step.outputs).toContain("voice_report");
  });

  it("对象枚举登记音色档案/配音音轨/配音报告", () => {
    const objects = JSON.parse(readFileSync(join(BUNDLE_DIR, "schemas/objects.json"), "utf8")) as {
      objects: Array<{ type: string; note?: string }>;
    };
    const types = objects.objects.map((item) => item.type);
    expect(types).toContain("voice_profile");
    expect(types).toContain("voice_track");
    expect(types).toContain("voice_report");
    expect(objects.objects.find((item) => item.type === "voice_profile")!.note).toContain("G-VOICE1");
  });

  it("工位随包交付：core/server/cli/executor/kit 与单测齐备", () => {
    for (const file of [
      "core.mjs", "server.mjs", "cli.mjs", "executor.ts", "executor.test.ts", "README.md",
      "kit/install.sh", "kit/station.sh", "kit/selftest.sh", "kit/engine-pin.json",
    ]) {
      expect(existsSync(join(BRIDGE_DIR, file)), `缺少工位文件 ${file}`).toBe(true);
    }
    const pin = JSON.parse(readFileSync(join(BRIDGE_DIR, "kit/engine-pin.json"), "utf8")) as {
      engine: { id: string; license: string };
      optionalEngines: Array<{ id: string; license: string }>;
    };
    expect(pin.engine.id).toBe("mlx-audio");
    expect(pin.engine.license).toBe("MIT");
    const fish = pin.optionalEngines.find((engine) => engine.id === "fish-speech")!;
    expect(fish.license).toContain("Research");
    const decision = readFileSync(join(REPO_ROOT, "docs/voice-clone-engine-decision.md"), "utf8");
    expect(decision).toMatch(/fish audio research license/i);
    expect(decision).toMatch(/macOS/);
  });
});

describe("工位内核纯函数（不依赖引擎与 ffmpeg）", () => {
  it("chunkText：按句切分并在上限内合并，超长句硬切", () => {
    expect(chunkText("")).toEqual([]);
    // 合并在上限内是**有意**的：分句后先合并，能少发几次请求（每次请求都要重编码参考音频）。
    expect(chunkText("你好。世界！")).toEqual(["你好。世界！"]);
    expect(chunkText("你好。世界！", { maxChars: 3 })).toEqual(["你好。", "世界！"]);
    expect(chunkText("一二。三四。", { maxChars: 5 })).toEqual(["一二。", "三四。"]);
    const long = "字".repeat(25);
    const chunks = chunkText(long, { maxChars: 10 });
    expect(chunks).toEqual(["字".repeat(10), "字".repeat(10), "字".repeat(5)]);
    expect(chunks.join("")).toBe(long);
  });

  it("evaluateReferenceGate：时长/语音占比/削波四类不达标都能报出来", () => {
    expect(evaluateReferenceGate({ seconds: 10, activeRatio: 0.9, truePeakDbtp: -6 }).ok).toBe(true);
    const short = evaluateReferenceGate({ seconds: 1.2, activeRatio: 0.9, truePeakDbtp: -6 });
    expect(short.ok).toBe(false);
    expect(short.reasons.join()).toContain("too_short");
    const silent = evaluateReferenceGate({ seconds: 10, activeRatio: 0.05, truePeakDbtp: -6 });
    expect(silent.reasons.join()).toContain("no_speech");
    const clipped = evaluateReferenceGate({ seconds: 10, activeRatio: 0.9, truePeakDbtp: 0.1 });
    expect(clipped.reasons.join()).toContain("clipping");
    const long = evaluateReferenceGate({ seconds: 40, activeRatio: 0.9, truePeakDbtp: -6 });
    expect(long.reasons.join()).toContain("too_long");
  });

  it("planSegments：显式时窗优先；纯文本按时长均分；非法时窗直接拒绝", () => {
    const explicit = planSegments({ segments: [{ start: 0, end: 2, text: "一" }, { start: 2, end: 4, text: "二" }], durationSec: 4 });
    expect(explicit.map((segment) => segment.text)).toEqual(["一", "二"]);
    expect(() => planSegments({ segments: [{ start: 3, end: 2, text: "坏" }], durationSec: 4 })).toThrowError(/时窗非法/);
    const split = planSegments({ text: "第一句。第二句。第三句。", durationSec: 9, maxChars: 5 });
    expect(split.length).toBe(3);
    expect(split[0]!.start).toBe(0);
    expect(split[split.length - 1]!.end).toBe(9);
    for (let index = 1; index < split.length; index += 1) {
      expect(split[index]!.start).toBe(split[index - 1]!.end);
    }
    expect(() => planSegments({ text: "只有文本", durationSec: 0 })).toThrowError(/时长/);
  });

  it("fitTempo：窗口内原速、1.25 倍内压缩、超出报 overflow", () => {
    expect(fitTempo({ audioSeconds: 3, windowSeconds: 5 })).toMatchObject({ tempo: 1, fits: true });
    const mild = fitTempo({ audioSeconds: 5, windowSeconds: 4 });
    expect(mild.fits).toBe(true);
    expect(mild.tempo).toBeCloseTo(1.25, 3);
    const over = fitTempo({ audioSeconds: 12, windowSeconds: 4 });
    expect(over.fits).toBe(false);
    expect(over.tempo).toBeLessThanOrEqual(1.25);
    expect(over.overflowSec).toBeGreaterThan(0);
  });

  it("textMatchRatio：保留词序与重复次数并标准化 Unicode，用于 ASR 回读核验", () => {
    expect(textMatchRatio("你好，世界。", "你好世界")).toBe(1);
    expect(textMatchRatio("一二三四", "一二四五")).toBeCloseTo(0.75, 3);
    expect(textMatchRatio("", "")).toBe(1);
    expect(textMatchRatio("有内容", "")).toBe(0);
    expect(textMatchRatio("甲乙丙丁戊己", "己戊丁丙乙甲")).toBeCloseTo(0.167, 3);
    expect(textMatchRatio("你好", "你好你好")).toBe(0.5);
    expect(textMatchRatio("ＣＡＦÉ", "cafe\u0301")).toBe(1);
  });

  it("engineConfig：默认为本机 MLX 引擎（支持参考音频直传），非法 kind 直接拒绝", () => {
    const config = engineConfig({});
    expect(config.kind).toBe("mlx");
    expect(config.baseUrl).toBe("http://127.0.0.1:8099");
    expect(config.referenceInjection).toBe(true);
    expect(config.asr).toBe(true);
    expect(config.asrLanguage).toBe("zh");
    const external = engineConfig({ WORKLOOM_VOICE_ENGINE: "openai", WORKLOOM_VOICE_ENGINE_URL: "http://127.0.0.1:3900/" });
    expect(external.baseUrl).toBe("http://127.0.0.1:3900");
    expect(external.referenceInjection).toBe(false);
    expect(() => engineConfig({ WORKLOOM_VOICE_ENGINE: "fish-speech" })).toThrowError(/不支持的引擎类型/);
  });

  it("路径监狱：白名单内放行、越界与软链逃逸拒绝", () => {
    const station = join(REPO_ROOT, "bundles/ai-video/connectors/voice-bridge");
    expect(assertPathAllowed(join(station, "README.md"), [station])).toContain("voice-bridge");
    expect(() => assertPathAllowed("/etc/hosts", [station])).toThrowError(/白名单/);
  });

  it("buildMultipart：字段与文件都在，且边界唯一", () => {
    const { body, contentType } = buildMultipart(
      { model: "mlx-community/whisper-large-v3-turbo", language: "zh" },
      { name: "file", filename: "ref.wav", contentType: "audio/wav", data: Buffer.from("RIFF0000") },
    );
    const text = body.toString("utf8");
    expect(contentType).toMatch(/^multipart\/form-data; boundary=----workloomvoice[0-9a-f]{16}$/);
    const boundary = contentType.split("boundary=")[1]!;
    expect(text).toContain(`name="model"`);
    expect(text).toContain("mlx-community/whisper-large-v3-turbo");
    expect(text).toContain(`filename="ref.wav"`);
    expect(text).toContain("RIFF0000");
    expect(text.trimEnd().endsWith(`--${boundary}--`)).toBe(true);
  });
});
