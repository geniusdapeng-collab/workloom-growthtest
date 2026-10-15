import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
const policy = new URL('./processing-quality.mjs', import.meta.url);
const hdrTags = { colorPrimaries: 'bt2020', colorSpace: 'bt2020nc', colorRange: 'tv', pixelFormat: 'yuv420p10le' };
if (existsSync(policy)) {
  const { resolveColorManagement } = await import(policy.href);
  for (const colorTransfer of ['arib-std-b67', 'smpte2084']) {
    test(`default ${colorTransfer} keeps legacy HDR pixels`, () => {
      const result = resolveColorManagement({ probe: { video: { ...hdrTags, colorTransfer } } });
      assert.equal(result.chain, 'null');
      assert.equal(result.toneMap, null);
      assert.equal(result.kind, 'legacy-hdr-pass-through');
      assert.deepEqual(result.removedHdrSideData, []);
      assert.match(result.assumptions.join(' '), /do not certify/);
    });
  }
  test('SDR normalization remains available', () => {
    const result = resolveColorManagement({ probe: { video: { colorTransfer: 'bt709', colorPrimaries: 'bt709', colorSpace: 'bt709', colorRange: 'tv' } } });
    assert.equal(result.kind, 'range-normalization');
    assert.doesNotMatch(result.chain, /tonemap=/);
  });
} else {
  test('legacy grade does not acquire implicit HDR normalization', () => {
    const source = readFileSync(new URL('./core.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /resolveColorManagement|tonemap=tonemap=mobius|transfer=linear:npl=100/);
    assert.match(source, /export async function grade/);
  });
}
