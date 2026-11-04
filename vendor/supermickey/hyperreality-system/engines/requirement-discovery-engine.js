/**
 * RequirementDiscoveryEngine - 需求洞察引擎
 * 
 * 职责：基于上游 CreativeThemeGenerator 输出的 12 字段，进行深度业务洞察
 * 输出：《业务需求对齐清单》- 结构化、强约束、可直接进入 PRD 环节
 * 
 * 设计原则：
 * - 输入只认上游 12 字段，不从用户原始输入重新解析
 * - 4 个 Agent 串行执行，每个有独立超时保护
 * - 输出严格遵循 JSON Schema，缺失字段自动兜底
 * - 用户只确认 Yes/No，不主动追问
 * 
 * @version 1.0.0
 * @date 2026-07-04
 */

// ===== JSON Schema 定义 =====

const AudienceProfileSchema = {
  type: "object",
  required: ["primaryAudience", "emotionTriggers", "contentExpectations", "audienceBasis", "audienceEvidenceQuote", "demographicEvidence"],
  properties: {
    primaryAudience: {
      type: "object",
      required: ["ageRange", "gender", "interestTags", "occupation", "consumptionLevel"],
      properties: {
        ageRange: { type: ["string", "null"] },
        gender: { type: ["string", "null"], enum: ["male", "female", "all", null] },
        interestTags: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 5 },
        occupation: { type: ["string", "null"] },
        consumptionLevel: { type: ["string", "null"] }
      },
      additionalProperties: false
    },
    audienceBasis: { type: "string", enum: ["customer-provided", "creative-hypothesis"] },
    audienceEvidenceQuote: { type: ["string", "null"] },
    demographicEvidence: {
      type: "object",
      properties: Object.fromEntries(["ageRange", "gender", "occupation", "consumptionLevel"]
        .map(key => [key, { type: ["string", "null"] }])),
      additionalProperties: false
    },
    secondaryAudience: { type: "array", items: { type: "string" }, maxItems: 3 },
    emotionTriggers: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 5 },
    painPoints: { type: "array", items: { type: "string" }, maxItems: 3 },
    contentExpectations: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 4 }
  },
  additionalProperties: false
};

const SceneStructureSchema = {
  type: "object",
  required: ["opening", "scenes", "ending", "totalDuration", "sceneCount"],
  properties: {
    opening: {
      type: "object",
      required: ["duration", "purpose", "keyElements"],
      properties: {
        duration: { type: "number", minimum: 3, maximum: 15 },
        purpose: { type: "string", minLength: 10, maxLength: 100 },
        keyElements: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 }
      }
    },
    scenes: {
      type: "array",
      items: {
        type: "object",
        required: ["index", "duration", "purpose", "keyElements", "emotionalBeat"],
        properties: {
          index: { type: "number" },
          duration: { type: "number", minimum: 5, maximum: 60 },
          purpose: { type: "string", minLength: 10, maxLength: 100 },
          keyElements: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 },
          emotionalBeat: { type: "string", enum: ["setup", "rising", "climax", "falling", "resolution", "twist"] }
        }
      },
      minItems: 0,
      maxItems: 8
    },
    ending: {
      type: "object",
      required: ["duration", "purpose", "keyElements"],
      properties: {
        duration: { type: "number", minimum: 3, maximum: 15 },
        purpose: { type: "string", minLength: 10, maxLength: 100 },
        keyElements: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 }
      }
    },
    totalDuration: { type: "number" },
    sceneCount: { type: "number" },
    narrativeArc: { type: "string", enum: ["linear", "loop", "flashback", "parallel", "twist"] }
  },
  additionalProperties: false
};

const RiskAssessmentSchema = {
  type: "object",
  required: ["technicalRisks", "businessConstraints", "mitigationSuggestions"],
  properties: {
    technicalRisks: {
      type: "array",
      items: {
        type: "object",
        required: ["risk", "level", "impact"],
        properties: {
          risk: { type: "string" },
          level: { type: "string", enum: ["high", "medium", "low"] },
          impact: { type: "string" }
        }
      },
      minItems: 1,
      maxItems: 5
    },
    businessConstraints: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: 4
    },
    mitigationSuggestions: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: 4
    }
  },
  additionalProperties: false
};

const ReferenceCasesSchema = {
  type: "object",
  required: ["filmReferences", "adReferences", "styleReferences"],
  properties: {
    filmReferences: {
      type: "array",
      items: {
        type: "object",
        required: ["title", "relevance", "keyTakeaway", "sourceQuote"],
        properties: {
          title: { type: "string" },
          relevance: { type: "string", enum: ["high", "medium", "low"] },
          keyTakeaway: { type: "string" },
          sourceQuote: { type: "string" }
        }
      },
      minItems: 0,
      maxItems: 4
    },
    adReferences: {
      type: "array",
      items: {
        type: "object",
        required: ["brand", "relevance", "keyTakeaway", "sourceQuote"],
        properties: {
          brand: { type: "string" },
          relevance: { type: "string", enum: ["high", "medium", "low"] },
          keyTakeaway: { type: "string" },
          sourceQuote: { type: "string" }
        }
      },
      minItems: 0,
      maxItems: 3
    },
    styleReferences: {
      type: "array",
      items: { type: "string" },
      minItems: 2,
      maxItems: 4
    }
  },
  additionalProperties: false
};

const RequirementAlignmentSchema = {
  type: "object",
  required: [
    "upstreamFields",
    "audienceProfile",
    "sceneStructure",
    "riskAssessment",
    "referenceCases",
    "confirmationStatus"
  ],
  properties: {
    upstreamFields: { type: "object" },
    audienceProfile: AudienceProfileSchema,
    sceneStructure: SceneStructureSchema,
    riskAssessment: RiskAssessmentSchema,
    referenceCases: ReferenceCasesSchema,
    confirmationStatus: {
      type: "object",
      required: ["status", "timestamp"],
      properties: {
        status: { type: "string", enum: ["pending", "confirmed", "modified"] },
        userFeedback: { type: "string" },
        timestamp: { type: "string" }
      }
    }
  },
  additionalProperties: false
};

