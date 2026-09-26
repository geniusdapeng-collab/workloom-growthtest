#!/usr/bin/env tsx
/**
 * talkcraft-engine-install.mts —— talkcraft 引擎安装器（T-2026-0926-0008）
 *
 * 为什么不把引擎源码提交进仓库：上游许可是 **PolyForm Noncommercial 1.0.0**
 * （"any commercial use of the toolkit requires prior authorization from the author"）。
 * 本仓是商用产品，复制上游源码进仓 = 未授权再分发。因此改为**安装期拉取**：
 *
 *   ① 源码：优先用本机已有克隆（--source），缺失时 `git clone` 上游（--ref 指定 commit/tag，缺省 main）；
 *   ② 复制**受控子集**到 `vendor/talkcraft/`（.gitignore 已忽略）：scripts/ template/ references/
 *      runtime/（不含 node_modules）demos/_lib/sfx-samples.js + 授权记录 + LICENSE + THIRD_PARTY_NOTICES；
 *   ③ 写 `PINNED`（commit sha + 日期 + 卡数 + runtime 版本）——复现同一支片子的依据；
 *   ④ `--with-runtime`：在 vendor/talkcraft/runtime 下 npm ci + 下载共享无头浏览器 + 冒烟渲 1 帧，
 *      通过后落 `.runtime-ready`（渲染 provider 的就绪闸）；
 *   ⑤ `--with-asr`：建 `var/tcvenv` 并装 mlx-whisper（Apple Silicon 词级时间戳后端）。
 *
 * 用法：
 *   pnpm talkcraft:install -- --source /path/to/video-talkcraft --ref <sha|tag|branch>
 *   pnpm talkcraft:install -- --with-runtime --with-asr
 *   pnpm talkcraft:install -- --check          # 只体检（不写入），输出引擎状态 JSON
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2);
const has = (name: string): boolean => args.includes(`--${name}`);
const opt = (name: string, fallback: string): string => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1]! : fallback;
};

const SOURCE = resolve(opt("source", join(REPO_ROOT, "var/talkcraft-src/video-talkcraft")));
const REF = opt("ref", "");
const ENGINE_DIR = resolve(process.env.TALKCRAFT_ENGINE_DIR?.trim() || join(REPO_ROOT, "vendor/talkcraft"));
const CHECK_ONLY = has("check");
const WITH_RUNTIME = has("with-runtime");
const WITH_ASR = has("with-asr");

function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

function sh(cmd: string, cmdArgs: string[], opts: { cwd?: string; allowFail?: boolean } = {}): { code: number; out: string } {
  const result = spawnSync(cmd, cmdArgs, { cwd: opts.cwd, encoding: "utf8", env: process.env, maxBuffer: 64 * 1024 * 1024 });
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if ((result.status ?? -1) !== 0 && !opts.allowFail) {
    throw new Error(`${cmd} ${cmdArgs.join(" ")} 失败（退出码 ${result.status}）：${out.slice(-600)}`);
  }
  return { code: result.status ?? -1, out };
}

function git(argsIn: string[], cwd: string): string {
  return sh("git", argsIn, { cwd }).out.trim();
}

function main(): void {
  if (CHECK_ONLY) {
    const status = checkEngine();
    log(JSON.stringify(status, null, 2));
    process.exit(status.ready ? 0 : 1);
  }

  /* ---------- ① 源码 ---------- */
  let source = SOURCE;
  if (!existsSync(join(source, "SKILL.md"))) {
    log(`[engine] 本机无源码 → git clone ${refHint()} → var/talkcraft-src/video-talkcraft`);
    mkdirSync(join(REPO_ROOT, "var/talkcraft-src"), { recursive: true });
    const cloneArgs = ["clone", "--depth", "1"];
    if (REF) cloneArgs.push("--branch", REF);
    cloneArgs.push("https://github.com/Vincentwei1021/video-talkcraft.git", source);
    sh("git", cloneArgs);
  } else if (REF) {
    log(`[engine] 源码已在位，按 --ref ${REF} 对齐`);
    sh("git", ["fetch", "--depth", "1", "origin", REF], { cwd: source });
    sh("git", ["checkout", "--detach", "FETCH_HEAD"], { cwd: source });
  }
  const commit = git(["rev-parse", "HEAD"], source);
  const dirty = git(["status", "--porcelain"], source);
  log(`[engine] 源码 commit ${commit}${dirty ? "（工作树有未提交改动——按现状复制，PINNED 会标注 dirty）" : ""}`);

  /* ---------- ② 受控子集复制 ---------- */
  rmSync(ENGINE_DIR, { recursive: true, force: true });
  mkdirSync(ENGINE_DIR, { recursive: true });
  const copies: Array<[string, string]> = [
    ["LICENSE", "LICENSE"],
    ["THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md"],
    ["scripts", "scripts"],
    ["template", "template"],
    ["references", "references"],
    ["runtime", "runtime"],
  ];
  for (const [from, to] of copies) {
    const src = join(source, from);
    if (!existsSync(src)) throw new Error(`上游缺少必需路径：${from}`);
    cpSync(src, join(ENGINE_DIR, to), { recursive: true, filter: (p) => !p.includes("node_modules") });
  }
  // sfx 采样（base64 内嵌版 + 授权记录）——sfx_dump.mjs 的输入，缺它就没有音效库
  mkdirSync(join(ENGINE_DIR, "demos/_lib"), { recursive: true });
  cpSync(join(source, "demos/_lib/sfx-samples.js"), join(ENGINE_DIR, "demos/_lib/sfx-samples.js"));
  mkdirSync(join(ENGINE_DIR, "demos/_lib/sfx"), { recursive: true });
  cpSync(join(source, "demos/_lib/sfx/ATTRIBUTION.md"), join(ENGINE_DIR, "demos/_lib/sfx/ATTRIBUTION.md"));
  if (existsSync(join(source, "workbench"))) {
    // 工作台（剪映式）体积大且依赖 dev server；PoC 阶段不复制，交付面后接时再加
    log("[engine] 跳过 workbench/（PoC 不接工作台；见模板 README「不在模板里的部分」）");
  }
  rmSync(join(ENGINE_DIR, "runtime/node_modules"), { recursive: true, force: true });
  rmSync(join(ENGINE_DIR, ".runtime-ready"), { force: true });

  /* ---------- ③ PINNED ---------- */
  const cards = readdirSync(join(ENGINE_DIR, "template/cards")).filter((f) => f.endsWith(".tsx")).length;
  const runtimePkg = JSON.parse(readFileSync(join(ENGINE_DIR, "runtime/package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
  const pin = {
    schema: "workloom.talkcraft-engine-pin/v1",
    source: "https://github.com/Vincentwei1021/video-talkcraft",
    commit,
    dirty: dirty.length > 0,
    syncedAt: new Date().toISOString(),
    syncedBy: process.env.USER ?? "unknown",
    license: "PolyForm-Noncommercial-1.0.0",
    cards,
    runtimeVersion: runtimePkg.dependencies["remotion"] ?? "unknown",
    subset: ["LICENSE", "THIRD_PARTY_NOTICES.md", "scripts/", "template/", "references/", "runtime/", "demos/_lib/sfx-samples.js"],
  };
  writeFileSync(join(ENGINE_DIR, "PINNED"), `${JSON.stringify(pin, null, 1)}\n`);
  log(`[engine] 已复制受控子集 → ${ENGINE_DIR}（卡 ${cards} 张 · runtime remotion ${pin.runtimeVersion}）`);

  /* ---------- ④ 运行时 ---------- */
  if (WITH_RUNTIME) {
    const npmBin = resolveNpm();
    const runtimeDir = join(ENGINE_DIR, "runtime");
    /**
     * registry：直连 registry.npmjs.org 在国内实测每个 tarball 2–4 分钟（14 分钟只拉了 6 个包）；
     * 默认走 npmmirror 镜像（实测 0.15s 响应），可用 TALKCRAFT_NPM_REGISTRY 覆盖回官方源。
     */
    const registry = process.env.TALKCRAFT_NPM_REGISTRY?.trim() || "https://registry.npmmirror.com";
    log(`[engine] 安装运行时依赖（npm ci @ ${registry}，约 760MB，含共享无头浏览器 ~95MB）…`);
    sh(npmBin.cmd, [...npmBin.args, "ci", "--no-audit", "--no-fund", "--loglevel=error", "--registry", registry], { cwd: runtimeDir });
    sh(npmBin.cmd, [...npmBin.args, "exec", "--", "remotion", "browser", "ensure"], { cwd: runtimeDir });
    const smoke = sh(npmBin.cmd, [...npmBin.args, "exec", "--", "remotion", "still", "smoke/index.ts", "Smoke", join(runtimeDir, "smoke.png"), "--frame=5"], {
      cwd: runtimeDir, allowFail: true,
    });
    if (smoke.code !== 0 || !existsSync(join(runtimeDir, "smoke.png"))) {
      throw new Error(`运行时冒烟失败（未落 .runtime-ready）：${smoke.out.slice(-400)}`);
    }
    writeFileSync(join(ENGINE_DIR, ".runtime-ready"), `${new Date().toISOString()}\n`);
    log("[engine] 运行时冒烟 PASS → .runtime-ready");
  } else if (!existsSync(join(ENGINE_DIR, "runtime/node_modules"))) {
    log("[engine] 提示：未加 --with-runtime，运行时依赖尚未安装（渲染前必须补跑）");
  }

  /* ---------- ⑤ ASR（mlx-whisper） ---------- */
  if (WITH_ASR) {
    const venv = join(REPO_ROOT, "var/tcvenv");
    const python = process.env.TALKCRAFT_PYTHON?.trim() || "python3";
    if (!existsSync(join(venv, "bin/python"))) {
      log(`[engine] 建 ASR venv：${venv}`);
      sh(python, ["-m", "venv", venv]);
    }
    sh(join(venv, "bin/pip"), ["install", "-q", "--disable-pip-version-check", "--upgrade", "pip"], { allowFail: true });
    /**
     * 依赖口径（真机补）：引擎的脚本依赖分开装——
     *   mlx-whisper   —— 词级时间戳后端（ASR）；
     *   numpy/imageio —— motion_check 的抖动判定（缺了只退化成静止检查，抖动闸等于没跑）；
     *   pillow        —— contact_sheet 拼图（缺了评审材料出不来）。
     * 三者都是"闸/材料"的硬依赖，装不全就会出现"闸静默降级"，所以一起装。
     */
    sh(join(venv, "bin/pip"), ["install", "-q", "--disable-pip-version-check", "mlx-whisper", "numpy", "imageio", "pillow"]);
    log("[engine] Python 依赖就绪：mlx-whisper（ASR）+ numpy/imageio（抖动闸）+ pillow（评审拼图）");
  }

  const status = checkEngine();
  log(`[engine] 完成：installed=${status.installed} runtime=${status.runtimeInstalled} license=${status.license.scope} ready=${status.ready}`);
  log(`[engine] 许可口径：${status.license.reason}`);
  if (!status.ready) log(`[engine] 尚未就绪：${status.reason}`);
}

/** npm 解析：PATH → 本机 npm-cli.js 兜底（node 发行版不带 npm 的机器上也能装运行时） */
function resolveNpm(): { cmd: string; args: string[] } {
  const which = spawnSync("npm", ["-v"], { encoding: "utf8" });
  if ((which.status ?? -1) === 0) return { cmd: "npm", args: [] };
  const candidates = [
    process.env.NPM_CLI_JS?.trim() ?? "",
    "/private/tmp/npmtool62/package/bin/npm-cli.js",
    join(homedir(), ".local/share/npm/lib/node_modules/npm/bin/npm-cli.js"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { cmd: process.execPath, args: [candidate] };
  }
  throw new Error("找不到 npm（PATH / NPM_CLI_JS / 常见兜底位置都没有）——运行时安装需要 npm 或 pnpm");
}

function refHint(): string {
  return REF ? `${REF}` : "main";
}

function checkEngine(): {
  engineDir: string;
  installed: boolean;
  missing: string[];
  cards: number;
  runtimeInstalled: boolean;
  runtimeReady: boolean;
  license: { scope: string; grantPresent: boolean; okToRender: boolean; reason: string };
  ready: boolean;
  reason: string;
} {
  const required = [
    "LICENSE", "PINNED", "scripts/render_shots.mjs", "scripts/make_timing.py", "scripts/card_lint.py",
    "scripts/beat_lint.py", "scripts/motion_check.py", "scripts/sfx_check.py", "scripts/qa_extract.py",
    "scripts/contact_sheet.py", "scripts/preflight.py", "scripts/voice_trim.py", "runtime/package.json",
  ];
  const missing = required.filter((rel) => !existsSync(join(ENGINE_DIR, rel)));
  const cardsDir = join(ENGINE_DIR, "template/cards");
  const cards = existsSync(cardsDir) ? readdirSync(cardsDir).filter((f) => f.endsWith(".tsx")).length : 0;
  const runtimeInstalled = existsSync(join(ENGINE_DIR, "runtime/node_modules"));
  const runtimeReady = existsSync(join(ENGINE_DIR, ".runtime-ready"));
  const scope = (process.env.TALKCRAFT_LICENSE_SCOPE ?? "noncommercial").trim();
  const grantPresent = existsSync(join(ENGINE_DIR, "LICENSE-GRANT.md"));
  const licenseOk = scope === "authorized" ? grantPresent : true;
  const installed = missing.length === 0;
  const ready = installed && runtimeInstalled && runtimeReady && licenseOk;
  return {
    engineDir: ENGINE_DIR,
    installed,
    missing,
    cards,
    runtimeInstalled,
    runtimeReady,
    license: {
      scope,
      grantPresent,
      okToRender: licenseOk,
      reason: licenseOk
        ? (scope === "authorized" ? "已声明商用授权且 LICENSE-GRANT.md 在场" : "非商用范围（评估/内部验证）")
        : "声明商用授权但缺 LICENSE-GRANT.md",
    },
    ready,
    reason: ready ? "引擎就绪" : `未就绪（missing=${missing.length} runtime=${runtimeInstalled} ready=${runtimeReady} license=${licenseOk}）`,
  };
}

main();
