import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { installVendorPhase3FusionBridge } from "./vendor-compat.js";
import { videoRuntimeRoot } from "./runtime-root.js";

type Row = Record<string, unknown>;
type Fields = Record<string, unknown>;
interface NativeAgent {
  consistencyChecker: { logLevel: string };
  _llmEngineLoaded: boolean;
  _currentShotIdx?: number;
  _callLLM(prompt: string, schema: Row, ...rest: unknown[]): Promise<Row>;
  _saveSubCheckpoint(manager: Row, hash: string, rows: Row[], completed: number, total: number): void;
  process(shots: Row[], blueprint: Row, options: Row): Promise<Row>;
}
interface Plan {
  fields: Fields;
  fill?: Fields;
  batch?: Fields;
  firstPrimaryDegraded?: boolean;
}
interface Call { kind: "primary" | "fill" | "batch"; shotId: string; requested: string[]; ordinal: number }
interface Run { rows: Row[]; state: { result: { stages: Record<string, Row> } }; directory: string; error: string }

const require = createRequire(import.meta.url);
const vendor = resolve(videoRuntimeRoot(import.meta.url), "vendor/supermickey/hyperreality-system");
const { PromptFusionAgent } = require(resolve(vendor, "engines/production-engine/agents/prompt-fusion-agent.js"));
const { Phase3PromptFusion } = require(resolve(vendor, "engines/production-engine/phases/phase-3-prompt-fusion.js"));
const nativeProcess = PromptFusionAgent.prototype.process as NativeAgent["process"];
const marker = "_workloomMarketingFieldWriterPolicy";
const currentPolicy = "native-marketing-field-authority/v5";
const silentRequirement = "本片无台词、无对白、无旁白；只保留动作和环境声。";
const stop = "DIALOGUE_CONTRACT_FIXTURE_STOP_WITHOUT_PRODUCTION_APPROVAL";

function detailed(text: string, minimum: number): string {
  let result = text;
  while (Array.from(result).length < minimum) result += text;
  return result;
}

// Complete synthetic author fields keep real native completeness, checker and
// assembly active. Only _callLLM is replaced; no delivery result is approved.
function authoredFields(): Fields {
  return {
    director_instruction: detailed("纪实摄影记录登记演员在工坊通道完成本镜动作，保留真实受力与环境材质，机位与光源服从本镜设计。", 80),
    constraint: "9:16画幅，4K分辨率，24fps，MP4格式。",
    baseline: "电影级写实材质，保留衣料纤维、地面磨损与自然颗粒。",
    scene: detailed("工坊通道内，灰墙与粗糙地面构成纵深，演员沿地面标记依次调整工具的位置，背景没有标牌或文字。", 120),
    lighting: detailed("左上方4300K灯具以柔光照向通道，光比2:1，暗部保留轮廓与衣料层次；人物经过灯位时肩线高光自然移动，光源位置与方向全程不变。", 150),
    composition: detailed("中景取景，演员位于中央偏右，金属工具与双手完整入画，通道边缘形成纵深引导，起幅落幅保持相同人物比例。", 100),
    color_palette: detailed("中性灰为主，衣料本色与地面材质形成分层，肤色保持真实，饱和度克制，明暗围绕主体展开。", 80),
    depth_of_field: detailed("使用f/5.6，焦点锁定演员与金属工具所在平面，前后景层次自然，人物轮廓与工具边缘清晰，背景纹理可辨。", 80),
    camera_movement: detailed("稳定器保持中景，沿通道与演员平行向右移动，起幅锁定右肩，落幅保持人物和工具比例，全程只沿一条平行轨迹运动。", 100),
    character: "登记演员林舟穿灰色工作外套，身份和发型与登记资料一致，双手握持金属工具。",
    costume: "灰色工作外套，左袖保留油渍，领口扣合。",
    makeup: "额头有汗水，左颊保留一道灰尘痕迹。",
    action: detailed("演员右手转动工具，左手托住底部，右脚踏过第一处标记，手腕保持同一平面，经过第二处标记后把工具移至胸前，动作依受力关系连续展开。", 120),
    props: "金属工具边缘有磨损，握柄缠有灰色胶带。",
    portraits: "登记演员已授权的身份参考图。",
    dialogue: "",
    timeline: detailed("T00:00—T00:02 演员经过第一处标记，工具保持水平；T00:02—T00:04 右手调整握持，左手托住底部；T00:04—T00:06 工具移至胸前，人物与镜头同向经过第二处标记，全程保留完整动作关系。", 200),
    mood: "专注观察动作与受力，情绪服从本镜明确设计。",
    pacing: "动作依次展开，前后衔接连续，镜头保持观察距离。",
    transition: "本镜动作结束后硬切，保持屏幕方向连续。",
    audio: detailed("环境风声、鞋底摩擦与金属工具接触衣料的声音同步，现场仅有不可辨呼吸声，不含可辨语句，各声音随人物位置自然变化。", 100),
    negative: "禁止水印、失真肢体、虚构物件与不连续动作。",
    bright_constraint: "主体轮廓清晰可辨，阴影保留层次。",
    character_constraint: "只出现登记演员，保持同一身份与既有服装状态。",
    consistency: "人物身份、工具形状、光源方位与动作方向跨帧一致。",
  };
}

