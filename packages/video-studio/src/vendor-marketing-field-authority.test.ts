import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { installVendorPhase3FusionBridge } from "./vendor-compat.js";
import { videoRuntimeRoot } from "./runtime-root.js";

type Row = Record<string, unknown>;
type Fields = Record<string, string>;
interface Issue {
  severity: string;
  fieldA: string;
  fieldB: string;
  message: string;
  fixable: boolean;
  fix?: (fields: Fields) => Partial<Fields> | null;
}
interface CheckResult { shotId: string; valid: boolean; warningCount: number; errorCount: number; issues: Issue[] }
interface Checker { check(shot: Row): CheckResult; autoFix(shot: Row): Row; logLevel: string }
interface NativeAgent {
  consistencyChecker: Checker;
  _llmEngineLoaded: boolean;
  _callLLM(prompt: string, schema: Row, ...rest: unknown[]): Promise<Row>;
  _fuseSingleShot(shot: Row, ratio: string, characters: Row[], blueprint: Row): Promise<Row>;
  process(shots: Row[], blueprint: Row, options: Row): Promise<never>;
}

const require = createRequire(import.meta.url);
const vendor = resolve(videoRuntimeRoot(import.meta.url), "vendor/supermickey/hyperreality-system");
const { PromptFusionAgent } = require(resolve(vendor, "engines/production-engine/agents/prompt-fusion-agent.js"));
const { Phase3PromptFusion } = require(resolve(vendor, "engines/production-engine/phases/phase-3-prompt-fusion.js"));
const { FieldConsistencyChecker } = require(resolve(vendor, "engines/field-consistency-checker.js"));
const marker = "_workloomMarketingFieldWriterPolicy";
const currentPolicy = "native-marketing-field-authority/v3";
const boundary = "FIELD_AUTHORITY_FIXTURE_STOP_AFTER_NATIVE_FUSION";
const cameraIssue = "动作快速但运镜没有快速/跟踪/手持";
const lightingIssue = "平静情绪需要均匀/柔光，当前灯光偏戏剧性 (mood: calm)";
const cameraPrefix = "fast handheld tracking following the action; ";
const lightingPrefix = "均匀柔光自然光，";

// All native minimum-length fields are supplied by the synthetic author reply.
// This fixture tests the real consistency/assembly path without invoking fill or fallback.
function detailed(text: string, minimum: number): string {
  let result = text;
  while (Array.from(result).length < minimum) result += text;
  return result;
}

