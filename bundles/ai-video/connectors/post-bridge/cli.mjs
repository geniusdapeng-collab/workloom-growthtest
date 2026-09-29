#!/usr/bin/env node
/**
 * post-cli —— 后期交付与返修工位命令行（剪辑师数字员工的"手"）。
 *
 * 用法：
 *   post-cli health
 *   post-cli variants
 *   post-cli plan     --project project.json --shots a.mp4,b.mp4 [--quality hd|uhd] [--variants warm-story,clean-tech]
 *   post-cli deliver  --project project.json --shots a.mp4,b.mp4 --out-dir out/ [--quality hd|uhd]
 *                     [--srt subs.srt] [--srt-en subs.en.srt] [--variants …]
 *                     [--burn-subtitles] [--no-soft-subtitles]
 *   post-cli impact   --project film-project.json --patch patch.json
 *   post-cli reedit   --project film-project.json --patch patch.json [--out-dir versions/v2]
 *                     [--delivery-dir <交付包根>] [--dry-run]
 *                     [--expected-version N --expected-project-sha256 <sha256>]
 *                     [--audio-stems-by-shot signed-sources.json]
 *                     [--shot SC-03=/path/new.mp4]…        # 只在已重生成镜头后使用
 *   post-cli triage   --feedback "配乐太吵了，另外第 3 个镜头人物走形"
 *
 * 退出码：0 成功；2 用法错误；3 工具错误（code 见 PostError）；4 需要人审（镜头重生成走 G8）。
 * 纪律：任何写入都落新文件；母版不烧字幕；复用的产物必须给出"未被重算"的证据。
 */

import fs from "node:fs";
import process from "node:process";

import {
  PostError, analyzeImpact, buildDeliveryPackage, callTool, findVariantPack, listVariantPacks,
  planDelivery, readRevisionBase, reedit, triageFeedback,
} from "./core.mjs";

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  const repeated = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        (repeated[key] ??= []).push(next);
        index += 1;
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, flags, repeated };
}

