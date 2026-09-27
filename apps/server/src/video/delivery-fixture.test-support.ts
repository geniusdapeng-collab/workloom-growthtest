/** Test authority only. Never imported by production modules. */
import { createHmac } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  DELIVERY_CHECK_SET, DELIVERY_REQUIRED_CHECKS, DELIVERY_SEAL_SCHEMA, canonicalDeliveryJson,
  deliverySha256, registeredDeliveryArtifacts, type DeliveryManifestIdentity, type DeliveryScope, type DeliverySealPayload,
} from "./delivery-trust.js";

export const TEST_DELIVERY_SECRET = "test-only-delivery-authority-secret-32-bytes";
export function writeFixtureJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
export function writeTestSeal(packageDir: string, payload: DeliverySealPayload, secret = TEST_DELIVERY_SECRET): void {
  writeFixtureJson(join(packageDir, "delivery-seal.json"), {
    schemaVersion: DELIVERY_SEAL_SCHEMA, payload,
    signature: createHmac("sha256", secret).update(canonicalDeliveryJson(payload)).digest("hex"),
  });
}
export function sealTestPackage(packageDir: string, scope: DeliveryScope, secret = TEST_DELIVERY_SECRET): DeliverySealPayload {
  const raw = readFileSync(join(packageDir, "delivery-manifest.json"));
  const manifest = JSON.parse(raw.toString()) as DeliveryManifestIdentity;
  const manifestSha256 = deliverySha256(raw);
  const artifacts = registeredDeliveryArtifacts(manifest).map((row) => ({
    ...row, bytes: statSync(join(packageDir, row.ref)).size, realpath: realpathSync(join(packageDir, row.ref)),
  }));
  const payload: DeliverySealPayload = {
    issuer: "workloom.production-authority", checkSet: DELIVERY_CHECK_SET,
    scope: { tenantId: scope.tenantId, workspaceId: scope.workspaceId },
    projectId: manifest.projectId!, revision: manifest.revision!, manifestSha256,
    recipeSha256: deliverySha256("test recipe"), toolchainSha256: deliverySha256("test executor"),
    issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    packageRealPath: realpathSync(packageDir), artifacts, checks: [],
  };
  const rows = [{ ref: null, role: "package" as const, sha256: manifestSha256 }, ...artifacts];
  let index = 0;
  for (const row of rows) for (const id of DELIVERY_REQUIRED_CHECKS[row.role]) {
    const ref = `evidence/${index++}-${id}.json`;
    const record = {
      schemaVersion: "workloom.delivery-evidence/v1", scope: payload.scope, projectId: payload.projectId, revision: payload.revision,
      artifactRef: row.ref, artifactSha256: row.sha256, checkId: id, status: "passed",
      receiptId: `test-receipt-${index}`, method: "test-fixture", observations: { fixture: true, realModel: false },
    };
    writeFixtureJson(join(packageDir, ref), record);
    payload.checks.push({ id, artifactRef: row.ref, artifactSha256: row.sha256, status: "passed", evidence: { ref, sha256: deliverySha256(readFileSync(join(packageDir, ref))) } });
  }
  writeTestSeal(packageDir, payload, secret);
  return payload;
}
export function seedTestPackage(packageDir: string, scope: DeliveryScope, projectId = scope.projectId ?? "P1"): DeliveryManifestIdentity {
  const add = (ref: string, content: string) => {
    mkdirSync(dirname(join(packageDir, ref)), { recursive: true });
    writeFileSync(join(packageDir, ref), content);
    return { path: ref, sha256: deliverySha256(content) };
  };
  const manifest: DeliveryManifestIdentity = {
    scope: { tenantId: scope.tenantId, workspaceId: scope.workspaceId }, projectId, revision: 1,
    master: add("master.mp4", `test master ${projectId}`),
    variants: ["a", "b", "c"].map((id) => ({ id,
      video: add(`variants/${id}/video.mp4`, `test video ${id} ${projectId}`),
      cover: add(`variants/${id}/cover.png`, `test cover ${id} ${projectId}`),
    })),
    checks: [{ kind: "fixture_checks", ok: true }],
  };
  writeFixtureJson(join(packageDir, "delivery-manifest.json"), manifest);
  writeFixtureJson(join(packageDir, "film-project.json"), { projectId, version: 1, layers: { shots: [{ shotId: "SC-01" }], variants: [{ id: "a" }] } });
  sealTestPackage(packageDir, scope);
  return manifest;
}