function authoredFields(fastAction = true, calm = true): Fields {
  return {
    director_instruction: detailed("纪实摄影记录演员甲在摄影棚通道内完成连续动作，保留真实受力与环境材质，机位与光源服从本镜明确设计。", 80),
    constraint: "9:16画幅，4K分辨率，24fps，MP4格式。",
    baseline: "电影级写实材质，保留衣料纤维、地面磨损与自然颗粒。",
    scene: detailed("夜晚的封闭摄影棚通道，深灰墙面与粗糙地面构成可辨识的纵深，演员甲沿既定路线经过地面标记，背景没有标牌或文字。", 120),
    lighting: detailed("左上方4300K钨丝灯投下窄束硬光，光比4:1，暗部保留轮廓与衣料层次；演员经过灯位时高光沿肩线移动，背后的墙面保持深灰，光源位置与照射方向全程不变。", 150),
    composition: detailed("中景取景，演员甲位于画面中央偏右，金属工具与双手完整入画，通道边缘形成纵深引导，起幅与落幅保留相同人物比例。", 100),
    color_palette: detailed("中性灰为主，衣料本色与地面材质形成明确分层，肤色保持真实，饱和度克制，明暗层次围绕主体展开。", 80),
    depth_of_field: detailed("使用f/5.6，焦点锁定演员甲与金属工具所在平面，前后景层次自然，人物轮廓与工具边缘清晰，背景纹理仍可辨认。", 80),
    camera_movement: detailed("稳定器保持中景，与演员甲平行快速跟拍，镜头沿通道同向移动，起幅锁定右肩位置，落幅仍保持人物与工具的完整比例；全程沿单一平行轨迹运动，不切换机位。", 100),
    character: "演员甲穿灰色工作外套，双手握住金属工具，五官与发型保持一致。",
    costume: "灰色工作外套",
    makeup: "自然妆容，额头可见轻微汗水。",
    action: detailed(fastAction
      ? "演员甲握住金属工具沿摄影棚通道奔跑，右脚先踏过第一处标记，左手保持工具水平，肩部随步幅自然起伏，经过第二处标记后继续向前冲刺，动作依照真实惯性连续展开。"
      : "演员甲握住金属工具经过第一处地面标记，右手将工具转向通道另一侧，左手托住底部，手腕保持同一平面，经过第二处标记后把工具移到胸前，动作依照受力关系连续展开。", 120),
    props: "金属工具",
    portraits: "演员甲已登记的身份参考图。",
    dialogue: "",
    timeline: detailed("T00:00—T00:02 演员甲经过第一处标记，工具保持水平；T00:02—T00:04 右手调整握持位置，左手托住工具；T00:04—T00:06 人物与镜头继续沿同一方向经过第二处标记，画面始终呈现完整动作关系。", 200),
    mood: calm ? "平静而专注，注意力集中在完成既定动作。" : "专注观察动作与受力，不附加情绪风格。",
    pacing: "动作依次展开，前后衔接连续，镜头保持同一观察距离。",
    transition: "本镜动作完成后硬切到下一镜，保留方向连续。",
    audio: detailed("环境风声、鞋底摩擦地面与金属工具接触衣料的声音保持同步；现场人声仅为不可辨呼吸，不包含可辨语句，各声音随人物经过镜头的位置自然变化。", 100),
    negative: "禁止水印、失真肢体、虚构物件与不连续动作。",
    bright_constraint: "低照度下主体轮廓清晰可辨，阴影保留层次。",
    character_constraint: "只出现已登记的演员甲，保持同一身份与服装。",
    consistency: "人物身份、工具形状、光源方位与动作方向跨帧一致。",
  };
}

function blueprint(policy: string | null = currentPolicy, marketing = true): Row {
  return {
    title: "原生营销字段作者边界", genre: "纪录片", config: { aspectRatio: "9:16", target_duration: 6 },
    character_system: { characters: [] },
    ...(policy === null ? {} : { [marker]: policy }),
    meta: { _metadata: { _prd: marketing ? { _workloomMarketingPrompt: { actions: [], overlay: [], endCard: [] } } : {} } },
  };
}

function diagnostics(result: CheckResult) {
  return { shotId: result.shotId, valid: result.valid, warningCount: result.warningCount, errorCount: result.errorCount,
    issues: result.issues.map(({ severity, fieldA, fieldB, message, fixable }) => ({ severity, fieldA, fieldB, message, fixable })) };
}

function fieldValues(row: Row): Fields { return row.fields as Fields; }

