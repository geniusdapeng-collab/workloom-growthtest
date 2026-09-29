import { describe, expect, it } from "vitest";
import { appendScenePolicyGuidance, resolveScenePolicyForIntent, ScenePolicyRouteError } from "./scene-policy-routing.js";

describe("原始视频需求的服务端片型选用", () => {
  it("从原始意图和嵌套 brief 命中 T1，并只记录命中词与来源", () => {
    const selected = resolveScenePolicyForIntent("给企业负责人拍一条销售演示，陈卓出镜口播", {
      brief: { request: { format: "正式商务短片", audience: "企业负责人" } },
    });
    expect(selected.decision).toMatchObject({ id: "commercial-person", version: expect.any(String), sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(selected.decision.evidence).toContain("brief.request.format: 正式商务短片");
    expect(selected.metadata.scenePolicy).toMatchObject({ id: "commercial-person" });
    expect(appendScenePolicyGuidance("客户的创作需求", selected.policy)).toContain("[片型制作规范 commercial-person@");
  });

  it("无关题材在当前只安装 T1 时保持无片型，显式未知或畸形 ID 则拒绝", () => {
    const unrelated = resolveScenePolicyForIntent("拍一条山间日出风景片");
    expect(unrelated.decision).toMatchObject({ id: null, evidence: [] });
    expect(appendScenePolicyGuidance("原意图", unrelated.policy)).toBe("原意图");
    expect(() => resolveScenePolicyForIntent("山间风景片", { scenePolicy: { id: "missing" } }))
      .toThrow(ScenePolicyRouteError);
    expect(() => resolveScenePolicyForIntent("山间风景片", { scenePolicy: { id: "missing" } }))
      .toThrow(/未知片型/);
    expect(() => resolveScenePolicyForIntent("山间风景片", { scenePolicy: { id: null } }))
      .toThrow(/必须是非空片型 ID/);
  });

  it("显式 T1 在信号不足时仍生效，客户原始 metadata 不被就地修改", () => {
    const metadata = { brief: { goal: "一条片子" }, scenePolicy: { id: "commercial-person", exceptions: [] } };
    const selected = resolveScenePolicyForIntent("一条片子", metadata);
    expect(selected.decision).toMatchObject({ id: "commercial-person", reason: "显式片型 commercial-person" });
    expect(metadata.scenePolicy).toEqual({ id: "commercial-person", exceptions: [] });
    expect(selected.metadata.scenePolicy).toMatchObject({ id: "commercial-person", exceptions: [] });
  });

  it("适用类别已有原始线索但知识条目未安装时阻断，不能当作无政策", () => {
    expect(() => resolveScenePolicyForIntent("做一条母婴亲子短片，记录宝宝第一次走路"))
      .toThrow(/没有可核实的已安装片型知识条目/);
  });
});
