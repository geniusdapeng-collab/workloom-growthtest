import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  adaptCharacterVisualVerdict, assessCharacterRelease, buildCharacterIdentityReviewRequest,
  buildCharacterReleaseContract, characterReleaseHash, generationIdentityLock,
  type CharacterReleaseArtifact,
} from "./character-release-contract.js";
import { buildProducerReviewContract, reviewStage, type ProducerGateOptions } from "./producer-gate.js";
import { REAL_PERSON_ASSET_SCHEMA, type RealPersonAsset } from "./real-person-asset.js";

const NOW = new Date("2026-10-05T12:00:00Z");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");
const shaFile = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const configuredFixtureEnv = { LLM_BASE_URL: "https://identity-fixture.invalid", LLM_API_KEY: "fixture-only", LLM_MODEL: "fixture-visual-judge" };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "identity-stage-integration-")); dirs.push(dir);
  const clipPath = join(dir, "shot.mp4");
  const build = spawnSync(process.env.WL_FFMPEG ?? "ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=10",
    "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", clipPath], { encoding: "utf8", timeout: 30_000 });
  expect(build.status, build.stderr || String(build.error)).toBe(0);
  const referencePath = join(dir, "registered-anchor.png"); writeFileSync(referencePath, png);
  const frames = [0.2, 0.8].map((atSec, index) => {
    const path = join(dir, `frame-${index}.jpg`);
    const result = spawnSync(process.env.WL_FFMPEG ?? "ffmpeg", ["-v", "error", "-y", "-ss", String(atSec), "-i", clipPath, "-frames:v", "1", path],
      { encoding: "utf8", timeout: 30_000 });
    expect(result.status, result.stderr || String(result.error)).toBe(0);
    return { path, sha256: shaFile(path), atSec };
  });
  const asset: RealPersonAsset = { schemaVersion: REAL_PERSON_ASSET_SCHEMA, assetId: "asset-fixture-person", displayName: "Fixture",
    assetGroupId: "fixture-group", referenceAssets: ["asset-fixture-close", "asset-fixture-side"],
    certified: { gender: "female", source: "fixture registration" },
    authorization: { status: "real-authorized", scope: "fixture integration test", evidence: "fixture authorization" } };
  const contract = buildCharacterReleaseContract({ projectId: "VID-FIXTURE", assets: [asset], now: NOW,
    characters: [{ characterId: "ceo", assetId: asset.assetId, wardrobeLock: { id: "w1", description: "黑色粗花呢商务套装" },
      identityAnchor: { path: referencePath, sha256: shaFile(referencePath), assetId: asset.assetId, source: "fixture registered anchor" } }],
    shots: [{ shotId: "GT-03", characterId: "ceo", assetRef: "asset://asset-fixture-person" }] });
  const producerContracts = { shots: [{ shotId: "GT-03", scene: "一位CEO坐在窗边", characters: ["ceo"], action: "保持坐姿",
    wardrobe: "黑色粗花呢商务套装", dialogue: "" }] };
  const promptSha256 = characterReleaseHash("fixture original shot prompt");
  const clip = { path: clipPath, sha256: shaFile(clipPath) };
  const request = buildCharacterIdentityReviewRequest({ contract, shotId: "GT-03", clip, promptSha256, frames,
    producerContractHash: buildProducerReviewContract(producerContracts).contractHash, now: NOW });
  const options: ProducerGateOptions = { stage: "shot", projectId: contract.projectId,
    artifacts: [{ path: clipPath, kind: "video" }, ...frames.map((frame) => ({ path: frame.path, kind: "image" as const }))],
    deterministic: [], rubric: request.rubric, context: request.context, contracts: producerContracts,
    referenceImages: [referencePath], batchSize: 10, env: configuredFixtureEnv };
  const artifact: CharacterReleaseArtifact = { shotId: request.shotId, clip, promptSha256,
    referenceAssets: generationIdentityLock(contract, request.shotId, NOW).referenceAssets, evidence: [] };
  return { contract, request, options, artifact };
}
function fixtureJudge(answer: unknown, bodies: string[]): typeof fetch {
  return (async (url, init) => {
    expect(String(url)).toBe("https://identity-fixture.invalid/chat/completions");
    bodies.push(String(init?.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }));
  }) as typeof fetch;
}

