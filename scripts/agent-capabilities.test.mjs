import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { resolve, join, dirname } from "node:path";
import {
  CapabilityError, invokeCapability, loadCatalog, mcpTools, sanitizeErrorMessage, validateInput,
} from "./agent-capabilities.mjs";
import {
  productionStatus, deliveryInspect, productionPlan, VideoCapabilityError,
} from "../bundles/geo-growth/capabilities/video.mjs";

const root = resolve(import.meta.dirname, "..");
/**
 * 清单口径从本仓事实源推导（基座 ai-pm / 行业仓 geo-growth 等），
 * 避免把"基座只有 8 条"写死——行业仓会把行业清单合并进来（T-2026-1001-0008）。
 */
const productManifest = JSON.parse(readFileSync(resolve(root, "product.manifest.json"), "utf8"));
const bundleId = productManifest.defaultBundle;
const coreCatalog = JSON.parse(readFileSync(resolve(root, "scripts/agent-capabilities.core.json"), "utf8"));
const industryCatalogFile = resolve(root, "bundles", bundleId, "agent-capabilities.json");
const industryItems = existsSync(industryCatalogFile)
  ? JSON.parse(readFileSync(industryCatalogFile, "utf8")).capabilities ?? []
  : [];
const expectedTotal = coreCatalog.capabilities.length + industryItems.length;
const expectedEnabled = [...coreCatalog.capabilities, ...industryItems].filter((item) => item.enabled !== false).length;
const demoWorkspaceSlug = productManifest.demoWorkspaceSlug;
const demoMemberNo = productManifest.demoMemberNo;

async function testServer(handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: "http://127.0.0.1:" + server.address().port,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

test("catalog only publishes reviewed common capabilities in the base repo", async () => {
  const catalog = await loadCatalog(root);
  assert.equal(catalog.bundle, bundleId);
  assert.equal(catalog.entries.size, expectedTotal);
  assert.equal(mcpTools(catalog).length, expectedEnabled);
  assert.equal(catalog.entries.get("core.workspace.profile").transport.path, "workspace.profile");
});

test("CLI list accepts options without a positional capability ID", async () => {
  const child = spawn(process.execPath, [
    resolve(root, "scripts/workloom-agent.mjs"), "list", "--root", root,
  ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [exitCode] = await once(child, "exit");
  assert.equal(exitCode, 0, stderr);
  const result = JSON.parse(stdout);
  assert.equal(result.capabilities.length, expectedTotal);
});

test("input validation rejects missing and unexpected fields", async () => {
  const catalog = await loadCatalog(root);
  const descriptor = catalog.entries.get("core.threads.get");
  assert.throws(() => validateInput(descriptor, {}), /threadId 缺失/u);
  assert.throws(() => validateInput(descriptor, { threadId: "T-1", tenantId: "other" }), /tenantId 不允许/u);
  assert.deepEqual(validateInput(descriptor, { threadId: "T-1" }), { threadId: "T-1" });
});

test("loopback dev identity invokes the same tRPC procedure and returns structured result", async () => {
  const requests = [];
  const localTestToken = "test-only-local-token";
  const mock = await testServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, method: req.method, auth: req.headers.authorization, body });
    res.setHeader("content-type", "application/json");
    if (req.url === "/trpc/auth.loginAs") {
      res.end(JSON.stringify({ result: { data: { token: localTestToken } } }));
    } else if (req.url === "/trpc/workspace.profile") {
      res.end(JSON.stringify({ result: { data: { workspace: "demo" } } }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { message: "missing" } }));
    }
  });
  try {
    const catalog = await loadCatalog(root);
    const output = await invokeCapability(catalog, "core.workspace.profile", {}, {
      baseUrl: mock.url, env: {},
    });
    assert.equal(output.status, "succeeded");
    assert.equal(output.dataMode, "unverified");
    assert.deepEqual(output.result, { workspace: "demo" });
    assert.equal(requests[0].method, "POST");
    assert.deepEqual(JSON.parse(requests[0].body), {
      workspaceSlug: demoWorkspaceSlug, memberNo: demoMemberNo,
    });
    assert.equal(requests[1].method, "GET");
    assert.equal(requests[1].auth, `Bearer ${localTestToken}`);
  } finally {
    await mock.close();
  }
});

