/**
 * explainer/qa-gates.ts —— 关卡 1「机器闸六条」+ 评审材料装配 · T-2026-0926-0008
 *
 * 六条命令逐字对齐 spec §1.1⑤ / SKILL.md ⑥⑦（参数名与顺序都以真实脚本为准）：
 *   ① motion_check.py   —— 静止段（反 PPT）+ 并发光栅抖动（有源素材时给 --baseline 降误报）
 *   ② sfx_check.py      —— 音效在场（solo 轨）
 *   ③ sfx_check.py --mix—— 音效可听（掩蔽分级；agent 听不了成品，它是耳听的机器替身）
 *   ④ card_lint.py      —— 卡保真（工程内复制件 vs 引擎原文）
 *   ⑤ beat_lint.py      —— 词落点 |Δ|≤0.1s（本引擎的 beats 由 timing 派生，天然对齐；闸仍要跑）
 *   ⑥ qa_extract.py + contact_sheet.py —— 评审材料（每句 2 帧 + 锚点帧 + 3×4 拼图）
 *
 * 纪律：任一 FAIL 即整体 FAIL；**SKIP 必须带理由**（如"本片未用音效"），不允许静默跳过。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePython } from "./asr-aligner.js";
import { engineDirOf } from "./engine.js";
import type { GateResult, QaReport } from "./types.js";
import type { ExplainerQuality } from "./types.js";

export interface GateInput {
  jobDir: string;
  /** 工程用到的卡 slug（card_lint 的全量清单） */
  cards: string[];
  /** 音效 cue 数（0 → sfx 两查 SKIP） */
  cueCount: number;
  /** 人物源素材（motion_check --baseline 用；null = 无源素材） */
  baseline?: string | null;
  /** 抽帧宽度（竖屏 540） */
  qaScale?: number;
  /** 画幅（决定抖动采样窗的裁剪带：竖屏 1080 宽，横屏 1920 宽） */
  aspect?: "9:16" | "16:9";
  quality?: ExplainerQuality;
  /** 分镜起止（每镜取一个采样窗，替代 motion_check 的 18s 自动采样） */
  shots?: Array<{ id: string; start: number; end: number }>;
  engineDir?: string;
  env?: NodeJS.ProcessEnv;
  onLog?: (line: string) => void;
  timeoutMs?: number;
}

export interface GateRunResult {
  report: QaReport;
  qaFramesDir: string;
  sheetsDir: string;
}

async function run(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; onLog?: (l: string) => void },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`${cmd} 超时`)); }, opts.timeoutMs);
    child.stdout.on("data", (d) => { stdout += String(d); });
    child.stderr.on("data", (d) => {
      const text = String(d);
      stderr += text;
      for (const line of text.split("\n")) if (line.trim()) opts.onLog?.(line.trim());
    });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("exit", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
  });
}

function summarize(stdout: string, stderr: string): { summary: string; details: string[] } {
  const text = `${stdout}\n${stderr}`.trim();
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const key = lines.filter((l) => /FAIL|WARN|PASS|OK|警报|失败|警告|判定|静止|掩蔽|不一致|超差/.test(l)).slice(0, 6);
  return { summary: (key[0] ?? lines[lines.length - 1] ?? "").slice(0, 200), details: key };
}