describe("dedicated identity adapter through the real reviewStage exit (no network)", () => {
  it("actual video+frame+reference byte receipts and joint rubric flow through the official producer adapter", async () => {
    const f = fixture(); const bodies: string[] = [];
    const verdict = await reviewStage({ ...f.options, fetchImpl: fixtureJudge({ approved: true, score: 85, issues: [], suggestions: [],
      reason: "fixture joint identity and explicit wardrobe supported" }, bodies) });
    expect(verdict.approved, verdict.reason).toBe(true);
    expect(verdict.contractHash).toBe(f.request.producerContractHash);
    expect(bodies).toHaveLength(1);
    const sent = JSON.parse(bodies[0]!) as { messages: Array<{ content: Array<{ type: string; text?: string }> }> };
    expect(sent.messages[0]!.content.filter((item) => item.type === "image_url")).toHaveLength(8);
    expect(bodies[0]).toContain("身份事实检查"); expect(bodies[0]).toContain("黑色粗花呢商务套装");
    expect(bodies[0]).toContain("identity-and-explicit-wardrobe"); expect(bodies[0]).toContain("基准图");
    const evidence = adaptCharacterVisualVerdict({ request: f.request, verdict });
    expect(evidence.checks).toEqual({ identity: "passed", wardrobe: "passed" });
    const report = assessCharacterRelease({ contract: f.contract, phase: "canary", shots: [{ ...f.artifact, evidence: [evidence] }], now: NOW });
    expect(report.continuePaidRendering).toBe(true); expect(report.releaseAllowed).toBe(false);
    const release = assessCharacterRelease({ contract: f.contract, phase: "release", shots: [{ ...f.artifact, evidence: [evidence] }], now: NOW });
    expect(release.releaseAllowed).toBe(true);
  });

  it("joint visual rejection blocks release without inventing a changed-face finding", async () => {
    const f = fixture(); const bodies: string[] = [];
    const verdict = await reviewStage({ ...f.options, fetchImpl: fixtureJudge({ approved: false, score: 20, issues: ["服装违反显式合同"], suggestions: [],
      reason: "fixture white dress violates explicit black wardrobe lock" }, bodies) });
    expect(verdict.status).toBe("failed"); expect(bodies).toHaveLength(1);
    const evidence = adaptCharacterVisualVerdict({ request: f.request, verdict });
    expect(evidence.rejected).toBe(true); expect(evidence.checks.identity).toBe("unverified");
    const report = assessCharacterRelease({ contract: f.contract, phase: "release", shots: [{ ...f.artifact, evidence: [evidence] }], now: NOW });
    expect(report.status).toBe("failed"); expect(report.releaseAllowed).toBe(false);
    expect(report.issues.map((item) => item.code)).toContain("dedicated-visual-review-rejected");
  });

  it("missing model or failed HTTP cannot yield a release receipt through the dedicated path", async () => {
    const f = fixture(); let calls = 0;
    const unavailable = (async () => { calls += 1; return new Response("fixture unavailable", { status: 503 }); }) as typeof fetch;
    for (const options of [{ ...f.options, env: {}, fetchImpl: unavailable }, { ...f.options, fetchImpl: unavailable }]) {
      const verdict = await reviewStage(options); const evidence = adaptCharacterVisualVerdict({ request: f.request, verdict });
      expect(evidence.checks.identity).toBe("unverified");
      const report = assessCharacterRelease({ contract: f.contract, phase: "canary", shots: [{ ...f.artifact, evidence: [evidence] }], now: NOW });
      expect(report.status).toBe("unverified"); expect(report.continuePaidRendering).toBe(false);
    }
    expect(calls).toBe(1);
  });
});
