import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { installVendorPhase3FusionBridge } from "./vendor-compat.js";
import { videoRuntimeRoot } from "./runtime-root.js";

type Row = Record<string, unknown>;
type Fields = Record<string, string>;
interface AuthorContext {
  schemaVersion: string;
  mode: string;
  targetShotId: string;
  sourcePlan: Row[];
  authoredDrafts: Array<{ shotId: string; origin: string; degraded: boolean; fields: Fields }>;
  registeredCharacters?: Row[];
}
interface NativeAgent {
  consistencyChecker: { logLevel: string };
  _llmEngineLoaded: boolean;
  _cameraPlans?: Row[];
  _currentShotIdx?: number;
  _callLLM(prompt: string, schema: Row, ...rest: unknown[]): Promise<Row>;
  _saveSubCheckpoint(manager: Row, hash: string, rows: Row[], completed: number, total: number): void;
  _buildBatchPrompt(shots: Row[], ratio: string, characters: Row[], blueprint: Row): string;
  process(shots: Row[], blueprint: Row, options: Row): Promise<Row>;
}
interface Capture { shotId: string; prompt: string; rawPrompt: string; ordinal: number }

const require = createRequire(import.meta.url);
const vendor = resolve(videoRuntimeRoot(import.meta.url), "vendor/supermickey/hyperreality-system");
const { PromptFusionAgent } = require(resolve(vendor, "engines/production-engine/agents/prompt-fusion-agent.js"));
const { Phase3PromptFusion } = require(resolve(vendor, "engines/production-engine/phases/phase-3-prompt-fusion.js"));
const nativeProcess = PromptFusionAgent.prototype.process as NativeAgent["process"];
const prefix = "【本轮跨镜作者上下文】\n";
const boundary = "\n【跨镜执行边界】";
const stop = "CROSS_SHOT_FIXTURE_STOP_AFTER_REAL_NATIVE_PROCESS";
const marker = "_workloomMarketingFieldWriterPolicy";
const currentPolicy = "native-marketing-field-authority/v2";
const privateContext = /workloom\.native-shot-author-context\/v1|【本轮跨镜作者上下文】|_workloomSetFusionDraftRows|"sourcePlan"|"authoredDrafts"/;

function expectNoAuthorContext(rows: Row[]): void {
  expect(JSON.stringify(rows)).not.toMatch(privateContext);
}

function detailed(text: string, minimum: number): string {
  let result = text;
  while (Array.from(result).length < minimum) result += text;
  return result;
}

// Every native minimum-length field is authored here. The sole synthetic
// boundary is _callLLM; process, fusion, checker, assembly and checkpoint I/O run.
function authoredFields(tag: string): Fields {
  return {
    director_instruction: detailed(`${tag}：纪实摄影记录登记演员在工坊通道完成本镜动作，保留真实受力与环境材质，机位与光源服从本镜设计。`, 80),
    constraint: "9:16画幅，4K分辨率，24fps，MP4格式。",
    baseline: "电影级写实材质，保留衣料纤维、地面磨损与自然颗粒。",
    scene: detailed(`${tag}：工坊通道内，灰墙与粗糙地面构成纵深，演员沿地面标记依次调整工具的位置，背景没有标牌或文字。`, 120),
    lighting: detailed("左上方4300K灯具以柔光照向通道，光比2:1，暗部保留轮廓与衣料层次；人物经过灯位时肩线高光自然移动，光源位置与方向全程不变。", 150),
    composition: detailed(`${tag}：中景取景，演员位于中央偏右，金属工具与双手完整入画，通道边缘形成纵深引导，起幅落幅保持相同人物比例。`, 100),
    color_palette: detailed("中性灰为主，衣料本色与地面材质形成分层，肤色保持真实，饱和度克制，明暗围绕主体展开。", 80),
    depth_of_field: detailed("使用f/5.6，焦点锁定演员与金属工具所在平面，前后景层次自然，人物轮廓与工具边缘清晰，背景纹理可辨。", 80),
    camera_movement: detailed(`${tag}：稳定器保持中景，沿通道与演员平行向右移动，起幅锁定右肩，落幅保持人物和工具比例，全程只沿一条平行轨迹运动。`, 100),
    character: "登记演员林舟，身份和发型与登记资料一致，双手握持金属工具。",
    costume: `${tag}：灰色工作外套左袖留有油渍，领口扣合。`,
    makeup: `${tag}：额头有汗水，左颊保留一道灰尘痕迹。`,
    action: detailed(`${tag}：演员右手转动工具，左手托住底部，右脚踏过第一处标记，手腕保持同一平面，经过第二处标记后把工具移至胸前，动作依受力关系连续展开。`, 120),
    props: `${tag}：金属工具边缘有磨损，握柄缠有灰色胶带。`,
    portraits: "登记演员已授权的身份参考图。",
    dialogue: "",
    timeline: detailed(`${tag}：T00:00—T00:02 演员经过第一处标记，工具保持水平；T00:02—T00:04 右手调整握持，左手托住底部；T00:04—T00:06 工具移至胸前，人物与镜头同向经过第二处标记，全程保留完整动作关系。`, 200),
    mood: "专注观察动作与受力，情绪服从本镜明确设计。",
    pacing: "动作依次展开，前后衔接连续，镜头保持观察距离。",
    transition: `${tag}：本镜动作结束后硬切，保持屏幕方向连续。`,
    audio: detailed("环境风声、鞋底摩擦与金属工具接触衣料的声音同步，现场仅有不可辨呼吸声，不含可辨语句，各声音随人物位置自然变化。", 100),
    negative: "禁止水印、失真肢体、虚构物件与不连续动作。",
    bright_constraint: "主体轮廓清晰可辨，阴影保留层次。",
    character_constraint: "只出现登记演员，保持同一身份与既有服装状态。",
    consistency: "人物身份、工具形状、光源方位与动作方向跨帧一致。",
  };
}

