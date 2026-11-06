import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { videoRuntimeRoot } from "./runtime-root.js";
import { installVendorNarrativePromptReviewBridge, normalizeNarrativePromptsForReview,
  type NarrativePromptReviewPolicy } from "./vendor-compat.js";
import { bindStudioEngineCheckpoints, createStudioCheckpointRunner, studioCheckpointHash,
  type StudioCheckpointAdapter, type StudioEngineCheckpoint, type StudioCheckpointRequest } from "./studio-checkpoints.js";
import { unicodeLength } from "./unicode-text.mjs";

type Row = Record<string, unknown>;
const require = createRequire(import.meta.url);
const root = videoRuntimeRoot(import.meta.url);
const { HyperrealitySystem } = require(resolve(root, "vendor/supermickey/hyperreality-system/index.js"));
const { OpeningTitleOptimizer } = require(resolve(root,
  "vendor/supermickey/hyperreality-system/engines/production-engine/agents/opening-title-optimizer.js"));
const titleKeys = ["title_content", "subtitle_content", "title_animation", "title_font_design", "opening_audio_design"];
const titles = { title_content: "器物𠮷$&", subtitle_content: "从拿起到放稳", title_animation: "片名淡入后静止。",
  title_font_design: "灰色无衬线字。", opening_audio_design: "器物接触工作台的轻响。" };
const policy: NarrativePromptReviewPolicy = { noDialogue: true, noMusic: true, noCharacters: false,
  noAnimals: true, noTitles: false, maxLength: 3000, durationSeconds: 4, aspectRatio: "9:16", resolution: "1080x1920",
  characterNames: ["演员甲"], characterPortraits: [], projectProps: [], projectActions: ["演员甲放稳器物"],
  marketingPrompt: { actions: ["演员甲放稳器物"], overlay: ["原文$&𠮷"], endCard: ["工序结束"] } };

function production(extraScene = 0, priorTitles = false) {
  const fields = { scene: `工作室内，成形工作台靠近左侧窗户。${"墙".repeat(extraScene)}`,
    action: "演员甲拿起器物，转动后平稳放回工作台。", costume: "灰色工作外套。", makeup: "自然肤色。",
    props: "一件器物、工作台。", timeline: "T00:00-T00:02拿起转动；T00:02-T00:04放稳。",
    composition: "中景，器物与双手完整入画。", lighting: "左侧自然柔光。", color_palette: "中性灰。",
    transition: "落幅静止。", mood: "专注地看器物落稳。", camera_movement: "固定机位。",
    pacing: "先拿起，再放稳。", depth_of_field: "器物与双手同时清晰。", audio: "器物接触工作台的轻响。",
    character: "演员甲位于工作台右侧。" };
  const row: Row = { shotId: "S1", sceneType: "opening", duration: 4, ...fields, fields,
    prompt: "01.【基础】电影级写实材质。", _workloomPromptReviewPolicy: structuredClone(policy) };
  if (priorTitles) Object.assign(row, titles, { title_animation: "旧".repeat(2800) });
  return { success: true, shots: [structuredClone(row)], prompts: [row] };
}

function fixture(reply: (prompt: string, fallback: () => unknown, systemPrompt: string) => Promise<Row>) {
  const descriptor = Object.getOwnPropertyDescriptor(OpeningTitleOptimizer.prototype, "_callLLM");
  const author = vi.fn(async function(this: object, prompt: string, _schema: unknown, fallback: () => unknown) {
    expect(this).toBeInstanceOf(OpeningTitleOptimizer);
    return reply(prompt, fallback, (this as { _getSystemPrompt(): string })._getSystemPrompt());
  });
  OpeningTitleOptimizer.prototype._callLLM = author;
  const release = installVendorNarrativePromptReviewBridge();
  const records: StudioEngineCheckpoint[] = [];
  const adapter: StudioCheckpointAdapter = { load: async () => null, save: async record => { records.push(record); } };
  const failure = vi.fn();
  const system = Object.create(HyperrealitySystem.prototype);
  Object.assign(system, { creativeThemeGenerator: { generate: async () => ({}) },
    requirementDiscoveryEngine: { discover: async () => ({}) }, prdGenerator: { generate: async () => ({}) },
    scriptEngine: { process: async () => ({}) }, productionEngine: { produce: async () => ({}) } });
  bindStudioEngineCheckpoints(system, adapter, "frozen input", { assertActive() {}, onFailure: failure });
  return { system, records, failure, author, close() { release();
    if (descriptor) Object.defineProperty(OpeningTitleOptimizer.prototype, "_callLLM", descriptor);
    else delete OpeningTitleOptimizer.prototype._callLLM; } };
}