function fixture(replies: Map<string, Fields>, beforeReply?: (shotId: string) => Promise<void>) {
  const agent = new PromptFusionAgent({ semanticRefinement: false }) as NativeAgent;
  agent.consistencyChecker.logLevel = "silent";
  const originalChecker = agent.consistencyChecker;
  const captures = new Map<string, { row: Row; diagnostics: ReturnType<typeof diagnostics> }>();
  const authorCalls: string[] = [];
  const transport = vi.fn(async (_prompt: string, schema: Row): Promise<Row> => {
    const shots = schema.shots as Array<{ shotId: string }> | undefined;
    if (Array.isArray(shots)) {
      const id = shots[0]?.shotId;
      const fields = id ? replies.get(id) : undefined;
      if (!id || !fields) throw new Error("Unknown synthetic author shot");
      authorCalls.push(id);
      await beforeReply?.(id);
      return { result: { shots: [{ shotId: id, fields: structuredClone(fields) }] }, degraded: false };
    }
    if ((schema.required as string[] | undefined)?.includes("picks")) return { result: { picks: [] }, degraded: false };
    throw new Error(`Unexpected synthetic transport schema: ${JSON.stringify(schema)}`);
  });
  agent._callLLM = transport;
  agent.process = vi.fn(async function captureNativeBoundary(this: NativeAgent, shots: Row[], current: Row) {
    const shot = shots[0]!;
    const id = String(shot.shotId);
    const fields = replies.get(id);
    if (!fields) throw new Error("Missing synthetic author reply");
    const report = diagnostics(this.consistencyChecker.check({ shotId: id, fields: structuredClone(fields) }));
    const row = await this._fuseSingleShot(shot, "9:16", [], current);
    captures.set(id, { row, diagnostics: report });
    // Deliberately stop before unrelated host canonical/gate policy. This is a
    // native author/checker boundary fixture, never a passed Phase3 production.
    throw new Error(`${boundary}/${id}`);
  });
  const saveCheckpoint = vi.fn(async () => undefined);
  const run = async (id: string, current: Row) => {
    const fields = replies.get(id)!;
    const phase = new Phase3PromptFusion({ agents: { promptFusion: agent }, logFn: () => undefined,
      cloneShots: structuredClone, saveCheckpoint });
    const state = { shots: [{ shotId: id, sceneType: "action", duration: 6, scene: fields.scene,
      action: fields.action, character: "演员甲", cameraString: fields.camera_movement, lightingString: fields.lighting }],
    adaptedBlueprint: current, result: { stages: {} as Record<string, Row>, llmStats: {} } };
    await expect(phase.execute(state)).rejects.toThrow(`${boundary}/${id}`);
    expect(state.result.stages.phase3Fusion).toMatchObject({ status: "unverified", code: "PHASE3_EXECUTION_FAILED" });
    expect(saveCheckpoint).not.toHaveBeenCalled();
    const captured = captures.get(id);
    if (!captured) throw new Error("Real native fusion did not reach the explicit fixture boundary");
    expect(captured.row.degraded).toBe(false);
    expect(captured.row).not.toHaveProperty("_workloomFusion");
    expect(agent._llmEngineLoaded).toBe(false);
    return captured;
  };
  return { agent, originalChecker, authorCalls, transport, run };
}

it("preserves the exact native Chinese camera field instead of prepending an English action-camera fix", async () => {
  const uninstall = installVendorPhase3FusionBridge();
  try {
    const fields = authoredFields(true, false);
    const f = fixture(new Map([["S1", fields]]));
    const output = await f.run("S1", blueprint());
    expect(output.diagnostics.issues.some(issue => issue.message === cameraIssue)).toBe(true);
    expect(fieldValues(output.row).camera_movement).toBe(fields.camera_movement);
    expect(f.authorCalls).toEqual(["S1"]);
    expect(f.agent.consistencyChecker).toBe(f.originalChecker);
  } finally { uninstall(); }
});

it("preserves native night hard lighting instead of prepending uniform soft lighting for calm mood", async () => {
  const uninstall = installVendorPhase3FusionBridge();
  try {
    const fields = authoredFields(false, true);
    const f = fixture(new Map([["S1", fields]]));
    const output = await f.run("S1", blueprint());
    expect(output.diagnostics.issues.some(issue => issue.message === lightingIssue)).toBe(true);
    expect(fieldValues(output.row).lighting).toBe(fields.lighting);
    expect(f.authorCalls).toEqual(["S1"]);
  } finally { uninstall(); }
});

