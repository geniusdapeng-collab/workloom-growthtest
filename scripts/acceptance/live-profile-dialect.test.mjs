/**
 * live-profile-dialect.test.mjs · 本仓实际 profile 的模型端点方言回归（MC-015）
 *
 * 历史 growthmatrix 实测发现：Messages 兼容根带 /anthropic；OpenAI 兼容
 * /chat/completions 必须使用归一后的 OpenAI 根。两个模型条目和任务仍读取本仓
 * acceptance/profile.json，不借其它仓的 profile 证明通过。
 *
 * 本次获授权的隔离仓局部控制修复保留本仓协议声明；缺 LLM_BASE_URL 时以精确
 * 端点与归一警告锁定回归，不能用允许错误协议根的宽松正则冒充验证。
 * 原 required 摘要、隔离状态、业务身份、上游冻结引用和 rename policy 不变。
 * 此测试仅进行解析和断言，不发网络请求，也不证明付费供应商或产品任务完成。
 *
 * 用法：node --test scripts/acceptance/live-profile-dialect.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { resolveLiveModels } from "./lib/live/providers.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROFILE = JSON.parse(readFileSync(join(REPO_ROOT, "acceptance", "profile.json"), "utf-8"));

/** live.env 的真实键约定（值只用于复算，不落任何报告） */
const SEALED_KEYS_ENV = {
  DEEPSEEK_API_KEY: "sealed-deepseek-key",
  DEEPSEEK_BASE_URL: "https://api.deepseek.com/anthropic",
  DEEPSEEK_MODEL: "deepseek-flash",
  LLM_BASE_URL: "https://api.deepseek.com",
  VOLCENGINE_ARK_API_KEY: "sealed-ark-key",
};

const resolvedOf = (env = SEALED_KEYS_ENV) => resolveLiveModels(PROFILE.live.models, env);
const tasksOfChain = (chain) => PROFILE.live.tasks.filter((task) => task.chain === chain);
const modelOf = (resolved, id) => resolved.find((m) => m.id === id);

describe("P 域模型端点方言（MC-015 · LLM-G1 404 根因）", () => {
  it("model-gateway 链路解析到 OpenAI 兼容根，且不会拼出 /anthropic/chat/completions", () => {
    const tasks = tasksOfChain("model-gateway");
    assert.ok(tasks.length > 0, "profile 必须声明至少一个 model-gateway 任务（LLM-G1）");
    const resolved = resolvedOf();
    for (const task of tasks) {
      const model = modelOf(resolved, task.model);
      assert.ok(model, `${task.id} 引用的模型 ${task.model} 必须在 profile.live.models 里声明`);
      assert.equal(model.ready, true, `${task.id} 的模型必须凭据就绪：${model.missing.join("；")}`);
      assert.equal(
        String(model.baseUrl).includes("/anthropic"),
        false,
        `${task.id}（model-gateway）不得使用 Anthropic 兼容根：${model.baseUrl}`,
      );
      assert.equal(
        `${model.baseUrl}/chat/completions`,
        "https://api.deepseek.com/chat/completions",
        `${task.id} 实际请求端点必须落在 OpenAI 兼容根上`,
      );
    }
  });

  it("声明层锁死：model-gateway 的模型条目不得把 baseUrlEnv 指向 DEEPSEEK_BASE_URL", () => {
    const gatewayModelIds = new Set(tasksOfChain("model-gateway").map((task) => task.model));
    for (const entry of PROFILE.live.models.filter((m) => gatewayModelIds.has(m.id))) {
      assert.notEqual(
        entry.baseUrlEnv,
        "DEEPSEEK_BASE_URL",
        `${entry.id} 的 baseUrlEnv 指向 Anthropic 兼容根会在 /chat/completions 上 404`,
      );
      assert.equal(entry.adapter, "model-gateway", `${entry.id} 的 adapter 应与任务链路一致`);
    }
  });

  it("dsh-harness 链路仍走 Anthropic 兼容根（Messages 协议），不被“统一端点”顺手改坏", () => {
    const resolved = resolvedOf();
    for (const task of tasksOfChain("dsh-harness")) {
      const model = modelOf(resolved, task.model);
      assert.ok(model, `${task.id} 引用的模型 ${task.model} 必须在 profile.live.models 里声明`);
      assert.equal(
        model.baseUrl,
        "https://api.deepseek.com/anthropic",
        `${task.id}（dsh-harness）必须解析到 Anthropic 兼容根`,
      );
    }
  });

  it("缺 LLM_BASE_URL 时（只剩封存文件的其它键）不得静默回落到 Anthropic 根", () => {
    const env = { ...SEALED_KEYS_ENV };
    delete env.LLM_BASE_URL;
    const gatewayModelId = tasksOfChain("model-gateway")[0].model;
    const model = modelOf(resolvedOf(env), gatewayModelId);
    // 当前局部修复在缺 OpenAI 根时剥除 Anthropic 协议后缀，并记录归一警告。
    // 本仓真实 profile 的任务和两条协议声明均保留，不能用宽松正则接受错误端点。
    assert.ok(model, "model-gateway 的模型条目必须可解析");
    assert.equal(model.baseUrl, "https://api.deepseek.com");
    assert.equal(model.baseUrlDialect, "openai");
    assert.ok(model.warnings.some((warning) => warning.includes("OpenAI 兼容根归一")));
  });
});
