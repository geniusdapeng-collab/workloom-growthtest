/**
 * Industry shot intent facade. The shared ESM implementation also runs in cine-KB's Node CLI,
 * so runtime and offline tools cannot silently diverge on subject, negation or enhancement ownership.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { videoRuntimeRoot } from "./runtime-root.js";
const core:typeof import("../../../bundles/ai-video/connectors/cine-kb-bridge/shot-intent.mjs") =
  await import(pathToFileURL(path.join(videoRuntimeRoot(import.meta.url),"bundles/ai-video/connectors/cine-kb-bridge/shot-intent.mjs")).href);
export const {
  SHOT_INTENT_VERSION, ENHANCEMENT_META_KEY, ShotIntentError,
  normalizeShotIntent, resolveShotIntent, shotIntentHash, shotText, splitShotAssertions,
  restoreShotContributions, appendShotContributions,
} = core;
export type {
  ShotCard, ShotIntent, ShotIntentStatus, EnhancementOwner, ShotContributionResult,
} from "../../../bundles/ai-video/connectors/cine-kb-bridge/shot-intent.mjs";
