import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript-governance";
import { freezeOriginalSubmission, issueOriginalRenderReceipt } from "./film-standard-post.mjs";
import { normalizeShotIntent, shotIntentHash } from "../../packages/video-studio/src/shot-intent.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ffmpeg = process.env.WL_FFMPEG ?? "ffmpeg";
const ffprobe = process.env.WL_FFPROBE ?? "ffprobe";
const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

type Card = Record<string, unknown>;
function runChain(shots: Card[], options: { stages?: string; args?: string[]; dir?: string; dryRun?: boolean; project?: string; source?: Card; env?: Record<string, string> } = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "video-request-regression-"));
  if (!options.dir) temporary.push(dir);
  const shotsFile = join(dir, "shots.json");
  writeFileSync(shotsFile, JSON.stringify({ projectId: options.project ?? "regression", title: "摄影增强回归", ...options.source, shots }));
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/tools/full-chain-film.mts",
    "--shots", shotsFile, "--project", options.project ?? "regression", "--work-dir", dir, "--out", join(dir, "out"),
    "--keys-file", join(dir, "no-credentials.env"), "--library", join(dir, "no-characters"),
    /** 出片入口要求分流结论（T-2026-0930-0015）：回归夹具是叙事片，显式声明即可（不猜商品） */
    "--route-kind", "narrative",
    "--platform", "youtube", "--stages", options.stages ?? "cine-kb,micromotion", ...(options.dryRun === false ? [] : ["--dry-run"]), ...(options.args ?? [])
  ], { cwd: root, encoding: "utf8", timeout: 30_000, env: { ...process.env, ARK_API_KEY: "", LLM_API_KEY: "", ...options.env } });
  return {
    dir, result, diagnostic: `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`,
    read: (file: string) => JSON.parse(readFileSync(join(dir, file), "utf8")),
    rows: () => readFileSync(join(dir, "logs", options.project ?? "regression", "stages.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)),
  };
}

/** Real local media and one declared output-write fault; neither implies provider or quality approval. */
function currentOriginalAndComposeFault(dir: string) {
  const source = join(dir, "clips/regression/EMPTY.mp4"), master = join(dir, "post/regression/master-raw.mp4");
  mkdirSync(dirname(source), { recursive: true });
  const made = spawnSync(ffmpeg, ["-v", "error", "-nostdin", "-n", "-f", "lavfi", "-i", "testsrc2=s=64x96:r=24:d=1",
    "-f", "lavfi", "-i", "sine=frequency=733:sample_rate=48000:duration=1", "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2", source],
    { encoding: "utf8", timeout: 15_000 });
  expect(made.status, `${made.error ?? ""}\n${made.stderr}`).toBe(0);
  const measured = spawnSync(ffprobe, ["-v", "error", "-show_streams", "-of", "json", source], { encoding: "utf8", timeout: 15_000 });
  expect(measured.status, `${measured.error ?? ""}\n${measured.stderr}`).toBe(0);
  const video = JSON.parse(measured.stdout).streams.find((stream: { codec_type: string }) => stream.codec_type === "video");
  expect(video).toMatchObject({ width: 64, height: 96, avg_frame_rate: "24/1", nb_frames: "24" });
  expect(Number(video.duration)).toBe(1);
  const sourceSha256 = createHash("sha256").update(readFileSync(source)).digest("hex");
  const faultLog = join(dir, "compose-output-fault.json"), fault = join(dir, "fixture-ffmpeg.mjs");
  writeFileSync(fault, `#!${process.execPath}
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.includes(process.env.WORKLOOM_TEST_COMPOSE_TARGET)) {
  writeFileSync(process.env.WORKLOOM_TEST_COMPOSE_FAULT_LOG, JSON.stringify({ fixture: "compose-output-fault", target: process.env.WORKLOOM_TEST_COMPOSE_TARGET, argv: args }));
  process.stderr.write("FIXTURE_COMPOSE_NO_OUTPUT" + String.fromCharCode(10)); process.exit(73);
}
const result = spawnSync(process.env.WORKLOOM_TEST_REAL_FFMPEG, args, { stdio: "inherit" });
if (result.error) { process.stderr.write(String(result.error.message)); process.exit(74); }
process.exit(result.status ?? 75);
`);
  chmodSync(fault, 0o700);
  return { source, master, sourceSha256, faultLog, env: { WL_FFMPEG: fault, WL_FFPROBE: ffprobe,
    WORKLOOM_TEST_REAL_FFMPEG: ffmpeg, WORKLOOM_TEST_COMPOSE_TARGET: master, WORKLOOM_TEST_COMPOSE_FAULT_LOG: faultLog } };
}

/** Run the entire current master region in its real async context; absence must stop before inspection or output. */
function currentMissingMaster(dir: string): Promise<void> {
  const file = join(root, "scripts/tools/full-chain-film.mts"), source = readFileSync(file, "utf8");
  const start = source.indexOf("/* ---------- ⑪"), end = source.indexOf("/* ---------- ⑫", start);
  if (start < 0 || end <= start) throw new Error("CURRENT_MASTER_FIXTURE_INVALID: actual master region missing");
  const code = ts.transpileModule(`(async () => {\n${source.slice(start, end)}\n})()`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const records: unknown[] = [], scored = join(dir, "post/regression/master-raw.mp4"), deliverablePath = join(dir, "out/regression-30s-final.mp4");
  return (runInNewContext(code, { STAGES: new Set(["master"]), DRY_RUN: false, scored, deliverablePath, existsSync,
    masterGenerationQuality: null, record: (row: unknown) => records.push(row),
    inspectCurrentGeneration: async () => { throw new Error("UNEXPECTED_INSPECTION_WITHOUT_MASTER"); },
  }, { timeout: 1000 }) as Promise<void>).finally(() => {
    expect(records).toEqual([]); expect(readFileSync(file, "utf8")).toBe(source);
  });
}

const emptyShot = { shotId: "EMPTY", duration: 10, scene: "无人的办公室空镜", depth_of_field: "原定深景深" };
const windowShot = { shotId: "PERSON", duration: 10, scene: "人物站在木质窗边的白天室内", action: "看着远处", character: "演员甲", lighting: "右侧窗光" };

describe("全链路镜头增强真实消费", () => {
  it("无人物与商品定妆照的镜头可使用场地参考回退，不访问块外变量", () => {
    const dir = mkdtempSync(join(tmpdir(), "video-render-fallback-")); temporary.push(dir);
    const shotsFile = join(dir, "shots.json");
    writeFileSync(shotsFile, JSON.stringify([{ shotId: "NC-01", duration: 10, scene: "无人的庭院空镜" }]));
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/tools/render-project.mts",
      "--shots", shotsFile, "--project", "regression-empty", "--total-seconds", "10",
      "--dry-run", "--allow-spec-fail"
    ], { cwd: root, encoding: "utf8", timeout: 30_000 });
    expect(result.status, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).not.toContain("ReferenceError");
    expect(JSON.parse(readFileSync(join(dir, "render-summary.json"), "utf8")).shots).toHaveLength(1);
  }, 40_000);

  it("KB之后的微动作读取当前卡片，保留景深与灯光增强", () => {
    const run = runChain([windowShot]);
    expect(run.result.status, run.diagnostic).toBe(0);
    const kb = run.read("shotlist-enriched-regression.json").shots[0];
    const consumed = run.read("shotlist-current-regression.json").shots[0];
    expect(kb.depth_of_field).toBeTruthy();
    expect(consumed.depth_of_field).toBe(kb.depth_of_field);
    expect(consumed.lighting).toEqual(kb.lighting);
    expect(consumed.action).toContain("【微动作】");
    const trace = run.read("micromotion-regression.json").traces[0];
    expect(trace.status).toBe("passed");
    expect(trace.applied.length).toBeGreaterThan(0);
    expect(trace.applied.length).toBeLessThan(4);
    expect(trace.outputHash).toBe(shotIntentHash(consumed.action));
    expect(trace.sourceHash).toBe(normalizeShotIntent(windowShot).sourceHash);
  }, 40_000);

  it("空镜和商品均可不适用：不注入人物、不伪报写入，KB项目聚合允许全 N/A", () => {
    const product = { shotId: "WATCH", duration: 10, scene: "手表产品特写", depth_of_field: "表盘刻度清晰" };
    const run = runChain([emptyShot, product]);
    expect(run.result.status, run.diagnostic).toBe(0);
    expect(run.read("shotlist-current-regression.json").shots).toEqual([emptyShot, product]);
    const kb = run.read("shotlist-enriched-regression.json");
    expect(kb.status).toBe("not_applicable");
    expect(kb.cineKbApplied).toBe(false);
    const micro = run.read("micromotion-regression.json");
    expect(micro.traces.map((trace: Card) => trace.status)).toEqual(["not_applicable", "not_applicable"]);
    expect(micro.traces.every((trace: { applied: unknown[] }) => trace.applied.length === 0)).toBe(true);
    for (const stage of ["cine-kb", "micromotion"]) {
      expect(run.rows().findLast((row: Card) => row.stage === stage)).toMatchObject({ ok: true, evidence: { status: "not_applicable" } });
    }
  }, 40_000);

  it("蹲姿不笑与睡眠只添加适用通道，保留台词/时长/否定原文并核对完整输出", () => {
    const crouch = { shotId: "CROUCH", duration: 8, scene: "女人蹲在庭院中", action: "保持蹲姿，不要起身，不笑", composition: "中景", dialogue: [{ speaker: "演员甲", text: "我保持这个姿势。" }] };
    const sleep = { shotId: "SLEEP", duration: 6, scene: "女人躺在床上熟睡", action: "保持睡眠，闭着眼睛", composition: "中景" };
    const run = runChain([crouch, sleep]);
    expect(run.result.status, run.diagnostic).toBe(0);
    const current = run.read("shotlist-current-regression.json").shots;
    const micro = run.read("micromotion-regression.json");
    for (const [index, original] of [crouch, sleep].entries()) {
      const trace = micro.traces[index];
      expect(trace.status).toBe("passed");
      expect(trace.applied.length).toBeLessThan(4);
      expect(current[index].action.startsWith(original.action)).toBe(true);
      expect(current[index].action.endsWith("【微动作】" + trace.applied.map((entry: { clause: string }) => entry.clause).join("；"))).toBe(true);
      expect(trace.outputHash).toBe(shotIntentHash(current[index].action));
      expect(trace.sourceHash).toBe(normalizeShotIntent(original).sourceHash);
      expect(current[index].duration).toBe(original.duration);
    }
    expect(current[0].dialogue).toEqual(crouch.dialogue);
    expect(micro.traces[0].text).not.toMatch(/笑意|站起|起身|台词节拍/);
    expect(micro.traces[1].applied.map((entry: { id: string }) => entry.id)).not.toContain("eyes");
    expect(micro.traces[1].text).not.toMatch(/眨眼|睁眼|笑意/);
  }, 40_000);

  it.each([
    { label: "未知主体", card: { shotId: "UNKNOWN", duration: 10 } },
    { label: "没有来源的旧标记", card: { ...windowShot, action: "站着；【微动作】人工添加的旧动作" } },
  ])("$label 不能靠 skipped 或单标记伪过微动作门", ({ card }) => {
    const run = runChain([card], { stages: "micromotion" });
    expect(run.result.status, run.diagnostic).not.toBe(0);
    expect(run.read("micromotion-regression.json").traces[0].status).toBe("unverified");
    expect(run.rows().findLast((row: Card) => row.stage === "micromotion")).toMatchObject({ ok: false, evidence: { status: "unverified" } });
    expect(existsSync(join(run.dir, "shotlist-current-regression.json"))).toBe(false);
  }, 40_000);

  it("KB第一镜未验证、最后一镜成功时，项目仍失败且停止下游", () => {
    const run = runChain([{ shotId: "UNKNOWN", duration: 10 }, windowShot]);
    expect(run.result.status, run.diagnostic).not.toBe(0);
    const rows = run.rows().filter((row: Card) => row.stage === "cine-kb");
    expect(rows.map((row: { evidence: Card }) => row.evidence.status)).toEqual(["unverified", "passed", "unverified"]);
    expect(rows.at(-1)).toMatchObject({ shotId: null, ok: false });
    expect(run.read("shotlist-enriched-regression.json").status).toBe("unverified");
    expect(run.rows().some((row: Card) => row.stage === "micromotion")).toBe(false);
  }, 40_000);

  it("KB部分字段超预算不能用其余成功写入掩盖", () => {
    const run = runChain([{ ...windowShot, lighting: `右侧窗光；${"原始灯光说明".repeat(80)}` }]);
    expect(run.result.status, run.diagnostic).not.toBe(0);
    const row = run.rows().find((entry: Card) => entry.stage === "cine-kb" && entry.shotId === windowShot.shotId);
    expect(row).toMatchObject({ ok: false, evidence: { status: "unverified" } });
    expect(row.evidence.injectedFields).not.toContain("lighting");
    expect(run.read("shotlist-enriched-regression.json").shots[0].lighting).toBe(`右侧窗光；${"原始灯光说明".repeat(80)}`);
  }, 40_000);

  it("请求的KB目录缺失会记录未验证并停止，而非跳过后继续微动作", () => {
    const run = runChain([windowShot], { args: ["--kb-dir", join(tmpdir(), "workloom-no-kb", "missing")] });
    expect(run.result.status, run.diagnostic).not.toBe(0);
    expect(run.rows().findLast((row: Card) => row.stage === "cine-kb")).toMatchObject({ ok: false, evidence: { status: "unverified" } });
    expect(run.rows().some((row: Card) => row.stage === "micromotion")).toBe(false);
  }, 40_000);

  it("当前镜头JSON重新作为输入时保持幂等，trace仍核到实际消费卡片", () => {
    const first = runChain([emptyShot, windowShot]);
    expect(first.result.status, first.diagnostic).toBe(0);
    const original = first.read("shotlist-current-regression.json").shots;
    const second = runChain(original, { dir: first.dir });
    expect(second.result.status, second.diagnostic).toBe(0);
    expect(second.read("shotlist-current-regression.json").shots).toEqual(original);
    const trace = second.read("micromotion-regression.json").traces[1];
    expect(trace.charDelta).toBe(0);
    expect(trace.skipped).toContain("幂等");
    expect(trace.outputHash).toBe(shotIntentHash(original[1].action));
  }, 40_000);

  it("G7复核合法N/A与真实两通道写入，记录当前证据而非历史成功或marker计数", () => {
    const run = runChain([emptyShot, windowShot], { stages: "micromotion,videos", args: ["--accept-env-defects"] });
    // These fixtures intentionally have no approved prompts/plates, so G7 still blocks rendering.
    expect(run.result.status, run.diagnostic).toBe(5);
    const gate = run.rows().find((row: Card) => row.stepKey === "g7-preproduction");
    expect(gate.checks.find((check: Card) => check.id === "micromotion-applied")).toMatchObject({ pass: true, hard: true });
    expect(gate.evidence.micromotionEvidence.map((entry: Card) => entry.status)).toEqual(["not_applicable", "passed"]);
    expect(gate.evidence.micromotionEvidence.every((entry: Card) => entry.verified === true)).toBe(true);
    expect(gate.evidence.micromotionEvidence[1].outputHash).toBe(shotIntentHash(run.read("shotlist-current-regression.json").shots[1].action));
  }, 40_000);
});