function sourceShot(id = "S4", sceneType = "emotional_climax"): Row {
  return { shotId: id, sceneType, duration: 6, scene: "工坊通道内的连续操作。", action: "演员调整工具的位置。",
    character: "林舟", characters: ["林舟"], dialogue: "", dialogueText: "", dialogueBlocks: [],
    cameraString: "中景平行移动观察人物与工具。" };
}

function blueprint(options: { requirement?: string | null; policy?: string | null; marketing?: boolean } = {}): Row {
  const requirement = options.requirement === undefined ? silentRequirement : options.requirement;
  const policy = options.policy === undefined ? currentPolicy : options.policy;
  return { title: "原生无台词字段合同", genre: "纪录片", config: { aspectRatio: "9:16", target_duration: 6 },
    character_system: { characters: [] }, ...(policy === null ? {} : { [marker]: policy }),
    meta: { _metadata: { ...(requirement === null ? {} : { dialogueRequirement: requirement }),
      _prd: options.marketing === false ? {} : { _workloomMarketingPrompt: { actions: [], overlay: [], endCard: [] } } } } };
}

function fixture(plans: Map<string, Plan>, options: { hostRepair?: boolean; beforePrimary?: (id: string) => Promise<void> } = {}) {
  const agent = new PromptFusionAgent({ semanticRefinement: false }) as NativeAgent;
  agent.consistencyChecker.logLevel = "silent";
  const calls: Call[] = [];
  const primaryCounts = new Map<string, number>();
  const scopes = new WeakMap<object, Row[]>();
  const captures = new Map<string, Row[]>();
  const directories: string[] = [];
  const seeds = new Map<string, Row[]>();
  const locate = (receiver: object, schema: Row): string => {
    if (typeof schema.shotId === "string") return schema.shotId;
    for (let owner: object | null = receiver; owner; owner = Object.getPrototypeOf(owner) as object | null) {
      const rows = scopes.get(owner);
      if (rows) return String(rows[(receiver as NativeAgent)._currentShotIdx ?? 0]?.shotId ?? "");
    }
    throw new Error("Synthetic reply cannot locate the real current native shot");
  };
  agent._callLLM = vi.fn(async function syntheticTransport(this: NativeAgent, _prompt: string, schema: Row): Promise<Row> {
    if ((schema.required as string[] | undefined)?.includes("picks")) return { result: { picks: [] }, degraded: false };
    const primary = schema.shots as Array<{ shotId: string }> | undefined;
    const id = Array.isArray(primary) ? String(primary[0]?.shotId) : locate(this, schema);
    const plan = plans.get(id);
    if (!plan) throw new Error(`Unexpected synthetic author shot ${id}`);
    if (Array.isArray(primary)) {
      const ordinal = (primaryCounts.get(id) ?? 0) + 1;
      primaryCounts.set(id, ordinal);
      calls.push({ kind: "primary", shotId: id, requested: Object.keys(plan.fields), ordinal });
      await options.beforePrimary?.(id);
      return { result: { shots: [{ shotId: id, fields: structuredClone(plan.fields) }] },
        degraded: plan.firstPrimaryDegraded === true && ordinal === 1 };
    }
    if (!schema.fields || typeof schema.fields !== "object") throw new Error("Unexpected non-author synthetic schema");
    const kind = typeof schema.shotId === "string" ? "fill" : "batch";
    calls.push({ kind, shotId: id, requested: Object.keys(schema.fields as Row), ordinal: calls.length + 1 });
    return { result: { fields: structuredClone((kind === "fill" ? plan.fill : plan.batch) ?? { dialogue: "" }) }, degraded: false };
  });
  agent.process = async function observeRealNativeProcess(this: NativeAgent, shots: Row[], current: Row, opts: Row) {
    scopes.set(this, shots);
    const seed = seeds.get(String(shots[0]?.shotId));
    if (seed) this._saveSubCheckpoint(opts.checkpointManager as Row, String(opts.blueprintHash), seed, seed.length, shots.length);
    const result = await nativeProcess.call(this, shots, current, opts);
    captures.set(String(shots[0]?.shotId), result.shots as Row[]);
    if (options.hostRepair) return result;
    throw new Error(stop);
  };
  const run = async (shots: Row[], current = blueprint(), seed?: Row[]): Promise<Run> => {
    const before = structuredClone({ shots, current });
    if (seed) seeds.set(String(shots[0]?.shotId), seed);
    const directory = mkdtempSync(join(tmpdir(), "native-dialogue-contract-"));
    directories.push(directory);
    const saveCheckpoint = vi.fn(async () => { throw new Error(stop); });
    const phase = new Phase3PromptFusion({ agents: { promptFusion: agent }, cloneShots: structuredClone,
      checkpointManager: { baseDir: directory }, saveCheckpoint, logFn: () => undefined });
    const state = { shots, adaptedBlueprint: current, result: { stages: {} as Record<string, Row>, llmStats: {} } };
    let error = "";
    try { await phase.execute(state); } catch (caught) { error = String(caught); }
    if (!options.hostRepair) {
      expect(error).toContain(stop);
      expect(saveCheckpoint).not.toHaveBeenCalled();
    } else {
      expect(error).toMatch(/PHASE3_|FUSION_|SKILL_|DIALOGUE_CONTRACT_FIXTURE_STOP/);
    }
    expect(state.result.stages.phase3Fusion?.status).not.toBe("passed");
    expect({ shots, current }).toEqual(before);
    expect(agent._llmEngineLoaded).toBe(false);
    const rows = captures.get(String(shots[0]?.shotId));
    if (!rows) throw new Error("Real native process did not produce the observed raw rows");
    expect(JSON.stringify(rows)).not.toContain("_isFieldSemanticallyComplete");
    return { rows, state, directory, error };
  };
  const runNative = async (shots: Row[], current = blueprint()) => {
    scopes.set(agent, shots);
    const result = await nativeProcess.call(agent, shots, current, {});
    expect(agent._llmEngineLoaded).toBe(false);
    return result.shots as Row[];
  };
  const savedRows = (run: Run): Row[] => readdirSync(run.directory)
    .filter(name => /^checkpoint-phase3-.*\.json$/.test(name))
    .flatMap(name => (JSON.parse(readFileSync(join(run.directory, name), "utf8")) as { results: Row[] }).results);
  const cleanup = () => { for (const directory of directories) rmSync(directory, { recursive: true, force: true }); };
  return { agent, calls, run, runNative, savedRows, cleanup };
}

