import { describe, expect, it } from "vitest";
import { ruleBasedRoute } from "./intent.js";

/**
 * 意图路由回归用例（2026-09-21 真机事故固化为门禁）。
 *
 * 事故：产品所有者对 AI 助手说「介绍下你自己」，系统把它当成交付型指令（Quest）——
 * 建了线程、跑了规划器，还把内部步骤挂成「待您拍板」。这是两条缺陷叠加：
 *   ① 自我介绍类问句落到默认分支（本文件覆盖）；
 *   ② 内部协作动作因围栏对象类型未登记而兜底成人审（见 bundles/geo-growth/fences）。
 * 下面这些断言就是"再犯即红"的那道闸。
 */
describe("规则兜底意图路由", () => {
  it("自我介绍/身份/能力类问句一律 ask（不立项、不产生人审）", () => {
    const cases = [
      "介绍下你自己",
      "介绍一下你自己",
      "自我介绍",
      "你是谁",
      "你能做什么",
      "你会干啥",
      "你有什么能力",
      "你是什么助手",
    ];
    for (const text of cases) {
      const result = ruleBasedRoute(text);
      expect(result.kind, text).toBe("routed");
      expect(result.mode, text).toBe("ask");
      expect(result.via, text).toBe("rule");
    }
  });

  it("交付型指令仍然走 Quest（不要为了修自我介绍把任务误判成问答）", () => {
    for (const text of ["整理本周GEO内容选题", "把本周选题做成一集短片", "排期发布并核验版权"]) {
      const result = ruleBasedRoute(text);
      expect(result.kind, text).toBe("routed");
      expect(result.mode, text).toBe("quest");
    }
  });

  it("查询/问答类仍走 ask，含糊指令仍反问澄清", () => {
    expect(ruleBasedRoute("今天有多少询盘？").mode).toBe("ask");
    expect(ruleBasedRoute("帮我看看").kind).toBe("clarify");
  });
});
