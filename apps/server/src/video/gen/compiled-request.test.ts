import { afterEach, describe, expect, it, vi } from "vitest";
import { ArkImageProvider, ArkVideoProvider, HiggsfieldProvider, MuapiProvider } from "./providers.js";
import { buildRenderPrompt, canonicalRenderJson, compileProviderRequest, compileRenderRequest, validateProductionParams } from "./compiled-request.js";
import { getModel } from "./catalog.js";

const model = getModel("doubao-seedance-2-5")!;
const script = { id: "RS-1", project_id: "P-1", shot_id: "S-1", script_key: "qualified:PQ-1", version: 1, status: "draft", md: "固定机位观察窗边玻璃杯。\n", fields: { durationSec: 5 } };
afterEach(() => vi.unstubAllGlobals());

describe("完整最终请求编译", () => {
  it.each([
    ["seedance", new ArkVideoProvider({ apiKey: "test", baseUrl: "https://ark.example.test/api" }), { baseUrl: "https://ark.example.test/api" }],
    ["seedream", new ArkImageProvider({ apiKey: "test", baseUrl: "https://ark.example.test/api" }), { baseUrl: "https://ark.example.test/api" }],
    ["higgsfield", new HiggsfieldProvider({ keyId: "test", keySecret: "test", baseUrl: "https://hf.example.test", webhookUrl: "https://hook.example.test" }), { baseUrl: "https://hf.example.test", webhookUrl: "https://hook.example.test" }],
    ["muapi", new MuapiProvider({ apiKey: "test", baseUrl: "https://mu.example.test" }), { baseUrl: "https://mu.example.test" }],
  ] as const)("%s 审核的端点和 JSON 字节与真实适配器发送完全一致", async (providerId, provider, cfg) => {
    const seen: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => { seen.push({ url: String(url), body: init.body }); return new Response(JSON.stringify({ id: "task", data: [{ url: "https://cdn.example.test/image.png" }] })); }));
    const req = { prompt: script.md, estimatedUnits: 5, params: { providerModel: "model/video", durationSec: 5, seed: 0,
      aspectRatio: "16:9", generateAudio: false, firstFrameUrl: "asset://first", referenceImageUrls: ["asset://reference"],
      referenceVideoUrls: ["https://cdn.example.test/v.mp4"], referenceAudioUrls: ["https://cdn.example.test/a.wav"],
      extra: { cfg_scale: 1.25, negative_prompt: "没有文字" } } };
    const compiled = compileProviderRequest(providerId, req, cfg);
    await provider.submit(req);
    expect(seen).toEqual([{ url: compiled.endpoint, body: compiled.bodyJson }]);
    expect(JSON.parse(compiled.bodyJson)).toEqual(compiled.body);
    expect(compiled.bodyJson).toContain("固定机位观察");
    expect(compiled.payloadHash).toMatch(/^[a-f0-9]{64}$/);
  });
  it("保留完整正文与换行，不追加脚本标签；超过模型上限明确拒绝", () => {
    expect(buildRenderPrompt(script, model)).toBe(script.md);
    const limit = model.limits?.maxPromptChars ?? 4000;
    expect(buildRenderPrompt({ md: "字".repeat(limit) }, model)).toHaveLength(limit);
    expect(() => buildRenderPrompt({ md: "字".repeat(limit + 1) }, model)).toThrow("PROMPT_TOO_LONG");
    expect(() => buildRenderPrompt({ md: " " }, model)).toThrow("REQUEST_INVALID");
  });
  it("正文、模型覆盖、端点、参考顺序和全部额外参数改变都会改变资格指纹", () => {
    const input = { script, model, params: { durationSec: 5, referenceImageUrls: ["asset://a", "asset://b"] },
      scope: { tenantId: "t", workspaceId: "w" }, mode: "manual" as const, env: {} };
    const original = compileRenderRequest(input);
    for (const patch of [
      { script: { ...script, md: script.md + "更多细节" } }, { env: { SEEDANCE_MODEL: "new-model" } },
      { env: { SEEDANCE_ENDPOINT: "https://another.example.test" } },
      { params: { durationSec: 5, referenceImageUrls: ["asset://b", "asset://a"] } },
      { params: { durationSec: 5, extra: { cfg_scale: 9 } } },
    ]) expect(compileRenderRequest({ ...input, ...patch }).requestHash).not.toBe(original.requestHash);
  });
  it("对象顺序规范化、数组保序，__proto__ 不会消失", () => {
    expect(canonicalRenderJson({ b: 2, a: 1 })).toBe(canonicalRenderJson({ a: 1, b: 2 }));
    expect(canonicalRenderJson([1, 2])).not.toBe(canonicalRenderJson([2, 1]));
    expect(canonicalRenderJson(JSON.parse('{"__proto__":{"x":1}}'))).toContain('"__proto__"');
  });
  it.each(["model", "prompt", "content", "duration", "image_url", "jobDir", "__proto__"])("extra.%s 不能替换源内容", key => {
    expect(() => validateProductionParams({ extra: JSON.parse(`{"${key}":"forged"}`) })).toThrow("REQUEST_INVALID");
  });
  it("非法 JSON、空模型、未编译供应商和模型路径穿越都拒绝", () => {
    expect(() => validateProductionParams({ durationSec: NaN })).toThrow("REQUEST_INVALID");
    expect(() => validateProductionParams({ prompt: "手写覆盖" })).toThrow("REQUEST_INVALID");
    expect(() => compileProviderRequest("seedance", { prompt: "p", estimatedUnits: 1 })).toThrow("REQUEST_INVALID");
    expect(() => compileProviderRequest("kling", { prompt: "p", estimatedUnits: 1, params: { providerModel: "m" } })).toThrow("PROVIDER_COMPILER_UNAVAILABLE");
    expect(() => compileProviderRequest("higgsfield", { prompt: "p", estimatedUnits: 1, params: { providerModel: "model/../other" } })).toThrow("REQUEST_INVALID");
  });
});
