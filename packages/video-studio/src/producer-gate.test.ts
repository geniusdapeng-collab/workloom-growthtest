import { describe, expect, it } from "vitest";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
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
  /**
   * 真机事故（2026-09-24 三轮审计）：4 张 1080×1920 PNG 抽帧 + 2 张定妆照 base64 后 ≈53MB，
   * 评审网关直接 HTTP 413 → 监制"不可用"、镜头既没通过也没被打回（悬空待复检）。
   */
  it("送审图超预算时自动压缩后再送审（防 413 让监制悬空）", async () => {
    const bigPath = join(tmpdir(), `judge-big-${randomUUID()}.png`);
    const smallPath = join(tmpdir(), `judge-small-${randomUUID()}.jpg`);
    writeFileSync(bigPath, Buffer.alloc(2_400_000, 0x41)); // 'A' × 2.4MB（模拟 10MB PNG 的量级）
    writeFileSync(smallPath, Buffer.alloc(64_000, 0x42)); // 'B' × 64KB（模拟 720 宽 JPEG）
    const bigB64 = Buffer.alloc(2_400_000, 0x41).toString("base64").slice(0, 48);
    const smallB64 = Buffer.alloc(64_000, 0x42).toString("base64").slice(0, 48);
    let sentBody = "";
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sentBody = String(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ approved: true, score: 80, issues: [], suggestions: [], reason: "ok" }) } }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as unknown as typeof fetch;
    try {
      const verdict = await reviewStage({
        stage: "shot", projectId: "VID-1",
        artifacts: [{ path: bigPath, kind: "image" }],
        deterministic: [], env, fetchImpl,
        shrinkImage: () => smallPath
      });
      expect(verdict.approved).toBe(true);
      expect(sentBody).toContain(smallB64);
      expect(sentBody).not.toContain(bigB64);
      expect(sentBody.length).toBeLessThan(400_000);
    } finally {
      rmSync(bigPath, { force: true });
      rmSync(smallPath, { force: true });
    }
  });

  /**
   * 真机事故（2026-09-24 晚）：prompt 环节只送产物**路径清单**，监制看不到正文，
   * 于是以"字段与红线项无正文可核验"打回（score 58）——门变成了空转。
   * 现在 json/text 产物正文按预算送审。
   */
  it("文本类产物把正文片段送审（监制能真的核字段与红线）", async () => {
    const promptPath = join(tmpdir(), `judge-prompt-${randomUUID()}.txt`);
    writeFileSync(promptPath, `【约束】9:16画幅，1080x1920\n${"平江路石拱桥，女主正面走近。".repeat(20)}`);
    let sentBody = "";
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sentBody = String(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ approved: true, score: 88, issues: [], suggestions: [], reason: "ok" }) } }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as unknown as typeof fetch;
    try {
      await reviewStage({
        stage: "prompt", projectId: "VID-1",
        artifacts: [{ path: promptPath, kind: "text", bytes: 2000 }],
        deterministic: [], env, fetchImpl
      });
      expect(sentBody).toContain("平江路石拱桥");
      expect(sentBody).toContain("产物正文");
    } finally {
      rmSync(promptPath, { force: true });
    }
  });

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
