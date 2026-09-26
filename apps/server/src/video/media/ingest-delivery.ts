/**
 * media/ingest-delivery.ts —— 交付包 → 媒资库（合成成片通路，T-2026-0926-0007）
 *
 * 规格书 §3.3 要求在"变体落盘处"注册 final_cut。实现期核对发现：
 * `packages/video-studio/src/deliver.ts` 是**纯逻辑**模块（只算计划/判据/清单，不写盘），
 * 真正落盘的是后期工位（`bundles/ai-video/connectors/post-bridge`）产出的交付包目录。
 * 因此本模块挂在两处真实落盘点上：
 *   ① 服务内返修作业（`delivery.ts startDeliveryRevision` 完成回调）；
 *   ② 交付包目录的直接登记入口（`video.media.ingestDelivery`，供 CLI/运维补录与验收使用）。
 * 幂等：幂等键是 sha256（register 层去重），重复登记同一交付包不会产生重复素材。
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type pg from "pg";
import type { AppPool, Scope } from "../gen/db.js";
import { registerLocalAsset, type RegisterLocalAssetResult } from "./register-local.js";
import { assertInside } from "./paths.js";

export interface DeliveryManifestLike {
  projectId?: string;
  platform?: string;
  master?: { path?: string; sha256?: string; duration?: number | null; subtitles?: string };
  variants?: Array<{
    id?: string;
    name?: string;
    video?: { path?: string; duration?: number | null };
    cover?: { path?: string; text?: string };
    softsub?: { path?: string };
    style?: { color?: { profile?: string | null } | null; bgm?: { mood?: string | null } | null };
  }>;
}

export interface IngestDeliveryResult {
  dir: string;
  projectId: string | null;
  registered: Array<{ role: "master" | "variant" | "cover"; variantId: string | null; assetId: string; relPath: string; deduped: boolean }>;
  skipped: number;
  errors: string[];
}

/** 交付包内相对路径解析：先按包根，再退到 versions/<最新>（返修产物的历史口径） */
function resolveArtifact(packageDir: string, path: string | undefined): string | null {
  if (!path) return null;
  // 交付清单是**数据**不是指令：绝对路径/`..` 一律按越界拒收（深审实测：绝对路径曾被原样登记进媒体仓）
  const relative = String(path).replace(/^[/\\]+/, "");
  const candidates = [join(packageDir, relative), join(packageDir, "versions", relative)];
  for (const candidate of candidates) {
    try {
      const abs = assertInside(packageDir, candidate, "交付产物路径");
      if (existsSync(abs)) return abs;
    } catch {
      return null;
    }
  }
  return null;
}

export async function ingestDeliveryPackage(
  app: AppPool,
  gateway: pg.Pool,
  scope: Scope,
  input: { dir: string; by: string; projectId?: string | null; pipelineKind?: "narrative" | "marketing" | null; title?: string },
): Promise<IngestDeliveryResult> {
  const result: IngestDeliveryResult = { dir: input.dir, projectId: input.projectId ?? null, registered: [], skipped: 0, errors: [] };
  const manifestPath = join(input.dir, "delivery-manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`交付清单缺失：${manifestPath}（不是交付包目录）`);
  }
  let manifest: DeliveryManifestLike;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as DeliveryManifestLike;
  } catch (err) {
    throw new Error(`交付清单解析失败：${err instanceof Error ? err.message : String(err)}`);
  }
  const projectId = input.projectId ?? manifest.projectId ?? null;
  result.projectId = projectId;
  const titleOf = (suffix: string) => input.title ?? `${projectId ?? "项目"} · ${suffix}`;

  const registerOne = async (
    role: "master" | "variant" | "cover",
    variantId: string | null,
    abs: string | null,
    meta: { title: string; kind: "final_cut" | "cover"; provenance: Record<string, unknown>; tags: string[] },
  ): Promise<void> => {
    if (!abs) { result.skipped += 1; return; }
    try {
      const reg: RegisterLocalAssetResult = await registerLocalAsset(app, gateway, scope, {
        absPath: abs,
        kind: meta.kind,
        title: meta.title,
        tags: meta.tags,
        projectId,
        pipelineKind: input.pipelineKind ?? null,
        sourceType: "generated",
        provenance: { composedFrom: "delivery", packageDir: input.dir, role, variantId, ...meta.provenance },
        meta: { deliveryPackage: input.dir, deliveryRole: role, variantId },
        by: input.by,
      });
      result.registered.push({ role, variantId, assetId: reg.assetId, relPath: reg.relPath, deduped: reg.deduped });
    } catch (err) {
      result.errors.push(`${role}${variantId ? `/${variantId}` : ""}：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  await registerOne("master", null, resolveArtifact(input.dir, manifest.master?.path), {
    title: titleOf("成片母版"),
    kind: "final_cut",
    provenance: { masterSha256: manifest.master?.sha256 ?? null, subtitles: manifest.master?.subtitles ?? null },
    tags: ["成片", "母版"],
  });

  for (const variant of manifest.variants ?? []) {
    const variantId = variant.id ?? null;
    await registerOne("variant", variantId, resolveArtifact(input.dir, variant.video?.path), {
      title: titleOf(`成片变体 ${variant.name ?? variantId ?? ""}`.trim()),
      kind: "final_cut",
      provenance: { gradeProfile: variant.style?.color?.profile ?? null, bgmMood: variant.style?.bgm?.mood ?? null },
      tags: ["成片", "变体"],
    });
    await registerOne("cover", variantId, resolveArtifact(input.dir, variant.cover?.path), {
      title: titleOf(`封面 ${variant.name ?? variantId ?? ""}`.trim()),
      kind: "cover",
      provenance: { coverText: variant.cover?.text ?? null },
      tags: ["封面"],
    });
  }
  return result;
}

/**
 * 交付包目录名 → 全路径（`delivery.ts resolvePackageDir` 的安全口径：只接受目录名，
 * 不接受带分隔符/`..` 的输入；这里复用同一判据，避免"补录入口"变成任意路径读取）。
 */
export function assertSafePackageName(name: string, root: string): string {
  const trimmed = String(name ?? "").trim();
  if (!trimmed || trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..") || trimmed.startsWith(".")) {
    throw new Error(`交付包目录名非法：${name}`);
  }
  const abs = join(root, trimmed);
  if (!existsSync(abs)) throw new Error(`交付包目录不存在：${abs}`);
  return abs;
}
