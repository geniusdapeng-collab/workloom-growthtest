#!/usr/bin/env tsx
/**
 * pipeline-audit.mts —— 预生产运行审计（2026-09-22）
 *
 * 回答三个问题（产品所有者口径）：
 *   ① 每个环节是否正常产出（stage 在场 / 状态 / 关键产物计数）；
 *   ② 产出是否符合字段规范（25 字段内容镜 / 30 字段片头 + 交付闸 PromptDeliveryGuard）；
 *   ③ 是否正常流转（叙事片管线 16 步映射 + 渲染/后期/调色/入库的交接证据）。
 *
 * 输入：一次 `video.studio.start` 的产物目录（`apps/server/output/<ts>_<title>/`）
 *   - result.json（全阶段产物）
 *   - shots.json（导出镜头卡）
 *   - meta.json（brief/标题/时间戳）
 *   - 可选 `.vm-work/logs/<projectId>.log`（studio-worker 落盘的逐环节日志）
 *   - 可选 `<runDir>/render-summary.json`（render-project.mts 的出片汇总）
 *
 * 用法：
 *   pnpm exec tsx scripts/tools/pipeline-audit.mts [--run <outputDir>] [--project <VID-xxxx>] [--json]
 * 产物：`<runDir>/audit.md` + `<runDir>/audit.json`
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  OPENING_EXCLUSIVE_FIELDS_LEGACY,
  prepareShotPrompt,
  shotSpecMarkdown,
  fieldSpec,
  type ShotSpecReport
} from "../../packages/video-studio/src/index.js";

const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}
const flag = (name: string) => process.argv.includes(name);

/** 叙事片管线 16 步（bundles/ai-video/pipelines/narrative-film.yml）→ 预生产产物证据 */
interface StepCheck {
  step: string;
  name: string;
  evidence: string;
  ok: boolean | null;
  note?: string;
}

interface AuditResult {
  runDir: string;
  projectId: string | null;
  generatedAt: string;
  stages: Array<{ name: string; present: boolean; status: string; keys: string[]; timingMs: number | null }>;
  pipelineSteps: StepCheck[];
  shots: ShotSpecReport[];
  log: { path: string | null; lines: number; warnings: number; errors: number; stageMarkers: string[] };
  render: unknown | null;
  verdicts: string[];
}

function newestRunDir(): string {
  const base = join(REPO_ROOT, "apps/server/output");
  const dirs = readdirSync(base)
    .map((name) => join(base, name))
    .filter((p) => statSync(p).isDirectory())
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (dirs.length === 0) throw new Error("apps/server/output 下没有任何运行产物");
  return dirs[0]!;
}

function stageStatus(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value !== "object") return typeof value;
  const record = value as Record<string, unknown>;
  if (record.skipped === true) return "skipped";
  if (typeof record.status === "string") return record.status;
  if (typeof record.pass === "boolean") return record.pass ? "pass" : "fail";
  if (typeof record.success === "boolean") return record.success ? "success" : "fail";
  if (typeof record.error === "string") return "error";
  return "-";
}

function nonEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

