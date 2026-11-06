import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { installVendorPhase3FusionBridge } from "./vendor-compat.js";
import { videoRuntimeRoot } from "./runtime-root.js";

type Row = Record<string, unknown>;
const require = createRequire(import.meta.url);
const root = videoRuntimeRoot(import.meta.url);
const { Phase3PromptFusion } = require(resolve(root,
  "vendor/supermickey/hyperreality-system/engines/production-engine/phases/phase-3-prompt-fusion.js"));
const { PromptFusionAgent } = require(resolve(root,
  "vendor/supermickey/hyperreality-system/engines/production-engine/agents/prompt-fusion-agent.js"));
const checkpointHash = "56e1cace29c3513d9d2ed62a";

function nativeRow(shotId: string, scene = "检修工位内，金属工具从左侧移至灰色工作台中央。", degraded = false): Row {
  const fields = {
    action: "金属工具从画面左侧匀速进入，在灰色工作台中央停稳。", scene,
    costume: "无人物出场，不适用。", makeup: "无人物出场，不适用。", props: "金属检修工具、灰色工作台。",
    timeline: "T00:00-00:02工具进入；T00:02-00:04横移；T00:04-00:05停稳。",
    composition: "工作台近景，工具位于画面中央。", lighting: "左侧顶灯提供5600K柔光。",
    color_palette: "中性灰色为主，金属冷色为辅。", transition: "入场硬切，出场硬切至下一镜。",
    mood: "平静，工具移动速度均匀。", camera_movement: "固定近景，机位水平且稳定。",
    pacing: "开头进入、中段横移、结尾停稳。", depth_of_field: "焦点锁定工具，背景轻微虚化。",
    audio: "金属工具接触工作台时发出咔嗒声，伴随工位风声。",
  };
  return { shotId, sceneType: "establishing", duration: 5, character: "无人物出场。",
    ...fields, fields, prompt: `01.【场景】${scene.slice(0, 30)}`, degraded };
}

function localRecovery(shotId: string): Row {
  return {
    shotId, sceneType: "establishing", duration: 5,
    scene: "检修工位，工具与工作台清晰可见。", action: "工具从左侧横移。", lightingString: "顶灯柔光。",
    fields: { scene: "检修工位。", action: "工具横移。", lighting: "顶灯柔光。", camera_movement: "固定机位。" },
    prompt: "01.【场景】检修工位\n02.【动作】工具横移。", degraded: false,
    _workloomLocalRecovery: { mode: "contract-source-reprojection", requiresFinalReviewProjection: true },
  };
}

function fixture(directory: string, first: Row[]) {
  const process = vi.fn(async () => ({ shots: structuredClone(first), checkpointBlueprintHash: checkpointHash,
    degraded: false, stats: { total: first.length, failed: 0 } }));
  const repair = vi.fn(async (shot: Row): Promise<Row> => nativeRow(String(shot.shotId)));
  const writer = vi.fn((...args: unknown[]) => PromptFusionAgent.prototype._saveSubCheckpoint(...args));
  const finalCheckpoint = vi.fn(async () => {});
  const merge = vi.fn((_base: Row[], updated: Row[]) => updated);
  const phase = new Phase3PromptFusion({
    agents: { promptFusion: { process, _fuseSingleShot: repair, _saveSubCheckpoint: writer,
      _callLLM: async () => ({ result: { picks: [] }, degraded: false }) } },
    checkpointManager: { baseDir: directory }, logFn: () => {}, cloneShots: structuredClone,
    mergeShots: merge, saveCheckpoint: finalCheckpoint,
  });
  const state = () => ({
    shots: first.map(row => ({ shotId: row.shotId, scene: "检修工位工具近景。", action: "工具横移。", duration: 5, characters: [] })),
    adaptedBlueprint: { title: "营销原生单镜修复", config: { aspectRatio: "9:16", target_duration: first.length * 5 },
      character_system: { characters: [] }, meta: { _metadata: { dialogueRequirement: "不添加人声旁白或对白，不添加配乐。",
        _prd: { _workloomMarketingPrompt: { actions: [], overlay: [], endCard: [] },
          productPositioning: { targetDuration: first.length * 5, aspectRatio: "9:16", resolution: "1080x1920" },
          characterSystem: { characters: [] } } } } },
    result: { stages: {} as Record<string, Row>, llmStats: {} },
  });
  const cache = resolve(directory, `checkpoint-phase3-${checkpointHash}.json`);
  return { process, repair, writer, finalCheckpoint, merge, phase, state, cache };
}

