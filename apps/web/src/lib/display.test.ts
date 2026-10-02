import { describe, expect, it } from "vitest";
import { actionText, actorText, approvalGestureText, chineseDisplayName, hydrateDisplayTerminology, payloadText, skillDisplayName, versionText } from "./display";

describe("技能中文展示名（不向客户端裸奔技术串）", () => {
  it("技能说明首段即中文名", () => {
    expect(skillDisplayName("checkin-checkout", "入住退房全流程套件。覆盖到店/离店…")).toBe("入住退房全流程套件");
  });

  it("首段夹带技术记号时剔除记号再取中文名", () => {
    expect(skillDisplayName("comment-ops", "评论三级分流 SOP 官方套件（随 bundles/ai-video 分发）：…")).toBe("评论三级分流 官方套件");
    expect(skillDisplayName("publish-ops", "全平台 RPA 发布纪律官方套件（随 bundles/ai-video 分发）：…")).toBe("全平台 发布纪律官方套件");
    // 破折号左边就是名字，右边是解释：取「线索管家」，不再把整句当名字
    expect(skillDisplayName("lead-concierge", "线索管家——四路承接应答留资 SOP。…")).toBe("线索管家");
  });

  it("技术串剔除后为空时回落下一个分隔符或原始 id", () => {
    // 首段本身就是纯技术串（SOP/RPA/Brief/query/Y…）时，剔除后没剩中文 → 回落原 id，不硬造词
    expect(skillDisplayName("sop-only", "SOP（随包分发）：…")).toBe("sop-only");
    expect(skillDisplayName("query-skill", "query：…")).toBe("query-skill");
  });

  it("破折号也当名字结束符（无句号/冒号的长说明不再裸奔英文 id）", () => {
    expect(skillDisplayName("coupon-ops", "团购券运营——通兑券/预售券 SKU 设计、库存熔断、定价红线…")).toBe("团购券运营");
    expect(skillDisplayName("intent-radar", "意图雷达——竞对评论区/OTA差评/query 搜索词…")).toBe("意图雷达");
    expect(skillDisplayName("hotel-geo-content", "酒店 GEO 内容——AI 答案版探店图文创作：「XX市XX酒店怎么选」类 query…")).toBe("酒店 GEO 内容");
  });

  it("词典认可的行业词保留原样（GEO 不被误剔）", () => {
    expect(skillDisplayName("ai-answer-rewrite", "GEO 六段式改写官方套件（随 bundles/geo-growth 分发）：…")).toBe("GEO 六段式改写官方套件");
  });

  it("通栏装载事件名剔除拉丁记号，无法中文化才回落中性兜底", () => {
    expect(chineseDisplayName("Y 域分发技能", "技能能力")).toBe("域分发技能");
    expect(chineseDisplayName("comment-ops", "技能能力")).toBe("技能能力");
    expect(chineseDisplayName("", "技能能力")).toBe("技能能力");
  });
});

describe("客户端版本文案", () => {
  it("只展示人类可读版本序号", () => {
    expect(versionText("v3")).toBe("第 3 版");
    expect(versionText("hotel-baseline/v1.5")).toBe("第 1.5 版");
  });

  it("不会释放内部包名或哈希", () => {
    expect(versionText("bundle_internal_sha")).toBe("版本已记录");
    expect(versionText("版本 workspace_id")).toBe("版本已记录");
    expect(versionText("版本 InternalServerError")).toBe("版本已记录");
    expect(versionText(undefined)).toBe("版本待确认");
  });
});

describe("行业术语投影", () => {
  it("只从当前 Bundle 投影读取岗位、动作和字段显示名", () => {
    hydrateDisplayTerminology({
      "actor.industry-worker": "行业执行官",
      "action.domain.process": "办理行业事项",
      "field.domain_metric": "行业指标",
    });
    expect(actorText("industry-worker")).toBe("行业执行官");
    expect(actionText("domain.process")).toBe("办理行业事项");
    expect(payloadText({ domain_metric: 8 })).toContain("行业指标：8");
    hydrateDisplayTerminology({});
  });

  it("未知代码只显示通用中文兜底", () => {
    hydrateDisplayTerminology({ "action.private.machine_code": "办理 private_field" });
    expect(actorText("private-worker-id")).toBe("系统成员");
    expect(actorText("成员 workspace_id")).toBe("系统成员");
    expect(actorText("MEM-12345")).toBe("系统成员");
    expect(actionText("private.machine_code")).toBe("系统操作");
    expect(payloadText({ private_field: "raw_machine_value" })).toBe("补充信息：信息待确认");
  });
});

describe("业务关卡放行手势文案", () => {
  it("只展示受控字典文案，不直出手势码", () => {
    expect(approvalGestureText("approve")).toBe("已放行");
    expect(approvalGestureText("edit")).toBe("改后放行");
    expect(approvalGestureText("reject")).toBe("已退回");
    expect(approvalGestureText("private_gesture")).toBe("关卡已处理");
  });
});