function sourceRows(ids = ["S1", "S2", "S3"]): Row[] {
  return ids.map((shotId, index) => ({
    shotId, sceneType: "action", duration: 6, scene: `原始场景${shotId}：工坊内的连续通道。`,
    action: `原始动作${shotId}：登记演员仅完成第${index + 1}项工具操作。`,
    character: "林舟", characters: ["林舟"], costume: "源计划灰色工作外套", makeup: "源计划自然妆容", props: "源计划金属工具",
    cameraString: `静态旧规划${shotId}：固定机位观察工具。`, composition: "大特写", transition: "源计划硬切",
  }));
}

function blueprint(policy: string | null = currentPolicy, marketing = true): Row {
  return {
    title: "跨镜作者上下文契约", genre: "纪录片", config: { aspectRatio: "9:16", target_duration: 18 },
    character_system: { characters: [{ id: "fallback", name: "旧登记演员", description: "回退资料" }] },
    ...(policy === null ? {} : { [marker]: policy }),
    meta: { _metadata: { _prd: {
      ...(marketing ? { _workloomMarketingPrompt: { actions: [], overlay: [], endCard: [] } } : {}),
      characterSystem: { characters: [{ id: "C1", name: "林舟", gender: "女", description: "登记女性演员，短发。" },
        { id: "C2", name: "夏远", description: "登记演员，性别资料未提供。" }] },
    } } },
  };
}

function context(capture: Capture): AuthorContext {
  expect(capture.prompt.split(prefix)).toHaveLength(2);
  const start = capture.prompt.indexOf(prefix) + prefix.length;
  const end = capture.prompt.indexOf(boundary, start);
  expect(end).toBeGreaterThan(start);
  const serialized = capture.prompt.slice(start, end);
  expect(serialized).not.toContain("\n");
  const value = JSON.parse(serialized) as AuthorContext;
  expect(value.schemaVersion).toBe("workloom.native-shot-author-context/v1");
  expect(value.targetShotId).toBe(capture.shotId);
  return value;
}

