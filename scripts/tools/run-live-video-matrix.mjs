#!/usr/bin/env node
/** Sequential real-model preproduction matrix. Never enables portraits or render submission. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { effectivePipelineFailures, promptSpeechViolationShotIds } from "./live-video-matrix-classification.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (name, fallback = "") => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
};
const has = (name) => process.argv.includes(name);
const casesPath = resolve(repoRoot, arg("--cases", "stress/live-video-cases.json"));
const outRoot = resolve(repoRoot, arg("--out", `outputs/live-video-matrix/${new Date().toISOString().replace(/[:.]/g, "-")}`));
const workRoot = resolve(repoRoot, arg("--work-root", join(outRoot, "work")));
const timeoutMs = Number(arg("--timeout-ms", String(45 * 60 * 1000)));
const only = new Set(arg("--only").split(",").map((value) => value.trim()).filter(Boolean));
const reuseWork = has("--reuse-work");
const keysFile = resolve(arg("--keys-file", join(homedir(), ".workloom", "live.env")).replace(/^~/, homedir()));
const searchCache = resolve(outRoot, "search-cache.json");

if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 60_000 || timeoutMs > 60 * 60 * 1000) {
  throw new Error("--timeout-ms must be an integer between 60000 and 3600000");
}
const suite = JSON.parse(readFileSync(casesPath, "utf8"));
if (suite.schema !== "workloom.live-video-matrix/v1" || !Array.isArray(suite.cases) || suite.cases.length !== 14) {
  throw new Error("LIVE_MATRIX_INVALID: expected 14 cases");
}
const caseIds = new Set(suite.cases.map((item) => item?.id));
const outputIds = new Set(suite.cases.map((item) => item?.output));
const projectIds = new Set(suite.cases.map((item) => item?.project));
if (caseIds.size !== 14 || outputIds.size !== 14 || projectIds.size !== 14
  || suite.cases.some((item) => !item?.id || !item?.output || !item?.project || !item?.intent
    || !Number.isFinite(Number(item?.duration)) || Number(item.duration) <= 0)) {
  throw new Error("LIVE_MATRIX_INVALID: id/output/project must be unique and every case needs intent + positive duration");
}
const selected = only.size ? suite.cases.filter((item) => only.has(item.id)) : suite.cases;
if (selected.length === 0) throw new Error("--only did not match any case");

const hash = (path) => existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;
const readJson = (path) => {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { return null; }
};
const readJsonl = (path) => {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
};
const dialogueText = (shot) => {
  const value = shot?.dialogue;
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(dialogueText).filter(Boolean).join(" ");
  if (!value || typeof value !== "object") return "";
  const lines = Array.isArray(value.lines) ? value.lines : [];
  const blocks = Array.isArray(value.blocks) ? value.blocks : [];
  return [
    typeof value.text === "string" ? value.text.trim() : "",
    ...lines.map((line) => String(line?.text ?? line?.line ?? "").trim()),
    ...blocks.map((line) => String(line?.text ?? line?.line ?? "").trim()),
  ].filter(Boolean).join(" ");
};
const caseCommand = (item) => {
  const outDir = join(outRoot, item.output);
  const workDir = join(workRoot, item.id);
  const args = [
    "scripts/tools/data-pipeline-run.mts",
    "--intent", item.intent,
    "--duration", String(item.duration),
    "--platform", item.platform,
    "--route", item.route,
    "--producer", "review",
    // A rejected attempt already fails the evidence contract; do not hide it behind a full rerun.
    "--producer-retry", "0",
    "--project", item.project,
    "--work-dir", workDir,
    "--out", outDir,
    "--keys-file", keysFile,
    "--no-portraits",
    "--audit-skip-portrait-gate",
    "--json",
  ];
  if (item.args) args.push(...item.args);
  if (item.primeSearch) args.push("--prime-search", item.primeSearch, "--search-cache", searchCache);
  return { args, outDir, workDir };
};

function terminate(child) {
  if (!child.pid || child.killed) return;
  try { process.kill(-child.pid, "SIGTERM"); }
  catch { child.kill("SIGTERM"); }
}

async function runCase(item) {
  const { args, outDir, workDir } = caseCommand(item);
  if (existsSync(outDir) || (!reuseWork && existsSync(workDir))) {
    throw new Error(`${item.id}: output/work directory already exists${reuseWork ? "（--reuse-work 只允许复用 work 目录）" : ""}`);
  }
  mkdirSync(outDir, { recursive: true });
  if (!existsSync(workDir)) mkdirSync(workDir, { recursive: true });
  const logPath = join(outDir, "run.log");
  const log = createWriteStream(logPath, { flags: "wx" });
  const startedAt = new Date();
  const started = Date.now();
  let timedOut = false;
  let child;
  const exit = await new Promise((resolveExit) => {
    child = spawn(process.execPath, [join(repoRoot, "node_modules/tsx/dist/cli.mjs"), ...args], {
      cwd: repoRoot,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => { timedOut = true; terminate(child); }, timeoutMs);
    child.stdout.on("data", (chunk) => { process.stdout.write(chunk); log.write(chunk); });
    child.stderr.on("data", (chunk) => { process.stderr.write(chunk); log.write(chunk); });
    child.once("error", (error) => {
      clearTimeout(timer);
      log.end(`\nSPAWN_ERROR ${error.message}\n`);
      resolveExit({ code: null, signal: null, spawnError: error.message });
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      log.end(`\nexit_code=${code ?? "null"} signal=${signal ?? "none"} timed_out=${timedOut}\n`);
      resolveExit({ code, signal, spawnError: null });
    });
  });
  const elapsedMs = Date.now() - started;
  const resultPath = join(outDir, "result.json");
  const summaryPath = join(outDir, "data-pipeline-summary.json");
  const metaPath = join(outDir, "meta.json");
  const gatesPath = join(outDir, "gates.jsonl");
  const eventsPath = join(outDir, "events.jsonl");
  const shotsPath = join(outDir, "shots.json");
  const result = readJson(resultPath);
  const summary = readJson(summaryPath);
  const meta = readJson(metaPath);
  const gates = readJsonl(gatesPath);
  const events = readJsonl(eventsPath);
  const shotRows = Array.isArray(readJson(shotsPath)) ? readJson(shotsPath) : [];
  const production = result?.stages?.productionEngine;
  const promptRows = Array.isArray(production?.prompts) ? production.prompts : [];
  const rejectedGates = gates.filter((gate) => gate.approved !== true);
  const requiredGates = item.route === "marketing"
    ? ["G1_DOSSIER", "G2_THEME", "G3_INSIGHT", "G4_PRD", "G5_PORTRAIT", "G6_PROMPT", "G7_FINAL"]
    : ["G2_THEME", "G3_INSIGHT", "G4_PRD", "G5_PORTRAIT", "G6_PROMPT", "G7_FINAL"];
  const approvedGateNames = new Set(gates.filter((gate) => gate.approved === true).map((gate) => gate.gate));
  const missingGates = requiredGates.filter((gate) => !approvedGateNames.has(gate));
  const packageChecks = events.filter((event) => event?.kind === "pipeline.duration.package_check");
  const packageCheckPassed = packageChecks.length > 0
    && packageChecks.every((event) => event?.payload?.pass === true);
  const durationInfeasible = events.filter((event) => event?.kind === "pipeline.duration.infeasible");
  const failedEvents = effectivePipelineFailures(events, result);
  const declaredDuration = Number(item.duration);
  const actualDuration = shotRows.reduce((sum, shot) => sum + Math.max(0, Number(shot?.duration ?? shot?.timing?.duration ?? 0)), 0);
  const durationMatches = Math.abs(actualDuration - declaredDuration) <= 0.05;
  const speechViolations = item.expect?.allSpeechForbidden
    ? shotRows.filter((shot) => dialogueText(shot)).map((shot) => String(shot?.shotId ?? "?"))
    : [];
  const promptSpeechViolations = item.expect?.allSpeechForbidden
    ? promptSpeechViolationShotIds(shotRows, promptRows)
    : [];
  const failureReasons = [
    exit.code !== 0 ? `exitCode=${exit.code ?? "null"}` : "",
    exit.signal ? `signal=${exit.signal}` : "",
    timedOut ? `timeout>${timeoutMs}ms` : "",
    result?.success !== true ? "result.success!=true" : "",
    summary?.success !== true ? "summary.success!=true" : "",
    Number(summary?.shots ?? 0) <= 0 ? "shots==0" : "",
    Number(summary?.prompts ?? 0) !== Number(summary?.shots ?? -1) ? "prompts!=shots" : "",
    summary?.shots !== shotRows.length ? "summary.shots!=shots.json" : "",
    !durationMatches ? `shotDuration=${actualDuration}!=${declaredDuration}` : "",
    meta?.renderSubmitted !== false ? "renderSubmitted!=false" : "",
    meta?.portraitsEnabled !== false ? "portraitsEnabled!=false" : "",
    rejectedGates.length > 0 ? `rejectedGates=${rejectedGates.map((gate) => gate.gate).join(",")}` : "",
    missingGates.length > 0 ? `missingGates=${missingGates.join(",")}` : "",
    !packageCheckPassed ? "durationPackageCheck!=pass" : "",
    durationInfeasible.length > 0 ? `durationInfeasible=${durationInfeasible.length}` : "",
    failedEvents.length > 0 ? "pipeline.failed" : "",
    speechViolations.length > 0 ? `dialogueViolations=${speechViolations.join(",")}` : "",
    promptSpeechViolations.length > 0 ? `promptSpeechViolations=${promptSpeechViolations.join(",")}` : "",
  ].filter(Boolean);
  const completed = failureReasons.length === 0;
  const checks = {
    exitZeroAndNotTimedOut: exit.code === 0 && !exit.signal && !timedOut,
    resultSuccess: result?.success === true,
    summarySuccess: summary?.success === true,
    promptCountMatchesShots: Number(summary?.prompts ?? 0) === Number(summary?.shots ?? -1)
      && Number(summary?.shots ?? 0) === shotRows.length,
    durationMatches,
    declaredDuration,
    actualDuration,
    packageCheckPassed,
    durationInfeasibleCount: durationInfeasible.length,
    failedEventCount: failedEvents.length,
    rejectedGates: rejectedGates.map((gate) => gate.gate),
    missingGates,
    speechViolations,
    promptSpeechViolations,
    renderSubmitted: meta?.renderSubmitted ?? null,
    portraitsEnabled: meta?.portraitsEnabled ?? null,
  };
  return {
    id: item.id,
    project: item.project,
    route: item.route,
    duration: item.duration,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    elapsedMs,
    exitCode: exit.code,
    signal: exit.signal,
    spawnError: exit.spawnError,
    timedOut,
    completed,
    failureReasons,
    checks,
    shots: Number(summary?.shots ?? 0),
    prompts: Number(summary?.prompts ?? 0),
    gates,
    rejectedGates,
    renderSubmitted: meta?.renderSubmitted ?? null,
    portraitsEnabled: meta?.portraitsEnabled ?? null,
    preproductionAudit: result?.preproductionAudit ?? null,
    deliveryStatus: result?.deliveryStatus ?? null,
    dataMining: summary?.dataMining ?? null,
    resultRef: existsSync(resultPath) ? relative(outRoot, resultPath) : null,
    summaryRef: existsSync(summaryPath) ? relative(outRoot, summaryPath) : null,
    metaRef: existsSync(metaPath) ? relative(outRoot, metaPath) : null,
    shotsRef: existsSync(shotsPath) ? relative(outRoot, shotsPath) : null,
    eventsRef: existsSync(eventsPath) ? relative(outRoot, eventsPath) : null,
    logRef: relative(outRoot, logPath),
    hashes: {
      result: hash(resultPath),
      summary: hash(summaryPath),
      meta: hash(metaPath),
      gates: hash(gatesPath),
      shots: hash(shotsPath),
      events: hash(eventsPath),
      log: hash(logPath),
    },
  };
}

mkdirSync(outRoot, { recursive: true });
mkdirSync(workRoot, { recursive: true });
writeFileSync(join(outRoot, "cases.json"), `${JSON.stringify(suite, null, 2)}\n`);
const results = [];
for (const item of selected) results.push(await runCase(item));
const report = {
  schema: "workloom.live-video-matrix-report/v1",
  taskId: suite.taskId,
  generatedAt: new Date().toISOString(),
  model: process.env.DEEPSEEK_MODEL ?? process.env.LLM_MODEL ?? "configured-by-keys-file",
  total: results.length,
  passed: results.filter((item) => item.completed).length,
  failed: results.filter((item) => !item.completed).length,
  providerVideoSubmissions: 0,
  portraitSubmissions: 0,
  results,
};
writeFileSync(join(outRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(join(outRoot, "SUMMARY.md"), [
  "# 真实视频预生产 14-case",
  "",
  `- 总计：${report.total}`,
  `- 通过：${report.passed}`,
  `- 失败：${report.failed}`,
  "- 视频渲染提交：0",
  "- 定妆照生成：0（本轮 disabled）",
  "- 每个案例必须：退出码 0、镜头/提示词一致、时长守恒、所有必需门通过、包时长检查通过、无 duration.infeasible、无 pipeline.failed。",
  "",
  "| 案例 | 结果 | 镜头/提示词 | 时长 | 失败原因 | 耗时 |",
  "|---|---:|---:|---:|---|---:|",
  ...results.map((item) => `| ${item.id} | ${item.completed ? "通过" : "失败"} | ${item.shots}/${item.prompts} | ${item.checks.actualDuration}/${item.checks.declaredDuration}s | ${item.failureReasons.join("<br>") || "-"} | ${(item.elapsedMs / 1000).toFixed(1)}s |`),
].join("\n") + "\n");
process.stdout.write(`${JSON.stringify({ outRoot, total: report.total, passed: report.passed, failed: report.failed })}\n`);
if (report.failed > 0) process.exitCode = 1;
