'use strict';

/**
 * truth-check-bridge.js —— 营销片「事实红线闸」数据桥（T-2026-0926-0103）
 * ---------------------------------------------------------------------------
 * 背景：营销片管线的 `truth-check` 环节（创意主题之后、业务需求洞察之前）声明
 *       「ProductTruthChecker 一票否决」，但 `product-truth-checker.js` 在全仓
 *       没有任何调用点——闸是纸门。本桥把三方接起来：
 *
 *   情报档案（dossier / 摘要卡）→ researchNotes（带信源）→ ProductTruthChecker.verify()
 *        → conflicts（创意前提与事实矛盾）→ 命中即打回创意，不进洞察与 PRD
 *        → factRedLines（事实红线）→ 注入 PRD「制作约束」章节
 *
 * 纪律（与 data-mining 五条铁律同源）：
 *   1. 纯函数：无 IO、无网络、无 LLM、无时钟依赖，可单测可复算；
 *   2. 不伪造事实：没有证据就返回 degraded（`no-evidence`），绝不补默认事实；
 *   3. 只映射不改写：档案条目原文截断上限 300 字，不重写、不润色；
 *   4. 缺源可见：条目缺 `source` 时原样带着空 source 进 notes，由 checker 报"缺信源标注"。
 */

/** 通用底座四维（与 product-truth-checker 的 UNIVERSAL_DIMENSIONS 同名，避免跨模块耦合） */
const DIM_PREREQ = '使用前提与依赖条件';
const DIM_BOUNDARY = '能力/效果边界';
const DIM_OFFICIAL = '官方宣传口径';
const DIM_PRICE = '价格与购买履约方式';
const FALLBACK_DIMENSIONS = [DIM_PREREQ, DIM_BOUNDARY, DIM_OFFICIAL, DIM_PRICE];

/** 是否营销片运行（与宿主 `dataMiningConfigFor` 的激活条件同源） */
function isMarketingRun(metadata = {}) {
  const m = metadata && typeof metadata === 'object' ? metadata : {};
  if (m.dataMining) return true;
  if (m.pipelineRoute && m.pipelineRoute.kind === 'marketing') return true;
  const brief = m.brief;
  return Boolean(brief && typeof brief === 'object' && typeof brief.product === 'string' && brief.product.trim());
}

/** 取条目文本（兼容 string / {value|text|fact|name|label}） */
function valueText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    const raw = value.value ?? value.text ?? value.fact ?? value.point ?? value.name ?? value.label ?? '';
    return typeof raw === 'string' ? raw : String(raw ?? '');
  }
  return '';
}

/** 取信源（兼容 {source_url|source|url} 与 source_refs 数组） */
function pickSource(value, fallback = '') {
  if (value && typeof value === 'object') {
    const direct = value.source_url || value.source || value.url;
    if (direct) return String(direct);
    const refs = value.source_refs || value.evidence_refs;
    if (Array.isArray(refs) && refs.length > 0) return String(refs[0]);
  }
  return fallback ? String(fallback) : '';
}

/** 用 checker 解析出的维度做精确匹配（品类扩展维度优先，避免被判"调研维度缺失"） */
function matchDimension(text, dimensions) {
  const t = String(text || '');
  for (const dim of dimensions) {
    const parts = String(dim).split(/[/、（）()\s]+/).filter((p) => p.length >= 2);
    for (const part of parts) {
      if (t.includes(part)) return dim;
    }
  }
  return '';
}

/** 无品类维度匹配时的兜底归类（保守：拿不准就进"官方口径"区，不夸大成事实能力） */
function defaultDimension(text) {
  const t = String(text || '');
  if (/前提|依赖|绑定|配对|需要|必须|联网|网络|账号|应用|App|APP|资质|预约|安装|登录/i.test(t)) return DIM_PREREQ;
  if (/续航|充电|兼容|机型|系统|适配|边界|离线|独立|限制|不支持|无法|不能|暂未|仅支持/i.test(t)) return DIM_BOUNDARY;
  if (/价格|售价|价位|购买|渠道|发货|物流|售后|保修|退款|履约|交付|下单|套餐/i.test(t)) return DIM_PRICE;
  return DIM_OFFICIAL;
}

/**
 * 档案 → researchNotes
 * @param {{dossier?:object|null, cards?:object|null, dimensions?:string[], brief?:object}} input
 * @returns {Array<{dimension:string, fact:string, source:string}>}
 */
