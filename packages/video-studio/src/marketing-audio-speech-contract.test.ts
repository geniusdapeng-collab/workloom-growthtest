import { describe, expect, it } from "vitest";
import { applyNarrativeFinalPromptContract, narrativeSpeechPolicy, normalizeNarrativePromptsForReview } from "./vendor-compat.js";

const options = { noDialogue: true, noMusic: false, maxLength: 3000, canonicalize: true,
  noTitles: true, characterNames: ["演员甲"], projectActions: ["放稳器物"],
  marketingPrompt: { actions: ["放稳器物"], overlay: [], endCard: [] } };
function shot() {
  return { shotId: "N1", duration: 4, prompt: "【身份持续】演员甲 01.【音频】旧的单行展示文本。",
    fields: { scene: "工作室的展示台", action: "演员甲将器物放稳后收手", costume: "工作服与护具",
      makeup: "自然肤色", props: "器物与展示台", timeline: "T00:00-T00:04 放稳器物后收手",
      composition: "全景，器物与双手完整入画", lighting: "窗边自然柔光", color_palette: "中性自然色彩",
      transition: "动作完成后硬切", mood: "视线跟随器物落稳后放松", camera_movement: "固定机位",
      pacing: "前段放稳，末段收手", depth_of_field: "器物与双手清晰",
      audio: "人声对话清晰可辨，器物碰撞声清楚，原生呼吸声与现场人声欢呼逐渐靠近；远处广播人声含混，不构成可辨语句；音乐为电子摇滚，BPM120，鼓点推动节奏；手掌接触桌面的轻响。" } };
}
const field = (value: { prompt?: unknown }, label: string) =>
  new RegExp(`^\\d+\\.【${label}】([^\\n]*)$`, "mu").exec(String(value.prompt))?.[1] ?? "";

describe("T-2026-1105-9004 semantic speech permission", () => {
  it.each(["不添加人声旁白或对白", "不需要人声旁白"])("recognizes the human-voice qualifier in an explicit denial: %s", denial => {
    expect(narrativeSpeechPolicy(`无台词；保留环境声与现场欢呼；${denial}。`))
      .toMatchObject({ dialogueAllowed: false, voiceoverDenied: true, voiceoverAllowed: false, allSpeechForbidden: true });
  });
  it.each(["明确要求旁白或对白时保留相应内容", "如果需要旁白，请按客户要求保留"])("does not turn a conditional instruction into permission: %s", condition => {
    expect(narrativeSpeechPolicy(`全片无对白；${condition}。`))
      .toMatchObject({ voiceoverAllowed: false, allSpeechForbidden: true });
  });
  it("keeps explicit permission for one voiceover sentence", () => {
    expect(narrativeSpeechPolicy("全片无对白；结尾可加一句气声旁白“已经完成”。"))
      .toMatchObject({ dialogueAllowed: false, voiceoverAllowed: true, allSpeechForbidden: false });
  });
  it("keeps offscreen environmental sound separate from voiceover permission", () => {
    expect(narrativeSpeechPolicy("无台词；仅保留主体动作与画外环境声。"))
      .toMatchObject({ voiceoverAllowed: false, allSpeechForbidden: true });
  });
});