// Creative interests and viewing motives are proposals. Demographics and named
// references need the caller's customer text, never an upstream model's guess.
function customerIntent(input = {}) {
  if (Object.hasOwn(input, '_workloomCustomerIntent')) {
    return typeof input._workloomCustomerIntent === 'string' ? input._workloomCustomerIntent : '';
  }
  return String(input._originalStoryText || input.original_story_text || '');
}

function nonemptyText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function sourceQuoteContexts(source, quote) {
  if (!quote || !source.includes(quote)) return [];
  const needle = quote.trim().replace(/[。！？!?；;\n]+$/u, '').trim();
  // A provenance quote cannot borrow an audience marker from one sentence and
  // a character's demographic from the next sentence.
  if (!needle || /[。！？!?；;\n]/u.test(needle)) return [];
  const contexts = [];
  for (const sentence of source.match(/[^。！？!?；;\n]+/gu) || []) {
    let index = sentence.indexOf(needle);
    while (index >= 0) {
      contexts.push({ sentence, index, needle });
      index = sentence.indexOf(needle, index + 1);
    }
  }
  return contexts;
}

function negativeAudiencePolarity(text) {
  const normalized = text.replace(/不限性别|性别不限|不分性别|不低于|不高于|不少于|不大于|不超过|不小于/gu, '');
  return /不|未|并非|而非|排除|除外|禁止|严禁|避免|勿|别|\b(?:not|never|exclude|excluding)\b/iu.test(normalized);
}

function customerAudienceClause(source, quote) {
  if (/(?:不|未|没有|无需)(?:再|明确)?(?:指定|设定|限定)(?:任何)?(?:受众|观众)(?:的)?人口(?:属性|特征|信息)?|(?:受众|观众)(?:的)?人口(?:属性|特征|信息)?(?:未|不|无需)(?:指定|设定|限定)/u.test(source)) return null;
  const contexts = sourceQuoteContexts(source, quote);
  if (!contexts.length) return null;
  const marker = /(?:目标)?(?:受众|观众|人群|观看者)|面向|目标(?:客户|用户)|\b(?:audience|viewers)\b|(?:给|供)(?=[^。！？\n]{0,80}(?:观看|看))/iu.exec(contexts[0].needle);
  if (!marker) return null;
  const relation = contexts[0].needle.slice(marker.index + marker[0].length);
  if (!/^(?:面向|给|供)$/u.test(marker[0])
    && !/^\s*(?:[:：=]|(?:主要|明确|应当|应|设定|定位|设置|设)?(?:为|是)|包括|包含|以|is\b|are\b)/iu.test(relation)) return null;
  for (const { sentence, index } of contexts) {
    const markerIndex = index + marker.index;
    const prefix = sentence.slice(0, markerIndex).split(/[，,]/u).pop();
    const firstAudienceClause = sentence.slice(markerIndex).split(/[，,]/u)[0];
    // Check the actual raw occurrence, including a negative prefix the model
    // may have cut out of sourceQuote. Ambiguous repeated occurrences fail shut.
    if (negativeAudiencePolarity(prefix) || negativeAudiencePolarity(firstAudienceClause)
      || /(?:受众|观众|人群)[^，,]{0,8}(?:未知|不明)/u.test(firstAudienceClause)) return null;
  }
  return contexts[0].needle.slice(marker.index);
}

function demographicValueMatchesQuote(key, value, quote) {
  if (!value || !quote) return false;
  if (key === 'gender') {
    const patterns = {
      male: /男性|男士|男生|男观众|\bmale\b|\bmen\b/iu,
      female: /女性|女士|女生|女观众|\bfemale\b|\bwomen\b/iu,
      all: /性别不限|不限性别|不分性别|男女皆可|所有性别|\ball genders\b/iu
    };
    return patterns[value]?.test(quote) === true;
  }
  if (key === 'consumptionLevel') {
    const patterns = {
      low: /低消费|消费(?:能力|水平)?低|低收入|\blow\b/iu,
      medium: /中等|中消费|消费(?:能力|水平)?中|\bmedium\b/iu,
      high: /高消费|消费(?:能力|水平)?高|高收入|\bhigh\b/iu,
      luxury: /奢侈|奢华|\bluxury\b/iu
    };
    if (Object.hasOwn(patterns, value)) return patterns[value].test(quote);
  }
  const normalize = text => text.replace(/\s|岁/gu, '').replace(/至|到|[~～—–]/gu, '-');
  return normalize(quote).includes(normalize(value));
}

function positiveDemographicQuote(clause, quote) {
  const segments = clause.split(/[，,；;。！？!?\n]/u).filter(segment => segment.includes(quote));
  return segments.length > 0 && segments.every(segment => {
    const viewingObject = segment.replace(/观看者/gu, '受众者')
      .search(/看|欣赏|拍摄|扮演|表演|\bwatch(?:es|ing)?\b/iu);
    const quoteEnd = segment.lastIndexOf(quote) + quote.length;
    return !negativeAudiencePolarity(segment)
      && !/(?:主角|配角|演员|出镜角色|人物|模特)(?:是|为|设为)/u.test(segment)
      && !(viewingObject >= 0 && viewingObject < quoteEnd);
  });
}

