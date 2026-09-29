import { describe, expect, it } from "vitest";
import { accessAuthorityDeps } from "../service/access-authority.js";
import { appRouter } from "./router.js";

describe("三端访问权威路由面", () => {
  it("挂载 access.me，且匿名请求失败关闭", async () => {
    const caller = appRouter.createCaller({
      session: null,
      identity: null,
      partnerIdentity: null,
      headers: new Headers(),
    });

    await expect(caller.access.me()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("挂载首次欢迎三端点，游客首屏明确进入欢迎流程", async () => {
    const guest = {
      kind: "member" as const,
      memberId: "guest",
      memberNo: "GUEST",
      name: "游客",
      role: "readonly" as const,
      tenantId: "tenant-preview",
      workspaceId: "ws-preview",
      plan: "community" as const,
    };
    const originalLoadMemberFacts = accessAuthorityDeps.loadMemberFacts;
    accessAuthorityDeps.loadMemberFacts = async () => ({ ...guest, permissions: {} });
    try {
      const caller = appRouter.createCaller({
        session: guest,
        identity: guest,
        partnerIdentity: null,
        headers: new Headers(),
      });

      await expect(caller.onboarding.welcomeStatus()).resolves.toMatchObject({
        persisted: false,
        status: "not_started",
        currentStep: "start",
        shouldShow: true,
        role: "readonly",
      });
      expect(caller.onboarding.saveWelcomeProgress).toBeTypeOf("function");
      expect(caller.onboarding.replayWelcome).toBeTypeOf("function");
    } finally {
      accessAuthorityDeps.loadMemberFacts = originalLoadMemberFacts;
    }
  });

  /**
   * 回归守卫（T-2026-0925-0007）：`fence.activeRules` 是 dsh 围栏插件的数据源
   * （`packages/runtime/plugins/workloom-fence.plugin.js` 直接 fetch 该路径）。
   * 端点缺失时 tRPC 返回 404，插件把错误体当数组遍历 → 工具执行流水线整体不可用
   * （隔离副本 2026-09-24 P 域实测过这一故障，随后被一次移植覆盖再次丢失）。此处只守"端点必须挂载"。
   */
  it("挂载围栏数据源端点 fence.activeRules（dsh 围栏插件依赖）", () => {
    const caller = appRouter.createCaller({
      session: null,
      identity: null,
      partnerIdentity: null,
      headers: new Headers(),
    });
    expect(typeof caller.fence.activeRules).toBe("function");
  });
});
