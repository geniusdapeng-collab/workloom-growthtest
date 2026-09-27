import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveGate } from "./gates.js";
import { autoApproveHandler, runWithConfirmationHandler } from "./confirmation.js";
import { WorkloomLLMEngine } from "./llm-adapter.js";
import { buildRenderScript, loadPromptLengthSpec } from "./render-scripts.js";
import { VideoStudio, type ApprovalCallback, type EventSink } from "./studio.js";

const studioMocks = vi.hoisted(() => ({
  construct: vi.fn(),
  create: vi.fn(),
  installed: [] as string[],
  disposed: [] as string[],
  failInstall: "",
  failDispose: ""
}));

// 仅替换 vendor 的生产执行和全局补丁，测试实际 VideoStudio 与确认分发器的接线。
vi.mock("node:module", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:module")>();
  return {
    ...original,
    createRequire: (url: string | URL) => {
      const require = original.createRequire(url);
      return new Proxy(require, {
        apply(target, thisArg, args: [string]) {
          if (args[0].endsWith("/vendor/supermickey/hyperreality-system/index.js")) {
            return { HyperrealitySystem: class {
              constructor() { studioMocks.construct(); }
              create(...input: unknown[]) { return studioMocks.create(...input); }
            } };
          }
          return Reflect.apply(target, thisArg, args);
        }
      });
    }
  };
});

vi.mock("./vendor-compat.js", () => {
  const install = (name: string) => () => {
    if (studioMocks.failInstall === name) throw new Error(`install failed: ${name}`);
    studioMocks.installed.push(name);
    return () => {
      studioMocks.disposed.push(name);
      if (studioMocks.failDispose === name) throw new Error(`dispose failed: ${name}`);
    };
  };
  return {
    applyDurationPolicyToManager: vi.fn(),
    installVendorConfigIsolatorBridge: install("isolator"),
    installVendorPhaseDiagnosticsBridge: install("phase"),
    installVendorFieldQualityBridge: install("field"),
    installVendorMicroMotionBridge: install("micro"),
    installVendorContractBridge: install("contract"),
    installVendorPromptRebuildBridge: install("prompt"),
    installVendorDiscoveryFixBridge: install("discovery"),
    installVendorPhaseInternalsDiagnostics: install("inner"),
    installVendorAudioDisciplineBridge: install("audio"),
    installVendorDurationPolicyBridge: install("duration"),
    installVendorDurationProjectionBridge: install("projection"),
    installSharedBridge: (_key: string, factory: () => () => void) => factory()
  };
});

vi.mock("./duration-rules.js", () => ({
  loadDurationRules: () => ({ modelMin: 4, modelMax: 30, sources: [], nonLive: [], blockers: [], aligned: true })
}));

beforeEach(() => {
  studioMocks.construct.mockReset();
  studioMocks.create.mockReset();
  studioMocks.installed.length = 0;
  studioMocks.disposed.length = 0;
  studioMocks.failInstall = "";
  studioMocks.failDispose = "";
});

describe("gates 映射", () => {
  it("vendor 确认门 type 映射到业务门", () => {
    expect(resolveGate("creative-theme")).toBe("G2_THEME");
    expect(resolveGate("prd")).toBe("G4_PRD");
    expect(resolveGate("portraits")).toBe("G5_PORTRAIT");
    expect(resolveGate("prompt")).toBe("G6_PROMPT");
    expect(resolveGate("dossier")).toBe("G1_DOSSIER");
    expect(resolveGate("nonexistent")).toBe("UNKNOWN");
  });
});

describe("确认门桥", () => {
  it("作用域内可读取批准，退出后固定分发器拒绝无作用域调用", async () => {
    const handler = autoApproveHandler();
    const request = { type: "prd", content: "# PRD", runId: "r1" };
    const verdict = await runWithConfirmationHandler(handler, () => globalThis.__HR_CONFIRMATION_HANDLER__!(request));
    expect(verdict.approved).toBe(true);
    expect(await globalThis.__HR_CONFIRMATION_HANDLER__!(request)).toMatchObject({
      approved: false, fatal: "confirmation-scope-missing"
    });
  });
});

