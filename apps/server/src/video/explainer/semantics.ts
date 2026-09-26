/**
 * explainer/semantics.ts —— ②-1 语义标注（选卡的需求侧产物）· T-2026-0926-0008
 *
 * 为什么必须有（SKILL.md ②-1 原文教训）：没有语义标注，选卡只剩"输入类型"一道过滤，
 * 108 张卡里全是能配的候选，等于没过滤。本模块把每句口播标成
 * `{sem(26 词封闭词表), weight(main/sub), entities, need}` 并校验词表闭合。
 *
 * 两条路径：
 *   - LLM（生产路径）：逐句给 main 语义，严格 JSON；失败降级到规则并**留痕**（不静默）；
 *   - 规则（兜底/离线）：关键词矩阵——判不准归「论点」（词表里的默认档），不硬凑。
 */
import { SEMANTIC_VOCAB, SemanticsFileSchema, type ExplainerScript, type SemanticSentence, type SemanticsFile, type Semantic, type TimestampsFile } from "./types.js";

export type LlmCall = (prompt: string, opts?: { system?: string }) => Promise<string>;

const RULES: Array<{ sem: Semantic; re: RegExp }> = [
  { sem: "自我介绍", re: /(大家好|我是|我叫|我是你们的)/ },
  { sem: "转折", re: /(但是|但|然而|其实|可惜|问题在于|难点|可是|不过|反而)/ },
  { sem: "设问", re: /(为什么|凭什么|怎么办|怎么才能|如何|是吗|对不对|有没有)/ },
  { sem: "号召", re: /(关注|点赞|订阅|联系|预约|申请|试用|体验一下|开始用|找我们|私信|评论区见)/ },
  { sem: "结尾", re: /(谢谢大家|再见|就到这里|总结一下|收个尾|以上就是)/ },
  { sem: "章节", re: /(接下来|下面|下一个|第一部分|第二部分|第三个|最后一件事|先说)/ },
  { sem: "步骤", re: /(第一步|第二步|首先|然后|接着|最后一步|先.{0,6}再|流程是)/ },
  { sem: "数据", re: /([零一二三四五六七八九十百千万亿]{1,8}(倍|%|个百分点|条|个|家|人|小时|分钟|天|年|万|元|段)|百分之|翻倍|占比|成本|效率)/ },
  { sem: "对比", re: /(相比|不同于|比.{0,8}更|以前.{0,10}现在|传统|通用 AI|别人|竞品)/ },
  { sem: "列举", re: /([三四五六七八九两]{1,2}(支|条|个|类|件事|步|种|项|大)|第一|第二|第三|、.*、)/ },
  { sem: "机制", re: /(因为|所以|导致|原理|机制|靠的是|背后是|链路|闭环)/ },
  { sem: "定义", re: /(就是|叫做|意味着|是一种|指的是|本质上是)/ },
  { sem: "例证", re: /(比如|例如|举个例子|像|以.{1,10}为例|案例|实测|真机)/ },
  { sem: "金句", re: /(记住|一句话|说到底|真正的|最值钱|铁律|不是.{0,10}而是)/ },
  { sem: "标题", re: /^(获客增长系统|WorkLoom|AI 自主经营)/i },
];

/** 规则标注（确定性；判不准归「论点」） */
export function ruleSemantics(script: ExplainerScript, timestamps?: TimestampsFile): SemanticsFile {
  const sentences: SemanticSentence[] = script.sentences.map((sentence) => {
    const hit = RULES.find((r) => r.re.test(sentence.text));
    const sem: Semantic = hit?.sem ?? "论点";
    const short = sentence.text.replace(/[，。！？、；：""''（）\s]/g, "").length <= 6;
    const connective = /^(而且|同时|另外|还有|因为|所以|这样一来)/.test(sentence.text);
    return {
      i: sentence.i,
      text: sentence.text,
      sem,
      weight: short || connective ? "sub" : "main",
      entities: [],
      need: "",
      shot: null,
    };
  });
  void timestamps;
  return SemanticsFileSchema.parse({ sentences });
}

export interface AnnotateInput {
  script: ExplainerScript;
  timestamps?: TimestampsFile;
  llm?: LlmCall;
  onLog?: (line: string) => void;
}

export interface AnnotateResult {
  semantics: SemanticsFile;
  via: "llm" | "rule";
  /** LLM 失败原因（via=rule 且 LLM 曾尝试时非空） */
  reason: string | null;
}

export async function annotateSemantics(input: AnnotateInput): Promise<AnnotateResult> {
  if (!input.llm) return { semantics: ruleSemantics(input.script, input.timestamps), via: "rule", reason: null };
  const prompt = [
    "你是口播视频的分镜语义标注器。逐句判断这句话在「做什么」，只输出 JSON，不要解释。",
    "",
    `封闭词表（只能从这里选，不得造词）：${SEMANTIC_VOCAB.join(" / ")}`,
    "",
    "weight 口径：main = 主句（允许进新元素）；sub = 陪衬句（短句/连接词开头/补充说明）。",
    "need 口径：这句话需要什么形态的画面（可空字符串），例如「数据图表」「人物出镜」「界面演示」。",
    "",
    "口播稿：",
    ...input.script.sentences.map((s) => `${s.i}. ${s.text}`),
    "",
    '输出格式：{"sentences":[{"i":1,"sem":"钩子","weight":"main","entities":[],"need":""}]}',
  ].join("\n");
  try {
    const text = await input.llm(prompt, { system: "只输出严格 JSON；字段缺一个都不行。" });
    const parsed = extractJson(text) as { sentences?: unknown };
    const sentences = SemanticsFileSchema.parse({ sentences: parsed.sentences }).sentences;
    const scriptById = new Map(input.script.sentences.map((s) => [s.i, s.text]));
    if (sentences.length !== input.script.sentences.length) {
      throw new Error(`语义标注句数不符：${sentences.length} ≠ ${input.script.sentences.length}`);
    }
    for (const sentence of sentences) {
      const original = scriptById.get(sentence.i);
      if (original === undefined) throw new Error(`语义标注出现不存在的句号：${sentence.i}`);
      sentence.text = original;
      sentence.shot = null;
    }
    input.onLog?.(`[semantics] LLM 标注完成：${sentences.length} 句`);
    return { semantics: { sentences }, via: "llm", reason: null };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    input.onLog?.(`[semantics] LLM 标注失败，降级规则矩阵：${reason}`);
    return { semantics: ruleSemantics(input.script, input.timestamps), via: "rule", reason };
  }
}

/** 从模型输出里抠出第一个平衡的 JSON 对象（容忍 ``` 围栏与前后说明） */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf("{");
  if (start < 0) throw new Error(`模型输出里找不到 JSON：${text.slice(0, 120)}`);
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < body.length; i += 1) {
    const ch = body[i]!;
    if (quote) {
      if (ch === quote && body[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"') { quote = ch; continue; }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(body.slice(start, i + 1)) as unknown;
    }
  }
  throw new Error("模型输出的 JSON 不完整（括号未闭合）");
}
