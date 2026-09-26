/**
 * media/paths.ts —— 媒资库路径围栏（T-2026-0926-0014 深审修正）
 *
 * 为什么必须集中一层：深审实测发现四处入口都只做"字符串拼接/前缀判断"，
 * 结果 `productId="../../../etc"`、`dir`（含 "/" 就绕过白名单）、manifest 里的绝对路径、
 * `relPath="upload/ws-a/../../<任意文件>"` 都能把媒体仓外的路径带进业务：
 * 轻则越界读存在性/大小、把仓外文件复制进媒体仓并给出可下载的签名 URL；
 * 重则（将来任何保留原始文件名的上传通道）升级成任意文件读取。
 *
 * 口径：resolve 之后必须仍在 root 内（`root + sep` 前缀）。相对路径里的 `..` 会被
 * 直接判越界，绝对路径除了显式落在 root 内也一律拒绝。
 */
import { resolve, sep } from "node:path";

export function assertInside(root: string, candidate: string, label = "路径"): string {
  const absRoot = resolve(root);
  const abs = resolve(candidate);
  if (abs !== absRoot && !abs.startsWith(absRoot + sep)) {
    throw new Error(`${label}越界（必须在 ${absRoot} 内）：${candidate}`);
  }
  return abs;
}

/**
 * 相对路径 → root 内绝对路径。
 * 契约是**相对**：绝对路径直接判非法（不偷偷 re-root，否则 `/etc/passwd` 会被解析成
 * `<root>/etc/passwd` 而"看起来合法"——深审用例就是这么抓到的）。
 * 需要接受绝对路径但限制在 root 内的场景请直接用 `assertInside`。
 */
export function resolveInside(root: string, relativePath: string, label = "路径"): string {
  const raw = String(relativePath ?? "");
  if (/^[/\\]/.test(raw) || /^[A-Za-z]:/.test(raw)) {
    throw new Error(`${label}非法（不接受绝对路径）：${relativePath}`);
  }
  return assertInside(root, resolve(root, raw), label);
}

/** 单段标识（workspaceId/projectId/productId/目录名）：不允许分隔符、`..` 与隐藏前缀 */
export function safeSegment(value: string, label = "标识"): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed || trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..") || trimmed.startsWith(".")) {
    throw new Error(`${label}非法：${value}`);
  }
  return trimmed;
}