const budgetFrom = (prompt: string) => Number(/五字段字符串值合计最多 (\d+) 个 Unicode 字符/u.exec(prompt)?.[1]);

it("authors within the exact dynamic remainder and preserves every native field, audio and five literal title values", async () => {
  const budgets: number[] = [];
  const f = fixture(async (prompt, _fallback, systemPrompt) => {
    const budget = budgetFrom(prompt); budgets.push(budget);
    expect(budgetFrom(systemPrompt)).toBe(budget);
    expect(systemPrompt).toContain("原规则中的低沉器乐音要求取消");
    expect(systemPrompt).toContain("禁止可辨台词、对白、旁白或口播");
    expect(prompt).toContain("原文字段篇幅要求由本次总预算覆盖");
    expect(prompt).toContain("禁止音乐、配乐、器乐、旋律或音乐节拍");
    expect(prompt).toContain("工序结束"); // Single-shot opening is also the last shot.
    const fixed = Object.values(titles).reduce((sum, value) => sum + unicodeLength(value), 0);
    return { result: { ...titles, title_animation: titles.title_animation + "动".repeat(budget - fixed) }, degraded: false };
  });
  try {
    for (const extra of [0, 137]) {
      const source = production(extra, true);
      const heldPrompts = source.prompts; const heldRow = source.prompts[0]!;
      const heldShots = source.shots; const heldShot = source.shots[0]!;
      const originalFields = structuredClone(source.prompts[0]!.fields);
      await f.system._optimizeOpeningTitle(source, { stages: { adapter: { title: "器物工序" } } }, {});
      const row = source.prompts[0]!;
      expect(source.prompts).toBe(heldPrompts); expect(row).toBe(heldRow);
      expect(source.shots).toBe(heldShots); expect(source.shots[0]).toBe(heldShot);
      expect(heldRow.title_content).toBe(titles.title_content); expect(heldShot.title_content).toBe(titles.title_content);
      expect(heldRow.prompt).toContain(titles.title_content); expect(heldShot.prompt).toBe(heldRow.prompt);
      expect(row.fields).toEqual(originalFields);
      expect(row.audio).toBe((originalFields as Row).audio);
      for (const key of titleKeys) expect(typeof row[key]).toBe("string");
      expect(row.title_content).toBe(titles.title_content);
      expect(row.opening_audio_design).toBe(titles.opening_audio_design);
      const normalized = normalizeNarrativePromptsForReview([row], policy)[0]!;
      expect(unicodeLength(String(normalized.prompt))).toBe(3000);
      for (const key of titleKeys) expect(String(normalized.prompt)).toContain(String(row[key]));
      expect(normalized.prompt).toContain(policy.marketingPrompt!.overlay[0]);
      expect(normalized.prompt).toContain(policy.marketingPrompt!.endCard[0]);
    }
    expect(budgets.every(value => value > 5 && value < 3000)).toBe(true);
    expect(budgets[0]! - budgets[1]!).toBe(137);
    expect(f.author).toHaveBeenCalledTimes(2); // Existing complete but oversized titles cannot early-return.
    expect(f.records.map(record => record.stage)).toEqual(["OPENING_TITLE", "OPENING_TITLE"]);
    expect(f.failure).not.toHaveBeenCalled();
  } finally { f.close(); }
});

