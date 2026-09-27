#!/usr/bin/env node
/**
 * color-cli —— 调色工位命令行（调色师数字员工的"手"）。
 *
 * 用法：
 *   color-cli health
 *   color-cli probe   --in clip.mp4
 *   color-cli analyze --in clip.mp4 [--at 1.5,5] [--neutral x,y,w,h] [--skin x,y,w,h]
 *   color-cli scope   --in clip.mp4 [--at 3] [--kinds waveform,vectorscope,histogram] [--out dir]
 *   color-cli grade   --in clip.mp4 --out graded.mp4 [--profile teal-orange] [--lut x.cube]
 *                     [--intensity 0.8] [--corrections-json '{"eq":{"brightness":0.05}}']
 *   color-cli match   --ref hero.mp4 --in a.mp4 --in b.mp4 --out-dir dir [--profile natural]
 *
 * 退出码：0 成功；2 用法错误；3 工具错误（code 见 ColorError）。
 * 任何写入都落到新文件；覆盖原片一律拒绝。
 */

import path from "node:path";
import process from "node:process";

import {
  ColorError, assertPathAllowed, allowedRoots,
  best, callTool, compareFrames, findRecipes, grade, match, resolveBinaries, SCOPE_KINDS, PROFILES,
} from "./core.mjs";

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else if (flags[key] === undefined) {
        flags[key] = next;
        i += 1;
      } else if (Array.isArray(flags[key])) {
        flags[key].push(next);
        i += 1;
      } else {
        flags[key] = [flags[key], next];
        i += 1;
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

function parsePatch(value, label) {
  if (!value) return null;
  const parts = String(value).split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new ColorError(`${label} 需要 x,y,w,h 四个数字，收到 "${value}"`, "bad_patch");
  }
  const [x, y, w, h] = parts;
  return { x, y, w, h };
}

function fmt(value, digits = 1) {
  return Number.isFinite(value) ? value.toFixed(digits) : "n/a";
}

