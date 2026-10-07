/** Provider wire negatives require neither paid calls nor a browser. */
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runChatTask, runImageTask, runVideoTask } from "./providers.mjs";
import { verifyExpectations } from "./verification.mjs";

const resolved = { ready: true, credentialEnv: "SYNTHETIC_API_KEY", model: "synthetic-model", baseUrl: "https://synthetic.invalid" };
const env = { SYNTHETIC_API_KEY: "synthetic-key" };
const originalFetch = globalThis.fetch;
function response(t, fn) { globalThis.fetch = fn; t.after(() => { globalThis.fetch = originalFetch; }); }
const wire = (overrides = {}) => ({ id: "synthetic-call", model: "synthetic-model", choices: [{ message: { content: "synthetic answer" } }], usage: { total_tokens: 15, prompt_tokens: 10, completion_tokens: 5 }, ...overrides });

test("gateway: complete identity and authoritative usage give a measured, synced receipt", async (t) => {
  response(t, async () => new Response(JSON.stringify(wire())));
  const result = await runChatTask({ resolved, env, prompt: "synthetic" }); assert.equal(result.status, "ok");
  assert.equal(result.called, true); assert.equal(result.usage.complete, true); assert.equal(result.tokens, 15); assert.equal(result.receipt.synced, true);
});

test("gateway: missing, coerced or contradictory usage stays blocked and is never reported as measured zero", async (t) => {
  for (const usage of [undefined, {}, { total_tokens: "15" }, { total_tokens: 14, prompt_tokens: 10, completion_tokens: 5 }, { total_tokens: -1 }]) {
    response(t, async () => new Response(JSON.stringify(wire({ usage }))));
    const result = await runChatTask({ resolved, env, prompt: "synthetic" }); assert.equal(result.status, "blocked");
    assert.equal(result.called, true); assert.equal(result.usage.complete, false); assert.equal(result.tokens, null); assert.equal(result.receipt.synced, false);
  }
});

test("gateway: missing response model/id and malformed JSON cannot borrow request identity for a passing receipt", async (t) => {
  for (const body of [JSON.stringify(wire({ model: undefined })), JSON.stringify(wire({ id: undefined })), "{broken"]) {
    response(t, async () => new Response(body)); const result = await runChatTask({ resolved, env, prompt: "synthetic" });
    assert.notEqual(result.status, "ok"); assert.notEqual(result.receipt?.synced, true);
  }
});

test("gateway: authentication, network and timeout failures preserve unknown usage after attempted I/O", async (t) => {
  for (const fn of [async () => new Response("synthetic denied", { status: 403 }), async () => { throw new Error("synthetic timeout"); }]) {
    response(t, fn); const result = await runChatTask({ resolved, env, prompt: "synthetic" }); assert.notEqual(result.status, "ok");
    assert.equal(result.called, true); assert.equal(result.usage.complete, false); assert.equal(result.tokens, null);
  }
});

test("gateway: missing credentials prevents external I/O and discloses that no call was admitted", async (t) => {
  let calls = 0; response(t, async () => { calls += 1; return new Response("unexpected"); });
  const result = await runChatTask({ resolved, env: {}, prompt: "synthetic" }); assert.equal(result.status, "blocked"); assert.equal(result.called, false); assert.equal(calls, 0);
});

async function mediaWire(t, handle) {
  const calls = [];
  const instance = http.createServer(async (req, res) => {
    let body = ""; for await (const bytes of req) body += bytes;
    calls.push({ method: req.method, url: req.url, body });
    handle(req, res, calls);
  });
  await new Promise((resolve) => instance.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { instance.close(resolve); instance.closeAllConnections(); }));
  return { calls, url: `http://127.0.0.1:${instance.address().port}` };
}
const reply = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const mediaArgs = (t, kind, url, extra = {}) => { const dir = mkdtempSync(join(tmpdir(), "wl-provider-journal-")); t.after(() => rmSync(dir, { recursive: true, force: true })); return ({ artifactsDir: dir, resolved: { ready: true, credentialEnv: "SYNTHETIC_API_KEY", model: "synthetic-model", baseUrl: url }, env,
  task: { id: kind === "image" ? "IMG-UNKNOWN" : "VID-UNKNOWN", prompt: "synthetic", images: 1, durationSeconds: 12 }, timeoutMs: 500, pollMs: 0, ...extra }); };