export async function runMachineGates(input: GateInput): Promise<GateRunResult> {
  const env = input.env ?? process.env;
  const engineDir = input.engineDir ?? engineDirOf(env);
  const python = resolvePython(env);
  const timeoutMs = input.timeoutMs ?? 30 * 60_000;
  const qaFramesDir = join(input.jobDir, "out", "qa-frames");
  const sheetsDir = join(input.jobDir, "out", "qa-sheets");
  mkdirSync(qaFramesDir, { recursive: true });
  mkdirSync(sheetsDir, { recursive: true });
  const gates: GateResult[] = [];
  const video = join(input.jobDir, "out", "v1.mp4");
  const audio = join(input.jobDir, "audio", "full.wav");
  const timestamps = join(input.jobDir, "audio", "timestamps.json");
  const cues = join(input.jobDir, "remotion", "cues.json");
  const shots = join(input.jobDir, "remotion", "shots.json");
  const beats = join(input.jobDir, "remotion", "beats.json");
  const anchors = join(input.jobDir, "remotion", "anchors.json");
  const srcDir = join(input.jobDir, "remotion", "src");

  /* ---------- ① motion_check：静止段 + 光栅抖动 ---------- */
  {
    const args = [join(engineDir, "scripts/motion_check.py"), video];
    if (input.baseline && existsSync(input.baseline)) args.push("--baseline", input.baseline);
    /**
     * 显式采样窗（而不是让脚本每 18s 自动采）：脚本的 DEFAULT_CROP 是横屏版面口径
     * （1200×120@(150,150)），竖屏 1080 宽会让 ffmpeg crop 直接报错——抖动闸等于没跑。
     * 这里按画幅给出合法裁剪带，并按**每镜取一点**（首镜动作落点 + 镜中段）覆盖全片。
     */
    const cropScale = input.quality === "uhd" ? 2 : 1;
    const band = (input.aspect ?? "9:16") === "9:16"
      ? `${1080 * cropScale}:${140 * cropScale}:0:${1500 * cropScale}`
      : `${1200 * cropScale}:${120 * cropScale}:${150 * cropScale}:${150 * cropScale}`;
    const windows = new Set<string>();
    for (const shot of input.shots ?? []) {
      windows.add(`${Math.max(1, Math.round((shot.start + 1.2) * 100) / 100)},${band}`);
      const mid = (shot.start + shot.end) / 2;
      windows.add(`${Math.round(mid * 100) / 100},${band}`);
    }
    for (const window of windows) args.push("--window", window);
    args.push("--anchors", anchors);
    const r = await run(python, args, { cwd: input.jobDir, env, timeoutMs, onLog: input.onLog });
    const info = summarize(r.stdout, r.stderr);
    gates.push({
      gate: "motion_check",
      status: r.code === 0 ? (/WARN/.test(r.stdout + r.stderr) ? "warn" : "pass") : "fail",
      command: `python3 scripts/motion_check.py out/v1.mp4${input.baseline ? " --baseline <host>" : ""} --anchors remotion/anchors.json`,
      summary: info.summary,
      details: info.details,
    });
  }

  /* ---------- ② sfx_check：在场（solo 轨；需要单独渲一条纯音效 wav） ---------- */
  if (input.cueCount === 0) {
    gates.push({
      gate: "sfx_check:solo",
      status: "skip",
      command: "python3 scripts/sfx_check.py out/sfx-solo.wav cues.json",
      summary: "本片未声明音效 cue（cues.json 为空）——按纪律 SKIP 并显式记录",
      details: [],
    });
    gates.push({
      gate: "sfx_check:mix",
      status: "skip",
      command: "python3 scripts/sfx_check.py --mix out/delivery.mp4 audio/full.wav cues.json --timestamps audio/timestamps.json",
      summary: "本片未声明音效 cue——交付前可听性复跑一并跳过",
      details: [],
    });
  } else {
    const solo = join(input.jobDir, "out", "sfx-solo.wav");
    /**
     * solo 轨与 props 同源：props（cue 位置/音量）比 solo 新时必须重渲——
     * 复用旧 solo 会让"音效在场"闸对着**上一版的 cue 表**检查（真机踩过：
     * cue 挪进气口后闸仍读 02:39 的旧轨，报"中位峰值 -140dBFS"，其实新轨没渲）。
     */
    const propsFile = join(input.jobDir, "remotion", "props.json");
    const soloFresh = existsSync(solo) && existsSync(propsFile)
      && statSync(solo).mtimeMs >= statSync(propsFile).mtimeMs;
    let soloOk = soloFresh;
    let soloErr = "";
    if (!soloOk) {
      if (existsSync(solo)) input.onLog?.("[sfx_check] props 比 solo 轨新 → 重渲 solo 轨（不复用旧口径）");
      const args = [
        join(engineDir, "scripts/render_shots.mjs"),
        "--shots", "shots.json", "--audio", "../out/sfx-solo.wav",
        // 相对路径：cwd 是工程 remotion/ 目录（与 render_shots 的默认解析一致）
        "--props", "@props-sfx.json",
      ];
      const r = await run("node", args, { cwd: join(input.jobDir, "remotion"), env, timeoutMs, onLog: input.onLog });
      soloOk = r.code === 0 && existsSync(solo);
      soloErr = r.stderr.slice(-300);
    }
    const r = soloOk
      ? await run(python, [join(engineDir, "scripts/sfx_check.py"), solo, cues], { cwd: input.jobDir, env, timeoutMs, onLog: input.onLog })
      : { code: -1, stdout: "", stderr: `solo 轨渲染失败：${soloErr}` };
    const info = summarize(r.stdout, r.stderr);
    gates.push({
      gate: "sfx_check:solo",
      status: r.code === 0 ? "pass" : "fail",
      command: "python3 scripts/sfx_check.py out/sfx-solo.wav cues.json",
      summary: info.summary,
      details: info.details,
    });
    const mix = await run(python, [
      join(engineDir, "scripts/sfx_check.py"), "--mix", video, audio, cues, "--timestamps", timestamps,
    ], { cwd: input.jobDir, env, timeoutMs, onLog: input.onLog });
    const mixInfo = summarize(mix.stdout, mix.stderr);
    gates.push({
      gate: "sfx_check:mix",
      status: mix.code === 0 ? (/WARN/.test(mix.stdout) ? "warn" : "pass") : "fail",
      command: "python3 scripts/sfx_check.py --mix out/v1.mp4 audio/full.wav cues.json --timestamps audio/timestamps.json",
      summary: mixInfo.summary,
      details: mixInfo.details,
    });
  }

  /* ---------- ③ card_lint：卡保真 ---------- */
  {
    const r = await run(python, [join(engineDir, "scripts/card_lint.py"), srcDir, input.cards.join(",")], {
      cwd: input.jobDir, env, timeoutMs: 120_000, onLog: input.onLog,
    });
    const info = summarize(r.stdout, r.stderr);
    gates.push({
      gate: "card_lint",
      status: r.code === 0 ? "pass" : "fail",
      command: `python3 scripts/card_lint.py remotion/src ${input.cards.join(",")}`,
      summary: info.summary,
      details: info.details,
    });
  }

  /* ---------- ④ beat_lint：词落点 |Δ|≤0.1s + 镜尾保护带 ---------- */
  {
    const r = await run(python, [
      join(engineDir, "scripts/beat_lint.py"), beats, timestamps, "--shots", shots, "--anchors", anchors,
    ], { cwd: input.jobDir, env, timeoutMs: 300_000, onLog: input.onLog });
    const info = summarize(r.stdout, r.stderr);
    gates.push({
      gate: "beat_lint",
      status: r.code === 0 ? "pass" : "fail",
      command: "python3 scripts/beat_lint.py remotion/beats.json audio/timestamps.json --shots remotion/shots.json --anchors remotion/anchors.json",
      summary: info.summary,
      details: info.details,
    });
  }

  /* ---------- ⑤ 评审材料：抽帧 + 拼图 ---------- */
  {
    const scale = String(input.qaScale ?? 540);
    const extract = await run(python, [
      join(engineDir, "scripts/qa_extract.py"), video, timestamps, qaFramesDir, scale, anchors,
    ], { cwd: input.jobDir, env, timeoutMs, onLog: input.onLog });
    const sheet = extract.code === 0
      ? await run(python, [join(engineDir, "scripts/contact_sheet.py"), qaFramesDir, sheetsDir], {
          cwd: input.jobDir, env, timeoutMs, onLog: input.onLog,
        })
      : { code: -1, stdout: "", stderr: "qa_extract 失败，拼图未执行" };
    const frames = existsSync(qaFramesDir) ? readdirSync(qaFramesDir).filter((f) => f.endsWith(".png")).length : 0;
    const sheets = existsSync(sheetsDir) ? readdirSync(sheetsDir).filter((f) => f.endsWith(".png")).length : 0;
    const info = summarize(`${extract.stdout}\n${sheet.stdout}`, `${extract.stderr}\n${sheet.stderr}`);
    gates.push({
      gate: "qa_materials",
      status: extract.code === 0 && sheet.code === 0 && frames > 0 && sheets > 0 ? "pass" : "fail",
      command: "python3 scripts/qa_extract.py out/v1.mp4 audio/timestamps.json out/qa-frames 540 remotion/anchors.json && python3 scripts/contact_sheet.py out/qa-frames out/qa-sheets",
      summary: `${frames} 帧 / ${sheets} 张拼图 · ${info.summary}`,
      details: info.details,
    });
  }

  const report: QaReport = {
    jobId: input.jobDir,
    totalFrames: null,
    gates,
    pass: gates.every((g) => g.status === "pass" || g.status === "warn" || g.status === "skip"),
  };
  writeFileSync(join(input.jobDir, "out", "qa-report.json"), JSON.stringify(report, null, 1));
  return { report, qaFramesDir, sheetsDir };
}
