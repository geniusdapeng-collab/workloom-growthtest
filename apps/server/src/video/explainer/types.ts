/**
 * explainer/types.ts —— 口播解说片（talkcraft-explainer）数据契约 · T-2026-0926-0008
 *
 * 三层分离（规格书 §2）：
 *   ① 数据层：口播稿 / 字级时间戳 / 语义标注 / SHOTBOOK —— 全部是 **JSON 数据**（Zod 严格校验）；
 *   ② 合成代码层：`packages/video-studio/explainer-template/`（我方受控模板，静态可审）；
 *   ③ 引擎资产层：本机安装的 talkcraft 引擎（卡 tsx + 确定性脚本），**不入库**（许可约束见 engine.ts）。
 *
 * 纪律：LLM 只产出数据，绝不产出代码；能写进本文件 schema 的约束，就不要留给"实现时注意"。
 */
import { z } from "zod";

/** 输出档位只改变合成画布尺寸；素材是否具备同等细节需由素材来源单独保证。 */
export const ExplainerQualitySchema = z.enum(["hd", "uhd"]);
export type ExplainerQuality = z.infer<typeof ExplainerQualitySchema>;

export function explainerOutputSize(
  aspect: "9:16" | "16:9",
  quality: ExplainerQuality = "hd",
): { width: number; height: number } {
  const shortEdge = quality === "uhd" ? 2160 : 1080;
  const longEdge = quality === "uhd" ? 3840 : 1920;
  return aspect === "9:16"
    ? { width: shortEdge, height: longEdge }
    : { width: longEdge, height: shortEdge };
}

/* ================= 口播稿 ================= */

export const ScriptSentenceSchema = z.object({
  /** 句号（1 起；与 timestamps.json / semantics.json 同口径） */
  i: z.number().int().min(1),
  text: z.string().min(1),
});
export type ScriptSentence = z.infer<typeof ScriptSentenceSchema>;

export const ExplainerScriptSchema = z.object({
  sentences: z.array(ScriptSentenceSchema).min(1),
});
export type ExplainerScript = z.infer<typeof ExplainerScriptSchema>;

/** 口播稿硬规（talkcraft SKILL.md ②）：数字必须写汉字——逐字锚定按文本对位，阿拉伯数字对不上读音。 */
export const ARABIC_DIGIT_RE = /[0-9０-９]/;

export function assertSpokenNumbers(text: string): void {
  const hit = ARABIC_DIGIT_RE.exec(text);
  if (hit) {
    const around = text.slice(Math.max(0, hit.index - 6), hit.index + 6);
    throw new Error(`口播稿数字必须写汉字（逐字对齐按文本锚定）：...${around}... 出现「${hit[0]}」`);
  }
}

/* ================= 字级时间戳（vendor 同 schema） ================= */

export const TimestampWordSchema = z.object({
  text: z.string(),
  start: z.number(),
  end: z.number(),
});

export const TimestampSentenceSchema = z.object({
  i: z.number().int().min(1),
  text: z.string(),
  start: z.number(),
  end: z.number(),
  /** ASR 原文（留痕：对齐器看到的句子是什么样） */
  asr: z.string().default(""),
  /** CJK 锚点覆盖率（0–1）；< 0.90 → ok=false，需人工听核 */
  match: z.number().min(0).max(1),
  ok: z.boolean(),
  words: z.array(TimestampWordSchema),
});

export const TimestampsFileSchema = z.object({
  sr: z.number().default(16000),
  total: z.number(),
  sentences: z.array(TimestampSentenceSchema).min(1),
});
export type TimestampsFile = z.infer<typeof TimestampsFileSchema>;

/* ================= SHOTBOOK（层矩阵结构化分镜） ================= */

/** G0 风格档：领域 → token / accent / 字体 / 材质 / 能量档（design-language §0） */
export const StyleSchema = z.object({
  domain: z.string().min(1),
  tone: z.string().min(1),
  palette: z.object({
    base: z.string().min(1),
    accent: z.string().min(1),
    ink: z.string().min(1),
  }),
  font: z.string().min(1),
  energy: z.enum(["低", "中", "高"]),
});
export type ExplainerStyle = z.infer<typeof StyleSchema>;

/** 版式节奏表一行（cinematography §4.5 第 9 条：同卡连用 / 人物形态 / 素材容器轮换的校验对象） */
export const RhythmRowSchema = z.object({
  shotId: z.string().regex(/^[A-Za-z0-9_-]+$/),
  /** 人物形态·方位：半身 / 角标左下 / 角标右下 / 分屏格内 / 抠人贴角 / 短离场 / 无人物 */
  hostForm: z.string().min(1),
  /** 素材容器：出血全屏 / 装框 / 分屏格 / 底床 / 多图编排 / 3D 墙 / 长页 / 无 */
  container: z.string().min(1),
  card: z.string().min(1),
});

