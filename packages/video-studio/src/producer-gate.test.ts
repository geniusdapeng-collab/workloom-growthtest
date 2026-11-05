import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PRODUCER_RUBRICS,
  resolveProducerLlm,
  reviewStage,
  type ProducerGateOptions,
} from "./producer-gate.js";

const env = {
  LLM_BASE_URL: "https://api.deepseek.com",
  LLM_API_KEY: "test-only",
  LLM_MODEL: "deepseek-flash",
};
const dirs: string[] = [];
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
  "base64",
);

function file(name: string, bytes: string | Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), "quality-test-"));
  dirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

afterEach(() => {
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

const good = {
  approved: true,
  score: 85,
  issues: [],
  suggestions: [],
  reason: "ok",
};

function judge(
  answer: unknown = good,
  bodies: string[] = [],
  overrides: Record<string, unknown> = {},
): typeof fetch {
  return (async (_url, init) => {
    bodies.push(String(init?.body));
    return new Response(JSON.stringify({
      id: "judge-response",
      model: "deepseek-flash",
      choices: [{
        finish_reason: "stop",
        message: { content: JSON.stringify(answer) },
      }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 30,
        total_tokens: 130,
        completion_tokens_details: { reasoning_tokens: 10 },
      },
      ...overrides,
    }));
  }) as typeof fetch;
}

function textOptions(extra: Partial<ProducerGateOptions> = {}): ProducerGateOptions {
  return {
    stage: "prompt",
    projectId: "VID-中文",
    artifacts: [{ path: file("prompt.txt", "剧本与镜头约束"), kind: "text" }],
    deterministic: [],
    env,
    fetchImpl: judge(),
    ...extra,
  };
}

describe("AI producer evidence gate", () => {
  it("has review criteria for every stage", () => {
    for (const rubric of Object.values(PRODUCER_RUBRICS)) {
      expect(rubric.every((line) => line.length > 4)).toBe(true);
    }
  });

  it("hard deterministic failure never calls the model", async () => {
    const bodies: string[] = [];
    const verdict = await reviewStage(textOptions({
      deterministic: [{ id: "duration", pass: false, hard: true, detail: "bad" }],
      fetchImpl: judge(good, bodies),
    }));
    expect(verdict).toMatchObject({ status: "failed", approved: false });
    expect(bodies).toHaveLength(0);
  });

  it("missing model stays unverified even if the legacy fallback flag is true", async () => {
    for (const allowFallbackApprove of [false, true]) {
      const verdict = await reviewStage(textOptions({ env: {}, allowFallbackApprove }));
      expect(verdict).toMatchObject({ approved: false, status: "unverified", degraded: true });
    }
  });

  it("sends complete text evidence to one canonical thinking review", async () => {
    const content = "正常描述".repeat(4_000) + "末尾约束冲突";
    const path = file("long.txt", content);
    const bodies: string[] = [];
    const verdict = await reviewStage(textOptions({
      artifacts: [{ path, kind: "text" }],
      fetchImpl: judge(good, bodies),
    }));
    expect(verdict.approved).toBe(true);
    expect(bodies).toHaveLength(1);
    const body = JSON.parse(bodies[0]!) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "deepseek-flash",
      thinking: { type: "enabled" },
      reasoning_effort: "high",
      response_format: { type: "json_object" },
    });
    expect(body.max_tokens).toBeGreaterThan(300_000);
    expect(JSON.stringify(body)).toContain("末尾约束冲突");
    expect(verdict.evidence?.[0]?.sha256)
      .toBe(createHash("sha256").update(readFileSync(path)).digest("hex"));
    expect(verdict.evidence?.[0]?.scope).toBe("complete-text");
    expect(verdict.receipts?.[0]).toMatchObject({
      modelId: "deepseek-flash",
      inputTokens: 100,
      outputTokens: 30,
      reasoningTokens: 10,
      finishReason: "stop",
    });
  });

  it("HTTP failure stays unverified", async () => {
    const verdict = await reviewStage(textOptions({
      fetchImpl: (async () => new Response("failure", { status: 500 })) as typeof fetch,
    }));
    expect(verdict).toMatchObject({ approved: false, status: "unverified", degraded: true });
    expect(verdict.reason).toContain("HTTP 500");
  });

  it.each([
    ["inline-json", '# 当前提示词\n```json\n{"registeredSubjectCount":1,"subjectCount":null,"participants":["主角","已声明的对手"]}\n```\n摘盔和转场仍有真实冲突。'],
    ["plain-text", "当前正文没有结构化镜头合同，只有需要核对的动作描述。"],
  ])("distinguishes omitted contract arguments from %s evidence without overriding rejection", async (_label, content) => {
    const path = file("contract-evidence.md", content);
    const bodies: string[] = [];
    const rejected = { approved: false, score: 58, issues: ["摘盔重复、转场及护具冲突"],
      suggestions: ["修复真实连续性后重新送审"], reason: "动作和原始需求冲突" };
    const verdict = await reviewStage(textOptions({
      artifacts: [{ path, kind: "text" }],
      context: { request: "先停稳，再摘盔；只用已声明的角色和文字。" },
      fetchImpl: judge(rejected, bodies),
    }));
    expect(bodies).toHaveLength(1);
    const request = JSON.parse(bodies[0]!).messages[0].content;
    const instruction = request[0].text as string;
    expect(instruction).toContain("未单独传入结构化镜头合同参数");
    expect(instruction).toContain("若正文内含镜头合同");
    expect(instruction).toContain("不代表已解析、验证或批准");
    expect(instruction).toContain("不得把待审产物本身当作独立来源");
    expect(instruction).not.toContain("未提供结构化镜头合同；");
    expect(request[1].text).toBe(`以下是产物正文（完整）：${path}\n${content}`);
    expect(verdict).toMatchObject({ approved: false, status: "failed", score: 58,
      issues: rejected.issues, suggestions: rejected.suggestions, degraded: false, via: "llm" });
    expect(verdict.contractHash).toBeUndefined();
    expect(verdict.reason).toContain(rejected.reason);
    expect(verdict.reason).toContain("所有证据批次需通过且评分≥70");
    expect(verdict.evidence).toEqual([{ path, sha256: createHash("sha256").update(content).digest("hex"), scope: "complete-text" }]);
  });

  it("contract presentation guidance retains the score threshold and explicit content rejection", async () => {
    for (const answer of [{ ...good, score: 69 }, { ...good, approved: false, score: 95, reason: "明确禁止的额外人物和片头标题仍出现" }]) {
      const bodies: string[] = [];
      const verdict = await reviewStage(textOptions({ fetchImpl: judge(answer, bodies) }));
      expect(bodies).toHaveLength(1);
      expect(verdict).toMatchObject({ approved: false, status: "failed", score: answer.score, via: "llm", degraded: false });
      expect(verdict.reason).toContain(answer.reason);
      expect(verdict.reason).toContain("所有证据批次需通过且评分≥70");
    }
  });

  it("scopes pre-storyboard evidence without overriding the judge's content rejection", async () => {
    const bodies: string[] = [];
    const rejected = { ...good, approved: false, score: 55, reason: "客户指定的结束画面缺失" };
    for (const evidencePhase of ["theme", "requirements", undefined] as const) {
      const verdict = await reviewStage(textOptions({
        stage: "script",
        evidencePhase,
        fetchImpl: judge(rejected, bodies),
      }));
      expect(verdict).toMatchObject({ approved: false, status: "failed", score: 55 });
    }
    const requests = bodies.map(body => JSON.parse(body).messages[0].content[0].text as string);
    expect(requests).toHaveLength(3);
    for (const early of requests.slice(0, 2)) {
      expect(early).toContain("按本环节实际应交付的内容核对原始需求和约束");
      expect(early).toContain("不能以缺少后续产物作为本环节的缺项");
    }
    expect(requests[2]).toContain("未单独传入结构化镜头合同参数");
    expect(requests[2]).not.toContain("不能以缺少后续产物作为本环节的缺项");
  });

  it("does not retry an unknown HTTP failure that mentions empty content", async () => {
    const bodies: string[] = [];
    const verdict = await reviewStage(textOptions({
      fetchImpl: async (_url, init) => {
        bodies.push(String(init?.body));
        return new Response(JSON.stringify({ error: { message: "content 为空" } }), { status: 500 });
      },
    }));
    expect(verdict).toMatchObject({ approved: false, status: "unverified" });
    expect(bodies).toHaveLength(1);
  });

  it("repairs the full malformed judge JSON once without re-evaluating the artifact", async () => {
    const bodies: string[] = [];
    let call = 0;
    const malformed = '{"approved":true,"score":85,"issues":[],"suggestions":["'
      + "完整证据".repeat(21_000) + '末尾标记"}';
    const fetchImpl = (async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      bodies.push(String(init?.body));
      call += 1;
      const content = call === 1 ? malformed : JSON.stringify(good);
      return new Response(JSON.stringify({
        id: `repair-${call}`,
        model: "deepseek-flash",
        choices: [{ finish_reason: "stop", message: { content } }],
        usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
      }));
    }) as typeof fetch;
    const verdict = await reviewStage(textOptions({ fetchImpl }));
    expect(verdict).toMatchObject({ approved: true, status: "passed", score: 85 });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toContain("仅修复 JSON");
    expect(bodies[1]).toContain("不得重新判定");
    const repairPrompt = JSON.parse(bodies[1]!).messages[0].content as string;
    expect(repairPrompt.includes(malformed)).toBe(true);
    expect(verdict.receipts).toHaveLength(2);
  });

  it("retries an empty producer response once with identical evidence and rubric", async () => {
    const bodies: string[] = [];
    let call = 0;
    const fetchImpl = (async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      bodies.push(String(init?.body));
      call += 1;
      return new Response(JSON.stringify({
        id: `empty-retry-${call}`,
        model: "deepseek-flash",
        choices: [{
          finish_reason: "stop",
          message: { content: call === 1 ? "" : JSON.stringify(good) },
        }],
        usage: { prompt_tokens: 100, completion_tokens: call === 1 ? 0 : 30, total_tokens: call === 1 ? 100 : 130 },
      }));
    }) as typeof fetch;
    const verdict = await reviewStage(textOptions({ fetchImpl }));
    expect(verdict).toMatchObject({ approved: true, status: "passed", score: 85 });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
  });

  it("wrong model, truncation, empty content and non-JSON fail closed", async () => {
    const payloads = [
      {
        id: "wrong-model",
        model: "kimi-k3",
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify(good) } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
      {
        id: "truncated",
        model: "deepseek-flash",
        choices: [{ finish_reason: "length", message: { content: JSON.stringify(good) } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
      {
        id: "empty",
        model: "deepseek-flash",
        choices: [{ finish_reason: "stop", message: { content: "" } }],
        usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
      },
      {
        id: "bad-json",
        model: "deepseek-flash",
        choices: [{ finish_reason: "stop", message: { content: "not json" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    ];
    for (const payload of payloads) {
      const verdict = await reviewStage(textOptions({
        fetchImpl: (async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch,
      }));
      expect(verdict).toMatchObject({ approved: false, status: "unverified", degraded: true });
    }
  });

  it("normalizes only unambiguous answer shapes", async () => {
    for (const answer of [
      { ...good, approved: "true" },
      { ...good, issues: "bad" },
      { ...good, score: "88" },
      { approved: true, score: 85, summary: "ok" },
      { result: { 通过: "通过", 评分: "88分", 问题: [{ message: "待修复" }], 建议: [{ suggestion: "补证据" }], 结论: "ok" } },
      { verdict: JSON.stringify(good) },
    ]) {
      const verdict = await reviewStage(textOptions({ fetchImpl: judge(answer) }));
      expect(verdict).toMatchObject({ approved: true, status: "passed" });
    }
  });

  it("valid JSON with unsafe field semantics fails closed without a repair call", async () => {
    const bodies: string[] = [];
    const fetchImpl = (async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      bodies.push(String(init?.body));
      return new Response(JSON.stringify({
        id: "unsafe-shape",
        model: "deepseek-flash",
        choices: [{
          finish_reason: "stop",
          message: { content: JSON.stringify({ approved: true, score: 85, issues: "需要修复", suggestions: [false] }) },
        }],
        usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
      }));
    }) as typeof fetch;
    const verdict = await reviewStage(textOptions({ fetchImpl }));
    expect(verdict).toMatchObject({ approved: false, status: "unverified" });
    expect(bodies).toHaveLength(1);
  });

  it("invalid score and impossible shape still fail closed without schema repair", async () => {
    for (const answer of [
      { ...good, score: 101 },
      { ...good, score: null },
      [],
      null,
    ]) {
      const bodies: string[] = [];
      const verdict = await reviewStage(textOptions({ fetchImpl: judge(answer, bodies) }));
      expect(verdict).toMatchObject({ approved: false, status: "unverified" });
      expect(bodies).toHaveLength(1);
    }
  });

  it("reviews all supplied images in one complete call by default", async () => {
    const images = Array.from({ length: 7 }, (_, index) => ({
      path: file(`image-${index}.png`, png),
      kind: "image" as const,
    }));
    const bodies: string[] = [];
    const verdict = await reviewStage(textOptions({
      stage: "keyframe",
      artifacts: images,
      fetchImpl: judge(good, bodies),
    }));
    expect(verdict.approved).toBe(true);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.match(/"type":"image_url"/g)).toHaveLength(7);
    expect(verdict.evidence).toHaveLength(7);
  });

  it("binds expected artifact hashes before and after review", async () => {
    const path = file("bound.txt", "完整证据");
    const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
    expect((await reviewStage(textOptions({
      artifacts: [{ path, kind: "text", expectedSha256: sha256 }],
    }))).approved).toBe(true);
    expect((await reviewStage(textOptions({
      artifacts: [{ path, kind: "text", expectedSha256: "a".repeat(64) }],
    }))).approved).toBe(false);
  });

  it("missing files, missing references and unsupported audio fail closed", async () => {
    expect((await reviewStage(textOptions({
      artifacts: [{ path: "/does-not-exist/evidence.txt", kind: "text" }],
    }))).approved).toBe(false);
    expect((await reviewStage(textOptions({
      referenceImages: ["/missing-reference.png"],
    }))).approved).toBe(false);
    expect((await reviewStage(textOptions({
      artifacts: [{ path: file("audio.wav", "data"), kind: "audio" }],
    }))).approved).toBe(false);
  });

  it("producer LLM requires canonical DeepSeek configuration", () => {
    expect(resolveProducerLlm({})).toBeNull();
    expect(resolveProducerLlm({
      LLM_BASE_URL: "https://api.deepseek.com",
      LLM_API_KEY: "key",
    })?.model).toBe("deepseek-flash");
    expect(() => resolveProducerLlm({
      LLM_BASE_URL: "https://api.deepseek.com",
      LLM_API_KEY: "key",
      LLM_MODEL: "deepseek-chat",
    })).toThrow("MODEL_ID_NOT_ALLOWED");
  });
});
