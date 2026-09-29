// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const fakeTrpc = vi.hoisted(() => ({
  access: { me: { query: vi.fn() } },
  accounts: { auth: { guestEnter: { mutate: vi.fn() } } },
  auth: { loginAs: { mutate: vi.fn() } },
}));

vi.mock("@trpc/client", () => ({
  createTRPCClient: vi.fn(() => fakeTrpc),
  httpBatchLink: vi.fn(() => ({})),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function loadSessionModule() {
  vi.resetModules();
  return import("./trpc");
}

beforeEach(() => {
  localStorage.clear();
  fakeTrpc.access.me.query.mockReset();
  fakeTrpc.accounts.auth.guestEnter.mutate.mockReset();
  fakeTrpc.auth.loginAs.mutate.mockReset();
});

describe("身份策略：只允许店主（正式身份）登录（2026-09-21 取消游客进入）", () => {
  it("ensureGuestSession（历史别名）不再签发游客，而是以店主登录", async () => {
    const session = await loadSessionModule();
    fakeTrpc.auth.loginAs.mutate.mockResolvedValueOnce({ token: "mock-owner-token" });

    await session.ensureGuestSession();

    expect(fakeTrpc.accounts.auth.guestEnter.mutate).not.toHaveBeenCalled();
    expect(fakeTrpc.auth.loginAs.mutate).toHaveBeenCalledTimes(1);
    expect(session.getToken()).toBe("mock-owner-token");
  });

  it("旧令牌失效后自动以店主身份重新登录（不会停留在无权限态）", async () => {
    const session = await loadSessionModule();
    session.setToken("expired-token");
    fakeTrpc.access.me.query.mockRejectedValueOnce(new Error("token expired"));
    fakeTrpc.auth.loginAs.mutate.mockResolvedValueOnce({ token: "mock-owner-token" });

    await session.ensureDemoLogin();

    expect(fakeTrpc.access.me.query).toHaveBeenCalled();
    expect(fakeTrpc.auth.loginAs.mutate).toHaveBeenCalledTimes(1);
    expect(session.getToken()).toBe("mock-owner-token");
    expect(session.isGuest()).toBe(false);
  });

  it("并发登录只保留最后一次身份（epoch 语义）", async () => {
    const session = await loadSessionModule();
    const first = deferred<{ token: string }>();
    const second = deferred<{ token: string }>();
    fakeTrpc.auth.loginAs.mutate.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const a = session.ensureDemoLogin("MEM-G01");
    const b = session.ensureDemoLogin("MEM-G02");
    await vi.waitFor(() => expect(fakeTrpc.auth.loginAs.mutate).toHaveBeenCalledTimes(2));

    first.resolve({ token: "mock-first-token" });
    second.resolve({ token: "mock-second-token" });
    await Promise.all([a, b]);

    expect(session.getToken()).toBe("mock-second-token");
  });

  it("正式令牌写入会清除既有游客标记", async () => {
    const session = await loadSessionModule();
    localStorage.setItem("workloom:workloom-im:b-pc:access-token", "mock-guest-token");
    localStorage.setItem("workloom:workloom-im:b-pc:guest", "1");
    fakeTrpc.auth.loginAs.mutate.mockResolvedValueOnce({ token: "mock-formal-token" });

    await session.ensureDemoLogin("MEM-001");

    expect(session.getToken()).toBe("mock-formal-token");
    expect(session.isGuest()).toBe(false);
  });
});
