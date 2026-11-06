import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { applyNarrativeFinalPromptContract, installVendorPhase3FusionBridge } from "./vendor-compat.js";
import { videoRuntimeRoot } from "./runtime-root.js";

type Row = Record<string, unknown>;
const require = createRequire(import.meta.url);
const root = videoRuntimeRoot(import.meta.url);
const { Phase3PromptFusion } = require(resolve(root,
  "vendor/supermickey/hyperreality-system/engines/production-engine/phases/phase-3-prompt-fusion.js"));
const { PromptFusionAgent } = require(resolve(root,
  "vendor/supermickey/hyperreality-system/engines/production-engine/agents/prompt-fusion-agent.js"));
const checkpointHash = "a".repeat(64);
const marker = "【最终规范正文容量修复】";
const bodyPolicy = {
  noDialogue: true, noMusic: true, noCharacters: false, noAnimals: false, maxLength: 3000,
  noTitles: false, chineseOnly: true, canonicalize: true, deferOpeningFields: true,
  aspectRatio: "9:16", resolution: "1080x1920", characterNames: [], characterPortraits: [],
  projectProps: [], projectActions: [], marketingPrompt: { actions: [], overlay: [], endCard: [] },
};

function nativeRow(shotId: string): Row {
  const fields = {
    scene: "离线检修工位，灰色台面与两件工具清晰可见。",
    action: "工具先从左侧进入，随后另一件工具从右侧接近，最终分别在台面两端停稳。",
    costume: "本镜无人物，不适用。", makeup: "本镜无人物，不适用。", props: "两件不同轮廓的检修工具。",
    timeline: "T00:00-T00:02左侧进入；T00:02-T00:04右侧接近；T00:04-T00:05分别停稳。",
    composition: "台面近景，两件工具及其接触点完整入画。", lighting: "左上方5600K柔光，右侧保留自然阴影。",
    color_palette: "中性灰为主，金属本色为辅。", transition: "入场硬切，落幅停稳后硬切至下一镜。",
    mood: "工具匀速移动，末段清楚停稳。", camera_movement: "固定近景，始终保持水平轴线。",
    pacing: "先进入，再接近，最后分别停稳。", depth_of_field: "两件工具与台面接触点同时清晰。",
    audio: "金属工具落在台面发出两次不同音色的咔嗒声，保留工位风声。",
    character: "本镜无人物出场。",
  };
  return { shotId, sceneType: "content", duration: 5, ...fields, fields,
    prompt: "01.【基础】写实材质，连续物理运动。\n02.【场景】这是原生预览。", degraded: false };
}

/** Calibrate against the actual hard-cap error, including every existing host compaction pass. */
function overflowRow(shotId: string, target = 3022, audio?: string): Row {
  const row = nativeRow(shotId);
  const fields = row.fields as Row;
  if (audio) { fields.audio = audio; row.audio = audio; }
  let padding = 3500;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    fields.scene = `检修工位起点。${"𠮷".repeat(padding)}场景终点完整保留。`;
    try { applyNarrativeFinalPromptContract(row, bodyPolicy); }
    catch (error) {
      const actual = /重建后 (\d+) 字符/u.exec(String(error))?.[1];
      if (!actual) throw error;
      if (Number(actual) === target) {
        const prefix = "01.【基础】写实材质，连续物理运动。\n02.【场景】";
        row.prompt = prefix + "预".repeat(2749 - Array.from(prefix).length);
        return row;
      }
      padding += target - Number(actual);
    }
  }
  throw new Error("离线容量夹具未达到指定真实投影长度");
}

