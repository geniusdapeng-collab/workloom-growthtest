/**
 * explainer/engine.ts —— talkcraft 引擎的定位、体检与许可闸 · T-2026-0926-0008
 *
 * 为什么引擎**不入库**（规格书 v2.0 review 修复 F1）：
 *   上游 `Vincentwei1021/video-talkcraft` 的许可是 **PolyForm Noncommercial 1.0.0**——
 *   "noncommercial use is free; any commercial use of the toolkit requires prior authorization from the author"。
 *   把它的源码（108 张卡 tsx + 12 个管线脚本）复制进 WorkLoom-growth 这个商用产品仓库即构成再分发，
 *   且默认商用未获授权。因此本仓只保留**我方代码**（模板 / 调度 / 数据契约），引擎改为：
 *     ① 安装期从上游按 PINNED commit 拉取到 `vendor/talkcraft/`（已进 .gitignore，不进仓）；
 *     ② 运行前过三关：文件齐备 → LICENSE/PINNED 在场 → 许可范围与授权记录匹配；
 *     ③ CI 闸 `scripts/ci/verify-talkcraft-license.mjs` 反向检查"上游源码没有被提交进 git"。
 *
 * 许可范围（`TALKCRAFT_LICENSE_SCOPE`）：
 *   - `noncommercial`（缺省）：评估 / 研究 / 内部验证可用，**不得对外商用交付**；
 *   - `authorized`：拿到作者书面商业授权后使用，必须把授权文件放到 `<engine>/LICENSE-GRANT.md`
 *     （内容含授权方、被授权方、范围、日期），闸门只认"文件在场"，不认口头/环境变量声明。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** apps/server/src/video/explainer → 仓库根（explainer→video→src→server→apps→root） */
export const REPO_ROOT = resolve(HERE, "../../../../..");

export type LicenseScope = "noncommercial" | "authorized";

export interface EnginePin {
  schema?: string;
  source?: string;
  commit?: string;
  syncedAt?: string;
  license?: string;
  cards?: number;
  runtimeVersion?: string;
  syncedBy?: string;
}

export interface LicenseState {
  scope: LicenseScope;
  /** 上游 LICENSE 文件在引擎目录在场 */
  upstreamLicensePresent: boolean;
  /** 上游许可证类型（读到文件头判定：PolyForm Noncommercial / 其他） */
  upstreamLicenseKind: "polyform-noncommercial" | "unknown" | "missing";
  /** 作者书面商业授权文件（LICENSE-GRANT.md）在场 */
  grantPresent: boolean;
  /** 当前是否允许渲染交付（noncommercial 可用于评估；authorized 必须有授权文件） */
  okToRender: boolean;
  reason: string;
}

/** 引擎必需文件（缺一即"未安装"；与 spec §1.1 的真实 CLI 清单逐条对齐） */
export const REQUIRED_ENGINE_FILES = [
  "LICENSE",
  "PINNED",
  "runtime/package.json",
  "runtime/check-runtime.sh",
  "scripts/render_shots.mjs",
  "scripts/render_stills.mjs",
  "scripts/timestamps_cpu.py",
  "scripts/make_timing.py",
  "scripts/voice_trim.py",
  "scripts/semantic_annotate.py",
  "scripts/preflight.py",
  "scripts/motion_check.py",
  "scripts/sfx_check.py",
  "scripts/card_lint.py",
  "scripts/beat_lint.py",
  "scripts/qa_extract.py",
  "scripts/contact_sheet.py",
  "scripts/cards_index.py",
  "scripts/card_match.py",
] as const;

export const REQUIRED_ENGINE_DIRS = ["template/cards", "template/motion-systems", "references/cards"] as const;

export function engineDirOf(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.TALKCRAFT_ENGINE_DIR?.trim() || "vendor/talkcraft";
  return isAbsolute(raw) ? raw : resolve(REPO_ROOT, raw);
}

export function jobsDirOf(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.TALKCRAFT_JOBS_DIR?.trim() || "var/talkcraft-jobs";
  return isAbsolute(raw) ? raw : resolve(REPO_ROOT, raw);
}

export function readEnginePin(engineDir = engineDirOf()): EnginePin | null {
  const file = join(engineDir, "PINNED");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as EnginePin;
  } catch {
    return null;
  }
}

export function licenseScopeOf(env: NodeJS.ProcessEnv = process.env): LicenseScope {
  const raw = (env.TALKCRAFT_LICENSE_SCOPE ?? "noncommercial").trim().toLowerCase();
  if (raw === "authorized" || raw === "commercial") return "authorized";
  if (raw === "noncommercial" || raw === "eval" || raw === "evaluation") return "noncommercial";
  throw new Error(`TALKCRAFT_LICENSE_SCOPE 非法：${raw}（合法值：noncommercial | authorized）`);
}

