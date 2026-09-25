'use strict';

/**
 * MessageEnvelope — Agent 间数据管道信封
 * ------------------------------------------------------------
 * 珍妮纺织机流水线中，Agent 之间传递的不是裸数据，而是带完整
 * 追踪信息的信封。信封解决四个问题：
 *   1. 可追溯：trace_id 贯穿全程，任何一条情报能倒查到哪个
 *      Agent 在哪个阶段、基于哪些证据产出
 *   2. 可校验：每个信封进出都要过 HandoffValidator 闸机
 *   3. 可审计：payload 带 sha256 校验和，防篡改、防串包
 *   4. 可回放：created_at + stage 序列支持流水线回放诊断
 */

const crypto = require('crypto');

let _seq = 0;

function _checksum(payload) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(payload == null ? null : payload))
    .digest('hex')
    .slice(0, 16);
}

/**
 * 创建一个信封
 * @param {object} opts
 * @param {string} opts.traceId   流水线追踪编号（同一次挖掘任务全程一致）
 * @param {string} opts.stage     阶段编号：A1_COLLECT / A2_MINE / A3_SCOUT / A4_VERIFY / A5_BIND
 * @param {string} opts.agent     产出 Agent 名
 * @param {string} opts.mode      spec | api
 * @param {object} opts.payload   业务数据本体
 * @param {string[]} [opts.evidenceRefs] 本信封payload引用的证据编号（EvidenceLedger 登记号）
 * @param {string} [opts.prevChecksum] 上游信封校验和（链式锁定，防跳站）
 */
function create(opts = {}) {
  const payload = opts.payload == null ? {} : opts.payload;
  return {
    envelope_id: `ENV-${(++_seq).toString().padStart(5, '0')}`,
    trace_id: opts.traceId || 'TRACE-UNBOUND',
    stage: opts.stage || 'UNKNOWN',
    agent: opts.agent || 'unknown',
    mode: opts.mode || 'spec',
    payload,
    evidence_refs: Array.isArray(opts.evidenceRefs) ? opts.evidenceRefs : [],
    prev_checksum: opts.prevChecksum || null,
    checksum: _checksum(payload),
    created_at: new Date().toISOString()
  };
}

/**
 * 校验信封完整性（结构 + 校验和）
 * @returns {{ok: boolean, issues: string[]}}
 */
function verify(env) {
  const issues = [];
  if (!env || typeof env !== 'object') return { ok: false, issues: ['信封不是对象'] };
  if (!env.envelope_id) issues.push('缺 envelope_id');
  if (!env.trace_id || env.trace_id === 'TRACE-UNBOUND') issues.push('缺有效 trace_id');
  if (!env.stage) issues.push('缺 stage');
  if (!env.agent) issues.push('缺 agent');
  if (!env.checksum) {
    issues.push('缺 checksum');
  } else if (_checksum(env.payload) !== env.checksum) {
    issues.push('checksum 校验失败：payload 与摘要不一致（串包或篡改）');
  }
  return { ok: issues.length === 0, issues };
}

/** 生成流水线追踪编号 */
function newTraceId(productId = '') {
  const stamp = Date.now().toString(36).toUpperCase();
  const rand = crypto.randomBytes(2).toString('hex').toUpperCase();
  const head = String(productId || 'GEN').replace(/[^A-Z0-9]/gi, '').slice(0, 8).toUpperCase() || 'GEN';
  return `LOOM-${head}-${stamp}-${rand}`;
}

/**
 * 校验信封链的**连续性**（防跳站 / 防串包）。
 *
 * 【2026-09-25 修复】此前只校验单个信封的 payload 摘要，`prev_checksum` 写了却没人读——
 * 「链式锁定」只停留在文档里。现在按流水线顺序逐环核对：
 *   ① 每个信封自身通过 verify()；
 *   ② 后一封的 prev_checksum 必须等于前一封的 checksum（首封必须为 null）；
 *   ③ 阶段序列不得跳站（只允许约定的 A1→A2→A3→A4→A5 顺序，缺站由缺站纪律处理，
 *      但**乱序**一律判为被篡改/串包）。
 * @param {Array<object>} envelopes assemble 过程中产出的信封序列
 * @returns {{ok: boolean, issues: string[]}}
 */
const STAGE_ORDER = ['A1_COLLECT', 'A2_MINE', 'A3_SCOUT', 'A4_VERIFY', 'A5_BIND'];

function verifyChain(envelopes = []) {
  const issues = [];
  if (!Array.isArray(envelopes) || envelopes.length === 0) {
    return { ok: false, issues: ['信封链为空：流水线未产出任何站'] };
  }
  let lastIndex = -1;
  envelopes.forEach((env, i) => {
    const self = verify(env);
    if (!self.ok) issues.push(`第 ${i + 1} 封（${env.stage}）自身校验失败：${self.issues.join('；')}`);
    if (i === 0) {
      if (env.prev_checksum) issues.push(`首封 ${env.stage} 不应带 prev_checksum（链起点）`);
    } else {
      const prev = envelopes[i - 1];
      if (env.prev_checksum !== prev.checksum) {
        issues.push(`链断裂：${env.stage} 的 prev_checksum 与上一封 ${prev.stage} 的 checksum 不一致（可能被篡改或串包）`);
      }
    }
    const stageIndex = STAGE_ORDER.indexOf(env.stage);
    if (stageIndex < 0) {
      issues.push(`未知阶段 ${env.stage}：不在契约阶段序列内`);
    } else {
      if (stageIndex <= lastIndex) issues.push(`阶段乱序/重复：${env.stage} 出现在 ${envelopes[i - 1]?.stage} 之后`);
      lastIndex = Math.max(lastIndex, stageIndex);
    }
  });
  return { ok: issues.length === 0, issues };
}

module.exports = { create, verify, verifyChain, newTraceId, STAGE_ORDER };