test("remote HTTP is rejected before any credential use", async () => {
  const catalog = await loadCatalog(root);
  await assert.rejects(
    invokeCapability(catalog, "core.workspace.profile", {}, {
      baseUrl: "http://example.com", env: { WORKLOOM_ACCESS_TOKEN: "test" },
    }),
    (error) => error instanceof CapabilityError && error.code === "INVALID_BASE_URL",
  );
});

test("error messages redact configured bearer and C tokens", () => {
  const token = "test-only-secret-token-12345";
  const output = sanitizeErrorMessage(new Error(`service echoed ${token} and Bearer ${token}`), {
    WORKLOOM_ACCESS_TOKEN: token,
    WORKLOOM_C_TOKEN: "test-only-c-token-67890",
  });
  assert.ok(!output.includes(token));
  assert.match(output, /\[REDACTED\]/u);
});

test("C service requires C token and uses same-origin path", async () => {
  const requests = [];
  const mock = await testServer((req, res) => {
    requests.push({ path: req.url, auth: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ticket: { id: "tck-1", status: "created" }, timeline: [] }));
  });
  const catalog = await loadCatalog(root);
  catalog.entries.set("growth.ticket.receipt", {
    id: "growth.ticket.receipt", version: "1.0.0", title: "工单回执",
    description: "读取本人工单", operation: "receipt", risk: "low", dataMode: "simulated",
    inputSchema: {
      type: "object", properties: { id: { type: "string" } },
      required: ["id"], additionalProperties: false,
    },
    transport: { kind: "c-service", path: "/c/tickets/{id}", method: "GET" },
  });
  try {
    await assert.rejects(
      invokeCapability(catalog, "growth.ticket.receipt", { id: "tck-1" }, { baseUrl: mock.url, env: {} }),
      (error) => error.code === "UNAUTHORIZED",
    );
    const output = await invokeCapability(catalog, "growth.ticket.receipt", { id: "tck-1" }, {
      baseUrl: mock.url, env: { WORKLOOM_C_TOKEN: "c-test-token" },
    });
    assert.equal(output.receipt.synced, false);
    assert.equal(output.dataMode, "simulated");
    assert.deepEqual(requests, [{ path: "/c/tickets/tck-1", auth: "Bearer c-test-token" }]);
  } finally {
    await mock.close();
  }
});

test("disabled writes and missing idempotency keys fail before network", async () => {
  const catalog = await loadCatalog(root);
  const descriptor = {
    id: "growth.ticket.execute", operation: "execute", risk: "moderate", dataMode: "simulated",
    inputSchema: { type: "object", properties: {
      idempotencyKey: { type: "string" },
    }, required: ["idempotencyKey"], additionalProperties: false },
    transport: { kind: "c-service", path: "/c/tickets", method: "POST" },
  };
  catalog.entries.set(descriptor.id, { ...descriptor, enabled: false, disabledReason: "隔离修复未发布" });
  await assert.rejects(
    invokeCapability(catalog, descriptor.id, { idempotencyKey: "abcdefgh" }),
    (error) => error.code === "DISABLED",
  );
  catalog.entries.set(descriptor.id, descriptor);
  await assert.rejects(
    invokeCapability(catalog, descriptor.id, {}),
    (error) => error.code === "INVALID_INPUT",
  );
});

