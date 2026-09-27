import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { PRODUCER_RUBRICS, buildProducerReviewContract, resolveProducerLlm, reviewStage, type ProducerGateOptions } from "./producer-gate.js";
const env = { LLM_BASE_URL: "https://api.example.com", LLM_API_KEY: "k", LLM_MODEL: "judge-1" };
const dirs: string[] = [];
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");
function file(name: string, bytes: string | Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), "quality-test-")); dirs.push(dir);
  const path = join(dir, name); writeFileSync(path, bytes); return path;
}
afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }); });
const good = { approved: true, score: 85, issues: [], suggestions: [], reason: "ok" };
function judge(answer: unknown = good, bodies: string[] = []): typeof fetch {
  return (async (_url, init) => {
    bodies.push(String(init?.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }));
  }) as typeof fetch;
}
function textOptions(extra: Partial<ProducerGateOptions> = {}): ProducerGateOptions {
  return { stage: "prompt", projectId: "VID-中文", artifacts: [{ path: file("prompt.txt", "剧本与镜头约束"), kind: "text" }], deterministic: [], env, fetchImpl: judge(), ...extra };
}
describe("AI producer evidence gate", () => {
  it("every supported stage has review criteria", () => {
    for (const rubric of Object.values(PRODUCER_RUBRICS)) expect(rubric.every((x) => x.length > 4)).toBe(true);
  });
  it("hard failures cannot be overturned by model", async () => {
    const bodies: string[] = [];
    const verdict = await reviewStage(textOptions({ deterministic: [{ id: "duration", pass: false, hard: true, detail: "bad" }], fetchImpl: judge(good, bodies) }));
    expect(verdict.status).toBe("failed"); expect(verdict.approved).toBe(false); expect(bodies).toHaveLength(0);
  });
  it("required unknown and missing checks cannot pass", async () => {
    expect((await reviewStage(textOptions({ requiredCheckIds: ["source"] }))).status).toBe("unverified");
    expect((await reviewStage(textOptions({ deterministic: [{ id: "source", pass: true, hard: true, status: "unverified", detail: "no receipt" }] }))).approved).toBe(false);
  });
  it("soft failure is reported alongside actual model review", async () => {
    const verdict = await reviewStage(textOptions({ deterministic: [{ id: "style", pass: false, detail: "different" }] }));
    expect(verdict.status).toBe("passed"); expect(verdict.issues[0]).toContain("style");
  });
  it("missing model stays unverified even if fallback flag is true", async () => {
    for (const allowFallbackApprove of [false, true]) {
      const v = await reviewStage(textOptions({ env: {}, allowFallbackApprove }));
      expect(v.approved).toBe(false); expect(v.status).toBe("unverified"); expect(v.degraded).toBe(true);
    }
  });
  it("HTTP failure stays unverified", async () => {
    const v = await reviewStage(textOptions({ fetchImpl: (async () => new Response("failure", { status: 500 })) as typeof fetch }));
    expect(v.approved).toBe(false); expect(v.reason).toContain("HTTP 500");
  });
  it("empty, missing and corrupt evidence blocks before calling model", async () => {
    const paths = ["/does-not-exist/quality.png", file("empty.png", ""), file("fake.png", "this is text")];
    for (const path of paths) {
      const bodies: string[] = [];
      const v = await reviewStage(textOptions({ stage: "keyframe", artifacts: [{ path, kind: "image" }], fetchImpl: judge(good, bodies) }));
      expect(v.status).toBe("unverified"); expect(bodies).toHaveLength(0);
    }
    expect((await reviewStage(textOptions({ artifacts: [] }))).approved).toBe(false);
  });
  it("missing reference cannot be silently skipped", async () => {
    const v = await reviewStage(textOptions({ referenceImages: ["/missing-reference.png"] }));
    expect(v.status).toBe("unverified");
  });
  it("image-only stages cannot approve on text evidence", async () => {
    expect((await reviewStage(textOptions({ stage: "shot" }))).approved).toBe(false);
  });
  it("full text including violations after the old prefix limit reaches judge", async () => {
    const path = file("long.txt", "正常描述".repeat(4000) + "末尾约束冲突");
    const bodies: string[] = [];
    const v = await reviewStage(textOptions({ artifacts: [{ path, kind: "text" }], fetchImpl: judge(good, bodies) }));
    expect(v.approved).toBe(true); expect(bodies[0]).toContain("末尾约束冲突");
    expect(v.evidence?.[0]?.sha256).toBe(createHash("sha256").update(readFileSync(path)).digest("hex"));
    expect(v.evidence?.[0]?.scope).toBe("complete-text");
  });
  it("oversize full text or context cannot be truncated into a pass", async () => {
    expect((await reviewStage(textOptions({ artifacts: [{ path: file("large.txt", "a".repeat(100001)), kind: "text" }] }))).status).toBe("unverified");
    expect((await reviewStage(textOptions({ context: { large: "a".repeat(30001) } }))).status).toBe("unverified");
  });
  it("all seven images are reviewed in batches and a later reject wins", async () => {
    const images = Array.from({ length: 7 }, (_, i) => ({ path: file(`image-${i}.png`, png), kind: "image" as const }));
    const bodies: string[] = [];
    const fetchImpl = (async (_url, init) => { bodies.push(String(init?.body)); return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(bodies.length === 1 ? good : { ...good, approved: false, reason: "last image bad" }) } }] })); }) as typeof fetch;
    const v = await reviewStage(textOptions({ stage: "keyframe", artifacts: images, fetchImpl }));
    expect(bodies).toHaveLength(2); expect(bodies.reduce((n, b) => n + (b.match(/image_url/g)?.length ?? 0), 0)).toBe(14);
    expect(v.approved).toBe(false); expect(v.reason).toContain("last image bad"); expect(v.evidence).toHaveLength(7);
  });
  it("oversize images must compress successfully without losing evidence", async () => {
    const big = file("big.png", Buffer.concat([png, Buffer.alloc(1_000_000)]));
    const small = file("small.png", png); const bodies: string[] = [];
    const v = await reviewStage(textOptions({ stage: "keyframe", artifacts: [{ path: big, kind: "image" }], shrinkImage: () => small, fetchImpl: judge(good, bodies) }));
    expect(v.approved).toBe(true); expect(bodies[0]!.length).toBeLessThan(50_000);
    expect((await reviewStage(textOptions({ artifacts: [{ path: big, kind: "image" }], shrinkImage: () => null }))).status).toBe("unverified");
  });
  it.each([{ ...good, score: 1 }, { ...good, approved: false }])("low score or reject cannot pass %j", async (answer) => {
    const v = await reviewStage(textOptions({ fetchImpl: judge(answer) })); expect(v.status).toBe("failed"); expect(v.approved).toBe(false);
  });
  /**
   * 2026-09-28 T1 真机：模型返回合法 JSON 但形状有偏差（score 字符串、issues 单条字符串、
   * 用 summary 代 reason、approved 写成 "true"）时，旧实现直接判"结构非法"要求整环节重跑——
   * 10 镜里 2 镜因此失败。无歧义偏差按语义归一，不改事实。
   */
  it.each([{ ...good, approved: "true" }, { ...good, issues: "bad" }, { ...good, score: "88" }, { approved: true, score: 85, summary: "ok" }])(
    "unambiguous shape deviations are normalized %j", async (answer) => {
      const v = await reviewStage(textOptions({ fetchImpl: judge(answer) }));
      expect(v.approved).toBe(true); expect(v.status).toBe("passed");
    }
  );
  it("wrong-shaped review is repaired into the schema instead of failing the stage", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      const content = calls === 1 ? JSON.stringify({ ...good, suggestions: [false] }) : JSON.stringify(good);
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
    }) as typeof fetch;
    const v = await reviewStage(textOptions({ fetchImpl }));
    expect(calls).toBe(2);
    expect(v.approved).toBe(true);
  });
  it.each([{ ...good, score: 101 }, { ...good, score: null }, { ...good, suggestions: [false] }, [], null])("invalid response is unverified %j", async (answer) => {
    const v = await reviewStage(textOptions({ fetchImpl: judge(answer) })); expect(v.status).toBe("unverified"); expect(v.approved).toBe(false);
  });
  it("unsupported audio and missing acoustic review cannot be called passed", async () => {
    expect((await reviewStage(textOptions({ artifacts: [{ path: file("audio.wav", "data"), kind: "audio" }] }))).status).toBe("unverified");
    expect((await reviewStage(textOptions({ stage: "bgm" }))).reason).toContain("audio-review");
  });
  const hasFfmpeg = spawnSync(process.env.WL_FFMPEG ?? "ffmpeg", ["-version"]).status === 0;
  it.skipIf(!hasFfmpeg)("actual video is probed and sampled at five timestamps", async () => {
    const path = file("video.mp4", "");
    const build = spawnSync(process.env.WL_FFMPEG ?? "ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=10", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", path]);
    expect(build.status).toBe(0);
    const bodies: string[] = [];
    const v = await reviewStage(textOptions({ stage: "shot", artifacts: [{ path, kind: "video" }], fetchImpl: judge(good, bodies) }));
    expect(v.approved, v.reason).toBe(true); expect(v.evidence?.[0]?.scope).toContain("temporal-sample");
    expect(bodies[0]).toContain("0.800s"); expect(bodies[0]?.match(/image_url/g)).toHaveLength(10);
  });
  it("credentials need all three fields", () => {
    expect(resolveProducerLlm({})).toBeNull(); expect(resolveProducerLlm({ LLM_BASE_URL: "x", LLM_API_KEY: "y" })).toBeNull();
    expect(resolveProducerLlm({ DEEPSEEK_BASE_URL: "https://api.example.com", DEEPSEEK_API_KEY: "k", DEEPSEEK_MODEL: "test" })?.model).toBe("test");
  });
});


