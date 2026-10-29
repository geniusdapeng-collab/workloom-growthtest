import { describe, expect, it } from "vitest";
import {
  PLAUSIBILITY_POLICY_VERSION, PLAUSIBILITY_RUBRIC, applyPromptPatches, buildPlausibilityContext,
  parsePlausibilityAnswer, reviewPlausibility,
} from "./plausibility-review.js";

const baseContext = {
  projectId: "VID-TEST",
  platform: "TikTok",
  locale: "en",
  aspect: "9:16",
  resolution: "1080p",
  durationSeconds: 30,
  character: { name: "陈卓", appearance: "身高约 166cm" },
  products: [{
    id: "demo-product", displayName: "演示商品", category: "vehicle",
    dimensions: { lengthMm: 2050, seatHeightMm: 825 }, photoAngles: ["three-quarter", "side"],
  }],
  shots: [{
    shotId: "SC-01", durationSec: 5, scene: "赛道", action: "赛车弹射起步冲出画面",
    props: "赛车", dialogue: [{ speaker: "陈卓", text: "Track only." }], promptText: "【约束】9:16…",
  }],
  stage: "pre-render" as const,
};

const jsonResponse = (payload: unknown, ok = true, status = 200) =>
  new Response(JSON.stringify(ok ? {
    id: "plausibility-response",
    model: "deepseek-flash",
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify(payload) } }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 30,
      total_tokens: 130,
      completion_tokens_details: { reasoning_tokens: 10 },
    },
  } : payload), { status });

const llmEnv = { LLM_PROVIDER: "deepseek", LLM_API_KEY: "test-key", LLM_BASE_URL: "https://api.deepseek.com", LLM_MODEL: "deepseek-flash" };

/**
 * 通用性验收（T-2026-1011-0001）：
 * 常识判断由**模型的世界模型**给出，引擎不包含任何品类规则；新增品类不需要改代码。
 */