function fixture(directory: string, initial: Row[]) {
  const calls: string[] = [];
  const process = vi.fn(async (_shots: Row[]) => ({ shots: structuredClone(initial), checkpointBlueprintHash: checkpointHash,
    degraded: false, stats: { total: initial.length, failed: 0 } }));
  const originalCall = vi.fn(async (prompt: string) => {
    calls.push(prompt);
    return { result: { picks: [] }, degraded: false };
  });
  const repair = vi.fn(async function (this: Row, shot: Row) {
    await (this._callLLM as (...args: unknown[]) => Promise<unknown>)("原生单镜作者输入", {}, () => null, { critical: true });
    return nativeRow(String(shot.shotId));
  });
  const writer = vi.fn((...args: unknown[]) => PromptFusionAgent.prototype._saveSubCheckpoint(...args));
  const finalCheckpoint = vi.fn(async () => {});
  const agent = { process, _fuseSingleShot: repair, _saveSubCheckpoint: writer, _callLLM: originalCall };
  const phase = new Phase3PromptFusion({
    agents: { promptFusion: agent },
    checkpointManager: { baseDir: directory }, logFn: () => {}, cloneShots: structuredClone,
    mergeShots: (_base: Row[], updated: Row[]) => updated, saveCheckpoint: finalCheckpoint,
  });
  const blueprint = { title: "离线最终正文容量修复", config: { aspectRatio: "9:16", target_duration: initial.length * 5 },
    character_system: { characters: [] }, meta: { _metadata: {
      dialogueRequirement: "无台词、无对白、无旁白、无口播；无配乐。",
      _prd: { _workloomMarketingPrompt: { actions: [], overlay: [], endCard: [] },
        productPositioning: { targetDuration: initial.length * 5, aspectRatio: "9:16", resolution: "1080x1920" },
        characterSystem: { characters: [] } },
    } } };
  const source = initial.map(row => ({ shotId: row.shotId, scene: "原始Phase2工位合同。", duration: 5, characters: [] }));
  const state = { shots: source, adaptedBlueprint: blueprint, result: { stages: {} as Record<string, Row>, llmStats: {} } };
  return { agent, process, repair, writer, finalCheckpoint, calls, blueprint, source, state, phase,
    cache: resolve(directory, `checkpoint-phase3-${checkpointHash}.json`) };
}

it("repairs an accepted-looking 2749-character raw preview whose complete canonical fields require3022", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "wl-phase3-canonical-capacity-"));
  const uninstall = installVendorPhase3FusionBridge();
  try {
    const first = [overflowRow("S1"), nativeRow("S2")];
    const before = structuredClone(first);
    expect(Array.from(String(first[0]!.prompt))).toHaveLength(2749);
    const f = fixture(directory, first);
    const sourceBefore = structuredClone(f.source);
    const blueprintBefore = structuredClone(f.blueprint);
    const output = await f.phase.execute(f.state);
    expect(output.success).toBe(true);
    expect(f.repair).toHaveBeenCalledTimes(1);
    expect(f.writer).toHaveBeenCalledTimes(1);
    const feedback = f.calls.find(text => text.includes(marker));
    expect(feedback).toBeDefined();
    for (const literal of ["\"actualCharacters\":3022", "\"maxCharacters\":3000", "\"overByCharacters\":22", "currentNativeFieldCharacters",
      "场景终点完整保留。", String((first[0]!.fields as Row).action), String((first[0]!.fields as Row).timeline)]) {
      expect(feedback, literal).toContain(literal);
    }
    expect(feedback).toContain(String((first[0]!.fields as Row).scene));
    expect(feedback).not.toMatch(/availableNativeCharacters|hostCharacters|nativeBodyCharacters/);
    const context = JSON.parse(feedback!.split(`${marker}\n`)[1]!.split("\n")[0]!) as Row;
    expect(context.currentNativeFields).toEqual(first[0]!.fields);
    expect(context.frozenProjectionPolicy).toMatchObject({ maxLength: 3000, canonicalize: true, deferOpeningFields: true });
    const saved = JSON.parse(readFileSync(f.cache, "utf8"));
    expect(saved.results[0]).toEqual(nativeRow("S1"));
    expect(saved.results[1]).toEqual(first[1]);
    for (const row of output.shots as Row[]) expect(Array.from(String(row.prompt)).length).toBeLessThanOrEqual(3000);
    expect(f.finalCheckpoint).toHaveBeenCalledTimes(1);
    expect(f.state.result.stages.phase3Retry).toMatchObject({ canonicalCapacityRepairs: [{
      shotId: "S1", before: { actualCharacters: 3022, maxCharacters: 3000, overByCharacters: 22 },
    }] });
    expect(JSON.stringify([saved.results, output.shots])).not.toMatch(/native-canonical-capacity-repair|currentNativeFieldCharacters|最终规范正文容量修复/);
    expect(first).toEqual(before);
    expect(f.source).toEqual(sourceBefore);
    expect(f.blueprint).toEqual(blueprintBefore);
  } finally { uninstall(); rmSync(directory, { recursive: true, force: true }); }
});

