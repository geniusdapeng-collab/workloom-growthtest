import { describe, expect, it } from "vitest";
import {
  adaptCharacterVisualVerdict, assessCharacterGenerationInput, assessCharacterRelease, assessRenderedCharacterUse,
  buildCharacterIdentityReviewRequest, buildCharacterReleaseContract, characterReleaseHash,
  generationIdentityLock, type CharacterIdentityEvidence, type CharacterReleaseArtifact,
} from "./character-release-contract.js";
import { REAL_PERSON_ASSET_SCHEMA, type RealPersonAsset } from "./real-person-asset.js";

const NOW = new Date("2026-10-05T12:00:00Z");
const H = (value: unknown) => characterReleaseHash(value);
const wardrobe = { id: "w1", description: "黑色粗花呢商务套装、金色纽扣、珍珠耳饰；全片不换装" };
const anchor = { path: "/registered/ceo-anchor.jpg", sha256: "a".repeat(64), assetId: "asset-primary", source: "平台认证资产组的本地登记基准" };
const asset: RealPersonAsset = {
  schemaVersion: REAL_PERSON_ASSET_SCHEMA, assetId: "asset-primary", displayName: "CEO",
  certified: { gender: "female", source: "平台认证 + 客户确认" }, assetGroupId: "group-ceo",
  referenceAssets: ["asset-close", "asset-side"],
  authorization: { status: "real-authorized", scope: "本项目宣传片", evidence: "客户确认授权" },
};
const fixture = () => buildCharacterReleaseContract({
  projectId: "VID-CEO", assets: [asset], now: NOW,
  characters: [{ characterId: "ceo", assetId: asset.assetId, wardrobeLock: wardrobe, identityAnchor: anchor }],
  shots: ["GT-01", "GT-03", "GT-05", "GT-06"].map((shotId) => ({ shotId, characterId: "ceo", assetRef: "asset://asset-primary" })),
});

function artifact(shotId = "GT-01"): CharacterReleaseArtifact {
  const contract = fixture(); const lock = generationIdentityLock(contract, shotId);
  return { shotId, clip: { path: `/clips/${shotId}.mp4`, sha256: H(`${shotId}-clip`) },
    promptSha256: H(`${shotId}-prompt`), referenceAssets: lock.referenceAssets, evidence: [] };
}
function visual(shotId = "GT-01", change: Record<string, unknown> = {}): CharacterIdentityEvidence {
  const contract = fixture(); const a = artifact(shotId);
  const frames = [{ path: `/frames/${shotId}-start.jpg`, sha256: H(`${shotId}-start`), atSec: 0.2 },
    { path: `/frames/${shotId}-end.jpg`, sha256: H(`${shotId}-end`), atSec: 4.5 }];
  const request = buildCharacterIdentityReviewRequest({ contract, shotId, clip: a.clip,
    promptSha256: a.promptSha256, frames, producerContractHash: H(`${shotId}-producer-contract`) });
  return adaptCharacterVisualVerdict({ request, verdict: {
    stage: "shot", status: "passed", approved: true, via: "llm", model: "configured-visual-model",
    degraded: false, score: 80, contractHash: request.producerContractHash, reason: "图像证据支持同一身份且符合w1服装合同",
    evidence: [{ ...a.clip, scope: "temporal-sample:0.000,1.000,2.000,3.000,4.000; audio-not-reviewed" },
      ...frames.map((f) => ({ path: f.path, sha256: f.sha256, scope: "image" })),
      { path: anchor.path, sha256: anchor.sha256, scope: "reference-image" }], ...change,
  } });
}
function withVisual(shotId: string): CharacterReleaseArtifact {
  const a = artifact(shotId); return { ...a, evidence: [visual(shotId)] };
}

