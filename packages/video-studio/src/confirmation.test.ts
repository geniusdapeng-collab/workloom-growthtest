import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { autoApproveHandler, runWithConfirmationHandler } from "./confirmation.js";
import type { GateRequest, GateVerdict } from "./gates.js";

const req: GateRequest = { type: "prd", content: "# 项目审批\n特殊字符：<>&", runId: "run-1" };
const confirm = (input: GateRequest = req) => {
  const bridge = globalThis.__HR_CONFIRMATION_HANDLER__;
  if (!bridge) throw new Error("confirmation bridge not installed");
  return bridge(input);
};
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("运行作用域确认桥", () => {
  it("确认入口收到当前运行裁决并原样传递请求", async () => {
    const handler = vi.fn(async (): Promise<GateVerdict> => ({
      approved: false, reason: "需改镜头", suggestions: ["补环境细节"]
    }));
    const verdict = await runWithConfirmationHandler(handler, confirm);
    expect(verdict).toMatchObject({ approved: false, reason: "需改镜头", suggestions: ["补环境细节"] });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining(req));
  });

  it("调用方与运行外的请求均明确拒绝", async () => {
    const hold = deferred();
    const handler = vi.fn(autoApproveHandler());
    const pending = runWithConfirmationHandler(handler, async () => { await hold.promise; });
    const outside = await confirm();
    expect(outside).toMatchObject({ approved: false, fatal: "confirmation-scope-missing" });
    hold.resolve();
    await pending;
    expect(await confirm()).toMatchObject({ approved: false, fatal: "confirmation-scope-missing" });
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(["first", "second"])("并发运行交错审批，%s 先结束不拆除另一个的桥", async (finishFirst) => {
    const releases = [deferred(), deferred()];
    const ready = [deferred(), deferred()];
    const handlers = ["A", "B"].map((reason) => vi.fn(async () => ({ approved: true, reason })));
    const run = (i: number) => runWithConfirmationHandler(handlers[i]!, async () => {
      ready[i]!.resolve();
      await releases[i]!.promise;
      const a = await confirm({ ...req, runId: `run-${i}` });
      await new Promise<void>((done) => setImmediate(done));
      const b = await confirm({ ...req, runId: `run-${i}` });
      return [a.reason, b.reason];
    });
    const running = [run(0), run(1)];
    await Promise.all(ready.map((r) => r.promise));
    const bridge = globalThis.__HR_CONFIRMATION_HANDLER__;
    const order = finishFirst === "first" ? [0, 1] : [1, 0];
    for (const i of order) {
      releases[i]!.resolve();
      expect(await running[i]).toEqual(i === 0 ? ["A", "A"] : ["B", "B"]);
      expect(globalThis.__HR_CONFIRMATION_HANDLER__).toBe(bridge);
    }
    handlers.forEach((handler, i) => {
      expect(handler).toHaveBeenCalledTimes(2);
      for (const [request] of handler.mock.calls as unknown as [GateRequest][]) {
        expect(request.runId).toBe(`run-${i}`);
      }
    });
  });

  it("嵌套运行结束后恢复父运行，子运行失败也不泄漏", async () => {
    const outer = vi.fn(async () => ({ approved: true, reason: "outer" }));
    const inner = vi.fn(async () => ({ approved: true, reason: "inner" }));
    await runWithConfirmationHandler(outer, async () => {
      expect((await confirm()).reason).toBe("outer");
      await expect(runWithConfirmationHandler(inner, async () => {
        expect((await confirm()).reason).toBe("inner");
        throw new Error("inner failed");
      })).rejects.toThrow("inner failed");
      expect((await confirm()).reason).toBe("outer");
    });
    expect(outer).toHaveBeenCalledTimes(2);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it.each(["sync", "async"])("%s 回调抛错后结束作用域并保留原始异常", async (mode) => {
    const failure = new Error("run failed");
    const callback = mode === "sync" ? () => { throw failure; } : async () => { throw failure; };
    await expect(runWithConfirmationHandler(autoApproveHandler(), callback)).rejects.toBe(failure);
    expect(await confirm()).toMatchObject({ approved: false, fatal: "confirmation-scope-missing" });
  });

  it("审批处理器抛错直接上抛，不变成批准", async () => {
    const failure = new Error("approval unavailable");
    await expect(runWithConfirmationHandler(async () => { throw failure; }, confirm)).rejects.toBe(failure);
  });

  it("运行结束后其遗留异步子任务不能再申请审批", async () => {
    const release = deferred();
    const handler = vi.fn(autoApproveHandler());
    let late!: Promise<GateVerdict>;
    await runWithConfirmationHandler(handler, () => {
      late = release.promise.then(() => confirm());
    });
    release.resolve();
    expect(await late).toMatchObject({ approved: false, fatal: "confirmation-scope-closed" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("已经发出但在运行结束后才返回的批准失效", async () => {
    const release = deferred<GateVerdict>();
    const handler = vi.fn(() => release.promise);
    let late!: Promise<GateVerdict>;
    await runWithConfirmationHandler(handler, () => { late = confirm(); });
    release.resolve({ approved: true });
    expect(await late).toMatchObject({ approved: false, fatal: "confirmation-scope-closed" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("审批前已取消则不调用处理器，等待途中取消则拒绝返回的批准", async () => {
    let cancelled = true;
    const handler = vi.fn(async () => { cancelled = true; return { approved: true }; });
    const input = { ...req, shouldAbort: () => cancelled };
    await runWithConfirmationHandler(handler, async () => {
      expect(await confirm(input)).toMatchObject({ approved: false, fatal: "confirmation-aborted" });
      expect(handler).not.toHaveBeenCalled();
      cancelled = false;
      expect(await confirm(input)).toMatchObject({ approved: false, fatal: "confirmation-aborted" });
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  it("发现未知全局处理器时拒绝启动，不覆盖其他宿主", async () => {
    await runWithConfirmationHandler(autoApproveHandler(), () => undefined);
    const dispatcher = globalThis.__HR_CONFIRMATION_HANDLER__;
    const other = autoApproveHandler();
    globalThis.__HR_CONFIRMATION_HANDLER__ = other;
    const body = vi.fn();
    try {
      await expect(runWithConfirmationHandler(autoApproveHandler(), body)).rejects.toThrow("confirmation-dispatcher-conflict");
      expect(body).not.toHaveBeenCalled();
      expect(globalThis.__HR_CONFIRMATION_HANDLER__).toBe(other);
    } finally {
      globalThis.__HR_CONFIRMATION_HANDLER__ = dispatcher;
    }
  });

  it("生产同款 tsx 运行时通过真实 vendor waiter：作用域内审批、作用域外拒绝", () => {
    // vendor/scripts 是 CJS 且没有包边界；与生产一样由 tsx 加载，避免 vitest 的 ESM 转换。
    const script = `
      import assert from "node:assert/strict";
      import { createRequire } from "node:module";
      import { runWithConfirmationHandler } from "./packages/video-studio/src/confirmation.ts";
      const require = createRequire(import.meta.url);
      const { waitForExternalConfirmation } = require("./vendor/supermickey/scripts/confirmation-waiter.js");
      const request = { type: "prd", content: "真实 vendor 桥", runId: "vendor-run", log: () => {} };
      const seen = [];
      const inside = await runWithConfirmationHandler(async (req) => {
        seen.push(req);
        return { approved: true, reason: "scope-approved", suggestions: [] };
      }, () => waitForExternalConfirmation(request));
      assert.equal(inside.approved, true);
      assert.equal(inside.reason, "scope-approved");
      assert.equal(seen[0].runId, "vendor-run");
      const outside = await waitForExternalConfirmation(request);
      assert.equal(outside.approved, false);
      assert.equal(outside.fatal, "confirmation-scope-missing");
      assert.equal(seen.length, 1);
      console.log("VENDOR_SCOPE_OK");
    `;
    const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)), encoding: "utf8", timeout: 30_000
    });
    expect(output.trim().split("\n").pop()).toBe("VENDOR_SCOPE_OK");
  }, 35_000);
});
