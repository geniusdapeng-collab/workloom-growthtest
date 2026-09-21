/**
 * vendor 运行时兼容桥（2026-09-21 真机修复）
 *
 * 背景：修好模型与端点后，逐镜渲染仍以 `characterRef.split is not a function` 失败。
 * 根因（vendor/supermickey/.../rendering-engine.js 第 283 行）：
 *   `_parseCharacterRef(prompt.fields?.portraits || prompt.portraits || prompt.characterRef)`
 * 当镜头卡的 `portraits` 是**空数组**时（本机没有定妆照，卡片里就是 `[]`），空数组在 JS 里是真值，
 * 于是被当成"字符串引用"送进 `_parseCharacterRef`，而该方法内部直接调 `.split()` → 类型崩溃，
 * 整条渲染阶段 0 个镜头提交。
 *
 * vendor 目录是只读审计基线（VENDOR.md 纪律），所以这里用**原型桥**在运行时归一入参：
 *   - 数组：有值就拼成 "char: path" 串，空数组归一为 'NONE'
 *   - 对象：无法解析的引用一律归一为 'NONE'
 *   - 其余类型原样传给原实现
 * 幂等；返回摘除函数。
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

export function installVendorRenderCompatBridge(): () => void {
  try {
    const repoRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "../../..");
    const vendorRequire = createRequire(resolvePath(repoRoot, "package.json"));
    const enginePath = resolvePath(repoRoot, "vendor/supermickey/hyperreality-system/engines/rendering-engine/rendering-engine.js");
    if (!existsSync(enginePath)) return () => undefined;
    const mod = vendorRequire(enginePath) as { RenderingEngine?: { prototype: Record<string, unknown> } };
    const prototype = mod?.RenderingEngine?.prototype;
    if (!prototype || typeof prototype._parseCharacterRef !== "function") return () => undefined;
    const original = prototype._parseCharacterRef as (ref: unknown) => unknown;
    prototype._parseCharacterRef = function patched(ref: unknown) {
      let normalized: unknown = ref;
      if (Array.isArray(ref)) normalized = ref.length ? ref.join(", ") : "NONE";
      else if (ref && typeof ref === "object") normalized = "NONE";
      return original.call(this, normalized);
    };
    return () => { prototype._parseCharacterRef = original; };
  } catch {
    // vendor 不在（单测环境）时静默：桥接是增强，不是启动前置
    return () => undefined;
  }
}
