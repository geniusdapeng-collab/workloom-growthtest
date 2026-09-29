/** 实际发行/验签/文件/监制代码；PG 为明确 SQL 边界替身，模型 HTTP 仅返回测试裁决。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type pg from "pg";
import { applyScenePolicy, auditScenePolicy, loadScenePolicies, type ScenePolicyShot } from "@hyperreality/video-studio";
import { authorizeRenderSubmission, loadQualifiedRenderInput, listProductionShots, qualifyProductionShot } from "./production-authority.js";
import { renderSha256 } from "./gen/compiled-request.js";
import { submitGenJob } from "./gen/submit.js";

vi.mock("@workloom/base/workdata", () => ({ gatewayAppendOnClient: vi.fn() }));
const env = { WORKLOOM_RENDER_SIGNING_SECRET: "unit-test-render-signing-key-with-32-bytes", VOLCENGINE_ARK_API_KEY: "unit-test-provider",
  LLM_BASE_URL: "https://judge.example.test", LLM_API_KEY: "unit-test-judge", LLM_MODEL: "test-judge" };
const scope = { tenantId: "tenant-a", workspaceId: "ws-a" };
const gates = ["G2_THEME", "G3_INSIGHT", "G4_PRD", "G5_PORTRAIT", "G6_PROMPT", "G7_FINAL"];
type Row = Record<string, any>;
class MemoryPool {
  source: Row = {}; selection: Row | null = null; qualifications: Row[] = []; scripts: Row[] = []; submissionState = "";
  locked = false; busy = false; unlockFails = false; releases: boolean[] = [];
  asPool() { return this as unknown as pg.Pool; }
  async connect() { return { query: this.query.bind(this), release: (discard = false) => { this.releases.push(discard); } }; }
  async query(sql: string, values: any[] = []) {
    let rows: Row[] = [];
    if (sql.startsWith("SELECT pg_try_advisory")) { this.locked = !this.busy; rows = [{ ok: !this.busy }]; }
    else if (sql.startsWith("SELECT pg_advisory_unlock")) { this.locked = false; if (this.unlockFails) throw new Error("unlock failure"); rows = [{ ok: true }]; }
    else if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("set_config")) { /* transaction shell */ }
    else if (sql.includes("SELECT r.*,p.kind")) rows = values[0] === scope.tenantId && values[1] === scope.workspaceId && values[2] === this.source.project_id ? [this.source] : [];
    else if (sql.includes("FROM biz_events") && sql.includes("video.scene_policy.selected")) rows = this.selection
      && values[0] === scope.tenantId && values[1] === scope.workspaceId && values[2] === this.source.project_id
      ? [{ after: this.selection }] : [];
    else if (sql.includes("SELECT q.*,s.state AS submission_state")) rows = this.submissionState ? this.qualifications.filter(row => row.payload_hash === values[5] && row.source_stage_run_id === values[4] && ["submitting", "unknown", "accepted", "finalized"].includes(this.submissionState)).slice(-1) : [];
    else if (sql.includes("INSERT INTO render_scripts")) this.scripts.push({ id: values[0], workspace_id: values[1], project_id: values[2], shot_id: values[3], script_key: values[4], version: 1, status: "draft", md: values[5], fields: JSON.parse(values[6]), created_by: values[7] });
    else if (sql.includes("INSERT INTO production_qualifications")) {
      const names = ["id","tenant_id","workspace_id","project_id","shot_id","source_stage_run_id","source_attempt","source_output_sha256","prompts_sha256","script_id","script_version","model_id","provider","provider_model","request_hash","payload_hash","compiled_request","params","mode","status","producer_verdict","issuer","key_id","signature","issued_at","expires_at","created_by"];
      const row: Row = { seq: String(this.qualifications.length + 1) };
      names.forEach((name, i) => { row[name] = ["compiled_request","params","producer_verdict"].includes(name) ? JSON.parse(values[i]) : values[i]; });
      this.qualifications.push(row);
    } else if (sql.startsWith("SELECT * FROM production_qualifications")) rows = this.qualifications.filter(row => row.tenant_id === values[0] && row.workspace_id === values[1] && row.id === values[2]);
    else if (sql.includes("SELECT state FROM generation_submissions")) rows = this.submissionState ? [{ state: this.submissionState }] : [];
    else if (sql.includes("SELECT id FROM production_qualifications")) rows = this.qualifications.filter(row => row.tenant_id === values[0] && row.workspace_id === values[1] && row.project_id === values[2] && row.shot_id === values[3]).slice(-1);
    else if (sql.includes("SELECT id,project_id,shot_id,script_key")) rows = this.scripts.filter(row => row.workspace_id === values[0] && row.id === values[1] && row.project_id === values[2] && row.version === values[3]);
    else throw new Error(`Unexpected SQL in authority test: ${sql.slice(0, 80)}`);
    return { rows: structuredClone(rows), rowCount: rows.length };
  }
}
let dir: string, root: string, pool: MemoryPool, output: Row, prompts: Row;
let judge = { approved: true, score: 95, issues: [] as string[], suggestions: [] as string[], reason: "完整内容符合镜头计划" };
let calls: Array<{ url: string; body: Row }>;
async function persist() {
  const promptsFile = path.join(root, "stages/preproduction/attempt-1.prompts.json");
  const promptBytes = JSON.stringify(prompts); await writeFile(promptsFile, promptBytes);
  output.promptsSha256 = renderSha256(promptBytes);
  const bytes = JSON.stringify(output); await writeFile(path.join(root, pool.source.output_ref), bytes);
  pool.source.output_sha256 = renderSha256(bytes);
}
async function installCommercialScenePolicy() {
  const policy = loadScenePolicies(path.resolve(import.meta.dirname, "../../../../bundles/ai-video/library/scene-policies"))
    .find(item => item.id === "commercial-person")!;
  const decision = { id: policy.id, version: policy.version, sourceSha256: policy.sourceSha256!, reason: "原始需求明确为正式商务短片", evidence: ["title:正式商务短片"] };
  pool.selection = { runId: pool.source.run_id, ...decision };
  const specs: Array<[string[], string, string?]> = [
    [["wide", "moving"], "大场面全景，人物站在大厅中央", "缓推镜展示空间纵深"],
    [["wide"], "广角全景，人物站在空间视觉主导位"],
    [["medium", "moving"], "半身中景，人物与实体材质同框", "轨道移镜围绕访谈位"],
    [["medium"], "腰部以上中景，人物与实体墙屏同框"],
    [["medium"], "膝上中景，人物站在会客厅首层"],
    [["person-close", "moving"], "面部近景特写，神态沉稳", "轻推镜到人物双眼"],
    [["person-close"], "胸部以上人物特写，说明手势清晰"],
    [["person-close"], "面部近景，人物直视镜头"],
    [["environment-detail"], "实体羊毛经纬纹样特写与材质工艺微距"],
    [["environment-detail"], "胡桃木与大理石材质特写，人物不入镜"],
  ];
  const shots: ScenePolicyShot[] = specs.map(([tags, composition, camera], index) => {
    const shot: ScenePolicyShot = {
      shotId: `S${index + 1}`, duration: 5, policyTags: tags,
      scene: "明亮的别墅式企业会客厅首层正式访谈位",
      composition, camera_movement: camera ?? "固定访谈机位",
      costume: "合体商务正装，衣料挺括整洁",
      speechMode: tags.includes("environment-detail") ? "voice-over" : "on-camera",
      speechScene: "interview", dialogue: [{ speaker: "主讲人", text: "欢迎了解方案。" }],
      action: [
        "正面直视镜头，以坚定眼神和从容停掌开始口播",
        "镜头从45°侧前方看她自然微笑",
        "侧面轮廓可辨，她用一个小手势说明重点",
        "背影气场后转身，留下沉思瞬间",
      ][index] ?? "自然讲述并保持专业气质",
      ...(index === 8 ? { props: "实体羊毛交织纹样与材质工艺" } : {}),
    };
    return applyScenePolicy({ ...shot, prompt: `${shot.scene}；${shot.composition}` }, policy);
  });
  const title = "正式商务短片";
  const report = auditScenePolicy({ title, shots }, policy);
  expect(report.passed).toBe(true);
  report.policy.selection = decision.reason;
  const shotlist = { title, scenePolicy: { ...decision, exceptions: [] }, scenePolicySelection: decision, draft: true, shots };
  prompts = { stageId: "preproduction", attempt: 1, pipelineKind: "narrative", scenePolicy: decision,
    shots: shots.map(shot => ({ shotId: shot.shotId, durationSec: shot.duration, degraded: false,
      prompt: shot.prompt, fields: { scene: shot.scene, durationSec: shot.duration } })) };
  const reportBytes = JSON.stringify(report), shotlistBytes = JSON.stringify(shotlist);
  await writeFile(path.join(root, "stages/preproduction/attempt-1.scene-policy-report.json"), reportBytes);
  await writeFile(path.join(root, "stages/preproduction/attempt-1.shotlist.json"), shotlistBytes);
  Object.assign(output, { scenePolicyPassed: true,
    scenePolicyReportRef: "stages/preproduction/attempt-1.scene-policy-report.json",
    scenePolicyReportSha256: renderSha256(reportBytes),
    shotlistRef: "stages/preproduction/attempt-1.shotlist.json",
    shotlistSha256: renderSha256(shotlistBytes) });
  await persist();
  return { policy, decision, report, shotlist };
}
function issue(patch: Partial<Parameters<typeof qualifyProductionShot>[0]> = {}) {
  return qualifyProductionShot({ app: pool.asPool(), scope, actor: "MEM-ORIGINAL", projectId: "P1", shotId: "S1",
    modelId: "doubao-seedance-2-5", params: { aspectRatio: "16:9" }, env, workDir: dir, ...patch });
}
async function authorized(token: string, patch: Record<string, unknown> = {}) {
  const input = await loadQualifiedRenderInput(pool.asPool(), scope, token, env);
  return authorizeRenderSubmission({ app: pool.asPool(), scope, ...input, qualificationToken: token, env, workDir: dir, ...patch });
}
beforeEach(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "authority-unit-")));
  root = path.join(dir, "archive", scope.workspaceId, "P1"); await mkdir(path.join(root, "stages/preproduction"), { recursive: true });
  pool = new MemoryPool(); pool.source = { id: "SR1", workspace_id: scope.workspaceId, project_id: "P1", stage_id: "preproduction", attempt: 1, status: "done",
    output_ref: "stages/preproduction/attempt-1.output.json", output_sha256: "", run_id: "RUN1", kind: "narrative" };
  pool.selection = { runId: "RUN1", id: null, version: null, sourceSha256: null, reason: "未命中", evidence: [] };
  const proofs: Row[] = [];
  for (const gate of gates) {
    const file = path.join(dir, "workspaces", scope.workspaceId, "gates", "P1", "attempt-1", `${gate}.md`);
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, "真实的完整门内容。".repeat(30));
    proofs.push({ gate, status: "passed", approved: true, via: "llm", degraded: false, model: "test-judge",
      evidence: [{ path: file, sha256: renderSha256(await readFile(file)), scope: "complete-text" }] });
  }
  proofs[3] = { gate: "G5_PORTRAIT", status: "not_applicable", approved: true, basis: "no-characters-or-products" };
  prompts = { stageId: "preproduction", attempt: 1, pipelineKind: "narrative", shots: [{ shotId: "S1", durationSec: 5, degraded: false,
    prompt: "01.【场景】固定机位，窗边玻璃杯。".repeat(80), fields: { scene: "窗边玻璃杯", durationSec: 5 } }] };
  output = { success: true, degraded: false, promptsRef: "stages/preproduction/attempt-1.prompts.json",
    productionEvidence: { schemaVersion: "workloom.preproduction-authority/v1", issuer: "workloom.studio-worker", ...scope,
      projectId: "P1", runId: "RUN1", attempt: 1, pipelineKind: "narrative", gates: proofs } };
  await persist(); calls = []; judge = { approved: true, score: 95, issues: [], suggestions: [], reason: "完整内容符合镜头计划" };
  vi.stubGlobal("fetch", vi.fn(async (url, init) => { calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(judge) } }] })); }));
});
afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

