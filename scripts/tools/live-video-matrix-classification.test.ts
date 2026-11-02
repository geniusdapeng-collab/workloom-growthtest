import { describe, expect, it } from "vitest";
import {
  effectivePipelineFailures,
  promptDialogueField,
  promptSpeechViolationShotIds,
} from "./live-video-matrix-classification.mjs";

describe("真实视频矩阵分类", () => {
  it("从单行最终提示词读取完整台词字段，不把不适用声明判成真实台词", () => {
    const prompt = "17.【定妆照】使用陈卓 18.【台词】不适用：本片无台词、无旁白、无口播。 19.【时间轴】0-2秒";
    expect(promptDialogueField(prompt)).toBe("不适用：本片无台词、无旁白、无口播。");
    expect(promptSpeechViolationShotIds(
      [{ shotId: "S1" }, { shotId: "S2" }],
      [
        { shotId: "S1", prompt },
        { shotId: "S2", prompt: "18.【台词】陈卓：走吧。 19.【时间轴】0-2秒" },
      ],
    )).toEqual(["S2"]);
  });

  it("预生产收口成功后的非渲染状态覆盖旧失败事件，其他失败仍保留", () => {
    const failed = [{ kind: "pipeline.failed" }];
    const passed = {
      success: true,
      preproductionAudit: {
        status: "passed",
        scope: "preproduction-only",
        renderSubmitted: false,
      },
    };
    expect(effectivePipelineFailures(failed, passed)).toEqual([]);
    expect(effectivePipelineFailures(failed, { success: false })).toEqual(failed);
    expect(effectivePipelineFailures(failed, {
      ...passed,
      preproductionAudit: { ...passed.preproductionAudit, renderSubmitted: true },
    })).toEqual(failed);
  });
});
