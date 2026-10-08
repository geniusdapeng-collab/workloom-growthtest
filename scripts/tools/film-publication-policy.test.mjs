import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertCoverPublication, resolveOpeningTitle } from './film-publication-policy.mjs';

test('project and cover metadata never become an implicit opening title', () => {
  assert.deepEqual(resolveOpeningTitle({ projectTitle: '示例品牌', coverHook: '让服务更从容' }), { burn: false, title: '', source: 'none' });
  assert.equal(resolveOpeningTitle().burn, false);
});
test('explicit title preserves the full requested text; disable remains explicit', () => {
  const title = '这是用户明确指定而且超过十二字的完整开场标题';
  assert.deepEqual(resolveOpeningTitle({ explicitTitle: ` ${title} ` }), { burn: true, title, source: 'explicit-opening-title' });
  assert.equal(resolveOpeningTitle({ explicitTitle: title, disabled: true }).burn, false);
  assert.equal(resolveOpeningTitle({ explicitTitle: '  ' }).burn, false);
  assert.throws(() => resolveOpeningTitle({ explicitTitle: 12 }), /OPENING_TITLE_INVALID/);
});
const sha = (value) => value.repeat(64);
const receipt = () => ({ schemaVersion: 1, mode: 'replace-first-frame', coverFrameCount: 1,
  input: { sha256: sha('a') }, cover: { sha256: sha('b') }, output: { sha256: sha('c') },
  audio: { preserved: true }, subtitles: { preserved: true }, video: { frameCount: 720, durationSeconds: 30 } });
const input = () => ({ receipt: receipt(), inputSha256: sha('a'), coverSha256: sha('b'), outputSha256: sha('c') });
test('successful assembly must still bind the actual current publication bytes', () => {
  assert.equal(assertCoverPublication(input()), true);
  for (const field of ['inputSha256', 'coverSha256', 'outputSha256']) assert.throws(() => assertCoverPublication({ ...input(), [field]: sha('d') }), /PUBLICATION_COVER_UNVERIFIED/);
});
test('a sidecar or old prepend receipt cannot grant publication cover status', () => {
  assert.throws(() => assertCoverPublication({ ...input(), receipt: null }), /PUBLICATION_COVER_UNVERIFIED/);
  for (const change of [{ mode: 'prepend' }, { coverFrameCount: 0 }, { audio: { preserved: false } }, { subtitles: { preserved: false } }]) {
    assert.throws(() => assertCoverPublication({ ...input(), receipt: { ...receipt(), ...change } }), /PUBLICATION_COVER_UNVERIFIED/);
  }
  assert.equal(assertCoverPublication({ required: false }), true);
});

const completeReceipt = () => ({ ...receipt(), schemaVersion: 2, mode: 'prepend-cover-frame', sourceVideo: { frameCount: 720, fps: 24, durationSeconds: 30 },
  sourceOffsetFrames: 1, bodyVideoOffsetSeconds: 1 / 24, audioOffsetSeconds: 0, subtitleOffsetSeconds: 0, qualityReviewPerformed: false,
  video: { frameCount: 721, fps: 24, durationSeconds: 721 / 24 } });
test('formal cover publication requires the complete body and truthful independent track offsets', () => {
  const formal = { ...input(), preserveSourceFramesRequired: true, receipt: completeReceipt() };
  assert.equal(assertCoverPublication(formal), true);
  assert.throws(() => assertCoverPublication({ ...formal, receipt: receipt() }), /PUBLICATION_COVER_UNVERIFIED/);
  for (const change of [{ sourceOffsetFrames: 0 }, { bodyVideoOffsetSeconds: 0 }, { audioOffsetSeconds: 1 / 24 }, { subtitleOffsetSeconds: 1 / 24 },
    { qualityReviewPerformed: true }, { sourceVideo: { frameCount: 719, fps: 24, durationSeconds: 30 } },
    { video: { frameCount: 720, fps: 24, durationSeconds: 30 } }, { video: { frameCount: 721, fps: 30, durationSeconds: 721 / 24 } }]) {
    assert.throws(() => assertCoverPublication({ ...formal, receipt: { ...completeReceipt(), ...change } }), /PUBLICATION_COVER_UNVERIFIED/);
  }
  for (const field of ['inputSha256', 'coverSha256', 'outputSha256'])
    assert.throws(() => assertCoverPublication({ ...formal, [field]: sha('d') }), /PUBLICATION_COVER_UNVERIFIED/);
});
