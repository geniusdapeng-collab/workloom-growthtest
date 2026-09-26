/**
 * 营销片「事实红线闸」接线回归（T-2026-0926-0103）
 *
 * 为什么单独一组：营销片管线的 `truth-check` 环节声明「ProductTruthChecker 一票否决」，
 * 但该检查器在全仓没有调用点（纸门）——创意前提与产品事实矛盾时没人拦得住。
 * 本组测试锁定新桥 `engines/truth-check-bridge.js` 的四条纪律：
 *   ① 营销片判定与宿主激活条件同源；② 档案事实按维度映射且保留信源；
 *   ③ 创意前提与事实矛盾 → conflicts 非空（可阻断）；④ 无证据 → degraded，绝不伪造事实。
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { bundlesRoot } from "./assembly.js";

const require_ = createRequire(import.meta.url);
const VENDOR = join(dirname(bundlesRoot()), "vendor/supermickey/hyperreality-system");
const bridge = require_(join(VENDOR, "engines/truth-check-bridge.js")) as {
  isMarketingRun: (metadata?: Record<string, unknown>) => boolean;
  buildTruthResearchNotes: (input: Record<string, unknown>) => Array<{ dimension: string; fact: string; source: string }>;
  buildCreativeInput: (task?: Record<string, unknown>) => { premise: string; hooks: string[]; scenes: string[] };
  runTruthCheck: (input: Record<string, unknown>) => {
    pass: boolean;
    conflicts: Array<{ banned?: string }>;
    issues: string[];
    factRedLines: string[];
    notes: number;
    blocking: boolean;
    degraded: boolean;
    degradedReason: string | null;
  };
};
const { ProductTruthChecker } = require_(join(VENDOR, "engines/production-engine/agents/product-truth-checker.js")) as {
  ProductTruthChecker: new () => {
    verify: (input: Record<string, unknown>) => { pass: boolean; conflicts: unknown[]; issues: string[]; factRedLines: string[] };
    resolveDimensions: (category: string, custom?: string[]) => { dimensions: string[] };
  };
};

/** 一份"手机 App 绑定"类商品的真实档案（规格带来源） */
const phoneBoundDossier = {
  identity: {
    name: '星野空气循环扇',
    category: '3C 数码 智能家电',
    price_band: '399-499 元',
    specs: {
      '控制方式': { value: '必须绑定手机 App 才能启用自然风模式', source_url: 'https://brand.example.com/spec' },
      '续航与充电方式': { value: '内置电池，续航 6 小时', source_url: 'https://brand.example.com/spec' },
      '保修政策': { value: '整机保修 2 年', source_url: 'https://brand.example.com/warranty' }
    },
    official_selling_points: [
      { text: '3 分钟全屋空气循环', source_url: 'https://brand.example.com/official' }
    ]
  },
  pros_cons: {
    pros: [
      { point: '风感柔和，夜间可用', claim_nature: 'user', source_refs: ['https://review.example.com/1'] },
      { point: '官方宣称静音低至 22dB', claim_nature: 'official', source_url: 'https://brand.example.com/official' }
    ],
    cons: [
      { point: '不绑定 App 无法调风速', source_refs: ['https://review.example.com/2'] }
    ]
  },
  voice_of_customer: {
    pain_points: [{ aspect: 'App 注册流程繁琐', mentions: 12 }]
  }
};

