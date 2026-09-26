/**
 * stage-registry.ts —— 视频数据管线「环节（Agent）登记表」（2026-09-22 审计基线）
 *
 * 目的：把 vendor 预生产链路的每个环节显式登记下来（模块、入口、产物、字段契约、
 * 已知兜底路径），供 `scripts/tools/pipeline-agent-audit.mts` 做三件事：
 *   ① 逐环节静态审计（静默 catch / 兜底默认值 / degraded 标记 / mock / TODO）；
 *   ② 逐环节日志核对（该环节是否真的产出，还是靠下游补齐）；
 *   ③ 逐环节产物核对（result.json 阶段在场 + 镜头字段是否等于 FieldGuard 默认模板）。
 *
 * 登记事实来源（全部 A 级：读 vendor 源码）：
 *   - `index.js` 的 create() 主流程（各 `result.stages.<name>` 写入点）
 *   - `engines/production-engine/production-engine.js` 的 Phase 0–3.5
 *   - `bundles/ai-video/pipelines/narrative-film.yml` 的 16 步业务口径
 */

export type StageLayer = "intake" | "planning" | "production" | "quality" | "asset" | "render" | "post";

export interface PipelineStage {
  /** 业务/日志口径的环节 id（与 result.stages / 日志标记对齐） */
  id: string;
  name: string;
  layer: StageLayer;
  /** vendor 模块路径（相对 vendor/supermickey/hyperreality-system） */
  modules: string[];
  /** 入口符号（便于定位实现层） */
  entry: string[];
  /** 该环节应当产出的字段/产物（字段契约） */
  outputs: string[];
  /** 已登记的兜底/降级路径（审计重点：这些路径会"看起来成功"） */
  fallbacks?: string[];
  /** 该环节最容易出现的问题（审计时优先核对） */
  auditFocus?: string[];
  /** 主流程中是否为条件环节 */
  conditional?: boolean;
  /** 该环节在运行日志里的典型标记（用于日志证据核对） */
  logMarkers?: string[];
  /** 真机已确认的问题（A 级：有运行证据） */
  knownIssues?: string[];
  /** 代码阅读得出的改进建议（A/B 级，注明依据） */
  improvementIdeas?: string[];
}

