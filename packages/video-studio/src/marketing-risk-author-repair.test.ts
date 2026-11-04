import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resetCircuit } from "@workloom/base/model-router";
import { WorkloomLLMEngine } from "./llm-adapter.js";
import { videoRuntimeRoot } from "./runtime-root.js";
import { installVendorDiscoveryFixBridge, installVendorDiscoveryNarrativeBridge } from "./vendor-compat.js";

const source = { intent: "骑手穿戴护具，在封闭场地通过训练门架。", product: "训练自行车", restrictions: ["禁止虚构性能"] };
const assessment = { technicalRisks: [{ risk: "接触扣带穿模", level: "medium", impact: "扣带不连续" }],
  mitigationSuggestions: ["固定扣带位置并逐镜检查手与扣带的接触点。"], businessConstraints: ["保持训练场封闭"] };
const schema = { type: "object", required: Object.keys(assessment) };
const completion = (id: string, content: string, measured = true): Response => Response.json({ id, model: "deepseek-flash",
  choices: [{ finish_reason: "stop", message: { content } }],
  ...(measured ? { usage: { prompt_tokens: 55, completion_tokens: 12, total_tokens: 67 } } : {}) });
const root = videoRuntimeRoot(import.meta.url);
const require = createRequire(join(root, "package.json"));
const { RequirementDiscoveryEngine } = require(join(root,
  "vendor/supermickey/hyperreality-system/engines/requirement-discovery-engine.js"));

async function runRisk(respond: (attempt: number) => Response) {
  const wire: Array<{ model: string; messages: unknown[] }> = [];
  const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
    wire.push(JSON.parse(String(init?.body)));
    return respond(wire.length);
  });
  const engine = new WorkloomLLMEngine({ baseUrl: "https://risk-fixture.example.invalid/v1", apiKey: randomUUID(), model: "deepseek-flash", fetchImpl });
  const restoreDefaults = installVendorDiscoveryFixBridge();
  const restore = installVendorDiscoveryNarrativeBridge({ marketingDiscovery: () => source });
  try {
    const risk = new RequirementDiscoveryEngine({ llmEngine: engine }).agents.risk;
    const result = await risk.run({ type: "商业广告", description: source.intent }, schema).then(
      (value: unknown) => ({ value }), (error: unknown) => ({ error }));
    return { result, wire };
  } finally {
    restore();
    restoreDefaults();
  }
}

afterEach(() => { resetCircuit(); });

it("repairs one positively settled author parse failure with one distinct same-model request", async () => {
  const { result, wire } = await runRisk(attempt => completion(`known-${attempt}`, attempt === 1 ? "答复正文遗失" : JSON.stringify(assessment)));
  expect(result).toMatchObject({ value: assessment });
  expect(wire.map(row => row.model)).toEqual(["deepseek-flash", "deepseek-flash"]);
  expect(wire[1]?.messages).not.toEqual(wire[0]?.messages);
  expect(JSON.stringify(wire[1]?.messages)).toContain(source.intent);
  expect(JSON.stringify(wire[1]?.messages)).toContain("本次作者修复");
});

it.each(["missing-usage", "transport", "unknown", "repeated-invalid", "unpaired-json"])("%s has no additional unverified author submission", async (mode) => {
  const { result, wire } = await runRisk(attempt => {
    if (mode === "unknown") throw new TypeError("loopback interrupted");
    if (mode === "transport") return Response.json({ error: { message: "JSON 解析失败: synthetic HTTP rejection" } }, { status: 403 });
    if (mode === "unpaired-json") return completion(`${mode}-${attempt}`, JSON.stringify({ ...assessment, mitigationSuggestions: [] }));
    return completion(`${mode}-${attempt}`, "没有可解析对象", mode !== "missing-usage");
  });
  expect(result).toHaveProperty("error");
  expect(wire).toHaveLength(mode === "repeated-invalid" ? 2 : 1);
});