it("retries only actual14-shaped recovered S1/S5 and preserves the five genuine native rows", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "wl-marketing-native-only-"));
  const uninstall = installVendorPhase3FusionBridge();
  try {
    const first = Array.from({ length: 7 }, (_, index) => nativeRow(`S${index + 1}`));
    first[0] = localRecovery("S1");
    const aliased = first[1]!;
    const aliasFields = aliased.fields as Row;
    for (const [field, alias] of [
      ["scene", "sceneDescription"], ["lighting", "lightingString"], ["color_palette", "colorPalette"],
      ["mood", "emotion"], ["camera_movement", "cameraString"], ["depth_of_field", "depthOfField"],
    ]) {
      aliased[alias!] = aliasFields[field!];
      delete aliased[field!];
      delete aliasFields[field!];
    }
    // Even complete fields cannot turn a source-recovery marker into native authorship.
    first[4] = { ...nativeRow("S5"), _workloomLocalRecovery: { mode: "contract-source-reprojection" } };
    const f = fixture(directory, first);
    const realS1 = nativeRow("S1", "检修工位，灰色墙面与金属工具保留真实细节。");
    const realS5 = nativeRow("S5");
    const neighborIndices: unknown[] = [];
    f.repair.mockImplementation(async function (this: Row, shot: Row) {
      neighborIndices.push(this._currentShotIdx);
      return shot.shotId === "S1" ? realS1 : realS5;
    });
    f.finalCheckpoint.mockRejectedValueOnce(new Error("OFFLINE_FINAL_CHECKPOINT_STOP"));
    await expect(f.phase.execute(f.state())).rejects.toThrow("OFFLINE_FINAL_CHECKPOINT_STOP");
    expect(f.repair.mock.calls.map(([shot]) => shot.shotId)).toEqual(["S1", "S5"]);
    expect(neighborIndices).toEqual([0, 4]);
    expect(f.writer).toHaveBeenCalledTimes(2);
    const saved = JSON.parse(readFileSync(f.cache, "utf8"));
    expect(saved).toMatchObject({ blueprintHash: checkpointHash, completed: 7, total: 7 });
    expect(saved.results[0]).toEqual(realS1);
    expect(saved.results[4]).toEqual(realS5);
    for (const index of [1, 2, 3, 5, 6]) expect(saved.results[index]).toEqual(first[index]);
    expect(saved.results.every((row: Row) => !row._workloomLocalRecovery && !row._workloomFusion)).toBe(true);
    expect(f.finalCheckpoint).toHaveBeenCalledTimes(1);
    expect(f.merge).toHaveBeenCalledTimes(1);
  } finally { uninstall(); rmSync(directory, { recursive: true, force: true }); }
});

it("persists a successful native S1 before S5 fails, then retries only S5 from that same cache", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "wl-marketing-native-progress-"));
  const uninstall = installVendorPhase3FusionBridge();
  try {
    const first = Array.from({ length: 7 }, (_, index) => nativeRow(`S${index + 1}`));
    first[0] = nativeRow("S1", "原生降级结果。", true);
    first[4] = nativeRow("S5", "原生降级结果。", true);
    const f = fixture(directory, first);
    const realS1 = nativeRow("S1");
    f.repair.mockImplementation(async shot => shot.shotId === "S1" ? realS1 : nativeRow("S5", "JSON失败后规则兜底。", true));
    await expect(f.phase.execute(f.state())).rejects.toThrow(/PHASE3_FUSION_RETRY_UNVERIFIED.*S5/u);
    expect(f.repair.mock.calls.map(([shot]) => shot.shotId)).toEqual(["S1", "S5"]);
    expect(f.writer).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(readFileSync(f.cache, "utf8"));
    expect(saved.results[0]).toEqual(realS1);
    expect(saved.results[4]).toEqual(first[4]);
    for (const index of [1, 2, 3, 5, 6]) expect(saved.results[index]).toEqual(first[index]);
    expect(f.finalCheckpoint).not.toHaveBeenCalled();
    expect(f.merge).not.toHaveBeenCalled();

    const realS5 = nativeRow("S5", "检修工位，灰色墙面与金属工具保留真实细节。");
    f.process.mockResolvedValueOnce({ shots: saved.results, checkpointBlueprintHash: checkpointHash,
      degraded: false, stats: { total: 7, failed: 0 } });
    f.repair.mockReset(); f.writer.mockClear();
    f.repair.mockResolvedValueOnce(realS5);
    f.finalCheckpoint.mockRejectedValueOnce(new Error("OFFLINE_FINAL_CHECKPOINT_STOP"));
    await expect(f.phase.execute(f.state())).rejects.toThrow("OFFLINE_FINAL_CHECKPOINT_STOP");
    expect(f.repair.mock.calls.map(([shot]) => shot.shotId)).toEqual(["S5"]);
    expect(f.writer).toHaveBeenCalledTimes(1);
    const resumed = JSON.parse(readFileSync(f.cache, "utf8"));
    expect(resumed.results[0]).toEqual(realS1);
    expect(resumed.results[4]).toEqual(realS5);
    for (const index of [1, 2, 3, 5, 6]) expect(resumed.results[index]).toEqual(first[index]);
  } finally { uninstall(); rmSync(directory, { recursive: true, force: true }); }
});

it("rejects a nondegraded retry with missing native props without overwriting the existing cache", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "wl-marketing-native-incomplete-"));
  const uninstall = installVendorPhase3FusionBridge();
  try {
    const first = [nativeRow("S1", "原生降级结果。", true), nativeRow("S2")];
    const f = fixture(directory, first);
    PromptFusionAgent.prototype._saveSubCheckpoint({ baseDir: directory }, checkpointHash, first, 2, 2);
    const before = readFileSync(f.cache);
    const incomplete = nativeRow("S1");
    delete incomplete.props;
    delete (incomplete.fields as Row).props;
    f.repair.mockResolvedValueOnce(incomplete);
    const state = f.state();
    await expect(f.phase.execute(state)).rejects.toThrow(/PHASE3_FUSION_RETRY_UNVERIFIED.*S1/u);
    expect(f.repair).toHaveBeenCalledTimes(1);
    expect(f.writer).not.toHaveBeenCalled();
    expect(readFileSync(f.cache)).toEqual(before);
    expect(state.result.stages).not.toHaveProperty("phase3Recovery");
    expect(f.finalCheckpoint).not.toHaveBeenCalled();
    expect(f.merge).not.toHaveBeenCalled();
  } finally { uninstall(); rmSync(directory, { recursive: true, force: true }); }
});
