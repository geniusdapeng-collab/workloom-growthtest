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
import type { PortraitIndex } from "./portrait-runtime.js";

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

/**
 * 定妆照绑定桥（2026-09-21 真机修复）
 *
 * 现象：定妆照真出图后（`portrait-index.json` 里 4 角度齐备），vendor 逐镜渲染仍报
 *   `BINDING_MANIFEST_INVALID: 清单中没有任何角色定义`。
 *
 * 根因（vendor 侧链路断点，不是我们的数据问题）：
 *   `engines/portrait-resolver.js` 只把定妆照写进 `prompt.portraitBindings` 与提示词正文
 *   （`【定妆照】住客: portrait-set://...`），**没有人**把它回填成
 *   `rendering-engine._parseCharacterRef()` 认得的 `name: image://characters/<dir>/<file>.png`；
 *   而绑定清单 `_generateBindingManifest()` 只从 `prompt.characterRef` 解析角色。
 *   于是「定妆照集」与「渲染绑定清单」之间缺一根线：出图了也照样 0 个角色。
 *
 * 本桥在渲染入口把索引里**四角度齐备**的角色回填到镜头卡（`characterRef` / `_workloomBoundCharacters`），
 * 并让 vendor 的镜头转换带上 `characters`，从而：
 *   1. 绑定清单由真实定妆照文件生成 → 渲染核心的四角度校验自然通过（**不是绕过校验**）；
 *   2. 提交体按 vendor 既有逻辑挂上参考图，每镜最多绑定 `maxCharactersPerShot` 个角色
 *      （每个角色 4 张角度图，贴合 Seedance「参考图 ≤ 4」上限）。
 *
 * vendor 目录保持只读；摘除函数用于卸载（幂等，可重复注入）。
 */
export interface PortraitBindingBridgeOptions {
  /**
   * 已出图的定妆照索引（`portrait-index.json` 解析结果）；
   * 也接受惰性加载函数——索引在预生产跑完才落盘，渲染阶段才需要读取。
   */
  index?: PortraitIndex;
  resolveIndex?: () => PortraitIndex | null;
  /** 每镜最多绑定几个角色（默认 1：一个角色 = 4 张角度图 = Seedance 上限） */
  maxCharactersPerShot?: number;
  log?: (line: string) => void;
}

interface RenderPromptLike {
  shotId?: string;
  characterRef?: unknown;
  characters?: unknown;
  prompt?: unknown;
  portraitBindings?: unknown;
  _workloomBoundCharacters?: string[];
  portraits?: unknown;
  [key: string]: unknown;
}

