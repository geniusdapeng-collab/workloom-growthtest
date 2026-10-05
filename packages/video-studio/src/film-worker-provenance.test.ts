import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { filmCanonicalJson, filmRequestHash } from "./film-worker-channel.js";
import {
  assertFilmVideoSubmissionReceipt,
  buildFilmVideoSubmissionReceipt,
  type FilmVideoSubmissionExpected,
  type FilmVideoSubmissionFacts,
} from "./film-worker-provenance.js";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
function fixture(): { facts: FilmVideoSubmissionFacts; expected: FilmVideoSubmissionExpected } {
  const prompt = "同一位前台工作人员完成自助入住演示。";
  const requestParams = { prompt, refs: ["references/front.png"], seconds: 5, generateAudio: true,
    aspect: "9:16", resolution: "720p", targetRef: "clips/S1-raw.mp4" };
  const facts: FilmVideoSubmissionFacts = {
    jobId: "FJ-1", projectId: "VID-1", inputSha256: hash("frozen input"), shotId: "S1", stepKey: "videos:S1",
    requestHash: filmRequestHash({ method: "video.generate", stepKey: "videos:S1", shotId: "S1", params: requestParams }),
    providerRequestHash: hash("actual compiled POST bytes"), taskId: "provider-task-1",
    artifact: { ref: "clips/S1-raw.mp4", sha256: hash("actual downloaded video bytes"), bytes: 1024 },
    promptSha256: hash(prompt), referenceInputs: [{ role: "reference-image", ref: "references/front.png", sha256: hash("front photo bytes"), hashKind: "bytes" }],
    aspect: "9:16", resolution: "720p", seconds: 5, generateAudio: true,
  };
  const { requestHash: ignoredChannelHash, providerRequestHash: ignoredProviderHash, ...bindings } = structuredClone(facts);
  void ignoredChannelHash; void ignoredProviderHash;
  return { facts, expected: { ...bindings, requestParams } };
}
function reseal(receipt: Record<string, unknown>): Record<string, unknown> {
  const { receiptHash: ignored, ...body } = receipt;
  void ignored;
  return { ...body, receiptHash: hash(filmCanonicalJson(body)) };
}