export const ShotMaterialSchema = z.object({
  kind: z.enum(["V", "图", "截图", "文"]),
  /** 工程内相对路径（public/... ；kind=文 时可省） */
  ref: z.string().optional(),
});

export const ExplainerShotSchema = z.object({
  /** beat_lint label 口径（进文件名）：只许 [A-Za-z0-9_-] */
  id: z.string().regex(/^[A-Za-z0-9_-]+$/),
  start: z.number().min(0),
  end: z.number().min(0),
  /** 本镜口播文本（全片各镜拼接必须逐字等于口播稿） */
  text: z.string().min(1),
  /** 卡 slug ∈ 卡注册表 ∩ 白名单 */
  card: z.string().min(1),
  /** 卡内容槽填充值：key ∈ 该卡可抽取的 const 槽（未声明则该卡内容保持 vendor 原文） */
  content: z.record(z.string(), z.unknown()).default({}),
  /** 卡内精确字符串替换（确定性：必须唯一命中；给"改文案"提供第二通道） */
  replace: z.array(z.object({ from: z.string().min(1), to: z.string() })).default([]),
  /** 蒙皮行：按 G0 token 改皮（不改运动命门） */
  skin: z.record(z.string(), z.string()).default({}),
  material: ShotMaterialSchema,
  /** 该镜声明的音效 cue（绝对秒） */
  sfx: z.array(z.object({
    t: z.number().min(0),
    name: z.string().min(1),
    vol: z.number().min(0).max(1).default(0.3),
  })).default([]),
  notes: z.string().default(""),
});
export type ExplainerShot = z.infer<typeof ExplainerShotSchema>;

export const ExplainerShotbookSchema = z.object({
  style: StyleSchema,
  rhythmTable: z.array(RhythmRowSchema).min(1),
  shots: z.array(ExplainerShotSchema).min(1),
});
export type ExplainerShotbook = z.infer<typeof ExplainerShotbookSchema>;

/* ================= 卡注册表 ================= */

export const CardEntrySchema = z.object({
  slug: z.string().min(1),
  title: z.string().default(""),
  oneLiner: z.string().default(""),
  fit: z.string().default(""),
  energy: z.string().default(""),
  category: z.string().default(""),
  inputs: z.array(z.string()).default([]),
  semantics: z.array(z.string()).default([]),
  materialForms: z.string().default(""),
  position: z.string().default(""),
  props: z.array(z.string()).default([]),
  priority: z.string().default(""),
  codePath: z.string().default(""),
  /** tsx 里可抽取的模块级 const 槽（内容填充通道） */
  slots: z.array(z.string()).default([]),
});
export type CardEntry = z.infer<typeof CardEntrySchema>;

/* ================= 语义标注（②-1） ================= */

/** 26 词封闭词表（references/taxonomy.md「语义索引」；顺序与索引表一致） */
export const SEMANTIC_VOCAB = [
  "钩子", "论点", "例证", "数据", "对比", "列举", "定义", "步骤", "转折", "设问",
  "金句", "标题", "引用", "自我介绍", "介绍他人", "号召", "时间地点", "空间叙事", "机制",
  "选择", "过程演示", "章节", "转场", "强调", "氛围", "结尾",
] as const;
export type Semantic = (typeof SEMANTIC_VOCAB)[number];

export const SemanticSentenceSchema = z.object({
  i: z.number().int().min(1),
  text: z.string(),
  /** 主语义（选卡第一依据） */
  sem: z.enum(SEMANTIC_VOCAB),
  /** main = 主句（允许进新元素）/ sub = 陪衬句 */
  weight: z.enum(["main", "sub"]).default("main"),
  entities: z.array(z.string()).default([]),
  /** 这一句需要什么形态的素材（可空） */
  need: z.string().default(""),
  /** ④ 之后回填的镜头号 */
  shot: z.string().nullable().default(null),
});
export type SemanticSentence = z.infer<typeof SemanticSentenceSchema>;

export const SemanticsFileSchema = z.object({
  sentences: z.array(SemanticSentenceSchema).min(1),
});
export type SemanticsFile = z.infer<typeof SemanticsFileSchema>;

/* ================= 机器闸报告 ================= */

export const GateResultSchema = z.object({
  gate: z.string(),
  status: z.enum(["pass", "warn", "fail", "skip"]),
  command: z.string(),
  summary: z.string().default(""),
  details: z.array(z.string()).default([]),
});
export type GateResult = z.infer<typeof GateResultSchema>;

export const QaReportSchema = z.object({
  jobId: z.string(),
  totalFrames: z.number().nullable().default(null),
  gates: z.array(GateResultSchema),
  pass: z.boolean(),
});
export type QaReport = z.infer<typeof QaReportSchema>;