function rowFields(row: Row): Fields { return row.fields as Fields; }
function expectSilent(row: Row): void {
  expect(row.degraded).toBe(false);
  expect(Object.hasOwn(rowFields(row), "dialogue")).toBe(true);
  expect(rowFields(row).dialogue).toBe("");
  expect(String(row.prompt)).not.toMatch(/规则兜底|dialogue 默认值|has_dialogue|\[object Object\]/);
  expect(row).not.toHaveProperty("_workloomFusion");
}

it("accepts an author's own empty dialogue under the frozen silent contract with one real primary author call", async () => {
  const uninstall = installVendorPhase3FusionBridge();
  const f = fixture(new Map([["S4", { fields: authoredFields() }]]));
  try {
    const result = await f.run([sourceShot()]);
    expectSilent(result.rows[0]!);
    expect(f.calls.map(call => call.kind)).toEqual(["primary"]);
    expectSilent(f.savedRows(result)[0]!);
  } finally { f.cleanup(); uninstall(); }
});

it("accepts an authored empty array only after the real normalizer has made it an owned empty dialogue field", async () => {
  const uninstall = installVendorPhase3FusionBridge();
  const fields = { ...authoredFields(), dialogue: [] };
  const f = fixture(new Map([["S4", { fields }]]));
  try {
    expectSilent((await f.run([sourceShot()])).rows[0]!);
    expect(f.calls.map(call => call.kind)).toEqual(["primary"]);
  } finally { f.cleanup(); uninstall(); }
});