const runDir = arg("--run") ? resolve(REPO_ROOT, arg("--run")) : newestRunDir();
const resultPath = join(runDir, "result.json");
if (!existsSync(resultPath)) throw new Error(`缺少 result.json：${resultPath}`);
const result = JSON.parse(readFileSync(resultPath, "utf8")) as {
  success?: boolean;
  stages?: Record<string, unknown>;
  errors?: unknown[];
};
const meta = existsSync(join(runDir, "meta.json"))
  ? (JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8")) as Record<string, unknown>)
  : {};
const projectId = arg("--project")
  || (() => {
    const m = String((meta.savedFiles ? "" : "") + JSON.stringify(meta)).match(/VID-\d+/);
    return m ? m[0] : null;
  })();

const stagesRaw = result.stages ?? {};
const stages: AuditResult["stages"] = Object.entries(stagesRaw).map(([name, value]) => {
  const record = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const timing = record.timing;
  return {
    name,
    present: value !== undefined && value !== null,
    status: stageStatus(value),
    keys: Object.keys(record).slice(0, 10),
    timingMs: typeof timing === "number" ? timing : (typeof timing === "object" && timing ? Number((timing as Record<string, unknown>).total ?? NaN) || null : null)
  };
});

/* ---------------- 逐镜字段规范 + 交付闸 ---------------- */
const shotsPath = join(runDir, "shots.json");
const shots = existsSync(shotsPath)
  ? (JSON.parse(readFileSync(shotsPath, "utf8")) as Array<Record<string, unknown>>)
  : [];
const reports: ShotSpecReport[] = shots.map((shot) => prepareShotPrompt(shot, { ratio: "9:16", log: () => undefined }));
const reportByShot = new Map(reports.map((r) => [r.shotId, r]));

/* ---------------- 叙事片管线 16 步映射 ---------------- */
const stageHas = (name: string) => nonEmpty((stagesRaw as Record<string, unknown>)[name]);
const shotField = (shot: Record<string, unknown>, key: string) => nonEmpty(shot[key]);
const openingShot = shots.find((s) => s.sceneType === "opening") ?? null;
const openingReport = openingShot ? reportByShot.get(String(openingShot.shotId)) ?? null : null;
const spec = fieldSpec();

const prompts = ((stagesRaw.productionEngine as Record<string, unknown>)?.prompts ?? []) as Array<Record<string, unknown>>;
const emptyPrompts = prompts.filter((p) => !nonEmpty(p.prompt)).length;
const portrait = (stagesRaw.portraitStudio ?? {}) as Record<string, unknown>;
const renderJobs = existsSync(join(runDir, "render-summary.json"))
  ? (JSON.parse(readFileSync(join(runDir, "render-summary.json"), "utf8")) as Record<string, unknown>)
  : null;
const jobRows = (renderJobs?.shots ?? []) as Array<Record<string, unknown>>;
/** 宿主侧后期（post-production.mts）与调色（compose-film.mts）证据 */
const postReport = existsSync(join(runDir, "post/post-report.json"))
  ? (JSON.parse(readFileSync(join(runDir, "post/post-report.json"), "utf8")) as Record<string, unknown>)
  : null;
/** 调色报告可能落在 run 根或 film/ 子目录（compose-film 输出位置） */
const colorReportFile = (() => {
  for (const dir of [runDir, join(runDir, "film"), join(runDir, "post")]) {
    if (!existsSync(dir)) continue;
    const hit = readdirSync(dir).find((name) => name.endsWith("-color-report.json"));
    if (hit) return join(dir, hit);
  }
  return null;
})();
const colorReport = colorReportFile
  ? (JSON.parse(readFileSync(colorReportFile, "utf8")) as Record<string, unknown>)
  : null;

const steps: StepCheck[] = [
  {
    step: "script", name: "剧本蓝图",
    evidence: stageHas("scriptEngine") ? "stages.scriptEngine（blueprint/validation）" : "缺失",
    ok: stageHas("scriptEngine")
  },
  {
    step: "scene", name: "场景设计",
    evidence: `${shots.length} 张镜头卡（productionEngine.shots）`,
    ok: shots.length > 0
  },
  {
    /**
     * 片头口径（2026-09-26 变更）：不再要求 5 个标题渲染字段（标题由后期封面产出），
     * 与内容镜同为 25 字段；这里查的是"片头镜的 25 字段齐备 + 交付闸放行"。
     */
    step: "opening", name: "片头设计（25 字段 · 标题交后期封面）",
    evidence: openingShot
      ? `${String(openingShot.shotId)} sceneType=opening；25 字段缺 ${openingReport?.missingSpecFields.length ?? "?"} 项；`
        + `标题渲染字段已下线（历史 5 字段：${OPENING_EXCLUSIVE_FIELDS_LEGACY.length} 个）`
      : "未识别到片头镜头",
    ok: Boolean(openingShot) && (openingReport?.missingSpecFields.length ?? 1) === 0
  },
  {
    step: "visual", name: "视觉语言设计",
    evidence: `color_palette/lighting/composition 覆盖 ${shots.filter((s) => shotField(s, "color_palette") && shotField(s, "lighting")).length}/${shots.length}`,
    ok: shots.length > 0 && shots.every((s) => shotField(s, "color_palette") && shotField(s, "lighting"))
  },
  {
    step: "audio", name: "音频设计",
    evidence: `audio 字段覆盖 ${shots.filter((s) => shotField(s, "audio")).length}/${shots.length}`,
    ok: shots.length > 0 && shots.every((s) => shotField(s, "audio"))
  },
  {
    step: "continuity", name: "连贯性导演评审",
    evidence: [
      stageHas("directorSkills") ? "directorSkills" : null,
      stageHas("directorOptimization") ? "directorOptimization" : null,
      stageHas("shotQuality") ? "shotQuality" : null
    ].filter(Boolean).join(" / ") || "缺失",
    ok: stageHas("directorSkills") || stageHas("shotQuality")
  },
  {
    step: "prompt-fuse", name: "逐镜提示词融合",
    evidence: `prompts ${prompts.length} 条，其中 prompt 为空 ${emptyPrompts} 条`,
    ok: prompts.length > 0 && emptyPrompts === 0,
    note: emptyPrompts > 0 ? "prompt 为空 = 渲染输入缺失（真机 2026-09-22 命中：S2–S6），需由 render-operator 按 25 字段重建" : undefined
  },
  {
    step: "field-check", name: "字段质检与修复",
    evidence: `pipelineGuard=${stageStatus(stagesRaw.pipelineGuard)}；降级镜头 ${shots.filter((s) => s.degraded).length}/${shots.length}`,
    ok: shots.length > 0 && shots.every((s) => !s.degraded),
    note: shots.some((s) => s.degraded) ? "存在 FieldGuard 就地修复（降级）镜头" : undefined
  },
  {
    step: "g6-prompt-confirm", name: "提示词审核 G6",
    evidence: renderJobs ? "见 biz_events（gate.requested G6）" : "见 biz_events（gate.requested G6）",
    ok: null
  },
  {
    step: "micromotion", name: "微动作增强",
    evidence: `${String((stagesRaw.microMotion as Record<string, unknown>)?.enhancedCount ?? "?")} 镜增强`,
    ok: stageHas("microMotion")
  },
  {
    step: "portrait", name: "定妆照制作",
    evidence: `completed ${String(portrait.completedPortraits ?? "?")}/${String(portrait.totalPortraits ?? "?")}（executor=${String(portrait.executor ?? "?")}）`,
    ok: Number(portrait.completedPortraits ?? 0) > 0 && Number(portrait.completedPortraits ?? 0) === Number(portrait.totalPortraits ?? -1)
  },
  { step: "g5-portrait-confirm", name: "定妆照确认 G5", evidence: "内部准备门（自动放行 + 留痕）", ok: null },
  { step: "g7-preproduction", name: "预生产最终确认 G7", evidence: "见 biz_events（pipeline.gate.resolved G7）", ok: null },
  {
    step: "render-script", name: "渲染脚本入 CMS",
    evidence: jobRows.length > 0
      ? `${jobRows.length} 个脚本（render-summary.json）`
      : "未执行（本 run 只做预生产；渲染由 render-operator 单独跑）",
    ok: jobRows.length > 0 ? jobRows.every((r) => nonEmpty(r.scriptId)) : null
  },
  {
    step: "render", name: "Seedance 渲染与回填（宿主 render-operator）",
    evidence: jobRows.length > 0
      ? `${jobRows.filter((r) => r.status === "done").length}/${jobRows.length} done；mock=${jobRows.filter((r) => r.mock).length}`
      : "未执行",
    ok: jobRows.length > 0 ? jobRows.every((r) => r.status === "done") : null,
    note: "vendor Layer 3 在 deferRender=true 下显式跳过（避免与宿主双份烧额度）"
  },
  {
    step: "post", name: "后期合成",
    evidence: postReport
      ? `宿主回填渲染路径后重跑 vendor 后期：${postReport.success ? "成功" : "失败"}，`
        + `版本 ${Object.keys((postReport.versions as Record<string, unknown>) ?? {}).join("/")}，`
        + `质量门 ${((postReport.stages as Record<string, Record<string, unknown>> | undefined)?.quality?.passed) === true ? "pass" : "fail"}`
      : (stageHas("postProductionEngine")
        ? `vendor 预生产内跑：${stageStatus(stagesRaw.postProductionEngine)}（deferRender 下拿不到 shot-*.mp4，属预期失败）`
        : "未执行"),
    ok: postReport ? postReport.success === true : null,
    note: postReport ? undefined : "宿主侧后期：scripts/tools/post-production.mts（回填真实成片路径）"
  },
  {
    step: "color", name: "成片调色（择优）",
    evidence: colorReport
      ? `mode=${String(colorReport.mode)}，判定=${String((colorReport.report as Record<string, unknown>)?.verdict ?? "?")}` +
        `${(colorReport.report as Record<string, unknown>)?.winner ? `，winner=${String((colorReport.report as Record<string, unknown>).winner)}` : ""}`
      : "未执行（由 compose-film.mts 择优调色）",
    ok: colorReport
      ? ["graded", "no_change_needed"].includes(String((colorReport.report as Record<string, unknown>)?.verdict))
      : null
  },
  {
    step: "archive", name: "成片入库",
    evidence: jobRows.length > 0 ? `${jobRows.filter((r) => nonEmpty(r.assetId)).length} 个 video_assets(final_cut)` : "未执行",
    ok: jobRows.length > 0 ? jobRows.every((r) => nonEmpty(r.assetId)) : null
  }
];

/* ---------------- 日志分析 ---------------- */
function auditLog(id: string | null): AuditResult["log"] {
  if (!id) return { path: null, lines: 0, warnings: 0, errors: 0, stageMarkers: [] };
  const file = join(REPO_ROOT, ".vm-work/logs", `${id}.log`);
  if (!existsSync(file)) return { path: null, lines: 0, warnings: 0, errors: 0, stageMarkers: [] };
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  const markers = new Set<string>();
  for (const line of lines) {
    const m = line.match(/([🎬🛡️🎨📋🖼️⚡✅⛔🔴⚠️]\s*)?\[([A-Za-z0-9_\- ]{3,32})\]/);
    if (m) markers.add(m[2]!.trim());
    const section = line.match(/\[(FieldGuard|PromptFusionAgent|RenderingEngine|PortraitStudio|Hyperreality|ShotQuality|Degradation|QualityGate)[^\]]*\]/);
    if (section) markers.add(section[1]!);
  }
  return {
    path: file.replace(REPO_ROOT + "/", ""),
    lines: lines.length,
    warnings: lines.filter((l) => / WARN |⚠️/.test(l)).length,
    errors: lines.filter((l) => / ERROR |❌|⛔/.test(l)).length,
    stageMarkers: [...markers].slice(0, 40)
  };
}
const log = auditLog(projectId);