function printHuman(command, result) {
  const line = (s = "") => process.stdout.write(`${s}\n`);
  if (command === "health" || command === "probe") {
    line(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "analyze") {
    const r = result;
    line(`素材：${r.input}`);
    line(`规格：${r.probe.video.width}x${r.probe.video.height} · ${fmt(r.probe.duration)}s · ${r.probe.video.codec} · transfer=${r.probe.video.colorTransfer ?? "unspecified"}`);
    line("");
    line("指标（均值）");
    line(`  YMIN ${fmt(r.summary.YMIN)}  YAVG ${fmt(r.summary.YAVG)}  YMAX ${fmt(r.summary.YMAX)}`);
    line(`  UAVG ${fmt(r.summary.UAVG)}  VAVG ${fmt(r.summary.VAVG)}  SATAVG ${fmt(r.summary.SATAVG)}`);
    line("");
    if (r.issues.length === 0) {
      line("诊断：未发现明显问题");
    } else {
      line(`诊断：${r.issues.length} 项`);
      for (const issue of r.issues) {
        line(`  [${issue.severity}] ${issue.kind} — ${issue.detail}`);
        line(`        建议：${issue.suggestion}`);
      }
    }
    if (r.whiteBalance) {
      const gains = r.whiteBalance.gains;
      line("");
      line(`白平衡（${r.whiteBalance.source} · 置信度 ${r.whiteBalance.confidence}）：R${fmt(gains.r, 3)} G${fmt(gains.g, 3)} B${fmt(gains.b, 3)}`);
    }
    if (r.skin) {
      line(`肤色：hue ${fmt(r.skin.hue)}° sat ${fmt(r.skin.saturation)} → ${r.skin.healthy ? "健康" : "需修正"}`);
    }
    return;
  }
  if (command === "grade") {
    const r = result;
    line(`成片：${r.output}`);
    line(`滤镜链：${r.chain}`);
    line(`强度：${r.intensity}${r.profile ? ` · profile=${r.profile}` : ""}${r.lut ? ` · lut=${path.basename(r.lut)}` : ""}`);
    line(`时长：${fmt(r.durationSeconds)}s · 体积：${(r.sizeBytes / 1024 / 1024).toFixed(2)}MB`);
    line(`指标：YAVG ${fmt(r.before.YAVG)} → ${fmt(r.after.YAVG)}（Δ${fmt(r.delta.YAVG)}）  SATAVG ${fmt(r.before.SATAVG)} → ${fmt(r.after.SATAVG)}`);
    line(`sha256：${r.sha256}`);
    for (const w of r.verifyWarnings) line(`⚠ ${w}`);
    return;
  }
  if (command === "best") {
    const r = result;
    line(`结论：${r.verdict === "graded" ? `已调色（选中 ${r.winnerLabel}）` : "无需调色（原片不动，未产出文件）"}`);
    if (r.recipe) line(`配方：${r.recipe}${r.recipeContext ? ` · ${r.recipeContext.genre} · ${r.recipeContext.scene}` : ""}`);
    line(`理由：${r.reason ?? `最佳候选比原片高 ${r.improvement} 分（阈值 ${r.minImprovement}）`}`);
    line("");
    line("候选得分（基准 100 = 原片）");
    for (const c of [...r.candidates].sort((a, b) => b.score - a.score).slice(0, 6)) {
      line(`  ${String(c.score).padStart(6)}  ${String(c.id).padEnd(22)} 对比度×${c.reasons.contrastRatio} 饱和×${c.reasons.satRatio} 裁切${c.reasons.clipDeltaPct >= 0 ? "+" : ""}${c.reasons.clipDeltaPct}% 亮度${c.reasons.lumaDrift >= 0 ? "+" : ""}${c.reasons.lumaDrift}`);
    }
    if (r.verdict === "graded") {
      line("");
      line(`成片：${r.output}`);
      line(`成片得分：${r.finalScore.score}（原片 100）｜可见性 ${r.visibility.meanAbsDiff}/255 ${r.visibility.verdict}`);
    }
    return;
  }
  if (command === "scope") {
    const r = result;
    for (const o of r.outputs) line(`${o.kind}: ${o.path}  ${o.sha256.slice(0, 12)}…`);
    return;
  }
  if (command === "match") {
    const r = result;
    line(`参考：${r.reference}`);
    line(`参考指标：YAVG ${fmt(r.referenceSummary.YAVG)} UAVG ${fmt(r.referenceSummary.UAVG)} VAVG ${fmt(r.referenceSummary.VAVG)}`);
    for (const item of r.results) {
      if (!item.ok) { line(`  ✗ ${item.target} — ${item.error}`); continue; }
      line(`  ✓ ${item.output}`);
      line(`    残差 YAVG ${fmt(item.residual.YAVG, 2)} / UAVG ${fmt(item.residual.UAVG, 2)} / VAVG ${fmt(item.residual.VAVG, 2)}`);
    }
    return;
  }
  if (command === "recipes") {
    if (result.items) {
      line(`共 ${result.total} 个配方 · ${result.principle}`);
      for (const item of result.items) {
        line(`  ${item.id.padEnd(22)} ${item.genre} · ${item.scene}`);
        line(`  ${" ".repeat(22)} profile=${item.profile} lut=${item.lut ?? "(无)"} 强度=${item.intensity} 平台=${(item.platforms ?? []).join("/")}`);
      }
      return;
    }
    const r = result.recipe;
    if (!r) { line("未匹配到配方"); return; }
    line(`配方：${r.id} · ${r.genre} · ${r.scene}`);
    line(`情绪：${r.mood}`);
    line(`执行：profile=${r.profile} · lut=${r.lut ?? "(无)"}${r.lutExists ? "" : " ⚠ LUT 缺失"} · 强度=${r.intensity}`);
    line(`目标：${JSON.stringify(r.targets)}${r.platformOverrideApplied ? `（已叠加平台微调：${r.platformOverrideApplied}）` : ""}`);
    line(`避免：${r.avoid.join("；")}`);
    if (r.notes) line(`备注：${r.notes}`);
    return;
  }
  line(JSON.stringify(result, null, 2));
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  const json = flags.json === true;
  const bins = resolveBinaries();
  const roots = allowedRoots();

  const needPath = (value, label) => assertPathAllowed(String(value ?? ""), roots, label);

  let result;
  switch (command) {
    case "health":
      result = (await callTool("colorread.health", {}, { bins })).result;
      break;

    case "probe":
      result = (await callTool("colorread.probe", { input_path: needPath(flags.in, "--in") }, { bins })).result;
      break;

    case "analyze":
      result = (await callTool("colorread.analyze", {
        input_path: needPath(flags.in, "--in"),
        at_seconds: flags.at ? String(flags.at).split(",").map(Number) : undefined,
        neutral_patch: parsePatch(flags.neutral, "--neutral"),
        skin_patch: parsePatch(flags.skin, "--skin"),
        sampling: flags.sampling ? String(flags.sampling) : undefined,
        scene_threshold: flags["scene-threshold"] === undefined ? undefined : Number(flags["scene-threshold"]),
        defects: flags["no-defects"] === true ? false : undefined,
      }, { bins })).result;
      break;

    case "scope":
      result = (await callTool("colorread.scope", {
        input_path: needPath(flags.in, "--in"),
        at_seconds: Number(flags.at ?? 0),
        kinds: flags.kinds ? String(flags.kinds).split(",") : SCOPE_KINDS,
        out_dir: needPath(flags.out ?? "./color-scopes", "--out"),
      }, { bins })).result;
      break;

    case "recipes":
      result = flags.list === true || !flags.id
        ? findRecipes({ list: true, genre: flags.genre ?? null, platform: flags.platform ?? null, keyword: flags.keyword ?? null })
        : findRecipes({ recipeId: String(flags.id), platform: flags.platform ?? null });
      break;

    case "grade": {
      const corrections = flags["corrections-json"] ? JSON.parse(String(flags["corrections-json"])) : {};
      const graded = await grade({
        input: needPath(flags.in, "--in"),
        output: needPath(flags.out, "--out"),
        profile: flags.profile ? String(flags.profile) : null,
        lutPath: flags.lut ? needPath(flags.lut, "--lut") : null,
        corrections,
        intensity: flags.intensity === undefined ? 0.8 : Number(flags.intensity),
        verifyAt: flags.at ? String(flags.at).split(",").map(Number) : null,
        auto: flags.auto === true,
        denoise: flags.denoise === true,
        sampling: flags.sampling ? String(flags.sampling) : undefined,
        sceneThreshold: flags["scene-threshold"] === undefined ? undefined : Number(flags["scene-threshold"]),
        defects: flags["no-defects"] === true ? false : undefined,
        onUnfixable: flags["on-unfixable"] ? String(flags["on-unfixable"]) : undefined,
        bins,
      });
      result = graded;
      break;
    }

    case "best": {
      result = await best({
        input: needPath(flags.in, "--in"),
        output: flags.out ? needPath(flags.out, "--out") : null,
        sampleAt: flags.at ? String(flags.at).split(",").map(Number) : null,
        minImprovement: flags["min-improvement"] === undefined ? 2 : Number(flags["min-improvement"]),
        recipe: flags.recipe ? String(flags.recipe) : null,
        genre: flags.genre ? String(flags.genre) : null,
        platform: flags.platform ? String(flags.platform) : null,
        sampling: flags.sampling ? String(flags.sampling) : undefined,
        sceneThreshold: flags["scene-threshold"] === undefined ? undefined : Number(flags["scene-threshold"]),
        defects: flags["no-defects"] === true ? false : undefined,
        onUnfixable: flags["on-unfixable"] ? String(flags["on-unfixable"]) : undefined,
        bins,
      });
      break;
    }

    case "match": {
      const refs = flags.ref ? [flags.ref].flat() : [];
      const targets = flags.in ? [flags.in].flat() : [];
      if (refs.length !== 1) throw new ColorError("--ref 需要且仅需要一个参考镜", "bad_request");
      const matched = await match({
        reference: needPath(refs[0], "--ref"),
        targets: targets.map((t) => needPath(t, "--in")),
        outDir: needPath(flags["out-dir"], "--out-dir"),
        profile: flags.profile ? String(flags.profile) : null,
        intensity: flags.intensity === undefined ? 1 : Number(flags.intensity),
        histogramCheck: flags["histogram-check"] ? String(flags["histogram-check"]) : "warn",
        denoise: flags.denoise === true,
        bins,
      });
      result = matched;
      break;
    }

    case "compare":
      result = await compareFrames({
        before: needPath(flags.before, "--before"),
        after: needPath(flags.after, "--after"),
        at: Number(flags.at ?? 0),
        output: needPath(flags.out, "--out"),
        bins,
      });
      break;

    case undefined:
    case "help":
      process.stdout.write([
        "color-cli —— 调色工位命令行",
        "",
        "  health                          工位与 ffmpeg 自检",
        "  probe   --in <file>             读素材规格",
        "  analyze --in <file> [--at a,b] [--neutral x,y,w,h] [--skin x,y,w,h]",
        "  scope   --in <file> [--at s] [--kinds waveform,vectorscope,histogram] [--out dir]",
        "  recipes [--list] [--genre <题材>] [--platform <平台>] [--keyword <词>] [--id <配方 id>]",
        "                                  题材×场景调色配方（含 profile/LUT/强度/目标区间/避免事项）",
        "  grade   --in <file> --out <file> [--profile <p>] [--lut <cube>] [--intensity 0..1] [--corrections-json <json>]",
        "                                        [--auto] [--denoise]  自动校正（曝光/饱和/偏色，先校正后创作）；降噪仅在噪点命中时插入",
        "  best    --in <file> [--out <file>] [--at a,b] [--min-improvement 2]",
        "                                  可加 [--recipe <id>] / [--genre <题材>] / [--platform <平台>] 走配方驱动",
        "                                  候选择优+画质打分；判「无需调色」时不产出文件（do no harm）",
        "  match   --ref <file> --in <file> [--in <file>...] --out-dir <dir> [--profile <p>]",
        "                                  [--histogram-check warn|fail|off] [--denoise]",
        "  compare --before <file> --after <file> [--at s] --out <png>",
        "",
        `可用 profile：${Object.keys(PROFILES).join(", ")}`,
        "通用开关：--json（输出原始 JSON）",
      ].join("\n") + "\n");
      return;

    default:
      throw new ColorError(`未知命令：${command}`, "bad_request");
  }

  if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else printHuman(command, result);
}

main().catch((error) => {
  const code = error instanceof ColorError ? error.code : "engine_failed";
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ ok: false, code, message, retryable: error instanceof ColorError ? error.retryable : false })}\n`);
  process.exit(code === "bad_request" || code === "bad_patch" ? 2 : 3);
});