export const PIPELINE_STAGES: PipelineStage[] = [
  {
    id: "dataMining",
    name: "情报挖掘（五站）",
    layer: "intake",
    modules: ["engines/data-mining-engine/index.js"],
    entry: ["DataMiningEngine"],
    outputs: ["dossier", "references"],
    auditFocus: ["无网络/无渠道时的降级是否显式"],
    conditional: true
  },
  {
    id: "creativeTheme",
    name: "创意主题（12 字段）",
    layer: "intake",
    modules: ["skills/creative-theme-generator/index.js"],
    entry: ["CreativeThemeGenerator.generate", "_extractFieldsWithLLM"],
    outputs: ["title", "theme", "description", "type", "tone", "visual_style", "dialogue_requirement", "special_notes", "duration", "creative_style", "aspect_ratio", "production_mode"],
    fallbacks: ["LLM 字段提取失败 → 规则兜底（_inferTypeWeighted / 静态库）", "类型不在库 → DynamicTypeResolver"],
    auditFocus: ["LLM 提取失败是否静默（真机曾因注入引擎被摊平而整套主题漂移）", "duration/aspect_ratio 是否被 brief 覆盖"]
  },
  {
    id: "requirementDiscovery",
    name: "需求洞察（受众/风险/参考）",
    layer: "intake",
    modules: ["engines/requirement-discovery-engine.js"],
    entry: ["RequirementDiscoveryEngine.discover"],
    outputs: ["audience", "scenes", "risks", "references"],
    auditFocus: ["子 Agent（AudienceProfiler/RiskAssessor/ReferenceCurator）超时是否降级"]
  },
  {
    id: "requirementReview",
    name: "需求对齐清单（G3/G4）",
    layer: "planning",
    modules: ["engines/script-engine/core/requirement-list-builder.js", "engines/enhancers/requirement-alignment-gate.js"],
    entry: ["RequirementListBuilder", "RequirementAlignmentGate"],
    outputs: ["requirementList", "contract"],
    auditFocus: ["契约抽取（characters/scenes/props/actions）质量与后续 alignment 判定一致性"]
  },
  {
    id: "emotionIntent",
    name: "情绪意图解析",
    layer: "planning",
    modules: ["engines/emotion/emotion-intent-parser.js"],
    entry: ["EmotionIntentParser.parse"],
    outputs: ["primary", "secondary", "intensity", "triggers", "confidence"],
    auditFocus: ["中性兜底是否吞掉真实意图"]
  },
  {
    id: "creativeIntensity",
    name: "创意指数（L1–L4 引擎配置）",
    layer: "planning",
    modules: ["engines/script-engine/core/creative-intensity-engine.js"],
    entry: ["CreativeIntensityEngine.parse", "generateEngineConfigs"],
    outputs: ["intensity", "level", "activeCapabilities", "engineConfigs"],
    auditFocus: ["engineConfigs 是否被下游真正消费（历史上有生成不消费的字段）"]
  },
  {
    id: "prdGeneration",
    name: "PRD（角色系统/视觉锚点）",
    layer: "planning",
    modules: ["engines/prd-generator/index.js"],
    entry: ["PRDGenerator.generate", "generateMarkdown"],
    outputs: ["characterSystem", "visualStyle", "deliveryStandards"],
    fallbacks: ["多 Agent 超时 → 单 Agent 降级"],
    auditFocus: ["角色系统与剧本/镜头卡的角色命名是否一致（真机出现过 char_001 vs 住客 双轨）"]
  },
  {
    id: "prdReview",
    name: "PRD 审核（G4）",
    layer: "planning",
    modules: ["index.js"],
    entry: ["_waitForExternalConfirmation"],
    outputs: ["prdReview"],
    conditional: true
  },
  {
    id: "scriptEngine",
    name: "剧本引擎（蓝图/角色/场景）",
    layer: "planning",
    modules: ["engines/script-engine/index.js", "engines/script-engine/core/script-generator.js"],
    entry: ["ScriptEngine.process"],
    outputs: ["blueprint", "character_system", "scenes"],
    fallbacks: ["JSON 修复/截断重试", "规则兜底"], 
    auditFocus: ["LLM JSON 解析失败的重试与兜底路径是否记录", "角色与场景编号是否稳定"]
  },
  {
    id: "emotionArc",
    name: "情绪弧",
    layer: "planning",
    modules: ["engines/emotion/emotion-arc-designer.js"],
    entry: ["EmotionArcDesigner.design"],
    outputs: ["curveType", "targets"],
    auditFocus: ["弧线与镜头情绪字段是否一致"]
  },
  {
    id: "narrativeRhythm",
    name: "叙事节奏",
    layer: "planning",
    modules: ["engines/enhancers/narrative-rhythm-adapter.js"],
    entry: ["NarrativeRhythmAdapter.enhance"],
    outputs: ["curveType", "dynamicMode", "beatInterval", "rhythmProfile"],
    auditFocus: ["节奏配置是否真的注入镜头卡（pacing/transition）"]
  },
  {
    id: "productionEngine",
    name: "制作引擎 Phase 0–3.5（场景/视觉音频/提示词融合/字段质检）",
    layer: "production",
    modules: [
      "engines/production-engine/production-engine.js",
      "engines/production-engine/phases/phase-1-scene-design.js",
      "engines/production-engine/phases/phase-2-visual-audio.js",
      "engines/production-engine/phases/phase-3-prompt-fusion.js",
      "engines/production-engine/phases/phase-3-5-field-quality.js",
      "engines/production-engine/agents/prompt-fusion-agent.js"
    ],
    entry: ["ProductionEngine.produce", "PromptFusionAgent.process"],
    outputs: ["shots", "prompts", "25 字段", "片头 30 字段"],
    fallbacks: [
      "Phase 3 异常 → 全量退回未融合 Prompt（真机：Assignment to constant variable.）",
      "字段不足 → _dynamicDefaultValue / _fillMissingFieldsWithRetry / _fastFallback",
      "Phase 3.5 异常 → FieldGuard 就地修复（默认模板）"
    ],
    auditFocus: [
      "内容镜头 prompt 是否为空（真机 5/6）",
      "镜头字段是否等于 FieldGuard 默认模板（=下游补齐）",
      "degraded/degradeReason 是否被后续环节忽略"
    ]
  },
  {
    id: "sceneNumberMap",
    name: "场景编号映射",
    layer: "production",
    modules: ["engines/scene-number-mapper.js"],
    entry: ["SceneNumberMapper.map"],
    outputs: ["sceneNumberMap"],
    auditFocus: ["映射与镜头卡 shotId 一致性"]
  },
  {
    id: "emotionShotSyntax",
    name: "情绪镜头语法注入",
    layer: "production",
    modules: ["engines/emotion/emotion-shot-syntax.js"],
    entry: ["EmotionShotSyntax.inject"],
    outputs: ["_emotionInjected"],
    auditFocus: ["注入字段是否被后续保留（历史上双数组同步会丢）"]
  },
  {
    id: "shotQuality",
    name: "镜头质量增强",
    layer: "quality",
    modules: ["engines/enhancers/shot-quality-enhancer.js"],
    entry: ["ShotQualityEnhancer.enhance"],
    outputs: ["enhancedCount", "quality_score"],
    auditFocus: ["增强是否真的改动字段（增强 0 镜时下游是否仍在跑）"]
  },
  {
    id: "commercialMode",
    name: "商业模式增强",
    layer: "production",
    modules: ["engines/scenarios/commercial-mode-enhancer.js"],
    entry: ["CommercialModeEnhancer.enhance"],
    outputs: ["onscreen_text", "商品锚点"],
    conditional: true
  },
  {
    id: "fpvMode",
    name: "FPV 模式增强",
    layer: "production",
    modules: ["engines/scenarios/fpv-mode-enhancer.js"],
    entry: ["FPVModeEnhancer.enhance"],
    outputs: ["fpv 字段"],
    conditional: true
  },
  {
    id: "directorSkills",
    name: "导演技能注入（好莱坞技能库）",
    layer: "quality",
    modules: ["skills/hollywood-cinematography/cinematography-skill-router.js"],
    entry: ["routeAndEnhanceV3"],
    outputs: ["_skillMatched", "_skillQC"],
    auditFocus: ["技能命中 0 时是否静默", "技能质检禁止词是否真拦截"]
  },
  {
    id: "directorOptimization",
    name: "导演优化（评分/迭代）",
    layer: "quality",
    modules: ["engines/enhancers/director-optimization-agent.js"],
    entry: ["DirectorOptimizationAgent.optimize"],
    outputs: ["score", "iterations", "improved"],
    auditFocus: ["评分阈值与实际改动是否一致（improved=false 时的处理）"]
  },
  {
    id: "microMotion",
    name: "微动作增强",
    layer: "quality",
    modules: ["engines/enhancers/micro-motion-adapter.js"],
    entry: ["MicroMotionAdapter.enhance"],
    outputs: ["enhancedCount", "details"],
    auditFocus: ["增强 0 镜是否为常态（真机两次都是 0）"]
  },
  {
    id: "promptGuardian",
    name: "提示词守护",
    layer: "quality",
    modules: ["engines/prompt-guardian.js"],
    entry: ["PromptGuardian.guard", "autoFix"],
    outputs: ["fixes", "safe", "fixCount"],
    auditFocus: ["自动修复是否破坏 25 字段结构"]
  },
  {
    id: "portraitStudio",
    name: "定妆照（角色 4 角度 / 商品 5 视角）",
    layer: "asset",
    modules: ["engines/portrait-studio/index.js", "engines/portrait-studio/character-planner.js", "engines/portrait-studio/product-branch.js", "engines/portrait-studio/portrait-set-builder.js"],
    entry: ["PortraitStudio.plan", "execute", "finalize"],
    outputs: ["portraitSet", "characters", "products"],
    fallbacks: ["executor=spec（只出规格不出图）", "失败张数记 errors 但不阻断"],
    auditFocus: ["completedPortraits=0 却被下游当成功", "角度命名与渲染核心 REQUIRED_ANGLES 是否对齐"]
  },
  {
    id: "portraitResolver",
    name: "定妆照绑定解析",
    layer: "asset",
    modules: ["engines/portrait-resolver.js"],
    entry: ["PortraitResolver.resolve"],
    outputs: ["bindings", "portraitBindings"],
    auditFocus: ["portraitBindings 是否被渲染环节消费（真机断线：只写不读）"]
  },
  {
    id: "promptReview",
    name: "提示词审核（G6）",
    layer: "quality",
    modules: ["index.js"],
    entry: ["_waitForExternalConfirmation"],
    outputs: ["promptReview"],
    conditional: true
  },
  {
    id: "preproductionReview",
    name: "预生产最终确认（G7）",
    layer: "quality",
    modules: ["index.js"],
    entry: ["_waitForExternalConfirmation"],
    outputs: ["preproductionReview"],
    conditional: true
  },
  {
    id: "pipelineGuard",
    name: "管线守卫（完整性/一致性）",
    layer: "quality",
    modules: ["engines/render-pipeline-guard.js", "engines/production-engine/utils/pipeline-integrity-validator.js"],
    entry: ["RenderPipelineGuard.check", "PipelineIntegrityValidator"],
    outputs: ["pass", "errors", "warnings"],
    auditFocus: ["strictMode 下的拦截范围（是否只查渲染入参）"]
  },
  {
    id: "renderingEngine",
    name: "渲染引擎（Seedance 提交）",
    layer: "render",
    modules: ["engines/rendering-engine/rendering-engine.js", "scripts/render-submitter-core.js"],
    entry: ["RenderingEngine.render", "RenderSubmitterCore.submit"],
    outputs: ["render_jobs", "taskId"],
    fallbacks: ["提交器缺失 → dryRun/mock 模式", "vendor 路径少一层导致核心加载失败"],
    auditFocus: ["本仓布局下 `../../../scripts/render-submitter-core.js` 解析是否失败", "绑定清单四角度要求"]
  },
  {
    id: "postProductionEngine",
    name: "后期引擎（字幕/音乐/版本合成）",
    layer: "post",
    modules: ["engines/post-production-engine/post-production-engine.js"],
    entry: ["PostProductionEngine.postProduce", "qualityCheck"],
    outputs: ["versions", "final_video"],
    fallbacks: ["缺 shot-*.mp4 → 质量门 fail 但仍产出 HTML 版本"],
    auditFocus: ["质量门 fail 是否阻断入库", "renderResult 路径回填"]
  },
  {
    id: "requirementAlignment",
    name: "需求对齐复核（契约 vs 成片）",
    layer: "quality",
    modules: ["engines/enhancers/requirement-alignment-gate.js"],
    entry: ["RequirementAlignmentGate.check"],
    outputs: ["pass", "score", "missing"],
    auditFocus: ["契约抽取碎片化导致误判（真机 missing: 地理位置与园 / 民国风）"]
  }
];