describe("全链路当前血缘与返修范围", () => {
  it.each(["compose", "color", "bgm", "master", "deliver", "revise"])("单镜范围不能误进整片 %s", (stage) => {
    const run = runChain([emptyShot], { stages: stage, args: ["--only", "EMPTY"] });
    expect(run.result.status, run.diagnostic).not.toBe(0);
    expect(run.diagnostic).toContain("SELECTED_SHOTS_POST_SCOPE");
  }, 40_000);
  it("未知阶段和未知镜号在执行前拒绝", () => {
    for (const options of [{ stages: "typo" }, { stages: "micromotion", args: ["--only", "GHOST"] }]) {
      const run = runChain([emptyShot], options);
      expect(run.result.status, run.diagnostic).not.toBe(0);
      expect(run.diagnostic).toMatch(/UNKNOWN_STAGE|SHOT_SCOPE_UNKNOWN/);
    }
  }, 40_000);
  it("镜号重复和路径字符不能混入同一产物目录", () => {
    for (const shots of [[emptyShot, emptyShot], [{ ...emptyShot, shotId: "../other" }]]) {
      const run = runChain(shots);
      expect(run.result.status, run.diagnostic).not.toBe(0);
      expect(run.diagnostic).toContain("SHOT_REGISTRY_INVALID");
    }
  }, 40_000);
  it("生产执行不能用豁免开关把缺测变合格", () => {
    const run = runChain([emptyShot], { stages: "master", dryRun: false, args: ["--accept-rejected", "master"] });
    expect(run.result.status, run.diagnostic).not.toBe(0);
    expect(run.diagnostic).toContain("PRODUCTION_BYPASS_REJECTED");
  }, 40_000);
  it("只有旧成功日志、本次合成不产出母版时不能报告请求完成", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "video-current-proof-"))); temporary.push(dir);
    mkdirSync(join(dir, "logs/regression"), { recursive: true });
    const oldRow = JSON.stringify({ stage: "master", ok: true, shotId: null });
    writeFileSync(join(dir, "logs/regression/stages.jsonl"), oldRow + "\n");
    const media = currentOriginalAndComposeFault(dir), shot = { ...emptyShot, duration: 1 }, document = { durationSeconds: 1 };
    const submitted = await freezeOriginalSubmission({ productionRoot: dir, projectId: "regression",
      bytes: Buffer.from(JSON.stringify({ projectId: "regression", title: "摄影增强回归", ...document, shots: [shot] })) });
    const acceptedDir = join(dir, "logs/regression/accepted-tasks"); mkdirSync(acceptedDir, { recursive: true });
    const taskId = "local-fixture-no-provider-call";
    writeFileSync(join(acceptedDir, "EMPTY.json"), JSON.stringify({ schemaVersion: "workloom.render-task/v1", state: "accepted",
      taskId, requestHash: createHash("sha256").update("local-fixture-request").digest("hex"), submissionSource: "local-submit" }));
    await issueOriginalRenderReceipt({ productionRoot: dir, projectId: "regression", shotId: "EMPTY", submittedSha256: submitted.sha256,
      artifactPath: media.source, taskId, requestInputVerified: true });
    const run = runChain([shot], { dir, stages: "master", dryRun: false, source: document, env: media.env,
      args: ["--assembly-mode", "post-only", "--assembly-reason", "Declared local media fixture; no provider or quality authority"] });
    expect(run.result.status, run.diagnostic).toBe(1);
    expect(run.diagnostic, run.diagnostic).toContain("POST_PROCESSING_FAILED: compose");
    const fault = JSON.parse(readFileSync(media.faultLog, "utf8"));
    expect(fault).toMatchObject({ fixture: "compose-output-fault", target: media.master });
    expect(fault.argv.at(-1)).toBe(media.master);
    expect(createHash("sha256").update(readFileSync(media.source)).digest("hex")).toBe(media.sourceSha256);
    expect(readFileSync(join(dir, "logs/regression/stages.jsonl"), "utf8").split("\n")[0]).toBe(oldRow);
    const rows = run.rows();
    expect(rows.filter((row: Card) => row.stage === "compose")).toHaveLength(1);
    expect(rows.find((row: Card) => row.stage === "compose")).toMatchObject({ invoked: true, ok: false });
    expect(rows.slice(1).some((row: Card) => ["master", "deliver"].includes(String(row.stage)) && row.ok === true)).toBe(false);
    expect(existsSync(media.master)).toBe(false);
    expect(existsSync(join(dir, "out"))).toBe(false);
  }, 40_000);
  it("当前母版出口不能用旧成功日志放行缺失的本次文件", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "video-missing-master-entry-"))); temporary.push(dir);
    mkdirSync(join(dir, "logs/regression"), { recursive: true });
    const old = JSON.stringify({ stage: "master", ok: true, shotId: null }) + "\n";
    writeFileSync(join(dir, "logs/regression/stages.jsonl"), old);
    await expect(currentMissingMaster(dir)).rejects.toThrow(/GENERATION_MASTER_CANDIDATE_UNVERIFIED/);
    expect(readFileSync(join(dir, "logs/regression/stages.jsonl"), "utf8")).toBe(old);
    expect(existsSync(join(dir, "out/regression-30s-final.mp4"))).toBe(false);
  });
  it("不同项目在同一work目录独立记账且当前输入输出含实际指纹", () => {
    const first = runChain([emptyShot], { stages: "micromotion", project: "project-a" });
    expect(first.result.status, first.diagnostic).toBe(0);
    const before = readFileSync(join(first.dir, "logs/project-a/stages.jsonl"), "utf8");
    const second = runChain([windowShot], { dir: first.dir, stages: "micromotion", project: "project-b" });
    expect(second.result.status, second.diagnostic).toBe(0);
    expect(readFileSync(join(first.dir, "logs/project-a/stages.jsonl"), "utf8")).toBe(before);
    const row = second.rows().find((entry: Card) => entry.stage === "micromotion");
    expect(row.lineage.projectId).toBe("project-b");
    expect(row.lineage.outputs[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  }, 40_000);
  it("修复另一镜输入不会使未选镜头自己的源指纹改变", () => {
    const first = runChain([emptyShot, windowShot], { stages: "cine-kb" });
    expect(first.result.status, first.diagnostic).toBe(0);
    const firstRow = first.rows().find((entry: Card) => entry.stage === "cine-kb" && entry.shotId === "EMPTY");
    const second = runChain([emptyShot, { ...windowShot, dialogue: [{ text: "仅改这一镜" }] }], { dir: first.dir, stages: "cine-kb", args: ["--only", "PERSON"] });
    expect(second.result.status, second.diagnostic).toBe(0);
    const existing = second.rows().find((entry: Card) => entry.stage === "cine-kb" && entry.shotId === "EMPTY");
    expect(existing.lineage).toEqual(firstRow.lineage);
    expect(existing.lineage.inputs.map((entry: Card) => entry.path)).not.toContain(join(first.dir, "shots.json"));
    const aggregate = second.rows().findLast((entry: Card) => entry.stage === "cine-kb" && entry.shotId === null);
    expect(aggregate.lineage.sourceHash).not.toBe(first.rows().find((entry: Card) => entry.stage === "cine-kb" && entry.shotId === null).lineage.sourceHash);
  }, 40_000);
  it("UHD后期交付档保留HD前期源血缘，并追加当前执行回执", () => {
    const first = runChain([emptyShot, windowShot], { stages: "cine-kb", args: ["--quality", "hd", "--only", "EMPTY"] });
    expect(first.result.status, first.diagnostic).toBe(0);
    const before = first.rows().findLast((entry: Card) => entry.stage === "cine-kb" && entry.shotId === "EMPTY");
    const beforeRows = first.rows();
    const second = runChain([emptyShot, { ...windowShot, dialogue: [{ text: "另一镜新台词" }] }], {
      dir: first.dir, stages: "cine-kb", args: ["--quality", "uhd", "--only", "EMPTY"],
    });
    expect(second.result.status, second.diagnostic).toBe(0);
    expect(second.diagnostic).toContain("源 1080p → 交付 2160p (2160x3840)@24fps");
    expect(second.rows().slice(0, beforeRows.length)).toEqual(beforeRows);
    expect(second.rows().length).toBeGreaterThan(beforeRows.length);
    const after = second.rows().findLast((entry: Card) => entry.stage === "cine-kb" && entry.shotId === "EMPTY");
    expect(after).toMatchObject({ ok: true, evidence: { status: "not_applicable" } });
    expect(after.lineage.projectId).toBe(before.lineage.projectId);
    expect(after.lineage.sourceHash).toBe(before.lineage.sourceHash);
    expect(after.lineage.recipeHash).toBe(before.lineage.recipeHash);
  }, 40_000);
});