it.each(["degraded", "fallback", "missing", "nonstring", "overbudget", "music",
  "mixed-speech", "mixed-music", "unban-speech", "unban-music", "prohibited-music"])(
  "rejects %s before the title checkpoint save and leaves native production intact", async mode => {
    const f = fixture(async (prompt, fallback) => {
      if (mode === "fallback") { fallback(); return { result: titles, degraded: false }; }
      const result: Row = { ...titles };
      if (mode === "missing") delete result.title_font_design;
      if (mode === "nonstring") result.title_animation = 42;
      if (mode === "overbudget") result.title_animation = "动".repeat(budgetFrom(prompt));
      if (mode === "music") result.opening_audio_design = "器物接触轻响；加入钢琴配乐。";
      if (mode === "mixed-speech") result.opening_audio_design = "器物接触轻响；禁台词但加入一句旁白。";
      if (mode === "mixed-music") result.opening_audio_design = "器物接触轻响；禁配乐但加入钢琴配乐。";
      if (mode === "unban-speech") result.opening_audio_design = "器物接触轻响；解禁台词。";
      if (mode === "unban-music") result.opening_audio_design = "器物接触轻响；解禁配乐。";
      if (mode === "prohibited-music") result.opening_audio_design = "器物接触轻响；加入一段违禁音乐。";
      return { result, degraded: mode === "degraded" };
    });
    try {
      const source = production();
      if (/^(?:mixed|unban)-/u.test(mode)) source.shots = source.prompts;
      const heldPrompts = source.prompts; const heldRow = source.prompts[0]!;
      const heldShots = source.shots; const heldShot = source.shots[0]!;
      const before = structuredClone(source);
      await expect(f.system._optimizeOpeningTitle(source, { stages: { adapter: { title: "器物工序" } } }, {}))
        .rejects.toThrow(/OPENING_TITLE_/u);
      expect(f.records).toHaveLength(0);
      expect(f.failure).toHaveBeenCalledOnce();
      expect(source).toEqual(before);
      expect(source.prompts).toBe(heldPrompts); expect(source.prompts[0]).toBe(heldRow);
      expect(source.shots).toBe(heldShots); expect(source.shots[0]).toBe(heldShot);
    } finally { f.close(); }
  });

it.each([false, true])("commits compact native title denials without changing shared aliases with noMusic=%s", async noMusic => {
  const audio = "器物触桌一声轻响；仅本镜现场声，禁配乐禁台词。";
  const authored = { ...titles, opening_audio_design: audio };
  const f = fixture(async () => ({ result: authored, degraded: false }));
  try {
    const source = production(); source.shots = source.prompts;
    const heldRows = source.prompts; const heldRow = source.prompts[0]!;
    (heldRow._workloomPromptReviewPolicy as NarrativePromptReviewPolicy).noMusic = noMusic;
    const originalFields = structuredClone(heldRow.fields);
    await f.system._optimizeOpeningTitle(source, { stages: { adapter: { title: "器物工序" } } }, {});
    expect(source.prompts).toBe(heldRows); expect(source.shots).toBe(heldRows);
    expect(source.prompts[0]).toBe(heldRow); expect(source.shots[0]).toBe(heldRow);
    for (const key of titleKeys) expect(heldRow[key]).toBe(authored[key as keyof typeof authored]);
    expect(heldRow.fields).toEqual(originalFields);
    expect(unicodeLength(String(heldRow.prompt))).toBeLessThanOrEqual(3000);
    expect(f.author).toHaveBeenCalledOnce();
    expect(f.records.map(record => record.stage)).toEqual(["OPENING_TITLE"]);
    const saved = f.records[0]!.output as { productionAfter: { prompts: Row[] } };
    expect(saved.productionAfter.prompts[0]!.opening_audio_design).toBe(audio);
    expect(f.failure).not.toHaveBeenCalled();
  } finally { f.close(); }
});

it("does not dispatch the native author when complete native content leaves no five-field capacity", async () => {
  const f = fixture(async () => ({ result: titles, degraded: false }));
  try {
    const source = production(4000); const before = structuredClone(source);
    await expect(f.system._optimizeOpeningTitle(source, {}, {})).rejects.toThrow(/OPENING_TITLE_CAPACITY/u);
    expect(f.author).not.toHaveBeenCalled(); expect(f.records).toHaveLength(0); expect(source).toEqual(before);
  } finally { f.close(); }
});

it("reuses fitting genuine title fields and leaves the nonmarketing native author prompt unchanged", async () => {
  const originalSystemPrompt = OpeningTitleOptimizer.prototype._getSystemPrompt;
  const originalSystemText = originalSystemPrompt.call(Object.create(OpeningTitleOptimizer.prototype));
  const f = fixture(async (prompt, _fallback, systemPrompt) => {
    expect(prompt).not.toContain("五字段字符串值合计最多");
    expect(systemPrompt).not.toContain("本次冻结片头合同优先于");
    return { result: titles, degraded: false };
  });
  try {
    const fitting = production();
    Object.assign(fitting.shots[0]!, titles); Object.assign(fitting.prompts[0]!, titles);
    await f.system._optimizeOpeningTitle(fitting, {}, {});
    expect(f.author).not.toHaveBeenCalled();
    const nonmarketing = production();
    delete (nonmarketing.prompts[0]!._workloomPromptReviewPolicy as NarrativePromptReviewPolicy).marketingPrompt;
    await f.system._optimizeOpeningTitle(nonmarketing, {}, {});
    expect(f.author).toHaveBeenCalledOnce();
    expect(f.records).toHaveLength(2);
  } finally {
    f.close();
    expect(OpeningTitleOptimizer.prototype._getSystemPrompt).toBe(originalSystemPrompt);
    expect(OpeningTitleOptimizer.prototype._getSystemPrompt.call(Object.create(OpeningTitleOptimizer.prototype)))
      .toBe(originalSystemText);
  }
});