function fixture(replies: Map<string, Fields>, options: {
  seed?: Row[];
  lateRepair?: boolean;
  beforeReply?: (id: string) => Promise<void>;
} = {}) {
  const agent = new PromptFusionAgent({ semanticRefinement: false }) as NativeAgent;
  agent.consistencyChecker.logLevel = "silent";
  const calls: Capture[] = [];
  const results = new Map<string, Row[]>();
  const directories: string[] = [];
  const sources = new Map<string, { row: Row; blueprint: Row }>();
  const counts = new Map<string, number>();
  const transport = vi.fn(async function syntheticTransport(this: NativeAgent, prompt: string, schema: Row): Promise<Row> {
    const shots = schema.shots as Array<{ shotId: string }> | undefined;
    if (Array.isArray(shots)) {
      const id = shots[0]?.shotId;
      const fields = id ? replies.get(id) : undefined;
      if (!id || !fields) throw new Error("Unexpected synthetic author shot");
      const ordinal = (counts.get(id) ?? 0) + 1;
      counts.set(id, ordinal);
      const source = sources.get(id);
      if (!source) throw new Error("Missing actual native source row");
      const characters = (source.blueprint.character_system as { characters?: Row[] }).characters ?? [];
      const rawPrompt = this._buildBatchPrompt([source.row], "9:16", characters, source.blueprint);
      calls.push({ shotId: id, prompt, rawPrompt, ordinal });
      await options.beforeReply?.(id);
      return { result: { shots: [{ shotId: id, fields: structuredClone(fields) }] },
        degraded: options.lateRepair === true && id === "S2" && ordinal === 1 };
    }
    if ((schema.required as string[] | undefined)?.includes("picks")) return { result: { picks: [] }, degraded: false };
    throw new Error(`Unexpected synthetic transport schema: ${JSON.stringify(schema)}`);
  });
  agent._callLLM = transport;
  agent.process = async function captureRealProcess(this: NativeAgent, shots: Row[], current: Row, opts: Row): Promise<Row> {
    for (const row of shots) sources.set(String(row.shotId), { row, blueprint: current });
    if (options.seed) this._saveSubCheckpoint(opts.checkpointManager as Row, String(opts.blueprintHash), options.seed, options.seed.length, shots.length);
    const result = await nativeProcess.call(this, shots, current, opts);
    results.set(String(shots[0]?.shotId), result.shots as Row[]);
    expectNoAuthorContext(result.shots as Row[]);
    if (options.lateRepair) return result;
    throw new Error(stop);
  };
  const run = async (shots: Row[], current = blueprint()) => {
    const inputBefore = structuredClone(shots);
    const blueprintBefore = structuredClone(current);
    const dir = mkdtempSync(join(tmpdir(), "native-cross-shot-"));
    directories.push(dir);
    const saveCheckpoint = vi.fn(async () => undefined);
    const phase = new Phase3PromptFusion({ agents: { promptFusion: agent }, cloneShots: structuredClone,
      checkpointManager: { baseDir: dir }, saveCheckpoint, logFn: () => undefined });
    const state = { shots, adaptedBlueprint: current, result: { stages: {} as Record<string, Row>, llmStats: {} } };
    if (options.lateRepair) {
      // The late native repair is the observed boundary; unrelated canonical
      // policies may reject afterward and are not asserted as a production pass.
      try { await phase.execute(state); } catch (error) {
        if (!String(error).includes("PHASE3_") && !String(error).includes("FUSION_") && !String(error).includes("SKILL_")) throw error;
      }
    } else {
      await expect(phase.execute(state)).rejects.toThrow(stop);
      expect(state.result.stages.phase3Fusion).toMatchObject({ status: "unverified", code: "PHASE3_EXECUTION_FAILED" });
      expect(saveCheckpoint).not.toHaveBeenCalled();
    }
    expect(agent._llmEngineLoaded).toBe(false);
    const nonPlannerDispatches = transport.mock.calls.filter(([, schema]) =>
      !(schema.required as string[] | undefined)?.includes("picks"));
    expect(nonPlannerDispatches).toHaveLength(calls.length);
    expect(shots).toEqual(inputBefore);
    expect(current).toEqual(blueprintBefore);
    const checkpoints = readdirSync(dir).filter(name => /^checkpoint-phase3-.*\.json$/.test(name));
    expect(checkpoints.length).toBeGreaterThan(0);
    for (const name of checkpoints) {
      const saved = JSON.parse(readFileSync(join(dir, name), "utf8")) as { results: Row[] };
      expect(saved.results.length).toBeGreaterThan(0);
      expectNoAuthorContext(saved.results);
    }
    return state;
  };
  const cleanup = () => { for (const dir of directories) rmSync(dir, { recursive: true, force: true }); };
  return { agent, calls, results, run, cleanup };
}

