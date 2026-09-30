import { describe, expect, it } from "vitest";
import { REAL_PERSON_ASSET_SCHEMA, type RealPersonAsset } from "./real-person-asset.js";
import {
  parseConsoleAssetList,
  reconcileRealPersonAsset,
  renderReconcileReport
} from "./real-person-asset-sync.js";

/**
 * 用**合成 ID**做用例（真实客户清单不进仓库；客户只需在运行时把自己的清单喂给 CLI）。
 * 形状与火山方舟控制台一致：asset-<14 位时间戳>-<短码>。
 */
const ID = (stamp: string, code: string): string => `asset-${stamp}-${code}`;
const A = ID("20260101120000", "aaaaa");
const B = ID("20260101120000", "bbbbb");
const C = ID("20260101120000", "ccccc");
const D = ID("20260101120001", "ddddd");

const screenshotLike = `
资产信息            资产状态
mmeexport1700000000001.jpg  ${A}   已入库
mmeexport1700000000002.jpg  ${B}   已入库
1700000000003.jpg           ${C}   已入库
group-20260101115741-gv1tdf
`;

function profileFixture(): RealPersonAsset & Record<string, unknown> {
  return {
    schemaVersion: REAL_PERSON_ASSET_SCHEMA,
    assetId: A,
    displayName: "测试出镜人",
    certified: { gender: "female", source: "平台认证 + 客户确认" },
    authorization: { status: "real-authorized" },
    assetGroupId: "group-20260101115741-gv1tdf",
    referenceAssets: [B, ID("20260101120000", "zzzzz")],
    referenceAssetSources: {
      schemaVersion: "workloom.real-person-asset-sources/v1",
      assets: [
        { assetId: A, sourceFile: "old-a.jpg", angleGuess: "front" },
        { assetId: B, sourceFile: "old-b.jpg", angleGuess: "closeup" }
      ]
    },
    portraitSet: {
      schemaVersion: "workloom.real-person-portrait-set/v1",
      group: "group-20260101115741-gv1tdf",
      count: 3,
      assets: [{ assetId: A, angleGuess: "front" }, { assetId: B, angleGuess: "closeup" }, { assetId: ID("20260101120000", "zzzzz"), angleGuess: "threeQuarter" }],
      note: "旧记录"
    }
  } as RealPersonAsset & Record<string, unknown>;
}

describe("parseConsoleAssetList —— 容忍客户清单的各种形态", () => {
  it("解析「文件名 + asset ID」两列（截图/控制台粘贴）并提取组 ID", () => {
    const parsed = parseConsoleAssetList(screenshotLike);
    expect(parsed.entries.map((entry) => entry.assetId)).toEqual([A, B, C]);
    expect(parsed.entries[0]?.sourceFile).toBe("mmeexport1700000000001.jpg");
    expect(parsed.groupId).toBe("group-20260101115741-gv1tdf");
    expect(parsed.ignoredLines.join(" ")).toContain("资产状态");
  });

  it("纯 ID 列表、重复 ID 去重、大小写归一", () => {
    const parsed = parseConsoleAssetList(`${A}\n${A.toUpperCase()}\n${D}`);
    expect(parsed.entries.map((entry) => entry.assetId)).toEqual([A, D]);
  });

  it("空清单解析为空（由对账层报错，不在解析层猜）", () => {
    expect(parseConsoleAssetList("这里没有素材 ID").entries).toEqual([]);
  });
});

describe("reconcileRealPersonAsset —— 用平台清单对账主档（通用，不含客户特定常量）", () => {
  it("新增/删除/不变 + 顺序 = 清单顺序（主素材置顶，其余按清单）", () => {
    const parsed = parseConsoleAssetList(screenshotLike);
    const { profile, report } = reconcileRealPersonAsset({
      profile: profileFixture(), parsed, sourceLabel: "客户控制台截图（测试夹具）", at: "2026-01-01"
    });
    expect(report.primaryAssetId).toBe(A);
    expect(report.referenceAssets).toEqual([B, C]);
    expect(report.removed).toEqual([ID("20260101120000", "zzzzz")]);
    expect(report.added).toEqual([C]);
    expect(report.unchanged).toEqual([B]);
    expect(profile.referenceAssets).toEqual([B, C]);
    const sources = (profile.referenceAssetSources as { assets: Array<Record<string, unknown>> }).assets;
    expect(sources.map((entry) => entry.assetId)).toEqual([A, B, C]);
    /** 同 ID 的既有 angleGuess 保留；新 ID 不猜角度 */
    expect(sources.find((entry) => entry.assetId === B)?.angleGuess).toBe("closeup");
    expect(sources.find((entry) => entry.assetId === C)?.angleGuess).toBeNull();
    /** 新 ID 的来源文件名来自清单 */
    expect(sources.find((entry) => entry.assetId === C)?.sourceFile).toBe("1700000000003.jpg");
    expect(renderReconcileReport(report)).toContain("客户控制台截图");
  });

  it("主素材：显式指定优先；未指定则沿用主档（若仍在清单里）；再退清单第一条", () => {
    const parsed = parseConsoleAssetList(`${A}\n${B}\n${C}`);
    expect(reconcileRealPersonAsset({ profile: profileFixture(), parsed, primaryAssetId: C }).report.primaryAssetId).toBe(C);
    expect(reconcileRealPersonAsset({ profile: profileFixture(), parsed }).report.primaryAssetId).toBe(A);
    const withoutPrimary = { ...profileFixture(), assetId: ID("20260101120000", "zzzzz") } as RealPersonAsset & Record<string, unknown>;
    expect(reconcileRealPersonAsset({ profile: withoutPrimary, parsed }).report.primaryAssetId).toBe(A);
  });

  it("幂等：对同一份清单再对账一次，新增/删除都为空", () => {
    const parsed = parseConsoleAssetList(screenshotLike);
    const first = reconcileRealPersonAsset({ profile: profileFixture(), parsed });
    const second = reconcileRealPersonAsset({ profile: first.profile, parsed });
    expect(second.report.added).toEqual([]);
    expect(second.report.removed).toEqual([]);
    expect(second.profile.referenceAssets).toEqual([B, C]);
  });

  it("清单为空 / 指定主素材不在清单里：明确报错", () => {
    expect(() => reconcileRealPersonAsset({ profile: profileFixture(), parsed: parseConsoleAssetList("无 ID") }))
      .toThrow(/ASSET_LIST_EMPTY/);
    expect(() => reconcileRealPersonAsset({
      profile: profileFixture(), parsed: parseConsoleAssetList(`${A}\n${B}`), primaryAssetId: D
    })).toThrow(/ASSET_PRIMARY_NOT_IN_LIST/);
  });

  it("组 ID 不一致时在报告里显式告警（不静默改写）", () => {
    const parsed = parseConsoleAssetList(`${A}\n${B}\n${C}\ngroup-20260101999999-other`);
    const { report } = reconcileRealPersonAsset({ profile: profileFixture(), parsed });
    expect(report.notes.join(" ")).toContain("组 ID 不一致");
  });
});