function sourceBoundAudience(result, input = {}) {
  const value = result && typeof result === 'object' ? result : {};
  const primary = value.primaryAudience && typeof value.primaryAudience === 'object' ? value.primaryAudience : {};
  const source = customerIntent(input);
  const proposedAudienceQuote = nonemptyText(value.audienceEvidenceQuote);
  const audienceClause = value.audienceBasis === 'customer-provided'
    ? customerAudienceClause(source, proposedAudienceQuote) : null;
  const audienceQuote = audienceClause ? proposedAudienceQuote : null;
  const evidence = value.demographicEvidence && typeof value.demographicEvidence === 'object' ? value.demographicEvidence : {};
  const primaryAudience = { interestTags: Array.isArray(primary.interestTags) ? [...primary.interestTags] : [] };
  const demographicEvidence = {};
  const excludedDemographics = Array.isArray(value.excludedDemographics) ? [...value.excludedDemographics] : [];
  for (const key of ['ageRange', 'gender', 'occupation', 'consumptionLevel']) {
    const candidate = nonemptyText(primary[key]);
    const quote = nonemptyText(evidence[key]);
    const supported = candidate && quote && audienceClause && audienceClause.includes(quote)
      && source.includes(quote) && positiveDemographicQuote(audienceClause, quote)
      && demographicValueMatchesQuote(key, candidate, quote);
    primaryAudience[key] = supported ? candidate : null;
    demographicEvidence[key] = supported ? quote : null;
    if (candidate && !supported) {
      const excluded = { field: key, value: candidate, quote, reason: 'customer-demographic-evidence-missing-or-incompatible' };
      if (!excludedDemographics.some(item => JSON.stringify(item) === JSON.stringify(excluded))) excludedDemographics.push(excluded);
    }
  }
  return {
    ...value,
    primaryAudience,
    audienceBasis: audienceQuote ? 'customer-provided' : 'creative-hypothesis',
    audienceEvidenceQuote: audienceQuote,
    demographicEvidence,
    excludedDemographics
  };
}

function measuredSceneStructure(result) {
  const value = result && typeof result === 'object' ? result : {};
  const nodes = [value.opening, ...(Array.isArray(value.scenes) ? value.scenes : []), value.ending]
    .filter(node => node && typeof node === 'object');
  const durations = nodes.map(node => node.duration);
  return {
    ...value,
    sceneCount: nodes.length,
    ...(durations.every(duration => typeof duration === 'number' && Number.isFinite(duration) && duration >= 0)
      ? { totalDuration: durations.reduce((sum, duration) => sum + duration, 0) } : {})
  };
}

const referenceUsageRestriction = '仅借鉴拍摄手法，不使用或复刻可识别素材';

function customerReferenceQuote(source, name, quote) {
  if (!name || !quote || !source.includes(quote) || !quote.includes(name)) return false;
  const contexts = sourceQuoteContexts(source, quote);
  if (!contexts.length || !/参考|借鉴|对标|风格|提供|启发|\breference\b/iu.test(quote)) return false;
  return contexts.every(({ sentence, index, needle }) => {
    const nameIndex = index + needle.indexOf(name);
    const start = Math.max(sentence.lastIndexOf('，', nameIndex), sentence.lastIndexOf(',', nameIndex)) + 1;
    const next = sentence.slice(nameIndex + name.length).search(/[，,]/u);
    const end = next >= 0 ? nameIndex + name.length + next : sentence.length;
    return !/不|未|禁止|严禁|避免|勿|别|排除|\b(?:not|never|exclude)\b/iu.test(sentence.slice(start, end));
  });
}

function sourceBoundReferences(result, input = {}) {
  const value = result && typeof result === 'object' ? result : {};
  const source = customerIntent(input);
  const excludedReferences = Array.isArray(value.excludedReferences) ? [...value.excludedReferences] : [];
  const keep = (items, field) => (Array.isArray(items) ? items : []).filter(item => {
    const name = nonemptyText(item?.[field]);
    const quote = nonemptyText(item?.sourceQuote);
    const supported = customerReferenceQuote(source, name, quote);
    if (!supported) excludedReferences.push({ field, value: item, reason: 'customer-reference-evidence-missing-or-incompatible' });
    return supported;
  }).map(item => ({ ...item, usageRestriction: referenceUsageRestriction }));
  const filmReferences = keep(value.filmReferences, 'title');
  const adReferences = keep(value.adReferences, 'brand');
  const allowedNames = new Set([...filmReferences.map(item => item.title), ...adReferences.map(item => item.brand)]);
  const styleReferences = (Array.isArray(value.styleReferences) ? value.styleReferences : []).filter(item => {
    if (typeof item !== 'string' || !item.trim()) return false;
    const titles = [...item.matchAll(/《[^》]+》/gu)].map(match => match[0]);
    const supported = titles.every(title => allowedNames.has(title));
    if (!supported) excludedReferences.push({ field: 'styleReferences', value: item, reason: 'unprovided-named-work-in-technique' });
    return supported;
  });
  return { ...value, filmReferences, adReferences,
    styleReferences, excludedReferences };
}

// ===== Agent 基类 =====

class BaseDiscoveryAgent {
  constructor(options = {}) {
    this.name = options.name || 'unnamed-agent';
    this.llmEngine = options.llmEngine || null;
    this.timeoutMs = options.timeoutMs || 90000; // 90 秒默认
    this.maxRetries = options.maxRetries || 1;
  }

  async run(input, schema) {
    const startTime = Date.now();
    
    for (let i = 0; i <= this.maxRetries; i++) {
      try {
        const result = await this._callLLM(input, schema);
        const validated = this._validateAndFill(result, schema, input);
        console.log(`   [${this.name}] ✅ 完成 (${Date.now() - startTime}ms)`);
        return validated;
      } catch (error) {
        console.warn(`   [${this.name}] ⚠️ 第${i + 1}次失败: ${error.message}`);
        if (i === this.maxRetries) {
          console.warn(`   [${this.name}] ❌ 全部失败，使用兜底规则`);
          return this._fallback(input, schema);
        }
      }
    }
  }

