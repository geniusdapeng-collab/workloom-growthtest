import { describe, expect, it } from "vitest";
import {
  DIALOGUE_CONTRACT_VERSION,
  dialogueContractFindings,
  exactDialogueClause,
  inferShotSpeechLanguage,
  noSpeechClause,
  resolveFilmSpeechLanguage,
  speechLanguageClause,
  speechNegativeTerms,
} from "./dialogue-contract.js";

/**
 * 真机样本（VID-ZXRRC-12）逐镜 ASR 实测：
 *   SC-01 卡片 "Track only." 被念成 "Not street legal."（时间轴残留旧台词）
 *   SC-03 增词、SC-04 无台词镜凭空 "Hi!"、SC-06 中文腔念车名。
 * 下面把这些"台词合同违背"固化成花钱前的判据。
 */
describe("台词合同判据（dialogue-contract）", () => {
  it("时间轴引用台词与 dialogue 不一致 → 高风险（提示词自相矛盾）", () => {
    const findings = dialogueContractFindings({
      shotId: "SC-01",
      dialogue: [{ speaker: "陈卓", text: "Track only." }],
      timeline: "T00:02.8–T00:05 说出 “Not street legal.”，维持直视镜头",
    });
    expect(findings.map((f) => f.id)).toContain("dialogue-line-conflict");
    expect(findings.find((f) => f.id === "dialogue-line-conflict")!.level).toBe("high");
  });

  it("引用台词与 dialogue 一致 → 不报冲突", () => {
    const findings = dialogueContractFindings({
      shotId: "SC-01",
      dialogue: [{ speaker: "陈卓", text: "Track only." }],
      timeline: "T00:02.8–T00:05 说出 “Track only.”，维持直视镜头",
    });
    expect(findings.map((f) => f.id)).not.toContain("dialogue-line-conflict");
  });

  it("台词语言与影片声明语言不一致 → 高风险", () => {
    const findings = dialogueContractFindings(
      { shotId: "SC-06", dialogue: [{ speaker: "陈卓", text: "关注我不迷路。" }] },
      { language: "en" },
    );
    expect(findings.map((f) => f.id)).toContain("dialogue-language-mismatch");
  });

  it("无台词镜（dialogueFree）却写了'说出' → 高风险", () => {
    const findings = dialogueContractFindings({
      shotId: "SC-04",
      dialogueFree: true,
      action: "骑手压弯驶过，说出短句",
    });
    expect(findings.map((f) => f.id)).toContain("dialogue-free-contradiction");
  });

  it("动作里声明说话但没登记 dialogue → 高风险（模型会自行编词）", () => {
    const findings = dialogueContractFindings({ shotId: "SC-05", action: "她望向赛道后说出一句台词" });
    expect(findings.map((f) => f.id)).toContain("dialogue-missing");
  });

  it("有引号台词但没有登记 dialogue → 中风险（台词未进合同）", () => {
    const findings = dialogueContractFindings({ shotId: "SC-02", timeline: "T00:03 说出 “Go faster.”" });
    expect(findings.map((f) => f.id)).toContain("dialogue-quoted-without-declaration");
  });

  it("影片语言：显式声明优先，其次由台词文本推断（英文台词片不再按中文口径处理）", () => {
    expect(resolveFilmSpeechLanguage({}, [{ dialogue: [{ text: "Track only." }] }])).toBe("en");
    expect(resolveFilmSpeechLanguage({}, [{ dialogue: [{ text: "只做不说。" }] }])).toBe("zh");
    expect(resolveFilmSpeechLanguage({ speechLanguage: "en" }, [])).toBe("en");
    expect(inferShotSpeechLanguage({ dialogue: "820RR-RC." })).toBe("en");
  });

  it("提示词条款：语言锁定 / 逐字 / 无台词 / 禁止其他语种人声", () => {
    expect(speechLanguageClause("en")).toContain("【台词语言】");
    expect(speechLanguageClause("en")).toContain("禁止中文");
    expect(speechLanguageClause("zh")).toContain("禁止英文");
    expect(speechLanguageClause("en")).toContain("逐字");
    expect(exactDialogueClause(["Track only."])).toBe("");
    expect(noSpeechClause()).toContain("【无台词】");
    expect(speechNegativeTerms("en")).toMatch(/no chinese speech/);
    expect(speechNegativeTerms("zh")).toMatch(/no english speech/);
    expect(DIALOGUE_CONTRACT_VERSION).toBe("workloom.dialogue-contract/v1");
  });
});
