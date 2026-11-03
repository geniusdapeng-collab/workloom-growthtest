import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

/** 子进程保留真实CJS边界；来源提取/支持判断用显式协议替身，装订/Studio/落盘是真实实现。 */
it("G1首次装订、Studio同目录重装订与磁盘复读保留同一条已审规格来源", () => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "wl-dossier-consumption-")));
  const script = path.join(directory, "check.mts");
  writeFileSync(script, `
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { prepareMarketingFacts } from ${JSON.stringify(path.join(repo, "apps/server/src/video/marketing-authority.ts"))};
import { VideoStudio } from ${JSON.stringify(path.join(repo, "packages/video-studio/src/studio.ts"))};
const require = createRequire(${JSON.stringify(path.join(repo, "package.json"))});
const entry = require('./vendor/supermickey/hyperreality-system/index.js');
const { JennyLoomEngine } = require('./vendor/supermickey/hyperreality-system/engines/data-mining-engine/index.js');
const hash = input => createHash('sha256').update(input).digest('hex');
const text = '星野 F3 风扇支持 9 档风量。';
const url = 'https://source.example.com/f3';
const source = { sourceId: 'SRC-consumption', requestedUrl: url, finalUrl: url, redirectChain: [], fetchedAt: new Date().toISOString(), contentType: 'text/plain', rawSha256: hash(text), textSha256: hash(text), bytes: Buffer.byteLength(text), text, assetUrls: [] };
const llm = { model: 'protocol-substitute', fastModel: 'protocol-substitute', reason: async prompt => {
 const stage = /当前阶段：(A[123])/u.exec(prompt)?.[1];
 if (stage !== 'A1') return { success: true, data: { payload: stage === 'A2' ? { reviews: [] } : { competitors: [] }, citations: [], noEvidenceReason: '仅商品参数，未取得评价或竞品证据' } };
 return { success: true, data: { payload: { identity: { name: '星野 F3', specs: { 风量: '9 档' } }, images: [] }, citations: ['/identity/name','/identity/specs/风量'].map(pointer => ({ pointer, sourceId: source.sourceId, quote: text })) } };
} };
const review = async input => ({ stage: input.stage, status: 'passed', approved: true, score: 96, hardFailures: [], issues: [], suggestions: [], rerun: false, via: 'llm', model: 'protocol-substitute', ms: 0, reason: 'explicit protocol substitute', degraded: false,
 evidence: await Promise.all(input.artifacts.map(async item => ({ path: item.path, sha256: hash(await readFile(item.path)), scope: 'complete-text' }))) });
const prepared = await prepareMarketingFacts({ scope: { tenantId: 'T1', workspaceId: 'W1', projectId: 'P1', runId: 'R1', attempt: 1 }, root: ${JSON.stringify(directory)}, metadata: { brief: { product: '星野 F3' } }, intent: '商品介绍', llm,
 dependencies: { search: async () => [{ title: '星野 F3 参数', url, snippet: text }], fetchSource: async () => ({ snapshot: source, rawBytes: Buffer.from(text) }), review } });
const Original = entry.HyperrealitySystem;
function OfflineSystem() {}
OfflineSystem.prototype = Object.create(Original.prototype);
OfflineSystem.prototype.constructor = OfflineSystem;
OfflineSystem.prototype.create = async function(intent, metadata, options) {
 const collector = new JennyLoomEngine({ mode: 'api', storeRoot: options.dataMiningStoreRoot });
 const assembled = collector.assemble(collector.plan(metadata.dataMining).trace_id, metadata.dataMining, options.dataMiningRaw);
 return { success: assembled.ok, stages: { dataMining: { data: assembled } } };
};
entry.HyperrealitySystem = OfflineSystem;
try {
 const studio = new VideoStudio({ llm, workDir: ${JSON.stringify(directory)}, portraits: { enabled: false }, deferRender: true, log: () => undefined, onApproval: async () => ({ approved: true }),
 dataMining: { mode: 'api', storeRoot: prepared.storeRoot, refresh: true, verifiedRaw: { projectId: 'P1', rawJson: JSON.stringify(prepared.raw), sha256: hash(JSON.stringify(prepared.raw)), productQuery: prepared.bundle.productQuery, specSourceUrls: prepared.specSourceUrls } } });
 const result = await studio.runPreproduction({ projectId: 'P1', intent: '商品介绍', isMarketing: true });
 const after = result.stages.dataMining.data.dossier;
 const disk = JSON.parse(await readFile(path.join(prepared.storeRoot, prepared.bundle.dossier.product_id, 'dossier.json'), 'utf8'));
 console.log('RESULT '+JSON.stringify({ before: prepared.bundle.dossier, after, disk, raw: prepared.raw, rawHash: prepared.bundle.rawSha256 }));
} finally { entry.HyperrealitySystem = Original; }
`);
  try {
    const output = execFileSync(process.execPath, [path.join(repo, "node_modules/tsx/dist/cli.mjs"), script],
      { cwd: repo, encoding: "utf8", timeout: 60_000, maxBuffer: 5_000_000 });
    const line = output.split("\n").find(value => value.startsWith("RESULT "));
    expect(line).toBeDefined();
    const result = JSON.parse(line!.slice(7));
    const sourceRows = (dossier: any) => dossier.provenance.filter((item: any) => item.claim_ref === "identity.specs.风量")
      .map((item: any) => ({ claim_ref: item.claim_ref, source_url: item.source_url, channel_class: item.channel_class }));
    expect(sourceRows(result.before)).toHaveLength(1);
    expect(sourceRows(result.after)).toEqual(sourceRows(result.before));
    expect(sourceRows(result.disk)).toEqual(sourceRows(result.before));
    expect(result.after.gaps.join("\n")).not.toContain('规格 "风量" 无来源');
    expect(result.raw.A1.identity.specs.风量).toBe("9 档");
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 65_000);