/* ---------------- 结论 ---------------- */
const verdicts: string[] = [];
const specFailures = reports.filter((r) => !r.delivery.pass);
const redlineHits = reports.filter((r) => r.redlines.length > 0);
verdicts.push(
  `阶段在场：${stages.filter((s) => s.present).length}/${stages.length}；`
  + `降级镜头 ${shots.filter((s) => s.degraded).length}/${shots.length}；`
  + `prompt 为空 ${emptyPrompts}/${prompts.length}`
);
verdicts.push(
  `字段规范：${reports.length - specFailures.length}/${reports.length} 镜过交付闸（vendor PromptDeliveryGuard）`
  + (specFailures.length ? `；未过：${specFailures.map((r) => r.shotId).join("、")}` : "")
);
verdicts.push(
  `片头口径：${openingShot
    ? `${String(openingShot.shotId)} 走 25 字段（标题由后期封面产出，5 个标题渲染字段已下线）；25 字段缺 ${openingReport?.missingSpecFields.length ?? "?"} 项`
    : "未识别片头镜头"}`
);
verdicts.push(
  `内容红线：${redlineHits.length ? `${redlineHits.map((r) => `${r.shotId}(${r.redlines.join("/")})`).join("、")}` : "无命中"}`
);
if (log.path) verdicts.push(`日志：${log.path}（${log.lines} 行，告警 ${log.warnings}，错误 ${log.errors}）`);
else verdicts.push("日志：未落盘（本 run 早于日志 tee 上线或未开启）");