it("gives the first native author the complete source ownership plan but no future authored drafts, with measured prompt growth", async () => {
  const uninstall = installVendorPhase3FusionBridge();
  const rows = sourceRows();
  const f = fixture(new Map(rows.map(row => [String(row.shotId), authoredFields(String(row.shotId))])));
  try {
    await f.run(rows);
    const first = f.calls[0]!;
    const value = context(first);
    expect(value.mode).toBe("serial");
    expect(value.sourcePlan.map(row => row.shotId)).toEqual(["S1", "S2", "S3"]);
    for (const row of rows) expect(JSON.stringify(value.sourcePlan)).toContain(String(row.action));
    expect(value.authoredDrafts).toEqual([]);
    expect(f.calls.map(call => call.shotId)).toEqual(["S1", "S2", "S3"]);
    const addedCharacters = Array.from(first.prompt).length - Array.from(first.rawPrompt).length;
    expect(addedCharacters).toBeGreaterThan(0);
    console.info("CROSS_SHOT_PROMPT_GROWTH", JSON.stringify({ calls: f.calls.map(call => ({ shotId: call.shotId,
      nativePromptCharacters: Array.from(call.rawPrompt).length, contextualPromptCharacters: Array.from(call.prompt).length,
      addedCharacters: Array.from(call.prompt).length - Array.from(call.rawPrompt).length })),
    tokenCount: "UNVERIFIED", extraAuthorCalls: 0 }));
  } finally { f.cleanup(); uninstall(); }
});

it("feeds actual prior action, costume, makeup, prop wear and timeline into later authors and refreshes native neighbor camera data", async () => {
  const uninstall = installVendorPhase3FusionBridge();
  const rows = sourceRows();
  // Private enumerable metadata survives native cloning and hashing, so the
  // context projection itself must exclude it. Input remains acyclic/supported.
  rows[0]!._blueprint = { privateCanary: "PRIVATE_BLUEPRINT_MUST_NOT_LEAK" };
  rows[0]!._workloomFusion = { status: "unverified", privateCanary: "PRIVATE_STAMP_MUST_NOT_LEAK" };
  const fields = authoredFields("ACTUAL_FIRST_DRAFT");
  const f = fixture(new Map([["S1", fields], ["S2", authoredFields("SECOND")], ["S3", authoredFields("FUTURE")]]));
  try {
    await f.run(rows);
    const second = f.calls[1]!;
    const value = context(second);
    expect(value.authoredDrafts).toHaveLength(1);
    expect(value.authoredDrafts[0]).toMatchObject({ shotId: "S1", origin: "native-result", degraded: false });
    for (const key of ["action", "costume", "makeup", "props", "timeline", "composition", "camera_movement", "transition"]) {
      expect(value.authoredDrafts[0]!.fields[key]).toBe(fields[key]);
    }
    const neighbor = second.prompt.slice(second.prompt.indexOf("【邻镜协调上下文"));
    expect(neighbor).toContain(`上一镜 S1: 景别=${fields.composition}`);
    expect(neighbor).toContain(`运镜=${fields.camera_movement}`);
    expect(neighbor).not.toContain("静态旧规划S1");
    expect(JSON.stringify(value)).not.toMatch(/_blueprint|PRIVATE_BLUEPRINT_MUST_NOT_LEAK|_workloomFusion|PRIVATE_STAMP_MUST_NOT_LEAK|approved/);
    expect(value.authoredDrafts.some(row => row.shotId === "S2" || row.shotId === "S3")).toBe(false);
    expect(f.calls).toHaveLength(3);
  } finally { f.cleanup(); uninstall(); }
});

it("seeds genuine native partial-checkpoint drafts before resumed authoring without calling the resumed shot again", async () => {
  const uninstall = installVendorPhase3FusionBridge();
  const fields = authoredFields("RAW_CHECKPOINT_FIRST");
  const seed = { ...sourceRows()[0], fields, prompt: "原生断点保留的未审批提示词", degraded: false };
  const f = fixture(new Map([["S2", authoredFields("SECOND")], ["S3", authoredFields("THIRD")]]), { seed: [seed] });
  try {
    await f.run(sourceRows());
    expect(f.calls.map(call => call.shotId)).toEqual(["S2", "S3"]);
    const value = context(f.calls[0]!);
    expect(value.mode).toBe("serial");
    expect(value.authoredDrafts).toHaveLength(1);
    expect(value.authoredDrafts[0]).toMatchObject({ shotId: "S1", origin: "native-raw-checkpoint", degraded: false });
    expect(value.authoredDrafts[0]!.fields.action).toBe(fields.action);
    expect(value.authoredDrafts[0]!.fields.costume).toBe(fields.costume);
    expect(f.calls[0]!.prompt).toContain(`上一镜 S1: 景别=${fields.composition}`);
  } finally { f.cleanup(); uninstall(); }
});

