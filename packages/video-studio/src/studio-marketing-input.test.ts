import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** 实际Studio接线、JennyLoom/CJS装订及真实卡片消费者；替换昂贵生产编排，不调用网络模型。 */
it.each([false, true])("Studio重装订只消费已审A1身份，保留已审身份=%s", hasVerifiedIdentity => {
  const directory = mkdtempSync(path.join(tmpdir(), "wl-marketing-input-"));
  const file = path.join(directory, "check.mts");
  writeFileSync(file, `
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { VideoStudio } from ${JSON.stringify(path.join(root, "packages/video-studio/src/studio.ts"))};
const require = createRequire(${JSON.stringify(path.join(root, "package.json"))});
const entry = require('./vendor/supermickey/hyperreality-system/index.js');
const { JennyLoomEngine } = require('./vendor/supermickey/hyperreality-system/engines/data-mining-engine/index.js');
const Original = entry.HyperrealitySystem;
function OfflineSystem() {}
OfflineSystem.prototype = Object.create(Original.prototype);
OfflineSystem.prototype.constructor = OfflineSystem;
OfflineSystem.prototype.create = async function(intent, metadata, options) {
  const collector = new JennyLoomEngine({ mode: 'api', storeRoot: options.dataMiningStoreRoot });
  const input = metadata.dataMining;
  const assembled = collector.assemble(collector.plan(input).trace_id, input, options.dataMiningRaw);
  if (!assembled.ok) throw new Error('real-dossier-assembly-failed');
  metadata._dataDossier = { cards: assembled.cards };
  metadata._creativeTheme = { description: '原始创意' };
  const carrier = { stages: {} };
  this._injectDossierEvidence(metadata, carrier);
  return { success: true, stages: { dataMining: { data: assembled }, consumption: { input, theme: this._buildThemeInput(intent, metadata), description: metadata._creativeTheme.description } } };
};
entry.HyperrealitySystem = OfflineSystem;
try {
 const raw = { A1: { identity: { name: '已核实 F3', ...${JSON.stringify(hasVerifiedIdentity ? { brand: "已审品牌", category: "已审家电", model: "已审型号F3" } : {})}, specs: { 风量: '9 档' }, official_selling_points: [{ point: '风量 9 档', source_url: 'https://source.example.com/f3' }] }, images: [] }, A2: { reviews: [] }, A3: { competitors: [] } };
 const rawJson = JSON.stringify(raw);
 const productQuery = { name: '已核实 F3', brand: '检索品牌', category: '检索服务', model: '检索型号' };
 const studio = new VideoStudio({ llm: { model: 'offline', fastModel: 'offline' }, workDir: ${JSON.stringify(directory)},
   portraits: { enabled: false }, deferRender: true, log: () => undefined, onApproval: async () => ({ approved: true }),
   dataMining: { mode: 'api', storeRoot: ${JSON.stringify(path.join(directory, "dossiers"))}, verifiedRaw: { projectId: 'P1', rawJson, sha256: createHash('sha256').update(rawJson).digest('hex'), productQuery } } });
 const result = await studio.runPreproduction({ projectId: 'P1', intent: '做商品介绍', isMarketing: true, metadata: { pipelineRoute: { kind: 'marketing' } } });
 console.log('RESULT '+JSON.stringify(result.stages));
} finally { entry.HyperrealitySystem = Original; }
`);
  try {
    const output = execFileSync(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), file],
      { cwd: root, encoding: "utf8", timeout: 60_000, maxBuffer: 5_000_000 });
    const line = output.split("\n").find(value => value.startsWith("RESULT "));
    expect(line).toBeDefined();
    const result = JSON.parse(line!.slice(7));
    const expected = hasVerifiedIdentity ? { name: "已核实 F3", brand: "已审品牌", category: "已审家电", model: "已审型号F3" }
      : { name: "已核实 F3", brand: "", category: "", model: "" };
    expect(result.dataMining.data.dossier.identity).toMatchObject(expected);
    expect(result.dataMining.data.cards.brief_card.category).toBe(expected.category);
    expect(result.consumption.theme).not.toContain("检索服务");
    expect(result.consumption.input).toMatchObject({ name: "已核实 F3" });
    for (const field of ["brand", "category", "model"] as const) expect(result.consumption.input[field] ?? "").toBe(expected[field]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 65_000);