describe("T-2026-1105-9004 native marketing audio", () => {
  it("uses native audio on a flattened prompt, retaining nonsemantic voice and source sound without BGM", () => {
    const source = shot();
    const before = structuredClone(source);
    const audio = field(applyNarrativeFinalPromptContract(source, options), "音频");
    for (const text of ["器物碰撞声清楚", "原生呼吸声", "现场人声欢呼", "远处广播人声含混", "手掌接触桌面的轻响"]) expect(audio).toContain(text);
    expect(audio).not.toMatch(/人声对话清晰|电子摇滚|BPM120|鼓点推动|无人物声/u);
    expect(audio).toContain("无可辨台词、对白、旁白或口播");
    expect(source).toEqual(before);
  });
  it("keeps cloned structured audio safe and identical to the positive sound across repeat review projection", () => {
    const policy = { ...options, noCharacters: false, noAnimals: true, aspectRatio: "9:16", resolution: "1080x1920", projectProps: ["器物", "展示台"],
      characterPortraits: [{ name: "演员甲", path: "registered-portrait.png" }] };
    const source = { ...shot(), audio: "旧顶层背景音乐与清晰人声对话", _workloomPromptReviewPolicy: policy };
    const before = structuredClone(source);
    const first = normalizeNarrativePromptsForReview([source], policy)[0]!;
    const second = normalizeNarrativePromptsForReview([first], policy)[0]!;
    const positiveSound = field(first, "音频").split("；无可辨台词、对白、旁白或口播")[0];
    expect(first.audio).toBe(positiveSound);
    expect((first.fields as Record<string, unknown>).audio).toBe(positiveSound);
    expect(String(first.audio)).not.toMatch(/人声对话清晰|旧顶层|背景音乐|电子摇滚|BPM120|鼓点推动|无可辨台词/u);
    expect(String(first.audio)).toContain("现场人声欢呼");
    expect(second.prompt).toBe(first.prompt);
    expect(second.audio).toBe(first.audio);
    expect((second.fields as Record<string, unknown>).audio).toBe(positiveSound);
    expect(source).toEqual(before);
  });
  it("preserves an explicitly permitted voiceover while still removing postproduction BGM", () => {
    const source = shot();
    source.fields.audio = "器物接触桌面的一声轻响；一句气声旁白“已经完成”；背景音乐为电子鼓。";
    const noDialogue = narrativeSpeechPolicy("无对白；允许一句气声旁白“已经完成”。").allSpeechForbidden;
    const audio = field(applyNarrativeFinalPromptContract(source, { ...options, noDialogue }), "音频");
    expect(audio).toContain("一句气声旁白“已经完成”");
    expect(audio).toContain("器物接触桌面的一声轻响");
    expect(audio).not.toContain("电子鼓");
  });
  it("retains a real in-scene music source when the customer has not forbidden music", () => {
    const source = shot();
    source.fields.audio = "店内音响传出的钢琴音乐，背景音乐为电子鼓，鼓点推动节奏；器物碰撞桌面的轻响。";
    const audio = field(applyNarrativeFinalPromptContract(source, options), "音频");
    expect(audio).toContain("店内音响传出的钢琴音乐");
    expect(audio).toContain("器物碰撞桌面的轻响");
    expect(audio).not.toContain("电子鼓");
    expect(audio).not.toContain("鼓点推动");
  });
  it("does not replace missing native audio with a generic sound promise", () => {
    const source = shot();
    delete (source.fields as Record<string, unknown>).audio;
    expect(() => applyNarrativeFinalPromptContract(source, options)).toThrow(/MARKETING_NATIVE_SHOT_FIELD_MISSING.*audio/u);
  });
  it("fails when the sound contract removes every supplied event", () => {
    const source = shot();
    source.fields.audio = "人声对话清晰可辨；背景音乐为电子鼓。";
    expect(() => applyNarrativeFinalPromptContract(source, options)).toThrow(/MARKETING_AUDIO_CONTRACT_EMPTY/u);
  });
  it("applies the same sound contract to native opening audio without rewriting the other opening fields", () => {
    const source = { ...shot(), sceneType: "opening", title_content: "器物成形", subtitle_content: "材料与动作",
      title_animation: "标题平稳进入后静止", title_font_design: "中性无衬线字体",
      opening_audio_design: "器物触桌一声轻响，旁白清晰说“完成”，紧接着叠入背景音乐；现场欢呼留在末尾。" };
    const result = applyNarrativeFinalPromptContract(source, { ...options, noTitles: false, requireOpeningFields: true });
    const audio = field(result, "开场音频设计");
    expect(audio).toContain("器物触桌一声轻响");
    expect(audio).toContain("现场欢呼留在末尾");
    expect(audio).not.toMatch(/旁白清晰说|叠入背景音乐/u);
    expect(field(result, "主标题内容")).toBe(source.title_content);
    expect(field(result, "标题动画设计")).toBe(source.title_animation);
  });
  it("preserves an opening audio value byte-for-byte when none of it violates the contract", () => {
    const source = { ...shot(), sceneType: "opening", title_content: "器物成形", subtitle_content: "材料与动作",
      title_animation: "标题平稳进入后静止", title_font_design: "中性无衬线字体",
      opening_audio_design: "器物触桌一声轻响；呼吸声与现场人声欢呼从远到近。" };
    const result = applyNarrativeFinalPromptContract(source, { ...options, noTitles: false, requireOpeningFields: true });
    expect(field(result, "开场音频设计")).toBe(source.opening_audio_design);
  });
});