describe("正式资格的正常路径和来源边界", () => {
  it("实际审核完整供应商请求后签发；加载出的脚本来自档案；提交持锁验真", async () => {
    const result = await issue();
    expect(result).toMatchObject({ scriptVersion: 1, params: { durationSec: 5, aspectRatio: "16:9" } });
    expect(pool.qualifications).toHaveLength(1); expect(pool.qualifications[0]?.status).toBe("passed");
    expect(calls).toHaveLength(1); expect(calls[0]?.url).toBe("https://judge.example.test/chat/completions");
    const content = JSON.stringify(calls[0]?.body.messages);
    expect(content).toContain("bodyJson"); expect(content).toContain("contents/generations/tasks"); expect(content).toContain(prompts.shots[0].prompt);
    const fullEvidence = calls[0]!.body.messages[0].content.find((item: Row) => item.text?.startsWith("以下是产物正文（完整）：")).text;
    expect(JSON.parse(fullEvidence.slice(fullEvidence.indexOf("\n") + 1)).compiledRequest.bodyJson).toBe(pool.qualifications[0]!.compiled_request.bodyJson);
    const loaded = await loadQualifiedRenderInput(pool.asPool(), scope, result.qualificationToken, env);
    expect(loaded.script.md).toBe(prompts.shots[0].prompt); expect(loaded.script.status).toBe("draft");
    const auth = await authorized(result.qualificationToken); expect(pool.locked).toBe(true);
    expect(auth.requestHash).toBe(result.requestHash); await auth.release(); expect(pool.locked).toBe(false);
  });
  it("营销不能只改kind复用叙事六门，必须本次G1和事实包", async () => {
    pool.source.kind = "marketing"; output.productionEvidence.pipelineKind = "marketing"; prompts.pipelineKind = "marketing";
    await persist(); await expect(issue()).rejects.toThrow("PREPRODUCTION_GATES_UNVERIFIED"); expect(calls).toHaveLength(0);
  });
  it("当前服务镜头列表无需 CMS 行；按完整档案读取 prompt/fields/时长及摘要", async () => {
    const listed = await listProductionShots({ app: pool.asPool(), scope, projectId: "P1", workDir: dir });
    expect(listed).toMatchObject({ projectId: "P1", sourceStageRunId: "SR1", sourceAttempt: 1,
      shots: [{ shotId: "S1", durationSec: 5, prompt: prompts.shots[0].prompt, fields: prompts.shots[0].fields, promptSha256: renderSha256(prompts.shots[0].prompt) }] });
    expect(pool.scripts).toHaveLength(0); expect(calls).toHaveLength(0);
  });
  it.each(["submitting", "unknown", "accepted", "finalized"])("%s 后重发相同签发请求复用旧资格，不通过随机scriptId重复烧额度", async state => {
    const original = await issue(); pool.submissionState = state;
    const retry = await issue(); expect(retry).toEqual(original); expect(pool.qualifications).toHaveLength(1); expect(calls).toHaveLength(1);
  });
  it.each(["missing", "failed", "old-evidence", "missing-gate", "auto", "degraded", "fields-trimmed", "missing-shot", "duplicate-shot"])("来源 %s 不得签发或调用监制", async kind => {
    if (kind === "missing") pool.source.status = "running";
    if (kind === "failed") output.success = false;
    if (kind === "old-evidence") delete output.productionEvidence;
    if (kind === "missing-gate") output.productionEvidence.gates.pop();
    if (kind === "auto") output.productionEvidence.gates[0].via = "auto";
    if (kind === "degraded") prompts.shots[0].degraded = true;
    if (kind === "fields-trimmed") prompts.fieldsTrimmed = true;
    if (kind === "missing-shot") prompts.shots = [];
    if (kind === "duplicate-shot") prompts.shots.push({ ...prompts.shots[0] });
    await persist(); await expect(issue()).rejects.toThrow(); expect(calls).toHaveLength(0); expect(pool.qualifications).toHaveLength(0);
  });
  it.each(["output", "prompts", "gate"])("%s 的字节变化即阻止签发", async kind => {
    const file = kind === "output" ? path.join(root, pool.source.output_ref) : kind === "prompts" ? path.join(root, output.promptsRef) : output.productionEvidence.gates[0].evidence[0].path;
    await writeFile(file, "changed"); await expect(issue()).rejects.toThrow("SOURCE_HASH_MISMATCH"); expect(calls).toHaveLength(0);
  });
  it("同内容的越界/符号链接证据也拒绝", async () => {
    const file = path.join(root, output.promptsRef), outside = path.join(dir, "outside.json");
    await writeFile(outside, await readFile(file)); await rm(file); await symlink(outside, file);
    await expect(issue()).rejects.toThrow("SOURCE_PATH_INVALID");
  });
  it("不同scope不能读源；无签密钥不消耗审核调用", async () => {
    await expect(issue({ scope: { tenantId: "other", workspaceId: "ws-a" } })).rejects.toThrow("PREPRODUCTION_REQUIRED");
    await expect(issue({ env: { ...env, WORKLOOM_RENDER_SIGNING_SECRET: "short" } })).rejects.toThrow("QUALIFICATION_SIGNING_UNAVAILABLE");
    expect(calls).toHaveLength(0);
  });
  it("计划时长、完整提示词上限和extra覆盖在审核前拒绝", async () => {
    await expect(issue({ params: { durationSec: 6 } })).rejects.toThrow("SOURCE_DURATION_MISMATCH");
    await expect(issue({ params: { extra: { prompt: "伪造" } } })).rejects.toThrow("REQUEST_INVALID");
    prompts.shots[0].prompt = "字".repeat(100_000); await persist(); await expect(issue()).rejects.toThrow("PROMPT_TOO_LONG");
    expect(calls).toHaveLength(0);
  });
});