describe("人物授权、服饰合同与正式发布", () => {
  it("所有出镜镜头统一使用授权主档的主素材+同组前两张，不从角色角度表猜ID", () => {
    const contract = fixture(); expect(contract.status).toBe("passed");
    const locks = contract.shots.map((s) => generationIdentityLock(contract, s.shotId));
    expect(locks.every((l) => JSON.stringify(l.referenceAssets) === JSON.stringify(["asset://asset-primary", "asset://asset-close", "asset://asset-side"]))).toBe(true);
    expect(locks.every((l) => l.promptFragment.includes(wardrobe.description))).toBe(true);
  });

  it("旧角色角度asset ID不属于注册组，花钱前拒绝；不静默代入同组", () => {
    const contract = buildCharacterReleaseContract({ projectId: "VID-CEO", assets: [asset], now: NOW,
      characters: [{ characterId: "ceo", assetId: asset.assetId, wardrobeLock: wardrobe }],
      shots: [{ shotId: "GT-03", characterId: "ceo", assetRef: "asset://asset-primary", referenceAssets: ["asset://asset-stale"] }] });
    expect(contract.status).toBe("failed"); expect(contract.issues.map((i) => i.code)).toContain("reference-not-authorized");
  });

  it("缺授权范围、过期、撤销，以及主档重名均不能放行", () => {
    for (const bad of [
      { ...asset, authorization: { ...asset.authorization, scope: "" } },
      { ...asset, authorization: { ...asset.authorization, expiresAt: "2026-10-01" } },
      { ...asset, authorization: { ...asset.authorization, status: "revoked" as const } },
    ]) {
      const good = fixture();
      expect(buildCharacterReleaseContract({ projectId: good.projectId, now: NOW, assets: [bad],
        characters: [{ characterId: "ceo", assetId: asset.assetId, wardrobeLock: wardrobe }],
        shots: [{ shotId: "S1", characterId: "ceo", assetRef: "asset://asset-primary" }] }).status).toBe("failed");
    }
    expect(buildCharacterReleaseContract({ projectId: "V", now: NOW, assets: [asset, asset], characters: [], shots: [] }).status).toBe("failed");
  });

  it("明确换装必须逐镜写客户来源；变更锁定内容改变contractHash", () => {
    const base = { projectId: "V", now: NOW, assets: [asset], characters: [{ characterId: "ceo", assetId: asset.assetId, wardrobeLock: wardrobe }] };
    const changed = { id: "w2", description: "白色礼服" };
    const bad = buildCharacterReleaseContract({ ...base, shots: [{ shotId: "S2", characterId: "ceo", assetRef: "asset://asset-primary", wardrobeLock: changed }] });
    expect(bad.issues.map((i) => i.code)).toContain("wardrobe-change-undeclared");
    const good = buildCharacterReleaseContract({ ...base, shots: [{ shotId: "S2", characterId: "ceo", assetRef: "asset://asset-primary",
      wardrobeLock: changed, wardrobeChange: { declaredBy: "product-owner", source: "用户原话回执", reason: "这一镜明确换白色礼服" } }] });
    expect(good.status).toBe("passed"); expect(generationIdentityLock(good, "S2").promptFragment).toContain("白色礼服");
    expect(good.contractHash).not.toBe(bad.contractHash);
  });

  it("生成请求须真的带统一refs和完整服饰锁；只写泛泛身份描述不够", () => {
    const contract = fixture(); const lock = generationIdentityLock(contract, "GT-03");
    expect(assessCharacterGenerationInput({ contract, shotId: "GT-03", prompt: "黑色套装，CEO本人", referenceAssets: lock.referenceAssets }).status).toBe("failed");
    expect(assessCharacterGenerationInput({ contract, shotId: "GT-03", prompt: `镜头原文\n${lock.promptFragment}`, referenceAssets: lock.referenceAssets }).status).toBe("passed");
    expect(assessCharacterGenerationInput({ contract, shotId: "GT-03", prompt: lock.promptFragment, referenceAssets: ["asset://asset-primary"] }).status).toBe("failed");
  });

  it("技术score100、颜色与ASR都不能当人脸认证，canary未验证阻止继续付费", () => {
    const contract = fixture(); const a = artifact();
    for (const method of ["deterministic", "color-proxy", "asr"]) {
      const evidence = { method, status: "passed", score: 100, checks: { identity: "passed", wardrobe: "passed" } } as unknown as CharacterIdentityEvidence;
      const report = assessCharacterRelease({ contract, phase: "canary", canaryShotId: a.shotId, shots: [{ ...a, evidence: [evidence] }], now: NOW });
      expect(report.status).toBe("unverified"); expect(report.continuePaidRendering).toBe(false);
      expect(report.releaseAllowed).toBe(false); expect(report.internalCandidateAllowed).toBe(true);
    }
  });

  it("真实专用视觉出口绑定合同、原视频、帧与基准，允许自动canary", () => {
    const contract = fixture(); const report = assessCharacterRelease({ contract, phase: "canary", canaryShotId: "GT-01", shots: [withVisual("GT-01")], now: NOW });
    expect(report.status).toBe("passed"); expect(report.continuePaidRendering).toBe(true);
    expect(report.releaseAllowed).toBe(false); expect(report.shots[0]?.identity).toBe("passed");
  });

  it("本次只选后续人物镜时可作为本次首镜，仍必须有该镜专用证据", () => {
    const contract = fixture();
    const passed = assessCharacterRelease({ contract, phase: "canary", canaryShotIds: ["GT-03"],
      canaryCharacterIds: ["ceo"], shots: [withVisual("GT-03")], now: NOW });
    expect(passed.continuePaidRendering).toBe(true);
    expect(assessCharacterRelease({ contract, phase: "canary", canaryShotIds: ["GT-03"],
      canaryCharacterIds: ["ceo"], shots: [artifact("GT-03")], now: NOW }).continuePaidRendering).toBe(false);
  });

  it("人物canary范围为空、重复或未登记时不得通过", () => {
    const contract = fixture();
    for (const canaryCharacterIds of [[], ["ceo", "ceo"], ["unregistered"]]) {
      expect(assessCharacterRelease({ contract, phase: "canary", canaryShotIds: ["GT-01"], canaryCharacterIds,
        shots: [withVisual("GT-01")], now: NOW }).continuePaidRendering).toBe(false);
    }
  });

  it("局部canary范围不能裁掉正式发布必需的其他人物镜", () => {
    const contract = fixture();
    const report = assessCharacterRelease({ contract, phase: "release", canaryShotIds: ["GT-01"],
      canaryCharacterIds: ["ceo"], shots: [withVisual("GT-01")], now: NOW });
    expect(report.releaseAllowed).toBe(false);
    expect(report.shots).toHaveLength(4);
  });

  it("普通确定性approved和模型降级不能伪装专用视觉通过", () => {
    expect(visual("GT-01", { via: "deterministic", score: 100 }).checks.identity).toBe("unverified");
    expect(visual("GT-01", { degraded: true }).checks.identity).toBe("unverified");
    expect(visual("GT-01", { evidence: [] }).checks.identity).toBe("unverified");
    expect(visual("GT-01", { contractHash: H("other") }).checks.identity).toBe("unverified");
  });

  it("联合专用评审拒绝只说明合同没有通过，不编造其中脸部已被判为不同人", () => {
    expect(visual("GT-03", { status: "failed", approved: false, reason: "白衣违反黑色套装合同" }).checks.identity).toBe("unverified");
  });

  it("近景评审绑定可见服饰范围；画外项留未观察，不改写生成时的完整服饰锁", () => {
    const contract = fixture(), before = characterReleaseHash(contract), evidence = visual();
    const request = evidence.visualReview!.request;
    expect(request.context.wardrobeEvidenceScope).toEqual({ policy: "visible-components-only", offscreen: "unobserved-no-pass-or-fail-claim",
      visibleContradiction: "reject", visibleNecessaryDetailUnclear: "unverified", faceEvidenceInsufficient: "unverified" });
    expect(request.wardrobeLock).toEqual(wardrobe);
    expect(generationIdentityLock(contract, "GT-01").promptFragment).toContain(wardrobe.description);
    expect(characterReleaseHash(contract)).toBe(before);
    const { requestHash, ...body } = request;
    expect(requestHash).toBe(characterReleaseHash(body));
  });

  it.each(["可见纽扣深色，违反金色纽扣合同；裙摆鞋子画外未观察", "人脸不可辨认；画外衣着不构成身份佐证"])("可见违约或身份不足仍阻止后续付费：%s", reason => {
    const contract = fixture(), clip = artifact(), rejected = visual("GT-01", { approved: false, status: "failed", reason });
    const report = assessCharacterRelease({ contract, phase: "canary", shots: [{ ...clip, evidence: [rejected] }], now: NOW });
    expect(report.continuePaidRendering).toBe(false);
    expect(report.releaseAllowed).toBe(false);
    expect(report.internalCandidateAllowed).toBe(true);
    expect(report.issues.map(row => row.code)).toContain("dedicated-visual-review-rejected");
    expect(rejected.visualReview!.verdict.reason).toBe(reason);
  });

  it("运行时间无效时授权不能被空比较绕过", () => {
    const contract = fixture();
    expect(assessCharacterRelease({ contract, phase: "release", shots: contract.shots.map((s) => withVisual(s.shotId)), now: new Date("invalid") }).status).toBe("failed");
  });

  it("外部人工回执缺checks结构保持未验证，不能抛异常或假绿", () => {
    const contract = fixture(); const a = artifact();
    const body = { schemaVersion: "workloom.character-identity-evidence/v1", method: "human-receipt", shotId: a.shotId,
      assetId: "asset-primary", contractHash: contract.contractHash, clipSha256: a.clip.sha256, promptSha256: a.promptSha256,
      reviewer: "owner", source: "实际人工回执", at: NOW.toISOString(), reason: "看过样片", referenceImage: anchor,
      frames: [{ path: "/f1.jpg", sha256: H("f1"), atSec: 0 }, { path: "/f2.jpg", sha256: H("f2"), atSec: 4 }] };
    const evidence = { ...body, receiptHash: H(body) } as unknown as CharacterIdentityEvidence;
    expect(assessCharacterRelease({ contract, phase: "canary", shots: [{ ...a, evidence: [evidence] }], now: NOW }).status).toBe("unverified");
  });

  it("外部回执伪造重复帧时间，不能构成完整时序视觉证据", () => {
    const accepted = visual(); const request = structuredClone(accepted.visualReview!.request);
    request.frames[1]!.atSec = request.frames[0]!.atSec;
    const { requestHash: _old, ...body } = request; request.requestHash = H(body);
    expect(adaptCharacterVisualVerdict({ request, verdict: accepted.visualReview!.verdict }).checks.identity).toBe("unverified");
  });

  it("外部视觉回执evidence畸形保持未验证，不能抛异常", () => {
    for (const receipts of [null, {}, [null], [{ path: null }], "receipt"]) {
      expect(visual("GT-01", { evidence: receipts }).checks.identity).toBe("unverified");
    }
  });

  it("外部视觉回执嵌套request或verdict缺失保持未验证，不能抛异常", () => {
    const contract = fixture(); const a = artifact();
    for (const change of [{ request: null }, { verdict: null }, { request: {} }, { verdict: {} }]) {
      const accepted = visual(); const { receiptHash: _old, ...body } = accepted;
      const changed = { ...body, visualReview: { ...body.visualReview, ...change } };
      const evidence = { ...changed, receiptHash: H(changed) } as unknown as CharacterIdentityEvidence;
      expect(assessCharacterRelease({ contract, phase: "canary", shots: [{ ...a, evidence: [evidence] }], now: NOW }).status).toBe("unverified");
    }
  });

  it("缺基准、只有一帧或重复同一帧不构成身份时序对比证据", () => {
    const contract = fixture(); const a = artifact();
    expect(() => buildCharacterIdentityReviewRequest({ contract, shotId: a.shotId, clip: a.clip,
      promptSha256: a.promptSha256, frames: [{ path: "/f.jpg", sha256: H("f"), atSec: 0 }], producerContractHash: H("p") })).toThrow(/帧|frame/);
    const noAnchor = buildCharacterReleaseContract({ projectId: "V", assets: [asset], now: NOW,
      characters: [{ characterId: "ceo", assetId: asset.assetId, wardrobeLock: wardrobe }],
      shots: [{ shotId: a.shotId, characterId: "ceo", assetRef: "asset://asset-primary" }] });
    expect(() => buildCharacterIdentityReviewRequest({ contract: noAnchor, shotId: a.shotId, clip: a.clip, promptSha256: a.promptSha256,
      frames: [{ path: "/f1.jpg", sha256: H("f1"), atSec: 0 }, { path: "/f2.jpg", sha256: H("f2"), atSec: 4 }], producerContractHash: H("p") })).toThrow(/基准/);
  });

  it("旧clip、prompt或被篡改的回执不能复用身份绿色状态", () => {
    const contract = fixture(); const a = withVisual("GT-01");
    for (const changed of [{ ...a, clip: { ...a.clip, sha256: H("new-clip") } }, { ...a, promptSha256: H("new-prompt") },
      { ...a, evidence: [{ ...a.evidence[0]!, checks: { identity: "passed", wardrobe: "failed" } } as CharacterIdentityEvidence] }]) {
      expect(assessCharacterRelease({ contract, phase: "canary", canaryShotId: a.shotId, shots: [changed], now: NOW }).status).toBe("unverified");
    }
  });

  it("第三镜缺身份验证，即使其他镜全绿也不能正式release", () => {
    const contract = fixture(); const shots = contract.shots.map((s) => s.shotId === "GT-03" ? artifact(s.shotId) : withVisual(s.shotId));
    const report = assessCharacterRelease({ contract, phase: "release", shots, now: NOW });
    expect(report.releaseAllowed).toBe(false); expect(report.status).toBe("unverified");
    expect(report.shots.find((s) => s.shotId === "GT-03")?.identity).toBe("unverified");
  });

  it("显式身份认证保留真实视觉拒绝，不能被另一个pass回执抹掉", () => {
    const contract = fixture(); const shots = contract.shots.map((s) => withVisual(s.shotId));
    const third = shots.find((s) => s.shotId === "GT-03")!;
    third.evidence.push(visual("GT-03", { status: "failed", approved: false, reason: "白色露肩礼服违反本镜w1黑色套装合同" }));
    const report = assessCharacterRelease({ contract, phase: "release", shots, now: NOW });
    expect(report.status).toBe("failed"); expect(report.releaseAllowed).toBe(false); expect(report.internalCandidateAllowed).toBe(true);
  });

  it("每镜独立验证同一授权人+本镜服装后才可正式发布，canary不能替其余镜通过", () => {
    const contract = fixture();
    const incomplete = assessCharacterRelease({ contract, phase: "release", shots: [withVisual("GT-01")], now: NOW });
    expect(incomplete.releaseAllowed).toBe(false);
    const report = assessCharacterRelease({ contract, phase: "release", shots: contract.shots.map((s) => withVisual(s.shotId)), now: NOW });
    expect(report.status).toBe("passed"); expect(report.releaseAllowed).toBe(true);
    expect(report.authorizationScope).toBe("registered-local-evidence-not-provider-verified");
  });

  it("回执不能覆盖后来撤销/过期授权，外部文件加载后合同篡改失败", () => {
    const contract = fixture(); contract.characters[0]!.authorization.status = "revoked";
    const report = assessCharacterRelease({ contract, phase: "release", shots: [withVisual("GT-01")], now: NOW });
    expect(report.status).toBe("failed"); expect(report.releaseAllowed).toBe(false);
  });

  it("重复shotId、未知人物、空服饰锁和非授权asset引用在预检拒绝", () => {
    const base = { projectId: "V", assets: [asset], now: NOW, characters: [{ characterId: "ceo", assetId: asset.assetId, wardrobeLock: wardrobe }] };
    for (const shots of [[{ shotId: "S", characterId: "unknown", assetRef: "asset://asset-primary" }],
      [{ shotId: "S", characterId: "ceo", assetRef: "asset://other" }],
      [{ shotId: "S", characterId: "ceo", assetRef: "asset://asset-primary" }, { shotId: "S", characterId: "ceo", assetRef: "asset://asset-primary" }]]) {
      expect(buildCharacterReleaseContract({ ...base, shots }).status).toBe("failed");
    }
  });
});

