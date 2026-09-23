import { describe, expect, it } from "vitest";
import { PRODUCER_RUBRICS, resolveProducerLlm, reviewStage } from "./producer-gate.js";

function fakeLlm(answer: Record<string, unknown>): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })) as unknown as typeof fetch;
}

const env = { LLM_BASE_URL: "https://api.example.com", LLM_API_KEY: "k", LLM_MODEL: "judge-1" };

describe("AI 监制门", () => {
  it("rubric 覆盖所有环节且都有可判定的条目", () => {
    for (const [stage, rubric] of Object.entries(PRODUCER_RUBRICS)) {
      expect(rubric.length, `${stage} 至少要有一条评审要点`).toBeGreaterThan(0);
      for (const line of rubric) expect(line.trim().length).toBeGreaterThan(4);
    }
  });

  it("硬闸失败直接打回：不调用模型、分数为 0", async () => {
    let called = 0;
    const fetchImpl = (async () => {
      called += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const verdict = await reviewStage({
      stage: "shot",
      projectId: "VID-1",
      artifacts: [],
      deterministic: [{ id: "duration", pass: false, detail: "期望 5s 实测 3.2s", hard: true }],
      env,
      fetchImpl
    });
    expect(verdict.approved).toBe(false);
    expect(verdict.rerun).toBe(true);
    expect(verdict.score).toBe(0);
    expect(verdict.via).toBe("deterministic");
    expect(verdict.hardFailures[0]).toContain("duration");
    expect(called).toBe(0);
  });

  it("软信号失败不影响放行，但进问题清单", async () => {
    const verdict = await reviewStage({
      stage: "color",
      projectId: "VID-1",
      artifacts: [],
      deterministic: [{ id: "improvement", pass: false, detail: "调色提升 1.2 分（阈值 2）" }],
      env,
      fetchImpl: fakeLlm({ approved: true, score: 82, issues: [], suggestions: [], reason: "择优判定无需调色" })
    });
    expect(verdict.approved).toBe(true);
    expect(verdict.issues.some((i) => i.includes("improvement"))).toBe(true);
    expect(verdict.via).toBe("llm");
  });

  it("模型判不合格 → rerun=true 且带建议", async () => {
    const verdict = await reviewStage({
      stage: "keyframe",
      projectId: "VID-1",
      artifacts: [{ path: "/tmp/x.png", kind: "image" }],
      deterministic: [{ id: "res", pass: true, detail: "1080x1920", hard: true }],
      env,
      fetchImpl: fakeLlm({ approved: false, score: 35, issues: ["人物与定妆照不是同一张脸"], suggestions: ["用 img2img 挂定妆照锚点重跑"], reason: "人物不像" })
    });
    expect(verdict.approved).toBe(false);
    expect(verdict.rerun).toBe(true);
    expect(verdict.suggestions[0]).toContain("重跑");
    expect(verdict.model).toBe("judge-1");
  });

  it("无模型时 fail-closed；显式允许降级才放行并标 degraded", async () => {
    const closed = await reviewStage({
      stage: "prompt", projectId: "VID-1", artifacts: [], deterministic: [], env: {}, fetchImpl: fakeLlm({})
    });
    expect(closed.approved).toBe(false);
    expect(closed.degraded).toBe(true);
    expect(closed.via).toBe("fallback");

    const open = await reviewStage({
      stage: "prompt", projectId: "VID-1", artifacts: [], deterministic: [], env: {}, allowFallbackApprove: true, fetchImpl: fakeLlm({})
    });
    expect(open.approved).toBe(true);
    expect(open.degraded).toBe(true);
    expect(open.suggestions[0]).toContain("LLM_");
  });

  it("模型报错同样按 fail-closed 处理（不打回静默）", async () => {
    const verdict = await reviewStage({
      stage: "bgm", projectId: "VID-1", artifacts: [], deterministic: [], env,
      fetchImpl: (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch
    });
    expect(verdict.approved).toBe(false);
    expect(verdict.degraded).toBe(true);
    expect(verdict.issues.some((i) => i.includes("HTTP 500"))).toBe(true);
  });

  it("凭据解析：缺任一即视为不可用（不拿半套配置去调）", () => {
    expect(resolveProducerLlm({} as NodeJS.ProcessEnv)).toBeNull();
    expect(resolveProducerLlm({ LLM_BASE_URL: "x", LLM_API_KEY: "y" } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(resolveProducerLlm({ DEEPSEEK_BASE_URL: "https://api.deepseek.com", DEEPSEEK_API_KEY: "k", DEEPSEEK_MODEL: "deepseek-flash" } as unknown as NodeJS.ProcessEnv))
      .toEqual({ baseUrl: "https://api.deepseek.com", apiKey: "k", model: "deepseek-flash" });
  });
});