describe("商业真人片型的选型账本与 G8 供应商提交硬闸", () => {
  it("当前选型事件、完整片单配比、报告与逐镜提示词同源时才签发，并在提交前重验", async () => {
    await installCommercialScenePolicy();
    const result = await issue();
    expect(result).toMatchObject({ scriptVersion: 1, params: { durationSec: 5 } });
    expect(pool.qualifications).toHaveLength(1);
    const auth = await authorized(result.qualificationToken);
    expect(auth.script.md).toBe(prompts.shots[0].prompt);
    await auth.release();
    expect(calls).toHaveLength(1);
  });

  it.each(["missing-event", "wrong-run", "null-bypass", "old-policy", "wrong-evidence", "missing-report-ref", "old-attempt"])(
    "%s 在模型评审前阻断，不得借旧报告或空选型绕过",
    async kind => {
      await installCommercialScenePolicy();
      if (kind === "missing-event") pool.selection = null;
      if (kind === "wrong-run") pool.selection!.runId = "RUN-OLDER";
      if (kind === "null-bypass") pool.selection = { runId: "RUN1", id: null, version: null, sourceSha256: null, reason: "未命中", evidence: [] };
      if (kind === "old-policy") pool.selection!.sourceSha256 = "f".repeat(64);
      if (kind === "wrong-evidence") pool.selection!.evidence = ["另一份原始需求"];
      if (kind === "missing-report-ref") { delete output.scenePolicyReportRef; await persist(); }
      if (kind === "old-attempt") pool.source.attempt = 2;
      await expect(issue()).rejects.toThrow();
      expect(calls).toHaveLength(0);
      expect(pool.qualifications).toHaveLength(0);
    },
  );

  it("已通过报告不能掩盖被改写的完整片单，提示词包也不能悄悄换镜头", async () => {
    const { shotlist } = await installCommercialScenePolicy();
    shotlist.shots[0]!.policyTags = ["person-close"];
    const altered = JSON.stringify(shotlist);
    await writeFile(path.join(root, output.shotlistRef), altered);
    output.shotlistSha256 = renderSha256(altered);
    await persist();
    await expect(issue()).rejects.toThrow("SCENE_POLICY_UNVERIFIED");
    expect(calls).toHaveLength(0);

    await installCommercialScenePolicy();
    prompts.shots[0].prompt = "未经片型审计的替换提示词";
    await persist();
    await expect(issue()).rejects.toThrow("SCENE_POLICY_UNVERIFIED");
    expect(calls).toHaveLength(0);

    await installCommercialScenePolicy();
    prompts.shots[0].durationSec = 10;
    await persist();
    await expect(issue()).rejects.toThrow("SCENE_POLICY_UNVERIFIED");
    expect(calls).toHaveLength(0);
  });

  it("签发后报告原始字节变化使供应商提交失效", async () => {
    await installCommercialScenePolicy();
    const result = await issue();
    await writeFile(path.join(root, output.scenePolicyReportRef), "{}");
    await expect(authorized(result.qualificationToken)).rejects.toThrow("SOURCE_HASH_MISMATCH");
    expect(pool.locked).toBe(false);
  });
});

