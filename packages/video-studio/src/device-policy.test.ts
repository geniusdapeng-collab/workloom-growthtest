import { describe, expect, it } from "vitest";
import {
  DEVICE_ALLOWLIST, DEVICE_POLICY_VERIFIED_AT, allowedModelSummary, deviceDefects,
  devicePolicyPromptLines, devicePolicyStatus, findDeviceModel, isAllowedDeviceModel,
  isSoftAllowedDeviceModel, summarizeDeviceDefects, type DeviceShotFields,
} from "./device-policy.js";

const era = { storyDate: "2026-09-28", devicePolicy: "story-compatible" as const };
const apple = { ...era, devicePolicy: "apple-2024plus" as const };
const tablet: DeviceShotFields = {
  shotId: "PAD", scene: "桌上放着一台 iPad Pro", props: "iPad Pro（M4 世代）",
  eraProfile: era, devices: [{ category: "tablet", model: "iPad Pro M4", role: "演示报表", placement: "支架承重，屏幕朝向观众" }],
};

describe("设备年代目录", () => {
  it("九类设备均有精确世代、公开可核的历史来源与上市日期", () => {
    expect(new Set(DEVICE_ALLOWLIST.map((entry) => entry.category)).size).toBe(9);
    expect(DEVICE_POLICY_VERIFIED_AT).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const entry of DEVICE_ALLOWLIST) {
      expect(entry.generation.length).toBeGreaterThan(2);
      expect(entry.availableFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.source).toMatch(/^https:\/\/(www\.apple\.com|news\.samsung\.com)\//);
      expect(Object.isFrozen(entry)).toBe(true);
    }
  });
  it("型号精确匹配，不以包含关系接受旧世代或虚构后缀", () => {
    for (const model of ["MacBook Pro M4", "macbook pro (m4, 2024)", "iPad Pro（M4 世代）", "iPhone 16", "Galaxy S24"]) expect(isAllowedDeviceModel(model), model).toBe(true);
    for (const model of ["MacBook Pro", "MacBook Pro 2012", "iPad Pro 2010", "MacBook Pro M4 2012", "iPhone 160", "iPhone 16 Fake", "Apple Watch", "AirPods", "Studio Display XDR", "笔记本电脑"]) expect(isAllowedDeviceModel(model), model).toBe(false);
    expect(findDeviceModel("Samsung Galaxy S24")?.brand).toBe("Samsung");
    expect(isSoftAllowedDeviceModel("Studio Display (2022)")).toBe(false);
  });
  it("建议列表只返回指定类别、故事日期与profile都允许的型号", () => {
    expect(allowedModelSummary("laptop")).toContain("MacBook Pro (M4, 2024)");
    expect(allowedModelSummary("phone", { schemaVersion: "workloom.era-profile/v1", ...apple })).not.toContain("Samsung");
    expect(allowedModelSummary("display", { schemaVersion: "workloom.era-profile/v1", ...apple })).toContain("没有匹配机型");
    expect(allowedModelSummary("phone", { schemaVersion: "workloom.era-profile/v1", storyDate: "2024-02-01", devicePolicy: "story-compatible" })).toContain("Samsung");
  });
});

