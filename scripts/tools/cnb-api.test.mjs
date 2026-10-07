import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { api } from './cnb-api.mjs';
import { Platform } from '../delivery/queue-platform.mjs';

const repo = 'workloom-ai/fixture';
const token = 'fixture-cn-api-token';
const nativeFetch = globalThis.fetch;
const options = { token, retries: 3, baseDelayMs: 0 };
const good = () => Response.json({ current: 'actual-response' });
const limited = headers => new Response('rate-limited', { status: 429, headers });
function fixture(t, handler, overrides = {}) {
  const state = { time: 0, wall: Date.UTC(2026, 9, 7), calls: [], waits: [] };
  const fetch = async (url, init) => {
    state.calls.push({ url, method: init.method, headers: { ...init.headers }, body: init.body, signal: init.signal });
    return handler(state, url, init);
  };
  globalThis.fetch = fetch;
  t.after(() => { globalThis.fetch = nativeFetch; });
  const runtime = { fetch, now: () => state.time, wallNow: () => state.wall + state.time,
    sleep: async ms => { state.waits.push(ms); state.time += ms; }, ...overrides };
  return { state, runtime };
}

test('429 recovery waits through the same rate window and returns only the new response', async t => {
  const f = fixture(t, state => state.time < 65000 ? limited() : good());
  assert.deepEqual(await api(repo, '/-/pulls/7', options, f.runtime), { current: 'actual-response' });
  assert.deepEqual(f.state.waits, [5000, 15000, 45000]);
  assert.equal(f.state.calls.length, 4);
  assert.equal(new Set(f.state.calls.map(row => row.url)).size, 1);
  assert.ok(f.state.calls.every(row => row.headers.Authorization === 'Bearer ' + token));
});

test('persistent 429 cannot outlive a smaller total read budget', async t => {
  const f = fixture(t, () => limited());
  await assert.rejects(api(repo, '/-/pulls/7', { ...options, retryBudgetMs: 10000 }, f.runtime), /budget exhausted/);
  assert.deepEqual(f.state.waits, [5000]);
  assert.equal(f.state.calls.length, 2);
});

test('failed retry wait is terminal before another request', async t => {
  const f = fixture(t, state => state.calls.length === 1 ? limited() : good(), { sleep: async () => { throw new Error('wait stopped'); } });
  await assert.rejects(api(repo, '/-/pulls/7', options, f.runtime), /retry wait failed.*wait stopped/);
  assert.equal(f.state.calls.length, 1);
});

test('a retry wait that consumes the remaining budget cannot issue another GET', async t => {
  const f = fixture(t, () => limited());
  f.runtime.sleep = async ms => { f.state.waits.push(ms); f.state.time += 11000; };
  await assert.rejects(api(repo, '/-/pulls/7', { ...options, retryBudgetMs: 10000 }, f.runtime), /budget exhausted/);
  assert.equal(f.state.calls.length, 1);
});

test('Retry-After greater than thirty seconds is honored without an early clamp', async t => {
  const f = fixture(t, state => state.calls.length === 1 ? limited({ 'retry-after': '90' }) : good());
  await api(repo, '/-/pulls/7', options, f.runtime);
  assert.deepEqual(f.state.waits, [90000]);
});

test('Retry-After HTTP date honors its longer wait using the actual wall clock', async t => {
  const f = fixture(t, state => state.calls.length === 1 ? limited({ 'retry-after': new Date(state.wall + 70000).toUTCString() }) : good());
  await api(repo, '/-/pulls/7', options, f.runtime);
  assert.deepEqual(f.state.waits, [70000]);
});

test('short, invalid and past Retry-After values retain the bounded fallback', async t => {
  for (const value of ['1', 'not-a-date', 'Wed, 01 Jan 2020 00:00:00 GMT']) {
    await t.test(value, async child => {
      const f = fixture(child, state => state.calls.length === 1 ? limited({ 'retry-after': value }) : good());
      await api(repo, '/-/pulls/7', options, f.runtime);
      assert.deepEqual(f.state.waits, [5000]);
    });
  }
});

