/** Deterministic color transforms and engineering guardrails; thresholds are local heuristics, not aesthetic scores. */
const norm = (value) => String(value ?? "").trim().toLowerCase();
const unknown = (value) => !value || ["unknown", "unspecified", "reserved", "n/a"].includes(value);
const TRANSFERS = new Set(["bt709", "smpte170m", "smpte240m", "bt470m", "bt470bg", "linear", "bt2020-10", "bt2020-12", "smpte2084", "iec61966-2-1", "arib-std-b67"]);
const PRIMARIES = new Set(["bt709", "bt470m", "bt470bg", "smpte170m", "smpte240m", "bt2020", "smpte431", "smpte432"]);
const MATRICES = new Set(["bt709", "bt470bg", "smpte170m", "smpte240m", "bt2020nc", "bt2020c", "gbr"]);
function fail(message, ErrorClass) { throw new ErrorClass(message, "unsupported_color_space"); }
/** Interpret observed tags before changing pixels. Unknown SDR tags have explicit, reproducible assumptions.
 * @param {{probe?:{video?:{pixelFormat?:string,colorPrimaries?:string,colorTransfer?:string,colorSpace?:string,colorRange?:string}},sourceTransfer?:string|null,sourceGamut?:string|null,ErrorClass?:new(message:string,code?:any)=>Error}} options
 */