describe("逐镜年代、类别、品牌合同", () => {
  it("具体型号与冻结年代合法才通过，并真实进入提示词", () => {
    expect(deviceDefects([tablet])).toEqual([]);
    expect(devicePolicyStatus([tablet])).toBe("passed");
    const prompt = devicePolicyPromptLines(tablet).join("\n");
    expect(prompt).toContain("iPad Pro M4");
    expect(prompt).toContain("2026-09-28");
    expect(prompt).toContain("屏幕朝向观众");
    expect(prompt).not.toContain("全部使用");
  });
  it("未提供故事日期不回退到今天，文件输出也不能伪过", () => {
    const shot = { ...tablet, eraProfile: undefined };
    expect(deviceDefects([shot])).toEqual(expect.arrayContaining([expect.objectContaining({ rule: "device-era", status: "unverified", hard: true })]));
    expect(devicePolicyStatus([shot])).toBe("unverified");
    expect(() => devicePolicyPromptLines(shot)).toThrow(/冻结/);
    expect(deviceDefects([shot], { eraProfile: era })).toEqual([]);
  });
  it("日期按日核验：发布公告不等于上市，前一日失败当日通过", () => {
    const phone = { ...tablet, scene: "iPhone 16 手机", props: "", devices: [{ category: "phone" as const, model: "iPhone 16" }] };
    expect(devicePolicyStatus([{ ...phone, eraProfile: { storyDate: "2024-09-19" } }])).toBe("failed");
    expect(deviceDefects([{ ...phone, eraProfile: { storyDate: "2024-09-20" } }])).toEqual([]);
    expect(deviceDefects([{ ...tablet, eraProfile: { storyDate: "2012-01-01" } }]).some((entry) => entry.rule === "device-era" && entry.status === "failed")).toBe(true);
  });
  it("类别必须匹配目录，声明了手机不能补齐未声明电脑和显示器", () => {
    const wrong = { ...tablet, devices: [{ category: "phone" as const, model: "iPad Pro M4" }] };
    expect(deviceDefects([wrong]).map((entry) => entry.rule)).toEqual(expect.arrayContaining(["device-category", "device-declaration"]));
    const partial = { ...tablet, scene: "手机旁边是笔记本电脑与显示器", props: "", devices: [{ category: "phone" as const, model: "iPhone 16" }] };
    const missing = deviceDefects([partial]).filter((entry) => entry.rule === "device-declaration");
    expect(missing).toHaveLength(2);
    expect(missing.map((entry) => entry.detail).join(" ")).toMatch(/笔记本电脑.*显示器/);
  });
  it("其他品牌由明确profile判：故事相容可用，apple-2024plus拒绝", () => {
    const samsung = { shotId: "SAMSUNG", scene: "Samsung Galaxy S24 手机", eraProfile: era, devices: [{ category: "phone" as const, model: "Samsung Galaxy S24" }] };
    expect(deviceDefects([samsung])).toEqual([]);
    expect(devicePolicyPromptLines(samsung).join("\n")).toContain("Samsung Galaxy S24");
    expect(deviceDefects([{ ...samsung, eraProfile: apple }]).some((entry) => entry.rule === "device-brand")).toBe(true);
  });
  it("2022显示器适用于2023故事；显式2024+合同无软白名单豁免", () => {
    const display = { shotId: "DISPLAY", scene: "显示器", devices: [{ category: "display" as const, model: "Studio Display (2022)" }], eraProfile: { storyDate: "2023-01-01" } };
    expect(deviceDefects([display])).toEqual([]);
    const defects = deviceDefects([{ ...display, eraProfile: apple }]);
    expect(defects).toContainEqual(expect.objectContaining({ rule: "device-generation", status: "failed", hard: true }));
    expect(summarizeDeviceDefects(defects)).toMatchObject({ hard: 1, soft: 0 });
  });
  it("设备禁用描述不触发要求；纸质笔记本、品牌地点、摄制相机不误作Apple品类", () => {
    for (const scene of ["无人海滩，无手机，不要笔记本电脑", "纸质笔记本和铅笔", "Google 总部门前的树", "相机在支架上拍摄"]) {
      expect(deviceDefects([{ shotId: "NONE", scene }]), scene).toEqual([]);
    }
    expect(devicePolicyStatus([{ scene: "纸质笔记本" }])).toBe("not_applicable");
    expect(deviceDefects([{ ...tablet, eraProfile: apple, action: "不要三星手机，不出现戴尔显示器" }])).toEqual([]);
  });
  it("片级profile继承，明确闪回按整份镜头profile覆写", () => {
    expect(deviceDefects([{ ...tablet, eraProfile: undefined }], { eraProfile: apple })).toEqual([]);
    expect(deviceDefects([{ ...tablet, eraProfile: { storyDate: "2010-01-01" } }], { eraProfile: apple })).toContainEqual(expect.objectContaining({ rule: "device-era", status: "failed" }));
  });
  it.each([null, "iPad", [null], [{ category: "unknown", model: "iPad Pro M4" }], [{ category: "tablet" }], [{ category: "tablet", model: 123 }]])("非法devices结构保留未验证：%j", (devices) => {
    const shot = { ...tablet, devices } as unknown as DeviceShotFields;
    expect(() => deviceDefects([shot])).not.toThrow();
    expect(devicePolicyStatus([shot])).toBe("unverified");
    expect(() => devicePolicyPromptLines(shot)).toThrow();
  });
  it("未知具体型号与泛型号都未验证，不能靠自己的releaseDate覆盖目录", () => {
    expect(devicePolicyStatus([{ ...tablet, devices: [{ category: "tablet", model: "iPad Pro 2010" }] }])).toBe("unverified");
    const future = { ...tablet, eraProfile: { storyDate: "2010-01-01" }, devices: [{ category: "tablet", model: "iPad Pro M4", availableFrom: "2000-01-01" }] } as unknown as DeviceShotFields;
    expect(devicePolicyStatus([future])).toBe("failed");
  });
  it("纯函数并发不交叉污染时代或改写输入", async () => {
    const original = JSON.stringify(tablet);
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) => Promise.resolve().then(() => devicePolicyStatus([{ ...tablet, eraProfile: index % 2 ? era : { storyDate: "2012-01-01" } }]))));
    expect(results).toEqual(Array.from({ length: 12 }, (_, index) => index % 2 ? "passed" : "failed"));
    expect(JSON.stringify(tablet)).toBe(original);
  });
});