test("MCP stdio lists only enabled tools and keeps stdout as JSON-RPC", async () => {
  const child = spawn(process.execPath, [resolve(root, "scripts/workloom-agent-mcp.mjs")], {
    cwd: root, stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stdin.write(JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
  child.stdin.end();
  const [exitCode] = await once(child, "exit");
  assert.equal(exitCode, 0);
  const lines = stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].result.protocolVersion, "2025-11-25");
  assert.equal(lines[1].result.tools.length, expectedEnabled);
  assert.equal(lines[1].result.tools[0].annotations.readOnlyHint, true);
});

function videoFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "video-capability-"));
  const overrides = {
    WORKLOOM_VIDEO_ARTIFACT_ROOT: dir,
    WORKLOOM_KEYS_FILE: join(dir, "test-keys.env"),
    VOLCENGINE_ARK_API_KEY: "test-only-render-key",
    WORKLOOM_VOICE_ENGINE: "mlx",
    WORKLOOM_VOICE_ENGINE_URL: "http://127.0.0.1:8099",
  };
  const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const put = (file, value) => {
    const absolute = join(dir, file); mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, typeof value === "string" ? value : JSON.stringify(value)); return absolute;
  };
  put("test-keys.env", "VOLCENGINE_ARK_API_KEY=test-only-render-key\n");
  const shots = { fps: 30, products: ["已声明商品"], shots: [{
    shotId: "S-01", duration: 5, speechMode: "on-camera", constraint: "30fps，单镜5秒",
    dialogue: [{ text: "服务更从容。", speaker: "CEO" }], action: "看向镜头开口", audio: "人物台词",
  }] };
  const route = { schemaVersion: "workloom.video-route-record/v1", decision: { route: "marketing", product: { name: "已声明商品" } } };
  put("work/film/shotlist.json", shots); put("work/route.json", route);
  return { dir, put, shots, route };
}
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

