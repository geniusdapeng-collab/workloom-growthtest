#!/usr/bin/env tsx
/** Deterministic preflight, not a visual quality approval. 0=no hard defect; 1=blocked; 2=input/I/O error. */
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DEVICE_POLICY_VERIFIED_AT, DEVICE_POLICY_VERSION, deviceDefects, devicePolicyStatus, summarizeDeviceDefects } from "../../packages/video-studio/src/device-policy.js";
import { environmentDefects, expandShotWithBible, summarizeDefects, validateSceneBible, type SceneBible, type EnvDefect } from "../../packages/video-studio/src/scene-bible.js";
import { resolveEraProfile } from "../../packages/video-studio/src/era-profile.js";
import { shotIntentHash, type ShotIntentStatus } from "../../packages/video-studio/src/shot-intent.js";
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const statusOf = (defects: readonly EnvDefect[]): ShotIntentStatus => defects.some((entry) => entry.status === "failed") ? "failed" : defects.length ? "unverified" : "passed";
function main(): number {
  const args = process.argv.slice(2);
  const values = new Map<string, string>(); const flags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (["--shots", "--scene-bible", "--report"].includes(arg)) {
      if (values.has(arg) || !args[index + 1] || args[index + 1]!.startsWith("--")) throw new Error(`参数 ${arg} 缺值或重复`);
      values.set(arg, args[++index]!);
    } else if (["--json", "--expand", "--accept-soft"].includes(arg)) flags.add(arg);
    else throw new Error(`未知参数：${arg}`);
  }
  if (!values.has("--shots")) throw new Error("用法：environment-realism-audit --shots <shotlist.json> [--scene-bible <bible.json>] [--expand] [--json] [--report <path>]");
  const shotsPath = resolve(values.get("--shots")!);
  const shotlist: unknown = JSON.parse(readFileSync(shotsPath, "utf8"));
  if (!record(shotlist) || !Array.isArray(shotlist.shots) || !shotlist.shots.length) throw new Error("镜头卡必须为对象，shots必须为非空数组");
  const seen = new Set<string>();
  const shots = shotlist.shots.map((shot) => {
    if (!record(shot) || typeof shot.shotId !== "string" || !shot.shotId.trim() || seen.has(shot.shotId)) throw new Error("shots每项须为对象并具有不重复的非空shotId");
    seen.add(shot.shotId); return shot;
  });
  const sceneBiblePath = values.has("--scene-bible") ? resolve(values.get("--scene-bible")!) : undefined;
  const rawBible: unknown = sceneBiblePath ? JSON.parse(readFileSync(sceneBiblePath, "utf8")) : shotlist.sceneBible;
  if (rawBible !== undefined) {
    const issues = validateSceneBible(rawBible);
    if (issues.length) throw new Error(`sceneBible非法：${issues.join("；")}`);
  }
  const bible = rawBible as SceneBible | undefined;
  const era = shotlist.eraProfile === undefined ? undefined : resolveEraProfile(shotlist.eraProfile);
  const errors: EnvDefect[] = [];
  const auditedShots = shots.map((raw) => {
    try {
      const shot = flags.has("--expand") && bible ? expandShotWithBible(raw, bible) : { ...raw };
      return shot.eraProfile === undefined && era !== undefined ? { ...shot, eraProfile: era } : shot;
    } catch (error) {
      errors.push({ rule: "scene-expansion", shotId: raw.shotId as string, detail: error instanceof Error ? error.message : String(error), hard: true, status: "unverified" });
      return { ...raw };
    }
  });
  const envDefects = [...errors, ...environmentDefects(auditedShots, bible)];
  const devices = deviceDefects(auditedShots, { eraProfile: era });
  const defects = [...envDefects, ...devices];
  const summary = summarizeDefects(defects);
  const status = statusOf(defects);
  const perShot = auditedShots.map((shot) => {
    const own = defects.filter((entry) => entry.shotId === shot.shotId);
    return { shotId: shot.shotId, status: statusOf(own), sourceHash: shotIntentHash(shots.find((entry) => entry.shotId === shot.shotId)), outputHash: shotIntentHash(shot), ...summarizeDefects(own), defects: own };
  });
  const report = {
    schemaVersion: "workloom.env-realism-report/v2", generatedAt: new Date().toISOString(),
    evidence: "deterministic-text-only", status, qualified: status === "passed", renderBlocked: summary.hard > 0,
    shotlist: shotsPath, mode: flags.has("--expand") ? "expanded" : "raw", projectId: shotlist.projectId ?? null,
    sourceHash: shotIntentHash(shotlist), sceneBible: bible ? { spaceId: bible.spaceId, sha256: shotIntentHash(bible) } : null,
    eraProfile: era ?? null, summary, environment: summarizeDefects(envDefects),
    devicePolicy: { version: DEVICE_POLICY_VERSION, verifiedAt: DEVICE_POLICY_VERIFIED_AT, status: devicePolicyStatus(auditedShots, { eraProfile: era }), ...summarizeDeviceDefects(devices) },
    perShot, defects,
  };
  const reportPath = resolve(values.get("--report") ?? join(dirname(shotsPath), "env-realism-report.json"));
  const reportTarget = existsSync(reportPath) ? realpathSync(reportPath) : reportPath;
  if ([shotsPath, sceneBiblePath].filter((path): path is string => Boolean(path)).some((path) => realpathSync(path) === reportTarget)) throw new Error("报告路径不能覆盖镜头卡或场景圣经输入");
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  if (flags.has("--json")) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`环境与设备文本审计：${status}；硬缺陷 ${summary.hard}；软提示 ${summary.soft}；报告 ${reportPath}`);
    for (const row of perShot) {
      console.log(`${row.shotId}: ${row.status}，硬 ${row.hard} / 软 ${row.soft}`);
      for (const entry of row.defects) if (entry.hard || !flags.has("--accept-soft")) console.log(`  ${entry.rule}: ${entry.detail}`);
    }
    console.log("本报告仅检查声明与文字合同，不能证明生成画面或整片视觉质量；accept-soft不提升证据状态。");
  }
  return summary.hard ? 1 : 0;
}
try { process.exitCode = main(); }
catch (error) { console.error(`环境审计输入/文件错误：${error instanceof Error ? error.message : String(error)}`); process.exitCode = 2; }