describe("父服务影片提交事实回执（字节合同，不是签名或人物认证）", () => {
  it("接受同一次作业/IPC请求/下载产物的完整正常合同", () => {
    const { facts, expected } = fixture();
    const receipt = buildFilmVideoSubmissionReceipt(facts);
    expect(receipt.schemaVersion).toBe("workloom.film-video-submission/v1");
    expect(receipt.requestHash).toBe(filmRequestHash({ method: "video.generate", stepKey: expected.stepKey, shotId: expected.shotId, params: expected.requestParams }));
    expect(assertFilmVideoSubmissionReceipt(JSON.parse(JSON.stringify(receipt)), expected)).toEqual(receipt);
    expect(receipt).not.toHaveProperty("requestInputVerified");
    expect(receipt).not.toHaveProperty("identityVerified");
  });

  it.each(["实际生成提示词\n【授权人物锁】同一套深色西装", "实际生成提示词\r\n【授权人物锁】同一套深色西装", "实际生成提示词\t【授权人物锁】同一套深色西装", "\r\n\t 实际生成提示词\n【授权人物锁】同一套深色西装 \t\r\n"])(
    "多行和普通首尾空白提示词保留精确UTF8哈希而不因合法换行拒绝 %j", (prompt) => {
      const { facts, expected } = fixture();
      const requestParams = { ...(expected.requestParams as Record<string, unknown>), prompt };
      const receipt = buildFilmVideoSubmissionReceipt({ ...facts, promptSha256: hash(prompt),
        requestHash: filmRequestHash({ method: "video.generate", stepKey: facts.stepKey, shotId: facts.shotId, params: requestParams }) });
      expect(assertFilmVideoSubmissionReceipt(receipt, { ...expected, promptSha256: hash(prompt), requestParams }).promptSha256).toBe(hash(prompt));
      expect(receipt.promptSha256).not.toBe(hash(prompt.replace(/\s/g, "")));
    },
  );

  it("仅修改换行或首尾空白即使重封通道哈希仍不能继承旧提示词摘要", () => {
    const { facts, expected } = fixture();
    const prompt = "\n实际生成提示词\n【授权人物锁】深色西装\t";
    const requestParams = { ...(expected.requestParams as Record<string, unknown>), prompt };
    const receipt = buildFilmVideoSubmissionReceipt({ ...facts, promptSha256: hash(prompt),
      requestHash: filmRequestHash({ method: "video.generate", stepKey: facts.stepKey, shotId: facts.shotId, params: requestParams }) });
    for (const altered of [prompt.replace(/\n/g, "\r\n"), prompt.trim()]) {
      const changedParams = { ...requestParams, prompt: altered };
      const changedReceipt = reseal({ ...receipt, requestHash: filmRequestHash({ method: "video.generate", stepKey: facts.stepKey, shotId: facts.shotId, params: changedParams }) });
      expect(() => assertFilmVideoSubmissionReceipt(changedReceipt, { ...expected, promptSha256: hash(prompt), requestParams: changedParams })).toThrow(/VIDEO_SUBMISSION_MISMATCH/);
    }
  });

  it.each(["", " \r\n\t ", "合法前缀\x00非法NUL", "合法前缀\x01非法C0", "合法前缀\x0b非法C0", "合法前缀\x0c非法C0", "合法前缀\x1b非法C0", "合法前缀\x7f非法DEL", "x".repeat(30_001), 42, null])(
    "提示词空白、非法控制字、非字符串或超限均拒绝 %j", (prompt) => {
      const { facts, expected } = fixture();
      const requestParams = { ...(expected.requestParams as Record<string, unknown>), prompt };
      const promptSha256 = hash(String(prompt));
      const receipt = buildFilmVideoSubmissionReceipt({ ...facts, promptSha256,
        requestHash: filmRequestHash({ method: "video.generate", stepKey: facts.stepKey, shotId: facts.shotId, params: requestParams }) });
      expect(() => assertFilmVideoSubmissionReceipt(receipt, { ...expected, promptSha256, requestParams })).toThrow(/VIDEO_SUBMISSION_UNVERIFIED/);
    },
  );

  it("提示词30000字符上界仍精确绑定，标识符继续拒绝换行", () => {
    const { facts, expected } = fixture();
    const prompt = "x".repeat(30_000);
    const requestParams = { ...(expected.requestParams as Record<string, unknown>), prompt };
    const promptSha256 = hash(prompt);
    const receipt = buildFilmVideoSubmissionReceipt({ ...facts, promptSha256,
      requestHash: filmRequestHash({ method: "video.generate", stepKey: facts.stepKey, shotId: facts.shotId, params: requestParams }) });
    expect(assertFilmVideoSubmissionReceipt(receipt, { ...expected, promptSha256, requestParams })).toEqual(receipt);
    expect(() => buildFilmVideoSubmissionReceipt({ ...facts, jobId: "FJ-1\n" })).toThrow(/VIDEO_SUBMISSION_UNVERIFIED/);
  });

  it("receiptHash绑定全部字段，键序不影响身份而参考图顺序保留", () => {
    const { facts } = fixture();
    const receipt = buildFilmVideoSubmissionReceipt(facts);
    const { receiptHash, ...body } = receipt;
    expect(receiptHash).toBe(hash(filmCanonicalJson(body)));
    const reversed = Object.fromEntries(Object.entries(facts).reverse()) as unknown as FilmVideoSubmissionFacts;
    expect(buildFilmVideoSubmissionReceipt(reversed).receiptHash).toBe(receiptHash);
    const two = { ...facts, referenceInputs: [...facts.referenceInputs, { role: "reference-image", ref: "references/side.png", sha256: hash("side"), hashKind: "bytes" } as const] };
    expect(buildFilmVideoSubmissionReceipt(two).receiptHash).not.toBe(buildFilmVideoSubmissionReceipt({ ...two, referenceInputs: [...two.referenceInputs].reverse() }).receiptHash);
  });

  it("返回独立副本，修改构建输入不能偷偷改写回执", () => {
    const { facts, expected } = fixture();
    const receipt = buildFilmVideoSubmissionReceipt(facts);
    facts.artifact.sha256 = hash("changed caller object");
    facts.referenceInputs[0]!.sha256 = hash("changed caller reference");
    expect(assertFilmVideoSubmissionReceipt(receipt, expected)).toEqual(receipt);
  });

  it("没有回执、布尔true、旧产物裸回执均按未核实拒绝", () => {
    const { facts, expected } = fixture();
    for (const input of [undefined, null, true, {}, { ...facts.artifact, taskId: facts.taskId }, { verified: true }]) {
      expect(() => assertFilmVideoSubmissionReceipt(input, expected)).toThrow(/VIDEO_SUBMISSION_UNVERIFIED/);
    }
  });

  it("任一必需字段缺失都不能降级为成功，包括显式false和空参考数组", () => {
    const { facts, expected } = fixture();
    const receipt = buildFilmVideoSubmissionReceipt(facts);
    for (const key of Object.keys(receipt)) {
      const missing = { ...receipt } as Record<string, unknown>;
      delete missing[key];
      expect(() => assertFilmVideoSubmissionReceipt(missing, expected), key).toThrow(/VIDEO_SUBMISSION_UNVERIFIED/);
    }
    for (const key of Object.keys(expected)) {
      const missing = { ...expected } as Record<string, unknown>;
      delete missing[key];
      expect(() => assertFilmVideoSubmissionReceipt(receipt, missing as unknown as FilmVideoSubmissionExpected), key).toThrow(/VIDEO_SUBMISSION_UNVERIFIED/);
    }
  });

  it("重封有效哈希也不能跨作业、源稿、镜头、请求、任务或产物复用", () => {
    const { facts, expected } = fixture();
    const receipt = buildFilmVideoSubmissionReceipt(facts);
    const mutations: Record<string, unknown>[] = [
      { jobId: "FJ-2" }, { projectId: "VID-2" }, { inputSha256: hash("other input") }, { shotId: "S2" }, { stepKey: "videos:S2" },
      { requestHash: hash("different request") }, { taskId: "provider-task-2" }, { artifact: { ...receipt.artifact, ref: "clips/S2-raw.mp4" } },
      { artifact: { ...receipt.artifact, sha256: hash("other video") } }, { artifact: { ...receipt.artifact, bytes: 1025 } },
      { promptSha256: hash("other prompt") }, { aspect: "16:9" }, { resolution: "1080p" }, { seconds: 6 }, { generateAudio: false },
      { referenceInputs: [{ ...receipt.referenceInputs[0]!, sha256: hash("other photo") }] }, { referenceInputs: [] },
    ];
    for (const change of mutations) {
      expect(() => assertFilmVideoSubmissionReceipt(reseal({ ...receipt, ...change }), expected), Object.keys(change).join(",")).toThrow(/VIDEO_SUBMISSION_MISMATCH/);
    }
  });

  it("未重封篡改任何有效字段时拒绝，不能把新字节配旧receiptHash", () => {
    const { facts, expected } = fixture();
    const receipt = buildFilmVideoSubmissionReceipt(facts);
    expect(() => assertFilmVideoSubmissionReceipt({ ...receipt, providerRequestHash: hash("new POST") }, expected)).toThrow(/VIDEO_SUBMISSION_TAMPERED/);
    expect(() => assertFilmVideoSubmissionReceipt({ ...receipt, artifact: { ...receipt.artifact, sha256: hash("new video") } }, expected)).toThrow(/VIDEO_SUBMISSION_TAMPERED/);
  });

  it("拒绝verified附加字段、错schema、假providerHash和非JSON对象", () => {
    const { facts, expected } = fixture();
    const receipt = buildFilmVideoSubmissionReceipt(facts);
    for (const input of [{ ...receipt, verified: true }, { ...receipt, schemaVersion: "old/v0" }, { ...receipt, providerRequestHash: "" },
      { ...receipt, providerRequestHash: "A".repeat(64) }, new Date()]) {
      expect(() => assertFilmVideoSubmissionReceipt(input, expected)).toThrow(/VIDEO_SUBMISSION_UNVERIFIED/);
    }
    expect(() => buildFilmVideoSubmissionReceipt({ ...facts, requestInputVerified: true } as FilmVideoSubmissionFacts)).toThrow(/VIDEO_SUBMISSION_UNVERIFIED/);
  });

  it("child依据实际发送params重算请求身份，并校验事实和params互相一致", () => {
    const { facts, expected } = fixture();
    const receipt = buildFilmVideoSubmissionReceipt(facts);
    const parameters = expected.requestParams as Record<string, unknown>;
    for (const change of [{ prompt: "silently changed prompt" }, { targetRef: "clips/other.mp4" }, { refs: [] }, { seconds: 6 },
      { generateAudio: false }, { aspect: "16:9" }, { resolution: "1080p" }]) {
      const alteredParams = { ...parameters, ...change };
      // Even a coherently substituted channel request hash cannot rescue facts
      // that disagree with independently supplied current-byte bindings.
      const alteredReceipt = reseal({ ...receipt, requestHash: filmRequestHash({ method: "video.generate", stepKey: expected.stepKey, shotId: expected.shotId, params: alteredParams }) });
      expect(() => assertFilmVideoSubmissionReceipt(alteredReceipt, { ...expected, requestParams: alteredParams })).toThrow(/VIDEO_SUBMISSION_MISMATCH/);
    }
    expect(() => assertFilmVideoSubmissionReceipt(receipt, { ...expected, requestHash: hash("caller provided wrong channel hash") })).toThrow(/VIDEO_SUBMISSION_MISMATCH/);
  });

  it("接受明确无参考图与generateAudio=false，拒绝参数中缺失关键值", () => {
    const { facts, expected } = fixture();
    const requestParams = { ...(expected.requestParams as Record<string, unknown>), refs: [], generateAudio: false };
    const adjustedFacts = { ...facts, referenceInputs: [], generateAudio: false,
      requestHash: filmRequestHash({ method: "video.generate", stepKey: facts.stepKey, shotId: facts.shotId, params: requestParams }) };
    const receipt = buildFilmVideoSubmissionReceipt(adjustedFacts);
    const adjustedExpected = { ...expected, referenceInputs: [], generateAudio: false, requestParams };
    expect(assertFilmVideoSubmissionReceipt(receipt, adjustedExpected).generateAudio).toBe(false);
    for (const key of ["prompt", "refs", "seconds", "generateAudio", "aspect", "resolution", "targetRef"]) {
      const missing: Record<string, unknown> = { ...requestParams };
      delete missing[key];
      expect(() => assertFilmVideoSubmissionReceipt(receipt, { ...adjustedExpected, requestParams: missing }), key).toThrow(/VIDEO_SUBMISSION_UNVERIFIED/);
    }
  });

  it("asset:// 摘要只认证URI语义，不能混成像素bytes摘要", () => {
    const { facts, expected } = fixture();
    const ref = "asset://ceo-front-1";
    const referenceInputs = [{ role: "reference-image", ref, sha256: hash(ref), hashKind: "asset-uri" } as const];
    const requestParams = { ...(expected.requestParams as Record<string, unknown>), refs: [ref] };
    const receipt = buildFilmVideoSubmissionReceipt({ ...facts, referenceInputs,
      requestHash: filmRequestHash({ method: "video.generate", stepKey: facts.stepKey, shotId: facts.shotId, params: requestParams }) });
    expect(assertFilmVideoSubmissionReceipt(receipt, { ...expected, referenceInputs, requestParams }).referenceInputs[0]!.hashKind).toBe("asset-uri");
    expect(() => buildFilmVideoSubmissionReceipt({ ...facts, referenceInputs: [{ ...referenceInputs[0]!, sha256: hash("pretend photo pixels") }] })).toThrow(/VIDEO_SUBMISSION_UNVERIFIED/);
    expect(() => buildFilmVideoSubmissionReceipt({ ...facts, referenceInputs: [{ ...referenceInputs[0]!, hashKind: "bytes" }] })).toThrow(/VIDEO_SUBMISSION_UNVERIFIED/);
  });

  it("本地first frame与参考图按不同角色绑定，同URL不替代已签发字节", () => {
    const { facts, expected } = fixture();
    const first = { role: "first-frame", ref: "plates/S1.png", sha256: hash("issued first-frame bytes"), hashKind: "bytes" } as const;
    const referenceInputs = [first, ...facts.referenceInputs];
    const requestParams = { ...(expected.requestParams as Record<string, unknown>), firstFrame: { ref: first.ref } };
    const receipt = buildFilmVideoSubmissionReceipt({ ...facts, referenceInputs,
      requestHash: filmRequestHash({ method: "video.generate", stepKey: facts.stepKey, shotId: facts.shotId, params: requestParams }) });
    expect(assertFilmVideoSubmissionReceipt(receipt, { ...expected, referenceInputs, requestParams })).toEqual(receipt);
    const wrong = [{ ...first, sha256: hash("changed first-frame bytes") }, ...facts.referenceInputs];
    expect(() => assertFilmVideoSubmissionReceipt(receipt, { ...expected, referenceInputs: wrong, requestParams })).toThrow(/VIDEO_SUBMISSION_MISMATCH/);
  });

  it("hosted first frame同时绑定已签发artifact bytes与请求URL摘要", () => {
    const { facts, expected } = fixture();
    const hostedUrl = "https://issued.example.invalid/S1.png";
    const first = { role: "first-frame", ref: "plates/S1.png", sha256: hash("issued first-frame bytes"), hashKind: "bytes", requestUriSha256: hash(hostedUrl) } as const;
    const referenceInputs = [first, ...facts.referenceInputs];
    const requestParams = { ...(expected.requestParams as Record<string, unknown>), firstFrame: { hostedUrl } };
    const receipt = buildFilmVideoSubmissionReceipt({ ...facts, referenceInputs,
      requestHash: filmRequestHash({ method: "video.generate", stepKey: facts.stepKey, shotId: facts.shotId, params: requestParams }) });
    expect(assertFilmVideoSubmissionReceipt(receipt, { ...expected, referenceInputs, requestParams })).toEqual(receipt);
    const missingUrlBinding = [{ role: first.role, ref: first.ref, sha256: first.sha256, hashKind: first.hashKind }, ...facts.referenceInputs];
    expect(() => assertFilmVideoSubmissionReceipt(receipt, { ...expected, referenceInputs: missingUrlBinding, requestParams })).toThrow(/VIDEO_SUBMISSION_(UNVERIFIED|MISMATCH)/);
    const changed = { ...requestParams, firstFrame: { hostedUrl: "https://issued.example.invalid/other.png" } };
    const coherent = reseal({ ...receipt, requestHash: filmRequestHash({ method: "video.generate", stepKey: facts.stepKey, shotId: facts.shotId, params: changed }) });
    expect(() => assertFilmVideoSubmissionReceipt(coherent, { ...expected, referenceInputs, requestParams: changed })).toThrow(/VIDEO_SUBMISSION_MISMATCH/);
  });

  it("非法路径、hash、空/非整数bytes和非布尔音频值均拒绝", () => {
    const { facts } = fixture();
    for (const artifact of [{ ...facts.artifact, ref: "../outside.mp4" }, { ...facts.artifact, ref: "/tmp/raw.mp4" },
      { ...facts.artifact, ref: "C:\\raw.mp4" }, { ...facts.artifact, ref: "clips//raw.mp4" }, { ...facts.artifact, sha256: "x" },
      { ...facts.artifact, bytes: 0 }, { ...facts.artifact, bytes: 1.5 }, { ...facts.artifact, bytes: Number.MAX_SAFE_INTEGER + 1 }]) {
      expect(() => buildFilmVideoSubmissionReceipt({ ...facts, artifact })).toThrow(/VIDEO_SUBMISSION_UNVERIFIED/);
    }
    for (const change of [{ jobId: "" }, { taskId: "" }, { inputSha256: "" }, { promptSha256: "" }, { aspect: "" }, { resolution: "" },
      { seconds: 0 }, { seconds: Number.NaN }, { generateAudio: "false" }, { referenceInputs: undefined }]) {
      expect(() => buildFilmVideoSubmissionReceipt({ ...facts, ...change } as FilmVideoSubmissionFacts)).toThrow(/VIDEO_SUBMISSION_UNVERIFIED/);
    }
  });

  it("参考角色/顺序/集合均精确绑定，不允许多first frame或未知引用角色", () => {
    const { facts, expected } = fixture();
    const first = { role: "first-frame", ref: "plates/S1.png", sha256: hash("first"), hashKind: "bytes" } as const;
    expect(() => buildFilmVideoSubmissionReceipt({ ...facts, referenceInputs: [first, { ...first, ref: "plates/S2.png" }] })).toThrow(/VIDEO_SUBMISSION_UNVERIFIED/);
    expect(() => buildFilmVideoSubmissionReceipt({ ...facts, referenceInputs: [{ ...facts.referenceInputs[0]!, role: "unknown" }] } as unknown as FilmVideoSubmissionFacts)).toThrow(/VIDEO_SUBMISSION_UNVERIFIED/);
    const refs = [...facts.referenceInputs, { role: "reference-image", ref: "references/side.png", sha256: hash("side"), hashKind: "bytes" } as const];
    const params = { ...(expected.requestParams as Record<string, unknown>), refs: refs.map(x => x.ref) };
    const receipt = buildFilmVideoSubmissionReceipt({ ...facts, referenceInputs: refs,
      requestHash: filmRequestHash({ method: "video.generate", stepKey: facts.stepKey, shotId: facts.shotId, params }) });
    expect(() => assertFilmVideoSubmissionReceipt(receipt, { ...expected, requestParams: params, referenceInputs: [...refs].reverse() })).toThrow(/VIDEO_SUBMISSION_MISMATCH/);
  });

  it("可选provider摘要预期若给出必须匹配，但缺实际provider摘要一律未核实", () => {
    const { facts, expected } = fixture();
    const receipt = buildFilmVideoSubmissionReceipt(facts);
    expect(assertFilmVideoSubmissionReceipt(receipt, { ...expected, providerRequestHash: facts.providerRequestHash })).toEqual(receipt);
    expect(() => assertFilmVideoSubmissionReceipt(receipt, { ...expected, providerRequestHash: hash("other POST") })).toThrow(/VIDEO_SUBMISSION_MISMATCH/);
  });
});
