import { describe, expect, it } from "vitest";
import {
  REAL_PERSON_ASSET_SCHEMA,
  referenceAssetRefs,
  ageBandInText,
  assertShotMatchesCertifiedAsset,
  assetIdOf,
  gendersInText,
  identityReviewContext,
  realPersonUsageReceipt,
  verifyRealPersonAsset,
  type RealPersonAsset
} from "./real-person-asset.js";

const certified: RealPersonAsset = {
  schemaVersion: REAL_PERSON_ASSET_SCHEMA,
  assetId: "asset-20260101000000-demo",
  displayName: "客户方 CEO",
  certified: { gender: "female", ageBand: "三十岁上下", source: "平台认证 + 产品所有者确认" },
  authorization: { status: "real-authorized", evidence: "asset://asset-20260101000000-demo" }
};

describe("认证真人素材一致性门（T-2026-0929-0007 事故机制化）", () => {
  it("主档齐全且授权有效时通过；缺性别或授权过期即失败（不许猜）", () => {
    expect(verifyRealPersonAsset(certified, { now: new Date("2026-09-29") })).toEqual([]);
    const missingGender = { ...certified, certified: { ...certified.certified, gender: undefined } } as unknown as RealPersonAsset;
    expect(verifyRealPersonAsset(missingGender).map((i) => i.code)).toContain("gender-missing");
    const expired = { ...certified, authorization: { ...certified.authorization, expiresAt: "2026-01-01" } };
    expect(verifyRealPersonAsset(expired, { now: new Date("2026-09-29") }).map((i) => i.code)).toContain("expiry-passed");
  });

  it("镜头卡写男性而主档认证为女性 → 硬冲突（真机事故形态）", () => {
    const bad = {
      shotId: "FP-01",
      character: "示例品牌负责人（与参考画面中的男士为同一人：东亚男性，四十岁上下，黑色短发三七分）",
      costume: "深藏青色西装", action: "他正对镜头开口", assetRef: "asset://asset-20260101000000-demo"
    };
    const issues = assertShotMatchesCertifiedAsset(bad, certified);
    expect(issues.some((i) => i.code === "gender-conflict" && i.hard)).toBe(true);
    expect(issues.some((i) => i.code === "age-conflict" && i.hard)).toBe(true);
  });

  it("女性 + 三十岁上下 的镜头卡与主档一致；assetRef 指向别的素材会拦", () => {
    const good = {
      shotId: "FP-01", assetRef: "asset://asset-20260101000000-demo",
      character: "这位女士（东亚女性，三十岁上下，面容清丽精致）", costume: "高定黑色小香风套装", action: "她正对镜头开口"
    };
    expect(assertShotMatchesCertifiedAsset(good, certified).filter((i) => i.hard)).toEqual([]);
    const wrongAsset = { ...good, assetRef: "asset://asset-20260929120055-other" };
    expect(assertShotMatchesCertifiedAsset(wrongAsset, certified).map((i) => i.code)).toContain("asset-mismatch");
  });

  it("性别未确认的主档会停在「先确认」而不是默认放行", () => {
    const unspecified = { ...certified, certified: { ...certified.certified, gender: "unspecified" as const } };
    expect(assertShotMatchesCertifiedAsset({ shotId: "S1", character: "主角" }, unspecified).map((i) => i.code)).toContain("gender-unspecified");
  });

  it("身份比对上下文带主档属性；使用留痕登记素材与镜号", () => {
    const ctx = identityReviewContext(certified);
    expect(JSON.stringify(ctx)).toContain("female");
    expect(String(ctx.discipline)).toContain("身份漂移");
    const receipt = realPersonUsageReceipt({ asset: certified, projectId: "VID-FF02", shots: ["FP-03", "FP-01"] });
    expect(receipt.assetId).toBe("asset-20260101000000-demo");
    expect(receipt.shots).toEqual(["FP-01", "FP-03"]);
  });

  it("文本抽取：中文代词与年龄词都能识别", () => {
    expect([...gendersInText("他正对镜头，客户是男士")]).toEqual(["male"]);
    expect([...gendersInText("她站在大堂里")]).toEqual(["female"]);
    expect(ageBandInText("三十岁上下的女士")).toBe("三十岁上下");
    expect(assetIdOf("asset://asset-20260101000000-demo")).toBe("asset-20260101000000-demo");
  });

  it("同组多张参考素材：主素材在前、去重、按 Seedance 上限 3 张截断", () => {
    const withGroup = { ...certified, assetId: "asset-A", referenceAssets: ["asset-B", "asset-A", "asset-C", "asset-D"] };
    expect(referenceAssetRefs(withGroup)).toEqual(["asset://asset-A", "asset://asset-B", "asset://asset-C"]);
    expect(referenceAssetRefs(withGroup, 2)).toEqual(["asset://asset-A", "asset://asset-B"]);
    expect(referenceAssetRefs(certified)).toEqual(["asset://asset-20260101000000-demo"]);
  });
});
