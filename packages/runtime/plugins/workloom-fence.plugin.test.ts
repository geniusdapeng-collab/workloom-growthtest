import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { apply } from './workloom-fence.plugin.js';

type Decision = { kind: string; reason?: string };
type Execution = { name?: string; tool?: { name: string }; signal?: AbortSignal; arguments?: unknown };
type Hook = (exec: Execution, next: () => Promise<Decision>) => Promise<Decision>;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const auto = { rule_id: 'R1', level: 'auto', actions: ['bash'] };
const block = { rule_id: 'R2', level: 'block', actions: ['bash'] };
function runtime(config: Record<string, unknown> = {}) {
  let hook: Hook | undefined;
  apply({ on: (event: string, handler: Hook) => { expect(event).toBe('tools/pre-execute'); hook = handler; } }, config);
  const next = vi.fn(async (): Promise<Decision> => ({ kind: 'allow' }));
  return { next, invoke: (exec: Execution = { name: 'bash' }) => hook!(exec, next) };
}
async function endpoint(handler: (res: ServerResponse) => void) {
  const requests: Array<{ auth?: string; url?: string }> = [];
  const server = createServer((req, res) => { requests.push({ auth: req.headers.authorization, url: req.url }); handler(res); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())); });
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/rules`, requests };
}
async function rules(value: unknown) { return endpoint(res => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); }); }

describe('actual dsh pre-execute adapter with HTTP rule source', () => {
  it.each([{}, { rulesUrl: '' }, { rulesUrl: 'http://public.invalid' }, { rulesUrl: 'https://user:secret@example.test' }, { rulesUrl: 'https://example.test/?token=secret' }])('missing or unsafe configuration does not dispatch %j', async config => {
    const r = runtime(config); expect((await r.invoke()).kind).toBe('deny'); expect(r.next).not.toHaveBeenCalled();
  });
  it.each([[auto], { result: { data: [auto] } }])('accepts explicit auto in raw and canonical tRPC envelopes', async value => {
    const source = await rules(value); const r = runtime({ rulesUrl: source.url });
    expect(await r.invoke()).toEqual({ kind: 'allow' }); expect(r.next).toHaveBeenCalledTimes(1);
  });
  it('uses the configured credential without placing it in diagnostics', async () => {
    const token = 'test-only-workspace-key'; vi.stubEnv('WORKLOOM_TEST_FENCE_TOKEN', token);
    const logs: string[] = []; vi.spyOn(console, 'log').mockImplementation((...parts) => { logs.push(parts.join(' ')); });
    const source = await rules({ result: { data: [auto] } });
    const r = runtime({ rulesUrl: source.url, tokenEnv: 'WORKLOOM_TEST_FENCE_TOKEN', requireAuth: true });
    expect((await r.invoke({ name: 'bash', arguments: { password: 'test-only-never-log-args' } })).kind).toBe('allow');
    expect(source.requests[0]?.auth).toBe(`Bearer ${token}`);
    expect(logs.join()).not.toContain(token); expect(logs.join()).not.toContain('test-only-never-log-args');
    vi.stubEnv('WORKLOOM_TEST_FENCE_TOKEN', ''); expect((await r.invoke()).kind).toBe('deny'); expect(source.requests).toHaveLength(1);
  });
  it.each([[], {}, { result: {} }, { error: { message: 'service-secret' } }, [{ ...auto, level: 'bogus' }], [{ ...auto, actions: [] }], [{ ...auto, actions: 'bash' }], [{ ...auto, actions: [''] }], [auto, auto], [{ ...auto, match: 'bad' }], [{ ...auto, when: true }], [{ ...auto, match: { actions: ['bash'], object_types: 'bad' } }]])('malformed, empty or duplicate rules do not dispatch', async value => {
    const source = await rules(value); const r = runtime({ rulesUrl: source.url });
    expect((await r.invoke()).kind).toBe('deny'); expect(r.next).not.toHaveBeenCalled();
  });
  it('keeps block above review above auto independent of array order', async () => {
    for (const value of [[auto, block], [block, auto], [auto, { ...block, level: 'review' }]]) {
      const source = await rules(value); const r = runtime({ rulesUrl: source.url });
      expect((await r.invoke()).kind).toBe(value.some(rule => rule.level === 'block') ? 'deny' : 'ask');
      expect(r.next).not.toHaveBeenCalled();
    }
  });
  it.each([{ ...auto, condition: false }, { ...auto, match: { actions: ['video.read'] } }, { ...auto, when: 'params.amount > 0', match: { actions: ['bash'], when: 'true' } }, { ...auto, objectTypes: ['invoice'], match: { actions: ['bash'], object_types: [] } }])('unknown or conflicting constraints are rejected rather than ignored', async value => {
    const source = await rules([value]); const r = runtime({ rulesUrl: source.url });
    expect((await r.invoke()).kind).toBe('deny'); expect(r.next).not.toHaveBeenCalled();
  });
  it('an exact read allow cannot authorize a sibling write; explicit subtree allow remains possible', async () => {
    const source = await rules([{ ...auto, actions: ['video.read'] }]); const r = runtime({ rulesUrl: source.url });
    expect((await r.invoke({ name: 'video.read' })).kind).toBe('allow');
    expect((await r.invoke({ name: 'video.render.submit' })).kind).toBe('deny');
    expect((await r.invoke({ name: 'video.readSecrets' })).kind).toBe('deny'); expect(r.next).toHaveBeenCalledTimes(1);
    const subtree = await rules([{ ...auto, actions: ['video.production.*'] }]); const s = runtime({ rulesUrl: subtree.url });
    expect((await s.invoke({ name: 'video.production.shots' })).kind).toBe('allow');
    expect((await s.invoke({ name: 'video.productionOther.shots' })).kind).toBe('deny');
  });
  it.each([{ when: 'params.amount > 0' }, { match: { actions: ['bash'], object_types: ['video_project'] } }, { match: { actions: ['bash'], identity: 'owner' } }])('does not treat unevaluated business constraints as auto %j', async extra => {
    const source = await rules([{ ...auto, ...extra }]); const r = runtime({ rulesUrl: source.url });
    expect(await r.invoke()).toMatchObject({ kind: 'deny', reason: expect.stringContaining('SERVICE_EVALUATION') }); expect(r.next).not.toHaveBeenCalled();
  });
  it('revocation and HTTP outage are effective at the next call instead of reusing a previous allow cache', async () => {
    let current = [auto]; let failed = false;
    const source = await endpoint(res => { res.statusCode = failed ? 503 : 200; res.end(JSON.stringify(current)); });
    const r = runtime({ rulesUrl: source.url }); expect((await r.invoke()).kind).toBe('allow');
    current = [block]; expect((await r.invoke()).kind).toBe('deny');
    failed = true; expect((await r.invoke()).kind).toBe('deny'); expect(source.requests).toHaveLength(3); expect(r.next).toHaveBeenCalledTimes(1);
  });
  it('rejects HTTP errors, invalid JSON and oversize streamed bodies, never echoing body text', async () => {
    for (const mode of ['status', 'json', 'oversize']) {
      const source = await endpoint(res => { if (mode === 'status') res.statusCode = 403; res.end(mode === 'oversize' ? 'x'.repeat(600_000) : 'private-service-error-secret'); });
      const r = runtime({ rulesUrl: source.url }); const decision = await r.invoke();
      expect(decision.kind).toBe('deny'); expect(decision.reason).not.toContain('private-service'); expect(r.next).not.toHaveBeenCalled();
    }
  });
  it('does not forward authorization across redirect', async () => {
    const target = await rules([auto]); const source = await endpoint(res => { res.statusCode = 302; res.setHeader('location', target.url); res.end(); });
    const r = runtime({ rulesUrl: source.url }); expect((await r.invoke()).kind).toBe('deny'); expect(target.requests).toHaveLength(0);
  });
  it('timeout and caller cancellation both terminate rule fetch without dispatch', async () => {
    const source = await endpoint(() => undefined); const r = runtime({ rulesUrl: source.url, timeoutMs: 50 });
    expect((await r.invoke()).kind).toBe('deny'); expect(r.next).not.toHaveBeenCalled();
    const controller = new AbortController(); const pending = r.invoke({ name: 'bash', signal: controller.signal }); controller.abort();
    expect((await pending).kind).toBe('cancel'); expect(r.next).not.toHaveBeenCalled();
  });
  it('invalid tool identity and configuration do not contact the rule server', async () => {
    const source = await rules([auto]);
    for (const config of [{ timeoutMs: 0 }, { timeoutMs: Infinity }, { tokenEnv: 'bad-key' }, { requireAuth: 'false' }]) {
      const r = runtime({ rulesUrl: source.url, ...config }); expect((await r.invoke()).kind).toBe('deny');
    }
    const r = runtime({ rulesUrl: source.url }); for (const name of ['', '*', 'bash\nsecret']) expect((await r.invoke({ name })).kind).toBe('deny');
    expect(source.requests).toHaveLength(0);
  });
  it('concurrent calls independently revalidate and retain downstream failures', async () => {
    const source = await rules([auto]); const r = runtime({ rulesUrl: source.url });
    expect((await Promise.all(Array.from({ length: 20 }, () => r.invoke()))).every(decision => decision.kind === 'allow')).toBe(true);
    expect(source.requests).toHaveLength(20); expect(r.next).toHaveBeenCalledTimes(20);
    r.next.mockRejectedValueOnce(new Error('DOWNSTREAM_FAILED'));
    await expect(r.invoke()).rejects.toThrow('DOWNSTREAM_FAILED');
  });
});
