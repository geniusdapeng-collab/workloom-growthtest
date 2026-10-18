/** Assertions over completed real CLI media and the independently verified processing graph. */
import assert from 'node:assert/strict';

export function assertDefaultAiColors(manifest, records) {
  assert.deepEqual(manifest.variants.map(row => row.id), ['original', 'warm-story', 'content-auto']);
  assert.equal(manifest.colorPolicy.masterMode, 'preserve');
  assert.equal(manifest.colorPolicy.independentVariants, true);
  assert.match(manifest.colorPolicy.commonSourceSha256, /^[a-f0-9]{64}$/);
  const [original, warm, automatic] = manifest.variants;
  assert.equal(original.gradeProfile, null);
  assert.equal(original.gradeIntensity, 0);
  assert.equal(warm.gradeProfile, 'warm-film');
  assert.equal(warm.gradeLut, null);
  assert.equal(warm.gradeIntensity, 0.3);
  assert.ok(automatic.colorDecision?.evidence.length > 0);
  assert.ok(automatic.colorDecision?.limitations.length > 0);
  for (const variant of manifest.variants) assert.equal(variant.colorSourceSha256, manifest.colorPolicy.commonSourceSha256);
  const color = records.filter(row => row.stage === 'color').at(-1);
  assert.equal(color.invoked, false);
  assert.equal(color.ok, true);
  assert.equal(color.evidence.mode, 'preserve');
  assert.equal(manifest.generationQuality.processing.filter(row => row.stage === 'color').length, 2);
}