/** FieldGuard 的默认模板（=「下游补齐」的指纹；镜头字段命中即说明该字段不是生成出来的） */
export const FIELD_GUARD_DEFAULTS: Record<string, string> = {
  director_instruction: "好莱坞电影级质感，写实风格，8K超高清",
  constraint: "Aspect ratio: 16:9, Resolution: 1920x1080, Format: MP4, Frame rate: 24fps, no text, no watermark",
  baseline: "8K resolution, cinematic quality, photorealistic, sharp focus",
  scene: "写实室内场景，自然光线，真实材质",
  lighting: "主光：自然光5600K柔光漫射；补光：反光板填充；整体明亮清晰",
  camera_movement: "0-3s固定机位；3-6s缓慢推近",
  character: "主角，写实形象，自然姿态",
  action: "自然站立，手部自然动作，眼神交流",
  portraits: "image://characters/default/portrait.png",
  consistency: "保持角色形象跨镜头一致",
  composition: "景别：中景；主体位置：画面黄金分割点；线条引导：纵深层次感",
  color_palette: "主色调：自然偏暖；辅助色：环境本色；肤色：自然健康；饱和度：中等自然",
  depth_of_field: "焦点：主体面部；景深：中等；前景背景适度虚化",
  timeline: "T00:00 - 开场构图；T00:03 - 主体进入画面；T00:06 - 核心动作",
  mood: "calm, natural",
  bright_constraint: "bright lighting, well-lit scene, clear visibility",
  character_constraint: "只出现指定角色一人，禁止其他人物入镜",
  costume: "符合角色身份的写实服装，面料质感真实",
  props: "场景中必要的写实道具，材质真实",
  pacing: "整体：沉稳中等节奏；开头：平缓引入；中段：自然推进；结尾：平稳收尾",
  audio: "环境底噪真实自然，无明显配乐干扰",
  makeup: "素颜或淡妆，妆容自然真实",
  transition: "自然切换，无特效转场"
};