  async _callLLM(input, schema) {
    if (!this.llmEngine) {
      throw new Error('LLM 引擎未初始化');
    }

    const prompt = this._buildPrompt(input);
    
    // 【方案A-fix】原始故事文本注入：从 input 中提取并追加到 prompt
    const originalStory = input._originalStoryText || input.original_story_text || '';
    const fullPrompt = originalStory ? `${prompt}\n\n## 📖 原始故事文本（需求分析的核心依据）\n${originalStory}` : prompt;
    
    // 超时保护
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('LLM 调用超时')), this.timeoutMs);
    });

    let responseText = '';

    try {
      if (typeof this.llmEngine.reasonStructured === 'function') {
        // 【v2.1.9-fix】SceneArchitect 的 schema 过大，导致 prompt 膨胀挤干 content
        // 改用 prompt 自描述模式，不传 schema 给 reasonStructured
        const useSchema = this.name === 'SceneArchitect' ? null : schema;
        console.log(`[DEBUG] Agent=${this.name}, useSchema=${useSchema === null ? 'null' : 'provided'}, schemaSize=${useSchema ? JSON.stringify(useSchema).length : 0}`);
        
        // Require structured JSON and disable reasoning so completion tokens
        // are spent on the scene contract rather than hidden reasoning.
        if (this.name === 'SceneArchitect') {
          const result = await Promise.race([
            this.llmEngine.reason(fullPrompt, { 
              maxTokens: 16384,
              temperature: 0.4,
              timeoutMs: this.timeoutMs,
              forceJson: true,
              thinking: { type: 'disabled' }
            }),
            timeoutPromise
          ]);
          if (!result.success) throw new Error(result.error);
          // 手动从 content 提取 JSON
          const extracted = this.llmEngine._extractJsonObject(result.content);
          if (!extracted) throw new Error('无法从 content 提取 JSON');
          return JSON.parse(extracted);
        }
        
        const result = await Promise.race([
          this.llmEngine.reasonStructured(fullPrompt, useSchema, { 
            maxTokens: 4000, 
            temperature: 1.0,
            timeoutMs: this.timeoutMs 
          }),
          timeoutPromise
        ]);
        return result.data || result;
      } else if (typeof this.llmEngine.generate === 'function') {
        const result = await Promise.race([
          this.llmEngine.generate(fullPrompt, { maxTokens: 4000, temperature: 1.0 }),
          timeoutPromise
        ]);
        responseText = result.content || '';
      } else if (typeof this.llmEngine.chat === 'function') {
        const result = await Promise.race([
          this.llmEngine.chat('你是一位资深视频业务分析师。只输出严格格式的JSON。', prompt, 1.0),
          timeoutPromise
        ]);
        responseText = result.content || result.data || '';
      } else {
        throw new Error('LLM 引擎无可用的调用方法');
      }
    } catch (error) {
      throw error;
    }

    // 解析 JSON
    try {
      const jsonMatch = responseText.match(/```json\n?([\s\S]*?)\n?```/) ||
                        responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[1] || jsonMatch[0]);
      }
      throw new Error('无法解析 LLM 输出为 JSON');
    } catch (e) {
      throw new Error(`JSON 解析失败: ${e.message}`);
    }
  }

  _validateAndFill(result, schema) {
    // 递归检查 required 字段，缺失则使用 _fallback 补全
    return this._fillDefaults(result, schema);
  }

  _fillDefaults(result, schema, path = '') {
    if (!result || typeof result !== 'object') {
      return this._fallback({}, schema);
    }

    const filled = { ...result };

    // 检查 required 字段
    if (schema.required) {
      for (const key of schema.required) {
        if (filled[key] === undefined || filled[key] === null) {
          // 从 fallback 获取默认值
          const fallback = this._fallback({}, schema);
          filled[key] = fallback[key];
        }
      }
    }

    // 递归处理对象属性
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (filled[key] && propSchema.type === 'object') {
          filled[key] = this._fillDefaults(filled[key], propSchema, `${path}.${key}`);
        }
      }
    }

    // 递归处理数组 items
    if (schema.items && Array.isArray(filled)) {
      filled = filled.map((item, i) => 
        this._fillDefaults(item, schema.items, `${path}[${i}]`)
      );
    }

    return filled;
  }

  _buildPrompt(input) {
    throw new Error('子类必须实现 _buildPrompt');
  }

  _fallback(input, schema) {
    throw new Error('子类必须实现 _fallback');
  }
}

// ===== 4 个洞察 Agent =====

class AudienceProfiler extends BaseDiscoveryAgent {
  constructor(options) {
    super({ name: 'AudienceProfiler', ...options });
  }

  _buildPrompt(input) {
    const { type, theme, tone, description, target_audience } = input;
    return `你是一位操过多个全球爆款短片的传播策略师。基于视频主题做受众分析，但你输出的不是"人群标签"，而是"这群人为什么会在第3秒停下来、在第50秒转发"。

视频类型: ${type}
核心主题: ${theme}
情绪基调: ${tone || '未指定'}
主题描述: ${description || '未提供'}
上游受众提案（不得自动当作客户人口事实）: ${target_audience || '未指定'}
客户原文（人口属性与受众来源的唯一依据）: ${customerIntent(input) || '未提供'}

【分析心法】
1. emotionTriggers 必须写到具体画面级：不是'匠人精神感人'，而是'老匠人颤抖的手与一整车人的安危之间的张力'——每个触发点都要能直接翻译成镜头。
2. painPoints 写现代生活的缺失感（快节奏/技艺消逝/承诺稀缺），不写生理痛点。
3. contentExpectations 至少包含一条'无需字幕也能看懂的视觉叙事'类要求，和一条可复述的画面记忆点；声音严格遵循客户合同，无台词时不得为了传播增加台词。
4. secondaryAudience 写'有具体记忆关联的人'（去过京都的游客/手艺人），不写泛人群。

【来源合同】观看兴趣、情绪触发、动机、次要受众与内容期望均是本片创作假设，不是用户调查或人口统计结论。只有客户明确指定的受众条款（例如包含“受众”“面向”“给某人群看”的完整原句）可以标为 customer-provided；原文仅有演员、人物或故事角色的属性不能作为受众依据。客户没有明确受众人口属性时，ageRange、gender、occupation、consumptionLevel 必须为 null。不得根据影片类型、演员年龄性别、品牌、平台或兴趣猜人口属性。明确给出的属性逐字保留其含义，不局限于固定年龄段。每个非空人口字段必须在 demographicEvidence 给出客户受众条款中的连续引用，并包含在 audienceEvidenceQuote 的受众部分中。

请输出 JSON 格式的受众分析：
{
  "primaryAudience": {
    "ageRange": null,
    "gender": null,
    "interestTags": ["标签1", "标签2", "标签3"],
    "occupation": null,
    "consumptionLevel": null
  },
  "audienceBasis": "creative-hypothesis",
  "audienceEvidenceQuote": null,
  "demographicEvidence": {"ageRange": null, "gender": null, "occupation": null, "consumptionLevel": null},
  "secondaryAudience": ["次要受众1", "次要受众2"],
  "emotionTriggers": ["情绪触发点1", "情绪触发点2", "情绪触发点3"],
  "painPoints": ["痛点1", "痛点2"],
  "contentExpectations": ["期望1", "期望2", "期望3"]
}

要求：
1. 无客户人口依据的字段必须是 JSON null；不得用 all、medium 或通用人群代替未知
2. gender 仅在客户明确给出时用 male/female/all；all 必须有客户明确“不限性别”的原文依据
3. interestTags 2-5个
4. 客户明确给出受众时 audienceBasis=customer-provided，并在 audienceEvidenceQuote 逐字引用完整受众条款；否则 creative-hypothesis 和 null
5. 保留具体观看兴趣和动机，不套人口模板，不编造消费能力或职业`;
  }

