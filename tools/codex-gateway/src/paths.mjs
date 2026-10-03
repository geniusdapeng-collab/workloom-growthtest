/**
 * 路径解析：所有入口都从真实文件系统定位 WorkLoom 仓库根，避免依赖 cwd。
 * 规则：向上查找同时存在 product.manifest.json 与 bundles/ 的目录。
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function gatewayRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export function gatewayFile(...parts) {
  return join(gatewayRoot(), ...parts);
}

export function resolveRepoRoot(start = process.cwd()) {
  if (process.env.WORKLOOM_REPO_ROOT) {
    const forced = resolve(process.env.WORKLOOM_REPO_ROOT);
    if (existsSync(join(forced, "product.manifest.json")) && existsSync(join(forced, "bundles"))) {
      return forced;
    }
    throw new Error(`WORKLOOM_REPO_ROOT 不是有效 WorkLoom 仓库根：${forced}`);
  }
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, "product.manifest.json")) && existsSync(join(dir, "bundles"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("未找到 WorkLoom 仓库根（需要同时存在 product.manifest.json 与 bundles/）");
    }
    dir = parent;
  }
}

export function repoRelative(repoRoot, absolutePath) {
  const rel = absolutePath.startsWith(repoRoot) ? absolutePath.slice(repoRoot.length + 1) : absolutePath;
  return rel.split("\\").join("/");
}
