// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWelcomeProgress, type WelcomeState } from "./useWelcomeProgress";

const fake = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock("../lib/trpc", () => ({ trpc: { onboarding: { saveWelcomeProgress: { mutate: fake.save } } } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const initial: WelcomeState = { status: "not_started", currentStep: "start", journeyVersion: 1, replayCount: 0, shouldShow: true, persisted: false, role: "owner" };
const completed = { ...initial, status: "completed" as const, currentStep: "done" as const, shouldShow: false, persisted: true };

describe("欢迎旅程请求的页面归属", () => {
  let host: HTMLDivElement;
  let root: Root | null;
  let api: ReturnType<typeof useWelcomeProgress>;
  const visibility = vi.fn();
  const error = vi.fn();
  function Probe() {
    api = useWelcomeProgress({ onVisibilityChange: visibility, onError: error });
    return <span data-status={api.welcome?.status} />;
  }
  beforeEach(async () => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    fake.save.mockReset(); visibility.mockClear(); error.mockClear();
    host = document.createElement("div"); document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<Probe />); });
    await act(async () => { api.initialize(initial); });
    visibility.mockClear();
  });
  afterEach(async () => {
    await act(async () => { root?.unmount(); root = null; });
    host.remove();
  });

  it("完成响应后迟到的进度响应不能回退状态或重新显示仪式", async () => {
    const old = deferred<WelcomeState>(); const done = deferred<WelcomeState>();
    fake.save.mockReturnValueOnce(old.promise).mockReturnValueOnce(done.promise);
    let first!: Promise<void>; let second!: Promise<void>;
    await act(async () => { first = api.save("in_progress", "team"); second = api.save("completed", "done"); });
    await act(async () => { done.resolve(completed); await second; });
    expect(api.welcome).toMatchObject({ status: "completed", currentStep: "done", role: "owner" });
    await act(async () => { old.resolve({ ...initial, status: "in_progress", currentStep: "team" }); await first; });
    expect(api.welcome?.status).toBe("completed");
    expect(visibility.mock.calls).toEqual([[false]]);
  });

  it("用户离开后仍在运行的阶段计时器不能再发送旧阶段", async () => {
    const done = deferred<WelcomeState>(); fake.save.mockReturnValue(done.promise);
    let request!: Promise<void>;
    await act(async () => { request = api.save("completed", "done"); await api.save("in_progress", "summary"); await api.save("completed", "done"); });
    expect(fake.save).toHaveBeenCalledTimes(1);
    await act(async () => { done.resolve(completed); await request; await api.save("in_progress", "mate"); });
    expect(fake.save).toHaveBeenCalledTimes(1);
    expect(api.welcome?.status).toBe("completed");
  });

  it("保存失败明确提示且允许重试，不伪造已保存完成", async () => {
    fake.save.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(completed);
    await act(async () => { await api.save("completed", "done"); });
    expect(api.welcome?.status).toBe("not_started");
    expect(error).toHaveBeenCalledWith("欢迎引导进度暂时无法保存，请稍后重试。");
    await act(async () => { await api.save("completed", "done"); });
    expect(api.welcome?.status).toBe("completed");
    expect(fake.save).toHaveBeenCalledTimes(2);
  });

  it("普通进度与稍后继续仍可保存；组件卸载后响应不回写页面", async () => {
    fake.save.mockResolvedValueOnce({ ...initial, status: "in_progress", currentStep: "team", persisted: true });
    await act(async () => { await api.save("in_progress", "team"); });
    expect(api.welcome?.currentStep).toBe("team");
    const paused = deferred<WelcomeState>(); fake.save.mockReturnValueOnce(paused.promise);
    let request!: Promise<void>;
    await act(async () => { request = api.save("paused", "team"); root!.unmount(); root = null; });
    await act(async () => { paused.resolve({ ...initial, status: "paused", currentStep: "team" }); await request; });
    expect(visibility).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
