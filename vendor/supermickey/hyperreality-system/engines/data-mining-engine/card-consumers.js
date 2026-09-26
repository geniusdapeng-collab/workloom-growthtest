'use strict';

/**
 * card-consumers.js —— 六张情报摘要卡的**消费侧**（T-2026-0926-0115）
 * ---------------------------------------------------------------------------
 * 读码事实（A 级）：情报层产出六张摘要卡，但只有两张有真实消费者——
 *   brief_card        → MarketingBriefParser.applyBriefCard（index.js 情报段）      ✔ 已消费
 *   theme_card        → index.js#_buildThemeInput（拼进创意主题输入）                ✔ 已消费
 *   insight_card      → 设计消费者 RequirementDiscoveryEngine                        ✗ 未接线
 *   prd_card          → 设计消费者 PRDGenerator                                       ✗ 未接线
 *   portrait_manifest → ProductPortraitBranch（portrait-studio 间接使用）             ~ 部分
 *   router_material   → MarketingSkillRouter（该路由器本身未被接线）                  ✗ 未接线
 *
 * 本模块补"证据可消费"这一半：把 insight_card / prd_card 压成**有界、确定性、
 * 只引用卡片字段**的证据块；由 index.js 追加进创意主题的 `description`
 * （需求洞察与 PRD 生成器的提示词都会读该字段），让下游真的看到情报证据。
 *
 * 纪律：
 *   1. 只搬运卡片字段，不新增事实、不推断、不润色；
 *   2. 有界（默认单卡 ≤600 字），超出按字段截断而不是整体丢弃；
 *   3. 幂等：同卡同输出；文本带固定标记，重复注入可被识别。
 */

const MARKER = '【情报证据】';
const DEFAULT_MAX_CHARS = 600;

function clip(text, max) {
  const s = String(text == null ? '' : text).trim();
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

function lines(entries) {
  return entries.filter((line) => line && String(line).trim().length > 0);
}

/** 组装证据块：标记前缀计入配额，保证返回文本整体 ≤ maxChars */
function block(label, body, maxChars) {
  const prefix = `${MARKER}（${label}）\n`;
  const budget = Math.max(0, maxChars - prefix.length);
  return `${prefix}${clip(body, budget)}`;
}

/** insight_card → 受众 / 用户共识 / 差评地图 / 市场位势（证据块） */
function buildInsightEvidence(cards, { maxChars = DEFAULT_MAX_CHARS } = {}) {
  const card = cards && cards.insight_card ? cards.insight_card : null;
  if (!card) return '';
  const out = [];
  const audience = (card.audience_profile || []).slice(0, 3).map((a) => {
    const who = [a && a.persona, a && a.scene, a && a.moment].filter(Boolean).join('/');
    return who ? `${who}${a && a.mentions ? `(${a.mentions}次)` : ''}` : '';
  }).filter(Boolean);
  if (audience.length) out.push(`受众：${audience.join('；')}`);
  const consensus = (card.consensus_points || []).slice(0, 3).map((c) => {
    if (!c || !c.point) return '';
    const meta = [c.confidence, c.mentions ? `${c.mentions}次` : ''].filter(Boolean).join(',');
    return `${c.point}${meta ? `(${meta})` : ''}`;
  }).filter(Boolean);
  if (consensus.length) out.push(`用户共识：${consensus.join('；')}`);
  const complaints = (card.complaint_map || []).slice(0, 3).map((c) => {
    if (!c || !c.point) return '';
    return c.root_cause ? `${c.point}→${c.root_cause}` : String(c.point);
  }).filter(Boolean);
  if (complaints.length) out.push(`差评地图：${complaints.join('；')}`);
  const position = card.market_position || {};
  const opening = Array.isArray(position.our_opening) ? position.our_opening.slice(0, 3).join('、') : '';
  const positionLine = [position.price_band ? `价格带 ${position.price_band}` : '', opening ? `差异化空位 ${opening}` : ''].filter(Boolean).join('；');
  if (positionLine) out.push(`市场位势：${positionLine}`);
  if (!out.length) return '';
  return block('洞察', lines(out).join('\n'), maxChars);
}

/** prd_card → 演示场景 / 卖点证据 / 合规红线 / 钩子候选（证据块） */
function buildPrdEvidence(cards, { maxChars = DEFAULT_MAX_CHARS } = {}) {
  const card = cards && cards.prd_card ? cards.prd_card : null;
  if (!card) return '';
  const out = [];
  const demos = (card.demo_scenes || []).slice(0, 3).map((s) => {
    const label = [s && s.scene, s && s.persona].filter(Boolean).join('/');
    return label ? `${label}${s && s.mentions ? `(${s.mentions}次)` : ''}` : '';
  }).filter(Boolean);
  if (demos.length) out.push(`演示场景：${demos.join('；')}`);
  const evidence = (card.selling_point_evidence || []).slice(0, 3).map((p) => {
    if (!p || !p.point) return '';
    const nature = p.nature === 'official' ? '官方口径' : '用户共识';
    return `${p.point}(${nature}${p.confidence ? `,${p.confidence}` : ''})`;
  }).filter(Boolean);
  if (evidence.length) out.push(`卖点证据：${evidence.join('；')}`);
  const redlines = (card.compliance_redlines || []).slice(0, 3).map((r) => String(r || '').trim()).filter(Boolean);
  if (redlines.length) out.push(`合规红线：${redlines.join('；')}`);
  const hooks = card.hook_candidates || {};
  const hookBits = [
    Array.isArray(hooks.data_points) ? hooks.data_points.slice(0, 2).join('、') : '',
    Array.isArray(hooks.conflicts) ? hooks.conflicts.slice(0, 2).join('、') : '',
    Array.isArray(hooks.questions) ? hooks.questions.slice(0, 2).join('、') : ''
  ].filter(Boolean);
  if (hookBits.length) out.push(`钩子候选：${hookBits.join('；')}`);
  if (!out.length) return '';
  return block('PRD', lines(out).join('\n'), maxChars);
}

/**
 * 汇总可注入的证据块（只返回非空项；顺序固定 insight → prd，保证可复现）。
 * @returns {Array<{card:string, marker:string, text:string}>}
 */
function buildDossierEvidence(cards, options = {}) {
  const blocks = [];
  const insight = buildInsightEvidence(cards, options);
  if (insight) blocks.push({ card: 'insight_card', marker: MARKER, text: insight });
  const prd = buildPrdEvidence(cards, options);
  if (prd) blocks.push({ card: 'prd_card', marker: MARKER, text: prd });
  return blocks;
}

/** 六张卡的消费矩阵（供审计文档与测试引用） */
function describeCardConsumption() {
  return [
    { card: 'brief_card', consumer: 'MarketingBriefParser.applyBriefCard', status: 'wired' },
    { card: 'theme_card', consumer: 'index.js#_buildThemeInput', status: 'wired' },
    { card: 'insight_card', consumer: 'RequirementDiscoveryEngine（本模块注入 description）', status: 'wired-by-evidence-block' },
    { card: 'prd_card', consumer: 'PRDGenerator（本模块注入 description）', status: 'wired-by-evidence-block' },
    { card: 'portrait_manifest', consumer: 'ProductPortraitBranch（portrait-studio 间接）', status: 'partial' },
    { card: 'router_material', consumer: 'MarketingSkillRouter（路由器未接线）', status: 'unwired' }
  ];
}

module.exports = {
  DOSSIER_EVIDENCE_MARKER: MARKER,
  buildInsightEvidence,
  buildPrdEvidence,
  buildDossierEvidence,
  describeCardConsumption
};