describe("渲染素材默认采用与身份认证分开", () => {
  it("无视觉意见即可采用，报告不授予身份或服饰认证", () => {
    const contract = fixture(), shots = contract.shots.map(shot => artifact(shot.shotId));
    const report = assessRenderedCharacterUse({ contract, shots, phase: "release", now: NOW });
    expect(report).toMatchObject({ status: "passed", releaseAllowed: true, materialUsePolicy: "default-use", qualityReviewPerformed: false });
    expect(report.shots.every(shot => shot.identity === "unverified" && shot.wardrobe === "unverified")).toBe(true);
    expect(assessCharacterRelease({ contract, shots, phase: "release", now: NOW }).releaseAllowed).toBe(false);
  });
  it("采用历史被拒片段时不修改其真实意见，显式认证仍反映原拒绝", () => {
    const contract = fixture(), shots = contract.shots.map(shot => withVisual(shot.shotId));
    shots[0]!.evidence = [visual("GT-01", { approved: false, status: "failed", reason: "fixture-visible-buttons-rejected" })];
    const before = JSON.stringify(shots);
    expect(assessRenderedCharacterUse({ contract, shots, phase: "release", now: NOW }).releaseAllowed).toBe(true);
    expect(JSON.stringify(shots)).toBe(before);
    expect(assessCharacterRelease({ contract, shots, phase: "release", now: NOW }).releaseAllowed).toBe(false);
  });
  it.each(["missing", "digest", "prompt", "refs", "duplicate", "unknown"])("%s source cannot be turned into an adopted release", kind => {
    const contract = fixture(), shots = contract.shots.map(shot => artifact(shot.shotId));
    if (kind === "missing") shots.pop();
    if (kind === "digest") shots[0]!.clip.sha256 = "invalid";
    if (kind === "prompt") shots[0]!.promptSha256 = "";
    if (kind === "refs") shots[0]!.referenceAssets = ["asset://asset-stale"];
    if (kind === "duplicate") shots.push(structuredClone(shots[0]!));
    if (kind === "unknown") shots.push({ ...artifact(), shotId: "unregistered" });
    expect(assessRenderedCharacterUse({ contract, shots, phase: "release", now: NOW }).releaseAllowed).toBe(false);
  });
  it("invalid, changed, revoked or expired registrations remain generation/source failures", () => {
    const contract = fixture(), shots = contract.shots.map(shot => artifact(shot.shotId));
    expect(assessRenderedCharacterUse({ contract, shots, phase: "release", now: new Date("invalid") }).releaseAllowed).toBe(false);
    const expired = buildCharacterReleaseContract({ projectId: "VID-CEO", assets: [{ ...asset,
      authorization: { ...asset.authorization, expiresAt: "2026-10-06T00:00:00Z" } }], now: NOW,
      characters: [{ characterId: "ceo", assetId: asset.assetId, wardrobeLock: wardrobe, identityAnchor: anchor }], shots: contract.shots });
    expect(assessRenderedCharacterUse({ contract: expired, shots, phase: "release", now: new Date("2026-10-07") }).releaseAllowed).toBe(false);
    contract.characters[0]!.authorization.status = "revoked";
    expect(assessRenderedCharacterUse({ contract, shots, phase: "release", now: NOW }).releaseAllowed).toBe(false);
  });
  it("a selected canary does not remove later shots from the final source report", () => {
    const contract = fixture();
    expect(assessRenderedCharacterUse({ contract, shots: [artifact()], phase: "canary", canaryShotIds: ["GT-01"],
      canaryCharacterIds: ["ceo"], now: NOW }).continuePaidRendering).toBe(true);
    expect(assessRenderedCharacterUse({ contract, shots: [artifact()], phase: "release", canaryShotIds: ["GT-01"],
      canaryCharacterIds: ["ceo"], now: NOW }).releaseAllowed).toBe(false);
  });
});
