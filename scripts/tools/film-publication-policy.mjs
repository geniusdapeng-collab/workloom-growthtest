/** Explicit display copy and publication byte binding; never infer display titles from metadata. */
export function resolveOpeningTitle({ explicitTitle, disabled = false } = {}) {
  if (explicitTitle !== undefined && typeof explicitTitle !== 'string') throw new TypeError('OPENING_TITLE_INVALID: title must be text');
  const title = (explicitTitle ?? '').trim();
  return { burn: !disabled && Boolean(title), title: disabled ? '' : title, source: title && !disabled ? 'explicit-opening-title' : 'none' };
}

export function assertCoverPublication({ required = true, preserveSourceFramesRequired = false, receipt, inputSha256, coverSha256, outputSha256 }) {
  if (!required) return true;
  const sha = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const legacy = receipt?.schemaVersion === 1 && receipt.mode === 'replace-first-frame' && !preserveSourceFramesRequired;
  const source = receipt?.sourceVideo, video = receipt?.video;
  const complete = receipt?.schemaVersion === 2 && receipt.mode === 'prepend-cover-frame'
    && source && Number.isSafeInteger(source.frameCount) && source.frameCount > 0 && Number.isFinite(source.fps) && source.fps > 0
    && Number.isFinite(source.durationSeconds) && source.durationSeconds > 0
    && video?.frameCount === source.frameCount + 1 && video.fps === source.fps
    && Math.abs(source.durationSeconds - source.frameCount / source.fps) <= 0.000002
    && Math.abs(video.durationSeconds - (source.durationSeconds + 1 / source.fps)) <= 0.000002
    && receipt.sourceOffsetFrames === 1 && Math.abs(receipt.bodyVideoOffsetSeconds - 1 / source.fps) <= 1e-9
    && receipt.audioOffsetSeconds === 0 && receipt.subtitleOffsetSeconds === 0 && receipt.qualityReviewPerformed === false;
  if (!receipt || !(legacy || complete) || receipt.coverFrameCount !== 1
    || ![inputSha256, coverSha256, outputSha256].every(sha)
    || receipt.input?.sha256 !== inputSha256 || receipt.cover?.sha256 !== coverSha256 || receipt.output?.sha256 !== outputSha256
    || receipt.audio?.preserved !== true || receipt.subtitles?.preserved !== true
    || !(receipt.video?.frameCount >= 1 || receipt.video?.frameCount === null && receipt.video?.frameCountBasis === "not-reported" && receipt.video?.fps > 0) || !(receipt.video?.durationSeconds > 0)) {
    throw new Error('PUBLICATION_COVER_UNVERIFIED: current source, cover and publication bytes need a successful conservation receipt');
  }
  return true;
}