it("reports an outdoor corridor as the original indoor-lighting issue without replacing the native lighting", async () => {
  const uninstall = installVendorPhase3FusionBridge();
  try {
    const fields = authoredFields(false, false);
    fields.scene = detailed("夜间封闭赛道的短直道，两道金属护栏向消失点延伸成一条对称走廊，护栏外是露天缓冲区与看台轮廓，沥青上保留清晰胎印。", 120);
    fields.lighting = detailed("护栏顶部排灯以5800K冷白硬光沿纵深等距排列，从上方与后侧压向沥青，主光方向和光比8:1保持不变，缝隙漏下的微弱冷光只勾出主体边缘，地面反光收成窄条，不增加柔光箱。", 150);
    const outside = new FieldConsistencyChecker({ logLevel: "silent" }) as Checker;
    const input = { shotId: "S1", fields: structuredClone(fields) };
    const report = diagnostics(outside.check(input));
    expect(report.issues).toEqual(expect.arrayContaining([expect.objectContaining({
      fieldA: "scene", fieldB: "lighting", message: "室内场景但灯光没有室内光源描述", fixable: true,
    })]));
    expect(fieldValues(outside.autoFix(input)).lighting).toBe("indoor lighting, " + fields.lighting);
    const f = fixture(new Map([["S1", fields]]));
    const output = await f.run("S1", blueprint());
    expect(output.diagnostics).toEqual(report);
    expect(fieldValues(output.row).lighting).toBe(fields.lighting);
    expect(diagnostics(f.originalChecker.check(input))).toEqual(report);
    expect(f.authorCalls).toEqual(["S1"]);
  } finally { uninstall(); }
});

it.each(["current", "no-marker", "old-marker", "narrative"])(
  "preserves outdoor night lighting only for the current marketing writer (%s)", async mode => {
  const uninstall = installVendorPhase3FusionBridge();
  try {
    const fields = authoredFields(false, false);
    fields.scene = detailed("室外封闭赛道的短直道，护栏与沥青保持真实纹理，演员甲沿地面标记行进，背景露天缓冲区保持原位。", 120);
    const outside = new FieldConsistencyChecker({ logLevel: "silent" }) as Checker;
    const input = { shotId: "S1", fields: structuredClone(fields) };
    const report = diagnostics(outside.check(input));
    expect(fieldValues(outside.autoFix(input)).lighting).toBe("natural sunlight, " + fields.lighting);
    const current = mode === "no-marker" ? blueprint(null)
      : mode === "old-marker" ? blueprint("native-marketing-field-authority/v2")
        : mode === "narrative" ? blueprint(currentPolicy, false) : blueprint();
    const f = fixture(new Map([["S1", fields]]));
    const output = await f.run("S1", current);
    expect(output.diagnostics).toEqual(report);
    expect(output.diagnostics.issues.some(issue => issue.message === "室外场景但灯光没有自然光描述")).toBe(true);
    expect(fieldValues(output.row).lighting).toBe(mode === "current" ? fields.lighting : "natural sunlight, " + fields.lighting);
    expect(diagnostics(f.originalChecker.check(input))).toEqual(report);
    expect(f.authorCalls).toEqual(["S1"]);
  } finally { uninstall(); }
});

it.each(["no-marker", "narrative", "old-marker"])("keeps original native fixes for the %s control", async mode => {
  const uninstall = installVendorPhase3FusionBridge();
  try {
    const fields = authoredFields();
    const current = mode === "no-marker" ? blueprint(null)
      : mode === "narrative" ? blueprint(currentPolicy, false) : blueprint("native-marketing-field-authority/v0");
    const f = fixture(new Map([["S1", fields]]));
    const output = await f.run("S1", current);
    expect(fieldValues(output.row).camera_movement).toBe(cameraPrefix + fields.camera_movement);
    expect(fieldValues(output.row).lighting).toBe(lightingPrefix + fields.lighting);
    expect(f.authorCalls).toEqual(["S1"]);
  } finally { uninstall(); }
});