it("does not prefill a missing dialogue key and accepts the actual directed author reply containing an explicit empty value", async () => {
  const uninstall = installVendorPhase3FusionBridge();
  const fields = authoredFields(); delete fields.dialogue;
  const f = fixture(new Map([["S4", { fields, fill: { dialogue: "" } }]]));
  try {
    expectSilent((await f.run([sourceShot()])).rows[0]!);
    expect(f.calls.map(call => [call.kind, call.requested])).toEqual([
      ["primary", Object.keys(fields)], ["fill", ["dialogue"]],
    ]);
  } finally { f.cleanup(); uninstall(); }
});

it("repairs only genuinely short lighting while keeping the author's existing empty dialogue complete", async () => {
  const uninstall = installVendorPhase3FusionBridge();
  const goodLighting = authoredFields().lighting;
  const fields = { ...authoredFields(), lighting: "左侧柔光。" };
  const f = fixture(new Map([["S4", { fields, fill: { lighting: goodLighting, dialogue: "" } }]]));
  try {
    const row = (await f.run([sourceShot()])).rows[0]!;
    expectSilent(row);
    expect(rowFields(row).lighting).toBe(goodLighting);
    expect(f.calls.filter(call => call.kind !== "primary")).toEqual([
      expect.objectContaining({ kind: "fill", requested: ["lighting"] }),
    ]);
  } finally { f.cleanup(); uninstall(); }
});

it.each([
  { label: "spoken contract", requirement: "本镜需要角色说出：工具已经放好。" },
  { label: "no lip sync but voiceover permitted", requirement: "无台词，但允许旁白" },
  { label: "unknown speech contract", requirement: null },
])("keeps empty dialogue degraded and rejected by the real host retry under a $label", async ({ requirement }) => {
  const uninstall = installVendorPhase3FusionBridge();
  const f = fixture(new Map([["S4", { fields: authoredFields() }]]), { hostRepair: true });
  try {
    const result = await f.run([sourceShot()], blueprint({ requirement }));
    expect(result.rows[0]!.degraded).toBe(true);
    expect(result.error).toContain("PHASE3_FUSION_RETRY_UNVERIFIED");
    expect(f.calls.filter(call => call.kind === "primary")).toHaveLength(2);
    expect(result.state.result.stages.phase3Retry).toBeUndefined();
  } finally { f.cleanup(); uninstall(); }
});

it("preserves actual authored spoken dialogue and does not introduce a silent-field exemption into it", async () => {
  const uninstall = installVendorPhase3FusionBridge();
  const spoken = "工具已经放好。";
  const f = fixture(new Map([["S4", { fields: { ...authoredFields(), dialogue: spoken } }]]));
  try {
    const row = (await f.run([sourceShot()], blueprint({ requirement: "本镜需要对白：工具已经放好。" }))).rows[0]!;
    expect(row.degraded).toBe(false);
    expect(rowFields(row).dialogue).toBe(spoken);
    expect(String(row.prompt)).toContain(spoken);
    expect(f.calls.map(call => call.kind)).toEqual(["primary"]);
  } finally { f.cleanup(); uninstall(); }
});

it.each([
  { label: "no marker", policy: null, marketing: true },
  { label: "old v2 marker", policy: "native-marketing-field-authority/v2", marketing: true },
  { label: "non-marketing input", policy: currentPolicy, marketing: false },
])("retains the original native missing-field behavior for $label", async ({ policy, marketing }) => {
  const uninstall = installVendorPhase3FusionBridge();
  const f = fixture(new Map([["S4", { fields: authoredFields() }]]));
  try {
    const row = (await f.run([sourceShot()], blueprint({ policy, marketing }))).rows[0]!;
    expect(row.degraded).toBe(true);
    expect(f.calls.map(call => call.kind)).toEqual(["primary", "fill", "batch"]);
    expect(rowFields(row).dialogue).toBe("[规则兜底] dialogue 默认值");
  } finally { f.cleanup(); uninstall(); }
});