test("media usage: actual HTTP timeout never becomes measured zero image count or video duration", async (t) => {
  for (const kind of ["image", "video"]) {
    const wire = await mediaWire(t, () => {});
    const result = await (kind === "image" ? runImageTask : runVideoTask)(mediaArgs(t, kind, wire.url, { timeoutMs: 200 }));
    assert.equal(wire.calls.length, 1); assert.equal(result.called, true);
    assert.equal(result.measurementComplete, false); assert.equal(result.receipt.measurementComplete, false);
    assert.equal(kind === "image" ? result.produced : result.durationSeconds, null);
  }
});

test("media usage: an accepted asynchronous task with unreadable or timed out polling stays unmeasured", async (t) => {
  for (const failure of ["http", "timeout", "network", "failed", "wrong-task"]) {
    const wire = await mediaWire(t, (req, res) => {
      if (req.method === "POST") return reply(res, 200, { id: "synthetic-video-1" });
      if (failure === "timeout") return;
      if (failure === "network") return req.socket.destroy();
      if (failure === "http") return reply(res, 403, { error: "synthetic denied" });
      return reply(res, 200, { id: failure === "wrong-task" ? "other-task" : "synthetic-video-1", status: "failed", duration: 12 });
    });
    const result = await runVideoTask(mediaArgs(t, "video", wire.url));
    assert.equal(result.called, true); assert.equal(result.taskId, "synthetic-video-1");
    assert.equal(result.measurementComplete, false); assert.equal(result.durationSeconds, null);
    assert.equal(result.receipt.measurementComplete, false); assert.notEqual(result.status, "ok");
    assert.ok(wire.calls.some((call) => call.method === "GET"));
  }
});

test("media usage: a reported duration without a readable media file cannot borrow the requested seconds", async (t) => {
  for (const returnedDuration of [undefined, 12, "12", 0]) {
    const wire = await mediaWire(t, (req, res) => reply(res, 200, req.method === "POST" ? { id: "synthetic-video-1" }
      : { id: "synthetic-video-1", status: "succeeded", duration: returnedDuration, content: {} }));
    const result = await runVideoTask(mediaArgs(t, "video", wire.url));
    assert.equal(result.measurementComplete, false); assert.equal(result.durationSeconds, null);
    assert.equal(result.receipt.durationSeconds, null); assert.equal(result.receipt.measurementComplete, false);
  }
});

test("media usage: missing, coerced or contradictory image usage never turns returned URLs into complete supplier accounting", async (t) => {
  for (const usage of [undefined, {}, { generated_images: "1" }, { generated_images: -1 }, { generated_images: 0 }, { generated_images: 2 }]) {
    const wire = await mediaWire(t, (_req, res) => reply(res, 200, { usage, data: [{ url: "http://127.0.0.1:1/synthetic.png" }] }));
    const result = await runImageTask(mediaArgs(t, "image", wire.url));
    assert.equal(result.called, true); assert.equal(result.measurementComplete, false); assert.equal(result.produced, null);
    assert.equal(result.receipt.measurementComplete, false); assert.equal(wire.calls.length, 1);
  }
});

test("media usage: an explicit supplier zero is measured independently from successful delivery", async (t) => {
  const wire = await mediaWire(t, (_req, res) => reply(res, 200, { usage: { generated_images: 0 }, data: [{ error: { message: "synthetic rejected image" } }] }));
  const result = await runImageTask(mediaArgs(t, "image", wire.url));
  assert.equal(result.measurementComplete, true); assert.equal(result.produced, 0); assert.notEqual(result.status, "ok");
  assert.equal(result.receipt.measurementComplete, true); assert.equal(result.receipt.synced, false);
});

test("media identity: image receipts retain returned model identity and never borrow the requested model", async (t) => {
  for (const model of [undefined, "actual-returned-model", 42, " "]) {
    const wire = await mediaWire(t, (req, res) => req.method === "POST"
      ? reply(res, 200, { model, usage: { generated_images: 1 }, data: [{ url: `${wire.url}/unreadable.png` }] })
      : reply(res, 403, { error: "synthetic delivery denied" }));
    const result = await runImageTask(mediaArgs(t, "image", wire.url));
    const actual = typeof model === "string" && model.trim() ? model.trim() : null;
    assert.equal(result.model, actual); assert.equal(result.receipt.model, actual); assert.equal(result.receipt.requestedModel, resolved.model);
    assert.equal(result.measurementComplete, true); assert.equal(result.produced, 1); assert.notEqual(result.status, "ok");
  }
});