function readJson(file, label) {
  if (typeof file !== "string") throw new PostError(`${label} 缺失`, "bad_request");
  if (!fs.existsSync(file)) throw new PostError(`${label} 不存在：${file}`, "not_found");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** 镜头清单：--shots a.mp4,b.mp4（按顺序生成 SC-01…）或 --shots shots.json（[{shotId,path}]）。 */
function readShots(value) {
  if (typeof value !== "string") return [];
  if (value.endsWith(".json")) {
    const doc = readJson(value, "shots");
    const list = Array.isArray(doc) ? doc : doc.shots;
    if (!Array.isArray(list)) throw new PostError("shots.json 必须是数组或 { shots: [...] }", "bad_request");
    return list.map((shot, index) => ({
      shotId: String(shot.shotId ?? shot.shot_id ?? `SC-${String(index + 1).padStart(2, "0")}`),
      path: String(shot.path ?? shot.localPath ?? ""),
      ...(shot.kind ? { kind: String(shot.kind) } : {}),
      ...(shot.audioStems ? { audioStems: shot.audioStems } : {}),
    }));
  }
  return value.split(",").map((file, index) => ({
    shotId: `SC-${String(index + 1).padStart(2, "0")}`,
    path: file.trim(),
  })).filter((shot) => shot.path);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { flags, repeated } = parseArgs(rest);
  const line = (text = "") => process.stdout.write(`${text}\n`);

  switch (command) {
    case "health":
      line(JSON.stringify((await callTool("postread.health", {})).result, null, 2));
      return 0;
    case "variants": {
      for (const pack of listVariantPacks()) {
        line(`${pack.id} · ${pack.name} —— ${pack.positioning}`);
        line(`   调色 ${pack.color ? `${pack.color.profile ?? pack.color.lut} @${pack.color.intensity}` : "不调色"} · 转场 ${pack.transitions?.mode ?? "hard"} · BGM ${pack.bgm?.enabled === false ? "不配乐" : `${pack.bgm?.mood}/${pack.bgm?.style}`} · 封面 ${pack.cover?.template ?? "默认"}`);
      }
      return 0;
    }
    case "plan": {
      const project = { ...readJson(flags.project, "--project"), ...(flags.quality ? { quality: flags.quality } : {}) };
      const shots = readShots(flags.shots);
      if (shots.length === 0) throw new PostError("--shots 缺失（a.mp4,b.mp4 或 shots.json）", "bad_request");
      const variants = typeof flags.variants === "string" ? flags.variants.split(",").map((id) => id.trim()).filter(Boolean) : null;
      const plan = await planDelivery({ project, shots, variants });
      line(`交付计划 · ${plan.projectId} · ${plan.shots.length} 镜 / ${plan.totalSeconds}s / ${plan.resolution.join("×")}@${plan.fps}fps`);
      line("变体：");
      for (const variant of plan.variants) {
        line(`  ${variant.id}（${variant.name}）：调色 ${variant.axes.color} · BGM ${variant.axes.bgm} · 转场 ${variant.axes.transitions} · 封面 ${variant.axes.cover} · 文案 ${variant.axes.copy}`);
      }
      line(`成本：${plan.cost.note}`);
      return 0;
    }
    case "deliver": {
      const project = { ...readJson(flags.project, "--project"), ...(flags.quality ? { quality: flags.quality } : {}) };
      const shots = readShots(flags.shots);
      if (shots.length === 0) throw new PostError("--shots 缺失（a.mp4,b.mp4 或 shots.json）", "bad_request");
      if (typeof flags["out-dir"] !== "string") throw new PostError("--out-dir 缺失", "bad_request");
      const variants = typeof flags.variants === "string" ? flags.variants.split(",").map((id) => id.trim()).filter(Boolean) : null;
      const outcome = await buildDeliveryPackage({
        project,
        shots,
        subtitles: flags.srt
          ? { zhPath: flags.srt, enPath: typeof flags["srt-en"] === "string" ? flags["srt-en"] : null }
          : null,
        variants,
        outDir: flags["out-dir"],
        burnSubtitles: flags["burn-subtitles"] === true,
        softSubtitles: flags["no-soft-subtitles"] !== true,
      });
      line(`交付包：${outcome.outDir}`);
      line(`  干净母版 ${outcome.manifest.master.path} · ${outcome.manifest.master.duration}s · 不含字幕`);
      if (outcome.manifest.subtitles) {
        line(`  字幕文件 ${outcome.manifest.subtitles.files.map((file) => file.path.split("/").pop()).join("、")}（母版未被改动）`);
      }
      for (const variant of outcome.manifest.variants) {
        line(`  变体 ${variant.id}：${variant.video.path}${variant.softsub ? ` + ${variant.softsub.path.split("/").pop()}（软字幕轨）` : ""}`);
      }
      line("  变体差异（实测）：");
      for (const row of outcome.manifest.divergence) {
        line(`    ${row.a} × ${row.b}：画面平均像素差 ${row.visual.meanAbsDiff}/255（${row.visual.verdict}）· 音频 ${row.audio.differs ? "不同" : "相同"}`);
      }
      line(`  清单：${outcome.manifestPath}`);
      line(`  工程文件：${outcome.projectPath}（返修入口）`);
      return outcome.passed ? 0 : 3;
    }
    case "impact": {
      const patch = readJson(flags.patch, "--patch");
      const project = flags.project ? readJson(flags.project, "--project") : null;
      const impact = analyzeImpact({ project, patch });
      line(`受影响层：${impact.layers.join(" → ") || "（无）"}`);
      for (const reason of impact.reasons) line(`  · ${reason}`);
      line(`本地重合成：${impact.localOnly ? "是（不重新生成镜头）" : "否（需先重生成点名镜头，过 G8 人审）"}`);
      line(`成本：${impact.costHint.note}`);
      if (impact.shotRegeneration.required) line(`点名镜头：${impact.shotRegeneration.shotIds.join("、") || "（未点名，需补）"}`);
      return 0;
    }
    case "reedit": {
      const patch = readJson(flags.patch, "--patch");
      const explicitVersion = flags["expected-version"];
      const explicitHash = flags["expected-project-sha256"];
      if ((explicitVersion !== undefined) !== (explicitHash !== undefined)
        || (explicitVersion !== undefined && (typeof explicitVersion !== "string" || !/^[1-9]\d*$/.test(explicitVersion)
          || typeof explicitHash !== "string" || !/^[a-f0-9]{64}$/.test(explicitHash)))) {
        throw new PostError("--expected-version 和 --expected-project-sha256 必须同时提供有效版本和完整 SHA256", "bad_request");
      }
      // --project is the user's chosen base. Capture its exact bytes once;
      // the core still rejects it if a different request has already advanced.
      const base = readRevisionBase(flags.project);
      const shotPaths = Object.fromEntries((repeated["shot"] ?? []).map((entry) => {
        const index = entry.indexOf("=");
        if (index < 0) throw new PostError(`--shot 需要形如 SC-03=/path/new.mp4，收到：${entry}`, "bad_request");
        return [entry.slice(0, index), entry.slice(index + 1)];
      }));
      const outcome = await reedit({
        projectPath: flags.project,
        deliveryDir: typeof flags["delivery-dir"] === "string" ? flags["delivery-dir"] : null,
        expectedVersion: explicitVersion === undefined ? base.version : Number(explicitVersion),
        expectedProjectSha256: explicitHash === undefined ? base.sha256 : explicitHash,
        patch,
        outDir: typeof flags["out-dir"] === "string" ? flags["out-dir"] : null,
        shotPaths: Object.keys(shotPaths).length ? shotPaths : null,
        audioStemsByShot: flags["audio-stems-by-shot"] ? readJson(flags["audio-stems-by-shot"], "--audio-stems-by-shot") : null,
        dryRun: flags["dry-run"] === true,
      });
      if (!outcome.executed) {
        if (outcome.dryRun) line(JSON.stringify({ expectedVersion: outcome.expectedVersion, expectedProjectSha256: outcome.expectedProjectSha256 }));
        line(`未执行（${outcome.blocked?.code ?? outcome.impact?.layers.join("/") ?? "planned"}）：${outcome.blocked?.message ?? "dry-run"}`);
        for (const action of outcome.blocked?.nextActions ?? []) line(`  ${action}`);
        return outcome.blocked?.code === "shot_regeneration_required" ? 4 : 0;
      }
      line(`返修完成：v${outcome.version} → ${outcome.targetDir}`);
      const fmt = (rows) => (rows.length
        ? rows.map((row) => `${row.layer}${row.variants.length ? `(${row.variants.join(",")})` : `×${row.count}`}`).join(" · ")
        : "（无）");
      line(`  重算：${fmt(outcome.summary.rebuiltByLayer)}`);
      line(`  复用：${fmt(outcome.summary.reusedByLayer)}（未被重算，哈希可直接对账）`);
      line(`  成本：${outcome.summary.note}`);
      line(`  返修记录：${outcome.revisionPath}`);
      return 0;
    }
    case "triage": {
      if (typeof flags.feedback !== "string") throw new PostError("--feedback 缺失", "bad_request");
      const outcome = triageFeedback({
        feedback: flags.feedback,
        project: flags.project ? readJson(flags.project, "--project") : null,
        variants: typeof flags.variants === "string" ? flags.variants.split(",") : null,
      });
      line(`归因：${outcome.attributions.join("、")}（${outcome.kinds.join("/")}）`);
      line(`受影响层：${outcome.layers.join(" → ") || "（需人工指认）"}`);
      line(`是否需要重生成镜头：${outcome.requiresShotRegeneration ? `是（${outcome.shotIds.join("、") || "未点名"}，走 ${outcome.gate} 人审）` : "否（本地重合成）"}`);
      line(`成本：${outcome.costHint.note}`);
      line(`回复用户：${outcome.reply}`);
      line("下一步：");
      for (const action of outcome.nextActions) line(`  ${action}`);
      line(`patch 提示：${JSON.stringify(outcome.patchHint)}`);
      return 0;
    }
    default:
      process.stderr.write(
        "用法：post-cli <health|variants|plan|deliver|impact|reedit|triage> [--flags]\n"
        + "参见 bundles/ai-video/connectors/post-bridge/README.md\n",
      );
      return 2;
  }
}

main()
  /**
   * 退出方式：**设 exitCode 而不是 `process.exit()`**（2026-09-24 真机修复）。
   *
   * 实测（Node 24.19.0 / macOS arm64）：一次完整交付跑完后立刻 `process.exit(0)`，进程会卡在
   * Node 关停阶段（`DisposePlatform → WorkerThreadsTaskRunner::Shutdown → uv_thread_join`）等一个
   * 正在做 V8 baseline 编译的 worker 线程——产物其实早已写全（清单/报告都在盘上），但调用方永远等不到退出，
   * 自动化脚本与"作业式"调用会被挂住。改成自然退出：事件循环排空后 Node 自己关停，不抢线程。
   */
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    const code = typeof error?.code === "string" ? error.code : "engine_failed";
    process.stderr.write(`${code}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 3;
  });

void findVariantPack;
