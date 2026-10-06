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