  _validateAndFill(result, schema, input = {}) {
    return sourceBoundAudience(super._validateAndFill(result, schema), input);
  }

  _fallback(input = {}) {
    return sourceBoundAudience({
      primaryAudience: {
        ageRange: null, gender: null, occupation: null, consumptionLevel: null,
        interestTags: [input.theme || '待补充具体观看兴趣', input.visual_style || '待补充观看动机']
      },
      secondaryAudience: [],
      emotionTriggers: [input.description || '待作者补充具体画面触发点'],
      painPoints: [],
      contentExpectations: [input.target_audience || '待作者基于当前内容补充观看动机']
    }, input);
  }
}

class SceneArchitect extends BaseDiscoveryAgent {
  constructor(options) {
    super({ name: 'SceneArchitect', ...options });
  }

  _buildPrompt(input) {
    const { type, theme, duration_sec, tone, description } = input;
    const duration = duration_sec || 45;
    const sceneCount = Math.min(Math.max(Math.ceil(duration / 15), 3), 8);
    const example = this._fallback(input);

    // 【P0-PE-01】根据类型注入电影语法参考
    const filmGrammar = this._getFilmGrammar(type);

    return `你是一位电影导演，正在为AI视频生成系统设计场景结构。每个场景的设计要回答三个问题：观众看到了什么？观众感受到了什么？观众为什么继续看下去？

视频类型: ${type}
核心主题: ${theme}
目标时长: ${duration}秒
情绪基调: ${tone || '未指定'}
主题描述: ${description || '未提供'}

${filmGrammar}

请设计约 ${sceneCount} 个实际场景节点（含开场和结尾），总时长约 ${duration} 秒。sceneCount 等于 opening、scenes 与 ending 的实际节点数之和；scenes 数组只装主体场景，不重复存开场与结尾。

输出 JSON 格式（严格遵守，只输出合法 JSON，不要 markdown 代码块）：
${JSON.stringify(example)}

要求：
1. 所有场景时长之和 ≈ ${duration} 秒
2. 每个场景必须有 emotionalBeat（从枚举中选一个：setup/rising/climax/falling/resolution/twist）
3. 场景按叙事节奏排列：setup → rising → climax → resolution
4. 关键元素 1-3 个
5. purpose 必须具体、电影化，避免"推动叙事发展"这种泛化描述。要回答：观众看到了什么具体画面？感受到了什么情绪？为什么继续看？
6. 只输出 JSON，不要任何解释文字

【结构心法——三幕呼吸法】
1. opening（前3秒抓眼）：第一帧即悬念——把全片最大的矛盾浓缩成一个画面（巨大vs渺小/颤抖的手vs一整车安危），禁止平铺直叙的建立镜头。
2. 每个 scenes[i].purpose 必须写'删掉这镜故事会损失什么'——答不上来就说明这镜该删。
3. 情绪弧线必须有'换气口'：高潮(climax)之后、结尾(ending)之前，安排一个 falling 级的留白场景（3-6秒），让最后的释放有落差。60秒短片没有喘息就是噪音。
4. ending 落到具体细节或动作的收束结构；声音遵循客户已确认要求，无台词时不得补一句台词。
5. keyElements 只写能被镜头拍到的物理元素，禁止'氛围''感觉'类词。

【时长铁律】所有场景时长之和≈目标时长；climax 场景时长必须≥任一其他场景的1.3倍——重点不突出等于没有重点。`;
  }

  // 【P0-PE-01 新增】类型化电影语法引导
  _getFilmGrammar(type) {
    const grammar = {
      '硬科幻': '【电影语法参考】关注：空间尺度感、科技纹理细节、冷色调光影、未知文明的神秘感',
      '赛博朋克': '【电影语法参考】关注：霓虹反射、雨夜氛围、高低反差构图、东方未来主义',
      '武侠动作': '【电影语法参考】关注：动作留白、气流轨迹、武器反光、身体动态线',
      '恐怖悬疑': '【电影语法参考】关注：阴影层次、声音引导视线、封闭空间压迫感、未知轮廓',
      '自然纪录片': '【电影语法参考】关注：自然光变化、微距纹理、生物行为瞬间、生态系统的关联性',
      '商业广告': '【电影语法参考】关注：产品质感光、品牌色自然融入、生活方式氛围、欲望触发点',
      '音乐MV': '【电影语法参考】关注：节拍可视化、色彩情绪映射、舞蹈动态线、视觉节奏剪辑点',
      '家庭温情': '【电影语法参考】关注：自然光室内、人物互动微表情、日常仪式感、温暖色调',
      '浪漫爱情': '【电影语法参考】关注：眼神光、身体距离变化、环境情绪映射、时间流逝感',
      '艺术实验': '【电影语法参考】关注：抽象形态运动、色彩情绪、超现实空间、视觉隐喻',
      '社会现实': '【电影语法参考】关注：真实环境质感、自然光下的社会纹理、人物与环境的关系、长镜头中的时间流动'
    };
    return grammar[type] || '【电影语法参考】关注：视觉焦点引导、情绪光影、空间层次、动作张力';
  }

