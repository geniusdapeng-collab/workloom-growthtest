import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const checkpointHash = "c".repeat(64);

function nativeRow(shotId: string, scene: string, degraded = false) {
  const fields = {
    scene, action: "检修工具从画面左侧缓慢移动到工作台中央。", costume: "无人物出场，本字段不适用。",
    makeup: "无人物出场，本字段不适用。", props: "金属检修工具、灰色工作台。",
    timeline: "T00:00-00:02工具进入；T00:02-00:04横移；T00:04-00:05停稳。",
    composition: "工作台近景，工具位于画面中央。", lighting: "左侧顶灯提供5600K柔光。",
    color_palette: "中性灰色为主，金属冷色为辅。", transition: "硬切到下一镜。",
    mood: "平静，工具移动速度均匀。", camera_movement: "固定近景机位，起幅与落幅保持一致。",
    pacing: "开头进入、中段横移、结尾停稳。", depth_of_field: "焦点锁定工具，背景轻微虚化。",
    audio: "金属工具接触台面发出清脆咔嗒声，保留工位风声。",
  };
  return { shotId, sceneType: "establishing", duration: 5, character: "无人物出场。",
    ...fields, fields, prompt: `01.【场景】${scene.slice(0, 30)}`, degraded };
}

function fixture(baseDir: string, writeStarted: () => void = () => {}) {
  const repaired = nativeRow("S1", `封闭检修工位，${"灰色墙面保留真实细节。".repeat(500)}`);
  const good = nativeRow("S2", "封闭检修工位，灰色工作台与金属工具清晰可见。");
  const first = [nativeRow("S1", "首次原生降级结果。", true), good];
  const process = vi.fn(async () => ({ shots: structuredClone(first), checkpointBlueprintHash: checkpointHash,
    degraded: false, stats: { total: 2, failed: 0 } }));
  const repair = vi.fn(async () => repaired);
  const writer = vi.fn((...args: unknown[]) => {
    writeStarted();
    return PromptFusionAgent.prototype._saveSubCheckpoint(...args);
  });
  const finalCheckpoint = vi.fn(async () => {});
  const merge = vi.fn((_base: Row[], updated: Row[]) => updated);
  const phase = new Phase3PromptFusion({
    agents: { promptFusion: { process, _fuseSingleShot: repair, _saveSubCheckpoint: writer,
      _callLLM: async () => ({ result: { picks: [] }, degraded: false }) } },
    checkpointManager: { baseDir }, logFn: () => {}, cloneShots: structuredClone,
    mergeShots: merge, saveCheckpoint: finalCheckpoint,
  });
  const blueprint = {
    title: "离线原生修复缓存", config: { aspectRatio: "9:16", target_duration: 10 },
    character_system: { characters: [] },
    meta: { _metadata: { dialogueRequirement: "不添加人声旁白或对白，不添加配乐。",
      _prd: { _workloomMarketingPrompt: { actions: [], overlay: [], endCard: [] },
        productPositioning: { targetDuration: 10, aspectRatio: "9:16", resolution: "1080x1920" },
        characterSystem: { characters: [] } } } },
  };
  const state = () => ({
    shots: ["S1", "S2"].map(shotId => ({ shotId, scene: "检修工位工具近景。", duration: 5, characters: [] })),
    adaptedBlueprint: blueprint, result: { stages: {} as Record<string, Row>, llmStats: {} },
  });
  return { phase, process, repair, writer, finalCheckpoint, merge, blueprint, state, repaired, good };
}

it("persists the repaired native rows before canonical rejection without creating a passed Phase3 checkpoint", async () => {
  const baseDir = mkdtempSync(resolve(tmpdir(), "wl-host-phase3-repair-"));
  const uninstall = installVendorPhase3FusionBridge();
  try {
    const f = fixture(baseDir);
    const state = f.state();
    await expect(f.phase.execute(state)).rejects.toThrow("FINAL_PROMPT_SOURCE_CAPACITY_EXCEEDED");
    expect(f.repair).toHaveBeenCalledTimes(1);
    expect(f.writer).toHaveBeenCalledTimes(1);
    expect(f.writer).toHaveBeenCalledWith({ baseDir }, checkpointHash, [f.repaired, f.good], 2, 2);
    const saved = JSON.parse(readFileSync(resolve(baseDir, `checkpoint-phase3-${checkpointHash}.json`), "utf8"));
    expect(saved).toMatchObject({ phase: "phase3-incremental", blueprintHash: checkpointHash,
      completed: 2, total: 2, results: [f.repaired, f.good] });
    expect(saved.results[0].fields.scene).toBe(f.repaired.fields.scene);
    expect(saved.results[1]).toEqual(f.good);
    expect(state.result.stages.phase3Retry).toMatchObject({ repaired: ["S1"], rawCheckpointSaved: true });
    expect(state.result.stages.phase3Fusion).toMatchObject({ status: "unverified", code: "PHASE3_EXECUTION_FAILED" });
    expect(f.finalCheckpoint).not.toHaveBeenCalled();
    expect(f.merge).not.toHaveBeenCalled();
    expect(existsSync(resolve(baseDir, "checkpoint-phase3.json"))).toBe(false);
    expect(saved.results.every((row: Row) => !row._workloomFusion)).toBe(true);

    // Already-repaired rows remain subject to canonical validation, but the
    // host does not rewrite their native cache or call the single-shot repair.
    f.process.mockResolvedValueOnce({ shots: saved.results, checkpointBlueprintHash: checkpointHash,
      degraded: false, stats: { total: 2, failed: 0 } });
    f.repair.mockClear(); f.writer.mockClear();
    await expect(f.phase.execute(f.state())).rejects.toThrow("FINAL_PROMPT_SOURCE_CAPACITY_EXCEEDED");
    expect(f.repair).not.toHaveBeenCalled();
    expect(f.writer).not.toHaveBeenCalled();
    expect(f.finalCheckpoint).not.toHaveBeenCalled();
  } finally { uninstall(); rmSync(baseDir, { recursive: true, force: true }); }
});

it("fails closed on a real filesystem write error before canonical validation or a passed checkpoint", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "wl-host-phase3-write-error-"));
  const baseDir = resolve(directory, "occupied-by-file");
  writeFileSync(baseDir, "not a directory");
  const uninstall = installVendorPhase3FusionBridge();
  try {
    let writeStarted = false;
    let canonicalMetaReads = 0;
    const f = fixture(baseDir, () => { writeStarted = true; });
    const meta = f.blueprint.meta;
    Object.defineProperty(f.blueprint, "meta", { enumerable: true, get() {
      if (writeStarted) canonicalMetaReads += 1;
      return meta;
    } });
    const state = f.state();
    await expect(f.phase.execute(state)).rejects.toThrow(/PHASE3_REPAIR_CHECKPOINT_UNVERIFIED.*ENOTDIR/u);
    expect(f.repair).toHaveBeenCalledTimes(1);
    expect(f.writer).toHaveBeenCalledTimes(1);
    expect(canonicalMetaReads).toBe(0);
    expect(state.result.stages.phase3Retry).not.toHaveProperty("rawCheckpointSaved");
    expect(state.result.stages.phase3Fusion).toMatchObject({ status: "unverified", code: "PHASE3_REPAIR_CHECKPOINT_UNVERIFIED" });
    expect(f.finalCheckpoint).not.toHaveBeenCalled();
    expect(f.merge).not.toHaveBeenCalled();
    expect(readFileSync(baseDir, "utf8")).toBe("not a directory");
  } finally { uninstall(); rmSync(directory, { recursive: true, force: true }); }
});
