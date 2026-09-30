import { describe, expect, it } from "vitest";
import { appendPlatformGuidance, explicitPlatformFromMetadata, resolvePlatformForIntent } from "./platform-routing.js";

describe("服务端目标平台识别", () => {
  it("需求未指定平台时落默认抖音口径，并写回元数据供下游使用", () => {
    const routed = resolvePlatformForIntent("给我们的获客系统做一条讲解视频", { brief: { goal: "讲清闭环" } });
    expect(routed.decision).toMatchObject({ id: "douyin", source: "default", aspectRatio: "9:16" });
    expect(routed.metadata).toMatchObject({ platform: "douyin" });
    expect((routed.metadata.platformSelection as { id: string }).id).toBe("douyin");
    /** 原 metadata 的其它字段不能被丢掉（分流器写入的商品信息要原样保留）。 */
    expect(routed.metadata.brief).toEqual({ goal: "讲清闭环" });
  });

  it("需求文本命中平台时切到该平台，画幅随之切换", () => {
    const routed = resolvePlatformForIntent("做一条小红书种草视频");
    expect(routed.decision).toMatchObject({ id: "xiaohongshu", source: "text", aspectRatio: "3:4" });
  });

  it("显式来源优先：调用方参数 > metadata.platform > metadata.coverPlatform > brief.platform", () => {
    expect(explicitPlatformFromMetadata({ platform: "抖音", coverPlatform: "小红书", brief: { platform: "B站" } })).toBe("抖音");
    expect(explicitPlatformFromMetadata({ coverPlatform: "小红书", brief: { platform: "B站" } })).toBe("小红书");
    expect(explicitPlatformFromMetadata({ brief: { platform: "B站" } })).toBe("B站");
    expect(explicitPlatformFromMetadata({})).toBe("");
    expect(explicitPlatformFromMetadata(null)).toBe("");
    const routed = resolvePlatformForIntent("发到抖音", { platform: "视频号" }, "小红书");
    expect(routed.decision).toMatchObject({ id: "xiaohongshu", source: "explicit" });
  });

  it("口径块追加在需求正文之后，含画幅/钩子窗口/目标与上限语速", () => {
    const routed = resolvePlatformForIntent("拍一条抖音口播片");
    const intent = appendPlatformGuidance("客户的创作需求", routed.decision);
    expect(intent.startsWith("客户的创作需求")).toBe(true);
    expect(intent).toContain("[平台制作口径 douyin·抖音]");
    expect(intent).toContain("画幅 9:16");
    expect(intent).toContain("前 3 秒");
    expect(intent).toContain("目标 4.8 字/秒、上限 5.6 字/秒");
  });

  it("长视频平台走 5 秒钩子窗口与 3.5 字/秒档，与既有全局口径一致", () => {
    const routed = resolvePlatformForIntent("做一条 B站长视频");
    const intent = appendPlatformGuidance("需求", routed.decision);
    expect(intent).toContain("[平台制作口径 bilibili·B站（哔哩哔哩）]");
    expect(intent).toContain("前 5 秒");
    expect(intent).toContain("目标 3.5 字/秒、上限 4.2 字/秒");
  });
});