it("rejects an overcapacity author repair before raw acceptance and preserves the previous raw bytes", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "wl-phase3-canonical-still-long-"));
  const uninstall = installVendorPhase3FusionBridge();
  try {
    const first = [overflowRow("S1")];
    const f = fixture(directory, first);
    PromptFusionAgent.prototype._saveSubCheckpoint({ baseDir: directory }, checkpointHash, first, 1, 1);
    const before = readFileSync(f.cache);
    f.repair.mockResolvedValueOnce(overflowRow("S1", 3001));
    await expect(f.phase.execute(f.state)).rejects.toThrow(/PHASE3_FUSION_RETRY_UNVERIFIED.*S1.*3001.*3000/u);
    expect(f.repair).toHaveBeenCalledTimes(1);
    expect(f.writer).not.toHaveBeenCalled();
    expect(f.finalCheckpoint).not.toHaveBeenCalled();
    expect(readFileSync(f.cache)).toEqual(before);
    expect(f.state.result.stages).not.toHaveProperty("phase3Retry");
    expect(f.state.result.stages.phase3Fusion).toMatchObject({ status: "unverified" });
  } finally { uninstall(); rmSync(directory, { recursive: true, force: true }); }
});

it("reports exact whole-canonical capacity with raw audio288 including discipline127 without inventing a host/native budget", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "wl-phase3-canonical-audio-measure-"));
  const uninstall = installVendorPhase3FusionBridge();
  try {
    const nativeAudio = "工位持续风声。".repeat(17) + "接触声。".repeat(10) + "声。";
    const disciplineTag = "【音频纪律】";
    const discipline = disciplineTag + "禁".repeat(127 - Array.from(disciplineTag).length);
    const audio = nativeAudio + discipline;
    expect(Array.from(nativeAudio)).toHaveLength(161);
    expect(Array.from(discipline)).toHaveLength(127);
    expect(Array.from(audio)).toHaveLength(288);
    const first = [overflowRow("S-AUDIO", 3022, audio)];
    const before = structuredClone(first);
    const f = fixture(directory, first);
    const output = await f.phase.execute(f.state);
    expect(output.success).toBe(true);
    const feedback = f.calls.find(text => text.includes(marker))!;
    const context = JSON.parse(feedback.split(`${marker}\n`)[1]!.split("\n")[0]!) as Row;
    expect(context.measurement).toEqual({ shotId: "S-AUDIO", actualCharacters: 3022, maxCharacters: 3000, overByCharacters: 22 });
    expect((context.currentNativeFields as Row).audio).toBe(audio);
    expect((context.currentNativeFieldCharacters as Row).audio).toBe(288);
    expect(feedback).not.toMatch(/availableNativeCharacters|hostCharacters|nativeBodyCharacters/);
    expect(f.repair).toHaveBeenCalledTimes(1);
    expect(first).toEqual(before);
  } finally { uninstall(); rmSync(directory, { recursive: true, force: true }); }
});

it("keeps capacity feedback private to the affected run when two repairs share the same base agent", async () => {
  const directories = [mkdtempSync(resolve(tmpdir(), "wl-phase3-capacity-scope-a-")),
    mkdtempSync(resolve(tmpdir(), "wl-phase3-capacity-scope-b-"))];
  const uninstall = installVendorPhase3FusionBridge();
  let release!: () => void;
  const together = new Promise<void>(resolveTogether => { release = resolveTogether; });
  try {
    const over = overflowRow("A1");
    const missing = nativeRow("B1");
    delete missing.props; delete (missing.fields as Row).props;
    const a = fixture(directories[0]!, [over]);
    const b = fixture(directories[1]!, [missing]);
    b.phase.agents.promptFusion = a.agent;
    a.process.mockImplementation(async (shots: Row[]) => ({ shots: structuredClone(shots[0]!.shotId === "A1" ? [over] : [missing]),
      checkpointBlueprintHash: checkpointHash, degraded: false, stats: { total: 1, failed: 0 } }));
    let arrived = 0;
    a.repair.mockImplementation(async function (this: Row, shot: Row) {
      if (++arrived === 2) release();
      await together;
      await (this._callLLM as (...args: unknown[]) => Promise<unknown>)(`原生作者/${String(shot.shotId)}`, {}, () => null, { critical: true });
      return nativeRow(String(shot.shotId));
    });
    const results = await Promise.all([a.phase.execute(a.state), b.phase.execute(b.state)]);
    expect(results.every(result => result.success === true)).toBe(true);
    const aCall = a.calls.find(text => text.includes("原生作者/A1"))!;
    const bCall = a.calls.find(text => text.includes("原生作者/B1"))!;
    expect(aCall).toContain(marker);
    expect(aCall).toContain('"shotId":"A1"');
    expect(bCall).not.toContain(marker);
    expect(bCall).not.toContain('"shotId":"A1"');
    expect(a.agent).not.toHaveProperty("_workloomSetCanonicalCapacityRepair");
    for (const directory of directories) {
      const saved = JSON.parse(readFileSync(resolve(directory, `checkpoint-phase3-${checkpointHash}.json`), "utf8"));
      expect(JSON.stringify(saved.results)).not.toMatch(/native-canonical-capacity-repair|currentNativeFieldCharacters|最终规范正文容量修复/);
    }
  } finally { release(); uninstall(); for (const directory of directories) rmSync(directory, { recursive: true, force: true }); }
});