export function resolveColorManagement({ probe, sourceTransfer = null, sourceGamut = null, ErrorClass = Error } = {}) {
  const video = probe?.video ?? {}, assumptions = [];
  const declared = { transfer: sourceTransfer, primaries: sourceGamut };
  const aliases = { pq: "smpte2084", hlg: "arib-std-b67", srgb: "iec61966-2-1", rec709: "bt709", rec2020: "bt2020" };
  let transfer = aliases[norm(sourceTransfer)] ?? norm(sourceTransfer || video.colorTransfer);
  let primaries = aliases[norm(sourceGamut)] ?? norm(sourceGamut || video.colorPrimaries);
  let matrix = norm(video.colorSpace), range = norm(video.colorRange);
  const log = /s-?log3/.test(transfer);
  if (log) {
    // Proprietary log curves are converted by the separately audited conversion LUT chain.
    transfer = "bt709"; primaries = "bt709";
    assumptions.push("S-Log3/S-Gamut3.Cine conversion is performed by the declared conversion LUTs after input range normalization");
  }
  const hdr = ["smpte2084", "arib-std-b67"].includes(transfer);
  if (unknown(transfer)) { transfer = "bt709"; assumptions.push("unspecified transfer assumed BT.709 for SDR input"); }
  if (unknown(primaries)) {
    if (hdr) fail("HDR 输入缺少可核实的色域标签；请显式提供 source_gamut，不能猜测后打 Rec.709 标签", ErrorClass);
    primaries = "bt709"; assumptions.push("unspecified primaries assumed BT.709 for SDR input");
  }
  if (unknown(matrix)) {
    const rgb = /^(?:gbr|rgb|bgr)/.test(String(video.pixelFormat ?? ""));
    matrix = rgb ? "gbr" : primaries === "bt2020" ? "bt2020nc" : ["smpte170m", "bt470bg"].includes(primaries) ? primaries : "bt709";
    assumptions.push(`unspecified matrix assumed ${matrix} from pixel format and declared primaries`);
  }
  if (["pc", "jpeg", "full"].includes(range)) range = "full";
  else if (["tv", "mpeg", "limited"].includes(range)) range = "limited";
  else { range = matrix === "gbr" || /^yuvj/.test(String(video.pixelFormat ?? "")) ? "full" : "limited"; assumptions.push(`unspecified input range assumed ${range}`); }
  if (!TRANSFERS.has(transfer)) fail(`不支持的源传递函数 ${transfer}；拒绝仅改标签`, ErrorClass);
  if (!PRIMARIES.has(primaries)) fail(`不支持的源色域 ${primaries}；拒绝仅改标签`, ErrorClass);
  if (!MATRICES.has(matrix)) fail(`不支持的源矩阵 ${matrix}；拒绝仅改标签`, ErrorClass);
  const input = `primariesin=${primaries}:transferin=${transfer}:matrixin=${matrix}:rangein=${range}`;
  const output = "primaries=bt709:transfer=bt709:matrix=bt709:range=limited:dither=error_diffusion";
  if (hdr) assumptions.push("Legacy HDR pixel processing restored by product-owner rollback; BT.709 output tags do not certify an HDR-to-SDR conversion");
  const chain = hdr
    ? "null" // Compatibility rollback: no implicit HDR tone mapping; preserve the pre-2026-10-14 pixel path.
    : `zscale=${input}:${output},format=yuv444p10le`;
  return { schema: "workloom/color-management/v1", source: { primaries, transfer, matrix, range },
    observed: { primaries: video.colorPrimaries ?? null, transfer: video.colorTransfer ?? null, matrix: video.colorSpace ?? null, range: video.colorRange ?? null },
    declared, destination: { primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "limited", pixelFormat: "yuv420p" },
    kind: log ? "log-lut" : hdr ? "legacy-hdr-pass-through" : primaries !== "bt709" || transfer !== "bt709" ? "sdr-conversion" : "range-normalization",
    chain, assumptions, removedHdrSideData: [], toneMap: null };
}
export function clarityFilter(mode = "off", ErrorClass = Error) {
  if (!["off", "conservative"].includes(mode)) throw new ErrorClass("clarity 只能为 off/conservative", "bad_request");
  return mode === "conservative" ? "unsharp=luma_msize_x=3:luma_msize_y=3:luma_amount=0.25:chroma_amount=0" : null;
}
/** Calibrated starting guardrails; percentages are percentage points, compared at identical normalized sample times. */
export const PROCESSING_THRESHOLDS = Object.freeze({
  minimumDetailRatio: 0.88, minimumSourceDetail: 2, maximumDetailRatio: 1.8,
  maximumShadowClipIncreasePct: 1, maximumHighlightClipIncreasePct: 1,
  maximumOversaturationIncreasePct: 5, maximumLumaDrift: 28, maximumTemporalCorrectionJump: 10,
});
export function assessProcessingQuality({ before, after, sampledAt, sourceSha256, outputSha256, sourceDimensions, outputDimensions,
  thresholds = PROCESSING_THRESHOLDS, colorManagement, clarity = "off" }) {
  if (!before?.length || before.length !== after?.length || sampledAt?.length !== before.length) throw new Error("后期质量证据帧数或采样时刻不一致");
  const perFrame = before.map((source, index) => {
    const result = after[index];
    if (![source, result].every((entry) => Object.values(entry).every(Number.isFinite))) throw new Error("后期质量证据含非数值指标");
    const detailRatio = source.sharpness >= thresholds.minimumSourceDetail ? result.sharpness / source.sharpness : null;
    const delta = { luma: result.yavg - source.yavg, shadowClipPct: result.shadowClipPct - source.shadowClipPct,
      highlightClipPct: result.highlightClipPct - source.highlightClipPct, oversaturationPct: result.oversatPct - source.oversatPct,
      detailRatio: detailRatio === null ? null : Math.round(detailRatio * 1000) / 1000 };
    const issues = [];
    if (detailRatio !== null && detailRatio < thresholds.minimumDetailRatio) issues.push("detail_loss");
    if (clarity !== "off" && detailRatio !== null && detailRatio > thresholds.maximumDetailRatio) issues.push("excess_detail_energy_possible_halo_or_noise");
    if (delta.shadowClipPct > thresholds.maximumShadowClipIncreasePct) issues.push("shadow_clipping_increase");
    if (delta.highlightClipPct > thresholds.maximumHighlightClipIncreasePct) issues.push("highlight_clipping_increase");
    if (delta.oversaturationPct > thresholds.maximumOversaturationIncreasePct) issues.push("oversaturation_increase");
    if (Math.abs(delta.luma) > thresholds.maximumLumaDrift) issues.push("large_luma_drift");
    return { at: sampledAt[index], before: source, after: result, delta, issues };
  });
  const temporal = [];
  for (let index = 1; index < perFrame.length; index += 1) {
    const jump = Math.abs(perFrame[index].delta.luma - perFrame[index - 1].delta.luma);
    if (jump > thresholds.maximumTemporalCorrectionJump) temporal.push({ from: sampledAt[index - 1], to: sampledAt[index], correctionJump: jump });
  }
  const issues = [...new Set(perFrame.flatMap((frame) => frame.issues).concat(temporal.length ? ["temporal_correction_jump"] : []))];
  return { schema: "workloom/processing-quality/v1", reviewed: true, purpose: "post-processing-damage-guard", evidenceLevel: "sampled-engineering-proxies",
    sourceSha256, outputSha256, sourceDimensions, outputDimensions, sampledAt, sampleCount: sampledAt.length,
    thresholds: { ...thresholds }, thresholdProvenance: "local conservative heuristics; no aesthetic or source-acceptance score",
    normalization: colorManagement, clarity, perFrame, temporal, issues, passed: issues.length === 0,
    limitations: "Sampled engineering proxies do not guarantee aesthetic quality, skin identity, semantic food segmentation or native detail recovery; no paid generation retry is triggered" };
}
