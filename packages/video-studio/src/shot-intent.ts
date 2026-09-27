/**
 * Industry shot intent facade. The shared ESM implementation also runs in cine-KB's Node CLI,
 * so runtime and offline tools cannot silently diverge on subject, negation or enhancement ownership.
 */
export {
  SHOT_INTENT_VERSION, ENHANCEMENT_META_KEY, ShotIntentError,
  normalizeShotIntent, resolveShotIntent, shotIntentHash, shotText, splitShotAssertions,
  restoreShotContributions, appendShotContributions,
} from "../../../bundles/ai-video/connectors/cine-kb-bridge/shot-intent.mjs";
export type {
  ShotCard, ShotIntent, ShotIntentStatus, EnhancementOwner, ShotContributionResult,
} from "../../../bundles/ai-video/connectors/cine-kb-bridge/shot-intent.mjs";