/** 内容镜 25 字段 / 片头 30 字段的业务分组（供字段定义审计表使用） */
export const FIELD_BUSINESS_GROUPS: Array<{ group: string; fields: string[]; note: string }> = [
  { group: "身份与意图", fields: ["shotId", "sceneType", "director_instruction"], note: "镜头编号/类型/创作意图" },
  { group: "画面基底", fields: ["constraint", "baseline", "negative"], note: "技术规格与负面约束" },
  { group: "空间与光", fields: ["scene", "sceneDescription", "lighting", "bright_constraint"], note: "场景与光线锚点" },
  { group: "镜头语言", fields: ["camera_movement", "composition", "color_palette", "depth_of_field"], note: "运镜/构图/色调/景深" },
  { group: "人物", fields: ["character", "costume", "makeup", "action", "character_constraint"], note: "角色/服装/妆造/动作/人物约束" },
  { group: "道具与一致性", fields: ["props", "consistency", "portraits"], note: "道具、跨镜一致性、定妆照锚点" },
  { group: "叙事与节奏", fields: ["dialogue", "timeline", "mood", "pacing", "transition"], note: "台词/时间轴/情绪/节奏/转场" },
  { group: "音频", fields: ["audio"], note: "环境声与音乐（营销场景另有 bgm）" },
  /**
   * 片头标题字段**已下线**（2026-09-26 产品所有者口径）：
   * 主标题/副标题/标题动画/标题字体/开场音频设计 由**后期封面工位**（cover 阶段）产出，
   * 生成侧片头与内容镜同为 25 字段口径；这里只保留 `title/subtitle` 两个**文案**字段供封面策划复用。
   */
  { group: "片头文案（无标题渲染字段）", fields: ["title", "subtitle"], note: "片头与内容同为 25 字段；标题由后期封面产出（title_content 等 5 字段已下线）" }
];