function studio(onApproval: ApprovalCallback, onEvent?: EventSink): VideoStudio {
  return new VideoStudio({
    llm: new WorkloomLLMEngine({ baseUrl: "https://example.invalid", apiKey: "test-only", model: "test" }),
    workDir: "/unused/confirmation-scope-test",
    onApproval,
    onEvent,
    log: () => undefined
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("VideoStudio 确认作用域与装配清理", () => {
  it("两条真实 studio 运行交错确认，项目与事件不串线", async () => {
    const ready = [deferred(), deferred()];
    const release = [deferred(), deferred()];
    const approvals = [vi.fn(async () => ({ approved: true, reason: "A" })), vi.fn(async () => ({ approved: false, reason: "B" }))];
    const events = [vi.fn(), vi.fn()];
    studioMocks.create.mockImplementation(async (intent: string) => {
      const i = intent === "A" ? 0 : 1;
      ready[i]!.resolve();
      await release[i]!.promise;
      const verdict = await globalThis.__HR_CONFIRMATION_HANDLER__!({ type: "prd", content: intent, runId: `run-${intent}` });
      return { success: verdict.approved, verdict, stages: {} };
    });
    const running = [
      studio(approvals[0]!, events[0]).runPreproduction({ projectId: "project-A", intent: "A" }),
      studio(approvals[1]!, events[1]).runPreproduction({ projectId: "project-B", intent: "B" })
    ];
    await Promise.all(ready.map((r) => r.promise));
    release[1]!.resolve();
    expect(await running[1]).toMatchObject({ success: false, verdict: { reason: "B" } });
    release[0]!.resolve();
    expect(await running[0]).toMatchObject({ success: true, verdict: { reason: "A" } });
    for (const [i, label] of ["A", "B"].entries()) {
      expect(approvals[i]).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        gate: "G4_PRD", contentMd: label, runId: `run-${label}`
      }));
      for (const [event] of events[i]!.mock.calls) expect(event.projectId).toBe(`project-${label}`);
      expect(events[i]).toHaveBeenCalledWith(expect.objectContaining({ kind: "pipeline.gate.resolved" }));
    }
  });

  it.each(["install", "constructor", "started", "create", "approval"])("%s 失败也逆序清理所有已装桥并关闭确认作用域", async (failureAt) => {
    const failure = new Error(`failed at ${failureAt}`);
    const onApproval = vi.fn(async () => {
      if (failureAt === "approval") throw failure;
      return { approved: true };
    });
    const events = vi.fn(async (event: Parameters<EventSink>[0]) => {
      if (failureAt === "started" && event.kind === "pipeline.started") throw failure;
    });
    if (failureAt === "install") studioMocks.failInstall = "field";
    if (failureAt === "constructor") studioMocks.construct.mockImplementation(() => { throw failure; });
    studioMocks.create.mockImplementation(async () => {
      if (failureAt === "create") throw failure;
      await globalThis.__HR_CONFIRMATION_HANDLER__!({ type: "prd", content: "content", runId: "r" });
      return { success: true };
    });
    await expect(studio(onApproval, events).runPreproduction({ projectId: "p", intent: "intent" }))
      .rejects.toThrow(failureAt === "install" ? "install failed: field" : failure.message);
    expect(studioMocks.disposed).toEqual([...studioMocks.installed].reverse());
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ kind: "pipeline.failed" }));
    expect(await globalThis.__HR_CONFIRMATION_HANDLER__!({ type: "prd", content: "outside", runId: "r" }))
      .toMatchObject({ approved: false, fatal: "confirmation-scope-missing" });
    if (["install", "constructor", "started"].includes(failureAt)) expect(studioMocks.create).not.toHaveBeenCalled();
  });

  it("一个桥清理失败仍尝试其余清理，并保留运行与清理两个错误", async () => {
    const failure = new Error("create failed");
    studioMocks.create.mockRejectedValue(failure);
    studioMocks.failDispose = "audio";
    const result = studio(async () => ({ approved: true })).runPreproduction({ projectId: "p", intent: "intent" });
    await expect(result).rejects.toMatchObject({
      name: "AggregateError", message: "video-studio-bridge-cleanup-failed",
      errors: [failure, expect.objectContaining({ message: "dispose failed: audio" })]
    });
    expect(studioMocks.disposed).toEqual([...studioMocks.installed].reverse());
  });

  it("成功路径也逆序清理，返回原始业务结果", async () => {
    const result = { success: true, stages: { fixture: { intact: true } } };
    studioMocks.create.mockResolvedValue(result);
    expect(await studio(async () => ({ approved: true })).runPreproduction({ projectId: "p", intent: "intent" })).toBe(result);
    expect(studioMocks.disposed).toEqual([...studioMocks.installed].reverse());
  });
});

