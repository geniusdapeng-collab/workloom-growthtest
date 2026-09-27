/** Delivery ingestion accepts only server-sealed, scoped, current bytes. */
import type pg from "pg";
import { realpathSync } from "node:fs";
import type { AppPool, Scope } from "../gen/db.js";
import { deliveryRoot, resolvePackageDir } from "../delivery.js";
import {
  DeliveryError, assertManifestScope, assertScopedPackagePath,
  inspectRegisteredDeliveryArtifact, readDeliveryManifestFile, registeredDeliveryArtifacts,
  requireDeliveryTrust, type DeliveryManifestIdentity,
} from "../delivery-trust.js";
import { registerLocalAsset } from "./register-local.js";

export interface DeliveryManifestLike extends DeliveryManifestIdentity { platform?: string }
export interface IngestDeliveryResult {
  dir: string;
  projectId: string | null;
  registered: Array<{ role: "master" | "variant" | "cover"; variantId: string | null; assetId: string; relPath: string; deduped: boolean }>;
  skipped: number;
  errors: string[];
}

export async function ingestDeliveryPackage(
  app: AppPool,
  gateway: pg.Pool,
  scope: Scope,
  input: { dir: string; by: string; projectId?: string | null; pipelineKind?: "narrative" | "marketing" | null; title?: string; env?: NodeJS.ProcessEnv },
): Promise<IngestDeliveryResult> {
  const env = input.env ?? process.env;
  const requestedScope = { ...scope, ...(input.projectId ? { projectId: input.projectId } : {}) };
  const packageDir = assertScopedPackagePath(deliveryRoot(env), input.dir, requestedScope);
  const { manifest, sha256 } = readDeliveryManifestFile(packageDir);
  assertManifestScope(manifest, requestedScope);
  const trust = requireDeliveryTrust(packageDir, requestedScope, env);
  if (trust.manifestSha256 !== sha256) throw new DeliveryError("交付清单在入库前变化", "artifact_changed");
  const projectId = manifest.projectId!;
  const result: IngestDeliveryResult = { dir: packageDir, projectId, registered: [], skipped: 0, errors: [] };
  // Preflight every artifact before the first write. A failed final variant must
  // not turn the preceding master into an apparently successful partial ingest.
  const artifacts = registeredDeliveryArtifacts(manifest)
    .filter((row) => row.role === "master" || row.role === "variant" || row.role === "cover")
    .map((row) => inspectRegisteredDeliveryArtifact(packageDir, manifest, row.ref));
  for (const artifact of artifacts) {
    const role = artifact.role as "master" | "variant" | "cover";
    const label = role === "master" ? "成片母版" : `${role === "cover" ? "封面" : "成片变体"} ${artifact.variantId ?? ""}`;
    try {
      const current = requireDeliveryTrust(packageDir, requestedScope, env);
      if (current.manifestSha256 !== sha256 || current.sealSha256 !== trust.sealSha256) throw new DeliveryError("交付封签在入库期间变化", "artifact_changed");
      const reg = await registerLocalAsset(app, gateway, scope, {
        absPath: artifact.path,
        expectedRealPath: realpathSync(artifact.path),
        expectedSha256: artifact.sha256,
        kind: role === "cover" ? "cover" : "final_cut",
        title: input.title ?? `${projectId} · ${label}`,
        tags: [role === "cover" ? "封面" : "成片", ...(role === "master" ? ["母版"] : ["变体"])],
        projectId,
        pipelineKind: input.pipelineKind ?? null,
        sourceType: "generated",
        provenance: {
          composedFrom: "delivery", packageDir, role, variantId: artifact.variantId,
          revision: trust.revision, manifestSha256: sha256, sealSha256: trust.sealSha256,
          verifiedArtifactSha256: artifact.sha256,
        },
        meta: { deliveryPackage: packageDir, deliveryRole: role, variantId: artifact.variantId, deliveryRevision: trust.revision },
        by: input.by,
      });
      result.registered.push({ role, variantId: artifact.variantId, assetId: reg.assetId, relPath: reg.relPath, deduped: reg.deduped });
    } catch (error) {
      // Each registration owns its transaction; retain honest partial progress
      // and stop immediately. The caller can retry using content-addressed IDs.
      result.errors.push(`${role}${artifact.variantId ? `/${artifact.variantId}` : ""}：${error instanceof Error ? error.message : String(error)}`);
      break;
    }
  }
  return result;
}

/** API callers resolve a package name under the authenticated scope. */
export function assertSafePackageName(name: string, scope: Scope, env: NodeJS.ProcessEnv = process.env): string {
  return resolvePackageDir(name, scope, env);
}
