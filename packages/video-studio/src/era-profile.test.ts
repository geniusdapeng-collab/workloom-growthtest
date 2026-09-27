import { describe, expect, it } from "vitest";
import { ERA_PROFILE_VERSION, eraProfilePromptLines, isIsoStoryDate, resolveEraProfile, validateEraProfile } from "./era-profile.js";

describe("冻结故事年代", () => {
  it("仅从显式日期与策略构造不可变合同，不隐式采用系统当前时间", () => {
    const resolved = resolveEraProfile({ storyDate: "2012-04-03" });
    expect(resolved).toEqual({ schemaVersion: ERA_PROFILE_VERSION, storyDate: "2012-04-03", devicePolicy: "story-compatible" });
    expect(Object.isFrozen(resolved)).toBe(true);
  });
  it("镜头可显式声明闪回，局部profile不与继承profile拼接", () => {
    expect(resolveEraProfile(undefined, { storyDate: "2026-09-28", devicePolicy: "apple-2024plus" }).devicePolicy).toBe("apple-2024plus");
    expect(resolveEraProfile({ storyDate: "2022-04-01" }, { storyDate: "2026-09-28", devicePolicy: "apple-2024plus" }))
      .toMatchObject({ storyDate: "2022-04-01", devicePolicy: "story-compatible" });
  });
  it.each([undefined, null, "2026", [], {}, { storyDate: "today" }, { storyDate: "latest" }, { storyDate: 2024 }, { storyDate: "2024-01-01", devicePolicy: "all-apple" }, { storyDate: "2024-01-01", storyYear: 2026 }, { storyDate: "2024-01-01", schemaVersion: "unknown" }])("缺失或非法合同保持未验证：%j", (value) => {
    expect(() => resolveEraProfile(value)).toThrow();
    try { resolveEraProfile(value); } catch (error) { expect(error).toMatchObject({ status: "unverified" }); }
  });
  it.each(["2024-02-29", "2000-02-29", "2026-12-31", "1000-01-01", "9999-12-31"])("接受真实日期 %s", (value) => expect(isIsoStoryDate(value)).toBe(true));
  it.each(["2023-02-29", "1900-02-29", "2026-04-31", "2026-00-01", "2026-13-01", "2026-01-00", "2026-1-1", "0000-01-01", "2026-01-01T00:00:00Z", "2026-01-01 "])("拒绝被Date自动归一的非法日期 %s", (value) => expect(isIsoStoryDate(value)).toBe(false));
  it("提示词包含冻结日期和显式profile；没有合同不编造年代", () => {
    expect(eraProfilePromptLines()).toEqual([]);
    expect(eraProfilePromptLines({ storyDate: "2026-09-28", devicePolicy: "apple-2024plus" }).join("\n")).toContain("2024-01-01");
    expect(eraProfilePromptLines({ storyDate: "2022-04-01" }).join("\n")).toContain("2022-04-01");
    expect(validateEraProfile({ storyDate: "2022-04-01" })).toEqual([]);
  });
});