const audit: AuditResult = {
  runDir: runDir.replace(REPO_ROOT + "/", ""),
  projectId,
  generatedAt: new Date().toISOString(),
  stages,
  pipelineSteps: steps,
  shots: reports,
  log,
  render: renderJobs,
  verdicts
};

/* ---------------- 报告 ---------------- */
const md: string[] = [
  `# 预生产审计报告 · ${projectId ?? "（未识别项目号）"}`,
  "",
  `- 产物目录：\`${audit.runDir}\``,
  `- 生成时间：${audit.generatedAt}`,
  `- 结论：${verdicts.join("；")}`,
  "",
  "## 一、逐环节产出",
  "",
  "| 阶段 | 状态 | 关键键 | 耗时(ms) |",
  "|---|---|---|---:|",
  ...stages.map((s) => `| ${s.name} | ${s.status} | ${s.keys.join("、")} | ${s.timingMs ?? "—"} |`),
  "",
  "## 二、叙事片管线 16 步映射（bundles/ai-video/pipelines/narrative-film.yml）",
  "",
  "| 步骤 | 名称 | 证据 | 判定 |",
  "|---|---|---|---|",
  ...steps.map((s) => `| ${s.step} | ${s.name} | ${s.evidence} | ${s.ok === null ? "—" : s.ok ? "✅" : "❌"}${s.note ? `（${s.note}）` : ""} |`),
  "",
  "## 三、镜头卡字段规范与交付闸（25/30 字段）",
  "",
  shotSpecMarkdown(reports),
  "",
  "## 四、日志",
  "",
  log.path
    ? `- 文件：\`${log.path}\`（${log.lines} 行，告警 ${log.warnings}，错误 ${log.errors}）\n- 出现的环节标记：${log.stageMarkers.join("、")}`
    : "- 未落盘（运行日志 tee 自 2026-09-22 起生效）",
  ""
];

writeFileSync(join(runDir, "audit.json"), `${JSON.stringify(audit, null, 2)}\n`, "utf8");
writeFileSync(join(runDir, "audit.md"), md.join("\n"), "utf8");

if (flag("--json")) {
  console.log(JSON.stringify(audit, null, 2));
} else {
  console.log(md.join("\n"));
  console.log(`\n审计产物：${join(runDir.replace(REPO_ROOT + "/", ""), "audit.md")} / audit.json`);
}