describe("成片硬切 CFR 接缝", () => {
  const available = [ffmpeg, ffprobe].every((bin) => spawnSync(bin, ["-version"], { stdio: "ignore" }).status === 0);
  const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
  const assertComposeReceipt = (master: string, clips: string[], expectedDuration: number) => {
    const receipt = JSON.parse(readFileSync(master.replace(/\.mp4$/i, ".av-sync.json"), "utf8"));
    expect(receipt.schemaVersion).toBe("workloom.composition-process/v1");
    expect(receipt.output).toBe(master);
    expect(receipt.outputSha256).toBe(hash(master));
    expect(receipt.inputBindings).toEqual(clips.map(path => ({ path, sha256: hash(path) })));
    expect(receipt.target).toEqual({ width: 64, height: 96, fps: 8, shotFrames: [8, 8, 8], durationSec: 3 });
    expect(receipt.sourceFilesUnchanged).toBe(true);
    expect(receipt.audioAlignmentMeasured).toBe(false);
    for (const field of ["ok", "measured", "samples", "policy"]) expect(receipt).not.toHaveProperty(field);
    const timing = spawnSync(ffprobe, ["-v", "error", "-show_entries", "stream=codec_type,duration,start_time", "-of", "json", master],
      { encoding: "utf8", timeout: 15_000 });
    expect(timing.status, `${timing.error ?? ""}\n${timing.stderr}`).toBe(0);
    const streams = JSON.parse(timing.stdout).streams as Array<{ codec_type: string; duration: string; start_time: string }>;
    for (const type of ["video", "audio"]) {
      const stream = streams.find(stream => stream.codec_type === type);
      const duration = Number(stream?.duration);
      expect(Number.isFinite(duration), `${type} has an actual output clock`).toBe(true);
      expect(Math.abs(duration - expectedDuration), `${type} follows the composition timeline`).toBeLessThanOrEqual(0.13); // Existing one-frame tolerance @8fps.
      expect(Number(stream?.start_time), `${type} starts on the composition clock`).toBe(0);
    }
    return receipt;
  };

  it.skipIf(!available)("视频直拷拼接的每个接缝保持整帧间隔，音画同步按同一时长计算", () => {
    const dir = mkdtempSync(join(tmpdir(), "compose-cfr-")); temporary.push(dir);
    const clips: string[] = [];
    for (const [index, color] of ["red", "green", "blue"].entries()) {
      const file = join(dir, `source-${index}.mp4`);
      const made = spawnSync(ffmpeg, [
        "-hide_banner", "-v", "error", "-y",
        "-f", "lavfi", "-i", `color=c=${color}:s=64x96:r=8:d=1`,
        "-f", "lavfi", "-i", `anoisesrc=color=white:seed=${index + 7}:r=48000:d=1`,
        "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-preset", "ultrafast",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2", file,
      ], { encoding: "utf8", timeout: 15_000 });
      expect(made.status, `${made.error ?? ""}\n${made.stderr}`).toBe(0);
      clips.push(file);
    }
    const master = join(dir, "master.mp4");
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/tools/compose-film.mts",
      "--clips", clips.join(","), "--out", master, "--width", "64", "--height", "96",
      "--fps", "8", "--fade", "0", "--color", "none", "--keep-temp",
    ], {
      cwd: root, encoding: "utf8", timeout: 90_000,
      env: { ...process.env, TMPDIR: dir, WL_FFMPEG: ffmpeg, WL_FFPROBE: ffprobe },
    });
    expect(result.status, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`).toBe(0);
    const work = join(dir, readdirSync(dir).find((name) => name.startsWith("wl-compose-")) ?? "missing");
    expect(readFileSync(join(work, "concat.txt"), "utf8").match(/^duration 1\.000000000$/gm)).toHaveLength(3);
    for (const file of [join(work, "video-only.mp4"), join(work, "raw.mp4"), master]) {
      const read = spawnSync(ffprobe, [
        "-v", "error", "-select_streams", "v:0", "-show_packets",
        "-show_entries", "stream=r_frame_rate,nb_frames:packet=pts_time", "-of", "json", file,
      ], { encoding: "utf8", timeout: 15_000 });
      expect(read.status, `${read.error ?? ""}\n${read.stderr}`).toBe(0);
      const doc = JSON.parse(read.stdout) as {
        streams: Array<{ r_frame_rate: string; nb_frames: string }>;
        packets: Array<{ pts_time: string }>;
      };
      const pts = doc.packets.map((packet) => Number(packet.pts_time)).sort((a, b) => a - b);
      expect(Number(doc.streams[0]!.nb_frames), file).toBe(24);
      expect(doc.streams[0]!.r_frame_rate, file).toBe("8/1");
      expect(pts, file).toHaveLength(24);
      for (let index = 1; index < pts.length; index += 1) {
        expect(pts[index]! - pts[index - 1]!, `${file}: frame ${index}`).toBeCloseTo(0.125, 4);
      }
    }
    assertComposeReceipt(master, clips, 3);
  }, 100_000);

  it.skipIf(!available)("--transition-at 3 只在第三镜入点转场，音画起点与刀数同源", () => {
    const dir = mkdtempSync(join(tmpdir(), "compose-transition-entry-")); temporary.push(dir);
    const clips: string[] = [];
    for (const [index, color] of ["red", "green", "blue"].entries()) {
      const file = join(dir, `source-${index}.mp4`);
      const made = spawnSync(ffmpeg, [
        "-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${color}:s=64x96:r=8:d=1`,
        "-f", "lavfi", "-i", `anoisesrc=color=white:seed=${index + 31}:r=48000:d=1`,
        "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-preset", "ultrafast",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2", file,
      ], { encoding: "utf8", timeout: 15_000 });
      expect(made.status, `${made.error ?? ""}\n${made.stderr}`).toBe(0);
      clips.push(file);
    }
    const master = join(dir, "master.mp4");
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/tools/compose-film.mts",
      "--clips", clips.join(","), "--out", master, "--width", "64", "--height", "96", "--fps", "8",
      "--fade", "0", "--color", "none", "--transition", "fade", "--transition-duration", "0.25",
      "--transition-at", "3",
    ], { cwd: root, encoding: "utf8", timeout: 90_000, env: { ...process.env, WL_FFMPEG: ffmpeg, WL_FFPROBE: ffprobe } });
    expect(result.status, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("× 1 刀");
    const duration = spawnSync(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", master], { encoding: "utf8" });
    expect(Math.abs(Number(duration.stdout.trim()) - 2.75)).toBeLessThanOrEqual(0.13); // ≤1 frame @8fps
    assertComposeReceipt(master, clips, 2.75);
    const pixel = (at: number) => {
      const frame = spawnSync(ffmpeg, ["-v", "error", "-ss", String(at), "-i", master, "-frames:v", "1",
        "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { encoding: "buffer" });
      expect(frame.status, `${frame.error ?? ""}\n${String(frame.stderr)}`).toBe(0);
      return [...frame.stdout.subarray(0, 3)];
    };
    const firstCut = pixel(1.125), beforeThirdEntry = pixel(1.625), thirdShot = pixel(2.125);
    expect(firstCut[1]).toBeGreaterThan(firstCut[2]); // second shot, not a blend into blue
    expect(beforeThirdEntry[1]).toBeGreaterThan(beforeThirdEntry[2]); // old index error cuts to blue here
    expect(thirdShot[2]).toBeGreaterThan(thirdShot[1]);
  }, 100_000);
});