it("leaves the fitting nonmarketing path free of marketing capacity feedback", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "wl-phase3-canonical-nonmarketing-"));
  const uninstall = installVendorPhase3FusionBridge();
  try {
    const f = fixture(directory, [nativeRow("N1")]);
    delete (f.blueprint.meta._metadata._prd as Row)._workloomMarketingPrompt;
    const result = await f.phase.execute(f.state);
    expect(result.success).toBe(true);
    expect(f.repair).not.toHaveBeenCalled();
    expect(f.calls.every(text => !text.includes(marker))).toBe(true);
  } finally { uninstall(); rmSync(directory, { recursive: true, force: true }); }
});

it("stops after an unknown repair result without another capacity dispatch or accepted checkpoint", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "wl-phase3-canonical-unknown-"));
  const uninstall = installVendorPhase3FusionBridge();
  try {
    const f = fixture(directory, [overflowRow("S1")]);
    f.repair.mockRejectedValueOnce(new Error("PROVIDER_RESULT_UNKNOWN"));
    await expect(f.phase.execute(f.state)).rejects.toThrow(/PHASE3_FUSION_RETRY_UNVERIFIED.*PROVIDER_RESULT_UNKNOWN/u);
    expect(f.repair).toHaveBeenCalledTimes(1);
    expect(f.writer).not.toHaveBeenCalled();
    expect(f.finalCheckpoint).not.toHaveBeenCalled();
    expect(existsSync(f.cache)).toBe(false);
  } finally { uninstall(); rmSync(directory, { recursive: true, force: true }); }
});

it("keeps fitting native rows on their existing no-repair path", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "wl-phase3-canonical-fit-"));
  const uninstall = installVendorPhase3FusionBridge();
  try {
    const first = [nativeRow("S1"), nativeRow("S2")];
    const before = structuredClone(first);
    const f = fixture(directory, first);
    const output = await f.phase.execute(f.state);
    expect(output.success).toBe(true);
    expect(f.repair).not.toHaveBeenCalled();
    expect(f.writer).not.toHaveBeenCalled();
    expect(f.calls.every(text => !text.includes(marker))).toBe(true);
    expect(first).toEqual(before);
  } finally { uninstall(); rmSync(directory, { recursive: true, force: true }); }
});

it("defers inherited opening values to the existing title station while checking the complete body", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "wl-phase3-canonical-pretitle-"));
  const uninstall = installVendorPhase3FusionBridge();
  try {
    const row = { ...nativeRow("S00"), sceneType: "opening", title_content: "旧标题".repeat(2000),
      subtitle_content: "旧副标题", title_animation: "旧动画", title_font_design: "旧字体", opening_audio_design: "旧声音" };
    const f = fixture(directory, [row]);
    const output = await f.phase.execute(f.state);
    expect(output.success).toBe(true);
    expect(f.repair).not.toHaveBeenCalled();
    expect((output.shots as Row[])[0]!.title_content).toBe(row.title_content);
    expect(String((output.shots as Row[])[0]!.prompt)).not.toContain("【主标题内容】");
  } finally { uninstall(); rmSync(directory, { recursive: true, force: true }); }
});