  _validateAndFill(result, schema) {
    return measuredSceneStructure(super._validateAndFill(result, schema));
  }

  _fallback(input = {}) {
    const supplied = Number(input.duration_sec);
    const duration = Number.isFinite(supplied) && supplied > 0 ? supplied : 45;
    const sceneCount = Math.min(Math.max(Math.ceil(duration / 15), 3), 8);
    const bookendDuration = Math.min(3, duration / 3);
    const bodyCount = sceneCount - 2;
    const perScene = (duration - bookendDuration * 2) / bodyCount;

    const scenes = [];
    const beats = ['setup', 'rising', 'climax', 'falling', 'resolution'];
    
    for (let i = 0; i < bodyCount; i++) {
      scenes.push({
        index: i + 1,
        duration: i === bodyCount - 1 ? duration - bookendDuration * 2 - perScene * (bodyCount - 1) : perScene,
        purpose: `场景${i + 1}：推动叙事发展`,
        keyElements: ['核心动作', '情绪表达'],
        emotionalBeat: beats[i % beats.length]
      });
    }

    return measuredSceneStructure({
      opening: {
        duration: bookendDuration,
        purpose: '建立场景氛围，引入主题',
        keyElements: ['环境展示', '主题暗示']
      },
      scenes,
      ending: {
        duration: bookendDuration,
        purpose: '总结收尾，留下印象',
        keyElements: ['情绪收束', '主题呼应']
      },
      totalDuration: duration,
      sceneCount: sceneCount,
      narrativeArc: 'linear'
    });
  }
}

class RiskAssessor extends BaseDiscoveryAgent {
  constructor(options) {
    super({ name: 'RiskAssessor', ...options });
  }

  _buildPrompt(input) {
    const { type, theme, visual_style, special_notes } = input;
    return `你是一位既懂 AI 视频生成模型能力边界、又懂影视制作的技术制片人。评估的核心问题是：这个故事里哪些画面是当前视频生成模型最容易翻车的？翻车了会不会毁掉全片？

视频类型: ${type}
核心主题: ${theme}
视觉风格: ${visual_style || '未指定'}
特殊要求: ${special_notes || '无'}

【评估心法】
1. 只评'致命级画面'：精细手部动作（系扣/咬绳/穿引）、大尺度木构透视、跨时空闪回的角色呼应、万人大场面——凡是模型弱项+故事泪点重叠的地方，才是 high。
2. 每条 mitigation 必须是可执行的镜头语言方案：'拆分为2-3个连续特写降低单镜头动作复杂度'、'用仰拍局部+声音设计暗示规模代替全景人群'——禁止'加强质量控制'类废话。
3. businessConstraints 必须包含：全球观众零背景知识可懂、无字幕依赖、无虚构特效元素（真实祭典/纪实类）。

请输出 JSON 格式：
{
  "technicalRisks": [
    {
      "risk": "风险描述",
      "level": "high|medium|low",
      "impact": "影响描述"
    }
  ],
  "businessConstraints": [
    "业务约束1",
    "业务约束2"
  ],
  "mitigationSuggestions": [
    "缓解建议1",
    "缓解建议2"
  ]
}

要求：
1. technicalRisks 1-5 个
2. businessConstraints 1-4 个
3. mitigationSuggestions 1-4 个
4. 风险 level 必须从枚举中选择`;
  }

  _fallback(input) {
    const typeToRisks = {
      '硬科幻': [
        { risk: '特效渲染复杂度高', level: 'high', impact: '可能需要更长的渲染时间' },
        { risk: '科学准确性要求', level: 'medium', impact: '需要专业顾问审核' }
      ],
      '赛博朋克': [
        { risk: '霓虹光效渲染', level: 'medium', impact: '需要精确的体积光模拟' }
      ],
      '武侠动作': [
        { risk: '动作流畅度', level: 'high', impact: '需要专业的动作设计' },
        { risk: '服装布料解算', level: 'medium', impact: '古风服装需要精细模拟' }
      ],
      '恐怖悬疑': [
        { risk: '氛围营造', level: 'medium', impact: '需要精确的光影和音效配合' }
      ],
      '自然纪录片': [
        { risk: '素材质量', level: 'medium', impact: '需要高质量的实拍素材或精细的3D建模' }
      ],
      '商业广告': [
        { risk: '产品展示精度', level: 'high', impact: '需要精确还原产品细节' }
      ],
      '音乐MV': [
        { risk: '音画同步', level: 'high', impact: '需要精确的时间轴控制' }
      ]
    };

    const defaultRisks = [
      { risk: 'AI生成质量不确定性', level: 'medium', impact: '可能需要多次迭代' },
      { risk: '时长控制', level: 'low', impact: '需要精确的镜头时长分配' }
    ];

    return {
      technicalRisks: typeToRisks[input.type] || defaultRisks,
      businessConstraints: ['目标时长限制', '平台画幅要求'],
      mitigationSuggestions: ['预留重试时间', '准备备选方案']
    };
  }
}

class ReferenceCurator extends BaseDiscoveryAgent {
  constructor(options) {
    super({ name: 'ReferenceCurator', ...options });
  }