it("keeps a genuinely missing other field degraded instead of using the dialogue exception as a blanket pass", async () => {
  const uninstall = installVendorPhase3FusionBridge();
  const fields = authoredFields(); delete fields.audio;
  const f = fixture(new Map([["S4", { fields, fill: { audio: "" }, batch: { audio: "" } }]]));
  try {
    const row = (await f.run([sourceShot()])).rows[0]!;
    expect(row.degraded).toBe(true);
    expect(rowFields(row).dialogue).toBe("");
    expect(f.calls.filter(call => call.kind !== "primary").flatMap(call => call.requested)).toEqual(["audio", "audio"]);
  } finally { f.cleanup(); uninstall(); }
});

it("leaves the default native path strict when no host bridge has installed a scoped semantic exception", async () => {
  const f = fixture(new Map([["S4", { fields: authoredFields() }]]));
  try {
    const rows = await f.runNative([sourceShot()]);
    expect(rows[0]!.degraded).toBe(true);
    expect(f.calls.map(call => call.kind)).toEqual(["primary", "fill", "batch"]);
  } finally { f.cleanup(); }
});

it("isolates silent and spoken contracts in concurrent real runs sharing one native base agent", async () => {
  const uninstall = installVendorPhase3FusionBridge();
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let entered = 0;
  const f = fixture(new Map([["SILENT", { fields: authoredFields() }], ["SPOKEN", { fields: authoredFields() }]]), {
    beforePrimary: async () => { if (++entered === 2) release(); await barrier; },
  });
  try {
    const [silent, spoken] = await Promise.all([
      f.run([sourceShot("SILENT")], blueprint()),
      f.run([sourceShot("SPOKEN")], blueprint({ requirement: "本镜必须有实际对白。" })),
    ]);
    expectSilent(silent.rows[0]!);
    expect(spoken.rows[0]!.degraded).toBe(true);
    expect(f.calls.filter(call => call.shotId === "SILENT").map(call => call.kind)).toEqual(["primary"]);
    expect(f.calls.filter(call => call.shotId === "SPOKEN").map(call => call.kind)).toEqual(["primary", "fill", "batch"]);
  } finally { release(); f.cleanup(); uninstall(); }
});

it("loads a genuine native partial checkpoint without reauthoring its completed prefix", async () => {
  const uninstall = installVendorPhase3FusionBridge();
  const f = fixture(new Map([["S1", { fields: authoredFields() }], ["S4", { fields: authoredFields() }]]));
  try {
    // The prefix is produced by actual native fusion, never stamped as approved.
    const prefix = await f.runNative([sourceShot("S1", "action")]);
    const result = await f.run([sourceShot("S1", "action"), sourceShot()], blueprint(), prefix);
    expect(result.rows[0]).toEqual(prefix[0]);
    expectSilent(result.rows[1]!);
    expect(f.calls.filter(call => call.kind === "primary").map(call => call.shotId)).toEqual(["S1", "S4"]);
    expect(f.calls.filter(call => call.kind !== "primary")).toHaveLength(0);
    expect(f.savedRows(result)).toHaveLength(2);
  } finally { f.cleanup(); uninstall(); }
});

it("performs a true host single-shot author retry and preserves the prior degraded flag until a fresh valid result exists", async () => {
  const uninstall = installVendorPhase3FusionBridge();
  const f = fixture(new Map([["S4", { fields: authoredFields(), firstPrimaryDegraded: true }]]), { hostRepair: true });
  try {
    const result = await f.run([sourceShot()]);
    expect(result.rows[0]!.degraded).toBe(true);
    expect(f.calls.map(call => call.kind)).toEqual(["primary", "primary"]);
    expect(result.error).not.toContain("PHASE3_FUSION_RETRY_UNVERIFIED");
    expect(result.state.result.stages.phase3Retry).toMatchObject({ repaired: ["S4"], mode: "single-shot-llm-retry", rawCheckpointSaved: true });
    const saved = f.savedRows(result);
    expect(saved).toHaveLength(1);
    expectSilent(saved[0]!);
    expect(result.rows[0]!.degraded).toBe(true);
  } finally { f.cleanup(); uninstall(); }
});
