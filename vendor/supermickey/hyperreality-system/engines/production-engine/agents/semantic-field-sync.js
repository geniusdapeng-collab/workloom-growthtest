'use strict';

// This module only projects an already guarded native semantic reply. It never
// authors content, calls a model, normalizes the full archive or changes a gate.
const { FIELD_ALIAS_MAP } = require('../../field-standardizer');

const PROTECTED_LABELS = new Set(['语言约束', '基础', '约束', '明亮约束', '负面约束', '台词']);
const UNMAPPED_METADATA = new Set(['语言约束', '台词', '音频纪律', '强制中文输出',
  '商品锚点', '商品一致性', '配乐', '画面文字设计']);
// These existing Phase2 summaries are read ahead of canonical fields by native
// consumers. Structured camera/light/sound plans remain structured source data.
const DERIVED_ALIASES = {
  camera_movement: ['cameraString', 'cameraMovement', 'camera'],
  lighting: ['lightingString'],
  audio: ['backgroundSoundString', 'backgroundSound'],
  scene: ['fusionText'],
};

function parseSections(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('正文为空或不是字符串');
  const matches = [...prompt.matchAll(/【([^【】\r\n]+)】/gu)];
  if (!matches.length) throw new Error('正文没有字段标签');
  const sections = [];
  const seen = new Set();
  let previousEnd = 0;
  for (const match of matches) {
    const between = prompt.slice(previousEnd, match.index);
    if (sections.length === 0) {
      if (!/^\s*(?:\d{1,2}\.[ \t]*)?$/u.test(between)) throw new Error('首标签前有无法解析的内容');
    } else {
      // Only explicit field separators delimit a section. Dialogue pipes and
      // ordinary multiline bodies stay in that same field.
      const separator = /(?:[ \t]+\|[ \t]*|\r?\n[ \t]*(?:\d{1,2}\.[ \t]*)?)$/u.exec(between);
      if (!separator) throw new Error(`标签缺少明确分隔:${match[1]}`);
      sections[sections.length - 1].body = between.slice(0, separator.index).trim();
    }
    if (seen.has(match[1])) throw new Error(`重复字段标签:${match[1]}`);
    seen.add(match[1]);
    sections.push({ label: match[1], body: '' });
    previousEnd = match.index + match[0].length;
  }
  sections[sections.length - 1].body = prompt.slice(previousEnd).trim();
  for (const section of sections) {
    if (!section.body || /[【】]/u.test(section.body)) throw new Error(`字段为空或括号结构不可解析:${section.label}`);
  }
  return sections;
}

function fieldAliases(key) {
  return [...new Set([key, key.replace(/_([a-z])/gu, (_, letter) => letter.toUpperCase()),
    ...Object.entries(FIELD_ALIAS_MAP).filter(([, canonical]) => canonical === key).map(([alias]) => alias),
    ...(DERIVED_ALIASES[key] || [])])];
}

/** Stage the complete projection before the caller changes any result value. */
function synchronizeSemanticFields(result, refinedPrompt, directFieldMap, openingFields) {
  const originalPrompt = result.prompt;
  const fields = result.fields;
  const audit = { schemaVersion: 'workloom.semantic-field-sync/v1', status: 'rejected',
    original: { prompt: originalPrompt }, refined: { prompt: refinedPrompt }, changes: [] };
  try {
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('原始fields不是字段对象');
    audit.original.fields = structuredClone(fields);
    const mapping = new Map(directFieldMap.map(([head, key]) => [head.slice(1, -1), key]));
    for (const { key, label } of openingFields) mapping.set(label, key);
    const original = parseSections(originalPrompt);
    const refined = parseSections(refinedPrompt);
    if (original.length !== refined.length || original.some((section, index) => section.label !== refined[index].label)) {
      throw new Error('字段标签数量或顺序发生变化');
    }
    const identities = new Set();
    const nextFields = { ...fields };
    const topLevel = {};
    const originalTopLevel = {};
    for (let index = 0; index < original.length; index += 1) {
      const before = original[index];
      const after = refined[index];
      const key = mapping.get(before.label);
      if (!key && !UNMAPPED_METADATA.has(before.label)) throw new Error(`未知字段标签:${before.label}`);
      if (key) {
        if (identities.has(key)) throw new Error(`同一字段出现多个标签:${key}`);
        identities.add(key);
      }
      if (before.body === after.body) continue;
      if (PROTECTED_LABELS.has(before.label)) throw new Error(`受保护字段被改写:${before.label}`);
      if (!key) throw new Error(`字段没有可无损同步的映射:${before.label}`);
      if (typeof fields[key] !== 'string') throw new Error(`原字段不是可无损回写的字符串:${key}`);

      const aliases = [];
      const preservedStructuredAliases = [];
      nextFields[key] = after.body;
      for (const alias of fieldAliases(key)) {
        if (Object.hasOwn(fields, alias) && typeof fields[alias] === 'string') {
          nextFields[alias] = after.body;
          aliases.push({ scope: 'fields', key: alias, before: fields[alias], after: after.body });
        }
        if (alias === key || Object.hasOwn(result, alias)) {
          if (!Object.hasOwn(result, alias) || typeof result[alias] === 'string') {
            originalTopLevel[alias] = Object.hasOwn(result, alias) ? result[alias] : null;
            topLevel[alias] = after.body;
            aliases.push({ scope: 'topLevel', key: alias, before: originalTopLevel[alias], after: after.body });
          } else if (result[alias] && typeof result[alias] === 'object') {
            preservedStructuredAliases.push(alias);
          } else if (alias === key) {
            throw new Error(`顶层字段类型不受支持:${key}`);
          }
        }
      }
      audit.changes.push({ label: before.label, field: key, beforePrompt: before.body, afterPrompt: after.body,
        beforeField: fields[key], afterField: after.body, aliases, preservedStructuredAliases });
    }
    const changed = audit.changes.length > 0;
    audit.status = changed ? 'applied' : 'unchanged';
    audit.original.topLevel = structuredClone(originalTopLevel);
    audit.refined.fields = structuredClone(changed ? nextFields : fields);
    audit.refined.topLevel = structuredClone(topLevel);
    return { applied: true, fields: changed ? nextFields : fields, topLevel, audit };
  } catch (error) {
    audit.reason = `字段同步拒绝:${error.message}`;
    // Candidate differences are useful diagnostics, but none were committed.
    return { applied: false, reason: audit.reason, audit };
  }
}

module.exports = { synchronizeSemanticFields };
