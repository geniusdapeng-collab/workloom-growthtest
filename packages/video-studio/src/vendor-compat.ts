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

/**
 * 注入依赖保活桥（2026-09-22 真机根因）
 *
 * 现象：新 run 的日志里，**链路最开头**的创意主题生成器报
 *   `[CreativeThemeGenerator] ⚠️ LLM 字段提取失败: LLM 引擎无可用调用方法`
 * 随后主题退化成规则兜底值（类型=艺术实验 / 主题=记忆的碎片 / 时长=50秒），
 * 整片随之漂移成与 brief 无关的艺术实验叙事。
 *
 * 根因：`HyperrealitySystem` 构造函数第一件事是 `ConfigIsolator.isolate(options)`。
 * 它先试 `structuredClone`（类实例含私有字段/方法会抛错），失败后退化为 `_manualDeepClone`，
 * 而后者把**任何对象**都摊平成普通对象 —— 宿主注入的 LLM 引擎实例因此丢掉
 * `reason/chat/generate` 等方法，只剩一个"真值但空心"的对象。
 * `_resolveLLMEngine()` 又优先返回这个注入值，于是 `CreativeThemeGenerator` 拿到的
 * 是一个没有可调用方法的引擎（其它 BaseAgent 子类自己 new vendor LLMEngine 才侥幸正常）。
 *
 * 处理：把隔离器的"深拷贝"收窄为**只拷贝纯数据**——函数与类实例按引用透传
 * （Map/Set/Date/RegExp 等内建对象保持原样），既保住隔离语义（配置对象仍是副本），
 * 又不破坏注入的协作对象。vendor 目录只读，运行时打补丁。
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function clonePreservingServices<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (value === null || typeof value !== "object") return value;
  if (typeof value === "function") return value;
  if (Array.isArray(value)) {
    if (seen.has(value)) return seen.get(value) as T;
    const out: unknown[] = [];
    seen.set(value, out);
    for (const item of value) out.push(clonePreservingServices(item, seen));
    return out as unknown as T;
  }
  if (!isPlainObject(value)) {
    // 类实例 / Map / Set / Date / RegExp / 流等：按引用透传（保活）
    return value;
  }
  if (seen.has(value)) return seen.get(value) as T;
  const out: Record<string, unknown> = {};
  seen.set(value, out);
  for (const [key, item] of Object.entries(value)) out[key] = clonePreservingServices(item, seen);
  return out as unknown as T;
}

export function installVendorConfigIsolatorBridge(): () => void {
  try {
    const repoRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "../../..");
    const vendorRequire = createRequire(resolvePath(repoRoot, "package.json"));
    const isolatorPath = resolvePath(
      repoRoot,
      "vendor/supermickey/hyperreality-system/utils/config-isolator.js"
    );
    if (!existsSync(isolatorPath)) return () => undefined;
    const mod = vendorRequire(isolatorPath) as {
      ConfigIsolator?: { isolate?: (config: unknown) => unknown };
    };
    const isolator = mod?.ConfigIsolator;
    if (!isolator || typeof isolator.isolate !== "function") return () => undefined;
    const original = isolator.isolate;
    isolator.isolate = function patchedIsolate(config: unknown) {
      if (!config || typeof config !== "object") return original(config);
      const clone = clonePreservingServices(config);
      return clone;
    };
    return () => {
      isolator.isolate = original;
    };
  } catch {
    return () => undefined;
  }
}

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

/**
 * 阶段异常栈诊断桥（2026-09-22）
 *
 * 真机现象：Phase 3（逐镜提示词融合）抛出 `Assignment to constant variable.`，
 * 但 vendor 的 catch 只打 `e.message`（`phase-3-prompt-fusion.js:200`），丢掉栈帧 →
 * 生产环境无法定位文件与行号；结果是 6 个镜头全部退回未融合的规则 Prompt
 * （`prompt` 字段为空、字段退化为 FieldGuard 默认模板）。
 *
 * 本桥在阶段执行体外包一层：异常时把 `err.stack` 完整写进 run 日志（行为不变——仍向上抛，
 * 由 vendor catch 决定降级），让下一次真机运行能直接读到行号。Phase 3.5 字段质检的
 * `tl.match is not a function` / `result.reports is not iterable` 也一并捕获。
 */
export interface PhaseDiagnosticsBridgeOptions {
  /** 需要带栈诊断的阶段模块（相对 vendor/supermickey/hyperreality-system 的路径 → 导出类名） */
  phases?: Array<{ path: string; exportName: string }>;
  log?: (line: string) => void;
}

const DEFAULT_PHASE_TARGETS: Array<{ path: string; exportName: string }> = [
  { path: "engines/production-engine/phases/phase-3-prompt-fusion.js", exportName: "Phase3PromptFusion" },
  { path: "engines/production-engine/phases/phase-3-5-field-quality.js", exportName: "Phase35FieldQuality" }
];

export function installVendorPhaseDiagnosticsBridge(options: PhaseDiagnosticsBridgeOptions = {}): () => void {
  const log = options.log ?? ((line: string) => console.warn(line));
  const phases = options.phases ?? DEFAULT_PHASE_TARGETS;
  const restores: Array<() => void> = [];
  try {
    const repoRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "../../..");
    const vendorRequire = createRequire(resolvePath(repoRoot, "package.json"));
    for (const phase of phases) {
      const file = resolvePath(repoRoot, "vendor/supermickey/hyperreality-system", phase.path);
      if (!existsSync(file)) continue;
      const mod = vendorRequire(file) as Record<string, unknown>;
      const ctor = mod?.[phase.exportName] as { prototype?: Record<string, unknown> } | undefined;
      const prototype = ctor?.prototype;
      if (!prototype || typeof prototype.execute !== "function") continue;
      const original = prototype.execute as (state: unknown) => Promise<unknown>;
      prototype.execute = async function patchedExecute(this: unknown, state: unknown) {
        try {
          return await original.call(this, state);
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          log(`[vendor-compat] ${phase.exportName} 抛出异常：${error.message}`);
          log(`[vendor-compat] ${phase.exportName} 栈：${(error.stack ?? "").split("\n").slice(0, 12).join(" ← ")}`);
          throw err;
        }
      };
      restores.push(() => {
        prototype.execute = original;
      });
    }
    return () => restores.forEach((restore) => restore());
  } catch (err) {
    log(`[vendor-compat] 阶段诊断桥注入失败（不影响其它桥）：${err instanceof Error ? err.message : String(err)}`);
    return () => restores.forEach((restore) => restore());
  }
}