it("invalidates only the old title policy while reusing current production and every upstream policy", async () => {
  const seed = "same seed"; const input = { same: "frozen" };
  const prior = [ ["G2_THEME", "theme-input-and-brief/v1"], ["G3_INSIGHT", "source-bound-discovery-and-assumptions/v2"],
    ["G3_PROFILE", "native-source-aware-production-profile/v2"], ["G4_PRD", "source-bound-prd-native-local-contract/v3"],
    ["SCRIPT", "native-script-and-metadata/v1"], ["PRODUCTION", "native-production-camera-repair-feedback/v16"],
    ["OPENING_TITLE", "native-opening-title-fields/v1"] ] as const;
  const records = new Map<string, StudioEngineCheckpoint>();
  const key = (r: StudioCheckpointRequest) => `${r.stage}/${r.inputSha256}/${r.dependencySha256}`;
  let dependencySha256 = studioCheckpointHash(seed);
  for (const [stage, policyVersion] of prior) {
    const output = { stage, retained: true }; const outputSha256 = studioCheckpointHash(output);
    const inputSha256 = studioCheckpointHash({ policyVersion, input });
    const record: StudioEngineCheckpoint = { schemaVersion: "workloom.studio-engine-checkpoint/v1", stage,
      inputSha256, dependencySha256, output, outputSha256 };
    records.set(key(record), record);
    dependencySha256 = studioCheckpointHash({ previous: dependencySha256, stage, inputSha256, outputSha256 });
  }
  const runner = createStudioCheckpointRunner({ load: async request => records.get(key(request)) ?? null,
    save: async record => { records.set(key(record), record); } }, seed);
  const author = vi.fn(async () => ({ title: "new complete title" }));
  for (const [stage] of prior) {
    const output = await runner.run(stage, input, author);
    if (stage !== "OPENING_TITLE") expect(output).toEqual({ stage, retained: true });
    else expect(output).toEqual({ title: "new complete title" });
  }
  expect(author).toHaveBeenCalledOnce();
});

it.each(["native-production-camera-repair-feedback/v11", "native-production-camera-repair-feedback/v15"])(
  "invalidates previous production writer %s and its title descendant while retaining every upstream station", async priorProduction => {
  const seed = "same production input"; const input = { scenes: "same", feedback: "same" };
  const prior = [["G2_THEME", "theme-input-and-brief/v1"], ["G3_INSIGHT", "source-bound-discovery-and-assumptions/v2"],
    ["G3_PROFILE", "native-source-aware-production-profile/v2"], ["G4_PRD", "source-bound-prd-native-local-contract/v3"],
    ["SCRIPT", "native-script-and-metadata/v1"], ["PRODUCTION", priorProduction],
    ["OPENING_TITLE", "native-opening-title-fields/v2"]] as const;
  const records = new Map<string, StudioEngineCheckpoint>();
  const key = (record: StudioCheckpointRequest) => `${record.stage}/${record.inputSha256}/${record.dependencySha256}`;
  let dependencySha256 = studioCheckpointHash(seed);
  for (const [stage, policyVersion] of prior) {
    const output = { stage, retained: true }; const outputSha256 = studioCheckpointHash(output);
    const inputSha256 = studioCheckpointHash({ policyVersion, input });
    const record: StudioEngineCheckpoint = { schemaVersion: "workloom.studio-engine-checkpoint/v1", stage,
      inputSha256, dependencySha256, output, outputSha256 };
    records.set(key(record), record);
    dependencySha256 = studioCheckpointHash({ previous: dependencySha256, stage, inputSha256, outputSha256 });
  }
  const runner = createStudioCheckpointRunner({ load: async request => records.get(key(request)) ?? null,
    save: async record => { records.set(key(record), record); } }, seed);
  const authored: string[] = [];
  for (const [stage] of prior) {
    const output = await runner.run(stage, input, async () => { authored.push(stage); return { stage, rewritten: true }; });
    expect(output).toEqual(stage === "PRODUCTION" || stage === "OPENING_TITLE"
      ? { stage, rewritten: true } : { stage, retained: true });
  }
  expect(authored).toEqual(["PRODUCTION", "OPENING_TITLE"]);
});
