/** One policy source; resolves both workspace symlinks and physical installed packages. */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
export type { DirectorPlatform, CreativeOrigin, DirectorScope, DeliveryTarget, DeliveryTargetPlan,
  DirectorProfile, CreativeDelegation, SourceShot, SourceManifest, PictureEdit, PostVariantPlan } from "../../../bundles/ai-video/library/director-system/core.mjs";

function policyFile(): string {
  let root = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 9; depth++) {
    const candidate = path.join(root, "bundles/ai-video/library/director-system/core.mjs");
    if (existsSync(path.join(root, "product.manifest.json")) && existsSync(candidate)) return candidate;
    const parent = path.dirname(root);
    if (parent === root) break;
    root = parent;
  }
  throw new Error("DIRECTOR_POLICY_UNAVAILABLE: 安装载荷缺少导演策略目录");
}
const core: typeof import("../../../bundles/ai-video/library/director-system/core.mjs") = await import(pathToFileURL(policyFile()).href);
export const { DirectorError, DIRECTOR_POLICY_VERSION, DIRECTOR_RECIPES, DEFAULT_DELIVERY_PLATFORMS,
  directorHash, resolveDeliveryTargets, findDirectorRecipe, buildDirectorDefaults, directorGuidance,
  createCreativeDelegation, validateCreativeDelegation, normaliseSourceManifest, buildPostVariantPlans,
  mapCuesToTimeline, assessPostVariantDifference, attributeCreativeFeedback, applyTimelineFeedback, planPersonQualitySamples,
  compilePersonPresentation, shotPresentationGuidance } = core;