describe("营销片事实红线闸 · 数据桥", () => {
  it("① 营销片判定与宿主同源（dataMining / pipelineRoute / brief.product）", () => {
    expect(bridge.isMarketingRun({ dataMining: { name: '星野空气循环扇' } })).toBe(true);
    expect(bridge.isMarketingRun({ pipelineRoute: { kind: 'marketing' } })).toBe(true);
    expect(bridge.isMarketingRun({ brief: { product: '星野空气循环扇' } })).toBe(true);
    expect(bridge.isMarketingRun({ pipelineRoute: { kind: 'narrative' } })).toBe(false);
    expect(bridge.isMarketingRun({})).toBe(false);
    expect(bridge.isMarketingRun()).toBe(false);
  });

  it("② 档案事实按维度映射且保留信源（前提/边界/价格/官方口径）", () => {
    const checker = new ProductTruthChecker();
    const { dimensions } = checker.resolveDimensions('3C 数码 智能家电');
    const notes = bridge.buildTruthResearchNotes({ dossier: phoneBoundDossier, dimensions });
    expect(notes.length).toBeGreaterThanOrEqual(5);
    const dims = new Set(notes.map((n) => n.dimension));
    expect([...dims].some((d) => d.includes('前提') || d.includes('依赖') || d.includes('绑定'))).toBe(true);
    expect([...dims].some((d) => d.includes('边界') || d.includes('续航'))).toBe(true);
    expect([...dims].some((d) => d.includes('价格'))).toBe(true);
    // 条目级事实必须带真实来源（http），聚合字段允许带档案路径标注（dossier:）
    const sourced = notes.filter((n) => n.source.startsWith('http') || n.source.startsWith('dossier:'));
    expect(sourced.length).toBe(notes.length);
  });

  it("③ 创意前提与事实矛盾 → conflicts 非空（能阻断），并产出事实红线", () => {
    const checker = new ProductTruthChecker();
    const creative = bridge.buildCreativeInput({
      title: '解放双手的循环扇',
      theme: '无需手机、脱离 App，老人小孩也能直接用',
      description: '主打"不绑手机也能独立使用"'
    });
    const verdict = bridge.runTruthCheck({
      checker,
      brief: { product: '星野空气循环扇', category: '3C 数码 智能家电' },
      dossier: phoneBoundDossier,
      creative
    });
    expect(verdict.conflicts.length).toBeGreaterThan(0);
    expect(verdict.blocking).toBe(true);
    expect(verdict.pass).toBe(false);
    expect(verdict.degraded).toBe(false);
    expect(verdict.factRedLines.join('\n')).toContain('禁用宣称');
  });

  it("④ 无档案、无卡片 → degraded=no-evidence（不伪造事实、不误阻断）", () => {
    const checker = new ProductTruthChecker();
    const verdict = bridge.runTruthCheck({
      checker,
      brief: { product: '星野空气循环扇', category: '3C 数码 智能家电' },
      dossier: null,
      cards: null,
      creative: { premise: '无证据时不得断言任何产品事实' }
    });
    expect(verdict.notes).toBe(0);
    expect(verdict.blocking).toBe(false);
    expect(verdict.degraded).toBe(true);
    expect(verdict.degradedReason).toBe('no-evidence');
    expect(verdict.conflicts.length).toBe(0);
    expect(verdict.issues.some((i) => i.includes('调研记录为空'))).toBe(true);
  });

  it("④′ 档案缺信源 → 显式报「缺信源标注」，不静默通过", () => {
    const checker = new ProductTruthChecker();
    const noSourceDossier = {
      identity: { name: '测试商品', category: '家居', specs: { 控制方式: '必须绑定手机' }, price_band: '', official_selling_points: [] },
      pros_cons: { pros: [], cons: [] }
    };
    const verdict = bridge.runTruthCheck({
      checker,
      brief: { product: '测试商品', category: '家居' },
      dossier: { ...noSourceDossier, identity: { ...noSourceDossier.identity, specs: { 控制方式: { value: '必须绑定手机' } } } },
      creative: { premise: '' }
    });
    expect(verdict.notes).toBeGreaterThan(0);
    expect(verdict.issues.some((i) => i.includes('缺信源标注'))).toBe(true);
  });

  it("⑤ 摘要卡兜底：无完整档案时仍可从卡片取事实（标注卡片溯源）", () => {
    const checker = new ProductTruthChecker();
    const notes = bridge.buildTruthResearchNotes({
      dossier: null,
      cards: { brief_card: { product: '星野空气循环扇', category: '家电', sellingPoints: ['风感柔和'] } },
      dimensions: checker.resolveDimensions('家电').dimensions
    });
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.every((n) => n.source === 'dossier:cards.brief_card')).toBe(true);
  });
});
