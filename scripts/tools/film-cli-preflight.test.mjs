import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function run(t, { unified = false, audioEnabled = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'film-cli-preflight-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const shots = join(dir, 'shots.json'), keys = join(dir, 'keys.env');
  writeFileSync(shots, JSON.stringify({ projectId: 'TEST-NATIVE-PREFLIGHT', title: 'source metadata', durationSeconds: 5,
    shots: [{ shotId: 'TEST-01', duration: 5, speechMode: 'on-camera', action: '人物面对镜头讲话',
      dialogue: [{ text: '这句对白必须保留原声', speaker: '主角' }] }] }));
  writeFileSync(keys, `SEEDANCE_GENERATE_AUDIO=${audioEnabled ? '1' : '0'}\n`);
  const result = spawnSync(process.execPath, ['--import', 'tsx', resolve(import.meta.dirname, 'full-chain-film.mts'),
    '--shots', shots, '--project', 'TEST-NATIVE-PREFLIGHT', '--route-kind', 'narrative', '--keys-file', keys,
    '--work-dir', dir, '--out', join(dir, 'out'), '--stages', 'voice', '--dry-run',
    ...(unified ? ['--narration-unified'] : [])], { cwd: resolve(import.meta.dirname, '../..'),
    encoding: 'utf8', timeout: 30_000, env: { ...process.env, VOLCENGINE_ARK_API_KEY: '', LLM_API_KEY: '', DEEPSEEK_API_KEY: '' } });
  const log = join(dir, 'logs', 'TEST-NATIVE-PREFLIGHT', 'stages.jsonl');
  const rows = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
  return { ...result, rows };
}

test('actual official CLI refuses unified on-camera speech before voice, generation or paid I/O', t => {
  const result = run(t, { unified: true });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /AUDIO_UNIFIED_NATIVE_DIALOGUE_REJECTED/);
  assert(!result.rows.some(row => ['shot', 'material-gen', 'voice'].includes(row.stage)), JSON.stringify(result.rows));
});
test('actual official CLI refuses silent model generation for on-camera dialogue before any workstation', t => {
  const result = run(t, { audioEnabled: false });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /AUDIO_NATIVE_GENERATION_REQUIRED/);
  assert(!result.rows.some(row => ['shot', 'material-gen', 'voice'].includes(row.stage)), JSON.stringify(result.rows));
});