export function installVendorPortraitBindingBridge(options: PortraitBindingBridgeOptions): () => void {
  const log = options.log ?? (() => undefined);
  const maxPerShot = options.maxCharactersPerShot ?? 1;

  /** 四角度齐备的角色（缺一即不作为绑定对象：渲染核心会整单拒绝） */
  function eligibleCharacters(): Array<{ key: string; files: Record<string, string> }> {
    const index = options.resolveIndex ? options.resolveIndex() : options.index ?? null;
    if (!index) return [];
    return Object.entries(index.characters ?? {})
      .map(([key, entry]) => ({ key, files: (entry.files ?? {}) as Record<string, string> }))
      .filter(({ files }) =>
        ["front", "threeQuarter", "closeup", "side"].every((angle) => typeof files[angle] === "string")
      );
  }

  function pickFor(prompt: RenderPromptLike): string[] {
    const eligible = eligibleCharacters();
    if (eligible.length === 0) return [];
    const haystack = [
      typeof prompt.prompt === "string" ? prompt.prompt : "",
      ...(Array.isArray(prompt.characters) ? prompt.characters.map((c) => String(c)) : []),
      ...(Array.isArray(prompt.portraitBindings)
        ? (prompt.portraitBindings as Array<{ character?: unknown }>).map((b) => String(b?.character ?? ""))
        : [])
    ].join(" ");
    const matched = eligible.filter((item) => item.key.length > 1 && haystack.includes(item.key));
    const chosen = (matched.length > 0 ? matched : eligible).slice(0, maxPerShot);
    return chosen.map((item) => item.key);
  }

  function bindPrompt(prompt: RenderPromptLike): void {
    const keys = pickFor(prompt);
    if (keys.length === 0) return;
    const index = (options.resolveIndex ? options.resolveIndex() : options.index) as PortraitIndex | null;
    if (!index) return;
    prompt._workloomBoundCharacters = keys;
    const refs = keys
      .map((key) => {
        const entry = index.characters[key];
        const front = entry?.files?.front;
        if (!front) return null;
        const fileName = front.split("/").pop() || `${key}-front.png`;
        return `${key}: image://characters/${key}/portraits/${fileName}`;
      })
      .filter((ref): ref is string => Boolean(ref))
      .join("; ");
    if (!refs) return;
    const existing = typeof prompt.characterRef === "string" ? prompt.characterRef.trim() : "";
    if (!existing || existing === "NONE") prompt.characterRef = refs;
    // 空数组在 JS 里是真值：vendor 的 `prompt.portraits || prompt.characterRef` 会优先取空数组，
    // 于是 refs 永远读不到（真机 2026-09-21 实测）。这里把空数组摘掉，让 characterRef 生效。
    if (Array.isArray(prompt.portraits) && prompt.portraits.length === 0) delete prompt.portraits;
  }

  try {
    const repoRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "../../..");
    const vendorRequire = createRequire(resolvePath(repoRoot, "package.json"));
    const enginePath = resolvePath(
      repoRoot,
      "vendor/supermickey/hyperreality-system/engines/rendering-engine/rendering-engine.js"
    );
    if (!existsSync(enginePath)) return () => undefined;
    const mod = vendorRequire(enginePath) as {
      RenderingEngine?: { prototype: Record<string, unknown> };
    };
    const prototype = mod?.RenderingEngine?.prototype;
    if (!prototype || typeof prototype.render !== "function") return () => undefined;

    const originalRender = prototype.render as (prompts: unknown, opts?: unknown) => Promise<unknown>;
    const originalConvert = typeof prototype._convertToShotFormat === "function"
      ? (prototype._convertToShotFormat as (prompt: RenderPromptLike) => Record<string, unknown>)
      : null;

    prototype.render = function patchedRender(this: unknown, prompts: unknown, opts?: unknown) {
      const list = Array.isArray(prompts) ? (prompts as RenderPromptLike[]) : [];
      let bound = 0;
      for (const prompt of list) {
        try {
          bindPrompt(prompt);
          if (prompt._workloomBoundCharacters?.length) bound += 1;
        } catch (err) {
          log(`[vendor-compat] 定妆照绑定失败（${String(prompt?.shotId ?? "?")}）：${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (bound > 0) {
        log(`[vendor-compat] 定妆照绑定桥：${bound}/${list.length} 个镜头已绑定角色定妆照（每镜 ≤${maxPerShot} 角色）`);
      }
      return originalRender.call(this, prompts, opts);
    };

    if (originalConvert) {
      prototype._convertToShotFormat = function patchedConvert(this: unknown, prompt: RenderPromptLike) {
        const shot = originalConvert.call(this, prompt) as Record<string, unknown>;
        const boundKeys = Array.isArray(prompt?._workloomBoundCharacters) ? prompt._workloomBoundCharacters : [];
        if (boundKeys.length > 0) shot.characters = [...boundKeys];
        return shot;
      };
    }

    return () => {
      prototype.render = originalRender;
      if (originalConvert) prototype._convertToShotFormat = originalConvert;
    };
  } catch (err) {
    log(`[vendor-compat] 定妆照绑定桥注入失败（不影响其它桥）：${err instanceof Error ? err.message : String(err)}`);
    return () => undefined;
  }
}