describe("实体与物理常识审核 agent", () => {
  it("rubric 是品类无关的通用问题，并显式要求模型使用自己的世界知识", () => {
    const rubric = PLAUSIBILITY_RUBRIC.join("\n");
    expect(rubric).toContain("真实世界里由谁使用");
    expect(rubric).toContain("用你自己的常识判断");
    expect(rubric).toContain("玩具比例");
    expect(rubric).toContain("CG/游戏过场");
    // 不得把某一种品类的规则写进 rubric（世界知识不枚举）
    expect(rubric).not.toMatch(/头盔|安全带|饺子|相机/);
  });

  it("送审上下文完整携带事实，不做字符截断", () => {
    const context = buildPlausibilityContext(baseContext);
    const serialized = JSON.stringify(context);
    expect(serialized).toContain("lengthMm");
    expect(serialized).toContain("three-quarter");
    expect(serialized).toContain("Track only.");
    expect(serialized).toContain("身高约 166cm");
    const large = buildPlausibilityContext({
      ...baseContext,
      shots: Array.from({ length: 40 }, (_, index) => ({ shotId: `S-${index}`, scene: "长".repeat(2000) })),
    });
    expect(JSON.stringify(large)).toContain("长".repeat(2_000));
  });

  it("解析模型输出：blocker/warning 与提示词补丁；结构非法即抛错（上层 fail-closed）", () => {
    const parsed = parsePlausibilityAnswer(JSON.stringify({
      verdict: "block",
      findings: [{ id: "subject-motion-without-operator", severity: "blocker", shotId: "SC-01", issue: "车辆自行起步", why: "画面没有骑手", fix: "补骑手并写明全盔" }],
      promptPatches: [{ shotId: "SC-01", clauses: ["本镜摩托车的运动必须由画面内戴全盔的骑手操控"] }],
      reason: "运动缺少操作者",
    }));
    expect(parsed.verdict).toBe("block");
    expect(parsed.findings[0]!.severity).toBe("blocker");
    expect(parsed.promptPatches[0]!.clauses[0]).toContain("骑手");
    expect(() => parsePlausibilityAnswer(JSON.stringify({ verdict: "block", findings: [] }))).toThrow(/PLAUSIBILITY/);
    expect(() => parsePlausibilityAnswer(JSON.stringify({ verdict: "pass", findings: [{ severity: "bad", issue: "x" }] }))).toThrow(/PLAUSIBILITY/);
  });

  it("模型给出 blocker → block；给出 pass → pass（同一条代码路径适配任意品类）", async () => {
    const blocked = await reviewPlausibility(baseContext, {
      env: llmEnv,
      fetchImpl: (async () => jsonResponse({
        verdict: "block",
        findings: [{ id: "plausibility-x", severity: "blocker", shotId: "SC-01", issue: "无人驾驶", why: "无操作者", fix: "补骑手" }],
        promptPatches: [], reason: "逻辑不成立",
      })) as unknown as typeof fetch,
    });
    expect(blocked.verdict).toBe("block");
    expect(blocked.findings.filter((finding) => finding.severity === "blocker")).toHaveLength(1);
    expect(blocked.model).toBe("deepseek-flash");
    expect(blocked.receipt).toMatchObject({
      inputTokens: 100,
      outputTokens: 30,
      reasoningTokens: 10,
      finishReason: "stop",
    });

    const passed = await reviewPlausibility(baseContext, {
      env: llmEnv,
      fetchImpl: (async () => jsonResponse({
        verdict: "pass",
        findings: [{ id: "plausibility-w", severity: "warning", shotId: "SC-02", issue: "建议补一个使用动作", why: "当前是静态展示但未写明", fix: "写明静置展示" }],
        promptPatches: [], reason: "仅提示项",
      })) as unknown as typeof fetch,
    });
    expect(passed.verdict).toBe("pass");
    expect(passed.findings).toHaveLength(1);
  });

  it("Flash 文本评审锁定官方模型、JSON 输出与 high thinking", async () => {
    let body: Record<string, unknown> | null = null;
    const result = await reviewPlausibility(baseContext, {
      env: {
        LLM_BASE_URL: "https://api.deepseek.com",
        DEEPSEEK_BASE_URL: "https://api.deepseek.com/anthropic",
        DEEPSEEK_API_KEY: "test-only",
        DEEPSEEK_MODEL: "deepseek-flash",
      },
      fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return jsonResponse({ verdict: "pass", findings: [], promptPatches: [], reason: "通过" });
      }) as typeof fetch,
    });
    expect(result.verdict).toBe("pass");
    expect(body).toMatchObject({
      model: "deepseek-flash",
      response_format: { type: "json_object" },
      thinking: { type: "enabled" },
      reasoning_effort: "high",
    });
  });

  it("无模型 / HTTP 失败 / 输出不可解析 → unverified（调用方 fail-closed）", async () => {
    const noModel = await reviewPlausibility(baseContext, { env: {}, fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch });
    expect(noModel.verdict).toBe("unverified");
    const httpFail = await reviewPlausibility(baseContext, {
      env: llmEnv, fetchImpl: (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch,
    });
    expect(httpFail.verdict).toBe("unverified");
    const badJson = await reviewPlausibility(baseContext, {
      env: llmEnv, fetchImpl: (async () => jsonResponse({ verdict: "也许吧" })) as unknown as typeof fetch,
    });
    expect(badJson.verdict).toBe("unverified");
  });

  it("提示词补丁：追加即止，重复应用不叠加", () => {
    const patches = [{ shotId: "SC-01", clauses: ["本镜必须有戴全盔的骑手操控"] }];
    const first = applyPromptPatches(patches, new Map([["SC-01", "【约束】9:16"]]));
    const text = first.get("SC-01")!;
    expect(text).toContain("【常识审核补丁】");
    const second = applyPromptPatches(patches, first);
    expect(second.get("SC-01")).toBe(text);
    expect(PLAUSIBILITY_POLICY_VERSION).toBe("workloom.plausibility-review/v1");
  });
});