it("retains original issue messages and counts while applying every unprotected native fix", async () => {
  const uninstall = installVendorPhase3FusionBridge();
  try {
    const fields: Fields = { ...authoredFields(), bright_constraint: "bright lighting", dialogue: "已经完成。",
      audio: detailed("脚步摩擦粗糙地面，金属工具轻碰衣料，通道内持续的风声随人物位置产生空间变化，所有声音与动作接触时刻同步。", 100) };
    const outside = new FieldConsistencyChecker({ logLevel: "silent" }) as Checker;
    const input = { shotId: "S1", fields: structuredClone(fields) };
    const expectedReport = diagnostics(outside.check(input));
    const expectedOtherFixes = fieldValues(outside.autoFix(input));
    const f = fixture(new Map([["S1", fields]]));
    const output = await f.run("S1", blueprint());
    expect(output.diagnostics).toEqual(expectedReport);
    expect(output.diagnostics).toMatchObject({ valid: false, errorCount: 1, warningCount: 3 });
    expect(output.diagnostics.issues.map(issue => issue.message)).toEqual(expect.arrayContaining([
      cameraIssue, lightingIssue, "夜晚场景但bright_constraint要求明亮，矛盾", "有台词但音频没有包含人声/对话描述",
    ]));
    expect(fieldValues(output.row).bright_constraint).toBe(expectedOtherFixes.bright_constraint);
    expect(fieldValues(output.row).audio).toBe(expectedOtherFixes.audio);
    expect(fieldValues(output.row).camera_movement).toBe(fields.camera_movement);
    expect(fieldValues(output.row).lighting).toBe(fields.lighting);
    expect(diagnostics(f.originalChecker.check(input))).toEqual(expectedReport);
  } finally { uninstall(); }
});

it("isolates concurrent marketing and narrative calls that share one native agent and leaves its global checker intact", async () => {
  const uninstall = installVendorPhase3FusionBridge();
  let release: (() => void) | undefined;
  try {
    const fields = authoredFields();
    let arrived = 0;
    const together = new Promise<void>(resolve => { release = resolve; });
    let globalWhileBothActive: Row | undefined;
    const f = fixture(new Map([["S1", fields], ["S2", fields]]), async () => {
      arrived += 1;
      if (arrived === 2) {
        globalWhileBothActive = f.originalChecker.autoFix({ shotId: "outside", fields: structuredClone(fields) });
        release?.();
      }
      await together;
    });
    const marketing = f.run("S1", blueprint()).finally(() => release?.());
    const narrative = f.run("S2", blueprint(currentPolicy, false)).finally(() => release?.());
    const [protectedOutput, originalOutput] = await Promise.all([marketing, narrative]);
    expect(arrived).toBe(2);
    expect(fieldValues(protectedOutput.row).camera_movement).toBe(fields.camera_movement);
    expect(fieldValues(protectedOutput.row).lighting).toBe(fields.lighting);
    expect(fieldValues(originalOutput.row).camera_movement).toBe(cameraPrefix + fields.camera_movement);
    expect(fieldValues(originalOutput.row).lighting).toBe(lightingPrefix + fields.lighting);
    expect(fieldValues(globalWhileBothActive!).camera_movement).toBe(cameraPrefix + fields.camera_movement);
    expect(fieldValues(globalWhileBothActive!).lighting).toBe(lightingPrefix + fields.lighting);
    expect(f.agent.consistencyChecker).toBe(f.originalChecker);
    expect(f.authorCalls.sort()).toEqual(["S1", "S2"]);
  } finally { release?.(); uninstall(); }
});

it("leaves standalone original checkers and their public check/autoFix methods unchanged", () => {
  const check = FieldConsistencyChecker.prototype.check;
  const autoFix = FieldConsistencyChecker.prototype.autoFix;
  const uninstall = installVendorPhase3FusionBridge();
  try {
    const fields = authoredFields();
    const checker = new FieldConsistencyChecker({ logLevel: "silent" }) as Checker;
    const shot = { shotId: "outside", fields: structuredClone(fields) };
    const before = structuredClone(shot);
    const report = checker.check(shot);
    expect(report.issues.map(issue => issue.message)).toEqual(expect.arrayContaining([cameraIssue, lightingIssue]));
    const fixed = fieldValues(checker.autoFix(shot));
    expect(fixed.camera_movement).toBe(cameraPrefix + fields.camera_movement);
    expect(fixed.lighting).toBe(lightingPrefix + fields.lighting);
    expect(shot).toEqual(before);
    expect(FieldConsistencyChecker.prototype.check).toBe(check);
    expect(FieldConsistencyChecker.prototype.autoFix).toBe(autoFix);
  } finally { uninstall(); }
});