  _buildPrompt(input) {
    const { type, theme, tone, visual_style } = input;
    return `你是一位剪辑指导。为本片提出可执行的构图、运镜、用光与声音策略。具名第三方作品只能来自客户明确提供的参考，不能自行从片库选片或指定品牌广告。

视频类型: ${type}
核心主题: ${theme}
情绪基调: ${tone || '未指定'}
视觉风格: ${visual_style || '未指定'}
客户原文: ${customerIntent(input) || '未提供'}

【推荐心法】
1. 客户未明确给出影片时 filmReferences=[]，未给出广告参考时 adReferences=[]。不设具名参考数量下限，不默认任何文化、导演、电影或品牌。
2. 只在客户原文明确给出参考时保留 title/brand；sourceQuote 必须逐字引用含该名称的客户原文，keyTakeaway 只写可借鉴的拍摄手法。
3. 每项具名参考均遵守：${referenceUsageRestriction}；不得把提名当作素材授权。
4. styleReferences 直接写本片可执行、不具名的视听策略，遵守当前声音、时长、动作和视觉合同；不在字符串里夹带未经客户提供的电影、导演或品牌名。

请输出 JSON 格式：
{
  "filmReferences": [],
  "adReferences": [],
  "styleReferences": [
    "风格参考1",
    "风格参考2"
  ]
}

要求：
1. filmReferences 0-4 个，adReferences 0-3 个；只有客户有明确提名及完整 sourceQuote 才能非空
2. styleReferences 2-4 个，必须结合本片的具体画面、节奏和声音
3. 客户具名参考的相关度从 high/medium/low 中选择，禁止新增提名`;
  }

  _validateAndFill(result, schema, input = {}) {
    return sourceBoundReferences(super._validateAndFill(result, schema), input);
  }

  _fallback(input = {}) {
    return sourceBoundReferences({
      filmReferences: [],
      adReferences: [],
      styleReferences: [input.visual_style || '待作者基于当前画面合同补充具体视听手法']
    }, input);
  }
}

// ===== 主引擎 =====

class RequirementDiscoveryEngine {
  constructor(options = {}) {
    this.llmEngine = options.llmEngine || null;
    this.agentTimeoutMs = options.agentTimeoutMs || 180000; // 【v2.1.8-fix】180 秒/Agent
    
    // 初始化 4 个 Agent
    this.agents = {
      audience: new AudienceProfiler({ 
        llmEngine: this.llmEngine, 
        timeoutMs: this.agentTimeoutMs  // 【v2.1.8-fix】180秒/Agent
      }),
      scene: new SceneArchitect({ 
        llmEngine: this.llmEngine, 
        timeoutMs: this.agentTimeoutMs  // 【v2.1.8-fix】180秒/Agent
      }),
      risk: new RiskAssessor({ 
        llmEngine: this.llmEngine, 
        timeoutMs: this.agentTimeoutMs  // 【v2.1.8-fix】180秒/Agent
      }),
      reference: new ReferenceCurator({ 
        llmEngine: this.llmEngine, 
        timeoutMs: this.agentTimeoutMs  // 【v2.1.8-fix】180秒/Agent
      })
    };

    this.startTime = null;
  }

  /**
   * 主入口：基于上游 12 字段生成业务需求对齐清单
   * @param {Object} upstreamFields - CreativeThemeGenerator 输出的 12 字段
   * @returns {Object} 结构化需求对齐清单
   */
  async discover(upstreamFields) {
    console.log('\n🔍 [RequirementDiscoveryEngine] 开始需求洞察...');
    this.startTime = Date.now();

    const results = {
      upstreamFields: this._sanitizeUpstreamFields(upstreamFields),
      audienceProfile: null,
      sceneStructure: null,
      riskAssessment: null,
      referenceCases: null,
      confirmationStatus: {
        status: 'pending',
        timestamp: new Date().toISOString()
      }
    };

    // Agent 1: AudienceProfiler
    try {
      results.audienceProfile = await this.agents.audience.run(upstreamFields, AudienceProfileSchema);
    } catch (e) {
      console.warn(`   [AudienceProfiler] 失败: ${e.message}`);
      results.audienceProfile = this.agents.audience._fallback(upstreamFields);
    }

    // Agent 2: SceneArchitect
    try {
      results.sceneStructure = await this.agents.scene.run(upstreamFields, SceneStructureSchema);
    } catch (e) {
      console.warn(`   [SceneArchitect] 失败: ${e.message}`);
      results.sceneStructure = this.agents.scene._fallback(upstreamFields);
    }

    // Agent 3: RiskAssessor
    try {
      results.riskAssessment = await this.agents.risk.run(upstreamFields, RiskAssessmentSchema);
    } catch (e) {
      console.warn(`   [RiskAssessor] 失败: ${e.message}`);
      results.riskAssessment = this.agents.risk._fallback(upstreamFields);
    }

    // Agent 4: ReferenceCurator
    try {
      results.referenceCases = await this.agents.reference.run(upstreamFields, ReferenceCasesSchema);
    } catch (e) {
      console.warn(`   [ReferenceCurator] 失败: ${e.message}`);
      results.referenceCases = this.agents.reference._fallback(upstreamFields);
    }

    const totalTime = Date.now() - this.startTime;
    console.log(`   ✅ 需求洞察完成 (${totalTime}ms)`);
    console.log(`      受众: ${results.audienceProfile.primaryAudience.ageRange} | 场景: ${results.sceneStructure.sceneCount}个 | 风险: ${results.riskAssessment.technicalRisks.length}个 | 参考: ${results.referenceCases.filmReferences.length}个`);

    return results;
  }

  /**
   * 极速模式：全部使用规则推断，不调用 LLM
   */
  _fastMode(upstreamFields) {
    console.log('   [极速模式] 使用规则推断...');
    return {
      upstreamFields: this._sanitizeUpstreamFields(upstreamFields),
      audienceProfile: this.agents.audience._fallback(upstreamFields),
      sceneStructure: this.agents.scene._fallback(upstreamFields),
      riskAssessment: this.agents.risk._fallback(upstreamFields),
      referenceCases: this.agents.reference._fallback(upstreamFields),
      confirmationStatus: {
        status: 'pending',
        timestamp: new Date().toISOString()
      }
    };
  }