describe("LLM 适配器", () => {
  it("从环境变量构建：缺变量返回 null", () => {
    expect(WorkloomLLMEngine.fromEnv({})).toBeNull();
    const engine = WorkloomLLMEngine.fromEnv({
      LLM_BASE_URL: "https://example.invalid/v1",
      LLM_API_KEY: "k",
      LLM_MODEL: "m"
    });
    expect(engine).not.toBeNull();
    expect(engine?.model).toBe("m");
  });

  it("JSON 提取容错：围栏/前后噪声", () => {
    const extract = (WorkloomLLMEngine as unknown as { extractJson(t: string): unknown })
      .extractJson;
    expect(extract('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extract('前言{"b":2}')).toEqual({ b: 2 });
  });

  /** 真机 2026-09-22：requirement-discovery 直接调 llmEngine._extractJsonObject → 我们缺该方法 → SceneArchitect 全失败兜底 */
  it("vendor 期望的引擎助手：_extractJsonObject / getStats / close 齐备", async () => {
    const engine = WorkloomLLMEngine.fromEnv({
      LLM_BASE_URL: "https://example.invalid/v1",
      LLM_API_KEY: "k",
      LLM_MODEL: "m"
    })!;
    const extract = (engine as unknown as { _extractJsonObject(text: unknown): unknown })._extractJsonObject;
    // 与 vendor 同语义：返回 JSON 文本（调用方自行 JSON.parse）；非字符串输入返回 null
    const fenced = extract('```json\n{"scenes":[1,2]}\n```');
    expect(typeof fenced).toBe("string");
    expect(JSON.parse(String(fenced))).toEqual({ scenes: [1, 2] });
    expect(typeof extract("前言 {\"a\":1} 后语")).toBe("string");
    expect(extract({ already: "object" })).toBeNull();
    expect(extract("没有 JSON 的文本")).toBeNull();
    expect(extract("")).toBeNull();
    const stats = (engine as unknown as { getStats(): { totalCalls: number; model: string } }).getStats();
    expect(stats.model).toBe("m");
    expect(stats.totalCalls).toBe(0);
    await expect((engine as unknown as { close(): Promise<void> }).close()).resolves.toBeUndefined();
  });
});

describe("渲染脚本", () => {
  it("从 vendor 读取长度口径（唯一真源）", () => {
    const spec = loadPromptLengthSpec();
    expect(spec.hardMax).toBeGreaterThanOrEqual(3000);
    expect(spec.idealMin).toBeGreaterThan(0);
  });

  it("生成 MD 脚本：序号+独立行排版 + 口径校验", () => {
    const script = buildRenderScript(
      "p1",
      {
        shotId: "S01",
        sceneType: "establishing",
        durationSec: 8,
        promptText: "x".repeat(100),
        fields: { 语言约束: "中文", 台词: "[00:00] 主角 说:\"你好\"" },
        bindings: { heroImageId: "BRAND-HERO-001" }
      },
      1
    );
    expect(script.version).toBe(1);
    expect(script.markdown).toContain("01.【语言约束】");
    expect(script.markdown).toContain("BRAND-HERO-001");
    expect(script.charCount).toBe(100);
    expect(script.withinSpec).toBe(true);
  });
});

describe("vendor 核心可加载", () => {
  it("HyperrealitySystem 在真实 node 进程内可加载", () => {
    // vitest 的 ESM 转换会误处理 vendor 的 CJS，改用子进程验证真实运行环境
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const path = require("node:path") as typeof import("node:path");
    const { fileURLToPath } = require("node:url") as typeof import("node:url");
    const here = path.dirname(fileURLToPath(import.meta.url));
    const entry = path.resolve(
      here,
      "../../../vendor/supermickey/hyperreality-system/index.js"
    );
    const out = execFileSync(
      process.execPath,
      ["-e", `const m=require(${JSON.stringify(entry)});console.log(typeof m.HyperrealitySystem)`],
      { encoding: "utf8", timeout: 30_000 }
    );
    // vendor 加载时会打印日志噪声，断言最后一行输出
    expect(out.trim().split("\n").pop()).toBe("function");
  }, 35_000);
});

 describe("营销只消费宿主绑定回填", () => {
  const rawJson = JSON.stringify({ A1: { identity: { name: "本次商品" } }, A2: { reviews: [] }, A3: { competitors: [] } });
  const sha256 = createHash("sha256").update(rawJson).digest("hex");
  function marketing(verifiedRaw?: { projectId: string; rawJson: string; sha256: string; productQuery: Record<string, unknown> }) {
    return new VideoStudio({ llm: new WorkloomLLMEngine({ baseUrl: "https://example.invalid", apiKey: "test-only", model: "test" }),
      workDir: "/unused/marketing-test", onApproval: async () => ({ approved: true }), log: () => undefined,
      dataMining: { mode: "api", raw: { A1: { identity: { name: "旧缓存商品" } } }, storeRoot: "/unused/current-attempt", verifiedRaw } });
  }
  it.each(["missing", "wrong-project", "wrong-hash", "missing-stage"])("%s在vendor构造与create之前拒绝", async kind => {
    let proof = { projectId: "P1", rawJson, sha256, productQuery: { name: "本次商品" } };
    if (kind === "wrong-project") proof.projectId = "other";
    if (kind === "wrong-hash") proof.sha256 = "0".repeat(64);
    if (kind === "missing-stage") { proof.rawJson = JSON.stringify({ A1: {} }); proof.sha256 = createHash("sha256").update(proof.rawJson).digest("hex"); }
    await expect(marketing(kind === "missing" ? undefined : proof).runPreproduction({ projectId: "P1", intent: "营销", isMarketing: true,
      metadata: { _dataDossier: { approved: true }, dataMiningRaw: { forged: true } } })).rejects.toThrow("MARKETING_G1_REQUIRED");
    expect(studioMocks.construct).not.toHaveBeenCalled(); expect(studioMocks.create).not.toHaveBeenCalled();
  });
  it("可信回填覆盖旧cfg raw，metadata自报档案被移除；强制刷新和G1后跳过vendor重复审核", async () => {
    studioMocks.create.mockResolvedValue({ success: true, stages: {} });
    const metadata = { _dataDossier: { name: "伪造档案" }, brief: { product: "当前查询商品" } };
    await marketing({ projectId: "P1", rawJson, sha256, productQuery: { name: "本次商品" } }).runPreproduction({ projectId: "P1", intent: "营销", isMarketing: true, metadata });
    expect(studioMocks.create).toHaveBeenCalledWith("营销", { brief: metadata.brief, dataMining: { name: "本次商品" } }, expect.objectContaining({ dataMiningRaw: JSON.parse(rawJson), dataMiningRefresh: true, skipDataMiningReview: true }));
    expect(metadata._dataDossier.name).toBe("伪造档案");
  });
});