it("gives a host late single-shot repair every other actual draft, including a later authored shot", async () => {
  const uninstall = installVendorPhase3FusionBridge();
  const f = fixture(new Map(["S1", "S2", "S3"].map(id => [id, authoredFields(`ACTUAL_${id}`)])), { lateRepair: true });
  try {
    await f.run(sourceRows());
    expect(f.calls.map(call => call.shotId)).toEqual(["S1", "S2", "S3", "S2"]);
    const serial = context(f.calls[1]!);
    expect(serial.authoredDrafts.map(row => row.shotId)).toEqual(["S1"]);
    const repair = context(f.calls[3]!);
    expect(repair.mode).toBe("targeted-repair");
    expect(repair.authoredDrafts.map(row => row.shotId)).toEqual(["S1", "S3"]);
    expect(repair.authoredDrafts[1]!.fields.props).toBe(authoredFields("ACTUAL_S3").props);
    expect(repair.authoredDrafts.every(row => row.origin === "native-result" && row.degraded === false)).toBe(true);
    expect(f.calls).toHaveLength(4);
  } finally { f.cleanup(); uninstall(); }
});

it("isolates two concurrent contexts on the same real base agent without leaking another run's source or draft state", async () => {
  const uninstall = installVendorPhase3FusionBridge();
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let entered = 0;
  const f = fixture(new Map(["A1", "A2", "B1", "B2"].map(id => [id, authoredFields(`DRAFT_${id}`)])), {
    beforeReply: async id => { if (id.endsWith("1")) { if (++entered === 2) release(); await barrier; } },
  });
  try {
    await Promise.all([f.run(sourceRows(["A1", "A2"])), f.run(sourceRows(["B1", "B2"]))]);
    for (const lane of ["A", "B"]) {
      const capture = f.calls.find(call => call.shotId === `${lane}2`)!;
      const value = context(capture);
      expect(value.sourcePlan.map(row => row.shotId)).toEqual([`${lane}1`, `${lane}2`]);
      expect(value.authoredDrafts.map(row => row.shotId)).toEqual([`${lane}1`]);
      expect(value.authoredDrafts[0]!.fields.costume).toContain(`DRAFT_${lane}1`);
      expect(JSON.stringify(value)).not.toContain(lane === "A" ? "DRAFT_B" : "DRAFT_A");
    }
    expect(f.calls).toHaveLength(4);
    expect(f.agent).not.toHaveProperty("_workloomNativeShotAuthorContext");
  } finally { release(); f.cleanup(); uninstall(); }
});

it.each([
  { label: "no marker", policy: null, marketing: true },
  { label: "old marker", policy: "native-marketing-field-authority/v1", marketing: true },
  { label: "non-marketing blueprint", policy: currentPolicy, marketing: false },
])("keeps the original native prompt path for $label", async ({ policy, marketing }) => {
  const uninstall = installVendorPhase3FusionBridge();
  const f = fixture(new Map([["S1", authoredFields("ORIGINAL_PATH")]]));
  try {
    await f.run(sourceRows(["S1"]), blueprint(policy, marketing));
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.prompt).not.toContain(prefix);
    expect(f.calls[0]!.prompt).toBe(f.calls[0]!.rawPrompt);
  } finally { f.cleanup(); uninstall(); }
});

it("projects registered identity facts from the PRD and preserves absent sex as unknown instead of guessing from a name", async () => {
  const uninstall = installVendorPhase3FusionBridge();
  const f = fixture(new Map([["S1", authoredFields("IDENTITY")]]));
  try {
    await f.run(sourceRows(["S1"]));
    const value = context(f.calls[0]!);
    expect(value.registeredCharacters).toEqual([
      { id: "C1", name: "林舟", gender: "女", description: "登记女性演员，短发。" },
      { id: "C2", name: "夏远", description: "登记演员，性别资料未提供。" },
    ]);
    expect(JSON.stringify(value.registeredCharacters)).not.toContain("旧登记演员");
    expect(value.registeredCharacters?.[1]).not.toHaveProperty("gender");
    expect(value.registeredCharacters?.[1]).not.toHaveProperty("sex");
    expect(f.calls).toHaveLength(1);
  } finally { f.cleanup(); uninstall(); }
});