test("media identity: only the same video task can supply returned model identity", async (t) => {
  for (const model of [undefined, "actual-returned-model", 42, " "]) {
    const wire = await mediaWire(t, (req, res) => reply(res, 200, req.method === "POST" ? { id: "synthetic-video-1" }
      : { id: "synthetic-video-1", status: "succeeded", model, duration: 12, content: {} }));
    const result = await runVideoTask(mediaArgs(t, "video", wire.url));
    const actual = typeof model === "string" && model.trim() ? model.trim() : null;
    assert.equal(result.model, actual); assert.equal(result.receipt.model, actual); assert.equal(result.receipt.requestedModel, resolved.model);
    assert.equal(result.measurementComplete, false); assert.equal(result.durationSeconds, null);
  }
});

test("model identity: an actual returned route must match the declared model or an explicit exact allowedModels list", async (t) => {
  response(t, async () => new Response(JSON.stringify(wire({ model: "actual-returned-model" }))));
  const result = await runChatTask({ resolved, env, prompt: "synthetic" }); assert.equal(result.status, "ok");
  const task = { kind: "llm", expectedModel: resolved.model };
  assert.equal((await verifyExpectations(task, result)).ok, false);
  assert.equal((await verifyExpectations({ ...task, allowedModels: ["actual-returned-model"] }, result)).ok, true);
  for (const allowedModels of ["actual-returned-model", ["actual-returned"], [42], [" "]]) assert.equal((await verifyExpectations({ ...task, allowedModels }, result)).ok, false);
});

test("media recovery: accepted video polling failures resume the same ID with no second POST", async t => {
  const wire = await mediaWire(t, (req, res) => reply(res, req.method === "POST" ? 200 : 403,
    req.method === "POST" ? { id: "synthetic-resume-video" } : { error: "synthetic polling denied" }));
  const args = mediaArgs(t, "video", wire.url);
  const first = await runVideoTask(args), second = await runVideoTask({ ...args, resumeOnly: true });
  assert.equal(first.taskId, "synthetic-resume-video"); assert.equal(second.taskId, first.taskId);
  assert.equal(wire.calls.filter(call => call.method === "POST").length, 1);
  assert.equal(wire.calls.filter(call => call.method === "GET").length, 2);
  assert.equal(first.submittedCalls, 1); assert.equal(second.submittedCalls, 0); assert.equal(second.resumed, true);
  assert.equal(second.measurementComplete, false); assert.equal(second.durationSeconds, null);
});

test("media admission: missing durable directory and changed task inputs cannot send a POST", async t => {
  const wire = await mediaWire(t, (_req, res) => reply(res, 200, { model: "synthetic-model", usage: { generated_images: 0 }, data: [] }));
  const args = mediaArgs(t, "image", wire.url);
  for (const run of [runImageTask, runVideoTask]) {
    const result = await run({ ...args, artifactsDir: undefined });
    assert.equal(result.status, "blocked"); assert.equal(result.called, false);
  }
  assert.equal(wire.calls.length, 0);
  await runImageTask(args);
  const changed = await runImageTask({ ...args, task: { ...args.task, prompt: "changed synthetic request" } });
  assert.equal(changed.status, "blocked"); assert.equal(changed.called, false);
  assert.equal(wire.calls.length, 1);
});

test("media recovery: partial image rounds reuse the first response and never resubmit an unknown second round", async t => {
  const wire = await mediaWire(t, (req, res, calls) => {
    if (calls.filter(call => call.method === "POST").length === 2) return req.socket.destroy();
    reply(res, 200, { model: "synthetic-model", usage: { generated_images: 1 }, data: [{ url: `${wire.url}/synthetic-image.png` }] });
  });
  const args = mediaArgs(t, "image", wire.url, { task: { id: "IMG-PARTIAL-RESUME", prompt: "synthetic", images: 2 } });
  const first = await runImageTask(args), second = await runImageTask({ ...args, resumeOnly: true });
  assert.equal(first.measurementComplete, false); assert.equal(second.measurementComplete, false);
  assert.equal(first.knownProduced, 1); assert.equal(second.knownProduced, 1);
  assert.equal(wire.calls.filter(call => call.method === "POST").length, 2);
  assert.equal(first.submittedCalls, 2); assert.equal(second.submittedCalls, 0); assert.equal(second.resumedCalls, 1);
});
