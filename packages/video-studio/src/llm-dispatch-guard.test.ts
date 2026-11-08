import { describe, expect, it, vi } from "vitest";
import { WorkloomLLMEngine } from "./llm-adapter.js";

describe("WorkloomLLMEngine dispatch guard", () => {
  it("stops every guarded request before provider transport", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const engine = new WorkloomLLMEngine({
      baseUrl: "https://guard.example.invalid/v1",
      apiKey: "fixture-only",
      model: "deepseek-flash",
      fetchImpl,
    });
    await expect(engine.withDispatchGuard(
      () => { throw new Error("PROMPT_REPAIR_BUDGET_EXHAUSTED: test"); },
      () => engine.reason("must not dispatch", {}),
    )).rejects.toThrow("PROMPT_REPAIR_BUDGET_EXHAUSTED");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps the guard scoped to one asynchronous repair run", async () => {
    const guard = vi.fn();
    const engine = new WorkloomLLMEngine({
      baseUrl: "https://guard.example.invalid/v1",
      apiKey: "fixture-only",
      model: "deepseek-flash",
      fetchImpl: vi.fn<typeof fetch>(),
    });
    await engine.withDispatchGuard(guard, async () => guard());
    expect(guard).toHaveBeenCalledTimes(1);
  });
});