test('Retry-After beyond remaining budget fails without sleeping or retrying early', async t => {
  const f = fixture(t, () => limited({ 'retry-after': '300' }));
  await assert.rejects(api(repo, '/-/pulls/7', options, f.runtime), /budget exhausted/);
  assert.equal(f.state.calls.length, 1);
  assert.deepEqual(f.state.waits, []);
});

test('non-progressing and non-returning retry waits fail within their bounds', async t => {
  await t.test('non-progressing', async child => {
    const f = fixture(child, () => limited(), { sleep: async () => {} });
    await assert.rejects(api(repo, '/-/pulls/7', options, f.runtime), /no monotonic progress/);
    assert.equal(f.state.calls.length, 1);
  });
  await t.test('non-returning', async child => {
    const f = fixture(child, () => limited(), { sleep: () => new Promise(() => {}) });
    // Use a short real timeout after a simulated first delay remains eligible.
    let reads = 0;
    f.runtime.now = () => reads++ < 7 ? 0 : 239990;
    const began = performance.now();
    await assert.rejects(api(repo, '/-/pulls/7', options, f.runtime), /retry wait failed|budget exhausted/);
    assert.equal(f.state.calls.length, 1);
    assert.ok(performance.now() - began >= 5);
  });
});

test('401 and 403 stay terminal without waiting or treating them as absent', async t => {
  for (const status of [401, 403]) {
    await t.test(String(status), async child => {
      const f = fixture(child, () => new Response('denied', { status }));
      await assert.rejects(api(repo, '/-/pulls/7', options, f.runtime), { status });
      assert.equal(f.state.calls.length, 1);
      assert.deepEqual(f.state.waits, []);
    });
  }
});

test('404, invalid JSON and raw source text keep their original distinct behavior', async t => {
  const f = fixture(t, () => new Response('absent', { status: 404 }));
  await assert.rejects(api(repo, '/-/pulls/7', options, f.runtime), { status: 404 });
  const malformed = fixture(t, () => new Response('{invalid JSON'));
  assert.equal(await api(repo, '/-/pulls/7', options, malformed.runtime), '{invalid JSON');
  const raw = fixture(t, () => new Response('pipeline:\n  source: current\n'));
  assert.equal(await api(repo, '/-/git/raw/current/.cnb.yml', options, raw.runtime), 'pipeline:\n  source: current\n');
});

test('read transport failures and 5xx can recover within the same budget', async t => {
  const transport = fixture(t, state => { if (state.calls.length === 1) throw new Error('disconnected'); return good(); });
  await api(repo, '/-/pulls/7', options, transport.runtime);
  assert.equal(transport.state.calls.length, 2);
  const server = fixture(t, state => state.calls.length === 1 ? new Response('temporary', { status: 503 }) : good());
  await api(repo, '/-/pulls/7', options, server.runtime);
  assert.equal(server.state.calls.length, 2);
});

test('every mutation attempts only once even when explicitly given retries', async t => {
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
    for (const failure of ['lost-response', '429', '503']) {
      await t.test(method + ' ' + failure, async child => {
        const f = fixture(child, () => { if (failure === 'lost-response') throw new Error('unknown write'); return new Response('failed', { status: Number(failure) }); });
        await assert.rejects(api(repo, '/-/pulls/7', { ...options, method, body: { id: 'fixed' }, retries: 8 }, f.runtime));
        assert.equal(f.state.calls.length, 1);
        assert.deepEqual(f.state.waits, []);
      });
    }
  }
});

test('retry keeps frozen body and credentials despite caller and environment mutation', async t => {
  const body = { id: 'first' };
  const previous = process.env.CNB_TOKEN;
  t.after(() => { if (previous === undefined) delete process.env.CNB_TOKEN; else process.env.CNB_TOKEN = previous; });
  const f = fixture(t, state => { body.id = 'changed'; process.env.CNB_TOKEN = 'other-fixture-token'; return state.calls.length === 1 ? limited() : good(); });
  await api(repo, '/-/pulls/7', { ...options, body }, f.runtime);
  assert.ok(f.state.calls.every(row => row.body === '{"id":"first"}' && row.headers.Authorization === 'Bearer ' + token));
});