describe("全链路冻结年代与原合同接线", () => {
  it.each([
    { sourceResolution: "720p", args: [], expectedSource: "720p", expectedOutput: "720p", quality: "hd" },
    { sourceResolution: "720p", args: ["--resolution", "1080p"], expectedSource: "1080p", expectedOutput: "1080p", quality: "hd" },
  ])("原生源规格 $sourceResolution 与明确生成规格选项进入前期prompt", ({ sourceResolution, args, expectedSource, expectedOutput, quality }) => {
    const run = runChain([emptyShot], { stages: "plates", source: { aspect: "16:9", resolution: sourceResolution }, args: ["--accept-env-defects", ...args] });
    expect(run.result.status, run.diagnostic).toBe(0);
    const prompt = run.rows().find((r: Card) => r.stage === "keyframe").evidence.prompt;
    expect(prompt).toContain("16:9 横幅");
    expect(prompt).toContain(expectedSource);
    expect(run.diagnostic).toContain(`源 ${expectedSource} → 交付 ${expectedOutput}`);
    expect(run.diagnostic).toContain(`(${quality === "uhd" ? "3840x2160" : expectedOutput === "720p" ? "1280x720" : "1920x1080"})`);
    if (quality === "uhd") expect(prompt).not.toContain("2160p");
  }, 40_000);
  it("2160p交付档别名使用1080p前期源提示，声明本机UHD画布", () => {
    const run = runChain([emptyShot], { stages: "plates", source: { aspect: "16:9", resolution: "2160p" }, args: ["--accept-env-defects"] });
    expect(run.result.status, run.diagnostic).toBe(0);
    const prompt = run.rows().find((row: Card) => row.stage === "keyframe").evidence.prompt;
    expect(prompt).toContain("16:9 横幅 1080p");
    expect(prompt).not.toContain("2160p");
    expect(run.diagnostic).toContain("源 1080p → 交付 2160p (3840x2160)@24fps");
    expect(run.rows().some((row: Card) => row.stage === "enhance")).toBe(false);
  }, 40_000);
  it.each([
    { label: "2160p交付档与HD档冲突", args: ["--quality", "hd"], error: "--resolution 2160p 与 --quality hd 冲突" },
    { label: "未接入模型增强参数", args: ["--enhance-kind", "live-action"], error: "STANDARD_ENHANCEMENT_OPTION_UNSUPPORTED" },
  ])("$label在执行前仍拒绝", ({ args, error }) => {
    const run = runChain([emptyShot], { stages: "plates", source: { aspect: "16:9", resolution: "2160p" }, args });
    expect(run.result.status, run.diagnostic).not.toBe(0);
    expect(run.diagnostic).toContain(error);
    expect(existsSync(join(run.dir, "logs/regression/stages.jsonl"))).toBe(false);
  }, 40_000);
  it("新项目默认当天且续跑保存同一日期，源合同记录进入血缘", () => {
    const first = runChain([emptyShot], { stages: "micromotion" });
    expect(first.result.status, first.diagnostic).toBe(0);
    const context = first.read("logs/regression/project-context.json");
    expect(context.eraProfile.storyDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const next = runChain([emptyShot], { stages: "micromotion", dir: first.dir });
    expect(next.result.status, next.diagnostic).toBe(0);
    expect(next.read("logs/regression/project-context.json")).toEqual(context);
    expect(next.rows().findLast((r: Card) => r.stage === "micromotion").lineage.inputs.some((input: Card) => typeof input.path === "string" && input.path.endsWith("project-context.json"))).toBe(true);
  }, 40_000);
  it("片级历史日期与局部闪回进入实际关键帧prompt，并继承源横幅", () => {
    const shot = { shotId: "PAIR", duration: 8, scene: "两个女人在海边岩石上相对站立", action: "两人不笑，保持站姿", composition: "双人中景", lighting: "2200K 暖烛光，日落余光", depth_of_field: "两人与海岸同时清晰", eraProfile: { storyDate: "1995-08-02" }, environmentProfile: { setting: "exterior", condition: "natural" } };
    const run = runChain([shot], { stages: "plates", source: { eraProfile: { storyDate: "2025-01-01" }, aspect: "16:9" }, args: ["--accept-env-defects"] });
    expect(run.result.status, run.diagnostic).toBe(0);
    const prompt = run.rows().find((r: Card) => r.stage === "keyframe").evidence.prompt;
    expect(prompt).toContain("16:9 横幅"); expect(prompt).toContain("人数 2");
    expect(prompt).toContain("1995-08-02"); expect(prompt).toContain("2200K 暖烛光");
    expect(prompt).toContain("两人与海岸同时清晰"); expect(prompt).not.toContain("5600K");
    expect(run.read("logs/regression/project-context.json").eraProfile.storyDate).toBe("2025-01-01");
  }, 40_000);
  it("外部场景圣经年代默认继承，逐镜未来设备被报告", () => {
    const dir = mkdtempSync(join(tmpdir(), "film-bible-era-")); temporary.push(dir);
    const bible = { spaceId: "coast", space: { city: "上海", building: "海边岩岸", orientation: "朝海", timeOfDay: "傍晚" }, materials: [], practicalLights: [{ type: "日落天光", direction: "西侧" }], traces: [], environmentProfile: { setting: "exterior", condition: "natural" }, eraProfile: { storyDate: "2024-01-01" } };
    const biblePath = join(dir, "bible.json"); writeFileSync(biblePath, JSON.stringify(bible));
    const shot = { ...emptyShot, scene: "无人的海边空镜，岩石上静置手机", devices: [{ category: "phone", model: "iPhone 16 Pro" }] };
    const run = runChain([shot], { dir, stages: "micromotion", args: ["--scene-bible", biblePath] });
    expect(run.result.status, run.diagnostic).toBe(0);
    const report = run.read("env-realism-report-regression.json");
    expect(report.eraProfile.storyDate).toBe("2024-01-01");
    expect(report.summary.device.hard).toBeGreaterThan(0);
    expect(JSON.stringify(report.defects)).toContain("2024-01-01");
  }, 40_000);
  it("已经冻结后改源年代明确拒绝，不能默默盖写", () => {
    const first = runChain([emptyShot], { stages: "micromotion", source: { eraProfile: { storyDate: "2024-01-01" } } });
    expect(first.result.status, first.diagnostic).toBe(0);
    const second = runChain([emptyShot], { stages: "micromotion", dir: first.dir, source: { eraProfile: { storyDate: "2025-01-01" } } });
    expect(second.result.status).not.toBe(0); expect(second.diagnostic).toContain("FILM_ERA_CONFLICT");
    expect(second.read("logs/regression/project-context.json").eraProfile.storyDate).toBe("2024-01-01");
  }, 40_000);
});
