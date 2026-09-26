#!/usr/bin/env tsx
/**
 * 白板引擎环境安装器（T-2026-0926-0020）
 *
 * 做三件事，幂等可重复执行：
 *   ① 选一个满足版本要求的 Python 解释器（>= 3.10；3.9 及以下装不了 PyAV/numpy2 的 wheel）；
 *   ② 调上游 `vendor/srt-whiteboard/scripts/prepare_env.py` 建隔离 venv 并补齐依赖；
 *   ③ 校验四个依赖（cv2 / numpy / av / PIL）真的能 import，并把 `ENV_PY` 落进构建产物目录供排障。
 *
 * 用法：
 *   pnpm exec tsx scripts/tools/whiteboard-env-install.mts                # 安装/修复
 *   pnpm exec tsx scripts/tools/whiteboard-env-install.mts --check        # 只探测（缺即非 0 退出）
 *   pnpm exec tsx scripts/tools/whiteboard-env-install.mts --python /opt/homebrew/bin/python3.12
 *
 * 纪律：不写入任何密钥；venv 落在 `vendor/srt-whiteboard/.venv`（已 gitignore）；
 * 不用系统 python 直接跑渲染（依赖污染会把渲染结果变得不可复现）。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");
const ENGINE_DIR = resolve(process.env.WHITEBOARD_ENGINE_DIR?.trim() || join(REPO_ROOT, "vendor/srt-whiteboard"));
const PREPARE = join(ENGINE_DIR, "scripts/prepare_env.py");
const VENV_PY = process.platform === "win32"
  ? join(ENGINE_DIR, ".venv", "Scripts", "python.exe")
  : join(ENGINE_DIR, ".venv", "bin", "python");

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}
const flag = (name: string) => process.argv.includes(name);

interface Candidate { path: string; version: [number, number]; label: string }

/** 候选解释器：显式参数 > 环境变量 > 常见路径（版本要求 >= 3.10） */
function candidateInterpreters(): Array<{ path: string; label: string }> {
  const explicit = arg("--python") || process.env.WHITEBOARD_PYTHON_BOOTSTRAP || "";
  const names = process.platform === "win32"
    ? ["python3.12", "python3.11", "python3.10", "python"]
    : ["python3.12", "python3.13", "python3.11", "python3.10", "python3", "python"];
  return [
    ...(explicit ? [{ path: explicit, label: "--python 指定" }] : []),
    ...names.map((n) => ({ path: n, label: "PATH" })),
    { path: "/opt/homebrew/bin/python3", label: "Homebrew arm64" },
    { path: "/usr/local/bin/python3", label: "Homebrew x64" },
    { path: "/usr/bin/python3", label: "系统 python3" },
  ];
}

function probe(path: string): Candidate | null {
  try {
    const out = execFileSync(path, [
      "-c", "import sys; print('%d.%d' % sys.version_info[:2])",
    ], { encoding: "utf8", timeout: 20_000 }).trim();
    const [maj, min] = out.split(".").map(Number);
    if (!Number.isFinite(maj) || !Number.isFinite(min)) return null;
    return { path, version: [maj!, min!], label: `${maj}.${min}` };
  } catch {
    return null;
  }
}

function pickInterpreter(): Candidate {
  const tried: string[] = [];
  for (const candidate of candidateInterpreters()) {
    const probed = probe(candidate.path);
    if (!probed) continue;
    tried.push(`${probed.path} → ${probed.label}`);
    if (probed.version[0] > 3 || (probed.version[0] === 3 && probed.version[1] >= 10)) return probed;
  }
  throw new Error(
    `找不到 >= 3.10 的 Python 解释器（依赖闭包 PyAV/numpy2 在 3.9 及以下没有 macOS arm64 wheel）。\n`
    + `  已探测：${tried.join("；") || "无"}\n`
    + "  修复：装一个 python3.12（brew install python@3.12），或用 --python <路径> 指定。",
  );
}

function dependencyReport(): { ok: boolean; detail: string[] } {
  if (!existsSync(VENV_PY)) return { ok: false, detail: [`venv 解释器不存在：${VENV_PY}`] };
  const detail: string[] = [];
  let ok = true;
  for (const [importName, pipName] of [["cv2", "opencv-python"], ["numpy", "numpy"], ["av", "PyAV"], ["PIL", "Pillow"]] as const) {
    try {
      const version = execFileSync(VENV_PY, [
        "-c", `import ${importName}; print(getattr(${importName}, '__version__', 'ok'))`,
      ], { encoding: "utf8", timeout: 60_000 }).trim();
      detail.push(`[ok] ${pipName} ${version}`);
    } catch (err) {
      ok = false;
      detail.push(`[miss] ${pipName}：${(err as Error).message.split("\n")[0]}`);
    }
  }
  return { ok, detail };
}

function main(): void {
  if (!existsSync(PREPARE)) {
    console.error(`白板引擎脚本缺失：${PREPARE}\n  （vendor/srt-whiteboard 未随仓分发？见 vendor/srt-whiteboard/VENDOR.md）`);
    process.exit(1);
  }

  const python = pickInterpreter();
  console.log(`[..] 引导解释器：${python.path}（Python ${python.label}）`);
  const args = [PREPARE, ...(flag("--check") ? ["--check"] : [])];
  try {
    const out = execFileSync(python.path, args, { encoding: "utf8", timeout: 30 * 60_000 });
    process.stdout.write(out);
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    process.stdout.write(e.stdout ?? "");
    process.stderr.write(e.stderr ?? e.message ?? "");
    process.exit(1);
  }

  const report = dependencyReport();
  for (const line of report.detail) console.log(`  ${line}`);
  if (!report.ok) {
    console.error("\n依赖不齐：请重跑本命令（不带 --check）补齐。");
    process.exit(1);
  }
  if (flag("--check")) {
    console.log(`\nENV_PY=${VENV_PY}`);
    return;
  }

  // 把解释器路径写进运行目录，便于排障（不放仓库受控清单里，避免每台机器 diff）
  const dir = resolve(process.env.WHITEBOARD_JOBS_DIR?.trim() || join(REPO_ROOT, "var/whiteboard-jobs"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "env.json"), `${JSON.stringify({
    envPy: VENV_PY,
    bootstrapPython: python.path,
    pythonVersion: python.label,
    engineDir: ENGINE_DIR,
    installedAt: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");
  console.log(`\nENV_PY=${VENV_PY}`);
  console.log("下一步：把 .env 的 WHITEBOARD_ENABLED 置 1（媒体目录里会出现 whiteboard-stream 模型）。");
}

main();