test("video status counts unique accepted task IDs, not failed, resumed or repeated stage rows", (t) => {
  const { put } = videoFixture(t);
  const rows = [
    { stage: "shot", invoked: true, ok: false, evidence: { taskId: "cgt-one" } },
    { stage: "shot", invoked: true, ok: false, evidence: { taskId: "cgt-one", resumed: true } },
    { stage: "shot", invoked: true, ok: true, evidence: { taskId: "cgt-one" } },
    { stage: "material-gen", invoked: true, ok: false, evidence: { taskId: "cgt-two" } },
    { stage: "material-gen", invoked: true, ok: false, evidence: { taskId: "cgt-two" } },
    { stage: "shot", invoked: true, ok: false, evidence: { error: "POST outcome unknown" } },
    { stage: "shot", invoked: true, ok: false, evidence: { taskId: "../fake-task" } },
    { stage: "shot", invoked: true, ok: false, evidence: { error: "AccountOverdue" } },
    { stage: "shot", invoked: true, ok: false, evidence: { error: "CANARY_ABORT: stop" } },
  ];
  put("work/logs/VID-TEST/stages.jsonl", rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const output = productionStatus({ projectId: "VID-TEST", workDir: "work" });
  assert.deepEqual(output.renderLedger, { renderAttempts: 2, rendersRejected: 1, platformRejections: 1, canaryAborts: 1 });
  assert.deepEqual(output.acceptedTaskIds, ["cgt-one", "cgt-two"]);
});

test("video status leaves acceptance unknown when invoked rows have no task ID", (t) => {
  const { put } = videoFixture(t);
  put("work/logs/VID-TEST/stages.jsonl", JSON.stringify({stage: "shot", invoked: true, ok: true}) + "\n");
  const output = productionStatus({projectId: "VID-TEST"});
  assert.equal(output.renderLedger.renderAttempts, 0);
  assert.equal(output.unacceptedRenderRecords, 1);
});

test("video delivery checks actual SHA-256 for entries and detects altered content", (t) => {
  const { put } = videoFixture(t);
  put("work/out/main.mp4", "altered media"); put("work/out/cover.png", "cover bytes");
  put("work/out/VID-TEST-delivery-manifest.json", { projectId: "VID-TEST", entries: [
    { label: "main", path: "work/out/main.mp4", sha256: digest("original media") },
    { label: "cover", path: "work/out/cover.png", sha256: digest("cover bytes") },
  ] });
  const output = deliveryInspect({ projectId: "VID-TEST" });
  assert.equal(output.integrity, "incomplete");
  assert.equal(output.files.find(file => file.label === "main").state, "sha256-mismatch");
  assert.equal(output.files.find(file => file.label === "cover").sha256, digest("cover bytes"));
});

test("video delivery merges asset hashes with legacy pointers and verifies a complete list", (t) => {
  const { put, dir } = videoFixture(t); put("work/out/main.mp4", "main bytes"); put("work/out/cover.png", "cover bytes");
  put("work/out/VID-TEST-delivery-manifest.json", { projectId: "VID-TEST",
    deliverable: { path: join(dir, "work/out/main.mp4"), sha256: digest("main bytes"), bytes: 10 },
    cover: { path: "work/out/cover.png" }, assets: [{path: "work/out/cover.png", sha256: digest("cover bytes")}],
  });
  const output = deliveryInspect({projectId: "VID-TEST"});
  assert.equal(output.integrity, "sha256-verified"); assert.equal(output.files.length, 2);
  assert.ok(output.files.every(file => file.state === "present" && file.verified === true));
});

test("video delivery never upgrades missing hashes, empty lists or malformed metadata to verified", (t) => {
  const { put } = videoFixture(t); put("work/out/main.mp4", "main bytes");
  put("work/out/VID-TEST-delivery-manifest.json", { deliverable: { path: "work/out/main.mp4" } });
  assert.equal(deliveryInspect({projectId: "VID-TEST"}).integrity, "unverified");
  for (const doc of [{entries: []}, {entries: [{sha256: digest("main bytes")}]}, {entries: [{path: "work/out/main.mp4", sha256: "bad"}]}]) {
    put("work/out/VID-TEST-delivery-manifest.json", doc);
    assert.equal(deliveryInspect({projectId: "VID-TEST"}).integrity, "incomplete");
  }
  put("work/out/VID-TEST-delivery-manifest.json", "null");
  assert.throws(() => deliveryInspect({projectId: "VID-TEST"}), VideoCapabilityError);
});

test("video delivery reports missing, directory and escaped assets without reading them", (t) => {
  const { put, dir } = videoFixture(t); mkdirSync(join(dir, "work/out/directory"), {recursive: true});
  symlinkSync(tmpdir(), join(dir, "work/out/escape"));
  put("work/out/VID-TEST-delivery-manifest.json", {entries: [
    {path: "work/out/missing", sha256: digest("")},
    {path: "work/out/directory", sha256: digest("")},
    {path: "work/out/escape/outside-file", sha256: digest("")},
  ]});
  const output = deliveryInspect({projectId: "VID-TEST"});
  assert.equal(output.integrity, "incomplete");
  assert.deepEqual(output.files.map(file => file.state), ["missing", "not-file", "out-of-root"]);
});

test("video delivery catches conflicting hashes, byte counts and malformed collections", (t) => {
  const { put } = videoFixture(t); put("work/out/main.mp4", "main bytes");
  const main = {path: "work/out/main.mp4", sha256: digest("main bytes")};
  for (const [doc, state] of [
    [{entries: [main, {...main, sha256: digest("other bytes")}]}, "invalid-metadata"],
    [{entries: [{...main, bytes: 1}]}, "size-mismatch"],
    [{entries: [{...main, bytes: -1}]}, "invalid-metadata"],
    [{entries: [main], variants: {}}, "invalid-metadata"],
    [{entries: [main], subtitles: {files: {}}}, "invalid-metadata"],
  ]) {
    put("work/out/VID-TEST-delivery-manifest.json", doc);
    const output = deliveryInspect({projectId: "VID-TEST"});
    assert.equal(output.integrity, "incomplete"); assert.ok(output.files.some(file => file.state === state));
  }
  put("work/out/VID-TEST-delivery-manifest.json", {projectId: "VID-OTHER", entries: [main]});
  assert.throws(() => deliveryInspect({projectId: "VID-TEST"}), /projectId/u);
});

test("video delivery hashes media larger than the JSON limit with bounded chunks and rejects soft links", (t) => {
  const { put, dir } = videoFixture(t); const bytes = Buffer.alloc(9 * 1024 * 1024, 0x5a);
  const target = join(dir, "work/out/main.mp4"); mkdirSync(dirname(target), {recursive: true}); writeFileSync(target, bytes);
  symlinkSync(target, join(dir, "work/out/linked.mp4"));
  put("work/out/VID-TEST-delivery-manifest.json", {entries: [{path: "work/out/main.mp4", sha256: digest(bytes)}]});
  assert.equal(deliveryInspect({projectId: "VID-TEST"}).integrity, "sha256-verified");
  put("work/out/VID-TEST-delivery-manifest.json", {entries: [{path: "work/out/linked.mp4", sha256: digest(bytes)}]});
  assert.equal(deliveryInspect({projectId: "VID-TEST"}).files[0].state, "not-file");
});

test("video plan exposes argv, follows declared fps and quotes shell metacharacters literally", (t) => {
  const { put, dir, shots, route } = videoFixture(t);
  const shotlistPath = "work/film/CEO's $(literal) shots.json", routePath = "work/route's file.json";
  put(shotlistPath, shots); put(routePath, route);
  const platform = "抖音'; $(printf injected); 文字";
  const output = productionPlan({projectId: "VID-TEST", shotlistPath, routePath, platform, outDir: "work/out with spaces"});
  assert.equal(output.previewOnly, true); assert.equal(output.executable, "pnpm");
  assert.ok(Array.isArray(output.argv)); assert.equal(output.workDir, root);
  assert.equal(output.argv[output.argv.indexOf("--fps") + 1], "30");
  assert.equal(output.argv[output.argv.indexOf("--platform") + 1], platform);
  assert.equal(output.argv[output.argv.indexOf("--shots") + 1], join(dir, shotlistPath));
  const parsed = execFileSync("/bin/sh", ["-c", `set -- ${output.recommendedCommand}; printf '%s\\0' "$@"`], {encoding: "utf8"}).split("\0").filter(Boolean);
  assert.deepEqual(parsed, [output.executable, ...output.argv]);
});

test("video plan reads fps from all authored constraints and rejects contradictory or absent rates", (t) => {
  const { put, shots } = videoFixture(t);
  delete shots.fps; shots.shots[0].constraint = "25fps"; put("work/film/shotlist.json", shots);
  let output = productionPlan({projectId: "VID-TEST"});
  assert.equal(output.fps, 25); assert.equal(output.argv[output.argv.indexOf("--fps") + 1], "25");
  for (const doc of [ {...shots, fps: 30}, {...shots, fps: 0}, {...shots, shots: [{...shots.shots[0], constraint: "未声明帧率"}]}, {...shots, shots: [{...shots.shots[0], constraint: "-30fps"}]} ]) {
    put("work/film/shotlist.json", doc); output = productionPlan({projectId: "VID-TEST"});
    assert.equal(output.ready, false); assert.equal(output.recommendedCommand, null);
    assert.equal(output.checklist.find(check => check.id === "fps").ok, false);
  }
});

test("video plan parses shot structure and fails closed for malformed or empty cards", (t) => {
  const { put, shots } = videoFixture(t);
  for (const doc of ["{", "null", {shots: []}, {...shots, shots: [shots.shots[0], shots.shots[0]]}, {...shots, shots: [{...shots.shots[0], duration: 0}]}]) {
    put("work/film/shotlist.json", doc);
    const output = productionPlan({projectId: "VID-TEST"});
    assert.equal(output.ready, false); assert.equal(output.checklist.find(check => check.id === "shotlist").ok, false);
  }
});

test("video plan rejects clarify, explainer, invalid-schema and anchorless marketing routes", (t) => {
  const { put, route, shots } = videoFixture(t);
  for (const doc of [ {...route, decision: {route: "clarify"}}, {...route, decision: {route: "explainer"}}, {...route, schemaVersion: "unknown"}, "{" ]) {
    put("work/route.json", doc); const output = productionPlan({projectId: "VID-TEST"});
    assert.equal(output.ready, false); assert.equal(output.checklist.find(check => check.id === "route").ok, false);
  }
  put("work/route.json", route); put("work/film/shotlist.json", {...shots, products: []});
  assert.equal(productionPlan({projectId: "VID-TEST"}).checklist.find(check => check.id === "route").ok, false);
});

test("video plan checks audio contract conflicts and only reports local ASR configuration", (t) => {
  const { put, shots } = videoFixture(t);
  const blocked = productionPlan({projectId: "VID-TEST", unifiedNarration: true});
  assert.equal(blocked.ready, false); assert.equal(blocked.checklist.find(check => check.id === "audio-contract").ok, false);
  for (const [kind, url] of [["mock", "http://127.0.0.1:8099"], ["openai", "https://external.example"], ["mlx", "http://secret:token@127.0.0.1:8099"]]) {
    process.env.WORKLOOM_VOICE_ENGINE = kind; process.env.WORKLOOM_VOICE_ENGINE_URL = url;
    const output = productionPlan({projectId: "VID-TEST"});
    assert.equal(output.ready, false); assert.equal(output.checklist.find(check => check.id === "local-asr").ok, false);
    assert.ok(!JSON.stringify(output).includes("secret:token"));
  }
  process.env.WORKLOOM_VOICE_ENGINE = "mlx"; process.env.WORKLOOM_VOICE_ENGINE_URL = "http://127.0.0.1:8099";
  shots.shots[0] = {...shots.shots[0], speechMode: "voice-over", action: "不开口说话", audio: "画外音"};
  put("work/film/shotlist.json", shots); const output = productionPlan({projectId: "VID-TEST", unifiedNarration: true});
  assert.equal(output.checklist.find(check => check.id === "audio-contract").ok, true);
  assert.equal(output.localAsr.runtimeVerified, false); assert.equal(output.argv.includes("--narration-unified"), true);
});

test("video plan rejects disabled native audio and unsafe paths before any runtime call", (t) => {
  const { dir } = videoFixture(t); const previous = process.env.SEEDANCE_GENERATE_AUDIO; process.env.SEEDANCE_GENERATE_AUDIO = "0";
  t.after(() => { if (previous === undefined) delete process.env.SEEDANCE_GENERATE_AUDIO; else process.env.SEEDANCE_GENERATE_AUDIO = previous; });
  assert.equal(productionPlan({projectId: "VID-TEST"}).checklist.find(check => check.id === "audio-contract").ok, false);
  for (const input of [{outDir: "../escape"}, {workDir: "/tmp/outside"}, {projectId: "../other"}, {unifiedNarration: "true"}]) {
    assert.throws(() => productionPlan(input), VideoCapabilityError);
  }
  symlinkSync(tmpdir(), join(dir, "outside"));
  assert.throws(() => productionPlan({workDir: "outside/nonexistent/subdir"}), /符号链接/u);
});

test("video local capabilities stay read-only through the registered transport without any network", async (t) => {
  videoFixture(t); const catalog = await loadCatalog(root);
  for (const id of ["growth.video.route.record", "growth.video.production.status", "growth.video.delivery.inspect", "growth.video.production.plan"]) {
    const descriptor = catalog.entries.get(id); assert.notEqual(descriptor.operation, "execute");
    assert.equal(mcpTools(catalog).find(tool => tool.name === "workloom_" + id.replaceAll(".", "_")).annotations.readOnlyHint, true);
    const value = id.endsWith("plan") ? {projectId: "VID-TEST", unifiedNarration: false} : id.endsWith("record") ? {} : {projectId: "VID-TEST"};
    const output = await invokeCapability(catalog, id, value, {fetcher: async () => assert.fail("local capability must not fetch")});
    assert.equal(output.dataMode, "unverified"); assert.equal(output.status, "succeeded");
    if (id.endsWith("plan")) assert.equal(output.result.previewOnly, true);
  }
});