function buildTruthResearchNotes({ dossier = null, cards = null, dimensions = [], brief = {} } = {}) {
  const dims = Array.isArray(dimensions) && dimensions.length > 0 ? dimensions : FALLBACK_DIMENSIONS;
  const notes = [];
  const seen = new Set();
  const add = (fact, source, hint = '') => {
    const text = String(fact || '').trim();
    if (!text) return;
    const key = `${text}|${source || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    const dim = matchDimension(`${hint}${text}`, dims) || defaultDimension(`${hint}${text}`);
    notes.push({ dimension: dim, fact: text.slice(0, 300), source: String(source || '').trim() });
  };

  const d = dossier && typeof dossier === 'object' ? dossier : null;
  if (d) {
    const specs = d.identity && typeof d.identity.specs === 'object' && d.identity.specs ? d.identity.specs : {};
    for (const [key, value] of Object.entries(specs)) {
      // 条目级事实**不编造来源**：档案规格无 source_url 时留空，由 checker 报"缺信源标注"
      add(`${key}：${valueText(value)}`, pickSource(value, ''), key);
    }
    const sellingPoints = Array.isArray(d.identity && d.identity.official_selling_points) ? d.identity.official_selling_points : [];
    for (const sp of sellingPoints) {
      add(valueText(sp), pickSource(sp, ''), '官方卖点');
    }
    const pros = Array.isArray(d.pros_cons && d.pros_cons.pros) ? d.pros_cons.pros : [];
    for (const p of pros) {
      const nature = String((p && (p.claim_nature || p.nature)) || '');
      const official = /official|官方/.test(nature) || Boolean(p && p.official);
      add(valueText(p), pickSource(p, ''), official ? '官方宣称' : '用户共识');
    }
    const cons = Array.isArray(d.pros_cons && d.pros_cons.cons) ? d.pros_cons.cons : [];
    for (const c of cons) {
      add(valueText(c), pickSource(c, ''), '用户吐槽边界');
    }
    const painPoints = Array.isArray(d.voice_of_customer && d.voice_of_customer.pain_points) ? d.voice_of_customer.pain_points : [];
    for (const p of painPoints) {
      add(valueText(p), pickSource(p, ''), '差评边界');
    }
    if (d.identity && d.identity.price_band) {
      // 价格带是档案聚合字段（样本溯源在 provenance），标注档案路径便于回查
      add(String(d.identity.price_band), 'dossier:identity.price_band', '价格');
    }
  }

  // 档案缺失时，用六张摘要卡兜底（卡片本身由 EvidenceLedger 派生，source 记为卡片溯源路径）
  if (notes.length === 0 && cards && typeof cards === 'object') {
    const briefCard = cards.brief_card || {};
    if (briefCard.product) {
      add(`${briefCard.product}${briefCard.category ? `（${briefCard.category}）` : ''}`, 'dossier:cards.brief_card', '商品身份');
    }
    const sellingPoints = Array.isArray(briefCard.sellingPoints) ? briefCard.sellingPoints : [];
    for (const sp of sellingPoints) add(String(sp), 'dossier:cards.brief_card', '卖点');
    const insight = cards.insight_card || {};
    const complaints = Array.isArray(insight.complaint_map) ? insight.complaint_map : [];
    for (const c of complaints) add(valueText(c), 'dossier:cards.insight_card', '差评边界');
  }

  return notes;
}

/** 创意主题产物 → checker 需要的 {premise, hooks, scenes} */
function buildCreativeInput(task = {}) {
  const t = task && typeof task === 'object' ? task : {};
  const premise = [t.theme, t.description, t.dialogue_requirement, t.special_notes, t.creative_style, t.tone]
    .filter(Boolean)
    .map((v) => String(v))
    .join('\n');
  const hooks = [t.title, t.hook, t.hook_line].filter(Boolean).map((v) => String(v));
  const rawScenes = Array.isArray(t.scenes) ? t.scenes : (Array.isArray(t.scene_list) ? t.scene_list : []);
  const scenes = rawScenes
    .map((s) => (typeof s === 'string' ? s : [s && s.scene, s && s.description, s && s.action].filter(Boolean).join(' ')))
    .filter(Boolean);
  return { premise, hooks, scenes };
}

/**
 * 执行事实红线闸
 * @param {{checker:object, brief?:object, dossier?:object|null, cards?:object|null, creative?:object|null}} input
 * @returns {{pass:boolean, conflicts:Array, issues:string[], factRedLines:string[], factBaseline:object, notes:number, degraded:boolean, degradedReason:string|null}}
 */
function runTruthCheck({ checker, brief = {}, dossier = null, cards = null, creative = null } = {}) {
  if (!checker || typeof checker.verify !== 'function') {
    throw new Error('truth-check-bridge: 缺少 ProductTruthChecker 实例');
  }
  let dimensions = [];
  try {
    const resolved = checker.resolveDimensions(brief.category || '', brief.customDimensions);
    dimensions = Array.isArray(resolved && resolved.dimensions) ? resolved.dimensions : [];
  } catch (_err) {
    dimensions = [];
  }
  const notes = buildTruthResearchNotes({ dossier, cards, dimensions, brief });
  const verdict = checker.verify({ brief, researchNotes: notes, creative: creative || {} });
  const degraded = notes.length === 0;
  /**
   * 阻断口径：只有「创意前提与事实矛盾」（conflicts）才阻断；调研缺口（issues：
   * 维度缺失/缺信源/无记录）作为可见的降级信号落账，不阻断主流程——
   * 与情报层"档案可缺站、缺口必须显式"的既有产品口径一致。
   */
  const blocking = verdict.conflicts.length > 0;
  return {
    ...verdict,
    notes: notes.length,
    blocking,
    degraded,
    degradedReason: degraded ? 'no-evidence' : null
  };
}

module.exports = {
  isMarketingRun,
  buildTruthResearchNotes,
  buildCreativeInput,
  runTruthCheck,
  DIMENSIONS: FALLBACK_DIMENSIONS
};