test('foreign origins and invalid retry bounds fail before transport', async t => {
  const f = fixture(t, good);
  await assert.rejects(api(repo, 'https://foreign.invalid/pulls', options, f.runtime), /其他来源/);
  for (const patch of [{ retries: -1 }, { retries: 9 }, { retries: 1.5 }, { retryBudgetMs: 0 }, { retryBudgetMs: NaN }, { retryBudgetMs: 240001 }, { baseDelayMs: -1 }]) await assert.rejects(api(repo, '/-/pulls/7', { ...options, ...patch }, f.runtime), /retry bounds/);
  assert.equal(f.state.calls.length, 0);
});

test('late successful bytes are not accepted after the total deadline', async t => {
  const f = fixture(t, state => { state.time += 10001; return good(); });
  await assert.rejects(api(repo, '/-/pulls/7', { ...options, retryBudgetMs: 10000 }, f.runtime), /budget exhausted/);
  assert.equal(f.state.calls.length, 1);
});

test('failed transport and HTTP errors redact the configured credential', async t => {
  const f = fixture(t, () => { throw new Error('disconnected ' + token); });
  await assert.rejects(api(repo, '/-/pulls/7', { ...options, retries: 0 }, f.runtime), error => !error.message.includes(token) && error.message.includes('[REDACTED]'));
  const denied = fixture(t, () => new Response('denied ' + token, { status: 403 }));
  await assert.rejects(api(repo, '/-/pulls/7', options, denied.runtime), error => !error.message.includes(token) && !error.body.includes(token));
});

test('real HTTP body that never completes is aborted within the remaining read budget', async t => {
  let received = 0;
  const server = createServer((_request, response) => { received++; response.writeHead(200, { 'content-type': 'application/json' }); response.write('{"incomplete":'); });
  let calls = 0;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const runtime = { fetch: (_url, init) => { calls++; return nativeFetch('http://127.0.0.1:' + server.address().port, init); } };
  const began = performance.now();
  await assert.rejects(api(repo, '/-/pulls/7', { ...options, retryBudgetMs: 500 }, runtime), /budget exhausted|timed out/);
  assert.equal(calls, 1);
  assert.equal(received, 1);
  assert.ok(performance.now() - began < 3000);
});

const head = 'a'.repeat(40), main = 'b'.repeat(40), changedMain = 'c'.repeat(40);
function platformFixture(t, drift) {
  const pull = { number: 7, state: 'open', is_wip: false, labels: [], body: '', head: { sha: head, ref: 'task/fixture' }, base: { sha: main, ref: 'main' } };
  const f = fixture(t, (state, input) => {
    const path = new URL(input).pathname;
    if (path.endsWith('/pulls/7')) return Response.json(pull);
    if (path.endsWith('/git/branches/main')) return Response.json({ commit: { sha: drift && state.time >= 65000 ? changedMain : main } });
    if (path.includes('/git/compare/')) return state.time < 65000 ? limited() : Response.json({ base_commit: { sha: main }, head_commit: { sha: head }, merge_base_commit: { sha: main }, files: [{ path: 'apps/example.ts' }] });
    if (path.endsWith('/git/commits/' + head)) return Response.json({ commit: { committer: { date: '2026-10-07T00:00:00Z' } } });
    throw new Error('Unexpected fixture endpoint ' + path);
  });
  return { f, platform: new Platform(repo, token, (slug, path, init) => api(slug, path, init, f.runtime)) };
}

test('actual Platform snapshot recovers delayed reads with complete current scope', async t => {
  const { f, platform } = platformFixture(t, false);
  const snapshot = await platform.snapshot(7, { requiredNames: [] }, { checks: false });
  assert.deepEqual(snapshot.files, ['apps/example.ts']);
  assert.equal(snapshot.headSha, head);
  assert.equal(snapshot.mainSha, main);
  assert.deepEqual(f.state.waits, [5000, 15000, 45000]);
});

test('actual Platform snapshot still rejects main drift during rate recovery', async t => {
  const { f, platform } = platformFixture(t, true);
  await assert.rejects(platform.snapshot(7, { requiredNames: [] }, { checks: false }), /snapshot changed/);
  assert.deepEqual(f.state.waits, [5000, 15000, 45000]);
});