export function licenseStateOf(engineDir = engineDirOf(), env: NodeJS.ProcessEnv = process.env): LicenseState {
  const scope = licenseScopeOf(env);
  const licenseFile = join(engineDir, "LICENSE");
  const upstreamLicensePresent = existsSync(licenseFile);
  let upstreamLicenseKind: LicenseState["upstreamLicenseKind"] = "missing";
  if (upstreamLicensePresent) {
    const head = readFileSync(licenseFile, "utf8").slice(0, 4000);
    upstreamLicenseKind = /PolyForm Noncommercial/i.test(head) ? "polyform-noncommercial" : "unknown";
  }
  const grantPresent = existsSync(join(engineDir, "LICENSE-GRANT.md"));

  if (!upstreamLicensePresent) {
    return { scope, upstreamLicensePresent, upstreamLicenseKind, grantPresent, okToRender: false, reason: "引擎目录缺上游 LICENSE 原文（安装器损坏）" };
  }
  if (scope === "authorized") {
    return {
      scope, upstreamLicensePresent, upstreamLicenseKind, grantPresent,
      okToRender: grantPresent,
      reason: grantPresent
        ? "已声明商用授权且 LICENSE-GRANT.md 在场"
        : "TALKCRAFT_LICENSE_SCOPE=authorized 但缺 LICENSE-GRANT.md（作者书面商业授权文件）——闸门拒绝渲染",
    };
  }
  return {
    scope, upstreamLicensePresent, upstreamLicenseKind, grantPresent,
    okToRender: true,
    reason: "非商用范围（评估/研究/内部验证）：PolyForm Noncommercial 允许免费使用；对外商用交付前必须取得作者书面授权并切到 authorized",
  };
}

export interface EngineStatus {
  engineDir: string;
  installed: boolean;
  missing: string[];
  cardCount: number;
  pin: EnginePin | null;
  license: LicenseState;
  runtimeInstalled: boolean;
  /** 冒烟标记（安装器 check-runtime.sh --smoke-only 通过后落盘） */
  runtimeReady: boolean;
  ready: boolean;
  reason: string;
}

export function engineStatus(engineDir = engineDirOf(), env: NodeJS.ProcessEnv = process.env): EngineStatus {
  const missing: string[] = [];
  for (const rel of REQUIRED_ENGINE_FILES) if (!existsSync(join(engineDir, rel))) missing.push(rel);
  for (const rel of REQUIRED_ENGINE_DIRS) if (!existsSync(join(engineDir, rel))) missing.push(`${rel}/`);
  const cardsDir = join(engineDir, "template/cards");
  let cardCount = 0;
  if (existsSync(cardsDir)) {
    for (const name of readdirSync(cardsDir)) if (name.endsWith(".tsx")) cardCount += 1;
  }
  const pin = readEnginePin(engineDir);
  const license = licenseStateOf(engineDir, env);
  const runtimeModules = join(engineDir, "runtime/node_modules");
  const runtimeInstalled = existsSync(runtimeModules) && statSync(runtimeModules).isDirectory();
  const runtimeReady = existsSync(join(engineDir, ".runtime-ready"));
  const installed = missing.length === 0;
  const ready = installed && license.okToRender && runtimeInstalled && runtimeReady;
  const reason = !installed
    ? `引擎未安装完整（缺 ${missing.slice(0, 4).join("、")}${missing.length > 4 ? ` 等 ${missing.length} 项` : ""}）——先跑 pnpm talkcraft:install`
    : !license.okToRender
      ? license.reason
      : !runtimeInstalled
        ? "引擎运行时依赖未安装（runtime/node_modules 缺失）——先跑 pnpm talkcraft:install"
        : !runtimeReady
          ? "引擎运行时未通过冒烟（.runtime-ready 缺失）——先跑 pnpm talkcraft:install"
          : "引擎就绪";
  return { engineDir, installed, missing, cardCount, pin, license, runtimeInstalled, runtimeReady, ready, reason };
}

/** 渲染/交付前的硬闸：未就绪一律抛出可执行原因（不静默降级） */
export function assertEngineReady(engineDir = engineDirOf(), env: NodeJS.ProcessEnv = process.env): EngineStatus {
  const status = engineStatus(engineDir, env);
  if (!status.ready) throw new Error(`talkcraft 引擎不可用：${status.reason}`);
  return status;
}

export function talkcraftEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.TALKCRAFT_ENABLED ?? "0").trim() === "1";
}