describe("producer uses explicit source contracts", () => {
  const shots = [{ shotId: "PAIR", scene: "两人坐在窗边", characters: ["甲", "乙"], composition: "双人近景", lighting: "右侧烛光2200K", action: "保持坐姿，不笑", depth_of_field: "深景深" }];
  it("exact contract hash and complete facts enter judge, without old universal templates", async () => {
    const bodies: string[] = []; const contracts = { shots };
    const expected = buildProducerReviewContract(contracts);
    const result = await reviewStage(textOptions({ contracts, fetchImpl: judge(good, bodies) }));
    expect(result.approved).toBe(true); expect(result.contractHash).toBe(expected.contractHash);
    expect(bodies[0]).toContain("右侧烛光2200K"); expect(bodies[0]).toContain("深景深"); expect(bodies[0]).toContain(expected.contractHash);
    expect(expected.shots[0]?.intent.subject.count).toBe(2);
    expect(Object.values(PRODUCER_RUBRICS).flat().join("；")).not.toMatch(/五路微动作齐备|无第二张脸|屏幕始终朝向|全部是 2024|六镜是同一个人|都在成片里可见/);
  });
  it("structured device date and purpose are checked before calling a model", async () => {
    const bodies: string[] = [];
    const phone = { shotId: "PHONE", scene: "手机产品特写", devices: [{ category: "phone", model: "iPhone 16" }] };
    const missing = await reviewStage(textOptions({ contracts: { shots: [phone] }, fetchImpl: judge(good, bodies) }));
    expect(missing.status).toBe("unverified"); expect(bodies).toHaveLength(0);
    const future = await reviewStage(textOptions({ contracts: { shots: [phone], eraProfile: { storyDate: "2012-01-01" } }, fetchImpl: judge(good, bodies) }));
    expect(future.status).toBe("failed"); expect(bodies).toHaveLength(0);
    const valid = await reviewStage(textOptions({ contracts: { shots: [phone], eraProfile: { storyDate: "2024-09-20" } }, fetchImpl: judge(good, bodies) }));
    expect(valid.approved).toBe(true); expect(bodies[0]).toContain("设备声明：iPhone 16");
  });
  it.each([null, { shots: [] }, { shots: [null] }, { shots: [{ scene: "空镜" }] }, { shots: [shots[0], shots[0]] }, { shots: [{ shotId: "UNKNOWN" }] }, { shots, sceneBible: null }])("invalid structured contracts are unverified before external calls %j", async (contracts) => {
    const bodies: string[] = [];
    const result = await reviewStage(textOptions({ contracts: contracts as never, fetchImpl: judge(good, bodies) }));
    expect(result.status).toBe("unverified"); expect(bodies).toHaveLength(0);
  });
  it("mutating the source while reviewing cannot retain a passed verdict", async () => {
    const contracts = { shots: structuredClone(shots) };
    const fetchImpl = (async () => { contracts.shots[0]!.lighting = "左侧冷光"; return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(good) } }] })); }) as typeof fetch;
    const result = await reviewStage(textOptions({ contracts, fetchImpl }));
    expect(result.approved).toBe(false); expect(result.reason).toContain("合同发生变化");
  });
  it("oversize contract stays unverified without truncating its final facts", async () => {
    const bodies: string[] = [];
    const result = await reviewStage(textOptions({ contracts: { shots: [{ ...shots[0], description: "a".repeat(30001) }] }, fetchImpl: judge(good, bodies) }));
    expect(result.status).toBe("unverified"); expect(result.reason).toContain("超预算"); expect(bodies).toHaveLength(0);
  });
  it("legacy no-contract caller explicitly declares the unverified fact boundary", async () => {
    const bodies: string[] = [];
    const result = await reviewStage(textOptions({ fetchImpl: judge(good, bodies) }));
    expect(result.contractHash).toBeUndefined(); expect(bodies[0]).toContain("未提供结构化镜头合同");
  });
});