  /**
   * 清理上游字段（只保留必要字段）
   */
  _sanitizeUpstreamFields(fields) {
    const allowed = [
      'type', 'theme', 'duration_sec', 'tone', 'visual_style',
      'dialogue_requirement', 'special_notes', 'target_audience',
      'creative_style', 'difficulty', 'description',
      // 【方案A-fix】原始故事文本透传
      '_originalStoryText', 'original_story_text'
    ];
    
    const sanitized = {};
    for (const key of allowed) {
      if (fields[key] !== undefined) {
        sanitized[key] = fields[key];
      }
    }
    return sanitized;
  }

  /**
   * 生成 Markdown 供人工确认
   */
  generateMarkdown(discoveryResult) {
    const { upstreamFields, riskAssessment } = discoveryResult;
    const audienceProfile = sourceBoundAudience(discoveryResult.audienceProfile, upstreamFields);
    const referenceCases = sourceBoundReferences(discoveryResult.referenceCases, upstreamFields);
    const sceneStructure = measuredSceneStructure(discoveryResult.sceneStructure);
    const primary = audienceProfile.primaryAudience;
    const demographic = (key, labels = {}) => primary[key] == null ? '未指定' : labels[primary[key]] || primary[key];
    
    // 【方案A-fix】原始故事文本加入需求洞察确认单
    const originalStory = customerIntent(upstreamFields);
    const storySection = originalStory ? `

## 📖 原始故事文本（完整版）

> 以下内容是所有需求分析的核心依据，请核对 LLM 是否正确理解了故事的关键细节：

${originalStory}

---
` : '';
    
    return `# 业务需求对齐清单

> 系统: 超级小香宝 v2.1.8
> 生成时间: ${new Date().toISOString()}
${storySection}
---

## 一、上游已确认内容

| 字段 | 值 |
|------|-----|
| 视频类型 | ${upstreamFields.type || '未指定'} |
| 核心主题 | ${upstreamFields.theme || '未指定'} |
| 目标时长 | ${upstreamFields.duration_sec || '未指定'}秒 |
| 情绪基调 | ${upstreamFields.tone || '未指定'} |
| 视觉风格 | ${upstreamFields.visual_style || '未指定'} |
| 创意系数 | ${upstreamFields.creative_style || '未指定'} |

---

## 二、深度洞察

### 2.1 目标受众画像

**主要受众**
- 受众依据: ${audienceProfile.audienceBasis === 'customer-provided' ? '客户明确指定；观看兴趣和动机的延展仍是本片创作假设' : '本片创作假设（依据内容提出观看兴趣和动机，不是人口统计或用户调查）'}
${audienceProfile.audienceEvidenceQuote ? `- 客户受众原文: ${audienceProfile.audienceEvidenceQuote}\n` : ''}- 年龄段: ${demographic('ageRange')}
- 性别: ${demographic('gender', { all: '不限（客户明确指定）', male: '男性（客户明确指定）', female: '女性（客户明确指定）' })}
- 兴趣标签: ${audienceProfile.primaryAudience.interestTags.join('、')}
- 职业: ${demographic('occupation')}
- 消费水平: ${demographic('consumptionLevel', { low: '低', medium: '中', high: '高', luxury: '奢侈消费' })}

**情绪触发点（本片创作假设）**
${audienceProfile.emotionTriggers.map((t, i) => `${i + 1}. ${t}`).join('\n')}

**内容期望（本片创作假设）**
${audienceProfile.contentExpectations.map((e, i) => `${i + 1}. ${e}`).join('\n')}

---

### 2.2 场景结构建议

**叙事弧线**: ${sceneStructure.narrativeArc || '线性'}
**总场景数**: ${sceneStructure.sceneCount}个
**总时长**: ${sceneStructure.totalDuration}秒

**开场** (${sceneStructure.opening.duration}秒)
- 目的: ${sceneStructure.opening.purpose}
- 关键元素: ${sceneStructure.opening.keyElements.join('、')}

**主体场景**
${sceneStructure.scenes.map(s => `
场景 ${s.index} (${s.duration}秒) [${s.emotionalBeat}]
- 目的: ${s.purpose}
- 关键元素: ${s.keyElements.join('、')}
`).join('\n')}

**结尾** (${sceneStructure.ending.duration}秒)
- 目的: ${sceneStructure.ending.purpose}
- 关键元素: ${sceneStructure.ending.keyElements.join('、')}

---

### 2.3 技术难点预判

${riskAssessment.technicalRisks.map(r => `- **${r.risk}** [${r.level === 'high' ? '高风险' : r.level === 'medium' ? '中风险' : '低风险'}]: ${r.impact}`).join('\n')}

**缓解建议**
${riskAssessment.mitigationSuggestions.map((s, i) => `${i + 1}. ${s}`).join('\n')}

---

### 2.4 对标参考

**参考影片**
${referenceCases.filmReferences.length ? referenceCases.filmReferences.map(f => `- ${f.title} [${f.relevance === 'high' ? '高度相关' : f.relevance === 'medium' ? '中度相关' : '参考'}]: ${f.keyTakeaway}；${f.usageRestriction || referenceUsageRestriction}；客户原文：${f.sourceQuote}`).join('\n') : '客户未提供具名影片参考，使用下列不具名视听策略。'}

**广告参考**
${referenceCases.adReferences.length ? referenceCases.adReferences.map(f => `- ${f.brand}: ${f.keyTakeaway}；${f.usageRestriction || referenceUsageRestriction}；客户原文：${f.sourceQuote}`).join('\n') : '客户未提供具名广告参考。'}

**风格参考**
${referenceCases.styleReferences.map((s, i) => `${i + 1}. ${s}`).join('\n')}

---

## 三、最终业务需求确认

□ 以上清单确认无误，进入 PRD 环节  
□ 需要修改：[请直接填写修改意见，如"场景2不要"或"时长改60s"]

**请回复：确认 / 修改：xxx / 重新生成**
`;
  }
}

module.exports = { RequirementDiscoveryEngine, sourceBoundAudience };
