/**
 * 镜头内电子设备硬约束回归（2026-09-27 产品所有者口径）：
 * 场景中出现的电子设备（笔记本/台式机/手机/平板/显示器等）**全部使用 2024 年之后的 Apple 设备**，
 * 且必须以机型写进镜头卡 —— 裸词不算、其他品牌判红、世代偏早给软提示。
 */
import { describe, expect, it } from "vitest";
import {
  DEVICE_ALLOWLIST,
  DEVICE_POLICY_VERIFIED_AT,
  allowedModelSummary,
  deviceDefects,
  isAllowedDeviceModel,
  isSoftAllowedDeviceModel,
  summarizeDeviceDefects,
  type DeviceShotFields
} from "./device-policy.js";

describe("设备允许清单", () => {
  it("清单覆盖产品所有者点名的五类设备（笔记本/台式机/手机/平板/显示器）", () => {
    const categories = new Set(DEVICE_ALLOWLIST.map((entry) => entry.category));
    for (const category of ["laptop", "desktop", "phone", "tablet", "display", "all-in-one"]) {
      expect(categories.has(category as never), `缺类别 ${category}`).toBe(true);
    }
  });

  it("每条清单项都带世代口径与事实来源（可核对、可扩展）", () => {
    expect(DEVICE_POLICY_VERIFIED_AT).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const entry of DEVICE_ALLOWLIST) {
      expect(entry.generation.length, `${entry.model} 缺世代口径`).toBeGreaterThan(2);
      expect(entry.source, `${entry.model} 缺来源`).toMatch(/^https:\/\/www\.apple\.com/);
    }
  });

  it("机型匹配：命中清单/别名；混淆写法不误判", () => {
    expect(isAllowedDeviceModel("MacBook Pro")).toBe(true);
    expect(isAllowedDeviceModel("macbook pro 14 英寸")).toBe(true);
    expect(isAllowedDeviceModel("iPhone 16")).toBe(true);
    expect(isAllowedDeviceModel("iPad Pro")).toBe(true);
    expect(isAllowedDeviceModel("Studio Display XDR")).toBe(true);
    expect(isAllowedDeviceModel("笔记本电脑")).toBe(false);
    expect(isAllowedDeviceModel("ThinkPad X1")).toBe(false);
    expect(isSoftAllowedDeviceModel("Studio Display")).toBe(true);
  });
});

describe("设备硬约束审计", () => {
  const withDevice: DeviceShotFields = {
    shotId: "GR-02",
    scene: "南向采光的会议室",
    sceneDescription: "桌上平放一台 iPad Pro，屏幕朝内",
    props: "iPad Pro（M4 世代）",
    devices: [{ category: "tablet", model: "iPad Pro", role: "展示报表", placement: "平放桌面、屏幕朝向主播本人" }]
  };

  it("声明齐全且机型在清单内 → 零缺陷", () => {
    expect(deviceDefects([withDevice])).toEqual([]);
  });

  it("文本里有设备但没声明 devices[] → 硬红（并给出可用机型）", () => {
    const defects = deviceDefects([{ ...withDevice, devices: undefined }]);
    expect(defects.map((defect) => defect.rule)).toContain("device-declaration");
    expect(defects[0]!.hard).toBe(true);
    expect(defects[0]!.detail).toContain("iPad Pro");
  });

  it("声明了裸词（没有机型）→ 硬红：裸词不算机型", () => {
    const defects = deviceDefects([{ ...withDevice, devices: [{ category: "tablet", model: "平板电脑" }] }]);
    expect(defects.map((defect) => defect.rule)).toContain("device-model");
  });

  it("其他品牌机型 → 硬红（机型不在清单）", () => {
    const defects = deviceDefects([{ ...withDevice, devices: [{ category: "laptop", model: "ThinkPad X1 Carbon" }] }]);
    expect(defects.map((defect) => defect.rule)).toContain("device-model");
  });

  it("文本里出现非 Apple 品牌 → 硬红", () => {
    const defects = deviceDefects([{
      ...withDevice,
      sceneDescription: "桌上平放一台 iPad Pro，旁边是一台戴尔显示器"
    }]);
    expect(defects.map((defect) => defect.rule)).toContain("device-brand");
    expect(defects.find((defect) => defect.rule === "device-brand")!.detail).toContain("戴尔");
  });

  it("在售但世代偏早（Studio Display 2022）→ 软提示，不阻断", () => {
    const defects = deviceDefects([{
      shotId: "GR-10",
      sceneDescription: "工位正前方一台显示器",
      devices: [{ category: "display", model: "Studio Display" }]
    }]);
    const summary = summarizeDeviceDefects(defects);
    expect(summary.hard).toBe(0);
    expect(summary.soft).toBe(1);
    expect(defects[0]!.rule).toBe("device-generation");
  });

  it("纸质笔记本不算电子设备（避免误伤商务场景里的纸本）", () => {
    expect(deviceDefects([{ shotId: "GR-13", sceneDescription: "桌上摊着合上的笔记本与一支笔" }])).toEqual([]);
    expect(deviceDefects([{ shotId: "GR-13b", sceneDescription: "桌上摊着一台笔记本屏幕微亮" }]).length).toBeGreaterThan(0);
  });

  it("建议清单按类别给出（判红时可执行）", () => {
    expect(allowedModelSummary("laptop")).toContain("MacBook Pro");
    expect(allowedModelSummary("phone")).toContain("iPhone");
    expect(allowedModelSummary("display")).toContain("Studio Display XDR");
  });
});