describe("资格失效、最新裁决与补账边界", () => {
  it("缺token/篡改/错租户/交付token都不能进入提交", async () => {
    const good = await issue(), input = await loadQualifiedRenderInput(pool.asPool(), scope, good.qualificationToken, env);
    for (const token of [undefined, "forged", good.qualificationToken.slice(0, -1) + (good.qualificationToken.endsWith("a") ? "b" : "a")]) {
      await expect(authorizeRenderSubmission({ ...input, app: pool.asPool(), scope, env, qualificationToken: token })).rejects.toThrow(/QUALIFICATION_(REQUIRED|INVALID)/);
    }
    await expect(loadQualifiedRenderInput(pool.asPool(), { ...scope, tenantId: "other" }, good.qualificationToken, env)).rejects.toThrow("QUALIFICATION_SCOPE_MISMATCH");
    const [raw, mac] = good.qualificationToken.split("."); const forged = JSON.parse(Buffer.from(raw!, "base64url").toString()); forged.purpose = "delivery";
    await expect(loadQualifiedRenderInput(pool.asPool(), scope, `${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${mac}`, env)).rejects.toThrow("QUALIFICATION_INVALID");
  });
  it("改正文/params/model/端点或换key都不能提交；失败会释放锁", async () => {
    const good = await issue(), original = await loadQualifiedRenderInput(pool.asPool(), scope, good.qualificationToken, env);
    for (const patch of [
      { script: { ...original.script, md: "改成手写" } }, { params: { ...original.params, seed: 42 } },
      { modelId: "doubao-seedance-2-0" }, { env: { ...env, SEEDANCE_ENDPOINT: "https://elsewhere.example.test" } },
      { idempotencyKey: "another-key" },
    ]) { await expect(authorized(good.qualificationToken, patch)).rejects.toThrow(/QUALIFICATION_(REQUEST|IDEMPOTENCY)_MISMATCH/); expect(pool.locked).toBe(false); }
  });
  it("过期、密钥轮换以及新源执行使未提交资格失效", async () => {
    const good = await issue();
    const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now + 31 * 60_000);
    await expect(authorized(good.qualificationToken)).rejects.toThrow("QUALIFICATION_EXPIRED"); vi.restoreAllMocks();
    await expect(loadQualifiedRenderInput(pool.asPool(), scope, good.qualificationToken, { ...env, WORKLOOM_RENDER_SIGNING_SECRET: "rotated-test-signing-key-with-more-than-32-bytes" })).rejects.toThrow("QUALIFICATION_INVALID");
    pool.source.status = "running"; await expect(authorized(good.qualificationToken)).rejects.toThrow("PREPRODUCTION_REQUIRED");
  });
  it("新审核打回仍只增保存，旧通过不可复用；模型不可用记录unverified", async () => {
    const good = await issue(); judge.approved = false; judge.score = 50;
    await expect(issue()).rejects.toThrow("PRODUCTION_REVIEW_REJECTED"); expect(pool.qualifications.map(row => row.status)).toEqual(["passed", "failed"]);
    await expect(authorized(good.qualificationToken)).rejects.toThrow("QUALIFICATION_SUPERSEDED");
    await expect(issue({ env: { ...env, LLM_API_KEY: "" } })).rejects.toThrow("PRODUCTION_REVIEW_UNVERIFIED");
    expect(pool.qualifications.at(-1)?.status).toBe("unverified"); expect(pool.scripts).toHaveLength(1);
  });
  it("审核期间产物变化拒绝签发，不能用审核开始时旧hash发证", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { await writeFile(path.join(root, output.promptsRef), "changed-during-review");
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(judge) } }] })); }));
    await expect(issue()).rejects.toThrow("SOURCE_HASH_MISMATCH"); expect(pool.qualifications).toHaveLength(0);
  });
  it("已accepted任务过期后可原内容补账，不再要求新源；改内容仍拒绝", async () => {
    const good = await issue(); pool.submissionState = "accepted"; pool.source.status = "failed";
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31 * 60_000);
    const auth = await authorized(good.qualificationToken, { env: { ...env, SEEDANCE_ENDPOINT: "https://new-endpoint.example.test" } });
    expect(auth.reconciliationOnly).toBe(true); await auth.release();
    await expect(authorized(good.qualificationToken, { params: { durationSec: 99 } })).rejects.toThrow("QUALIFICATION_REQUEST_MISMATCH");
  });
  it("项目忙时不调用审核，解锁失败销毁连接而不归还带锁连接", async () => {
    pool.busy = true; await expect(issue()).rejects.toThrow("QUALIFICATION_BUSY"); expect(calls).toHaveLength(0);
    pool.busy = false; const good = await issue(); const auth = await authorized(good.qualificationToken);
    pool.unlockFails = true; await expect(auth.release()).rejects.toThrow("unlock failure"); expect(pool.releases.at(-1)).toBe(true);
  });
  it("手写CMS脚本直调真实submit入口，在DB预占/供应商之前拒绝", async () => {
    await expect(submitGenJob({ app: pool.asPool(), gateway: pool.asPool(), scope, actor: "MEM-T", script: { id: "handwritten", project_id: "P1", shot_id: "S1", script_key: "handwritten", version: 1, status: "approved", md: "手写prompt", fields: {} },
      modelId: "doubao-seedance-2-5", params: { durationSec: 5 }, mode: "auto", fenceLevel: "auto", fenceImpacts: [], env })).rejects.toThrow("QUALIFICATION_REQUIRED");
    expect(calls).toHaveLength(0); expect(pool.qualifications).toHaveLength(0);
  });
});
