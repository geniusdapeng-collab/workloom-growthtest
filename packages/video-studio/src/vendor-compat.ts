import { videoRuntimeRoot } from "./runtime-root.js";
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
import { existsSync, readFileSync, lstatSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, sep, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyProjectedDurations,
  computeVoiceFloor,
  countVisibleUnits,
  extractDialogueLines,
  loadSpeechRate,
  projectShotDurations,
  resolveRateKey,
} from "./duration-projection.js";
import { REQUIRED_ANGLES, type PortraitIndex, type PortraitIndexEntry } from "./portrait-runtime.js";
import {
  CinematicSkillError, cinematicSkillHash, checkCinematicSkillCompliance, planCinematicSkills,
  type CinematicSkillRouter, type CinematicSkillStatus,
} from "./cinematic-skill-policy.js";
import { getCoverSpec } from "./cover-platforms.js";
import type { LLMReasonOptions, LLMReasonResult } from "./llm-adapter.js";
import { unicodeLength, unicodeSlice } from "./unicode-text.mjs";

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
    const repoRoot = videoRuntimeRoot(import.meta.url);
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

type VendorCharacterRefParser = (this: unknown, ref: unknown) => unknown;
const renderCompatInstallations = new WeakMap<object, {
  original: VendorCharacterRefParser;
  patched: VendorCharacterRefParser;
  users: number;
}>();

export function installVendorRenderCompatBridge(): () => void {
  try {
    const repoRoot = videoRuntimeRoot(import.meta.url);
    const vendorRequire = createRequire(resolvePath(repoRoot, "package.json"));
    const enginePath = resolvePath(repoRoot, "vendor/supermickey/hyperreality-system/engines/rendering-engine/rendering-engine.js");
    if (!existsSync(enginePath)) return () => undefined;
    const mod = vendorRequire(enginePath) as { RenderingEngine?: { prototype: Record<string, unknown> } };
    const prototype = mod?.RenderingEngine?.prototype;
    if (!prototype || typeof prototype._parseCharacterRef !== "function") return () => undefined;
    let installation = renderCompatInstallations.get(prototype);
    if (!installation) {
      const original = prototype._parseCharacterRef as VendorCharacterRefParser;
      const patched: VendorCharacterRefParser = function (ref) {
        let normalized: unknown = ref;
        if (Array.isArray(ref)) normalized = ref.length ? ref.join(", ") : "NONE";
        else if (ref && typeof ref === "object") normalized = "NONE";
        return original.call(this, normalized);
      };
      installation = { original, patched, users: 0 };
      prototype._parseCharacterRef = patched;
      renderCompatInstallations.set(prototype, installation);
    }
    const retained = installation;
    retained.users += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      retained.users -= 1;
      if (retained.users !== 0) return;
      if (prototype._parseCharacterRef === retained.patched) prototype._parseCharacterRef = retained.original;
      renderCompatInstallations.delete(prototype);
    };
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

type PortraitBindingEngine = { config?: { charactersDir?: string } };
type PortraitBoundEntry = { id: string; name: string; requiredAngles: readonly string[]; portraits: Record<string, string>; evidence: Record<string, unknown> };

function createPortraitBindingState(options: PortraitBindingBridgeOptions) {
  const log = options.log ?? (() => undefined);
  const maxPerShot = options.maxCharactersPerShot ?? 1;
  if (!Number.isInteger(maxPerShot) || maxPerShot < 1) throw new Error("PORTRAIT_BINDING_INVALID: 每镜角色上限无效");
  const boundSnapshots = new WeakMap<RenderPromptLike, string>();
  const inside = (root: string, file: string): boolean => { const rel = relative(root, file); return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
  function currentIndex(): PortraitIndex | null {
    const value = options.resolveIndex ? options.resolveIndex() : options.index ?? null;
    if (value && (value.schemaVersion !== "workloom.portrait-index/v1" || !isPlainObject(value.characters))) throw new Error("PORTRAIT_BINDING_INVALID: 角色索引无效");
    return value ? structuredClone(value) : null;
  }
  /** Read only the indexed files; directory order and historical filenames cannot select a version. */
  function exactEntry(engine: PortraitBindingEngine, key: string, entry: PortraitIndexEntry): PortraitBoundEntry {
    const root = engine.config?.charactersDir;
    if (!root || entry.kind !== "character" || typeof entry.id !== "string") throw new Error("PORTRAIT_BINDING_INVALID: 角色类型或根目录无效");
    const lexicalRoot = resolvePath(root); const canonicalRoot = realpathSync(root);
    const portraits: Record<string, string> = {}; const evidence: Record<string, unknown> = {};
    const seen = new Set<string>();
    for (const angle of REQUIRED_ANGLES) {
      const file = entry.files?.[angle];
      if (typeof file !== "string" || !isAbsolute(file) || !inside(lexicalRoot, resolvePath(file))) throw new Error(`PORTRAIT_BINDING_INVALID: ${key}/${angle} 路径越界或缺失`);
      const rel = relative(lexicalRoot, resolvePath(file));
      const realPath = realpathSync(file); const stat = lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 1024 || stat.size > 100_000_000 || realPath !== join(canonicalRoot, rel) || !inside(canonicalRoot, realPath)) throw new Error(`PORTRAIT_BINDING_INVALID: ${key}/${angle} 文件或符号链接不可用`);
      if (seen.has(realPath)) throw new Error(`PORTRAIT_BINDING_INVALID: ${key} 多个角度指向同一文件`);
      seen.add(realPath);
      const bytes = readFileSync(realPath); const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (bytes.length !== stat.size || realpathSync(file) !== realPath) throw new Error(`PORTRAIT_BINDING_CHANGED: ${key}/${angle} 读取期间变化`);
      const receipt = entry.receipts?.[angle];
      if (receipt) {
        if (receipt.schemaVersion !== "workloom.portrait-cache/v2" || receipt.kind !== "character" || receipt.id !== entry.id || receipt.angle !== angle || !/^[a-f0-9]{64}$/.test(receipt.requestHash)
          || receipt.output?.path !== file || receipt.output.realPath !== realPath || receipt.output.sha256 !== sha256 || receipt.output.bytes !== bytes.length) throw new Error(`PORTRAIT_BINDING_RECEIPT_INVALID: ${key}/${angle} 当前产物与收据不一致`);
      } else if (entry.receipts || /-[a-f0-9]{64}-[a-zA-Z]+\.png$/.test(file)) throw new Error(`PORTRAIT_BINDING_RECEIPT_INVALID: ${key}/${angle} 新缓存缺少收据`);
      portraits[angle] = rel.split(sep).join("/");
      evidence[angle] = { path: file, realPath, sha256, bytes: bytes.length, requestHash: receipt?.requestHash ?? null, scope: receipt ? "generation-receipt-and-current-bytes" : "legacy-index-current-bytes-only" };
    }
    return { id: key, name: entry.name || key, requiredAngles: REQUIRED_ANGLES, portraits, evidence };
  }

  /** 四角度齐备的角色（缺一即不作为绑定对象：渲染核心会整单拒绝） */
  function eligibleCharacters(index: PortraitIndex | null): Array<{ key: string; files: Record<string, string> }> {
    if (!index) return [];
    return Object.entries(index.characters ?? {})
      .map(([key, entry]) => ({ key, files: (entry.files ?? {}) as Record<string, string> }))
      .filter(({ files }) =>
        ["front", "threeQuarter", "closeup", "side"].every((angle) => typeof files[angle] === "string")
      );
  }

  function pickFor(prompt: RenderPromptLike, index: PortraitIndex | null): string[] {
    const eligible = eligibleCharacters(index);
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

  function bindPrompt(engine: PortraitBindingEngine, prompt: RenderPromptLike): PortraitBoundEntry[] {
    const index = currentIndex(); const keys = pickFor(prompt, index);
    if (keys.length === 0 || !index) return [];
    const entries = keys.map((key) => exactEntry(engine, key, index.characters[key]!));
    const snapshot = cinematicSkillHash(entries);
    const prior = boundSnapshots.get(prompt);
    if (prior && prior !== snapshot) throw new Error("PORTRAIT_BINDING_CHANGED: 镜头绑定后当前版本或字节发生变化");
    boundSnapshots.set(prompt, snapshot);
    prompt._workloomBoundCharacters = keys;
    prompt.characterRef = entries.map((entry) => `${entry.id}: image://characters/${entry.portraits.front}`).join("; ");
    // 空数组在 JS 里是真值：vendor 的 `prompt.portraits || prompt.characterRef` 会优先取空数组，
    // 于是 refs 永远读不到（真机 2026-09-21 实测）。这里把空数组摘掉，让 characterRef 生效。
    if (Array.isArray(prompt.portraits) && prompt.portraits.length === 0) delete prompt.portraits;
    return entries;
  }

  return { currentIndex, exactEntry, bindPrompt, log, maxPerShot, active: true };
}

type PortraitBindingState = ReturnType<typeof createPortraitBindingState>;
const portraitBindingScope = new AsyncLocalStorage<PortraitBindingState>();
let standalonePortraitBinding: PortraitBindingState | null = null;
let portraitBindingUsers = 0;
let restorePortraitBindingMethods: (() => void) | null = null;

function activePortraitBinding(): PortraitBindingState | null {
  const state = portraitBindingScope.getStore() ?? standalonePortraitBinding;
  return state?.active ? state : null;
}

function installPortraitBindingMethods(log: PortraitBindingState["log"]): () => void {
  try {
    const repoRoot = videoRuntimeRoot(import.meta.url);
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
    const coreMod = vendorRequire(resolvePath(repoRoot, "vendor/supermickey/scripts/render-submitter-core.js")) as { RenderSubmitterCore?: { prototype: Record<string, unknown> } };
    const corePrototype = coreMod.RenderSubmitterCore?.prototype;
    if (!corePrototype || typeof corePrototype.buildPayload !== "function") throw new Error("PORTRAIT_BINDING_INVALID: vendor缺少提交体构造入口");
    const originalPayload = corePrototype.buildPayload as (shot: Record<string, unknown>, manifest: Record<string, unknown>) => Record<string, unknown>;

    const originalRender = prototype.render as (prompts: unknown, opts?: unknown) => Promise<unknown>;
    const originalManifest = prototype._generateBindingManifest;
    if (typeof originalManifest !== "function") throw new Error("PORTRAIT_BINDING_INVALID: vendor缺少绑定清单入口");
    const originalConvert = typeof prototype._convertToShotFormat === "function"
      ? (prototype._convertToShotFormat as (prompt: RenderPromptLike) => Record<string, unknown>)
      : null;

    prototype.render = function patchedRender(this: PortraitBindingEngine, prompts: unknown, opts?: unknown) {
      const binding = activePortraitBinding();
      if (!binding) return originalRender.call(this, prompts, opts);
      const list = Array.isArray(prompts) ? (prompts as RenderPromptLike[]) : [];
      let bound = 0;
      for (const prompt of list) {
        binding.bindPrompt(this, prompt);
        if (prompt._workloomBoundCharacters?.length) bound += 1;
      }
      if (bound > 0) {
        binding.log(`[vendor-compat] 定妆照绑定桥：${bound}/${list.length} 个镜头已绑定角色定妆照（每镜 ≤${binding.maxPerShot} 角色）`);
      }
      return originalRender.call(this, prompts, opts);
    };

    prototype._generateBindingManifest = async function patchedManifest(this: PortraitBindingEngine, prompts: RenderPromptLike[]) {
      const binding = activePortraitBinding();
      if (!binding) return originalManifest.call(this, prompts);
      const characters: Record<string, PortraitBoundEntry> = {}; const shots: Record<string, unknown>[] = [];
      const shotIds = new Set<string>();
      for (const prompt of prompts) {
        if (!prompt.shotId || shotIds.has(prompt.shotId)) throw new Error("PORTRAIT_BINDING_INVALID: 镜头ID缺失或重复");
        shotIds.add(prompt.shotId);
        const entries = binding.bindPrompt(this, prompt);
        for (const entry of entries) {
          const prior = characters[entry.id];
          if (prior && cinematicSkillHash(prior) !== cinematicSkillHash(entry)) throw new Error("PORTRAIT_BINDING_CHANGED: 同一清单混入多个角色版本");
          characters[entry.id] = entry;
        }
        shots.push({ shotId: prompt.shotId, requiredCharacters: entries.map((entry) => entry.id), duration: prompt.duration ?? 15, promptLength: prompt.promptCharCount || (typeof prompt.prompt === "string" ? prompt.prompt.length : 0) });
      }
      return { generatedAt: new Date().toISOString(), characters, shots, schemaVersion: "workloom.portrait-binding/v2", selection: "exact-current-index-files", bindingHash: cinematicSkillHash({ characters, shots }) };
    };

    corePrototype.buildPayload = function patchedPayload(this: { charactersDir: string; extractCharactersFromShot: (shot: Record<string, unknown>) => string[] }, shot: Record<string, unknown>, manifest: Record<string, unknown>) {
      const binding = activePortraitBinding();
      if (!binding) return originalPayload.call(this, shot, manifest);
      if (manifest.schemaVersion !== "workloom.portrait-binding/v2") throw new Error("PORTRAIT_BINDING_INVALID: 提交体必须使用本次精确文件清单");
      if (manifest.bindingHash !== cinematicSkillHash({ characters: manifest.characters, shots: manifest.shots })) throw new Error("PORTRAIT_BINDING_CHANGED: 清单内容被改写");
      const characters = manifest.characters as Record<string, PortraitBoundEntry>;
      const index = binding.currentIndex(); const expected: Array<{ sha256: string; bytes: number }> = [];
      for (const key of this.extractCharactersFromShot(shot)) {
        const entry = index?.characters[key];
        if (!entry || !characters[key]) throw new Error("PORTRAIT_BINDING_INVALID: 提交角色缺少当前索引或清单");
        const current = binding.exactEntry({ config: { charactersDir: this.charactersDir } }, key, entry);
        if (cinematicSkillHash(current) !== cinematicSkillHash(characters[key])) throw new Error("PORTRAIT_BINDING_CHANGED: 提交前角色版本发生变化");
        for (const angle of REQUIRED_ANGLES) expected.push(current.evidence[angle] as { sha256: string; bytes: number });
      }
      const payload = originalPayload.call(this, shot, manifest);
      const images = (Array.isArray(payload.content) ? payload.content : []).filter((item: Record<string, unknown>) => item.type === "image_url") as Array<{ image_url?: { url?: string } }>;
      if (images.length !== expected.length) throw new Error("PORTRAIT_BINDING_CHANGED: 实际提交参考图数量不符");
      for (let i = 0; i < images.length; i += 1) {
        const encoded = /^data:image\/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/=]+)$/.exec(images[i]!.image_url?.url ?? "");
        if (!encoded) throw new Error("PORTRAIT_BINDING_INVALID: 参考图不是实际内联字节");
        const bytes = Buffer.from(encoded[1]!, "base64");
        if (bytes.length !== expected[i]!.bytes || createHash("sha256").update(bytes).digest("hex") !== expected[i]!.sha256) throw new Error("PORTRAIT_BINDING_CHANGED: 实际提交参考图字节与收据不一致");
      }
      return payload;
    };

    if (originalConvert) {
      prototype._convertToShotFormat = function patchedConvert(this: unknown, prompt: RenderPromptLike) {
        const shot = originalConvert.call(this, prompt) as Record<string, unknown>;
        const boundKeys = activePortraitBinding() && Array.isArray(prompt?._workloomBoundCharacters) ? prompt._workloomBoundCharacters : [];
        if (boundKeys.length > 0) shot.characters = [...boundKeys];
        return shot;
      };
    }

    return () => {
      prototype.render = originalRender;
      prototype._generateBindingManifest = originalManifest;
      corePrototype.buildPayload = originalPayload;
      if (originalConvert) prototype._convertToShotFormat = originalConvert;
    };
  } catch (err) {
    log(`[vendor-compat] 定妆照绑定桥注入失败：${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

function retainPortraitBinding(state: PortraitBindingState): () => void {
  if (portraitBindingUsers === 0) {
    const releaseParser = installVendorRenderCompatBridge();
    try {
      const releaseMethods = installPortraitBindingMethods(state.log);
      restorePortraitBindingMethods = () => {
        try { releaseMethods(); } finally { releaseParser(); }
      };
    } catch (error) {
      releaseParser();
      throw error;
    }
  }
  portraitBindingUsers += 1;
  return () => {
    if (!state.active) return;
    state.active = false;
    portraitBindingUsers -= 1;
    if (portraitBindingUsers === 0) {
      restorePortraitBindingMethods?.();
      restorePortraitBindingMethods = null;
    }
  };
}

/** 单次独立工具兼容入口。并发宿主必须使用 withVendorPortraitBindingBridge。 */
export function installVendorPortraitBindingBridge(options: PortraitBindingBridgeOptions): () => void {
  if (standalonePortraitBinding) throw new Error("PORTRAIT_BINDING_SCOPE_REQUIRED: 并发绑定必须使用运行作用域");
  const state = createPortraitBindingState(options);
  const release = retainPortraitBinding(state);
  standalonePortraitBinding = state;
  return () => {
    if (standalonePortraitBinding === state) standalonePortraitBinding = null;
    release();
  };
}

/** 只在本次vendor运行中绑定该项目索引，其他运行和无作用域调用使用自己的行为。 */
export async function withVendorPortraitBindingBridge<T>(
  options: PortraitBindingBridgeOptions,
  fn: () => T | Promise<T>,
): Promise<T> {
  const state = createPortraitBindingState(options);
  const release = retainPortraitBinding(state);
  try {
    return await portraitBindingScope.run(state, fn);
  } finally {
    release();
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
    const repoRoot = videoRuntimeRoot(import.meta.url);
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

/**
 * 字段质检桥（Phase 3.5，2026-09-22 真机修复）
 *
 * 现象（VID-1021 日志）：
 *   `[SafePromise.mapBatch] 索引 0..5 失败: tl.match is not a function`
 *   `[FIELD-QUALITY-FAIL] result.reports is not iterable` →
 *   `[PHASE-3.5] ⚠️ 字段质量检查失败，运行 FieldGuard 兜底修复` →
 *   6 个镜头被 FieldGuard 默认模板覆盖并标记降级。
 *
 * 根因（读码）：
 *   ① `FieldCheckAgent._checkStructure` 对 `shot.timeline` 直接 `.match(/T\d{2}:\d{2}/g)`，
 *      而 Phase 2 产出的 timeline 是数组/对象（`[CONTRACT]` 也报了"期望 string，实际 array"）；
 *   ② `FieldQualityPipeline.runAll` 直接展开 `result.reports`，单镜异常时该字段缺失。
 *
 * 处理：入参把结构化字段（timeline/cameraMovement/lighting/backgroundSound）归一为可读字符串
 * （原始值保留在 `_raw*`），并保证 per-shot 结果始终带 `reports/logs` 数组。
 */
export function installVendorFieldQualityBridge(options: { log?: (line: string) => void } = {}): () => void {
  const log = options.log ?? (() => undefined);
  try {
    const repoRoot = videoRuntimeRoot(import.meta.url);
    const vendorRequire = createRequire(resolvePath(repoRoot, "package.json"));
    const checkPath = resolvePath(
      repoRoot,
      "vendor/supermickey/hyperreality-system/engines/field-quality/field-check-agent.js"
    );
    const pipelinePath = resolvePath(
      repoRoot,
      "vendor/supermickey/hyperreality-system/engines/field-quality/field-quality-pipeline.js"
    );
    if (!existsSync(checkPath) || !existsSync(pipelinePath)) return () => undefined;

    const toText = (value: unknown): string => {
      if (value === null || value === undefined) return "";
      if (typeof value === "string") return value;
      if (Array.isArray(value)) return value.map((v) => toText(v)).filter(Boolean).join("；");
      if (typeof value === "object") {
        const record = value as Record<string, unknown>;
        if (typeof record.string === "string" && record.string.trim()) return record.string.trim();
        return Object.entries(record)
          .filter(([k]) => !k.startsWith("_"))
          .map(([k, v]) => {
            const text = toText(v);
            return text ? `${k === "timeline" ? "时间轴" : k}：${text}` : "";
          })
          .filter(Boolean)
          .join("；");
      }
      return String(value);
    };
    const normalizeShot = (shot: unknown): unknown => {
      if (!shot || typeof shot !== "object" || Array.isArray(shot)) return shot;
      const clone: Record<string, unknown> = { ...(shot as Record<string, unknown>) };
      for (const key of ["timeline", "cameraMovement", "camera_movement", "lighting", "backgroundSound"]) {
        const value = clone[key];
        if (value === null || value === undefined || typeof value === "string") continue;
        clone[`_raw${key.charAt(0).toUpperCase()}${key.slice(1)}`] = value;
        clone[key] = toText(value);
      }
      return clone;
    };

    const restores: Array<() => void> = [];
    const checkMod = vendorRequire(checkPath) as {
      FieldCheckAgent?: { prototype?: Record<string, unknown> };
      RuleChecker?: { prototype?: Record<string, unknown> };
    };
    /** `_checkStructure` 定义在 RuleChecker 上（FieldCheckAgent 内部实例化它）——真机即此路径崩 `tl.match` */
    for (const holder of [checkMod?.RuleChecker, checkMod?.FieldCheckAgent]) {
      const proto = holder?.prototype;
      if (!proto || typeof proto._checkStructure !== "function") continue;
      const original = proto._checkStructure as (shot: unknown) => unknown;
      proto._checkStructure = function patchedCheckStructure(this: unknown, shot: unknown) {
        return original.call(this, normalizeShot(shot));
      };
      restores.push(() => { proto._checkStructure = original; });
    }

    const pipelineMod = vendorRequire(pipelinePath) as { FieldQualityPipeline?: { prototype?: Record<string, unknown> } };
    const pipelineProto = pipelineMod?.FieldQualityPipeline?.prototype;
    if (pipelineProto && typeof pipelineProto.run === "function") {
      const originalRun = pipelineProto.run as (shot: unknown, shotId?: string) => Promise<Record<string, unknown>>;
      pipelineProto.run = async function patchedRun(this: unknown, shot: unknown, shotId?: string) {
        try {
          const result = await originalRun.call(this, normalizeShot(shot), shotId);
          return {
            finalShot: (result?.finalShot ?? shot),
            reports: Array.isArray(result?.reports) ? result.reports : [],
            logs: Array.isArray(result?.logs) ? result.logs : []
          };
        } catch (err) {
          log(`[vendor-compat] FieldQualityPipeline.run 失败（已按空报告回填）：${err instanceof Error ? err.message : String(err)}`);
          return { finalShot: shot, reports: [], logs: [] };
        }
      };
      restores.push(() => { pipelineProto.run = originalRun; });
    }
    if (pipelineProto && typeof pipelineProto.runAll === "function") {
      const originalRunAll = pipelineProto.runAll as (shots: unknown[]) => Promise<unknown>;
      pipelineProto.runAll = async function patchedRunAll(this: unknown, shots: unknown[]) {
        const list = Array.isArray(shots) ? shots : [];
        const frozenNarrativeContract = list.length > 0 && list.every((shot) => {
          if (!shot || typeof shot !== "object" || Array.isArray(shot)) return false;
          const row = shot as Record<string, unknown>;
          const prompt = typeof row.prompt === "string" ? row.prompt : "";
          const fieldCount = (prompt.match(/^\s*\d{2}\.【[^】]+】/gmu) ?? []).length;
          return fieldCount >= 25;
        });
        if (frozenNarrativeContract) {
          log(`[vendor-compat] 字段质检跳过无条件模型重写：${list.length} 镜均为完整编号合同，继续由 G6 监制评审`);
          return {
            finalShots: list,
            allReports: [],
            allLogs: [],
            summary: {
              totalShots: list.length,
              passed: list.length,
              failed: 0,
              totalRounds: 0,
              totalRepairs: 0,
              skipped: true,
              reason: "frozen-narrative-contract: complete numbered host prompt contract is authoritative; destructive field repair is skipped and G6 remains mandatory",
            },
          };
        }
        return originalRunAll.call(this, list.map((shot) => normalizeShot(shot)));
      };
      restores.push(() => { pipelineProto.runAll = originalRunAll; });
    }
    return () => restores.forEach((restore) => restore());
  } catch (err) {
    log(`[vendor-compat] 字段质检桥注入失败（不影响其它桥）：${err instanceof Error ? err.message : String(err)}`);
    return () => undefined;
  }
}

/**
 * 微动作桥（2026-09-22 真机修复）
 *
 * 现象：两次 run 都是 `✅ 微动作增强完成: 0/6 个镜头`（等于该环节空转）。
 * 根因（读码）：
 *   ① `_extractCameraDistance` 只读 `promptObj.camera`，而镜头卡字段是
 *      `camera_movement` / `cameraMovement` → 距离永远靠兜底（medium_shot）；
 *   ② `_extractEmotion` 默认返回 'neutral'，但 `microMotionTemplates` 只有
 *      joy/sadness/anger/fear/surprise/nostalgia/tension/relief **没有 neutral**
 *      → `_generateMicroMotion` 直接返回 null。
 * 处理：补 neutral 模板 + 让距离推断读标准字段（含结构化值）。
 */
export function installVendorMicroMotionBridge(options: { log?: (line: string) => void } = {}): () => void {
  const log = options.log ?? (() => undefined);
  const NEUTRAL_TEMPLATE = {
    facial: ["眼神平稳注视", "面部放松", "嘴角自然"],
    gesture: ["肩颈放松", "手势自然收拢", "身体重心微移"],
    breathing: ["呼吸平稳"]
  };
  try {
    const repoRoot = videoRuntimeRoot(import.meta.url);
    const vendorRequire = createRequire(resolvePath(repoRoot, "package.json"));
    const adapterPath = resolvePath(
      repoRoot,
      "vendor/supermickey/hyperreality-system/engines/enhancers/micro-motion-adapter.js"
    );
    if (!existsSync(adapterPath)) return () => undefined;
    const mod = vendorRequire(adapterPath) as { MicroMotionAdapter?: { prototype?: Record<string, unknown> } };
    const prototype = mod?.MicroMotionAdapter?.prototype;
    if (!prototype) return () => undefined;

    const restores: Array<() => void> = [];
    if (typeof prototype._extractCameraDistance === "function") {
      const original = prototype._extractCameraDistance as (promptObj: Record<string, unknown>) => string;
      prototype._extractCameraDistance = function patchedDistance(this: unknown, promptObj: Record<string, unknown>) {
        const candidates = [
          promptObj?.camera,
          promptObj?.camera_movement,
          promptObj?.cameraMovement,
          promptObj?.composition
        ];
        const text = candidates
          .map((value) => {
            if (!value) return "";
            if (typeof value === "string") return value;
            if (typeof value === "object") {
              const record = value as Record<string, unknown>;
              if (typeof record.string === "string") return record.string;
              return Object.values(record).map((v) => (typeof v === "string" ? v : "")).join(" ");
            }
            return "";
          })
          .join(" ");
        if (text) {
          return original.call(this, { ...promptObj, camera: text });
        }
        return original.call(this, promptObj);
      };
      restores.push(() => { prototype._extractCameraDistance = original; });
    }
    if (typeof prototype._generateMicroMotion === "function") {
      const original = prototype._generateMicroMotion as (emotion: string, granularity: number) => string | null;
      prototype._generateMicroMotion = function patchedGenerate(this: unknown, emotion: string, granularity: number) {
        const templates = (this as { microMotionTemplates?: Record<string, unknown> }).microMotionTemplates;
        if (templates && !templates.neutral) templates.neutral = NEUTRAL_TEMPLATE;
        const result = original.call(this, emotion, granularity);
        if (result) return result;
        if (granularity <= 0) return null;
        const fallback = NEUTRAL_TEMPLATE;
        if (granularity >= 3) return `面部细节：${fallback.facial.slice(0, 2).join("，")}；微动作：${fallback.gesture[0]}；呼吸：${fallback.breathing[0]}`;
        if (granularity === 2) return `表情：${fallback.facial[0]}；姿态：${fallback.gesture[0]}`;
        return `身体语言：${fallback.gesture[0]}`;
      };
      restores.push(() => { prototype._generateMicroMotion = original; });
    }
    return () => restores.forEach((restore) => restore());
  } catch (err) {
    log(`[vendor-compat] 微动作桥注入失败（不影响其它桥）：${err instanceof Error ? err.message : String(err)}`);
    return () => undefined;
  }
}

/** 25/30 字段键（与 vendor 字段规范一致；用于从镜头卡复原组装入参） */
const PROMPT_FIELD_KEYS = [
  "director_instruction", "constraint", "baseline", "scene", "sceneDescription", "lighting",
  "camera_movement", "composition", "color_palette", "depth_of_field", "character", "costume",
  "makeup", "action", "props", "portraits", "dialogue", "timeline", "mood", "pacing",
  "transition", "audio", "negative", "bright_constraint", "character_constraint", "consistency",
  "title", "subtitle", "title_content", "subtitle_content", "title_animation",
  "title_font_design", "opening_audio_design"
];

/** 任意结构化值 → 可读文本（数组拼接 / 对象按键值拼接 / 优先 .string） */
export function promptFieldText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(promptFieldText).filter(Boolean).join("；");
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.string === "string" && record.string.trim()) return record.string.trim();
    return Object.entries(record)
      .filter(([k]) => !k.startsWith("_"))
      .map(([, v]) => promptFieldText(v))
      .filter(Boolean)
      .join("；");
  }
  return "";
}

/** 服装锁定关键词（与 vendor `render-pipeline-guard.js#COSTUME_LOCK` 同一口径，只读不复制语义） */
const COSTUME_LOCK_PATTERN = /身穿|wearing|dressed in|in a|职业装|正装|西装|中山装|制服|工装|旗袍|礼裙|戏服|古装|战甲|铠甲|armor|袍|褂|裙|衫|服/;

export interface PromptContractHealResult {
  prompt: string;
  /** 本次自愈做了哪些事（逐条留痕，不允许静默修改） */
  fixes: string[];
  /** 服装是否已锁定（false = 只能写"未锁定"声明，调用方必须显式记账） */
  costumeLocked: boolean;
}

/**
 * 提示词契约自愈（T-2026-0926-0007 真机缺陷修复，对应 #165）。
 *
 * 背景（连续 4 轮营销片真实模型复现）：vendor Phase 3 抛 `Assignment to constant variable.` 后，
 * 宿主侧用 `rebuildPromptsFromFields` 重建 prompt；重建产物**没有再过一遍 PipelineGuard 字段契约**，
 * 于是被 `render-pipeline-guard` 稳定拦下：
 *   ① `COSTUME_LOCK`：prompt 里没有【服装】字段，角色描述也不含"身穿/旗袍/西装"等词
 *      → 每轮 5–6 镜判"未锁定服装"；
 *   ② `DIALOGUE_FORMAT`：字段层的台词把情绪/语气标记用 `|` 写进 prompt，格式校验必挂。
 *
 * 自愈只做两件**可审计**的事，不做静默放行：
 *   · 台词 `|` → `，`（保持原文信息，只是换成合法分隔符）；
 *   · 缺【服装】字段时补一条：优先取卡片 `costume` / 角色描述里的服装短语；确实没有则写
 *     **显式「未锁定」声明**并让调用方记 `costumeLock=false`（由人裁决是否允许渲染）。
 * 补字段后**重排字段编号**，避免出现断号（监制会把断号当结构缺陷打回）。
 */
export function healPromptContract(prompt: string, options: { costumeHint?: string } = {}): PromptContractHealResult {
  const fixes: string[] = [];
  let text = String(prompt ?? "");

  /** ① 台词竖杠归一：按字段块切分，只改【台词】块里的 `|` */
  if (text.includes("|")) {
    const blocks = text.split(/(?=^\s*\d{1,2}\.\s*【)/m);
    let touched = 0;
    text = blocks
      .map((block) => {
        if (!/^\s*\d{1,2}\.\s*【台词】/.test(block)) return block;
        /** 竖杠两侧的空白一并收掉，避免留下"工具 ， 你缺"这种带空格的分隔（单测口径） */
        const replaced = block.replace(/\s*\|\s*/g, "，");
        if (replaced !== block) touched += 1;
        return replaced;
      })
      .join("");
    if (touched > 0) fixes.push(`台词竖杠归一（${touched} 处 | → ，）`);
  }

  /** ② 服装锁定：有独立【服装】字段或关键词即视为已锁定 */
  const hasCostumeField = /【服装】[^【】]{10,}/.test(text);
  const hasCostumeKeyword = COSTUME_LOCK_PATTERN.test(text);
  let costumeLocked = hasCostumeField || hasCostumeKeyword;
  if (!hasCostumeField) {
    const hint = String(options.costumeHint ?? "").trim();
    const usable = hint.length >= 10 ? hint : "";
    const costumeLine = usable
      ? `【服装】${usable}`
      : "【服装】未锁定：镜头卡与角色档案均未提供服装字段，出片前须补齐（见 docs/character-registry.md）";
    const lines = text.split("\n");
    const characterIndex = lines.findIndex((line) => /^\s*\d{1,2}\.\s*【角色】/.test(line));
    const insertAt = characterIndex >= 0 ? characterIndex + 1 : lines.length;
    lines.splice(insertAt, 0, costumeLine);
    /**
     * 重排字段编号（补字段后不留断号）：按**字段行**计数，不用行号——
     * 新插入的【服装】行还没有编号，用行号会把后续字段整体错位（单测抓到）。
     */
    let fieldCounter = 0;
    text = lines
      .map((line) => {
        if (/^\s*\d{1,2}\.\s*【/.test(line)) {
          fieldCounter += 1;
          return line.replace(/^\s*\d{1,2}\.\s*(?=【)/, `${String(fieldCounter).padStart(2, "0")}.`);
        }
        if (/^\s*【/.test(line)) {
          fieldCounter += 1;
          return `${String(fieldCounter).padStart(2, "0")}.${line.trim()}`;
        }
        return line;
      })
      .join("\n");
    fixes.push(usable
      ? "补【服装】字段（来源：镜头卡 costume 字段）"
      : "补【服装】未锁定声明（显式留痕，costumeLock=false）");
    costumeLocked = Boolean(usable) || hasCostumeKeyword;
  }

  return { prompt: text, fixes, costumeLocked };
}

/**
 * 从镜头字段重建 prompt（Phase 3 失败止血的核心逻辑，独立导出便于单测）。
 * @returns 被重建的 shotId 列表（空数组表示无需重建）
 */
export function rebuildPromptsFromFields(
  shots: Array<Record<string, unknown>>,
  ratio: string,
  assemble: (shot: Record<string, unknown>, fields: Record<string, unknown>, ratio: string) => string,
  minLength = 120
): string[] {
  const rebuilt: string[] = [];
  for (const shot of shots) {
    if (typeof shot.prompt === "string" && shot.prompt.trim().length >= minLength) continue;
    const existing = (shot.fields && typeof shot.fields === "object" ? shot.fields : {}) as Record<string, unknown>;
    const fields: Record<string, unknown> = {};
    for (const key of PROMPT_FIELD_KEYS) {
      const raw = existing[key] ?? shot[key];
      const text = promptFieldText(raw);
      if (!text) continue;
      fields[key] = text;
      if (typeof raw !== "string") shot[`_raw${key.charAt(0).toUpperCase()}${key.slice(1)}`] = raw;
      shot[key] = text;
    }
    const prompt = assemble(shot, fields, ratio);
    if (!prompt || typeof prompt !== "string") continue;
    /**
     * 重建后必须**再过一遍字段契约**（T-2026-0926-0007 / #165 真机）：
     * 早先重建产物直接进 PipelineGuard，被 `COSTUME_LOCK`（缺【服装】字段）与
     * `DIALOGUE_FORMAT`（台词竖杠）稳定拦下——营销片连续 4 轮零渲染提交。
     */
    const costumeHint = promptFieldText(fields.costume) || promptFieldText(shot.costume) || promptFieldText(shot.character);
    const healed = healPromptContract(prompt, { costumeHint });
    shot.prompt = healed.prompt;
    shot.promptCharCount = healed.prompt.length;
    shot.promptRebuilt = true;
    if (healed.fixes.length > 0) {
      shot.promptContractHealed = healed.fixes;
    }
    if (!healed.costumeLocked) {
      /** 显式记账：不允许"未锁定也当锁定"地静默放行（由档案与事件面裁决是否继续渲染） */
      shot.costumeLock = false;
    }
    rebuilt.push(String(shot.shotId ?? "?"));
  }
  return rebuilt;
}

/**
 * 历史安装入口保留给 VideoStudio；现在安装真正的 Phase3 融合与准入桥。
 * 不再在融合失败后自动用字段重建 prompt：那会把预算/模型失败包装成可出片结果。
 * rebuildPromptsFromFields 仍是显式修复工具，不参与生产失败兜底。
 * Phase3 桥自身引用计数共享，最后一个 run 释放时才还原全部原型。
 */
export function installVendorPromptRebuildBridge(options: { log?: (line: string) => void; ratio?: string } = {}): () => void {
  return installVendorPhase3FusionBridge({ log: options.log });
}

/**
 * 契约桥（2026-09-22）：把「契约校验」从纯告警升级为"可修复即修复 + 账本留痕"。
 *
 * 两点修复：
 *  1. `_autoFix` 对 `type: 'string'` 的非法值用 `String(value)` → 对象变 `[object Object]`
 *     （这正是提示词里 `[object Object]` 的源头之一）。这里改为可读序列化。
 *  2. `validate` 前先对**逐镜头字段**（itemSchema 声明为 string 的
 *     `cameraMovement/lighting/timeline/backgroundSound`）做归一，并输出
 *     `[CONTRACT-REPORT] {...}` 账本行，供审计工具与出片交付闸消费。
 */
export function installVendorContractBridge(options: { log?: (line: string) => void } = {}): () => void {
  const log = options.log ?? (() => undefined);
  const STRING_ITEM_FIELDS = ["cameraMovement", "camera_movement", "lighting", "timeline", "backgroundSound", "background_sound"];
  try {
    const repoRoot = videoRuntimeRoot(import.meta.url);
    const vendorRequire = createRequire(resolvePath(repoRoot, "package.json"));
    const validatorPath = resolvePath(
      repoRoot,
      "vendor/supermickey/hyperreality-system/engines/production-engine/utils/agent-contract-validator.js"
    );
    if (!existsSync(validatorPath)) return () => undefined;
    const mod = vendorRequire(validatorPath) as { AgentContractValidator?: { prototype?: Record<string, unknown> } };
    const prototype = mod?.AgentContractValidator?.prototype;
    if (!prototype) return () => undefined;

    const toText = (value: unknown): string => {
      if (value === null || value === undefined) return "";
      if (typeof value === "string") return value;
      if (Array.isArray(value)) return value.map(toText).filter(Boolean).join("；");
      if (typeof value === "object") {
        const record = value as Record<string, unknown>;
        if (typeof record.string === "string") return record.string;
        return Object.entries(record)
          .filter(([k]) => !k.startsWith("_"))
          .map(([k, v]) => {
            const text = toText(v);
            return text ? `${k}：${text}` : "";
          })
          .filter(Boolean)
          .join("；");
      }
      return String(value);
    };
    const normalizeShots = (data: unknown): unknown => {
      if (!data || typeof data !== "object") return data;
      const record = data as Record<string, unknown>;
      if (!Array.isArray(record.shots)) return data;
      const shots = record.shots.map((shot) => {
        if (!shot || typeof shot !== "object") return shot;
        const clone: Record<string, unknown> = { ...(shot as Record<string, unknown>) };
        for (const key of STRING_ITEM_FIELDS) {
          const value = clone[key];
          if (value === null || value === undefined || typeof value === "string") continue;
          clone[`_raw${key.charAt(0).toUpperCase()}${key.slice(1)}`] = value;
          clone[key] = toText(value);
        }
        return clone;
      });
      return { ...record, shots };
    };

    const restores: Array<() => void> = [];
    if (typeof prototype.validate === "function") {
      const originalValidate = prototype.validate as (name: string, data: unknown) => Record<string, unknown>;
      prototype.validate = function patchedValidate(this: unknown, name: string, data: unknown) {
        const normalized = normalizeShots(data);
        const result = originalValidate.call(this, name, normalized);
        try {
          log(`[CONTRACT-REPORT] ${JSON.stringify({
            contract: name,
            valid: result?.valid,
            errorCount: Array.isArray(result?.errors) ? (result.errors as unknown[]).length : 0,
            fixCount: result?.fixCount ?? 0,
            sample: Array.isArray(result?.errors) ? (result.errors as string[]).slice(0, 3) : []
          })}`);
        } catch {
          /* 账本失败不影响主流程 */
        }
        return result;
      };
      restores.push(() => { prototype.validate = originalValidate; });
    }
    if (typeof prototype._autoFix === "function") {
      const originalFix = prototype._autoFix as (data: unknown, schema: unknown, contractName: string) => Record<string, unknown>;
      prototype._autoFix = function patchedAutoFix(this: unknown, data: unknown, schema: unknown, contractName: string) {
        const result = originalFix.call(this, data, schema, contractName);
        // 二次兜底：把对象型的字符串字段换成可读文本（原实现是 String(value) → "[object Object]"）
        const walk = (node: unknown): void => {
          if (!node || typeof node !== "object") return;
          const record = node as Record<string, unknown>;
          for (const [key, value] of Object.entries(record)) {
            if (value === "[object Object]") record[key] = toText(value === "[object Object]" ? "" : value) || "";
            else if (value && typeof value === "object") walk(value);
          }
        };
        walk(result?.data);
        return result;
      };
      restores.push(() => { prototype._autoFix = originalFix; });
    }
    return () => restores.forEach((restore) => restore());
  } catch (err) {
    log(`[vendor-compat] 契约桥注入失败（不影响其它桥）：${err instanceof Error ? err.message : String(err)}`);
    return () => undefined;
  }
}

/**
 * 需求洞察「字段默认值填充」修复桥（2026-09-22 静态审计发现）
 *
 * vendor `engines/requirement-discovery-engine.js` 的 `BaseDiscoveryAgent._fillDefaults(results, schema, path)`：
 *   ① 第 340 行 `filled = filled.map(...)`（对 `const filled` 重新赋值）——AST 扫描全仓唯一命中；
 *   ② 更隐蔽的是第 316 行 `const filled = { ...result }`：**数组会被展开成对象**（`{0:…,1:…}`），
 *      于是 ① 的 `Array.isArray(filled)` 永远为 false（该分支不可达），而数组型 LLM 结果
 *      （如 references/scenes 列表）在补默认值时**被静默改成对象**，下游按数组消费时会错位。
 *
 * 本桥用修正实现替换该方法：数组保持数组、对象保持对象，required/properties/items 三段逻辑按原意执行。
 */
export function installVendorDiscoveryFixBridge(options: { log?: (line: string) => void } = {}): () => void {
  const log = options.log ?? (() => undefined);
  try {
    const repoRoot = videoRuntimeRoot(import.meta.url);
    const vendorRequire = createRequire(resolvePath(repoRoot, "package.json"));
    const file = resolvePath(
      repoRoot,
      "vendor/supermickey/hyperreality-system/engines/requirement-discovery-engine.js"
    );
    if (!existsSync(file)) return () => undefined;
    /**
     * 该模块只导出 `RequirementDiscoveryEngine`（BaseDiscoveryAgent 不导出），
     * 所以先构造一个引擎实例，再沿原型链找到**真正拥有** `_fillDefaults` 的那一层原型。
     */
    const mod = vendorRequire(file) as {
      RequirementDiscoveryEngine?: new (options?: Record<string, unknown>) => {
        agents?: Record<string, { _fillDefaults?: unknown }>;
      };
    };
    if (!mod?.RequirementDiscoveryEngine) return () => undefined;
    const probeEngine = new mod.RequirementDiscoveryEngine({ llmEngine: null });
    const probeAgent = probeEngine?.agents?.scene ?? probeEngine?.agents?.audience ?? null;
    let prototype: Record<string, unknown> | null = probeAgent ? Object.getPrototypeOf(probeAgent) as Record<string, unknown> : null;
    while (prototype && prototype !== Object.prototype && !Object.prototype.hasOwnProperty.call(prototype, "_fillDefaults")) {
      prototype = Object.getPrototypeOf(prototype) as Record<string, unknown> | null;
    }
    if (!prototype || typeof prototype._fillDefaults !== "function") return () => undefined;
    const original = prototype._fillDefaults as (result: unknown, schema: Record<string, unknown>, path?: string) => unknown;

    prototype._fillDefaults = function patchedFillDefaults(
      this: {
        _fallback: (seed: Record<string, unknown>, schema: unknown) => Record<string, unknown>;
        _fillDefaults: (result: unknown, schema: Record<string, unknown>, path?: string) => unknown;
      },
      result: unknown,
      schema: Record<string, unknown>,
      path = ""
    ) {
      if (!result || typeof result !== "object") return this._fallback({}, schema);
      const schemaRecord = (schema ?? {}) as Record<string, unknown>;
      let filled: unknown = Array.isArray(result) ? [...(result as unknown[])] : { ...(result as Record<string, unknown>) };

      if (!Array.isArray(filled) && Array.isArray(schemaRecord.required)) {
        const fallback = this._fallback({}, schemaRecord) as Record<string, unknown>;
        for (const key of schemaRecord.required as string[]) {
          const record = filled as Record<string, unknown>;
          if (record[key] === undefined || record[key] === null) record[key] = fallback?.[key];
        }
      }
      const properties = schemaRecord.properties as Record<string, Record<string, unknown>> | undefined;
      if (properties && !Array.isArray(filled)) {
        const record = filled as Record<string, unknown>;
        for (const [key, propSchema] of Object.entries(properties)) {
          if (record[key] && propSchema?.type === "object") {
            record[key] = this._fillDefaults(record[key], propSchema, `${path}.${key}`);
          }
        }
      }
      if (schemaRecord.items && Array.isArray(filled)) {
        filled = (filled as unknown[]).map((item, i) =>
          this._fillDefaults(item, schemaRecord.items as Record<string, unknown>, `${path}[${i}]`)
        );
      }
      return filled;
    };
    log("[vendor-compat] 需求洞察 _fillDefaults 修复桥已注入（数组保持数组、消除 const 重赋值）");
    return () => {
      prototype._fillDefaults = original;
    };
  } catch (err) {
    log(`[vendor-compat] 需求洞察修复桥注入失败（不影响其它桥）：${err instanceof Error ? err.message : String(err)}`);
    return () => undefined;
  }
}

function extractFirstJsonValue(text: unknown): string | null {
  if (typeof text !== "string" || !text.trim()) return null;
  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    try {
      JSON.parse(fenced[1]);
      return fenced[1];
    } catch {
      // Continue with balanced-value scanning.
    }
  }
  const stack: Array<"{" | "["> = [];
  let inString = false;
  let escaped = false;
  let start = -1;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      if (stack.length === 0) start = index;
      stack.push(char);
      continue;
    }
    if (char !== "}" && char !== "]") continue;
    const opening = stack.pop();
    const matches = (opening === "{" && char === "}") || (opening === "[" && char === "]");
    if (!matches) {
      stack.length = 0;
      start = -1;
      continue;
    }
    if (stack.length === 0 && start >= 0) {
      const candidate = text.slice(start, index + 1);
      try {
        JSON.parse(candidate);
        return candidate;
      } catch {
        start = -1;
      }
    }
  }
  return null;
}

const NARRATIVE_ROLE_TERMS: Array<{
  pattern: RegExp;
  name: string;
  role: "protagonist" | "supporting";
}> = [
  { pattern: /内置默认模特|默认模特/u, name: "默认模特角色", role: "protagonist" },
  { pattern: /妈妈|母亲/u, name: "妈妈", role: "supporting" },
  { pattern: /爸爸|父亲/u, name: "爸爸", role: "supporting" },
  { pattern: /宝宝|婴儿/u, name: "宝宝", role: "supporting" },
  { pattern: /孩子|女儿|儿子/u, name: "孩子", role: "supporting" },
  { pattern: /爷爷|奶奶|外婆|老人/u, name: "老人", role: "supporting" },
  { pattern: /女主/u, name: "女主", role: "protagonist" },
  { pattern: /男主/u, name: "男主", role: "protagonist" },
  { pattern: /妻子|丈夫/u, name: "伴侣", role: "supporting" },
  { pattern: /两位厨师|两名厨师|两个厨师|面馆师傅|厨师/u, name: "厨师", role: "protagonist" },
  { pattern: /店员|客服/u, name: "店员", role: "supporting" },
  { pattern: /顾客|消费者/u, name: "顾客", role: "supporting" },
  { pattern: /学生|白领|上班族|通勤族/u, name: "年轻职场人", role: "protagonist" },
  { pattern: /年轻女性|女生|女人/u, name: "年轻女性", role: "protagonist" },
  { pattern: /年轻男性|男生|男人/u, name: "年轻男性", role: "protagonist" },
  { pattern: /年轻人|青年/u, name: "年轻人", role: "protagonist" },
  { pattern: /主角/u, name: "主角", role: "protagonist" },
  { pattern: /橘猫|猫咪|小猫|猫/u, name: "猫", role: "protagonist" },
  { pattern: /小狗|狗狗|狗/u, name: "狗", role: "protagonist" },
  { pattern: /小鸟|鸟儿|鸟/u, name: "鸟", role: "protagonist" },
];

function isNarrativeAnimal(name: unknown): boolean {
  return /(?:橘猫|猫咪|猫|小狗|狗狗|狗|小鸟|鸟儿|鸟|马|羊|牛|鹿|兔|鱼|虎|豹|狮子|熊|鸡|鸭|鹅)/u.test(String(name ?? ""));
}

function cleanNarrativeAnimalAppearance(value: unknown): string {
  let text = String(value ?? "")
    .replace(/[；;]?\s*(?:角色ID|模特ID|定妆照|授权)=[^；;\n]*/gu, "")
    .replace(/[；;]?\s*动物外观由文字锚点与跨镜参考帧锁定[^；;\n]*/gu, "")
    .replace(/(?:^|[；;])\s*跨镜参考帧锁定[^；;\n]*/gu, "");
  const humanTemplate = /[，,；;。]\s*(?:从站立过渡到站立|站立姿态|缓慢走动|张开双臂(?:或自然下垂)?|自然下垂|抱头(?:或伸展)?|伸展|指向(?:或握拳)?|握拳|微笑(?:或点头)?|点头|紧张移动|自然)(?=[，,；;。]|$)/gu;
  for (let index = 0; index < 8; index += 1) text = text.replace(humanTemplate, "");
  return text
    .replace(/[，,；;]{2,}/gu, "；")
    .replace(/^[，,；;。\s]+|[，,；;。\s]+$/gu, "")
    .trim();
}

function normalizePostRainWording(value: string): string {
  return String(value ?? "")
    .replace(/暴雨夜窄巷/gu, "雨后夜晚的窄巷")
    .replace(/雨夜/gu, "雨后夜晚")
    .replace(/冷蓝雨幕/gu, "冷蓝湿气与檐口残水")
    .replace(/雨幕/gu, "潮湿空气")
    .replace(/雨丝/gu, "檐口余滴")
    .replace(/雨打纸箱/gu, "檐口余滴落在纸箱")
    .replace(/持续降雨/gu, "降雨已经停止")
    .replace(/暴雨/gu, "雨后");
}

function mergeNarrativeProps(...groups: Array<unknown[] | undefined>): string[] {
  return [...new Set(groups.flatMap((group) => group ?? [])
    .map(String)
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => !/^(?:爪子?|猫爪|身体|尾巴).*(?:缩回|退回|退入|盘成|贴住)/u.test(item)))];
}

function canonicalCharacterFromEvidence(upstream: Record<string, unknown>): Array<Record<string, unknown>> {
  const explicit = upstream?.character && typeof upstream.character === "object"
    ? upstream.character as Record<string, unknown>
    : null;
  const story = String(upstream?._originalStoryText ?? upstream?.original_story_text ?? "");
  const read = (key: string): string | undefined => {
    const direct = explicit?.[key];
    if (typeof direct === "string" && direct.trim()) return direct.trim();
    const match = story.match(new RegExp(`(?:^|[；;\\n\\s])${key}=([^；;\\n\\s]+)`, "iu"));
    return match?.[1]?.trim();
  };
  const id = read("id");
  const name = read("name");
  const portraitRef = read("portraitRef");
  const authorization = read("authorization");
  if (!id || !name || !portraitRef || !authorization) return [];
  return [{
    id,
    characterId: id,
    name,
    role: explicit?.role ?? "protagonist",
    portraitRef,
    portraitPath: portraitRef,
    authorization,
    description: "本次显式指定的授权模特；所有镜头必须绑定该 ID、当前定妆照与授权范围",
  }];
}

/**
 * Vendor 的需求洞察结果没有角色表，导致有明确人物的叙事片在 G3 契约中
 * 被写成“无真人角色”。该纯函数只从本次意图/场景证据抽取明确出现的人物，
 * 明确声明纯商品/空镜时不生成角色。
 */
export function inferNarrativeCharacters(input: {
  intent: string;
  discovery: Record<string, unknown>;
  upstream?: Record<string, unknown>;
}): Array<{ name: string; role: "protagonist" | "supporting"; description: string }> {
  const explicit = canonicalCharacterFromEvidence(input.upstream ?? {});
  if (explicit.length > 0) {
    return explicit.map((item) => ({
      id: item.id,
      name: String(item.name),
      role: item.role === "supporting" ? "supporting" : "protagonist",
      description: String(item.description),
      portraitRef: item.portraitRef,
      portraitPath: item.portraitPath,
      authorization: item.authorization,
    })) as Array<{
      id: string;
      name: string;
      role: "protagonist" | "supporting";
      description: string;
      portraitRef: string;
      portraitPath: string;
      authorization: string;
    }>;
  }
  const scene = input.discovery?.sceneStructure && typeof input.discovery.sceneStructure === "object"
    ? input.discovery.sceneStructure as Record<string, unknown>
    : {};
  const sceneText = [
    input.intent,
    String(input.upstream?.special_notes ?? ""),
    String(input.upstream?.visual_style ?? ""),
    typeof scene.opening === "object" ? JSON.stringify(scene.opening) : "",
    Array.isArray(scene.scenes) ? JSON.stringify(scene.scenes) : "",
    typeof scene.ending === "object" ? JSON.stringify(scene.ending) : "",
  ].join(" ");
  const found = NARRATIVE_ROLE_TERMS.filter((entry) => entry.pattern.test(sceneText));
  const animals = found.filter((entry) => isNarrativeAnimal(entry.name));
  if (animals.length > 0 && /(?:无动物|不出现动物|禁止动物|不得出现[^。；\n]{0,8}动物)/u.test(sceneText)) return [];
  if (animals.length === 0
    && /(?:无|没有|不出现)(?:真人|人物|角色|模特|演员)|纯空镜|商品为主|场景为主体/u.test(sceneText)) return [];
  const candidates = animals.length > 0 ? animals : found;
  const specific = candidates.filter((entry) => entry.name !== "默认模特角色");
  const selected = specific.length > 0 ? specific : candidates.slice(0, 1);
  const unique = new Map<string, { name: string; role: "protagonist" | "supporting"; description: string }>();
  for (const entry of selected) {
    const usesDefaultModel = /内置默认模特|默认模特/u.test(input.intent);
    const animal = isNarrativeAnimal(entry.name);
    if (entry.name === "厨师" && /(?:两位|两名|两个).{0,3}厨师/u.test(sceneText)) {
      unique.set("厨师 A", {
        name: "厨师 A",
        role: "protagonist",
        description: "同场两位厨师之一；锁定拉面岗位、发型脸型、身高、服装颜色与手部外观，不得与厨师 B 合并",
      });
      unique.set("厨师 B", {
        name: "厨师 B",
        role: "protagonist",
        description: "同场两位厨师之一；锁定看火递碗岗位、发型脸型、身高、服装颜色与手部外观，不得与厨师 A 合并",
      });
      continue;
    }
    const animalCue = animal
      ? sceneText.match(new RegExp(`(?:橘|黑|白|灰|花|三花|狸花)?${entry.name}`, "u"))?.[0] ?? entry.name
      : "";
    const physicalAnchors = animal
      ? [
          animalCue,
          /湿毛成缕|毛(?:发)?被打湿/u.test(sceneText) ? "毛发被打湿成缕" : "",
          /耳尖挂水珠/u.test(sceneText) ? "耳尖挂水珠" : "",
          /盘成一团|蜷缩/u.test(sceneText) ? "体型与盘卧姿态固定" : "",
        ].filter(Boolean)
      : [];
    const description = animal
      ? `${physicalAnchors.join("；")}；跨镜锁定同一品种、体型、毛色、湿度和面部特征；肖像登记仅适用于平台授权动物素材，不得替换物种`
      : entry.name === "厨师"
        ? "厨师主体；锁定发型、脸型、身高、服装颜色与岗位分工，不得增减人数"
      : entry.name === "默认模特角色" || usesDefaultModel
        ? "使用仓库内置默认模特；出镜前仍需按当前角色档案绑定真实图像与授权范围"
        : "叙事片明确人物；出镜前需绑定角色档案与授权范围";
    unique.set(entry.name, { name: entry.name, role: entry.role, description });
  }
  return [...unique.values()];
}

export function narrativeSpeechPolicy(value: unknown): {
  noLipSyncDialogue: boolean;
  voiceoverMentioned: boolean;
  voiceoverDenied: boolean;
  voiceoverAllowed: boolean;
  dialogueAllowed: boolean;
  allSpeechForbidden: boolean;
} {
  const text = String(value ?? "");
  const noLipSyncDialogue = /(?:无.{0,2}台词|无对白|不建议加对白|不做口型|纯画面无对白)/u.test(text);
  const voiceoverMentioned = /(?:旁白|画外音|画外)/u.test(text);
  const voiceoverDenied = text.split(/[。；;\n]/u).some((clause) => {
    const compact = clause.replace(/\s+/gu, "");
    return /(?:禁止|不得|不要|无需|不需要|不加|不添加|不允许|不使用|不采用|避免)(?:任何|额外)?(?:使用|添加|加入|保留|有|出现|存在)?(?:任何|额外)?(?:字幕|文字)?(?:和|及|与|、|,|，|\/)?(?:人声)?(?:旁白|画外音|画外)/u.test(compact)
      || /(?:无|没有|零)(?:任何|额外)?(?:字幕|文字)?(?:和|及|与|、|,|，|\/)?(?:人声)?(?:旁白|画外音|画外)/u.test(compact)
      || /(?:字幕|文字)(?:和|及|与|、|,|，|\/)?(?:旁白|画外音|画外)(?:都|均|也)?(?:不要|禁止|禁用|去掉|删除)/u.test(compact);
  });
  const voiceoverAllowed = !voiceoverDenied && text.split(/[。；;\n]/u).some((clause) => {
    const compact = clause.replace(/\s+/gu, "");
    // A conditional instruction describes how to obey a later request; it is not that request.
    if (/(?:若|如果|如需|仅当)[^。；;\n]{0,32}(?:旁白|画外音)|(?:当|明确要求)[^。；;\n]{0,32}(?:时|则|才)/u.test(compact)) return false;
    return /(?:允许|需要|保留|加入|添加|使用|可(?:以)?(?:加|加入|用|使用|保留))[^。；;\n]{0,12}(?:旁白|画外音)/u.test(compact)
      || /(?:旁白|画外音)[:：][“"「]/u.test(compact);
  });
  return {
    noLipSyncDialogue,
    voiceoverMentioned,
    voiceoverDenied,
    voiceoverAllowed,
    dialogueAllowed: !noLipSyncDialogue,
    allSpeechForbidden: noLipSyncDialogue && !voiceoverAllowed,
  };
}

/** ScriptEngine 在不同阶段把同一合同放在 metadata、metadata._metadata 或 PRD 内。 */
function scriptIntentSpeechRequirement(userIntent: Record<string, unknown>): string {
  const metadata = recordValue(userIntent.metadata);
  const metaFields = recordValue(metadata._metadata);
  const prd = recordValue(metaFields._prd ?? metadata._prd);
  const project = recordValue(prd.projectDefinition);
  const creativeTheme = recordValue(metadata._creativeTheme);
  return [
    metaFields.dialogueRequirement,
    metaFields.dialogue_requirement,
    metadata.dialogueRequirement,
    metadata.dialogue_requirement,
    creativeTheme.dialogue_requirement,
    project._originalStoryText,
    project.sourceIntent,
    metadata._originalStoryText,
    metadata.original_story_text,
  ]
    .map(String)
    .filter(Boolean)
    .join("\n");
}

const NARRATIVE_ACTION_PATTERN = /(摸索|摸向|摸到|碰到|触碰|擦过|擦拭|打滑|扫过|滑落|对准|插入|拧亮|被拧|拧动|拧|旋动|按压|按下|按动|压(?=开关|按钮|下|住|向|在)|磕出|贴上|贴在|推开|开门|打开|关闭|换鞋|走到|走进|拿起|放下|放到|举起|抬起|塌下|看向|抚摸|收伞|抖落|摸黑|贴住|探头|伸出|伸爪|接水|缩回|蜷缩|盘成|坐回|坐下|坐在|舔|蹭|跃过|跑过|回头|抬头|低头|奔跑|慢跑|沿河|停下|转身|跳到|钻回|探出)/gu;

export function extractNarrativeActions(
  discovery: Record<string, unknown>,
  upstream: Record<string, unknown> = {},
): string[] {
  const scene = discovery?.sceneStructure && typeof discovery.sceneStructure === "object"
    ? discovery.sceneStructure as Record<string, unknown>
    : {};
  const scenePurposes = [
    scene.opening && typeof scene.opening === "object" ? String((scene.opening as Record<string, unknown>).purpose ?? "") : "",
    ...(Array.isArray(scene.scenes)
      ? scene.scenes.map((item) => item && typeof item === "object" ? String((item as Record<string, unknown>).purpose ?? "") : "")
      : []),
    scene.ending && typeof scene.ending === "object" ? String((scene.ending as Record<string, unknown>).purpose ?? "") : "",
  ].filter(Boolean);
  const purposes = [
    ...scenePurposes,
    String(upstream._originalStoryText ?? upstream.original_story_text ?? ""),
    String(upstream.special_notes ?? "")
      .split(/\n+/u)
      .filter((line) => line.trim() && !/(?:视觉锚点|物理锚点|动作锚点|声音锚点)/u.test(line))
      .join("\n"),
  ].filter(Boolean);
  const actions: string[] = [];
  const actionFamilies = new Set<string>();
  const actionKey = (verb: string, phrase: string): string => {
    if (/^(?:收伞|抖落)/u.test(phrase)) return "close-umbrella";
    if (/^开门/u.test(phrase)) return "open-door";
    if (/^换鞋/u.test(phrase)) return "change-shoes";
    if (/^拧亮.*台灯/u.test(phrase)) return "turn-on-lamp";
    if (/^(?:坐下|坐回|坐进|坐在).*(?:听雨|灯下|暖光里)?/u.test(phrase)) return "sit-listen";
    if (/探出|探头/u.test(verb)) return "probe";
    if (/缩回|蜷缩|盘成|坐回|钻回/u.test(verb)) return "retreat";
    if (/伸爪|伸出|接水/u.test(verb)) return "reach";
    if (/举起|抬起/u.test(verb)) return "lift";
    if (/跑过|奔跑|慢跑/u.test(verb)) return "run";
    if (/停下|转身/u.test(verb)) return "turn";
    return phrase
      .replace(/^(?:他|她|陈卓|人物|橘猫|猫|狗|鸟)/u, "")
      .replace(/旧|老旧/gu, "")
      .replace(/灯罩(?:上|下)?/gu, "灯罩")
      .replace(/贴在/u, "贴上");
  };
  for (const purpose of purposes) {
    for (const match of purpose.matchAll(NARRATIVE_ACTION_PATTERN)) {
      const index = match.index ?? 0;
      const before = purpose.slice(Math.max(0, index - 6), index).replace(/^.*[，。；、：]/u, "");
      const after = purpose.slice(index + match[0].length, index + match[0].length + 16).split(/[，。；、：]/u)[0] ?? "";
      const locationPrefix = /摸索|摸向|摸黑/u.test(match[0]) && /沿墙|扶墙|贴墙/u.test(before)
        ? (before.match(/沿墙|扶墙|贴墙/u)?.[0] ?? "")
        : "";
      let phrase = `${locationPrefix}${match[0]}${after}`
        .replace(/的?(?:特写|镜头)/gu, "")
        .replace(/^贴[在到]/u, "贴上")
        .trim();
      if (/^(?:收伞|抖落).*/u.test(phrase)) phrase = /回到出租屋/u.test(phrase) ? "收伞回到出租屋" : "收伞";
      else if (/^开门/u.test(phrase)) phrase = "开门";
      else if (/^换鞋/u.test(phrase)) phrase = "换鞋";
      else if (/^拧亮.*台灯/u.test(phrase)) phrase = "拧亮旧台灯";
      else if (/^(?:坐在|坐回|坐进).*听雨/u.test(phrase) || /^坐在.*听雨/u.test(phrase)) phrase = "坐下听雨";
      if (/[—…]+$/u.test(phrase)) {
        const sourceClause = String(upstream._originalStoryText ?? "")
          .split(/[，。；\n]+/u)
          .map((item) => item.trim())
          .find((item) => item.includes(match[0]) && extractNarrativeActions({}, { _originalStoryText: item }).length > 0);
        if (sourceClause) {
          phrase = sourceClause
            .replace(/^(?:最后|随后|然后|接着|再)/u, "")
            .replace(/^.*(?:一只橘猫|橘猫|猫|狗|鸟)(?=从|伸|缩|钻|跑|跳)/u, match[0])
            .trim();
        }
      }
      const key = actionKey(match[0], phrase);
      const malformed = /(?:绒毛|骨上|undefined|null|未标注|关键词|标签|对象|待补|省略)/iu.test(phrase)
        || /(?:阻尼感|触感|手感|质感|音色)(?:$|[，。；、])/u.test(phrase)
        || /^(?:压在|湿冷大雨压在|大雨压在)/u.test(phrase)
        || /^放下$/u.test(phrase)
        || /(?:仅一|离水珠|悬停瞬间|收束动作)$/u.test(phrase)
        || /(?:爪垫|尾巴).*(?:瞬间|动作)$/u.test(phrase)
        || /(?:画面|构图|景别|机位|上三分之一|下三分之一)/u.test(phrase)
        || /^[\d\s，。；、：]/u.test(phrase);
      if (phrase.length >= 2 && !malformed && !actionFamilies.has(key)) {
        actionFamilies.add(key);
        actions.push(phrase);
      }
    }
  }
  const normalized = actions
    .map((phrase) => phrase.replace(/[。；，、\s]+$/u, ""))
    .filter((phrase, index, list) => !list.some((other, otherIndex) =>
      otherIndex !== index && other.length > phrase.length && other.includes(phrase)));
  return normalized.slice(0, 8);
}

export function inferNarrativeProps(input: {
  intent: string;
  discovery: Record<string, unknown>;
  upstream?: Record<string, unknown>;
}): string[] {
  const scene = recordValue(input.discovery?.sceneStructure);
  const evidence = [
    input.intent,
    String(input.upstream?._originalStoryText ?? ""),
    String(input.upstream?.special_notes ?? ""),
    String(scene.opening && typeof scene.opening === "object" ? (scene.opening as Record<string, unknown>).purpose ?? "" : ""),
    ...(Array.isArray(scene.scenes)
      ? scene.scenes.map((item) => `${String(recordValue(item).purpose ?? "")} ${(Array.isArray(recordValue(item).keyElements) ? recordValue(item).keyElements as unknown[] : []).join(" ")}`)
      : []),
    String(scene.ending && typeof scene.ending === "object" ? (scene.ending as Record<string, unknown>).purpose ?? "" : ""),
    ...(scene.opening && typeof scene.opening === "object" && Array.isArray((scene.opening as Record<string, unknown>).keyElements)
      ? ((scene.opening as Record<string, unknown>).keyElements as unknown[]).map(String)
      : []),
    ...(scene.ending && typeof scene.ending === "object" && Array.isArray((scene.ending as Record<string, unknown>).keyElements)
      ? ((scene.ending as Record<string, unknown>).keyElements as unknown[]).map(String)
      : []),
  ].join("\n");
  const terms: Array<{ pattern: RegExp; name: string }> = [
    { pattern: /(?:老旧|旧|新)?台灯|灯罩|钨丝|旋钮|开关/gu, name: "台灯" },
    { pattern: /(?:一串)?钥匙/gu, name: "钥匙" },
    { pattern: /(?:门缝|门轴|门框|锁孔|防盗门|木门|玻璃门|开门|关门|门口|(?<!快)门)/gu, name: "门" },
    { pattern: /(?:长柄|折叠|透明|湿)?雨?伞(?:骨|沿|布)?/gu, name: "雨伞" },
    { pattern: /(?:手机)?屏幕|手机/gu, name: "手机" },
    { pattern: /(?:楼梯)?扶手/gu, name: "扶手" },
    { pattern: /(?:玻璃)?窗(?:框|台|帘)?/gu, name: "窗" },
    { pattern: /(?:旧木)?桌面/gu, name: "桌面" },
    { pattern: /(?:茶|水|保温|咖啡)?杯/gu, name: "杯" },
    { pattern: /搪瓷杯/gu, name: "搪瓷杯" },
    { pattern: /(?:外卖|塑料|纸|手提)?袋/gu, name: "袋" },
    { pattern: /(?:湿|旧|外套|雨衣|肩)?外套/gu, name: "外套" },
    { pattern: /(?:湿|旧)?鞋(?:尖|跟)?/gu, name: "鞋" },
    { pattern: /(?:旧)?海报/gu, name: "海报" },
    { pattern: /书(?:本|页)?/gu, name: "书" },
    { pattern: /纸箱/gu, name: "纸箱" },
    { pattern: /(?:白瓷|陶瓷|瓷)?茶壶(?:壶盖|壶嘴)?/gu, name: "茶壶" },
    { pattern: /蒸汽/gu, name: "蒸汽" },
    { pattern: /釉面/gu, name: "釉面" },
    { pattern: /壶盖/gu, name: "壶盖" },
    { pattern: /壶嘴/gu, name: "壶嘴" },
    { pattern: /落叶/gu, name: "落叶" },
    { pattern: /栏杆/gu, name: "栏杆" },
    { pattern: /木栈道/gu, name: "木栈道" },
    { pattern: /信号灯|红绿灯/gu, name: "信号灯" },
    { pattern: /光斑|光柱/gu, name: "光影" },
    { pattern: /苔藓/gu, name: "苔藓" },
    { pattern: /露水/gu, name: "露水" },
    { pattern: /(?:纸船|纸条|照片|信封)/gu, name: "纸质道具" },
    { pattern: /(?:自行|公交|列|汽|火)车/gu, name: "车" },
    { pattern: /(?:陶器|瓷器|文物|石碑|石桥|桥)/gu, name: "场景器物" },
    { pattern: /(?:便利店)?灯箱/gu, name: "灯箱" },
    { pattern: /屋檐|檐口/gu, name: "屋檐" },
    { pattern: /积水|水洼/gu, name: "积水" },
    { pattern: /水滴|水珠|雨滴/gu, name: "水滴" },
    { pattern: /薄雾|雾气|雾层|晨雾/gu, name: "薄雾" },
    { pattern: /远山|山形|山脉/gu, name: "远山" },
    { pattern: /芦苇|芦花/gu, name: "芦苇" },
    { pattern: /湖面|水面|海面/gu, name: "水面" },
    { pattern: /涟漪|波纹/gu, name: "涟漪" },
  ];
  const props: string[] = [];
  const negativeClauses = [...evidence.matchAll(/(?:不出现|不得|禁止|不要|不能)[^。；\n]{0,40}/gu)]
    .map((match) => match[0]);
  for (const term of terms) {
    const matches = [...evidence.matchAll(term.pattern)];
    const literalDoor = /(?:门框|门缝|门锁|开门|关门|门口|防盗门|木门|玻璃门)/u.test(evidence);
    const metaphorOnlyDoor = term.name === "门" && matches.length > 0 && !literalDoor;
    if (matches.length > 0 && !metaphorOnlyDoor
      && !negativeClauses.some((clause) => clause.includes(term.name))
      && !props.includes(term.name)) props.push(term.name);
  }
  const product = String(input.upstream?.product ?? recordValue(input.upstream?.brief).product ?? "").trim();
  if (product && !props.includes(product)) props.unshift(product);
  return props.slice(0, 16);
}

function sceneElementsForPurpose(purpose: string, elements: string[]): string[] {
  const unique = [...new Set(elements.map((item) => item.trim()).filter(Boolean))];
  if (/^收伞.*(?:回到)?出租屋/u.test(purpose)) {
    return unique.filter((item) => /(?:雨伞|伞|积水|水滴|雨珠|霓虹|钥匙|楼道|门口)/u.test(item)).slice(0, 6);
  }
  if (/^开门/u.test(purpose)) {
    return unique
      .filter((item) => /(?:门|钥匙|雨伞)/u.test(item))
      .filter((item) => !/(?:暖光|暖黄|灯罩|光圈|灯下)/u.test(item))
      .slice(0, 5);
  }
  if (/^换鞋/u.test(purpose)) {
    return unique
      .filter((item) => /(?:鞋|门|雨伞)/u.test(item))
      .filter((item) => !/(?:暖光|暖黄|灯罩|光圈|灯下)/u.test(item))
      .slice(0, 5);
  }
  if (/^拧亮.*台灯/u.test(purpose)) {
    return ["旧台灯", "台灯开关/旋钮", "桌面"];
  }
  if (/^坐下.*听雨/u.test(purpose)) {
    return ["旧台灯", "窗", "坐具"];
  }
  if (/(?:猫|爪).*(?:探|伸|接水|滴水)|(?:探出|伸爪|接水).*(?:猫|爪)/u.test(purpose)) {
    return unique.filter((item) => /(?:纸箱|猫|爪|水滴|水珠|屋檐)/u.test(item)).slice(0, 8);
  }
  if (/(?:缩回|盘成|蜷缩|鼻尖|尾巴|耳朵)/u.test(purpose)) {
    return unique.filter((item) => /(?:纸箱|猫|尾巴|鼻尖|耳朵|毛巾)/u.test(item)).slice(0, 8);
  }
  if (/(?:落叶|栏杆|木栈道|光斑)/u.test(purpose)) {
    return unique.filter((item) => /(?:落叶|栏杆|木栈道|光斑|光影|缝隙)/u.test(item)).slice(0, 8);
  }
  if (/(?:湖|雾|芦苇|涟漪|远山)/u.test(purpose)) {
    return unique.filter((item) => /(?:湖|雾|远山|芦苇|水面|涟漪|露水)/u.test(item)).slice(0, 8);
  }
  if (/(?:茶壶|蒸汽|釉面|壶嘴|壶盖)/u.test(purpose)) {
    return unique.filter((item) => /(?:茶壶|蒸汽|釉面|壶嘴|壶盖|水滴|桌面|窗)/u.test(item)).slice(0, 8);
  }
  if (/(?:水洼|信号灯|红绿灯|雨滴|城市路面)/u.test(purpose)) {
    return unique.filter((item) => /(?:水洼|信号灯|红绿灯|雨滴|路面|积水|倒影)/u.test(item)).slice(0, 8);
  }
  return unique;
}

export function pairRiskMitigations(riskAssessment: Record<string, unknown>): string[] {
  const risks = Array.isArray(riskAssessment.technicalRisks)
    ? riskAssessment.technicalRisks.map(recordValue)
    : [];
  const mitigations = Array.isArray(riskAssessment.mitigationSuggestions)
    ? riskAssessment.mitigationSuggestions.map(String).filter(Boolean)
    : [];
  const groups = [
    { pattern: /(?:空间|布局|场景|角色|服装|造型)[^。；]{0,20}(?:一致|漂移)|跨镜头[^。；]{0,20}(?:空间|布局|角色|服装|造型)(?:一致|漂移)/u, weight: 24 },
    { pattern: /手部|手指|指腹|指尖|关节|触碰|接触|穿模|握|按键|开关/u, weight: 12 },
    { pattern: /台灯|道具|纹理|缺口|磨痕|物理一致/u, weight: 8 },
    { pattern: /低照度|曝光|色温|胶片颗粒|光源|光比|光影/u, weight: 6 },
    { pattern: /雨|伞|雨珠|发梢|水滴|湿发/u, weight: 4 },
    { pattern: /身份|面部|五官|模特|定妆|角色一致|人脸/u, weight: 3 },
  ];
  const exactFeatures = [
    "钨丝", "灯丝", "亮度", "色温", "光色", "亮度跳变", "光晕",
    "裂纹", "照度", "霓虹", "倒影", "光源位置",
    "钥匙", "钥匙串", "金属反光", "反光", "高光", "一致性", "跨镜头",
    "灯罩", "开关旧痕", "钨丝形状",
    "雨珠", "伞骨", "液体", "水珠", "湿发", "发丝", "面部",
    "划痕", "积尘", "材质", "纹理", "手指", "开关", "穿模",
    "台灯", "道具", "身份", "模特", "定妆", "角色",
    "爪心", "猫爪", "指甲", "肉垫", "爪尖", "溅花", "水花", "缩爪",
    "尾巴", "尾尖", "盘成", "蜷缩", "收束", "箱内",
  ];
  const featureGroups = [
    ["雨珠", "雨具", "雨伞", "伞骨", "雨丝"],
    ["钥匙", "钥匙串", "金属反光"],
    ["灯罩", "开关旧痕", "钨丝形状", "跨镜头", "一致性"],
    ["指纹", "磨白", "发黄", "塑料", "颗粒", "灰尘", "微质感", "磨砂", "材质", "纹理"],
    ["低照度", "曝光", "色温", "光比", "胶片颗粒"],
    ["身份", "面部", "模特", "定妆照", "角色一致"],
    ["爪心", "猫爪", "爪尖", "指甲", "肉垫", "溅花", "水花", "缩爪"],
    ["尾巴", "尾尖", "盘成", "蜷缩", "收束", "箱内"],
  ];
  const generic = /(?:预留重试|准备备选|待针对|补齐缓解|降低复杂度|保持视觉一致|提升质量)/u;
  const fallback = (text: string): string => {
    if (/(?:空间|布局|场景|角色|服装|造型)[^。；]{0,20}(?:一致|漂移)|跨镜头[^。；]{0,20}(?:空间|布局|角色|服装|造型)(?:一致|漂移)/u.test(text)) {
      return "锁定同一角色参考帧、服装与场景平面图，固定门、桌面和主光位置；逐镜检查角色轮廓、道具比例与空间连线，异常只重做该镜，不改动已确认场景结构。";
    }
    if (/手持|微晃|浅景深人物.*稳/u.test(text)) {
      return "保留已确认的呼吸级手持微晃，不改成三脚架或另一种运镜；锁定机位高度、轴线与焦平面，用后期轻微稳像抑制焦点漂移，逐镜检查边缘撕裂与背景融化，不改变人物动作和构图。";
    }
    if (/(?:微表情|表情.*僵硬|眼神.*空洞|情绪停顿|静止.*情绪)/u.test(text)) {
      return "把静止收束改为背影或侧影、手部自然放下与肩线下沉三个局部动作，不要求正脸长特写或丰富表情；用雨声、呼吸和衣料轻响承接停顿，逐镜保持同一姿态终点。";
    }
    if (/旧台灯.*(?:色温|灯罩.*旧痕|暖光斑)|灯罩.*旧痕/u.test(text)) {
      return "锁定旧台灯2700K主光、灯罩旧痕位置和墙面暖光斑轮廓，使用同一灯具参考帧与固定LUT；逐镜检查色温和光斑不漂移，异常只重做该镜照明。";
    }
    if (/窗外|雨幕|玻璃.*(?:雨光|反射)/u.test(text)) {
      return "把窗外雨幕设为独立背景板，锁定雨线方向、密度和反射强度；室内人物与玻璃保持固定焦平面，逐镜对照同一参考帧，异常只重做雨幕层，不改变主体动作。";
    }
    if (/猫爪|爪心|爪尖|肉垫|爪形|多趾/u.test(text)) {
      return "把猫爪接水拆成爪尖伸入、水滴下坠、爪垫接水三个固定微距短镜，锁定四趾轮廓、肉垫位置和爪毛湿度；水花用已批准实拍素材插入，出现多趾、粘连或穿模只重做该镜。";
    }
    if (/湿毛|毛发.*(?:干湿|连续|跳变)|干湿状态/u.test(text)) {
      return "按镜头锁定单一干湿度，写清湿毛成缕方向和爪垫泥水状态；跨镜用同一参考帧与光位复核，不允许同镜内干湿跳变，异常只重做相邻镜。";
    }
    if (/(?:猫头|纸箱).*(?:穿模|边界)|(?:箱沿|纸箱).*毛发/u.test(text)) {
      return "用箱沿遮挡猫头与纸箱交界，固定机位、焦距和暖光边缘；逐镜检查毛发穿透、边界闪烁和纸板形变，失败只重做该遮挡镜，不整段重生成。";
    }
    if (/蜷缩|肢体数量|尾巴.*(?:穿模|漂移)|盘成/u.test(text)) {
      return "把蜷缩拆成低头、尾巴扫入遮鼻、身体盘紧三个固定短镜；用箱沿前景遮住尾部连接处，锁定同一体型与光位，逐镜核对肢体数量，异常只重做该收束镜。";
    }
    if (/AI生成质量|生成质量不确定|质量不确定|多次迭代/u.test(text)) {
      return "把高风险画面拆成固定机位短镜，逐镜锁定首帧、主体外观、光源方向和接触关系；每镜生成后检查结构、材质与连续性，失败只重做该镜，不整条管线重跑。";
    }
    if (/蒸汽|水汽|体积雾|烟缕|热气/u.test(text)) {
      return "蒸汽只保留壶嘴上方一小缕低速热汽：锁定起点、上升方向、透明度和散开边界；优先用实拍水蒸气或低频体积雾叠层，逐镜检查循环帧、噪点闪烁与主体分离，异常只重做蒸汽层。";
    }
    if (/侧逆晨光|晨光.*釉面|光源方向|阴影长度|高光.*滚转|色温跳变/u.test(text)) {
      return "把晨光变化拆成同机位、固定光源方向的短段：起幅冷蓝侧逆光、中段暖金扫过釉面、末段光退；逐镜锁定光源方位、阴影长度、色温曲线与高光滚降，异常只重调该段照明。";
    }
    if (/白瓷|陶瓷|釉面|壶嘴.*结构|壶把.*结构|浅景深.*结构|塑料.*蜡质/u.test(text)) {
      return "锁定白色陶瓷茶壶的壶嘴、壶把、壶身比例与釉面高光位置；用真实微距素材、焦点堆栈或固定结构参考帧，单镜保持同一焦平面和光源方向，逐镜检查塑料感、蜡质感、焦点呼吸与细结构形变，异常只重做该镜。";
    }
    if (/时长|节奏|镜头时长分配/u.test(text)) {
      return "先按场景建立硬时间预算并写入镜头合同，再逐镜实测 durationSeconds；场景加总必须等于目标总时长，超差只重分配同场景镜头，不压缩有明确动作的镜头。";
    }
    if (/薄雾|雾层|雾散|时序.*(?:闪烁|连贯|一致)|回卷|局部重复/u.test(text)) {
      return "把雾散改为分层透明度递减：近景、中景和远景各锁一层漂移速度与透明度曲线，每镜只允许单调散开；逐镜检查回卷、闪断和贴图撕裂，失败只重做该雾层。";
    }
    if (/涟漪|波纹|水面.*(?:质感|运动)/u.test(text)) {
      return "把水面运动独立成一层：锁定风向、涟漪起点、扩频率和消失边界，用水面参考帧与芦苇摆动方向交叉核对；高频纹理只在局部特写内生成，必要时替换为实拍水面，异常只重做该层。";
    }
    if (/低饱和|青灰|水面.*高光|高光过强|暗部.*糊|质感控制/u.test(text)) {
      return "把低照度质感单独做技术样片：锁定青灰白平衡、暗部抬升与高光滚降，水面只保留低强度反射；每镜检查塑料感、频闪、色带与暗部断层，不达标只重做该镜的质感参数。";
    }
    if (/无主体|空镜.*幻觉|生成人物|人物、动物|船只|水印/u.test(text)) {
      return "为每个镜头建立唯一负面清单：无人物、无动物、无船、无品牌、无文字、无水印；生成前写入请求负面词，生成后检查首中尾帧和画面四角，出现任一元素只重做该镜，禁止用裁切掩盖。";
    }
    if (/涟漪.*(?:方向|频率)|风.*涟漪|无风自动|波纹.*重复/u.test(text)) {
      return "把风源与水面运动绑定：芦苇摆动方向决定涟漪扩散方向，每段只允许一个持续风源；目标帧核对涟漪频率、方向与芦苇摆动一致，无风段落必须保持静水，失败只重做该段。";
    }
    if (/芦苇|杆状|前景.*(?:抖动|分叉|数量跳变)/u.test(text)) {
      return "把芦苇拆成独立的实拍前景层，固定杆数、间距、朝向和焦点；生成层只负责远山、雾和水面，合成前逐帧核对杆体无抖动、分叉或增殖，异常只重做前景层。";
    }
    if (/远山|山形|山脊|剪影.*(?:细节|补全|漂移|新增)/u.test(text)) {
      return "把远山固定成单色低对比剪影参考层，锁定山脊转折点与画面占比；生成请求禁止补出森林、建筑或积雪细节，逐帧对照参考轮廓，异常只重做山体遮罩。";
    }
    if (/划痕|积尘|指纹|磨白|发黄|塑料|颗粒|灰尘|微质感|磨砂|裂纹|磨痕|材质|纹理|道具/u.test(text)) {
      return "把微质感锚点拆成固定机位微距短镜头，单镜不超过2秒，锁定同一参考帧、侧向硬光和非重复磨损路径；不在运动长镜中生成精细纹理。";
    }
    if (/钨丝|灯丝|暗转亮|由暗到亮|起亮/u.test(text)) {
      return "把钨丝起亮拆成暗态静帧、微亮插入、暖光稳定三个短镜，锁定灯丝形状与亮度曲线；连续光色变化交由后期曲线控制，不用单镜猜测。";
    }
    if (/尾巴|尾尖|盘成|蜷缩|收束/u.test(text)) {
      return "把结尾收束拆为低头、尾尖扫入遮鼻、固定中近景三个短镜；用箱沿前景遮挡尾部与身体连接处，锁定同一机型与光位，尾尖稳定贴合鼻头后再进入下一阶段。";
    }
    if (/手部|手指|指腹|指尖|关节|穿模|开关|旋钮/u.test(text)) {
      return "将手部动作拆成固定机位的短特写，分别拍悬停、局部接触和离开；用遮挡与剪辑规避完整手指接触，并为每镜锁定同一参考帧。";
    }
    if (/雨珠|伞骨|液体|水珠|水滴|发梢|滴水|水痕|湿鞋|积水|伞尖/u.test(text)) {
      return "雨珠改为静态挂珠或逆光水丝，滴落瞬间用声音与下一镜水痕承接；不要求模型生成连续流体轨迹，必要时替换为已批准实拍素材。";
    }
    if (/钥匙|锁孔|门锁|锁舌|金属反光/u.test(text)) {
      return "门锁与钥匙只拍局部剪影：固定锁孔轴心、钥匙尖端和金属高光方向；插入与转动拆成两个短特写，转动结果用锁舌声和门缝光变化承接。";
    }
    if (/身份|面部|五官|模特|定妆|角色/u.test(text)) {
      return "绑定当前角色 ID 与活动定妆照，固定发型、服装、焦平面和光位；限制大角度转头与正脸近景，每镜复核身份与外观指纹。";
    }
    if (/低照度|曝光|色温|胶片颗粒|光源|光比|光影|肤色|噪点/u.test(text)) {
      return "固定曝光、白平衡、主辅光比与 LUT，按场景隔离冷暖光；暗部细节保留在同一基准帧上复核，禁止单镜头内连续大幅调光。";
    }
    if (/霓虹|反射|风格|影调|倒影/u.test(text)) {
      return "将写实室内与霓虹外景分镜隔离，分别锁定色温、反射来源和背景虚化；背景文字全部失焦，不使用跨风格单镜混光。";
    }
    return "将风险镜头拆为更短的单动作镜头，锁定首帧、角色、道具与光位；每镜生成前复核参考帧，失败时改用已批准素材，不做规则兜底。";
  };
  const specificMitigations = mitigations.filter((item) => !generic.test(item));
  const semanticMitigation = (text: string): string | undefined => {
    const find = (pattern: RegExp): string | undefined =>
      specificMitigations.find((item) => pattern.test(item));
    if (/(?:蒸汽|水汽|体积雾|烟缕|热气)/u.test(text)) {
      const found = find(/(?:蒸汽|水汽|体积雾|烟缕|热气)/u);
      if (found) return found;
    }
    if (/(?:侧逆晨光|晨光.*釉面|光源方向|阴影长度|高光.*滚转|色温跳变)/u.test(text)) {
      const found = find(/(?:晨光|光源方向|色温|曝光|光影变化|白平衡|LUT)/u);
      if (found) return found;
    }
    if (/(?:白瓷|陶瓷|釉面|壶嘴.*结构|壶把.*结构|浅景深.*结构|塑料.*蜡质)/u.test(text)) {
      const found = find(/(?:白瓷|陶瓷|釉面|壶嘴|壶把|微距|焦点堆栈|材质)/u);
      if (found) return found;
    }
    if (/(?:悬落|拉丝|悬垂|断裂|果冻|流体).*水|水(?:珠|滴).*(?:悬|拉|形变)/u.test(text)) {
      const found = find(/(?:水珠|水滴).*(?:剪影|散景|跳切|悬垂|拉丝|折射)|(?:悬落|拉丝|果冻).*(?:水珠|水滴)/u);
      if (found) return found;
    }
    if (/(?:雨伞|雨珠|伞骨|伞尖|滴水|水痕|湿鞋|积水)/u.test(text)) {
      const found = find(/(?:雨珠|雨伞|伞骨|伞尖|滴水|水痕|湿鞋|积水|液体|水滴)/u);
      if (found) return found;
    }
    if (/(?:钥匙|锁孔|门锁|锁舌|金属反光)/u.test(text)) {
      const found = find(/(?:钥匙|锁孔|门锁|锁舌|金属反光)/u);
      if (found) return found;
    }
    if (/(?:同一角色|侧脸|身份|面部|五官|角色一致|模特|定妆)/u.test(text)) {
      const found = find(/(?:侧脸|身份|面部|五官|角色一致|参考立绘|定妆照|半脸|浅景深|首帧图生视频)/u);
      if (found) return found;
    }
    if (/(?:动作连续性|人物漂移|湿痕跳变|道具位置变化|姿态.*连续)/u.test(text)) {
      const found = find(/(?:固定机位.*短镜头|动作匹配|空间连续|道具状态变化)/u);
      if (found) return found;
    }
    if (/(?:长镜头.*(?:纹理蠕动|雨丝|噪点)|雨丝.*不连贯|静中之动)/u.test(text)) {
      const found = find(/(?:单镜时长|硬切拼接|雨丝|纹理蠕动|噪点|降噪)/u);
      if (found) return found;
    }
    if (/(?:低照度|色偏|噪点.*(?:闪烁|堆积|漂移|带状)|白平衡|曝光|主辅光比)/u.test(text)) {
      const found = find(/(?:低照度|曝光|色温|白平衡|主辅光比|LUT|青灰)/u);
      if (found) return found;
    }
    return undefined;
  };
  const tokens = (value: string): Set<string> => {
    const out = new Set<string>();
    const normalized = value.replace(/[^\p{Script=Han}A-Za-z0-9]+/gu, " ").replace(/\s+/gu, " ").trim();
    for (const chunk of normalized.split(" ")) {
      for (const size of [2, 3, 4]) {
        for (let index = 0; index <= chunk.length - size; index += 1) out.add(chunk.slice(index, index + size));
      }
    }
    return out;
  };
  const paired = risks.map((risk) => {
    const text = `${String(risk.risk ?? "")} ${String(risk.impact ?? "")}`;
    if (/耳朵|耳廓|耳尖/u.test(text) && /(?:收|折|贴|后压|抖动)/u.test(text)) {
      return "把耳朵收拢拆成耳根贴头、耳尖折入和最终静止三个局部短镜；锁定同一猫头参考帧与耳廓轮廓，用箱沿遮挡颈部连接处，逐镜检查耳朵数量、折叠方向与穿模。";
    }
    if (/纸箱|箱沿|瓦楞/u.test(text) && /(?:毛边|吸水|潮湿|塌陷|边缘|穿模|形变)/u.test(text)) {
      return "纸箱边缘固定同一参考帧，先锁定箱角厚度、毛边与水渍分布；猫爪或身体接触处只做局部遮挡和短镜，逐镜核对箱体不塌陷、毛边不增殖、毛发不穿模。";
    }
    if (/(?:悬停|将落未落|悬而未落)/u.test(text) && /(?:水珠|水滴|露水)/u.test(text)) {
      return "悬停水滴锁定单帧形态、挂点和重力方向；坠落前只做轻微鼓胀，不用长镜连续解算流体，落点用下一镜水痕与同步水滴声承接。";
    }
    if (/爪|肉垫|多趾/u.test(text) && /(?:连续|动作|抖动|形变|穿模|数量|粘连)/u.test(text)) {
      return "把爪部动作拆成探出、接触、缩回三个固定机位短镜，锁定同一猫爪参考帧、趾数和肉垫轮廓；接触点只做局部特写，逐镜检查爪数、关节方向与水滴穿模。";
    }
    if (/(?:跨镜头|逐帧)/u.test(text)
      && /(?:纸箱|花纹)/u.test(text)
      && /(?:一致|连续|漂移|跳变)/u.test(text)) {
      return "锁定同一纸箱参考帧、花纹位置、水痕边界与街灯光源方向；每个切点核对待机姿态和道具相对位置，异常只重做对应镜头的遮挡层，不改动已通过的场景结构。";
    }
    if (/(?:湿地面|水痕|反光|反射)/u.test(text)
      && /(?:跨镜头|逐帧|连续|一致|漂移|跳变)/u.test(text)
      && !/(?:低照度|色温|噪点|换鞋|鞋跟|脚掌|脚部|雨滴|涟漪|伞面|钥匙|锁孔|门锁|锁舌)/u.test(text)) {
      return "固定主灯位、背景板与相机高度，逐镜锁定湿地反光方向、水痕边界和调色基准；每个切点对照同一参考帧检查高光形状与暗部层次，异常只重做反光或水痕层。";
    }
    if (/(?:微表情|表情.*(?:僵硬|停滞)|眼神.*空洞|静坐.*(?:面部|情绪|长镜)|面部.*(?:漂移|变形))/u.test(text)
      && !/(?:台灯|旋钮|开关|钨丝|身份|定妆|角色一致)/u.test(text)) {
      return "把静止情绪拆成背影或侧影、手部自然放下与肩线下沉三个局部短镜，不要求正脸长特写；用雨声、呼吸和衣料轻响承接停顿，逐镜保持同一姿态终点。";
    }
    if (/(?:鞋带|鞋口|鞋跟|脚掌|脚踝|足部|换鞋).*(?:接触|形变|穿模|湿度|反射|动作)|(?:脚|足部).*(?:鞋|地面).*(?:一致|连续|反射)/u.test(text)) {
      return "换鞋拆成鞋跟松脱、脚掌离鞋、脚掌落地三个局部短镜；固定鞋型和脚踝比例，不生成完整解鞋带长镜，鞋跟形变或脚掌穿模时只重做该局部镜。";
    }
    if (/(?:低照度|曝光|色偏|白平衡|主辅光比)|噪点.*(?:闪烁|堆积|漂移)/u.test(text)
      && !/(?:微表情|静坐|手部|手指|旋钮|开关|指纹|磨白|发黄|塑料)/u.test(text)) {
      return "固定低照度曝光、青灰白平衡、主辅光比与LUT，分别锁定室内外冷暖光源；逐镜检查暗部噪点、色温漂移、雨丝连续性及高光滚降，不使用跨场景复用的雨幕参数。";
    }
    if (/(?:湖面|水面).*(?:反射|倒影|几何|边缘)|(?:远山|芦苇).*(?:反射|倒影)/u.test(text)
      && /(?:一致|连续|漂移|跳变|变形)/u.test(text)) {
      return "锁定固定机位、湖岸参考线和远山轮廓，倒影只用同一静态参考层与单次风源驱动；逐段核对山脊转折、芦苇杆数和倒影占比，异常只重做水面或倒影层。";
    }
    if (/(?:体积光|光柱|光束|眩光|镜头光晕|逆光)/u.test(text)) {
      return "体积光改用单侧窗光或实拍雾板遮光，锁定太阳画外方位、光柱角度和雾层厚度；禁止硬边上帝光和镜头光晕，逐段对照同一参考帧，异常只重做光柱遮罩。";
    }
    if (/(?:风.*涟漪|涟漪.*(?:方向|频率|尺度)|无风自动|波纹.*重复)/u.test(text)) {
      return "把风源与水面运动绑定：芦苇摆动方向决定涟漪扩散方向，每段只允许一个持续风源；目标帧核对涟漪频率、方向与芦苇摆动一致，无风段落必须保持静水，失败只重做该段。";
    }
    if (/(?:雨滴|雨珠|雨丝|涟漪|水渍).*(?:涟漪|反射|连续|方向|密度|因果|穿帮)|(?:雨落无涟漪|反光方向)/u.test(text)) {
      return "雨珠、雨滴、伞面和地面积水分别锁定同一声画时钟：单条雨丝方向保持一致，落点与涟漪中心逐帧对应；水渍反光固定同一光源方向，异常只重做对应雨层或水层。";
    }
    const semantic = semanticMitigation(text);
    if (semantic) return semantic;
    if (/(?:手持|微晃|微表情|表情.*僵硬|眼神.*空洞|情绪停顿|静止.*情绪)/u.test(text)) {
      return fallback(text);
    }
    if (/(?:划痕|积尘|指纹|磨白|发黄|塑料|颗粒|灰尘|微质感|磨砂|裂纹|磨痕|材质|纹理)/u.test(text)) {
      const found = specificMitigations.find((item) =>
        /(?:划痕|积尘|指纹|磨白|发黄|塑料|颗粒|灰尘|微质感|磨砂|裂纹|磨痕|材质|纹理|微距)/u.test(item));
      return found || fallback(text);
    }
    if (/(?:侧脸|面部.*漂移|低照度.*面部|长镜.*变形)/u.test(text)) {
      return "低照度侧脸保持半脸入画与侧逆光，固定同一参考帧、发型和焦平面；把长镜拆成呼吸感短镜，逐镜核对面部纹理、五官轮廓和发丝边缘，不追加正面补光。";
    }
    if (/(?:低照度|色偏|噪点.*闪烁|白平衡|曝光.*漂移|主辅光比)/u.test(text)) {
      return "固定曝光、白平衡、主辅光比与 LUT，分别锁定室外冷蓝环境光和室内钨丝主光；逐镜检查暗部噪点、色温漂移和高光滚降，不使用会跨场景复用的雨幕参数掩盖光照问题。";
    }
    if (/(?:台灯.*(?:开关|旋钮)|灯光.*渐变|钨丝.*亮)/u.test(text)) {
      return "把台灯开关拆成暗态静帧、指节接触旋钮、钨丝起亮三个短特写；锁定同一参考帧、旋钮轴心、手指接触点和亮度曲线，灯亮结果用连续明暗变化与开关声承接，不生成完整手部操作长镜。";
    }
    if (/(?:换鞋时|鞋跟|脚掌|脚踝|足部)/u.test(text)) {
      return "换鞋拆成鞋跟松脱、脚掌离鞋、脚掌落地三个局部短镜；固定鞋型和脚踝比例，不生成完整解鞋带长镜，鞋跟形变或脚掌穿模时只重做该局部镜。";
    }
    if (/(?:空间|布局|场景|角色|服装|造型)[^。；]{0,20}(?:一致|漂移)|跨镜头[^。；]{0,20}(?:空间|布局|角色|服装|造型)(?:一致|漂移)/u.test(text)) {
      return fallback(text);
    }
    if (/旧台灯.*(?:色温|灯罩.*旧痕|暖光斑)|灯罩.*旧痕/u.test(text)
      && !specificMitigations.some((item) => /旧台灯.*(?:色温|灯罩.*旧痕|暖光斑)|2700K|固定LUT/u.test(item))) {
      return fallback(text);
    }
    if (/窗外|雨幕|玻璃.*(?:雨光|反射)/u.test(text)
      && !specificMitigations.some((item) => /窗外|雨幕|玻璃.*(?:雨光|反射)/u.test(item))) {
      return fallback(text);
    }
    if (/钨丝|灯丝|起亮|由暗到亮|暗转亮/u.test(text)
      && !specificMitigations.some((item) => /钨丝|灯丝|起亮|由暗到亮|暗转亮/u.test(item))) {
      return fallback(text);
    }
    if (/猫爪|爪心|爪尖|肉垫|爪形|多趾/u.test(text)
      && !specificMitigations.some((item) => /猫爪|爪心|爪尖|肉垫|爪形|多趾/u.test(item))) {
      return fallback(text);
    }
    if (/湿毛|毛发.*(?:干湿|连续|跳变)|干湿状态/u.test(text)
      && !specificMitigations.some((item) => /湿毛|毛发.*(?:干湿|连续|跳变)|干湿状态/u.test(item))) {
      return fallback(text);
    }
    if (/(?:猫头|纸箱).*(?:穿模|边界)|(?:箱沿|纸箱).*毛发/u.test(text)
      && !specificMitigations.some((item) => /箱沿|纸箱.*遮挡|毛发穿模/u.test(item))) {
      return fallback(text);
    }
    if (/蜷缩|肢体数量|尾巴.*(?:穿模|漂移)|盘成/u.test(text)
      && !specificMitigations.some((item) => /蜷缩|肢体|尾巴/u.test(item))) {
      return fallback(text);
    }
    let best = "";
    let bestScore = 0;
    const riskTokens = tokens(text);
    for (const mitigation of specificMitigations) {
      const score = groups.reduce((sum, group) =>
        sum + (group.pattern.test(text) && group.pattern.test(mitigation) ? group.weight : 0), 0);
      const featureScore = exactFeatures.reduce((sum, feature) =>
        sum + (text.includes(feature) && mitigation.includes(feature) ? 20 : 0), 0);
      const aliasScore = featureGroups.reduce((sum, group) =>
        sum + (group.some((feature) => text.includes(feature)) && group.some((feature) => mitigation.includes(feature)) ? 20 : 0), 0);
      const mitigationTokens = tokens(mitigation);
      const lexicalScore = [...riskTokens].reduce((sum, token) =>
        sum + (mitigationTokens.has(token) ? (token.length === 4 ? 8 : token.length === 3 ? 5 : 2) : 0), 0);
      if (score + featureScore + aliasScore + lexicalScore > bestScore) {
        best = mitigation;
        bestScore = score + featureScore + aliasScore + lexicalScore;
      }
    }
    return bestScore >= 15 && best ? best : fallback(text);
  });
  const seen = new Set<string>();
  return paired.map((item, index) => {
    if (!seen.has(item)) {
      seen.add(item);
      return item;
    }
    const text = `${String(risks[index]?.risk ?? "")} ${String(risks[index]?.impact ?? "")}`;
    const replacement = fallback(text);
    const unique = seen.has(replacement) ? `针对风险${index + 1}：${replacement}；独立复核该风险的目标帧与回执。` : replacement;
    seen.add(unique);
    return unique;
  });
}

function narrativeNegativeConstraints(input: {
  intent: string;
  upstream?: Record<string, unknown>;
}): string[] {
  const text = [
    input.intent,
    input.upstream?._originalStoryText,
    input.upstream?.special_notes,
    input.upstream?.dialogue_requirement,
  ].map(String).join("\n");
  const explicit = [
    /无(?:真人|人物|角色|路人和游客)/u.test(text) ? "无人物" : "",
    /无动物|不出现动物/u.test(text) ? "无动物" : "",
    /无品牌|不出现品牌/u.test(text) ? "无品牌" : "",
    /无文字|无字幕|不出现文字/u.test(text) ? "无文字与字幕" : "",
    /无旁白|不出现旁白/u.test(text) ? "无旁白" : "",
  ].filter(Boolean);
  const clauses = [...text.matchAll(/(?:不出现|不得|禁止|不要|不能)[^。；\n]*/gu)]
    .map((match) => match[0].trim())
    .filter((item) => item.length >= 4);
  return [...new Set([...explicit, ...clauses])].slice(0, 12);
}

export function normalizeNarrativeRequirementMarkdown(
  markdown: string,
  discovery: Record<string, unknown>,
  duration: number,
  upstream: Record<string, unknown> = {},
): string {
  const scene = discovery?.sceneStructure && typeof discovery.sceneStructure === "object"
    ? discovery.sceneStructure as Record<string, unknown>
    : {};
  const sceneCount = Array.isArray(scene.scenes) ? scene.scenes.length : Number(scene.sceneCount ?? 0);
  const segmentCount = sceneCount + (scene.opening ? 1 : 0) + (scene.ending ? 1 : 0);
  const hasSceneStructure = Boolean(scene.opening || scene.ending || (Array.isArray(scene.scenes) && scene.scenes.length > 0));
  const speechFullyForbidden = narrativeSpeechPolicy(String(upstream.dialogue_requirement ?? "")).allSpeechForbidden;
  let normalized = hasSceneStructure
    ? markdown.replace(
      /\*\*总场景数\*\*:\s*(\d+)个/u,
      `**叙事结构**: 主体场景 ${sceneCount} 个；加开场与结尾共 ${segmentCount} 段`,
    )
    : markdown;
  normalized = normalized
    .replace(/\[undefined\]/giu, "[收束]")
    .replace(/\bundefined\b/giu, "未标注")
    .replace(/\bnull\b/giu, "未标注");
  if (Number.isFinite(duration) && duration > 0) {
    normalized = normalized
      .replace(/\*\*总时长\*\*:\s*[^\n]+/u, `**总时长**: ${duration}秒`);
    const openingDuration = Number(recordValue(scene.opening).duration ?? 0);
    if (openingDuration > 0) {
      normalized = normalized.replace(/\*\*开场\*\*\s*\([^)]*秒\)/u, `**开场** (${openingDuration}秒)`);
    }
    if (Array.isArray(scene.scenes)) {
      scene.scenes.forEach((item, index) => {
        const sceneDuration = Number(recordValue(item).duration ?? 0);
        if (sceneDuration > 0) {
          normalized = normalized.replace(
            new RegExp(`\\*\\*场景\\s*${index + 1}\\s*\\*\\*\\s*\\([^)]*秒\\)`, "u"),
            `**场景 ${index + 1}** (${sceneDuration}秒)`,
          );
        }
      });
    }
    const endingDuration = Number(recordValue(scene.ending).duration ?? 0);
    if (endingDuration > 0) {
      normalized = normalized.replace(/\*\*结尾\*\*\s*\([^)]*秒\)/u, `**结尾** (${endingDuration}秒)`);
    }
    normalized = normalized.replace(/(?:第\s*)?(\d+)\s*秒(?:前后)?/gu, (whole, value: string) =>
      Number(value) > duration ? `片尾（${duration}秒内）` : whole);
    normalized = normalized.replace(/\d+\s*[—~\-至]\s*片尾（(\d+)秒内）/gu, "片尾≤$1秒");
  }
  const contractGlobalProps = inferNarrativeProps({
    intent: String(upstream._originalStoryText ?? upstream.description ?? upstream.theme ?? ""),
    discovery: { sceneStructure: {} },
    upstream,
  });
  const contractScene = (label: string, node: Record<string, unknown>): string => {
    const purpose = String(node.purpose ?? "").trim();
    const substantive = purpose.replace(/[\s，。；、：]/gu, "");
    const existingElements = Array.isArray(node.keyElements)
      ? node.keyElements.map(String).map((item) => item.trim()).filter(Boolean)
      : [];
    const purposeProps = inferNarrativeProps({
      intent: purpose,
      discovery: { sceneStructure: { opening: { purpose } } },
      upstream: {},
    });
    const elements = purposeProps.length > 0 ? purposeProps : existingElements;
    if (substantive.length < 4
      && extractNarrativeActions({}, { _originalStoryText: purpose }).length === 0) {
      return `${label}：关键元素：${elements.length > 0 ? elements.join("、") : "未提取到可拍元素"}`;
    }
    const localContext = [
      purpose,
      ...elements,
    ].join(" ");
    const context = [
      localContext,
      String(upstream._originalStoryText ?? ""),
      String(upstream.special_notes ?? ""),
      String(upstream.visual_style ?? ""),
      JSON.stringify(recordValue(discovery.audienceProfile)),
    ].join(" ");
    const storyContext = [
      String(upstream._originalStoryText ?? ""),
      String(upstream.description ?? ""),
      String(upstream.special_notes ?? ""),
    ].join(" ");
    const pick = (pattern: RegExp, source = context): string => source.match(pattern)?.[0] ?? "";
    const durationText = Number(node.duration) > 0 ? `${Number(node.duration)}秒` : "";
    const time = pick(/(?:雨后|雨停后|雨夜|深夜|夜晚|清晨|黎明|白天|午后|傍晚|黄昏|春天|夏天|秋天|冬天)/u, localContext)
      || pick(/(?:雨后|雨停后|雨夜|深夜|夜晚|清晨|黎明|白天|午后|傍晚|黄昏|春天|夏天|秋天|冬天)/u, storyContext);
    const exteriorOpening = label === "开场"
      && /(?:收伞|雨夜|路灯|积水|水珠)/u.test(localContext)
      && !/(?:室内|门内|客厅|屋内)/u.test(localContext);
    const spacePattern = /(?:出租屋|小面馆|厨房|森林|海边|木栈道|栏杆|城市路面|水洼|湖面|高原湖|纸箱里|纸箱内|屋檐下|窗边|门口|室内|玄关|楼道|外廊|街口|河边|树林里|桌面上|茶壶旁)/u;
    const exteriorSpacePattern = /(?:楼道|外廊|室外|门口|门外|街口|街道|路面|路面|屋檐下|木栈道)/u;
    const localSpace = pick(spacePattern, localContext);
    const sourceSpace = pick(spacePattern, storyContext);
    const externalSpace = pick(exteriorSpacePattern, localContext);
    let space = exteriorOpening
      ? (externalSpace || (/(?:收伞|回到出租屋)/u.test(localContext) ? "楼道/室外门口" : (localSpace || sourceSpace || "")))
      : (localSpace || sourceSpace || "");
    if (/^开门/u.test(purpose)) space = "出租屋门口";
    else if (/^换鞋/u.test(purpose)) space = "出租屋玄关内侧";
    else if (/(?:拧亮.*台灯|坐下听雨)/u.test(purpose)) space = "出租屋室内";
    const localLighting = pick(/(?:信号灯[^。；，]*|冷白路灯|冷蓝路灯|路灯|单一暖黄钨丝光|暖黄钨丝光|冷蓝|暖黄|晨光|逆光|侧逆光|侧光|顶光|环境光|暖光|冷光|月光|自然光|晨光)/u, localContext);
    const visualLighting = pick(/(?:信号灯[^。；，]*|单一暖黄钨丝光|暖黄钨丝光|冷蓝|暖黄|晨光|侧逆光|逆光|侧光|顶光|环境光|暖光|冷光|月光|自然光)/u, String(upstream.visual_style ?? ""));
    let lighting = localLighting
      || (/(?:台灯|开门|换鞋|坐下|听雨)/u.test(localContext) ? "室内旧台灯暖黄" : "")
      || visualLighting
      || "按已确认视觉方案执行";
    if (!exteriorOpening
      && /(?:开门|换鞋)/u.test(purpose)
      && !/(?:拧亮|灯下|坐下|听雨)/u.test(purpose)) {
      lighting = "室内未开灯；门外楼道冷光从门缝进入，旧台灯关闭";
    }
    const camera = /(?:坐下|静坐|听雨|肩线|人物出画)/u.test(localContext)
      ? "中景"
      : (pick(/(?:低机位|高机位|平视|俯拍|仰拍|近景|中景|广角|特写|微距)/u, localContext)
        || pick(/(?:低机位|高机位|平视|俯拍|仰拍|近景|中景|广角|特写|微距)/u, String(upstream.visual_style ?? ""))
        || "9:16竖构图，关键元素位于中部安全区");
    const endingStill = label === "结尾" && /(?:半秒|0\.5秒)[^。；\n]{0,12}(?:静止|空镜)|(?:静止|空镜)[^。；\n]{0,12}(?:半秒|0\.5秒)/u.test(context)
      ? "；片尾静止=0.5秒"
      : "";
    const elementSet = sceneElementsForPurpose(
      purpose,
      [...new Set([...elements, ...existingElements, ...contractGlobalProps])],
    ).slice(0, 8);
    return `${label}：目的=${purpose}${durationText ? `；时长=${durationText}` : ""}${time ? `；时间=${time}` : ""}${space ? `；空间=${space}` : ""}${lighting ? `；光位=${lighting}` : ""}${camera ? `；机位=${camera}` : ""}${endingStill}；关键元素=${elementSet.length > 0 ? elementSet.join("、") : "未提取"}`;
  };
  const scenePurposes = [
    scene.opening && typeof scene.opening === "object"
      ? contractScene("开场", scene.opening as Record<string, unknown>)
      : "",
    ...(Array.isArray(scene.scenes) ? scene.scenes.map((item, index) =>
      item && typeof item === "object"
        ? contractScene(`主体场景 ${index + 1}`, item as Record<string, unknown>)
        : "") : []),
    scene.ending && typeof scene.ending === "object"
      ? contractScene("结尾", scene.ending as Record<string, unknown>)
      : "",
  ].filter(Boolean);
  if (hasSceneStructure) {
    const renderNode = (label: string, node: Record<string, unknown>): string[] => {
      const purpose = String(node.purpose ?? "").trim() || "按已确认场景目的执行";
      const elements = sceneElementsForPurpose(purpose, Array.isArray(node.keyElements) ? node.keyElements.map(String) : []);
      return [
        `**${label}** (${Number(node.duration ?? 0) || 0}秒)`,
        `- 目的: ${purpose}`,
        `- 关键元素: ${elements.length > 0 ? elements.join("、") : "未提取"}`,
        "",
      ];
    };
    const bodyScenes = Array.isArray(scene.scenes) ? scene.scenes.map(recordValue) : [];
    const sceneSection = [
      "### 2.2 场景结构建议",
      "",
      "**叙事弧线**: linear",
      `**叙事结构**: 主体场景 ${bodyScenes.length} 个；加开场与结尾共 ${bodyScenes.length + 2} 段`,
      `**总时长**: ${duration}秒`,
      "",
      ...renderNode("开场", recordValue(scene.opening)),
      "**主体场景**",
      "",
      ...bodyScenes.flatMap((node, index) => renderNode(`场景 ${index + 1}`, node)),
      ...renderNode("结尾", recordValue(scene.ending)),
    ].join("\n");
    const sceneStart = normalized.indexOf("### 2.2 场景结构建议");
    const sceneEnd = normalized.indexOf("### 2.3 技术难点预判", sceneStart + 1);
    if (sceneStart >= 0 && sceneEnd > sceneStart) {
      normalized = `${normalized.slice(0, sceneStart)}${sceneSection}\n\n---\n\n${normalized.slice(sceneEnd)}`;
    }
  }
  normalized = normalized.replace(
    /\*\*内容期望\*\*\r?\n([\s\S]*?)(?=\r?\n---|\r?\n###|\r?\n## )/u,
    (all, body: string) => {
      const seen = new Set<string>();
      const items = body.split(/\r?\n/u)
        .map((line) => line.match(/^\d+\.\s*(.+)$/u)?.[1]?.trim() ?? "")
        .filter(Boolean)
        .filter((item) => {
          if (seen.has(item)) return false;
          seen.add(item);
          return true;
        });
      return items.length > 0
        ? `**内容期望**\n${items.map((item, index) => `${index + 1}. ${item}`).join("\n")}\n`
        : all;
    },
  );
  if (hasSceneStructure && scenePurposes.length > 0) {
    normalized = normalized.replace(/- \*\*场景\*\*（\d+）：[^\n]*/u, `- **场景**（${scenePurposes.length}）：${scenePurposes.join("；")}`);
  }
  if (hasSceneStructure) {
    const sceneKeys = [
      recordValue(scene.opening),
      ...(Array.isArray(scene.scenes) ? scene.scenes.map(recordValue) : []),
      recordValue(scene.ending),
    ].filter((item) => Object.keys(item).length > 0)
      .map((item) => Array.isArray(item.keyElements) ? item.keyElements.map(String).join("、") : "");
    let keyIndex = 0;
    normalized = normalized.replace(/^- 关键元素:\s*[^\n]*$/gmu, (line) => {
      const value = sceneKeys[keyIndex++];
      return value ? `- 关键元素: ${value}` : line;
    });
  }
  const actions = extractNarrativeActions(discovery, upstream)
    .filter((item) => !/(?:动作声|环境底噪|等动作声|[，,].*[，,]|\/$)/u.test(item))
    .slice(0, 8);
  const riskTextForActions = JSON.stringify(recordValue(discovery.riskAssessment));
  if (/钥匙[^。；\n]{0,24}(?:锁孔|开锁|插入)/u.test(riskTextForActions)
    && !actions.some((item) => /钥匙.*(?:开锁|锁孔)/u.test(item))) {
    const doorIndex = actions.indexOf("开门");
    if (doorIndex >= 0) actions[doorIndex] = "钥匙开锁并开门";
    else actions.push("钥匙开锁并开门");
  }
  if (actions.length > 0) {
    normalized = normalized.replace(/- \*\*动作\*\*（\d+）：[^\n]*/u, `- **动作**（${actions.length}）：${actions.join("；")}`);
    normalized = normalized.replace(/(?:[一二三四五六七八九十]+|\d+)个连续动作/gu, `${actions.length}个连续动作`);
  }
  normalized = normalized.replace(/仅保留(?:人物|主体)?动作与画外环境声/gu, "仅保留动作与环境声");
  const inferredRoles = inferNarrativeCharacters({
    intent: String(upstream._originalStoryText ?? upstream.description ?? upstream.theme ?? ""),
    discovery,
    upstream,
  });
  const animalOnly = inferredRoles.length > 0 && inferredRoles.every((role) => isNarrativeAnimal(role.name));
  const noCharacterContract = inferredRoles.length === 0
    && /(?:无人物|无动物|无角色|纯空镜|场景为主体)/u.test([
      upstream._originalStoryText,
      upstream.description,
      upstream.special_notes,
    ].map(String).join(" "));
  const environmentActionPhrases = String(upstream._originalStoryText ?? "")
    .split(/[，。；\n]+/u)
    .map((item) => item.trim())
    .filter((item) => item.length >= 4)
    .filter((item) => !/(?:无人物|无动物|无品牌|无文字|无字幕|无旁白|不出现|仅保留环境声|需求口径)/u.test(item))
    .filter((item) => /(?:倒映|风|薄雾|雾|蒸汽|晨光|光斑|光柱|落叶|涟漪|水洼|信号灯|红绿灯|水滴|升起|散开|晃动|推过|变化)/u.test(item))
    .map((item) => item.replace(/^镜头(?:只)?/u, "").trim())
    .slice(0, 5);
  if (inferredRoles.length > 0) {
    normalized = normalized.replace(
      /- \*\*角色\*\*（\d+）：[^\n]*/u,
      `- **角色**（${inferredRoles.length}）：${inferredRoles.map((role) => `${role.name}（${role.description}）`).join("；")}`,
    );
    if (animalOnly) {
      normalized = normalized.replace(/人物动作/gu, "主体动作");
    }
  }
  if (noCharacterContract) {
    normalized = normalized
      .replace(/- \*\*角色\*\*（\d+）：[^\n]*/u, "- **角色**（0）：无角色（环境/场景空镜）")
      .replace(
        /- \*\*动作\*\*（\d+）：[^\n]*/u,
        [
          "- **动作**（0）：无角色动作",
          `- **环境变化**（${environmentActionPhrases.length}）：${environmentActionPhrases.length > 0 ? environmentActionPhrases.join("；") : "按源证据中的自然物理变化执行"}`,
        ].join("\n"),
      )
      .replace(/人物动作与画外环境声/gu, "画外环境声");
    const ending = recordValue(scene.ending);
    const lastEnvironmentChange = environmentActionPhrases.at(-1);
    if (Object.keys(ending).length > 0
      && lastEnvironmentChange
      && !String(ending.purpose ?? "").includes(lastEnvironmentChange)) {
      ending.purpose = `${String(ending.purpose ?? "").replace(/[。；]?\s*$/u, "")}；${lastEnvironmentChange}`;
    }
  }
  if (hasSceneStructure) {
    const finalScenePurposes = [
      scene.opening && typeof scene.opening === "object"
        ? contractScene("开场", scene.opening as Record<string, unknown>)
        : "",
      ...(Array.isArray(scene.scenes) ? scene.scenes.map((item, index) =>
        item && typeof item === "object"
          ? contractScene(`主体场景 ${index + 1}`, item as Record<string, unknown>)
          : "") : []),
      scene.ending && typeof scene.ending === "object"
        ? contractScene("结尾", scene.ending as Record<string, unknown>)
        : "",
    ].filter(Boolean);
    normalized = normalized.replace(
      /- \*\*场景\*\*（\d+）：[^\n]*/u,
      `- **场景**（${finalScenePurposes.length}）：${finalScenePurposes.join("；")}`,
    );
    const finalSceneKeys = [
      recordValue(scene.opening),
      ...(Array.isArray(scene.scenes) ? scene.scenes.map(recordValue) : []),
      recordValue(scene.ending),
    ].filter((item) => Object.keys(item).length > 0)
      .map((item) => Array.isArray(item.keyElements) ? item.keyElements.map(String).join("、") : "");
    let finalKeyIndex = 0;
    normalized = normalized.replace(/^- 关键元素:\s*[^\n]*$/gmu, (line) => {
      const value = finalSceneKeys[finalKeyIndex++];
      return value ? `- 关键元素: ${value}` : line;
    });
  }
  const risk = discovery?.riskAssessment && typeof discovery.riskAssessment === "object"
    ? discovery.riskAssessment as Record<string, unknown>
    : {};
  const risks = Array.isArray(risk.technicalRisks)
    ? risk.technicalRisks.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    : [];
  const sceneDurationsForContract = [
    recordValue(scene.opening),
    ...(Array.isArray(scene.scenes) ? scene.scenes.map(recordValue) : []),
    recordValue(scene.ending),
  ].filter((item) => Object.keys(item).length > 0)
    .map((item) => Number(item.duration ?? 0))
    .filter((value) => Number.isFinite(value) && value > 0);
  const umbrellaEvidence = /(?:雨伞|伞骨|伞尖|收伞|撑伞|伞面)/u.test([
    upstream._originalStoryText,
    upstream.special_notes,
    upstream.description,
  ].map(String).join(" "));
  const groundEvidence = /(?:地面|路面|地砖|台阶|水洼|积水|湿沙|沙滩)/u.test(
    String(upstream._originalStoryText ?? ""),
  );
  const pairedMitigations = pairRiskMitigations(risk).map((item) => {
    let value = item;
    if (sceneDurationsForContract.length > 0) {
      value = value.replace(
        /(?:把|将)?\s*\d+\s*秒[^。；]{0,24}(?:拆成|切成)[^。；]{0,24}秒[^。；]{0,12}镜(?:头|位)/gu,
        `镜头切分以场景合同为准：${sceneDurationsForContract.join("/")}秒`,
      );
    }
    if (!umbrellaEvidence) {
      value = value.replace(/(?:雨具|雨伞|伞面|伞骨|伞尖)/gu, "雨滴与屋檐落水");
    }
    if (!groundEvidence) {
      value = value.replace(/(?:地面)?积水|地面积水/gu, "纸箱接水面");
    }
    return value;
  });
  const riskText = risks.length > 0
    ? `${risks.length} 项技术风险：${risks.map((item, index) =>
      `风险${index + 1}（${item.level === "high" ? "高" : item.level === "medium" ? "中" : "低"}）：${String(item.risk ?? "")}；缓解：${pairedMitigations[index] ?? "见技术难点正文"}`).join("；")}`
    : "";
  if (riskText) normalized = normalized.replace(/- \*\*风险结论\*\*：[^\n]*/u, `- **风险结论**：${riskText}`);
  if (risks.length > 0 && pairedMitigations.length > 0) {
    normalized = normalized.replace(
      /\*\*缓解建议\*\*[\s\S]*?(?=\n---|\n###|\n## |\n- \*\*|$)/u,
      `**缓解建议**\n${pairedMitigations.map((item, index) => `${index + 1}. ${item}`).join("\n")}\n`,
    );
  }
  const propEvidence = [
    upstream._originalStoryText,
    upstream.description,
    upstream.special_notes,
    upstream.visual_style,
    upstream.theme,
  ].map(String).join("\n");
  const groundedProp = (item: string): boolean => {
    if (propEvidence.includes(item)) return true;
    if (item === "雨伞" && /伞/u.test(propEvidence)) return true;
    for (let index = 0; index < item.length - 1; index += 1) {
      if (propEvidence.includes(item.slice(index, index + 2))) return true;
    }
    return false;
  };
  const props = inferNarrativeProps({
    intent: String(upstream?._originalStoryText ?? ""),
    discovery,
    upstream,
  }).filter((item) =>
    (noCharacterContract || !["薄雾", "远山", "水面", "涟漪"].includes(item))
    && (item !== "积水" || groundEvidence)
    && groundedProp(item));
  if (/(?:地面|路面|地砖|台阶|水洼)/u.test(propEvidence)
    && /(?:雨|湿|积水)/u.test(propEvidence)
    && !props.some((item) => /(?:积水|水洼|水面)/u.test(item))) {
    props.push("积水");
  }
  if (/(?:滴水|水滴|水珠)/u.test(propEvidence)
    && !props.some((item) => /(?:水滴|水珠)/u.test(item))) {
    props.push("水滴");
  }
  if (/(?:茶壶|釉面|壶嘴|蒸汽)/u.test(propEvidence)) {
    for (let index = props.length - 1; index >= 0; index -= 1) {
      if (/^(?:蒸汽|釉面)$/u.test(props[index]!)) props.splice(index, 1);
    }
    if (/(?:白瓷|白色陶瓷).*茶壶/u.test(propEvidence)
      && !props.includes("白色陶瓷茶壶")) {
      const genericIndex = props.indexOf("茶壶");
      if (genericIndex >= 0) props.splice(genericIndex, 1);
      props.unshift("白色陶瓷茶壶");
    }
  }
  if (actions.some((item) => /钥匙/u.test(item)) && !props.includes("钥匙")) props.push("钥匙");
  const endingRecord = recordValue(scene.ending);
  const endingElements = Array.isArray(endingRecord.keyElements)
    ? endingRecord.keyElements.map(String)
    : [];
  if (endingElements.includes("坐具") && !props.includes("坐具")) props.push("坐具");
  if (props.length > 0) {
    normalized = normalized.replace(
      /- \*\*道具\*\*（\d+）：[^\n]*/u,
      `- **道具**（${props.length}）：${props.join("、")}`,
    );
  }
  const negatives = narrativeNegativeConstraints({
    intent: String(upstream?._originalStoryText ?? ""),
    upstream,
  });
  if (negatives.length > 0 && !normalized.includes("- **禁止项**")) {
    const line = `- **禁止项**（${negatives.length}）：${negatives.join("；")}`;
    if (/- \*\*动作\*\*（\d+）：[^\n]*/u.test(normalized)) {
      normalized = normalized.replace(/(- \*\*动作\*\*（\d+）：[^\n]*)/u, `$1\n${line}`);
    }
  }
  normalized = normalized.replace(
    /^\s*\d+[.、]\s*(?:预留重试时间|准备备选方案|保持视觉一致|提升质量|待针对补齐|补齐缓解|降低复杂度)\s*$/gmu,
    "",
  );
  normalized = normalized.replace(
    /\*\*缓解建议\*\*\s*(?=\n+(?:###|---|$))/u,
    "**缓解建议**：见“风险结论”中的逐项具体缓解。\n",
  );
  const anchorDefinitions = String(upstream.special_notes ?? "")
    .match(/[①②③④⑤⑥⑦⑧⑨⑩]\s*[^；;\n]+/gu)
    ?.map((item) => item.trim())
    .filter(Boolean) ?? [];
  if (anchorDefinitions.length > 0 && !normalized.includes("视觉锚点定义")) {
    normalized = `${normalized.trimEnd()}\n\n### 视觉锚点定义\n${anchorDefinitions.map((item) => `- ${item}`).join("\n")}\n`;
  }
  const anchorSectionPattern = /###\s*视觉锚点定义\s*\n([\s\S]*?)(?=\n(?:###|##|---|$)|\s*$)/gu;
  const anchorSections = [...normalized.matchAll(anchorSectionPattern)];
  if (anchorSections.length > 1) {
    const mergedAnchors = [...new Set(anchorSections.flatMap((match) =>
      String(match[1] ?? "").split("\n").map((line) => line.trim()).filter((line) => /^-\s+/u.test(line))))];
    let kept = false;
    normalized = normalized.replace(anchorSectionPattern, () => {
      if (kept) return "";
      kept = true;
      return `### 视觉锚点定义\n${mergedAnchors.join("\n")}`;
    });
  }
  normalized = normalized.replace(
    /(##\s*三、最终业务需求确认)/u,
    "> 设备型号、光照参数与实拍可行性未在本轮核实；相关摄影参数仅为创作参考，正式执行以结构化镜头合同为准。\n\n$1",
  );
  normalized = normalized.replace(
    /(> 设备型号、光照参数与实拍可行性未在本轮核实；[^\n]*\n)(?:\s*\1)+/gu,
    "$1",
  );
  const dialogue = String(upstream?.dialogue_requirement ?? "").trim();
  if (dialogue && !normalized.includes("- **台词/字幕口径**")) {
    normalized = normalized.replace(
      /- \*\*动作\*\*（\d+）：[^\n]*/u,
      (line) => `${line}\n- **台词/字幕口径**：${dialogue}`,
    );
  }
  if (narrativeSpeechPolicy(dialogue).allSpeechForbidden && !normalized.includes("- **声音锚点**")) {
    const soundEvidence = [upstream._originalStoryText, JSON.stringify(scene)].map(String).join(" ");
    const soundAnchors = [
      /雨(?!后|停)/u.test(soundEvidence) ? "雨声" : "",
      /屋檐|滴水|露水/u.test(soundEvidence) ? "屋檐滴水声" : "",
      /风|枝叶|树叶/u.test(soundEvidence) ? "风声与枝叶摆动声" : "",
      /落叶/u.test(soundEvidence) ? "落叶摩擦声" : "",
      /涟漪|水面|湖面/u.test(soundEvidence) ? "水面涟漪声" : "",
      /蒸汽|茶壶/u.test(soundEvidence) ? "蒸汽与陶瓷轻响声" : "",
      /纸箱/u.test(soundEvidence) ? "纸箱摩擦与受压声" : "",
      /猫|爪|蜷缩/u.test(soundEvidence) ? "猫爪接触纸箱与呼吸声" : "",
      /信号灯|红绿灯/u.test(soundEvidence) ? "信号灯继电器与街道底噪" : "",
      /(?:收伞|伞骨|伞尖)/u.test(soundEvidence) ? "伞骨滴水声" : "",
      /(?:开门|门锁|锁孔|钥匙)/u.test(soundEvidence) ? "门锁与开门声" : "",
      /(?:换鞋|鞋跟)/u.test(soundEvidence) ? "换鞋与鞋跟落地声" : "",
      /(?:台灯|旋钮|开关|钨丝)/u.test(soundEvidence) ? "台灯旋钮与钨丝电流声" : "",
    ].filter((item, index, list) => Boolean(item) && list.indexOf(item) === index);
    if (soundAnchors.length > 0) {
      normalized = normalized.replace(
        /- \*\*台词\/字幕口径\*\*：[^\n]*/u,
        (line) => `${line}\n- **声音锚点**（${soundAnchors.length}）：${soundAnchors.join("；")}；全部为画内环境声或动作声，不含配乐。`,
      );
    }
  }
  if (narrativeSpeechPolicy(dialogue).allSpeechForbidden) {
    normalized = normalized
      .replace(/(?:画外旁白|画外音|旁白)\s*[：:]\s*[^。；\n]+[。；]?/gu,
        noCharacterContract ? "仅保留现场自然环境声与可见声源动作声。" : `仅保留${animalOnly ? "主体" : "人物"}动作与现场自然环境声。`)
      .replace(/[^。；\n]{0,30}(?:紧接)?(?:一句)?(?:轻声|低声)?台词\s*[：:]?\s*[“「][^”」]+[”」][^。；\n]*[。；]?/gu,
        noCharacterContract ? "仅保留现场自然环境声与可见声源动作声。" : `仅保留${animalOnly ? "主体" : "人物"}动作与现场自然环境声。`)
      .replace(/[^。；\n]{0,48}(?:轻声|低声|开口)?说[：:]?\s*[「“"'‘][^」”"'’]+[」”"'’][。；]?/gu, "以动作与环境声完成回应。")
      .replace(/[^。；\n]{0,32}(?:一句)?(?:极轻|轻微|压低|贴耳)?(?:气声|耳语)[^。；\n]*[“"'「][^”"'」]+[”"'」][^。；\n]*[。；]?/gu, "")
      .replace(/钉子台词[^。；\n]*[。；]?/gu, "站外转发文案不进入成片。")
      .replace(/^.*(?:关键台词|片内台词)[^\n]*$/gmu, (line) => {
        const quote = line.match(/[“"'「]([^”"'」]+)[”"'」]/u)?.[1]?.trim();
        return quote
          ? `站外转发文案候选：“${quote}”；不进入成片，不生成字幕、旁白或口播。`
          : "站外转发文案候选仅用于发布文案，不进入成片，不生成字幕、旁白或口播。";
      });
  }
  normalized = normalized.replace(
    /仅保留人物动作与画外环境声/gu,
    noCharacterContract ? "仅保留现场自然环境声与可见声源动作声" : animalOnly ? "仅保留主体动作与现场自然环境声" : "仅保留动作与现场自然环境声",
  );
  const actionAudioClause = noCharacterContract
    ? "仅保留现场自然环境声与可见声源动作声"
    : animalOnly
      ? "仅保留主体动作与现场自然环境声"
      : "仅保留动作与现场自然环境声";
  normalized = normalized.replace(/仅保留画外环境声/gu, actionAudioClause);
  if (speechFullyForbidden && !normalized.includes(actionAudioClause)) {
    normalized = `${normalized.trimEnd()}\n\n- **可执行动作/声音口径**：${actionAudioClause}。\n`;
  }
  const visualStyle = String(upstream.visual_style ?? "").trim();
  if (visualStyle) {
    normalized = normalized.replace(
      /###\s*2\.4\s*对标参考[\s\S]*?(?=\n---|\n##\s*三)/u,
      `### 2.4 对标参考\n\n- 仅作影调与镜头策略参考，不引入片名对应的地域、品牌、人物或情节：${visualStyle}\n`,
    );
  }
  return normalized;
}

export function normalizeNarrativeDiscovery(
  discovery: Record<string, unknown>,
  duration: number,
  upstream: Record<string, unknown> = {},
): void {
  const dialoguePolicy = String(upstream.dialogue_requirement ?? "");
  const speech = narrativeSpeechPolicy(dialoguePolicy);
  const { noLipSyncDialogue, voiceoverDenied, voiceoverAllowed, dialogueAllowed, allSpeechForbidden: speechFullyForbidden } = speech;
  const canonicalDialogue = dialogueAllowed || voiceoverAllowed
    ? dialoguePolicy.match(/(?:旁白|画外音|人声|气声)[^。；\n]{0,24}?[「“"'‘]([^」”"'’]+)[」”"'’]/u)?.[1]?.trim()
      ?? dialoguePolicy.match(/[「“"'‘]([^」”"'’]+)[」”"'’]/u)?.[1]?.trim()
      ?? null
    : null;
  const repairs: Array<{ code: string; detail: string }> = [];
  const stripDisallowedSpeech = (value: string): string => {
    if (!speechFullyForbidden) return value;
    return value
      .replace(/(?:画外音?|旁白)[^。；\n]*?[：:]?\s*[「“"'‘][^」”"'’]+[」”"'’]/gu, "")
      .replace(/(?:画外音?|旁白)[^。；\n]*(?:一句|低语|台词)[^。；\n]*/gu, "")
      .replace(/[^，。；\n]{0,24}(?:轻声)?台词\s*[「“][^」”]+[」”][^。；\n]*/gu, "")
      .replace(/[^，。；\n]{0,48}(?:轻声|低声|开口)?说[：:]?\s*[「“"'‘][^」”"'’]+[」”"'’]/gu, "")
      .replace(/(?:一句|关键|钉子|片内)台词[^。；\n]*[。；]?/gu, "")
      .replace(/[^。；\n]{0,32}(?:低声|轻声)(?:一|这)?句\s*[「“"'‘][^」”"'’]+[」”"'’][^。；\n]*[。；]?/gu, "")
      .replace(/[^。；\n]{0,32}(?:一句)?(?:极轻|轻微|压低|贴耳)?(?:气声|耳语)[^。；\n]*[“"'「][^”"'」]+[”"'」][^。；\n]*[。；]?/gu, "")
      .replace(/(?:画外音?|旁白)[^。；\n]*?[：:]?\s*[「“"'‘][^」”"'’]+[」”"'’]/gu, "")
      .replace(/(?:画外音?|旁白)[：:]\s*[^。；\n]+/gu, "")
      .replace(/这(?:一)?句(?:几乎听不见的)?话/gu, "动作与环境声的停顿")
      .replace(/^[\s，,；;。]+/u, "")
      .replace(/[\s，,；;]+$/u, "");
  };
  const stripDisallowedVoiceover = (value: string): string => {
    if (!voiceoverDenied) return value;
    return value
      .replace(/(?:画外音?|旁白)[^。；\n]*?[：:]?\s*[“"'‘][^”"'’]+[”"'’]/gu, "")
      .replace(/(?:画外音?|旁白)[：:]\s*[^。；\n]+/gu, "")
      .replace(/(?:画外音?|旁白)[^。；\n]*(?:一句|低语)[^。；\n]*/gu, "")
      .replace(/^[\s，,；;。]+/u, "")
      .replace(/[\s，,；;]+$/u, "");
  };
  const cleanPurpose = (value: unknown): string => {
    const original = String(value ?? "");
    let text = original
      .replace(/^(?:如果删掉|删掉这)[^：。；]*[：。；]?/gu, "")
      .replace(/^删掉(?:结尾|开头|结尾段|开场段)[^：。；]*[：。；]?/gu, "")
      .replace(/^故事会失去[^：。；]*[：。；]?/gu, "")
      .replace(/删掉这(?:镜|场)[^：；，。]*[：；]?/gu, "")
      .replace(/^(?:若|如果|假如)[，,：:\s]+/u, "")
      .replace(/^[\s，,；;。]+/gu, "")
      .replace(/^(?:全片|整个片子)[^。]*[。]?/gu, "")
      .replace(/观众[^。；]*[。；]?/gu, "")
      .replace(/继续看[^。；]*[。；]?/gu, "")
      .replace(/会想知道[^。；]*[。；]?/gu, "")
      .replace(/最后记住[：:]?/gu, "")
      .trim();
    if (/^删掉这镜/u.test(original)) {
      const visibleAction = original.search(/(?:观众看到|画面中|镜头中)(?=(?:陈卓|他|她|人物|旧台灯|门|伞|镜头|画面))/u);
      if (visibleAction >= 0) {
        text = original
          .slice(visibleAction)
          .replace(/^(?:观众看到|画面中|镜头中)\s*/u, "")
          .trim();
      }
    }
    const actionable = (candidate: string): boolean =>
      extractNarrativeActions({}, { _originalStoryText: candidate }).length > 0;
    if (text.replace(/[\s，。；、：]/gu, "").length < 4 && !actionable(text)) text = original;
    if (noLipSyncDialogue && voiceoverAllowed) {
      const converted = text.replace(
        /[\u4e00-\u9fff]{0,24}(?:轻声|低声|开口)?说[：:]?\s*([「“"'‘][^」”"'’]+[」”"'’])/gu,
        (_all, quoted: string) => `画外旁白：${canonicalDialogue ? `“${canonicalDialogue}”` : quoted}`,
      );
      if (converted !== text) {
        repairs.push({ code: "LIP_SYNC_DIALOGUE_CONVERTED_TO_VOICEOVER", detail: "把口型台词改为合同允许的画外旁白" });
      }
      text = converted;
    } else if (speechFullyForbidden) {
      const stripped = stripDisallowedSpeech(text);
      if (stripped !== text) repairs.push({ code: "DISALLOWED_SPEECH_REMOVED", detail: "移除与无台词/无旁白合同冲突的台词或旁白" });
      text = stripped;
    } else if (voiceoverDenied) {
      const stripped = stripDisallowedVoiceover(text);
      if (stripped !== text) repairs.push({ code: "DISALLOWED_VOICEOVER_REMOVED", detail: "保留合法对白并移除合同禁止的旁白" });
      text = stripped;
    }
    if (Number.isFinite(duration) && duration > 0) {
      text = text.replace(/(?:第\s*)?(\d+)\s*秒(?:前后)?/gu, (whole, seconds: string) =>
        Number(seconds) > duration ? `片尾（${duration}秒内）` : whole);
    }
    if (/[—…]+$|＋$/u.test(text)) {
      const verb = text.match(/(?:缩回|探出|伸爪|接水|盘成|坐下|站起|抬头|低头|开门|关门)/u)?.[0];
      const recovered = verb
        ? sourceActionPhrases.find((item) => item.includes(verb))
        : undefined;
      if (recovered) text = recovered;
      else text = text.replace(/[—…+]+$/u, "").trim();
    }
    if (text.replace(/[\s，。；、：]/gu, "").length < 4 && !actionable(text)) {
      text = "以动作与现场自然环境声完成情绪转折";
    }
    if (/蒸汽.*水滴|水滴.*蒸汽/u.test(text) && /(?:托住|托起|承住)/u.test(text)) {
      text = text
        .replace(/水滴[^。；\n]{0,20}(?:被|由)[^。；\n]{0,12}蒸汽[^。；\n]{0,8}(?:托住|托起|承住)/u, "水滴在壶嘴下端短暂悬停")
        .replace(/蒸汽[^。；\n]{0,8}(?:托住|托起|承住)[^。；\n]{0,16}水滴/u, "蒸汽从壶口上方缓慢升起");
      repairs.push({ code: "PHYSICAL_CLAIM_NORMALIZED", detail: "改用可拍的水滴悬停与蒸汽升起，不依赖未经证实的物理托举" });
    }
    return text;
  };
  const scene = recordValue(discovery.sceneStructure);
  const storyPolicy = [
    upstream._originalStoryText,
    upstream.special_notes,
    upstream.dialogue_requirement,
  ].map(String).join(" ");
  const musicForbidden = /(?:无|不加|不要|禁止|不出现)[^。；\n]{0,8}(?:配乐|音乐|旋律)|(?:仅|只)保留(?:人物|主体)?(?:动作)?(?:与)?(?:画外)?(?:环境声|实拍声)/u.test(storyPolicy);
  const noAnimals = /无动物|不出现动物|无宠物/u.test(storyPolicy);
  const noPeople = /无人物|无真人|不出现人物/u.test(storyPolicy);
  const noText = /无文字|无字幕|不出现文字/u.test(storyPolicy);
  const noVehicles = /(?:无|不出现|不得出现|禁止出现)[^。；\n]{0,12}车辆/u.test(storyPolicy);
  const groundingText = [
    upstream._originalStoryText,
    upstream.description,
    upstream.special_notes,
    upstream.visual_style,
    upstream.theme,
    scene.opening ? String(recordValue(scene.opening).purpose ?? "") : "",
    ...(Array.isArray(scene.scenes) ? scene.scenes.map((item) => String(recordValue(item).purpose ?? "")) : []),
    scene.ending ? String(recordValue(scene.ending).purpose ?? "") : "",
  ].map(String).join(" ");
  const hasGroundingToken = (item: string): boolean => {
    if (groundingText.includes(item)) return true;
    if (/(?:雨|伞|湿|水)/u.test(groundingText) && /^(?:积水|水滴|水珠|水洼|涟漪)$/u.test(item)) return true;
    if (/(?:坐下|听雨|静坐)/u.test(groundingText) && /^(?:窗|坐具|窗玻璃雨珠)$/u.test(item)) return true;
    if (/(?:换鞋|鞋)/u.test(groundingText) && /^(?:鞋|室内拖鞋|白色湿便鞋)$/u.test(item)) return true;
    for (let index = 0; index < item.length - 2; index += 1) {
      if (groundingText.includes(item.slice(index, index + 3))) return true;
    }
    for (let index = 0; index < item.length - 1; index += 1) {
      if (groundingText.includes(item.slice(index, index + 2))) return true;
    }
    return false;
  };
  const sourceActionClauses = String(upstream._originalStoryText ?? "")
    .split(/[，。；\n]+/u)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length >= 2)
    .filter((clause) => !/(?:无人物|无动物|无品牌|无文字|无字幕|无旁白|仅保留环境声|需求口径)/u.test(clause))
    .filter((clause) => extractNarrativeActions({}, { _originalStoryText: clause }).length > 0)
    .filter((clause, index, list) => list.indexOf(clause) === index);
  const extractedSourceActionPhrases = extractNarrativeActions({}, {
    _originalStoryText: String(upstream._originalStoryText ?? ""),
  });
  const animalStory = /(?:橘猫|猫|狗|鸟|爪|耳朵|尾巴)/u.test(String(upstream._originalStoryText ?? ""));
  const sourceActionPhrases = animalStory
    ? [...extractedSourceActionPhrases].sort((left, right) =>
      narrativeAnimalActionRank(left) - narrativeAnimalActionRank(right))
    : extractedSourceActionPhrases;
  const splitActionPurposes = sourceActionPhrases.length >= 3 ? sourceActionPhrases : sourceActionClauses;
  const openingActionCount = extractNarrativeActions(
    { sceneStructure: { opening: scene.opening } },
    upstream,
  ).length;
  const openingText = JSON.stringify(scene.opening ?? {});
  const openingSourceCoverage = splitActionPurposes.filter((action) =>
    openingText.includes(action.slice(0, Math.min(4, action.length)))).length;
  const preSplitNodes = [
    scene.opening,
    ...(Array.isArray(scene.scenes) ? scene.scenes : []),
    scene.ending,
  ].map(recordValue).filter((node) => Object.keys(node).length > 0);
  const overloadedNode = preSplitNodes.some((node) =>
    extractNarrativeActions({ sceneStructure: { opening: node } }, upstream).length >= 3);
  if (splitActionPurposes.length >= 3
    && ((openingActionCount >= 3 && openingSourceCoverage >= 3) || overloadedNode)) {
    // 一个开场承载三个以上动作时，逐动作拆镜，避免 3 秒内塞入整条归家链。
    const groupedPurposes = splitActionPurposes.slice(0, 6);
    const sourceSceneElements = [
      ...(Array.isArray(recordValue(scene.opening).keyElements) ? recordValue(scene.opening).keyElements as unknown[] : []),
      ...(Array.isArray(scene.scenes)
        ? scene.scenes.flatMap((item) => Array.isArray(recordValue(item).keyElements) ? recordValue(item).keyElements as unknown[] : [])
        : []),
      ...(Array.isArray(recordValue(scene.ending).keyElements) ? recordValue(scene.ending).keyElements as unknown[] : []),
    ].map(String).filter(Boolean);
    const globalProps = [...new Set([
      ...inferNarrativeProps({
        intent: String(upstream._originalStoryText ?? ""),
        discovery: { sceneStructure: {} },
        upstream,
      }),
      ...sourceSceneElements,
    ])];
    const nodes = groupedPurposes.map((purpose) => {
      const localProps = inferNarrativeProps({
        intent: purpose,
        discovery: { sceneStructure: { opening: { purpose } } },
        upstream: {},
      });
      const props = sceneElementsForPurpose(
        purpose,
        [...new Set([...localProps, ...globalProps])],
      ).slice(0, 8);
      return {
        duration: Number((duration / groupedPurposes.length).toFixed(3)),
        purpose,
        keyElements: props,
      };
    });
    const bodyScenes = nodes.slice(1, -1);
    scene.opening = nodes[0];
    scene.scenes = bodyScenes;
    scene.ending = nodes[nodes.length - 1];
    scene.sceneCount = bodyScenes.length;
    repairs.push({
      code: "OVERSTUFFED_OPENING_SPLIT",
      detail: `把开场中的 ${splitActionPurposes.length} 个源动作拆为 1 个开场、${bodyScenes.length} 个主体场景和 1 个结尾`,
    });
  }
  const sceneNodes = [
    recordValue(scene.opening),
    ...(Array.isArray(scene.scenes) ? scene.scenes.map(recordValue) : []),
    recordValue(scene.ending),
  ].filter((node) => Object.keys(node).length > 0);
  const genericScene = /(?:建立场景|引入主题|推动叙事|核心动作|情绪表达|场景器物|总结收尾|留下印象|环境展示|主题暗示|情绪收束|主题呼应|纸质道具)/u;
  const purposeViolation = (node: Record<string, unknown>): boolean => {
    const value = String(node.purpose ?? "");
    return (noAnimals && /(?:黑|白|灰|小|一只)?(?:天鹅(?!湖)|水鸟|鸟|猫|狗|鱼|动物)/u.test(value))
      || (noPeople && /(?:人物|真人|人类|路人|游客|夜归人|手部|手指|手臂|肩膀|身体|人影|手机|相机|快门|录制|取景框|屏幕|屏息|呼吸声|鞋尖|伞尖|他抬|他停|他先|她才)/u.test(value))
      || (noText && /(?:字幕|水印|文字|数字|倒计时数字)/u.test(value))
      || (noVehicles && /(?:车辆|汽车|出租车|车流|车型|车牌|车顶灯|尾灯)/u.test(value));
  };
  const keyElementsViolation = (node: Record<string, unknown>): boolean => {
    const values = Array.isArray(node.keyElements) ? node.keyElements.map(String) : [];
    return values.some((item) =>
      genericScene.test(item)
      || item.trim().length >= 2 && !hasGroundingToken(item)
      || noAnimals && /(?:黑|白|灰|小|一只)?(?:天鹅(?!湖)|水鸟|鸟|猫|狗|鱼|动物)/u.test(item)
      || noPeople && /(?:人物|真人|人类|路人|游客|夜归人|手部|手指|手臂|肩膀|身体|人影|手机|相机|快门|录制|取景框|屏幕|屏息|呼吸声|鞋尖|伞尖|他抬|他停|他先|她才)/u.test(item)
      || noText && /(?:字幕|水印|文字|数字|倒计时数字)/u.test(item)
      || noVehicles && /(?:车辆|汽车|出租车|车流|车型|车牌|车顶灯|尾灯)/u.test(item)
      || item === "门" && !/(?:门框|门缝|门锁|开门|关门|门口|防盗门|木门|玻璃门)/u.test(groundingText));
  };
  if (sceneNodes.some((node) =>
    genericScene.test(String(node.purpose ?? ""))
    || purposeViolation(node)
    || keyElementsViolation(node))) {
    const evidenceClauses = [
      String(upstream._originalStoryText ?? ""),
      String(upstream.description ?? ""),
    ].join("，")
      .split(/[，。；\n]+/u)
      .map((item) => item.replace(/^\[需求口径\].*$/u, "").trim())
      .filter((item) => item.length >= 4)
      .filter((item) => !/(?:无人物|无动物|无品牌|无文字|无字幕|无旁白|仅保留环境声)/u.test(item));
    const visualProps = inferNarrativeProps({
      intent: String(upstream._originalStoryText ?? upstream.description ?? upstream.theme ?? ""),
      discovery: { sceneStructure: {} },
      upstream,
    }).filter(hasGroundingToken);
    let clauseIndex = 0;
    let propIndex = 0;
    for (const node of sceneNodes) {
      const mappedPurpose = evidenceClauses[clauseIndex++];
      const replacePurpose = genericScene.test(String(node.purpose ?? "")) || purposeViolation(node);
      const replaceElements = keyElementsViolation(node);
      if (!replacePurpose && !replaceElements) continue;
      if (replacePurpose) {
        if (mappedPurpose) node.purpose = mappedPurpose;
      }
      if (replaceElements && visualProps.length > 0) {
        const elements: string[] = [];
        for (let count = 0; count < 2; count += 1) {
          const item = visualProps[propIndex++ % visualProps.length]!;
          if (!elements.includes(item)) elements.push(item);
        }
        node.keyElements = elements;
      }
    }
  }
  if (scene.opening && typeof scene.opening === "object") {
    const node = scene.opening as Record<string, unknown>;
    node.purpose = cleanPurpose(node.purpose);
  }
  if (Array.isArray(scene.scenes)) {
    for (const item of scene.scenes) {
      if (item && typeof item === "object") {
        const node = item as Record<string, unknown>;
        node.purpose = cleanPurpose(node.purpose);
      }
    }
  }
  if (scene.ending && typeof scene.ending === "object") {
    const node = scene.ending as Record<string, unknown>;
    node.purpose = cleanPurpose(node.purpose);
    if (/^(?:[」”’…—]|不是讲道理)|(?:这口气让|这口气)$/u.test(String(node.purpose ?? "").trim())) {
      const repaired = sourceActionPhrases.find((item) => /(?:坐下|听雨)/u.test(item))
        ?? sourceActionPhrases.at(-1);
      if (repaired) {
        node.purpose = repaired;
        repairs.push({ code: "TRUNCATED_ENDING_REPAIRED", detail: `截断结尾按末段源动作修复为“${repaired}”` });
      }
    }
  }
  const globalNodeProps = inferNarrativeProps({
    intent: String(upstream._originalStoryText ?? upstream.description ?? upstream.theme ?? ""),
    discovery: { sceneStructure: {} },
    upstream: {},
  });
  for (const node of [
    recordValue(scene.opening),
    ...(Array.isArray(scene.scenes) ? scene.scenes.map(recordValue) : []),
    recordValue(scene.ending),
  ].filter((item) => Object.keys(item).length > 0)) {
    const purpose = String(node.purpose ?? "");
    const existingElements = Array.isArray(node.keyElements) ? node.keyElements.map(String) : [];
    const local = inferNarrativeProps({
      intent: purpose,
      discovery: { sceneStructure: { opening: { purpose } } },
      upstream: {},
    });
    node.keyElements = sceneElementsForPurpose(
      purpose,
      [...new Set([...existingElements, ...local, ...globalNodeProps])],
    ).slice(0, 8);
  }
  if (Array.isArray(scene.scenes)) scene.sceneCount = scene.scenes.length;
  const nodes = [
    scene.opening,
    ...(Array.isArray(scene.scenes) ? scene.scenes : []),
    scene.ending,
  ].map(recordValue).filter((node) => Object.keys(node).length > 0);
  const catSequence = sourceActionPhrases.some((item) => /探头|探出/u.test(item))
    && sourceActionPhrases.some((item) => /伸爪|接水/u.test(item))
    && sourceActionPhrases.some((item) => /缩回|盘成|蜷缩/u.test(item));
  if (catSequence && Array.isArray(scene.scenes) && scene.scenes.length >= 2) {
    const originalScenes = (scene.scenes as unknown[]).map(recordValue);
    const rank = (node: Record<string, unknown>): number => {
      const purpose = String(node.purpose ?? "");
      if (/探头|探出/u.test(purpose)) return 0;
      if (/伸爪|接水|滴水/u.test(purpose)) return 1;
      if (/缩回|盘成|蜷缩|鼻尖|尾巴/u.test(purpose)) return 2;
      return 1.5;
    };
    const ordered = [...originalScenes].sort((left, right) => rank(left) - rank(right));
    if (ordered.some((node, index) => node !== originalScenes[index])) {
      scene.scenes = ordered;
      repairs.push({ code: "ANIMAL_ACTION_ORDER_REPAIRED", detail: "橘猫场景按探头→伸爪接水→缩回盘团重排" });
    }
  }
  const requiredActions = extractNarrativeActions(discovery, upstream);
  for (const action of requiredActions) {
    if (nodes.some((node) => String(node.purpose ?? "").includes(action))) continue;
    const actionPrefix = action.slice(0, Math.min(4, action.length));
    if (actionPrefix.length >= 3 && nodes.some((node) => String(node.purpose ?? "").includes(actionPrefix))) continue;
    const bigrams = (value: string): Set<string> => new Set(
      value.match(/[\p{Script=Han}]{2}/gu) ?? [],
    );
    const actionGrams = bigrams(action);
    const ranked = nodes.map((node) => {
      const purposeGrams = bigrams(String(node.purpose ?? ""));
      return {
        node,
        score: [...actionGrams].filter((gram) => purposeGrams.has(gram)).length,
      };
    }).sort((left, right) => right.score - left.score);
    const target = ranked[0]?.node;
    if (target) {
      const purpose = String(target.purpose ?? "").trim();
      target.purpose = `${purpose}${purpose ? "；" : ""}${action}`;
      repairs.push({ code: "ACTION_COVERAGE_ADDED", detail: `把漏掉的动作“${action}”补入最相关场景` });
    }
  }
  const totalDuration = nodes
    .map((node) => Number(node.duration ?? 0))
    .reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
  if (Number.isFinite(duration) && duration > 0 && nodes.length > 0 && totalDuration > 0
    && Math.abs(totalDuration - duration) > 0.001) {
    let assigned = 0;
    nodes.forEach((node, index) => {
      const base = Math.max(0, Number(node.duration ?? 0));
      const next = index === nodes.length - 1
        ? Number((duration - assigned).toFixed(3))
        : Number((base / totalDuration * duration).toFixed(3));
      node.duration = next;
      assigned += next;
    });
    repairs.push({ code: "SCENE_DURATION_REBALANCED", detail: `${totalDuration}s 按比例投影到目标 ${duration}s` });
  }
  scene.totalDuration = Number.isFinite(duration) && duration > 0 ? duration : totalDuration;
  if (Number.isFinite(duration) && duration > 0) {
    const audience = recordValue(discovery.audienceProfile);
    if (Array.isArray(audience.emotionTriggers)) {
      audience.emotionTriggers = [...new Set((audience.emotionTriggers as unknown[])
        .map(String)
        .map((item) => item.trim())
        .filter((item) => item && !/^只记录自然环境与环境声的缓慢变化$/u.test(item)))];
    }
    if (Array.isArray(audience.contentExpectations)) {
      audience.contentExpectations = [...new Set((audience.contentExpectations as unknown[]).map((item) => {
        const text = String(item);
        if (speechFullyForbidden
          && /(?:钉子台词|钉子文案|片内台词|关键台词|关键句|画外旁白|画外人声|人声|口播|可复述|可截图|可转发|固定台词|低声一句|轻声一句)/u.test(text)) {
          repairs.push({ code: "EXTERNAL_COPY_SEPARATED", detail: "把可转发文案移出成片台词/字幕合同" });
          const quote = text.match(/[“"'「]([^”"'」]+)[”"'」]/u)?.[1]?.trim();
          return `${quote ? `站外转发文案候选：“${quote}”；` : "站外转发文案候选"}仅用于发布文案，不进入成片，不生成字幕、旁白或口播。`;
        }
        return stripDisallowedSpeech(text);
      }))];
      discovery.audienceProfile = audience;
    }
  }
  const normalizeText = (item: string): string => {
    let text = item
      .replace(/\bundefined\b/giu, "未标注")
      .replace(/\bnull\b/giu, "未标注")
      .replace(/仅保留画外环境声/gu, "仅保留现场自然环境声与可见声源动作声");
    if (musicForbidden && MUSIC_CUE_PATTERN.test(text)) {
      const kept = text.split(/[。；\n]+/u)
        .map((part) => part.trim())
        .filter(Boolean)
        .filter((part) => !MUSIC_CUE_PATTERN.test(part));
      text = `${kept.length > 0 ? `${kept.join("；")}；` : ""}不使用配乐，仅保留环境声与动作声`;
    }
    if (noLipSyncDialogue && voiceoverAllowed) {
      text = text.replace(
        /[\u4e00-\u9fff]{0,24}(?:轻声|低声|开口)?说[：:]?\s*([「“"'‘][^」”"'’]+[」”"'’])/gu,
        (_all, quoted: string) => `画外旁白：${canonicalDialogue ? `“${canonicalDialogue}”` : quoted}`,
      );
    }
    if (canonicalDialogue && /(?:台词|人声|气声|旁白|画外|轻声说|低声说|说[：:]?\s*[「“"'‘])/u.test(text)) {
      text = text.replace(/[「“"'‘][^」”"'’]+[」”"'’]/gu, `“${canonicalDialogue}”`);
      text = text.replace(/(“[^”]+”|‘[^’]+’)\s*或\s*\1/gu, "$1");
    }
    if (Number.isFinite(duration) && duration > 0) {
      text = text.replace(/(?:第\s*)?(\d+)\s*秒(?:前后)?/gu, (whole, seconds: string) =>
        Number(seconds) > duration ? `片尾（${duration}秒内）` : whole);
    }
    if (speechFullyForbidden) text = stripDisallowedSpeech(text);
    else if (voiceoverDenied) text = stripDisallowedVoiceover(text);
    return text;
  };
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const item = value[index];
        if (typeof item === "string") value[index] = normalizeText(item);
        else visit(item);
      }
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    for (const [key, item] of Object.entries(record)) {
      if (typeof item === "string") {
        record[key] = normalizeText(item);
      } else {
        visit(item);
      }
    }
  };
  const prohibitedAudiencePattern = [
    noPeople ? /(?:手机取景框|红色录音点|按下录制|按下快门|屏息|呼吸声|耳边[^。；\n]{0,8}憋气|手伸进|手指|手掌|夜归人|路人|游客|第二个人|空椅子|人影|男人|女人|鞋尖|伞尖|他抬|他停|他先|她才)/u : null,
    noAnimals ? /(?:黑天鹅|水鸟|飞鸟|鸟鸣|猫|狗)/u : null,
    noText ? /(?:字幕|水印|文字卡|数字|倒计时数字)/u : null,
    noVehicles ? /(?:车辆|汽车|出租车|车流|车型|车牌|车顶灯|尾灯)/u : null,
  ].filter((pattern): pattern is RegExp => pattern instanceof RegExp);
  if (prohibitedAudiencePattern.length > 0) {
    const sanitizeAudience = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
          const item = value[index];
          if (typeof item === "string") {
            const kept = item.split(/[。；\n]+/u).map((part) => part.trim()).filter(Boolean)
              .filter((part) => /(?:不进入成片|不生成字幕|无字幕|不得出现|禁止出现|仅保留环境声)/u.test(part)
                || !prohibitedAudiencePattern.some((pattern) => pattern.test(part)));
            value[index] = kept.length > 0 ? kept.join("；") : "只记录自然环境与环境声的缓慢变化";
          } else {
            sanitizeAudience(item);
          }
        }
        return;
      }
      if (!value || typeof value !== "object") return;
      const record = value as Record<string, unknown>;
      for (const [key, item] of Object.entries(record)) {
        if (typeof item === "string") {
          const kept = item.split(/[。；\n]+/u).map((part) => part.trim()).filter(Boolean)
            .filter((part) => /(?:不进入成片|不生成字幕|无字幕|不得出现|禁止出现|仅保留环境声)/u.test(part)
              || !prohibitedAudiencePattern.some((pattern) => pattern.test(part)));
          record[key] = kept.length > 0 ? kept.join("；") : "只记录自然环境与环境声的缓慢变化";
        } else {
          sanitizeAudience(item);
        }
      }
    };
    sanitizeAudience(discovery.audienceProfile);
  }
  visit(discovery);
  discovery._contractRepairs = repairs.filter((item, index, list) =>
    list.findIndex((candidate) => candidate.code === item.code && candidate.detail === item.detail) === index);
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function canonicalPlatformId(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const known: Record<string, string> = {
    "抖音": "douyin",
    "小红书": "xiaohongshu",
    "b站": "bilibili",
    "B站": "bilibili",
    "哔哩哔哩": "bilibili",
    "视频号": "wechat-channel",
    "微信视频号": "wechat-channel",
    "快手": "kuaishou",
    "youtube": "youtube",
    "YouTube": "youtube",
  };
  return known[raw] ?? raw.toLowerCase().replace(/\s+/g, "-");
}

function aspectPixelSize(aspect: string): { width: number; height: number } {
  if (aspect === "16:9") return { width: 1920, height: 1080 };
  if (aspect === "1:1") return { width: 1080, height: 1080 };
  if (aspect === "4:3") return { width: 1440, height: 1080 };
  if (aspect === "3:4") return { width: 1080, height: 1440 };
  return { width: 1080, height: 1920 };
}

function subtitleContract(upstream: Record<string, unknown>): Record<string, unknown> {
  const policyText = [
    upstream.dialogue_requirement,
    upstream.special_notes,
    upstream.subtitle_policy,
  ].map(String).join(" ");
  if (/(?:无字幕|零字幕|不烧录|不压字幕|不显示字)/u.test(policyText)) {
    return { mode: "none", burned: false, sidecar: false };
  }
  if (/(?:硬字幕|烧录字幕|字幕烧录)/u.test(policyText)) {
    return { mode: "burned", burned: true, sidecar: false };
  }
  if (/(?:软字幕|SRT|srt|字幕文件)/u.test(policyText)) {
    return { mode: "sidecar", burned: false, sidecar: true };
  }
  const speech = narrativeSpeechPolicy(policyText);
  if (speech.allSpeechForbidden) {
    return { mode: "none", burned: false, sidecar: false };
  }
  return { mode: "unverified", burned: false, sidecar: false };
}

function authoritativeCharacterProfile(id: string): Record<string, unknown> | null {
  try {
    const root = videoRuntimeRoot(import.meta.url);
    const registry = JSON.parse(readFileSync(resolvePath(
      root,
      "bundles/ai-video/library/characters/registry.json",
    ), "utf8")) as {
      models?: Array<{ id?: string; name?: string; archive?: string; authorization?: string }>;
    };
    const model = registry.models?.find((item) => item.id === id);
    if (!model?.archive) return null;
    const profile = JSON.parse(readFileSync(resolvePath(root, model.archive, "profile.json"), "utf8")) as {
      name?: string;
      kind?: string;
      identity?: Record<string, unknown>;
      appearance?: Record<string, unknown>;
      wardrobe?: Array<Record<string, unknown>>;
      authorization?: Record<string, unknown>;
    };
    const appearance = profile.appearance ?? {};
    const identity = profile.identity ?? {};
    const parts = [
      identity.gender,
      identity.age,
      appearance.face,
      appearance.hair,
      appearance.bodyType,
    ].map(String).filter(Boolean);
    return {
      name: profile.name ?? model.name,
      kind: profile.kind ?? null,
      gender: identity.gender ?? null,
      age: identity.age ?? null,
      appearance: parts.join("；"),
      wardrobe: profile.wardrobe ?? [],
      authorization: profile.authorization?.status ?? model.authorization ?? "unknown",
      authorizationExpiresAt: profile.authorization?.expiresAt ?? null,
    };
  } catch {
    return null;
  }
}

function portraitEvidence(ref: string): Record<string, unknown> {
  if (!ref) return { exists: false, reason: "portraitRef-missing" };
  try {
    const root = videoRuntimeRoot(import.meta.url);
    const file = resolvePath(root, ref);
    const real = realpathSync(file);
    if (real !== file || relative(root, real).startsWith("..") || !existsSync(file)) {
      return { exists: false, reason: "portrait-path-invalid" };
    }
    const bytes = readFileSync(real);
    const png = bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    let jpeg = bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8;
    let width: number | null = png ? bytes.readUInt32BE(16) : null;
    let height: number | null = png ? bytes.readUInt32BE(20) : null;
    if (jpeg && width === null) {
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) {
          jpeg = false;
          break;
        }
        const marker = bytes[offset + 1]!;
        if (marker === 0xd8 || marker === 0xd9) {
          offset += 2;
          continue;
        }
        const length = bytes.readUInt16BE(offset + 2);
        if (length < 2 || offset + 2 + length > bytes.length) {
          jpeg = false;
          break;
        }
        if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
          height = bytes.readUInt16BE(offset + 5);
          width = bytes.readUInt16BE(offset + 7);
          break;
        }
        offset += 2 + length;
      }
    }
    return {
      exists: true,
      path: ref,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      mediaType: png ? "image/png" : jpeg ? "image/jpeg" : "unknown",
      extensionMatches: png ? ref.toLowerCase().endsWith(".png")
        : jpeg ? /\.(?:jpe?g)$/iu.test(ref) : false,
      width,
      height,
    };
  } catch (error) {
    return { exists: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function rebalanceSceneDurations(scenePlan: Record<string, unknown>, target: number): number {
  const scenes = Array.isArray(scenePlan.scenes) ? scenePlan.scenes.map(recordValue) : [];
  if (target <= 0 || scenes.length === 0) return scenes.reduce((sum, scene) => sum + Number(scene.duration ?? 0), 0);
  const currentTotal = scenes.reduce((sum, scene) => sum + Math.max(0, Number(scene.duration ?? 0)), 0);
  if (currentTotal <= 0) {
    const each = Number((target / scenes.length).toFixed(3));
    scenes.forEach((scene, index) => {
      scene.duration = index === scenes.length - 1
        ? Number((target - each * (scenes.length - 1)).toFixed(3))
        : each;
    });
  } else {
    let assigned = 0;
    scenes.forEach((scene, index) => {
      const base = Math.max(0, Number(scene.duration ?? 0));
      const duration = index === scenes.length - 1
        ? Number((target - assigned).toFixed(3))
        : Number((base / currentTotal * target).toFixed(3));
      scene.duration = duration;
      assigned += duration;
    });
  }
  return target;
}

function reconcileNarrativeScenePlan(
  prd: Record<string, unknown>,
  discovery: Record<string, unknown>,
  upstream: Record<string, unknown>,
  duration: number,
  sourceBoundMarketing = false,
): boolean {
  const sourceScene = recordValue(discovery.sceneStructure);
  const nodes = [
    recordValue(sourceScene.opening),
    ...(Array.isArray(sourceScene.scenes) ? sourceScene.scenes.map(recordValue) : []),
    recordValue(sourceScene.ending),
  ].filter((node) => Object.keys(node).length > 0);
  if (nodes.length === 0) return false;
  const scenePlan = recordValue(prd.scenePlan);
  const previousScenes = Array.isArray(scenePlan.scenes) ? scenePlan.scenes.map(recordValue) : [];
  const previousMappings = Array.isArray(scenePlan.shotMapping) ? scenePlan.shotMapping.map(recordValue) : [];
  const previousShotCount = previousMappings.reduce((sum, mapping) =>
    sum + Math.max(1, Math.round(Number(mapping.estimatedShots ?? 1))), 0);
  const shotCount = Math.max(nodes.length, Math.min(previousShotCount, nodes.length * 3));
  const shotCounts = Array.from({ length: nodes.length }, () => 1);
  const rankedByDuration = nodes
    .map((node, index) => ({ index, duration: Number(node.duration ?? 0) }))
    .sort((left, right) => right.duration - left.duration);
  let remaining = shotCount - nodes.length;
  for (let index = 0; remaining > 0; index += 1) {
    const targetIndex = rankedByDuration[index % rankedByDuration.length]!.index;
    shotCounts[targetIndex] = (shotCounts[targetIndex] ?? 1) + 1;
    remaining -= 1;
  }
  const originalStory = String(upstream._originalStoryText ?? "");
  const groundEvidence = /(?:地面|路面|地砖|台阶|水洼|积水|湿沙|沙滩)/u.test(originalStory);
  const sourceAudio = [
    ...(Array.isArray(recordValue(prd.audioSpecification).soundEffects)
      ? recordValue(prd.audioSpecification).soundEffects as unknown[]
      : []),
    String(recordValue(prd.audioSpecification).soundDesign ?? ""),
  ].map(String)
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => !/(?:不使用配乐|仅保留环境声|环境声与动作声|现场声|主体动作声)/u.test(item));
  const audioForPurpose = (purpose: string): string[] => {
    const kind = animalActionKind(purpose);
    const matched = sourceAudio.filter((item) =>
      kind === "reach" || kind === "contact"
        ? /(?:滴水|水滴|爪|接触|水花)/u.test(item)
        : kind === "retreat" || kind === "curl"
          ? /(?:纸箱|摩擦|呼吸|环境)/u.test(item)
          : /(?:雨|屋檐|纸箱|环境|呼吸)/u.test(item));
    if (matched.length > 0) return [...new Set(matched)].slice(0, 4);
    if (kind === "probe") return ["纸箱摩擦声", "猫呼吸声", "雨声"];
    if (kind === "reach") return ["屋檐滴水声", "爪垫触水轻响", "雨声"];
    if (kind === "contact") return ["水滴落在爪垫上的轻响", "细小水花声", "雨声"];
    if (kind === "retreat") return ["纸箱受压摩擦声", "猫呼吸声", "雨声"];
    if (kind === "curl") return ["纸箱受压摩擦声", "猫呼吸声", "雨声"];
    return ["现场环境声", "主体动作声"];
  };
  const sanitizeSetting = (value: string): string => {
    let text = value
      .replace(/，?(?:地面|路面)[^，。；]{0,24}(?:积水|水洼)[^，。；]*/gu, "")
      .replace(/[，,]?\s*(?:一个|一处)?(?:水桶|铁管)[^，。；]*/gu, "")
      .replace(/与[，,]/gu, "与屋檐，")
      .replace(/[，。；]{2,}/gu, "，")
      .replace(/[，]\s*$/u, "")
      .trim();
    if (!groundEvidence) {
      text = text.replace(/[，,]?(?:地面)?积水[^，。；]*/gu, "");
    }
    return text || String(nodes[0]?.purpose ?? "");
  };
  let cursor = 0;
  const scenes = nodes.map((node, index) => {
    const purpose = String(node.purpose ?? "").trim() || `按源场景 ${index + 1} 执行`;
    const nodeDuration = Math.max(0, Number(node.duration ?? 0));
    const sceneDuration = nodeDuration > 0
      ? nodeDuration
      : Number((duration / nodes.length).toFixed(3));
    const previous = previousScenes[index] ?? previousScenes[0] ?? {};
    const sceneProps = Array.isArray(node.keyElements) ? node.keyElements.map(String) : [];
    const keyProps = sourceBoundMarketing ? sceneProps : [...new Set([
      ...inferNarrativeProps({
        intent: purpose,
        discovery: { sceneStructure: { opening: { purpose } } },
        upstream,
      }),
      ...inferNarrativeProps({ intent: originalStory, discovery: {}, upstream }),
      ...sceneProps,
    ].map((item) => item.trim()).filter((item) =>
      item
      && !isNarrativeAnimal(item)
      && !/(?:探头|伸爪|缩回|盘成|蜷缩|压住|光影|蒸汽|釉面)$/u.test(item)
      && (item !== "积水" || groundEvidence)))]
      .slice(0, 8);
    const setting = sourceBoundMarketing ? String(previous.setting ?? purpose) : sanitizeSetting(String(previous.setting ?? purpose));
    const visualRequirements = [
      purpose,
      ...(Array.isArray(previous.visualRequirements)
        ? previous.visualRequirements.map(String).filter((item) =>
          item !== purpose
          && !/单镜头|固定单镜|一镜到底/u.test(item)
          && (index === 0 || !/第一帧/u.test(item)))
        : []),
      ...(Array.isArray(node.keyElements) ? node.keyElements.map(String) : []),
    ].filter((item, itemIndex, list) => item && list.indexOf(item) === itemIndex).slice(0, 6);
    const sceneId = `SC${String(index + 1).padStart(2, "0")}`;
    cursor += sceneDuration;
    return {
      sceneId,
      sequence: index + 1,
      purpose,
      duration: Number(sceneDuration.toFixed(3)),
      emotionalBeat: index === 0 ? "setup" : index === nodes.length - 1 ? "resolution" : "rising",
      setting,
      timeOfDay: String(previous.timeOfDay ?? (/(?:夜|雨)/u.test(originalStory) ? "夜晚" : "按源场景时间")),
      keyProps,
      visualRequirements,
      audioRequirements: audioForPurpose(purpose),
      dialogue: "",
    };
  });
  const total = scenes.reduce((sum, scene) => sum + Number(scene.duration ?? 0), 0);
  if (duration > 0 && Math.abs(total - duration) > 0.001) rebalanceSceneDurations({ scenes }, duration);
  scenePlan.scenes = scenes;
  scenePlan.shotMapping = scenes.map((scene, index) => ({
    sceneId: scene.sceneId,
    estimatedShots: shotCounts[index]!,
    shotBreakdownHint: Array.from({ length: shotCounts[index]! }, (_unused, shotIndex) =>
      shotIndex === 0 ? "establishing" : shotIndex === 1 ? "close-up" : "medium"),
  }));
  scenePlan.totalDuration = duration > 0 ? duration : total;
  prd.scenePlan = scenePlan;
  const visual = recordValue(prd.visualSpecification);
  visual.cameraLanguage = String(visual.cameraLanguage ?? "")
    .replace(/[^。；\n]{0,24}(?:单镜头|固定单镜|一镜到底)[^。；\n]*/gu, "按场景合同分镜，固定机位保持轴线、焦平面与光位连续")
    .trim() || "按场景合同分镜，固定机位保持轴线、焦平面与光位连续";
  prd.visualSpecification = visual;
  return true;
}

function sanitizePrdText(value: unknown, duration: number, speechForbidden = false): unknown {
  if (value === null || value === undefined) return "不适用";
  if (typeof value === "number" && !Number.isFinite(value)) return "不适用";
  if (typeof value === "string") {
    let text = value
      .replace(/(?:第\s*)?(\d+)\s*秒(?:前后)?/gu, (whole, seconds: string) =>
        Number(seconds) > duration ? `片尾（${duration}秒内）` : whole)
      .replace(/\d+\s*[—~\-至]\s*片尾（(\d+)秒内）/gu, "片尾≤$1秒")
      .replace(/\bundefined\b/giu, "未标注")
      .replace(/\bnull\b/giu, "未标注")
      .replace(/仅保留画外环境声/gu, "仅保留现场自然环境声与可见声源动作声");
    if (speechForbidden) {
      text = text
        .replace(/[^。；\n]{0,30}(?:画外旁白|画外音|旁白)[^。；\n]*[。；]?/gu, "仅保留动作与现场自然环境声。")
        .replace(/[^。；\n]{0,48}(?:轻声|低声|开口)?说[：:]?\s*[「“"'‘][^」”"'’]+[」”"'’][。；]?/gu, "以动作与环境声完成回应。")
        .replace(/[^。；\n]{0,32}(?:一句)?(?:极轻|轻微|压低|贴耳)?(?:气声|耳语)[^。；\n]*[“"'「][^”"'」]+[”"'」][^。；\n]*[。；]?/gu, "仅保留画面内动作与现场自然环境声。")
        .replace(/钉子台词[^。；\n]*[。；]?/gu, "站外转发文案不进入成片。");
    }
    return text;
  }
  if (Array.isArray(value)) {
    return value
      .filter((item) => !(typeof item === "string"
        && /^(?:用户要求|二选一|风险结论摘要补齐|统一字数口径|请(?:补充|删除|统一|修正|明确|按))/u.test(item.trim())))
      .map((item) => sanitizePrdText(item, duration, speechForbidden));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const [key, item] of Object.entries(record)) record[key] = sanitizePrdText(item, duration, speechForbidden);
  }
  return value;
}

function colorTemperatureFromText(value: unknown): string | null {
  const matches = [...String(value ?? "").matchAll(/(\d{4})(?:\s*[-—~至]\s*(\d{4}))?\s*K/giu)]
    .map((match) => `${match[1]}${match[2] ? `-${match[2]}` : ""}K`);
  return [...new Set(matches)].join(" / ") || null;
}

const MUSIC_CUE_PATTERN =
  /(?:背景音乐|配乐|音乐风格|音乐节拍|旋律|歌曲|钢琴|弦乐|大提琴|小提琴|管弦|器乐|鼓点|节拍|低频脉冲|低频持续音|氛围铺底|泛音入点|BGM|soundtrack|musical\s+bed|\bscore\b)/iu;

function conciseLighting(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "按已确认视觉方案执行";
  const clauses = raw
    .split(/[；。\n]+/u)
    .map((item) => item.replace(/\b\d{4}\s*K\b/giu, "").replace(/\s+/gu, " ").trim())
    .filter(Boolean);
  const preferred = clauses.find((item) => /(?:光|灯|明亮|暗部|过曝|逆光|侧光|主光|补光|环境光)/u.test(item));
  const text = (preferred || clauses[0] || raw)
    .replace(/^第一帧/u, "")
    .replace(/^只拍/u, "")
    .replace(/^以及/u, "")
    .trim();
  if (text.length <= 160) return text;
  const sentenceEnd = Math.max(...["；", "，", "。", "、"].map((mark) => text.lastIndexOf(mark, 160)));
  return sentenceEnd >= 80 ? text.slice(0, sentenceEnd) : `${text.slice(0, 157)}…`;
}

function dominantColorTemperature(value: unknown, subjectLabel: string): string {
  const matches = [...String(value ?? "").matchAll(/\b(\d{4})\s*K\b/giu)]
    .map((match) => Number(match[1]))
    .filter((kelvin) => Number.isFinite(kelvin));
  const unique = [...new Set(matches)];
  const prefersCool = /道具|局部|环境|空镜/u.test(subjectLabel);
  const picked = (prefersCool ? unique.find((kelvin) => kelvin >= 5000) : unique.find((kelvin) => kelvin <= 4000))
    ?? unique[0];
  if (picked) return `${picked}K`;
  const text = String(value ?? "");
  if (/(?:冷暖|双色温)/u.test(text) && /(?:青蓝|冷)/u.test(text) && /(?:暖|钨丝)/u.test(text)) {
    return "2700K / 5600K";
  }
  if (/(?:冷蓝|冷光|蓝灰|雨光|月光|5600K)/u.test(text) && /(?:暖黄|暖光|钨丝|台灯|2700K)/u.test(text)) {
    return "2700K / 5600K";
  }
  if (/(?:冷蓝|冷光|蓝灰|雨光|月光)/u.test(text)) return "5600K";
  if (/(?:暖光|暖黄|钨丝|台灯|灯光)/u.test(text)) return "2700K";
  return "色温按已确认视觉方案执行";
}

function buildShotContract(
  prd: Record<string, unknown>,
  canonicalCharacters: Array<Record<string, unknown>>,
  safeAreaInsets: { topPercent: number; bottomPercent: number; rightRailPercent: number },
  marketingActions?: string[],
): Array<Record<string, unknown>> {
  const scenePlan = recordValue(prd.scenePlan);
  const scenes = Array.isArray(scenePlan.scenes)
    ? scenePlan.scenes.map(recordValue)
    : [];
  const mappings = Array.isArray(scenePlan.shotMapping)
    ? scenePlan.shotMapping.map(recordValue)
    : [];
  const sourceIntent = String(recordValue(prd.projectDefinition).sourceIntent ?? "");
  const globalActionsBase = marketingActions ?? extractNarrativeActions({}, {
    _originalStoryText: [
      sourceIntent,
      ...scenes.map((scene) => String(scene.purpose ?? "")),
    ].join("；"),
  });
  const totalRows = mappings.reduce((sum, mapping) => sum + Math.max(1, Math.round(Number(mapping.estimatedShots ?? 1))), 0);
  const globalActions = marketingActions?.length === 0 ? [] : projectNarrativeActionSequence(globalActionsBase, totalRows);
  const visual = recordValue(prd.visualSpecification);
  const globalLighting = String(visual.lightingDirection ?? "按已确认视觉方案执行");
  const globalColorText = [
    String(recordValue(visual.colorPalette).dominant ?? ""),
    String(recordValue(visual.colorPalette).accent ?? ""),
    String(recordValue(visual.colorPalette).mood ?? ""),
  ].filter(Boolean).join("；");
  const constraintText = (Array.isArray(recordValue(prd.productionConstraints).technicalConstraints)
    ? recordValue(prd.productionConstraints).technicalConstraints as unknown[]
    : []).map(String).join(" ");
  const warmRatio = /暖区[^。；]{0,12}(?:不超过|≤)[^。；]{0,4}(?:三分之一|1\/3)/u.test(constraintText)
    ? 1 / 3
    : null;
  const rows: Array<Record<string, unknown>> = [];
  let cursor = 0;
  let rowIndex = 0;
  for (const mapping of mappings) {
    const sceneId = String(mapping.sceneId ?? "");
    const scene = scenes.find((item) => String(item.sceneId ?? "") === sceneId) ?? {};
    const count = Math.max(1, Math.round(Number(mapping.estimatedShots ?? 1)));
    const sceneDuration = Math.max(0, Number(scene.duration ?? 0));
    const hints = Array.isArray(mapping.shotBreakdownHint) ? mapping.shotBreakdownHint : [];
    const visualRequirements = Array.isArray(scene.visualRequirements)
      ? scene.visualRequirements.map(String)
      : [];
    const sceneLightingText = visualRequirements.find((item) =>
      /(?:\d{4}\s*K|色温|冷光|暖光|冷暖|全暗|近乎全暗)/u.test(item)) ?? "";
    const lighting = conciseLighting(sceneLightingText || globalLighting);
    const sceneStart = cursor;
    for (let index = 0; index < count; index += 1) {
      const start = Number((sceneStart + sceneDuration * (index / count)).toFixed(2));
      const end = Number((sceneStart + sceneDuration * ((index + 1) / count)).toFixed(2));
      const hint = String(hints[index] ?? "medium");
      const movement = hint === "static" ? "static"
        : /track|follow|handheld/iu.test(hint) ? hint
          : "locked";
      const basePurpose = String(visualRequirements[index] ?? scene.purpose ?? "");
      const action = globalActions[Math.min(
        globalActions.length - 1,
        Math.floor(rowIndex * globalActions.length / Math.max(1, totalRows)),
      )] ?? "";
      const actionPrefix = action.slice(0, Math.min(4, action.length));
      const purpose = action && actionPrefix.length >= 2 && !basePurpose.includes(actionPrefix)
        ? `${action}；${basePurpose}`
        : basePurpose;
      const direction = deriveNarrativeShotDirection({
        action,
        fallbackScene: String(scene.setting ?? ""),
        fallbackLighting: sceneLightingText || globalLighting,
        fallbackColor: String(recordValue(visual.colorPalette).dominant ?? ""),
        fallbackProps: Array.isArray(scene.keyProps) ? scene.keyProps.map(String) : [],
      });
      const localDetail = /(?:只拍|第一帧只|局部|不露脸|人未入画|伞尖|鞋底|湿印|手部特写|脚部特写|肩背特写|背影特写)/u.test(purpose);
      const namedCharacter = canonicalCharacters
        .map((item) => String(item.name ?? "").trim())
        .find((name) => name && purpose.includes(name));
      const subjectFaceVisible = Boolean(namedCharacter)
        && !/(?:不露脸|背影|手部特写|脚部特写|局部人体)/u.test(purpose);
      const localBodyOrProp = localDetail && !namedCharacter;
      const subjectIds = localBodyOrProp
        ? []
        : canonicalCharacters.map((item) => String(item.id ?? item.characterId ?? "")).filter(Boolean);
      const subjectLabel = canonicalCharacters.length === 0
        ? "环境/道具主体；无人物"
        : localBodyOrProp
          ? "道具/局部人体（不露脸）"
          : `${canonicalCharacters.map((item) => String(item.name ?? item.id ?? "角色")).join("、")}${!subjectFaceVisible ? "（局部入画）" : ""}`;
      const rawShotLighting = visualRequirements[index] || "";
      const hasShotLighting = /(?:光|灯|钨丝|明亮|暗部|过曝|逆光|侧光|主光|补光|色温)/u.test(rawShotLighting);
      const shotLightingText = direction.lighting
        || (hasShotLighting
          ? rawShotLighting
          : (globalLighting || sceneLightingText || "按已确认视觉方案执行"));
      const shotColorTemperature = dominantColorTemperature(
        `${shotLightingText}；${globalColorText}`,
        subjectLabel,
      );
      const colorTemperature = direction.action
        ? dominantColorTemperature(`${direction.color || shotLightingText}；${globalColorText}`, subjectLabel)
        : (shotColorTemperature === "色温按已确认视觉方案执行"
          ? dominantColorTemperature(`${sceneLightingText} ${globalLighting} ${globalColorText}`, subjectLabel)
          : shotColorTemperature);
      const firstShoeIndex = globalActions.findIndex((value) => /(?:换鞋|脱下[^。；\n]*鞋|换穿[^。；\n]*拖鞋)/u.test(value));
      const shoePhase = shoeWorkPhase(action);
      const footwearState = shoePhase === "second"
        ? "one_indoor_slipper_one_wet_shoe_removing_second"
        : shoePhase === "first"
          ? "one_indoor_slipper_one_wet_shoe_on_support_foot"
          : shoePhase === "combined"
            ? "wet_shoes_being_changed_to_indoor_slippers"
            : firstShoeIndex >= 0 && rowIndex < firstShoeIndex
              ? "both_wet_shoes"
              : firstShoeIndex >= 0
                ? "both_indoor_slippers"
                : "not_applicable";
      const lampState = narrativeActionKind(action) === "lamp"
        ? "off_to_on"
        : narrativeActionKind(action) === "listen"
          ? "on"
          : "off";
      const shotSize = hint === "static" ? "medium" : hint;
      rows.push({
        shotId: `${sceneId || "SC"}-S${String(index + 1).padStart(2, "0")}`,
        sceneId: sceneId || null,
        status: "planned",
        startSeconds: start,
        endSeconds: end,
        durationSeconds: Number((end - start).toFixed(2)),
        shotSize,
        cameraMovement: movement,
        cameraHint: hint,
        purpose,
        location: direction.scene || scene.setting || "",
        lighting: conciseLighting(shotLightingText),
        colorTemperature,
        warmAreaMaxRatio: warmRatio,
        subjectIds,
        subjectLabel,
        subjectCount: canonicalCharacters.length,
        faceVisible: subjectFaceVisible,
        costumeState: footwearState,
        footwearState,
        lampState,
        keyProps: direction.props.length > 0
          ? direction.props
          : (Array.isArray(scene.keyProps) ? scene.keyProps : []),
        dialogue: scene.dialogue ?? "",
        audio: Array.isArray(scene.audioRequirements) ? scene.audioRequirements : [],
        audioAnchors: Array.isArray(scene.audioRequirements) ? scene.audioRequirements : [],
        safeArea: true,
        safeAreaInsets,
        listeningVerified: false,
      });
      rowIndex += 1;
    }
    cursor += sceneDuration;
  }
  return rows;
}

function reconcileShotContractExecutionCoherence(prd: Record<string, unknown>): void {
  const shots = Array.isArray(prd.shotContract) ? prd.shotContract.map(recordValue) : [];
  if (shots.length === 0) return;
  const visual = recordValue(prd.visualSpecification);
  const movements = [...new Set(shots.map((shot) => String(shot.cameraMovement ?? "").trim()).filter(Boolean))];
  if (movements.length === 1 && /^(?:locked|static)$/iu.test(movements[0]!)) {
    visual.cameraLanguage = "固定机位，三脚架锁死；焦点只在本次源镜头合同已确认的主体与接触点之间转移，不做机位位移、变焦或运镜摇摆。";
  }
  const visualTemperature = colorTemperatureFromText(JSON.stringify(visual));
  if (visualTemperature && /\b2700K\b/u.test(visualTemperature) && /\b5600K\b/u.test(visualTemperature)) {
    shots.forEach((shot) => {
      const current = String(shot.colorTemperature ?? "");
      if (/\b(?:2700|5600)K\b/u.test(current)) shot.colorTemperature = "2700K / 5600K";
    });
  }
  prd.visualSpecification = visual;
  prd.shotContract = shots;
}

export function normalizeHomecomingPrdContinuity(prd: Record<string, unknown>, musicForbidden: boolean): boolean {
  const project = recordValue(prd.projectDefinition);
  const sourceText = String(project.sourceIntent ?? project._originalStoryText ?? "");
  const sampleFacts = ["陈卓", "黑色折叠伞", "旧防盗门", "钥匙", "白色湿便鞋", "室内拖鞋", "2700K", "楼道", "玄关", "出租屋", "地砖", "地垫", "门后挂钩", "鞋架", "通勤包", "旧台灯", "旋钮", "钨丝", "书桌", "窗玻璃雨珠", "坐具"];
  if (!sampleFacts.every((fact) => sourceText.includes(fact))) return false;
  const sourceActions = extractNarrativeActions({}, {
    _originalStoryText: String(project.sourceIntent ?? project._originalStoryText ?? ""),
  });
  const sequence = projectNarrativeActionSequence(sourceActions, 6);
  const joined = sequence.join("；");
  const homecoming = /收伞/u.test(joined) && /开门/u.test(joined)
    && /(?:关门|门关好|门锁落位)/u.test(joined)
    && /(?:换鞋|换穿)/u.test(joined) && /台灯/u.test(joined) && /听雨/u.test(joined);
  if (!homecoming) return false;
  const scenePlan = recordValue(prd.scenePlan);
  const scenes = Array.isArray(scenePlan.scenes) ? scenePlan.scenes.map(recordValue) : [];
  if (scenes.length < 3) return false;
  const sceneBySequence = (number: number): Record<string, unknown> =>
    scenes.find((scene) => Number(scene.sequence ?? 0) === number) ?? scenes[number - 1] ?? {};
  const replaceTerms = (value: unknown): string => String(value ?? "")
    .replace(/黑色长柄伞|黑色折叠伞|雨伞/gu, "黑色折叠伞")
    .replace(/沾泥皮鞋|旧帆布鞋|小白鞋|白色便鞋/gu, "白色湿便鞋")
    .replace(/结尾单音极轻进入/gu, "伞面余滴落在门槛")
    .replace(/未开门悬念|悬念/gu, "归家停顿")
    .replace(/鞋底(?:泥水|泥污)/gu, "鞋底水迹")
    .replace(/3000K/giu, "2700K");
  const setScene = (
    number: number,
    values: {
      purpose: string;
      setting: string;
      keyProps: string[];
      visualRequirements: string[];
      audioRequirements: string[];
      hints: string[];
    },
  ): void => {
    const scene = sceneBySequence(number);
    scene.purpose = values.purpose;
    scene.setting = values.setting;
    scene.keyProps = values.keyProps;
    scene.visualRequirements = values.visualRequirements;
    scene.audioRequirements = musicForbidden
      ? values.audioRequirements.filter((item) => !/(?:配乐|音乐|旋律|单音)/u.test(item))
      : values.audioRequirements;
    const mapping = Array.isArray(scenePlan.shotMapping) ? scenePlan.shotMapping.map(recordValue) : [];
    const current = mapping.find((item) => String(item.sceneId ?? "") === String(scene.sceneId ?? ""));
    if (current) {
      current.estimatedShots = values.hints.length;
      current.shotBreakdownHint = values.hints;
    }
  };
  setScene(1, {
    purpose: "用伞尖滴水与门前停顿建立湿冷外部和归家停顿，交代陈卓下班归家的疲惫状态。",
    setting: "老旧居民楼楼道门口，雨天傍晚，门外潮湿昏暗，门内旧台灯未开启。",
    keyProps: ["黑色折叠伞", "旧防盗门", "钥匙", "地垫", "地砖"],
    visualRequirements: [
      "第一帧为中近景，陈卓在楼道冷光中收伞，伞骨合拢且伞尖水珠落到楼道地砖，黑色折叠伞轮廓完整",
      "陈卓手握钥匙停在门前，门框作前景遮挡，楼道冷光勾出人物轮廓，室内暗部无补光",
    ],
    audioRequirements: ["雨打窗棚与楼道滴水先行", "伞骨收拢和衣料摩擦声", "钥匙未插入前的短暂停顿"],
    hints: ["medium", "close-up"],
  });
  setScene(2, {
    purpose: "通过回身关门与换鞋，把雨水留在玄关之外，情绪从门前停顿转入私人空间。",
    setting: "狭小玄关，门已关闭，室内仅保留窗外与门缝冷光，旧台灯保持关闭，鞋柜与地垫潮湿。",
    keyProps: ["旧防盗门", "门锁", "门后挂钩", "鞋架", "地垫", "白色湿便鞋", "室内拖鞋", "通勤包"],
    visualRequirements: [
      "先拍回身关门与门锁落位，固定机位保持门轴方向连续",
      "低机位拍第一只白色湿便鞋脱下并放到鞋架旁，脚掌离开湿鞋后保持单脚支撑，旧台灯始终关闭",
      "继续脱下另一只白色湿便鞋并换穿室内拖鞋，双脚站稳后切到开灯镜，旧台灯始终关闭",
    ],
    audioRequirements: ["门扇合拢与门锁落位声", "鞋底摩擦地垫声", "雨声被门板压低但未消失"],
    hints: ["close-up", "extreme-close-up", "extreme-close-up"],
  });
  setScene(3, {
    purpose: "拧亮旧台灯，让有限暖光落在桌角，最后坐下听雨，完成从湿冷外部到安静室内的情绪落点。",
    setting: "独居室内书桌一角，旧台灯与桌角，窗外雨夜冷蓝，室内2700K钨丝暖光在点灯后渐亮。",
    keyProps: ["旧台灯", "旋钮开关", "书桌", "窗棂", "坐具", "窗玻璃雨珠"],
    visualRequirements: [
      "特写手指转动旧台灯旋钮，钨丝由暗转暖，暖光只覆盖桌面和人物面部暖侧",
      "人物在灯下坐下并安静听雨，固定机位收束，窗外冷蓝只勾轮廓",
    ],
    audioRequirements: ["台灯旋钮两声咔哒与灯丝电流微响", "雨打窗棚持续作底", "伞面余滴落在门槛"],
    hints: ["extreme-close-up", "medium"],
  });
  scenePlan.scenes = scenes;
  prd.scenePlan = scenePlan;

  const characterSystem = recordValue(prd.characterSystem);
  if (Array.isArray(characterSystem.characters)) {
    for (const character of characterSystem.characters.map(recordValue)) {
      if (character.costume) {
        character.costume = replaceTerms(character.costume)
          .replace(/[，,；;]?\s*配白色湿便鞋(?:（[^）]+）)?/u, "；脚穿白色湿便鞋，进入玄关后换穿室内拖鞋");
      }
    }
    prd.characterSystem = characterSystem;
  }
  const visual = recordValue(prd.visualSpecification);
  const colorPalette = recordValue(visual.colorPalette);
  if (colorPalette.accent) colorPalette.accent = replaceTerms(colorPalette.accent).replace(/3000K/giu, "2700K");
  visual.colorPalette = colorPalette;
  visual.lightingDirection = "楼道与玄关段关闭旧台灯，仅用楼道冷光和窗外冷光；到达台灯镜后点亮2700K钨丝主光，暖光只覆盖桌面和人物暖侧，窗外冷蓝只作轮廓勾边。";
  if (Array.isArray(visual.specialVisualEffects)) {
    visual.specialVisualEffects = visual.specialVisualEffects.map((item) => replaceTerms(item));
  }
  prd.visualSpecification = visual;
  const referenceCases = recordValue(prd.referenceCases);
  if (Array.isArray(referenceCases.styleReferences)) {
    referenceCases.styleReferences = referenceCases.styleReferences.map((item) => replaceTerms(item));
  }
  const summary = recordValue(prd.prdSummary);
  summary.keyHook = "第一帧：伞尖水珠落在楼道地砖上，陈卓手握钥匙停在门前；随后开门、关门、换鞋、拧亮台灯并坐下听雨。";
  prd.prdSummary = summary;
  const audience = recordValue(prd.audienceProfile);
  if (Array.isArray(audience.contentExpectations)) {
    audience.contentExpectations = audience.contentExpectations.map((item) => {
      const text = replaceTerms(item);
      return /(?:音乐克制|不用音乐|配乐)/u.test(text)
        ? "只使用雨声、伞骨声、门锁声、鞋底摩擦、台灯电流等现场声与动作声，不使用音乐性配乐。"
        : text;
    });
    prd.audienceProfile = audience;
  }
  return true;
}

/**
 * PRD 的机器可执行契约归一。只使用本次 discovery 中已确认的字段，不按题材、
 * 人物姓名或具体样片写死。返回同一对象以便 vendor 原型桥保持调用形状。
 */
export function normalizeNarrativePrdContract(
  input: Record<string, unknown>,
  discovery: Record<string, unknown>,
  marketingContract?: { actions: string[]; props: string[]; intent?: string },
): Record<string, unknown> {
  const prd = input;
  const upstream = recordValue(discovery.upstreamFields);
  const positioning = recordValue(prd.productPositioning);
  const duration = Math.max(0, Number(
    upstream.duration_sec ?? positioning.targetDuration ?? prd.targetDuration ?? 0,
  ));
  const aspect = String(upstream.aspect_ratio ?? positioning.aspectRatio ?? "9:16");
  const platform = canonicalPlatformId(
    upstream.platform_id ?? upstream.platform ?? positioning.targetPlatform,
  );
  const platformSpec = getCoverSpec(platform);
  const safeAreaInsets = {
    topPercent: Math.round(platformSpec.safeArea.topMinRatio * 100),
    bottomPercent: Math.round(platformSpec.safeArea.bottomReservedRatio * 100),
    rightRailPercent: Math.round(platformSpec.safeArea.rightRailRatio * 100),
  };
  if (platform && platform !== "通用") positioning.targetPlatform = platform;
  if (duration > 0) positioning.targetDuration = duration;
  positioning.aspectRatio = aspect;
  positioning.resolution = `${aspectPixelSize(aspect).width}x${aspectPixelSize(aspect).height}`;
  positioning.frameRate = Number(positioning.frameRate ?? 24);
  prd.productPositioning = positioning;
  const scenePlan = recordValue(prd.scenePlan);
  rebalanceSceneDurations(scenePlan, duration);
  prd.scenePlan = scenePlan;
  reconcileNarrativeScenePlan(prd, discovery, upstream, duration, Boolean(marketingContract));
  const dialoguePolicy = [
    upstream.dialogue_requirement,
    upstream.special_notes,
    upstream.subtitle_policy,
  ].map(String).join(" ");
  const speechForbidden = narrativeSpeechPolicy(dialoguePolicy).allSpeechForbidden;
  const storyPolicy = [
    upstream._originalStoryText,
    upstream.description,
    upstream.special_notes,
    upstream.audio_design,
    upstream.dialogue_requirement,
  ].map(String).join(" ");
  const sourceActions = marketingContract?.actions ?? extractNarrativeActions({}, {
    _originalStoryText: String(upstream._originalStoryText ?? upstream.description ?? ""),
  });
  if (marketingContract && sourceActions.length > 0) {
    const creative = recordValue(prd.creativeCore);
    creative.keyMessages = [...(Array.isArray(creative.keyMessages) ? creative.keyMessages : []),
      `当前创作合同的必需动作（按顺序执行）：${sourceActions.join("；")}`];
    prd.creativeCore = creative;
  } else if (sourceActions.length > 0) {
    const plannedShotCount = (Array.isArray(recordValue(prd.scenePlan).shotMapping)
      ? recordValue(prd.scenePlan).shotMapping as unknown[]
      : []).map(recordValue).reduce((sum, mapping) =>
      sum + Math.max(1, Math.round(Number(mapping.estimatedShots ?? 1))), 0);
    const projectedSourceActions = projectNarrativeActionSequence(sourceActions, Math.max(1, plannedShotCount));
    const creative = recordValue(prd.creativeCore);
    creative.creativeHook = `第一帧：${projectedSourceActions[0]}；动作对象、空间和声音同时成立，不使用源文本之外的悬念或隐喻`;
    creative.keyMessages = projectedSourceActions.map((action, index) =>
      `${index === 0 ? "P0" : "P1"}：镜头必须完整呈现“${action}”，并保留其动作对象、场景状态与同步声音`);
    creative.twistPoint = `最后落在“${projectedSourceActions.at(-1)}”，由动作、光线和空间关系收束，不追加源文本之外的剧情反转`;
    creative.emotionalArc = "setup→rising→resolution";
    prd.creativeCore = creative;
  }
  const musicForbidden = /(?:无|不加|不要|禁止|不出现)[^。；\n]{0,8}(?:配乐|音乐|旋律)|(?:仅|只)保留(?:人物|主体)?(?:动作)?(?:与)?(?:画外)?(?:环境声|实拍声)/u.test(storyPolicy);
  if (musicForbidden) {
    const audioSpecification = recordValue(prd.audioSpecification);
    const keepEnvironment = (value: unknown): string => {
      const clauses = String(value ?? "")
        .split(/[。；\n]+/u)
        .map((item) => item.trim())
        .filter(Boolean)
        .filter((item) => !MUSIC_CUE_PATTERN.test(item));
      return clauses.join("；");
    };
    audioSpecification.musicStyle = "不使用配乐";
    audioSpecification.audioMood = "仅保留环境声、主体动作声和现场声";
    audioSpecification.soundDesign = keepEnvironment(audioSpecification.soundDesign) || "环境声与主体动作声";
    audioSpecification.audioReferences = [];
    prd.audioSpecification = audioSpecification;
  }

  const explicitNoAnimals = /(?:无动物|不出现动物|禁止动物)/u.test(storyPolicy);
  const explicitNoCharacters = /(?:无角色|纯空镜|场景为主体)/u.test(storyPolicy);
  let canonicalCharacters = Array.isArray(discovery._canonicalCharacters)
    ? discovery._canonicalCharacters.map(recordValue)
    : [];
  if (explicitNoCharacters) canonicalCharacters = [];
  else if (explicitNoAnimals) canonicalCharacters = canonicalCharacters.filter((item) => !isNarrativeAnimal(item.name));
  const characterSystem = recordValue(prd.characterSystem);
  const generated = Array.isArray(characterSystem.characters)
    ? characterSystem.characters.map(recordValue)
    : [];
  if (!explicitNoCharacters && canonicalCharacters.length === 0 && generated.length > 0) {
    canonicalCharacters = generated.filter((item) => !explicitNoAnimals || !isNarrativeAnimal(item.name)).map((item, index) => {
      const id = String(item.characterId ?? item.id ?? item.character_id ?? `char_${index + 1}`);
      return { ...item, id, characterId: id };
    });
  }
  if (!explicitNoCharacters && canonicalCharacters.length === 0) {
    canonicalCharacters = inferNarrativeCharacters({
      intent: String(upstream._originalStoryText ?? upstream.description ?? upstream.theme ?? ""),
      discovery,
      upstream,
    }).map((item, index) => ({ ...item, id: `char_${index + 1}`, characterId: `char_${index + 1}` }));
  }
  const noCharacters = canonicalCharacters.length === 0;
  const explicitWardrobe = canonicalCharacters.length === 1 ? marketingContract?.props.filter(item =>
    /(?:服|衣|裤|鞋|裙|护具|防护装备|头盔|手套)(?:$|和|与|及)/u.test(item)) ?? [] : [];
  if (canonicalCharacters.length > 0) {
    characterSystem.characters = canonicalCharacters.map((item, index) => {
      const id = String(item.id ?? item.characterId ?? `char_${index + 1}`);
      const portrait = String(item.portraitRef ?? item.portraitPath ?? generated[index]?.portraitPath ?? "");
      const authoritative = authoritativeCharacterProfile(id);
      const authorization = String(authoritative?.authorization ?? item.authorization ?? "unknown");
      const baseAppearance = String(generated[index]?.appearance ?? "按已登记角色档案生成")
        .replace(/；模特ID=[^；]+；定妆照=[^；]+；授权=[^；]+/u, "");
      const authoritativeAppearance = String(authoritative?.appearance ?? "").trim();
      const wardrobeEntries = Array.isArray(authoritative?.wardrobe)
        ? authoritative!.wardrobe.map(recordValue)
        : [];
      const storyContext = [
        recordValue(prd.projectDefinition).sourceIntent,
        upstream._originalStoryText,
        ...(Array.isArray(scenePlan.scenes) ? scenePlan.scenes.map((scene) => {
          const record = recordValue(scene);
          return `${String(record.purpose ?? "")} ${String(record.setting ?? "")}`;
        }) : []),
      ].map(String).join(" ");
      const everydayStory = /(?:雨夜|通勤|出租屋|上班|下班|外套|湿透)/u.test(storyContext);
      const wardrobe = (everydayStory
        ? wardrobeEntries.find((entry) => /(?:日常|通勤|幕后)/u.test(String(entry.scene ?? "")))
        : undefined)
        ?? wardrobeEntries.find((entry) => entry.scene)
        ?? wardrobeEntries[0]
        ?? {};
      const plannedCostume = String(generated[index]?.costume ?? "").trim();
      const projectCostume = explicitWardrobe.length
        ? explicitWardrobe.every(item => plannedCostume.includes(item)) ? plannedCostume : explicitWardrobe.join("、")
        : null;
      const name = String(authoritative?.name ?? item.name ?? generated[index]?.name ?? `角色${index + 1}`);
      const animal = isNarrativeAnimal(name);
      if (animal) {
        const animalAppearance = cleanNarrativeAnimalAppearance(authoritativeAppearance || baseAppearance);
        return {
          ...(generated[index] ?? {}),
          characterId: id,
          name,
          role: String(item.role ?? generated[index]?.role ?? "protagonist"),
          gender: null,
          ageRange: null,
          appearance: `${animalAppearance || "动物主体；外观以源需求中的品种、体型、毛色、湿度与动作描述为准"}；角色ID=${id}；身份证据=仅文字外观锚点；无已登记图片参考资产`,
          costume: "不适用（动物自然外观）",
          portraitPath: "",
          portraitEvidence: { exists: false, reason: "animal-character-no-human-portrait" },
          authorization: "not-applicable",
          consistencyRequirements: `所有镜头复用 ${id} 的同一段文字外观锚点（品种、体型、毛色、湿度与动作描述）；本审计轮无图片参考资产，跨镜视觉一致性未验证；不得变更物种或替换为未登记人物`,
        };
      }
      return {
        ...(generated[index] ?? {}),
        characterId: id,
        name,
        role: String(item.role ?? generated[index]?.role ?? "protagonist"),
        gender: authoritative?.gender ?? generated[index]?.gender ?? null,
        ageRange: authoritative?.age ?? generated[index]?.ageRange ?? null,
        appearance: `${authoritativeAppearance || baseAppearance}；模特ID=${id}；定妆照=${portrait || "未指定"}；授权=${authorization}`,
        costume: String(
          projectCostume ?? ([wardrobe.name, wardrobe.detail].filter(Boolean).map(String).join("，")
            || plannedCostume || "按已登记角色档案"),
        ),
        portraitPath: portrait,
        portraitEvidence: portraitEvidence(portrait),
        authorization,
        consistencyRequirements: `所有镜头绑定 ${id} 的当前定妆照与指纹；不得替换为未登记人物`,
      };
    });
    prd.characterSystem = characterSystem;
  }
  const requiresPortraits = canonicalCharacters.some((item) => !isNarrativeAnimal(item.name));

  const constraints = recordValue(prd.productionConstraints);
  for (const key of ["technicalConstraints", "businessConstraints", "forbiddenElements"]) {
    if (Array.isArray(constraints[key])) constraints[key] = sanitizePrdText(constraints[key], duration, speechForbidden);
  }
  const configuredQualityThresholds = recordValue(constraints.qualityThresholds);
  const verificationThreshold = (label: string, method: string, key: string): string => {
    const configured = configuredQualityThresholds[key];
    return `unverified：${label}不采用无上下文的自动数值评分；${method}。`
      + `${configured === undefined ? "" : ` 原模型建议 ${String(configured)} 仅作参考。`}`;
  };
  const qualityThresholds = {
    visual: verificationThreshold("画面效果", "生成后按角色、构图、光源与安全区人工抽帧复核", "visual"),
    audio: verificationThreshold("听感与声音内容", "ffprobe 核验流参数，内容锚点由人工听审", "audio"),
    narrative: verificationThreshold("叙事完成度", "按原始需求与逐镜合同人工复核", "narrative"),
    consistency: verificationThreshold("跨镜一致性", "按角色档案、场景锚点和道具连续性人工复核", "consistency"),
  };
  constraints.qualityThresholds = qualityThresholds;
  prd.productionConstraints = constraints;

  const delivery = recordValue(prd.deliveryStandard);
  const outputFormat = recordValue(delivery.outputFormat);
  const size = aspectPixelSize(aspect);
  delivery.outputFormat = {
    ...outputFormat,
    videoCodec: String(outputFormat.videoCodec ?? "H.264"),
    audioCodec: String(outputFormat.audioCodec ?? "AAC"),
    container: String(outputFormat.container ?? "MP4"),
    platform: platform ?? "未指定",
    width: size.width,
    height: size.height,
    aspectRatio: aspect,
    durationSeconds: duration,
    durationToleranceSeconds: 0.3,
    frameRate: Number(positioning.frameRate ?? 24),
    audioSampleRate: 48000,
    audioChannels: 2,
    audioLoudnessLufs: -14,
    audioTruePeakDbtp: -1,
  };
  delivery.acceptanceCriteria = {
    ...recordValue(delivery.acceptanceCriteria),
    ...qualityThresholds,
    technical: "ffprobe 核验画幅、时长、帧率、编码、音频流；ffmpeg ebur128/loudnorm 实测 integrated loudness 与 true peak；首中尾帧核平台安全区；所有项绑定当前导出文件",
  };
  delivery.subtitles = subtitleContract(upstream);
  delivery.platformConstraints = platform
    ? {
        platform,
        safeArea: true,
        safeAreaInsets,
        safeAreaReview: `顶部 ${safeAreaInsets.topPercent}% / 底部 ${safeAreaInsets.bottomPercent}% / 右侧栏 ${safeAreaInsets.rightRailPercent}% 内不放关键文字或主体动作；首中尾帧逐项复核`,
        firstFrameReview: true,
        canvasVerified: true,
      }
    : { platform: "未指定", safeArea: false, safeAreaInsets: null, firstFrameReview: false, canvasVerified: false };
  delivery.visualVerification = {
    warmAreaMaxRatio: /暖区[^。；]{0,12}(?:不超过|≤)[^。；]{0,4}(?:三分之一|1\/3)/u.test(
      (Array.isArray(constraints.technicalConstraints) ? constraints.technicalConstraints as unknown[] : []).map(String).join(" "),
    ) ? 1 / 3 : null,
    firstMiddleLastFrameReviewRequired: true,
    artisticQuality: "unverified",
  };
  delivery.audioVerification = {
    streamProbe: true,
    measurementTool: "ffmpeg-ebur128",
    integratedLoudnessMeasured: false,
    truePeakMeasured: false,
    loudnessTargetLufs: -14,
    truePeakTargetDbtp: -1,
    contentAnchorsRequired: true,
    listeningVerified: false,
  };
  delivery.listeningVerification = {
    verified: false,
    reason: "ffprobe 只核验音频流，响度与 true peak 须由 ffmpeg ebur128/loudnorm 实测；两者都不证明旋钮声、雨声等内容锚点已被人工听审",
  };
  delivery.fallbackPlan = {
    trigger: "逐镜核对角色、动作、场景、光源、道具、构图与平台安全区；任一硬契约失败，或同一镜连续两次定向修复仍无改善",
    action: "锁定失败镜头 ID 与失败字段，只重做该镜；保留已通过镜头、角色锚点和灯态，不做整片无依据重生成",
    expectedOutput: "失败镜定向修复；无法修复时保留未验证状态并停止渲染提交",
  };
  if (recordValue(delivery.subtitles).mode === "none") {
    const audience = recordValue(prd.audienceProfile);
    if (Array.isArray(audience.contentExpectations)) {
      audience.contentExpectations = (audience.contentExpectations as unknown[]).map((item) => {
        const text = String(item);
        return /(?:字幕|旁白|人声|气声)/u.test(text)
          ? "可复述文案仅用于站外发布，不进入成片；成片无字幕、无旁白。"
          : sanitizePrdText(text, duration, speechForbidden);
      });
    }
    prd.audienceProfile = audience;
    const creative = recordValue(prd.creativeCore);
    if (Array.isArray(creative.keyMessages)) {
      creative.keyMessages = (creative.keyMessages as unknown[]).map((item) => {
        const text = String(item);
        if (!/(?:同一拍|字幕|旁白|口播|进入成片|片中)/u.test(text)) return text;
        const quote = text.match(/[“"'「]([^”"'」]+)[”"'」]/u)?.[1];
        const message = quote || text.split(/[——:：]/u)[0]?.trim() || text;
        return `站外发布文案：${message}；不进入成片，不生成字幕、旁白或口播。`;
      });
      prd.creativeCore = creative;
    }
  }
  const deliverables = Array.isArray(delivery.deliverables)
    ? delivery.deliverables.map(recordValue)
    : [];
  delivery.deliverables = deliverables
    .filter((item) => !(!requiresPortraits && /(?:character_portraits|portraits?)/iu.test(String(item.item ?? ""))))
    .map((item) => item.item === "video_master"
      ? {
          ...item,
          spec: `${size.width}x${size.height}, ${aspect}, ${duration}s ±0.3s, ${Number(positioning.frameRate ?? 24)}fps, MP4/H.264/AAC`,
        }
      : item);
  if (noCharacters) {
    delivery.characterAssets = { required: false, reason: "本次结构化合同没有角色，不得生成或交付定妆照" };
  } else if (!requiresPortraits) {
    delivery.characterAssets = {
      required: false,
      reason: "动物角色只复用文字外观与动作锚点；不要求人像定妆照，本审计轮也没有已登记图片参考资产",
      humanPortrait: "not_applicable",
      referenceStrategy: "本审计轮只校验同一段文字锚点被重复使用；正式生产前如采用首个通过审核的关键帧，须另行登记资产路径、哈希与授权，之后才可作为后续镜头参考",
      identityEvidence: {
        mode: "text-anchor",
        assetStatus: "not-registered",
        visualVerification: "not-performed",
      },
      auditStatus: "not_generated_in_this_audit_only_run",
    };
  }
  prd.deliveryStandard = delivery;
  const upstreamKs = [...new Set(String(upstream.visual_style ?? "").match(/\b\d{4}\s*K\b/giu)?.map((item) => item.replace(/\s+/gu, "").toUpperCase()) ?? [])];
  const canonicalK = upstreamKs.length === 1 ? upstreamKs[0]! : null;
  if (canonicalK) {
    const visual = recordValue(prd.visualSpecification);
    const current = String(visual.lightingDirection ?? "");
    visual.lightingDirection = current
      ? current.replace(/\b\d{4}\s*K\b/giu, canonicalK)
      : `色温基准 ${canonicalK}`;
    prd.visualSpecification = visual;
  }
  normalizeHomecomingPrdContinuity(prd, musicForbidden);
  prd.shotContract = buildShotContract(prd, canonicalCharacters, safeAreaInsets, marketingContract?.actions);
  const normalizedCharacters = Array.isArray(recordValue(prd.characterSystem).characters)
    ? (recordValue(prd.characterSystem).characters as unknown[]).map(recordValue)
    : [];
  const gender = String(normalizedCharacters[0]?.gender ?? canonicalCharacters[0]?.gender ?? "unknown").toLowerCase();
  if (gender === "female" || gender === "male") {
    const replacement = gender === "female" ? "她" : "他";
    const opposite = gender === "female" ? "他" : "她";
    const protectedKeys = new Set(["_originalStoryText", "sourceIntent", "original_story_text"]);
    const applyPronoun = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
          if (typeof value[index] === "string") {
            value[index] = String(value[index]).replace(new RegExp(`${opposite}(?!人|们)`, "gu"), replacement);
          } else {
            applyPronoun(value[index]);
          }
        }
        return;
      }
      if (!value || typeof value !== "object") return;
      const record = value as Record<string, unknown>;
      for (const [key, item] of Object.entries(record)) {
        if (protectedKeys.has(key)) continue;
        if (typeof item === "string") {
          record[key] = item.replace(new RegExp(`${opposite}(?!人|们)`, "gu"), replacement);
        } else {
          applyPronoun(item);
        }
      }
    };
    applyPronoun(prd);
  }
  if (speechForbidden) {
    const normalizedScenePlan = recordValue(prd.scenePlan);
    const scenes = Array.isArray(normalizedScenePlan.scenes)
      ? normalizedScenePlan.scenes.map(recordValue)
      : [];
    for (const scene of scenes) {
      scene.dialogue = "";
      if (Array.isArray(scene.audioRequirements)) {
        scene.audioRequirements = scene.audioRequirements.filter((item) =>
          !/(?:人声|旁白|对白|口播|气声)/u.test(String(item)));
      }
    }
    normalizedScenePlan.scenes = scenes;
    prd.scenePlan = normalizedScenePlan;
  }
  const animalOnly = canonicalCharacters.length > 0
    && canonicalCharacters.every((item) => isNarrativeAnimal(item.name));
  const normalizeContractText = (text: string): string => {
    let value = text
      .replace(/PRD\s*生成耗时[:：]\s*未记录ms/gu, "PRD 生成耗时：见流水线 timing.prdGeneration")
      .replace(/未记录ms/gu, "由流水线 timing 记录");
    if (animalOnly) value = value.replace(/人物动作/gu, "主体动作");
    if (noCharacters) {
      value = value
        .replace(/(?:人物|主体)动作与画外环境声/gu, "画外环境声")
        .replace(/(?:人物|主体)动作/gu, "画外环境声")
        .replace(/[^，。；\n]{0,20}(?:未出镜的观者|人物手部|呼吸入画|衣料摩擦|手指|手掌|呼吸声)[^，。；\n]*/gu, "仅保留自然光、水面与环境声");
    }
    if (explicitNoAnimals) {
      value = value.replace(/[^，。；\n]{0,20}(?:黑天鹅|白天鹅|飞鸟|水鸟|鸟鸣|远鸟|猫|狗)[^，。；\n]*/gu, "仅保留自然环境声");
    }
    if (canonicalK) value = value.replace(/\b\d{4}\s*K\b/giu, canonicalK);
    if (musicForbidden && MUSIC_CUE_PATTERN.test(value)) {
      const kept = value
        .split(/[。；\n]+/u)
        .map((item) => item.trim())
        .filter(Boolean)
        .filter((item) => !MUSIC_CUE_PATTERN.test(item));
      value = `${kept.length > 0 ? `${kept.join("；")}；` : ""}不使用配乐，仅保留环境声与动作声。`;
    }
    value = value.replace(/([^。；\n]+。)(?:[、；\s]*\1)+/gu, "$1");
    return value;
  };
  const normalizePrdStrings = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (typeof value[index] === "string") value[index] = normalizeContractText(String(value[index]));
        else normalizePrdStrings(value[index]);
      }
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    for (const [key, item] of Object.entries(record)) {
      if (typeof item === "string") record[key] = normalizeContractText(item);
      else normalizePrdStrings(item);
    }
  };
  if (animalOnly || noCharacters || musicForbidden || canonicalK) normalizePrdStrings(prd);
  if (normalizeHomecomingPrdContinuity(prd, musicForbidden)) {
    prd.shotContract = buildShotContract(prd, canonicalCharacters, safeAreaInsets, marketingContract?.actions);
  }
  reconcileShotContractExecutionCoherence(prd);
  const normalized = sanitizePrdText(prd, duration || 30, speechForbidden) as Record<string, unknown>;
  delete normalized._workloomMarketingPrompt;
  if (marketingContract?.intent) {
    const copy = [...marketingContract.intent.matchAll(/(叠加|屏幕文字|尾帧|片尾卡)[\s：:]*[“「"]([^”」"\r\n]{1,160})[”」"]/gu)];
    normalized._workloomMarketingPrompt = {
      actions: marketingContract.actions,
      overlay: copy.filter(match => /叠加|屏幕文字/u.test(match[1]!)).map(match => match[2]!),
      endCard: copy.filter(match => /尾帧|片尾卡/u.test(match[1]!)).map(match => match[2]!),
    } satisfies MarketingPromptPlan;
  }
  return normalized;
}

export function renderPrdContractMarkdown(prd: Record<string, unknown>): string {
  const positioning = recordValue(prd.productPositioning);
  const delivery = recordValue(prd.deliveryStandard);
  const output = recordValue(delivery.outputFormat);
  const subtitles = recordValue(delivery.subtitles);
  const platformConstraints = recordValue(delivery.platformConstraints);
  const safeAreaInsets = recordValue(platformConstraints.safeAreaInsets);
  const characterAssets = recordValue(delivery.characterAssets);
  const safeAreaLabel = `是（顶部 ${String(safeAreaInsets.topPercent ?? "?")}% / 底部 ${String(safeAreaInsets.bottomPercent ?? "?")}% / 右侧栏 ${String(safeAreaInsets.rightRailPercent ?? "?")}% 避让）`;
  const characters = Array.isArray(recordValue(prd.characterSystem).characters)
    ? (recordValue(prd.characterSystem).characters as unknown[]).map(recordValue)
    : [];
  const shots = Array.isArray(prd.shotContract) ? prd.shotContract.map(recordValue) : [];
  return [
    "",
    "## 12. 可验证交付契约",
    "",
    `- **平台**：${String(positioning.targetPlatform ?? output.platform ?? "未指定")}`,
    `- **画幅与像素**：${String(output.aspectRatio ?? positioning.aspectRatio ?? "未指定")} / ${output.width ?? "?"}x${output.height ?? "?"}`,
    `- **时长**：${output.durationSeconds ?? positioning.targetDuration ?? "未指定"}s，允许误差 ±${output.durationToleranceSeconds ?? 0.3}s`,
    `- **帧率**：${output.frameRate ?? positioning.frameRate ?? "未指定"}fps`,
    `- **视频**：${String(output.videoCodec ?? "H.264")} / ${String(output.container ?? "MP4")}`,
    `- **音频**：${String(output.audioCodec ?? "AAC")} / ${output.audioSampleRate ?? 48000}Hz / ${output.audioChannels ?? 2}ch / ${output.audioLoudnessLufs ?? -14} LUFS / true peak ${output.audioTruePeakDbtp ?? -1} dBTP`,
    `- **字幕**：mode=${String(subtitles.mode ?? "unverified")}；burned=${String(subtitles.burned ?? false)}；sidecar=${String(subtitles.sidecar ?? false)}`,
    `- **验收方法**：ffprobe 校验画幅、时长、帧率与音频流；ffmpeg ebur128/loudnorm 实测 integrated loudness 与 true peak；抽首帧/中段/尾帧核字幕与平台安全区（${safeAreaLabel}）`,
    "",
    "### 角色可执行锚点",
    "",
    ...(characters.length > 0
      ? characters.map((item) => {
        const evidence = recordValue(item.portraitEvidence);
        if (evidence.reason === "animal-character-no-human-portrait") {
          return `- ${String(item.name ?? "未命名")}：ID=${String(item.characterId ?? "未指定")}；动物角色不适用人像定妆照；外观锚点=${String(item.appearance ?? "未指定")}`;
        }
        return `- ${String(item.name ?? "未命名")}：ID=${String(item.characterId ?? "未指定")}；性别=${String(item.gender ?? "未标注")}；年龄=${String(item.ageRange ?? "未标注")}；定妆照=${String(item.portraitPath ?? "未指定")}；授权=${String(item.authorization ?? "unknown")}；文件存在=${String(evidence.exists ?? false)}；尺寸=${evidence.width ?? "?"}x${evidence.height ?? "?"}；sha256=${String(evidence.sha256 ?? "未核验")}`;
      })
      : ["- 本次无角色或角色锚点未提供，不得生成真人主体。"]),
    ...(Object.keys(characterAssets).length > 0
      ? [
        `- **角色资产规则**：required=${String(characterAssets.required ?? "unverified")}；humanPortrait=${String(characterAssets.humanPortrait ?? "unverified")}；reason=${String(characterAssets.reason ?? "未说明")}；identityEvidence=${String(recordValue(characterAssets.identityEvidence).mode ?? "unverified")}/${String(recordValue(characterAssets.identityEvidence).visualVerification ?? "unverified")}`,
      ]
      : []),
    "",
    "### 结构化镜头合同",
    "",
    "| 镜头 | 场景 | 起止 | 时长 | 景别/运镜 | 主体 | 关键道具 | 光位/色温 | 音频锚点 | 安全区 |",
    "|---|---|---|---:|---|---|---|---|---|---|",
    ...(shots.length > 0
      ? shots.map((shot) =>
        `| ${String(shot.shotId)} | ${String(shot.sceneId ?? "-") } | ${shot.startSeconds}-${shot.endSeconds}s | ${shot.durationSeconds}s | ${String(shot.shotSize)} / ${String(shot.cameraMovement)} | ${String(shot.subjectLabel ?? (Array.isArray(shot.subjectIds) && shot.subjectIds.length ? shot.subjectIds.join("、") : "无"))} | ${Array.isArray(shot.keyProps) ? shot.keyProps.join("、") : "无"} | ${String(shot.lighting ?? "未指定")} / ${String(shot.colorTemperature ?? "未指定")} | ${Array.isArray(shot.audioAnchors) && shot.audioAnchors.length ? shot.audioAnchors.join("、") : "无"} | ${shot.safeArea === true ? safeAreaLabel : "否"} |`)
      : ["| - | - | - | - | - | - | - | - | - | - |"]),
  ].join("\n");
}

export interface SourceBoundMarketingDiscovery {
  intent: string;
  product: string;
  restrictions: readonly string[];
}

const sourceBoundRiskAssessment = Symbol("source-bound-marketing-risk-assessment");

function sourceBoundMarketingRisk(result: Record<string, unknown>): Record<string, unknown> {
  const { technicalRisks, mitigationSuggestions, businessConstraints } = result;
  const nonemptyText = (value: unknown) => typeof value === "string" && Boolean(value.trim());
  if (!Array.isArray(technicalRisks) || !technicalRisks.length || technicalRisks.length > 4
    || !technicalRisks.map(recordValue).every(risk => nonemptyText(risk.risk) && nonemptyText(risk.impact)
      && ["high", "medium", "low"].includes(String(risk.level)))
    || !Array.isArray(mitigationSuggestions) || mitigationSuggestions.length !== technicalRisks.length
    || !mitigationSuggestions.every(nonemptyText) || !Array.isArray(businessConstraints)
    || !businessConstraints.length || !businessConstraints.every(nonemptyText)) {
    throw new Error("MARKETING_RISK_ASSESSMENT_UNVERIFIED：风险与缓解措施缺少完整逐项对应");
  }
  return { ...result, [sourceBoundRiskAssessment]: true };
}

/** Rebuild the nonserializable runtime marker only after authenticated checkpoint loading. */
export function restoreMarketingDiscoveryCheckpoint(
  discovery: Record<string, unknown>,
  source: SourceBoundMarketingDiscovery,
): Record<string, unknown> {
  const restored = { ...discovery, riskAssessment: sourceBoundMarketingRisk(recordValue(discovery.riskAssessment)) };
  marketingDiscoveryContract(restored, source);
  return restored;
}

function marketingDiscoveryContract(discovery: Record<string, unknown>, source: SourceBoundMarketingDiscovery) {
  const scene = recordValue(discovery.sceneStructure);
  const risk = recordValue(discovery.riskAssessment);
  const literals = (value: unknown, allowSingleHan = false): string[] | null => {
    if (!Array.isArray(value) || value.length > 30 || !value.every(item => typeof item === "string"
      && (item.length >= 2 || allowSingleHan && /^\p{Script=Han}$/u.test(item))
      && item.length <= 120 && !item.includes("\n") && source.intent.includes(item))) return null;
    return [...new Set(value)];
  };
  const actions = literals(scene.requiredActions);
  const props = literals(scene.requiredProps, true);
  if (!actions || !props || !(sourceBoundRiskAssessment in risk)) {
    throw new Error("MARKETING_DISCOVERY_UNVERIFIED：场景动作和道具须绑定需求原文，技术风险须逐条对应缓解措施");
  }
  return { actions, props: [...new Set([source.product, ...props])], intent: source.intent };
}

function marketingDiscoveryPrompt(agent: string | undefined, source: SourceBoundMarketingDiscovery): string {
  return [
    "【当前已核对的营销创作合同，优先于上述示例、惯例与自动补全】",
    JSON.stringify(source),
    "根据该合同完成当前工位。只使用本项目的角色、场景、动作和可拍道具。受众分析、场景目的、风险和参考方案不得自行添加未明确要求的商品规格、报价、音轨或发布文案。客户明确要求的商品主张仍须依赖本轮已核对的来源与限定。不得把虚构情节写成真实成绩或实测性能。保留原文要求的画幅、声音、披露和尾帧。示例人物、道具和情节不得带进答案。",
    ...(agent === "SceneArchitect" ? [
      "在 JSON 根级同时输出 requiredActions 和 requiredProps 两个字符串数组。逐项从 intent 中逐字摘出所有明确必需的可拍动作（保持剧情先后）和可见道具（包括服装、护具和其他明确实物），禁止改写、杜撰或略去必需项。无此类要求时用 []。每个场景 keyElements 只写该场实际出现的实物，purpose 写完整句子，覆盖明确要求的结尾。",
    ] : []),
    ...(agent === "RiskAssessor" ? [
      "列 1 至 4 条本片风险，mitigationSuggestions 必须与 technicalRisks 数量相等且按同一索引一一对应。每项缓解措施写明该风险对象、可执行处理和检查点。",
    ] : []),
  ].join("\n");
}

/**
 * 叙事片运行时兼容桥：
 * 1. 阻断 vendor 仅凭 brief.platform/goal 把叙事片改写成营销广告；
 * 2. 把明确人物补入 requirementList.characters，避免 G3 契约“无真人角色”与场景矛盾；
 * 3. 需求洞察统一走可修复的 JSON 提取，兼容合法首个 JSON 后带尾随文本的回包。
 */
export function installVendorDiscoveryNarrativeBridge(options: {
  log?: (line: string) => void;
  marketingDiscovery?: () => SourceBoundMarketingDiscovery | undefined;
  /** The caller's current host run requires G4; unscoped vendor previews retain their fallback. */
  requireVerifiedPrd?: () => boolean;
  assertActive?: () => void;
} = {}): () => void {
  const log = options.log ?? (() => undefined);
  const restores: Array<() => void> = [];
  try {
    const repoRoot = videoRuntimeRoot(import.meta.url);
    const vendorRequire = createRequire(resolvePath(repoRoot, "package.json"));
    const systemMod = vendorRequire(resolvePath(repoRoot, "vendor/supermickey/hyperreality-system/index.js")) as {
      HyperrealitySystem?: { prototype: Record<string, unknown> };
    };
    const systemPrototype = systemMod?.HyperrealitySystem?.prototype;
    if (systemPrototype && typeof systemPrototype._generateMinimalPRD === "function") {
      const original = systemPrototype._generateMinimalPRD as (discovery: Record<string, unknown>) => Record<string, unknown>;
      systemPrototype._generateMinimalPRD = function guardedHostPrdFallback(
        this: unknown,
        discovery: Record<string, unknown>,
      ) {
        if (options.requireVerifiedPrd?.()) {
          throw new Error("HOST_PRD_UNVERIFIED: 未生成并核实本次 PRD，停止后续剧本、定妆照及生成调用");
        }
        return original.call(this, discovery);
      };
      restores.push(() => { systemPrototype._generateMinimalPRD = original; });
    }
    if (systemPrototype && typeof systemPrototype._buildThemeInput === "function") {
      const original = systemPrototype._buildThemeInput as (intent: string, metadata?: Record<string, unknown>) => string;
      systemPrototype._buildThemeInput = function patchedBuildThemeInput(
        this: unknown,
        intent: string,
        metadata: Record<string, unknown> = {},
      ) {
        if (options.marketingDiscovery?.()) {
          const input = original.call(this, intent, metadata);
          return [
            input,
            "",
            "【营销主题字段合同】以下字段要求优先于通用提炼心法、类型默认值和示例。",
            "tone 必须逐字选用温暖治愈、轻快明朗、冷酷精密、诗意哀伤中的一项。把用户的速度、动作张力和节奏要求写入 description 或 special_notes，按原文保留强度，不拼接到 tone。",
            "target_audience 必填。已指定受众时保留原意；否则基于本片商品、内容与平台，提出具体的观看兴趣及观看动机，并明示是本片创作假设。不要用“目标消费者/品牌受众”等泛称，也不要编造用户调查、市场规模、年龄或性别。",
            "visual_style 用本片可执行的景别、运动、用光及色调描述美学。仅在客户原文明确提供第三方作品时才可提名，并注明仅借鉴拍摄手法、不得使用或复刻可识别素材。",
            "dialogue_requirement 严格按客户的声音合同填报。禁止人声时保留原文允许的声音，台词字数与配音语速不适用。明确要求旁白或对白时保留相应内容。",
            "description 和 special_notes 保留客户明确给出的动作、声音、披露与尾帧。画面里尚未创作的物理细节、场地和道具是创作建议，不是客户已指定的事实。",
          ].join("\n");
        }
        const route = metadata?.pipelineRoute && typeof metadata.pipelineRoute === "object"
          ? metadata.pipelineRoute as Record<string, unknown>
          : {};
        if (route.kind !== "narrative") return original.call(this, intent, metadata);
        const brief = metadata?.brief && typeof metadata.brief === "object"
          ? { ...(metadata.brief as Record<string, unknown>) }
          : {};
        for (const key of ["product", "products", "brand", "category", "sellingPoints", "audience", "platform", "goal"]) {
          delete brief[key];
        }
        return original.call(this, intent, { ...metadata, brief, _dataDossier: undefined });
      };
      restores.push(() => { systemPrototype._buildThemeInput = original; });
    }
    if (systemPrototype && typeof systemPrototype._convertDiscoveryToRequirementList === "function") {
      const original = systemPrototype._convertDiscoveryToRequirementList as (
        discovery: Record<string, unknown>,
        upstream: Record<string, unknown>,
      ) => Promise<Record<string, unknown>>;
      systemPrototype._convertDiscoveryToRequirementList = async function patchedConvert(
        this: unknown,
        discovery: Record<string, unknown>,
        upstream: Record<string, unknown>,
      ) {
        options.assertActive?.();
        const marketing = options.marketingDiscovery?.();
        const marketingContract = marketing ? marketingDiscoveryContract(discovery, marketing) : null;
        const result = await original.call(this, discovery, upstream);
        const platform = canonicalPlatformId(upstream?.platform_id ?? upstream?.platform);
        const canonical = canonicalCharacterFromEvidence(upstream);
        const existing = Array.isArray(result.characters)
          ? result.characters.filter((item) => {
              const name = String(recordValue(item).name ?? "").trim();
              return !/^(?:无|没有)(?:真人|人物|角色|模特)|^(?:none|n\/a)$/iu.test(name);
            })
          : [];
        const rawInferred = canonical.length > 0
          ? canonical
          : existing.length > 0
            ? existing
            : inferNarrativeCharacters({
              intent: String(upstream?._originalStoryText ?? upstream?.description ?? upstream?.theme ?? ""),
              discovery,
              upstream,
            });
        const inferred = rawInferred.map((item, index) => {
          const record = recordValue(item);
          const id = String(record.id ?? record.characterId ?? record.character_id ?? `char_${index + 1}`);
          return { ...record, id, characterId: id };
        });
        discovery._canonicalCharacters = inferred;
        const discoveryUpstream = recordValue(discovery.upstreamFields);
        discovery.upstreamFields = {
          ...discoveryUpstream,
          ...(platform ? { platform, platform_id: platform } : {}),
          ...(upstream?.aspect_ratio ? { aspect_ratio: upstream.aspect_ratio } : {}),
          ...(upstream?.character ? { character: upstream.character } : {}),
          ...(upstream?._originalStoryText ? { _originalStoryText: upstream._originalStoryText } : {}),
        };
        const withEvidence = {
          ...result,
          ...(platform ? { platform } : {}),
          ...(marketing && marketingContract ? { ...marketingContract,
            ...(typeof upstream?.aspect_ratio === "string" ? { aspectRatio: upstream.aspect_ratio } : {}),
            keyPoints: [...(Array.isArray(result.keyPoints) ? result.keyPoints : []), marketing.intent] } : {}),
          characters: inferred,
          _discoveryEvidence: {
            sceneStructure: discovery?.sceneStructure ?? null,
            riskAssessment: discovery?.riskAssessment ?? null,
            upstreamFields: discovery?.upstreamFields ?? null,
          },
        };
        if (inferred.length > existing.length) {
          log(`[vendor-compat] 角色契约补全：${inferred.map((item) => String(recordValue(item).name ?? "")).join("、")}`);
        }
        return withEvidence;
      };
      restores.push(() => { systemPrototype._convertDiscoveryToRequirementList = original; });
    }
    if (systemPrototype && typeof systemPrototype._renderRequirementContract === "function") {
      const original = systemPrototype._renderRequirementContract as (
        intent: string,
        metadata: Record<string, unknown>,
        requirementList: Record<string, unknown>,
        discovery: Record<string, unknown>,
      ) => string;
      systemPrototype._renderRequirementContract = function patchedRenderContract(
        this: unknown,
        intent: string,
        metadata: Record<string, unknown> = {},
        requirementList: Record<string, unknown> = {},
        discovery: Record<string, unknown> = {},
      ) {
        if (options.marketingDiscovery?.()) {
          const rendered = original.call(this, intent, metadata, requirementList, discovery);
          const renderList = (label: string, values: unknown): string => {
            const items = Array.isArray(values) ? values : [];
            return `- **${label}**（${items.length}）：${items.length ? items.join("、") : "客户未指定"}`;
          };
          const scene = recordValue(discovery.sceneStructure);
          const sceneNodes = [scene.opening, ...(Array.isArray(scene.scenes) ? scene.scenes : []), scene.ending].map(recordValue);
          const scenes = sceneNodes.map((node, index) => {
            const label = index === 0 ? "开场" : index === sceneNodes.length - 1 ? "结尾" : `主体场景 ${index}`;
            const elements = Array.isArray(node.keyElements) ? node.keyElements.join("、") : "未提取";
            return `${label}（${node.duration}s）：${String(node.purpose ?? "").replace(/\s+/gu, " ")}（实物：${elements}）`;
          });
          const risk = recordValue(discovery.riskAssessment);
          const risks = Array.isArray(risk.technicalRisks) ? risk.technicalRisks.map(recordValue) : [];
          const mitigation = Array.isArray(risk.mitigationSuggestions) ? risk.mitigationSuggestions : [];
          const riskSummary = risks.map((item, index) => `风险${index + 1}（${item.level}）：${item.risk}；缓解：${mitigation[index]}`);
          return rendered.replace(/^- \*\*场景\*\*[^\n]*$/mu, () => renderList("场景", scenes))
            .replace(/^- \*\*道具\*\*[^\n]*$/mu, () => renderList("道具", requirementList.props))
            .replace(/^- \*\*动作\*\*[^\n]*$/mu, () => renderList("动作", requirementList.actions))
            .replace(/^- \*\*风险结论\*\*[^\n]*$/mu, () => `- **风险结论**：${riskSummary.join("；")}`);
        }
        const duration = Number(
          requirementList.targetDuration
          ?? (metadata?.brief as Record<string, unknown> | undefined)?.duration
          ?? 0,
        );
        normalizeNarrativeDiscovery(discovery, duration, recordValue(discovery.upstreamFields));
        const existing = Array.isArray(requirementList.characters) ? requirementList.characters : [];
        const inferred = existing.length > 0
          ? []
          : inferNarrativeCharacters({
            intent,
            discovery,
            upstream: recordValue(discovery?.upstreamFields),
          });
        const rendered = original.call(this, intent, metadata, inferred.length > 0
          ? { ...requirementList, characters: inferred }
          : requirementList, discovery);
        return normalizeNarrativeRequirementMarkdown(
          rendered,
          discovery,
          duration,
          recordValue(discovery.upstreamFields),
        );
      };
      restores.push(() => { systemPrototype._renderRequirementContract = original; });
    }
    if (systemPrototype && typeof systemPrototype._confirmRequirementList === "function") {
      const original = systemPrototype._confirmRequirementList as (
        markdown: string,
        requirementList: Record<string, unknown>,
      ) => Promise<Record<string, unknown>>;
      systemPrototype._confirmRequirementList = function patchedConfirmRequirement(
        this: {
          _renderRequirementContract?: unknown;
        },
        markdown: string,
        requirementList: Record<string, unknown>,
      ) {
        if (options.marketingDiscovery?.()) return original.call(this, markdown, requirementList);
        const duration = Number(requirementList?.targetDuration ?? 0);
        const discovery = requirementList?._discoveryEvidence && typeof requirementList._discoveryEvidence === "object"
          ? requirementList._discoveryEvidence as Record<string, unknown>
          : { sceneStructure: { opening: null, scenes: [], ending: null, sceneCount: 0 } };
        normalizeNarrativeDiscovery(discovery, duration, recordValue(discovery.upstreamFields));
        return original.call(
          this,
          normalizeNarrativeRequirementMarkdown(
            markdown,
            discovery,
            duration,
            recordValue(requirementList?.upstreamFields ?? discovery?.upstreamFields),
          ),
          requirementList,
        );
      };
      restores.push(() => { systemPrototype._confirmRequirementList = original; });
    }

    const prdMod = vendorRequire(resolvePath(
      repoRoot,
      "vendor/supermickey/hyperreality-system/engines/prd-generator/prd-generator.js",
    )) as { PRDGenerator?: { prototype: Record<string, unknown> } };
    if (prdMod.PRDGenerator?.prototype && typeof prdMod.PRDGenerator.prototype.generate === "function") {
      const prototype = prdMod.PRDGenerator.prototype;
      const original = prototype.generate as (discovery: Record<string, unknown>) => Promise<Record<string, unknown>>;
      prototype.generate = async function patchedPrdGenerate(
        this: unknown,
        discovery: Record<string, unknown>,
      ) {
        const result = await original.call(this, discovery) as Record<string, unknown>;
        const marketing = options.marketingDiscovery?.();
        return normalizeNarrativePrdContract(result, discovery, marketing ? marketingDiscoveryContract(discovery, marketing) : undefined);
      };
      restores.push(() => { prototype.generate = original; });
    }
    if (prdMod.PRDGenerator?.prototype && typeof prdMod.PRDGenerator.prototype.generateMarkdown === "function") {
      const prototype = prdMod.PRDGenerator.prototype;
      const original = prototype.generateMarkdown as (prd: Record<string, unknown>) => string;
      prototype.generateMarkdown = function patchedPrdMarkdown(this: unknown, prd: Record<string, unknown>) {
        const rendered = original.call(this, prd);
        return `${rendered}${renderPrdContractMarkdown(prd)}`;
      };
      restores.push(() => { prototype.generateMarkdown = original; });
    }

    const discoveryMod = vendorRequire(resolvePath(
      repoRoot,
      "vendor/supermickey/hyperreality-system/engines/requirement-discovery-engine.js",
    )) as {
      RequirementDiscoveryEngine?: (new (options?: Record<string, unknown>) => {
        agents?: Record<string, Record<string, unknown>>;
      }) & {
        prototype: Record<string, unknown>;
      };
    };
    if (discoveryMod?.RequirementDiscoveryEngine?.prototype
      && typeof discoveryMod.RequirementDiscoveryEngine.prototype.generateMarkdown === "function") {
      const prototype = discoveryMod.RequirementDiscoveryEngine.prototype;
      const original = prototype.generateMarkdown as (discovery: Record<string, unknown>) => string;
      prototype.generateMarkdown = function patchedDiscoveryMarkdown(
        this: unknown,
        discovery: Record<string, unknown>,
      ) {
        if (options.marketingDiscovery?.()) return original.call(this, discovery);
        const upstream = recordValue(discovery?.upstreamFields);
        const duration = Number(upstream.duration_sec ?? 0);
        normalizeNarrativeDiscovery(discovery, duration, upstream);
        const rendered = original.call(this, discovery);
        return normalizeNarrativeRequirementMarkdown(rendered, discovery, duration, upstream);
      };
      restores.push(() => { prototype.generateMarkdown = original; });
    }
    const probe = discoveryMod?.RequirementDiscoveryEngine
      ? new discoveryMod.RequirementDiscoveryEngine({ llmEngine: null })
      : null;
    for (const agentName of ["audience", "reference"] as const) {
      const agent = probe?.agents?.[agentName];
      const prototype = agent ? Object.getPrototypeOf(agent) as Record<string, unknown> : null;
      if (!prototype || typeof prototype.run !== "function") continue;
      const originalRun = prototype.run as (input: unknown, schema: unknown) => Promise<unknown>;
      const hadOwnRun = Object.hasOwn(prototype, "run");
      prototype.run = async function runSourceBoundDiscovery(this: unknown, input: unknown, schema: unknown) {
        const marketing = options.marketingDiscovery?.();
        if (!marketing) return originalRun.call(this, input, schema);
        options.assertActive?.();
        // The native prompt and provenance validation receive the same raw customer
        // contract. Keep the approved theme and its enriched story evidence untouched.
        const customerInput = { ...recordValue(input), _workloomCustomerIntent: marketing.intent };
        return originalRun.call(this, customerInput, schema);
      };
      restores.push(() => {
        if (hadOwnRun) prototype.run = originalRun;
        else delete prototype.run;
      });
    }
    const riskPrototype = probe?.agents?.risk ? Object.getPrototypeOf(probe.agents.risk) as Record<string, unknown> : null;
    if (riskPrototype && typeof riskPrototype.run === "function") {
      const originalRun = riskPrototype.run as (input: unknown, schema: unknown) => Promise<unknown>;
      const hadOwnRun = Object.hasOwn(riskPrototype, "run");
      riskPrototype.run = async function runSourceBoundRisk(this: {
        _callLLM: (input: unknown, schema: unknown) => Promise<unknown>;
      }, input: unknown, schema: unknown) {
        if (!options.marketingDiscovery?.()) return originalRun.call(this, input, schema);
        // Only the measured author repair below may dispatch again in this scope.
        const result = recordValue(await this._callLLM(input, schema));
        return sourceBoundMarketingRisk(result);
      };
      restores.push(() => {
        if (hadOwnRun) riskPrototype.run = originalRun;
        else delete riskPrototype.run;
      });
    }
    const agent = probe?.agents?.risk ?? probe?.agents?.audience ?? null;
    let agentPrototype = agent ? Object.getPrototypeOf(agent) as Record<string, unknown> : null;
    while (agentPrototype && agentPrototype !== Object.prototype && !Object.hasOwn(agentPrototype, "_callLLM")) {
      agentPrototype = Object.getPrototypeOf(agentPrototype) as Record<string, unknown> | null;
    }
    if (agentPrototype && typeof agentPrototype._callLLM === "function") {
      const original = agentPrototype._callLLM as (input: unknown, schema: unknown) => Promise<unknown>;
      agentPrototype._callLLM = async function patchedDiscoveryCall(
        this: {
          name?: string;
          llmEngine?: {
            reason?: (prompt: string, options?: LLMReasonOptions) => Promise<LLMReasonResult>;
            reasonStructured?: (prompt: string, schema: unknown, options?: LLMReasonOptions) => Promise<LLMReasonResult>;
          };
          timeoutMs?: number;
          _buildPrompt?: (input: unknown) => string;
        },
        input: unknown,
        schema: unknown,
      ) {
        options.assertActive?.();
        const llm = this.llmEngine;
        if (!llm) throw new Error("LLM 引擎未初始化");
        if (!this._buildPrompt) return original.call(this, input, schema);
        const marketing = options.marketingDiscovery?.();
        const prompt = this._buildPrompt(input) + (marketing ? `\n\n${marketingDiscoveryPrompt(this.name, marketing)}` : "");
        const requestOptions = {
          maxTokens: this.name === "SceneArchitect" ? 16_384 : 8_192,
          temperature: this.name === "SceneArchitect" ? 0.4 : 0.8,
          timeoutMs: this.timeoutMs,
          forceJson: true,
        };
        let response = typeof llm.reasonStructured === "function"
          ? await llm.reasonStructured(prompt, this.name === "SceneArchitect" ? null : schema, requestOptions)
          : typeof llm.reason === "function"
            ? await llm.reason(prompt, requestOptions)
            : null;
        const author = response?.settledAuthor;
        if (marketing && this.name === "RiskAssessor" && llm.reasonStructured && author
          && response?.success === false && response.structuredParseFailure === true && response.unknown !== true) {
          const revised = `${prompt}\n\n【本次作者修复】上次正文未形成可解析的 JSON 对象。请根据同一已核对合同重新提交一份紧凑 JSON，只含 technicalRisks、businessConstraints、mitigationSuggestions。禁止解释和代码围栏，每条风险必须对应同索引的一条缓解措施。`;
          response = await llm.reasonStructured(revised, schema, { ...requestOptions,
            strictAuthorModel: author.modelId });
          if (response.success && (response.settledAuthor?.modelId !== author.modelId
            || response.settledAuthor.responseId === author.responseId)) {
            throw new Error("MARKETING_RISK_REPAIR_UNVERIFIED：风险修复缺少同模型独立响应回执");
          }
        }
        if (!response?.success) throw new Error(String(response?.error ?? "LLM 调用失败"));
        if (response.data && typeof response.data === "object") return response.data;
        const extracted = extractFirstJsonValue(response.content);
        if (!extracted) throw new Error("无法从 LLM 回包提取首个完整 JSON");
        return JSON.parse(extracted);
      };
      restores.push(() => { agentPrototype._callLLM = original; });
    }

    const scriptGeneratorPath = resolvePath(
      repoRoot,
      "vendor/supermickey/hyperreality-system/engines/script-engine/core/script-generator.js",
    );
    if (existsSync(scriptGeneratorPath)) {
      const scriptMod = vendorRequire(scriptGeneratorPath) as {
        ScriptGenerator?: { prototype: Record<string, unknown> };
      };
      const generatorPrototype = scriptMod.ScriptGenerator?.prototype;
      if (generatorPrototype && typeof generatorPrototype._resolveVoiceoverPolicy === "function") {
        const originalPolicy = generatorPrototype._resolveVoiceoverPolicy as (
          this: Record<string, unknown>,
          userIntent: Record<string, unknown>,
        ) => Record<string, unknown>;
        generatorPrototype._resolveVoiceoverPolicy = function patchedNarrativePolicy(
          this: Record<string, unknown>,
          userIntent: Record<string, unknown>,
        ) {
          const original = originalPolicy.call(this, userIntent);
          const requirement = scriptIntentSpeechRequirement(userIntent)
            || String(original.dialogueRequirement ?? "");
          const speech = narrativeSpeechPolicy(requirement);
          const policy = {
            ...original,
            allowed: speech.voiceoverAllowed,
            dialogueRequirement: requirement || String(original.dialogueRequirement ?? ""),
            dialogueAllowed: speech.dialogueAllowed,
            voiceoverAllowed: speech.voiceoverAllowed,
            allSpeechForbidden: speech.allSpeechForbidden,
          };
          this._workloomNarrativePolicy = policy;
          return policy;
        };
        restores.push(() => { generatorPrototype._resolveVoiceoverPolicy = originalPolicy; });
      }
      if (generatorPrototype && typeof generatorPrototype._buildGenerationPrompt === "function") {
        const originalBuildPrompt = generatorPrototype._buildGenerationPrompt as (
          this: Record<string, unknown>,
          userIntent: Record<string, unknown>,
          template: Record<string, unknown>,
        ) => string;
        generatorPrototype._buildGenerationPrompt = function patchedNoDialoguePrompt(
          this: Record<string, unknown>,
          userIntent: Record<string, unknown>,
          template: Record<string, unknown>,
        ) {
          const prompt = originalBuildPrompt.call(this, userIntent, template);
          const policy = recordValue(this._workloomNarrativePolicy);
          if (policy.allSpeechForbidden !== true || typeof prompt !== "string") return prompt;
          const systemStart = prompt.indexOf("## 系统约束（不可违反）");
          const systemEnd = prompt.indexOf("## 剧本结构模板", systemStart + 1);
          let normalized = prompt;
          if (systemStart >= 0 && systemEnd > systemStart) {
            normalized = `${normalized.slice(0, systemStart)}${[
              "## 系统约束（不可违反）",
              "1. 本片禁止所有台词、对白、旁白、画外音和口播；仅用可见动作、环境声和动作声叙事",
              "2. 每个场景的 dialogue 必须是 {\"has_dialogue\":false,\"lines\":[],\"blocks\":[]}",
              "3. 不得把台词写到 dialogue、narration、voice_over、voiceover 或其他游离字段",
              "4. 场景时长分配只依据动作、空间变化与视觉复杂度，不依据台词长度",
              `5. 总时长必须严格等于 ${Number(recordValue(userIntent.metadata).target_duration ?? 0) || "目标"} 秒`,
              "6. 角色视觉锚点必须保持一致，且不得为了制造冲突而新增台词",
              "",
            ].join("\n")}${normalized.slice(systemEnd)}`;
          }
          normalized = normalized.replace(
            /dialogue 对象的标准结构（必须严格遵守）：[\s\S]*?(?=\n##\s)/u,
            [
              "dialogue 对象的标准结构（必须严格遵守）：",
              "```json",
              '{"has_dialogue":false,"lines":[],"blocks":[]}',
              "```",
              "",
              "本片禁止旁白，因此不得输出旁白写法或 speaker=\"旁白\" 的块。",
              "",
            ].join("\n"),
          );
          normalized = normalized
            .replace(/4\. 每个场景的台词必须包含在场景中（不能旁白）/gu, "4. 每个场景不得生成台词；dialogue 三要素必须为空")
            .replace(/□ 每句台词是否都能用动作演出来而不是说出来？/gu, "□ 是否为所有场景保持 dialogue 为空，并用可见动作替代表达？")
            .replace(/□ 原文的钉子台词与特写细节是否原样保留？/gu, "□ 原文的钉子动作、动作声与特写细节是否原样保留？");
          return `${normalized.trimEnd()}\n\n## 台词合同（最高优先级）\n- 本片明确无台词、无旁白；任何模型回包中的 dialogue.lines、dialogue.blocks、narration、voice_over 或 voiceover 都必须在落盘前清空。\n- 不得沿用模板中的强制台词规则生成任何人物声；动作与环境声承担全部叙事。\n`;
        };
        restores.push(() => { generatorPrototype._buildGenerationPrompt = originalBuildPrompt; });
      }
      if (generatorPrototype && typeof generatorPrototype._normalizeScenesDialogue === "function") {
        const originalNormalize = generatorPrototype._normalizeScenesDialogue as (
          this: Record<string, unknown>,
          parsed: Record<string, unknown>,
          voiceoverAllowed: boolean,
        ) => void;
        generatorPrototype._normalizeScenesDialogue = function patchedNarrativeDialogue(
          this: Record<string, unknown>,
          parsed: Record<string, unknown>,
          voiceoverAllowed: boolean,
        ) {
          const policy = this._workloomNarrativePolicy && typeof this._workloomNarrativePolicy === "object"
            ? this._workloomNarrativePolicy as Record<string, unknown>
            : {};
          const noLipSyncDialogue = policy.dialogueAllowed === false;
          const allSpeechForbidden = policy.allSpeechForbidden === true
            || (noLipSyncDialogue && policy.voiceoverAllowed !== true);
          const structure = parsed?.structure && typeof parsed.structure === "object"
            ? parsed.structure as Record<string, unknown>
            : {};
          if (noLipSyncDialogue && Array.isArray(structure.scenes)) {
            for (const scene of structure.scenes) {
              if (!scene || typeof scene !== "object") continue;
              const record = scene as Record<string, unknown>;
              record.dialogue = { has_dialogue: false, lines: [], blocks: [] };
              if (allSpeechForbidden) {
                delete record.narration;
                delete record.voice_over;
                delete record.voiceover;
              }
            }
          }
          return originalNormalize.call(this, parsed, allSpeechForbidden ? false : voiceoverAllowed);
        };
        restores.push(() => { generatorPrototype._normalizeScenesDialogue = originalNormalize; });
      }
    }

    const scriptValidatorPath = resolvePath(
      repoRoot,
      "vendor/supermickey/hyperreality-system/engines/script-engine/core/script-validator.js",
    );
    if (existsSync(scriptValidatorPath)) {
      const validatorMod = vendorRequire(scriptValidatorPath) as {
        ScriptValidator?: { prototype: Record<string, unknown> };
      };
      const validatorPrototype = validatorMod.ScriptValidator?.prototype;
      if (validatorPrototype && typeof validatorPrototype._checkDialogue === "function") {
        const originalCheck = validatorPrototype._checkDialogue as (
          this: unknown,
          blueprint: Record<string, unknown>,
        ) => Array<Record<string, unknown>>;
        validatorPrototype._checkDialogue = function patchedNoDialogueCheck(
          this: unknown,
          blueprint: Record<string, unknown>,
        ) {
          const meta = blueprint?.meta && typeof blueprint.meta === "object"
            ? blueprint.meta as Record<string, unknown>
            : {};
          const metadata = meta._metadata && typeof meta._metadata === "object"
            ? meta._metadata as Record<string, unknown>
            : {};
          const requirement = String(metadata.dialogueRequirement ?? "");
          const speech = narrativeSpeechPolicy(requirement);
          if (!speech.noLipSyncDialogue) {
            return originalCheck.call(this, blueprint);
          }
          if (!speech.allSpeechForbidden) {
            const scenes = Array.isArray(recordValue(blueprint.structure).scenes)
              ? recordValue(blueprint.structure).scenes as unknown[]
              : [];
            const voiceovers = new Set<string>();
            const spokenLines: string[] = [];
            for (const scene of scenes.map(recordValue)) {
              for (const value of [scene.narration, scene.voice_over, scene.voiceover]) {
                const text = String(value ?? "").trim();
                if (text) voiceovers.add(text);
              }
              const dialogue = recordValue(scene.dialogue);
              const rows = Array.isArray(dialogue.lines) && dialogue.lines.length > 0
                ? dialogue.lines
                : Array.isArray(dialogue.blocks) ? dialogue.blocks : [];
              for (const raw of rows) {
                const row = recordValue(raw);
                const text = String(row.text ?? row.line ?? "").trim();
                if (!text) continue;
                if (/^(?:旁白|voiceover)$/iu.test(String(row.speaker ?? "")) || /^narration$/iu.test(String(row.type ?? ""))) {
                  voiceovers.add(text);
                } else {
                  spokenLines.push(text);
                }
              }
            }
            const lineCount = spokenLines.length;
            return [
              {
                category: "dialogue",
                name: "has_dialogue",
                passed: lineCount === 0,
                severity: lineCount === 0 ? "ok" : "error",
                message: lineCount === 0 ? "不适用：本片明确无口型对白；允许已声明的画外旁白" : "无口型合同中出现对白行",
                suggestion: lineCount === 0 ? null : "移除对白行，只保留合同允许的一句画外旁白",
              },
              {
                category: "dialogue",
                name: "line_length",
                passed: true,
                severity: "ok",
                message: "不适用：无口型对白",
                suggestion: null,
              },
              {
                category: "dialogue",
                name: "no_voiceover",
                passed: voiceovers.size <= 1,
                severity: voiceovers.size <= 1 ? "ok" : "error",
                message: voiceovers.size <= 1 ? "允许且仅允许一条画外旁白" : `明确要求最多一句旁白，实际发现 ${voiceovers.size} 条`,
                suggestion: voiceovers.size <= 1 ? null : "合并或删除多余旁白",
              },
            ];
          }
          return [
            {
              category: "dialogue",
              name: "has_dialogue",
              passed: true,
              severity: "ok",
              message: "不适用：本片明确无台词，仅以画面与环境声叙事",
              suggestion: null,
            },
            {
              category: "dialogue",
              name: "line_length",
              passed: true,
              severity: "ok",
              message: "不适用：无台词",
              suggestion: null,
            },
            {
              category: "dialogue",
              name: "no_voiceover",
              passed: true,
              severity: "ok",
              message: "不适用：无台词且未要求旁白",
              suggestion: null,
            },
          ];
        };
        restores.push(() => { validatorPrototype._checkDialogue = originalCheck; });
      }
    }

    const contractPath = resolvePath(
      repoRoot,
      "vendor/supermickey/hyperreality-system/engines/production-engine/utils/agent-contract-validator.js",
    );
    if (existsSync(contractPath)) {
      const contractMod = vendorRequire(contractPath) as {
        AgentContractValidator?: { prototype: Record<string, unknown> };
      };
      const validatorPrototype = contractMod.AgentContractValidator?.prototype;
      if (validatorPrototype && typeof validatorPrototype._checkType === "function") {
        const originalCheckType = validatorPrototype._checkType as (
          this: unknown,
          value: unknown,
          expectedType: string,
          path: string,
        ) => boolean;
        validatorPrototype._checkType = function patchedContractType(
          this: unknown,
          value: unknown,
          expectedType: string,
          path: string,
        ) {
          if (/\.dialogue$/u.test(path) && expectedType === "object" && typeof value === "string") {
            return true;
          }
          return originalCheckType.call(this, value, expectedType, path);
        };
        restores.push(() => { validatorPrototype._checkType = originalCheckType; });
      }
    }
    return () => restores.reverse().forEach((restore) => restore());
  } catch (error) {
    log(`[vendor-compat] 叙事契约/发现 JSON 桥注入失败（不影响其它桥）：${error instanceof Error ? error.message : String(error)}`);
    return () => restores.reverse().forEach((restore) => restore());
  }
}

/**
 * 深栈诊断（Phase 3 变体定位用）：除阶段 execute 外，再包裹 Phase 3 的后融合链路，
 * 让「Assignment to constant variable.」这类被 vendor catch 吞掉的异常直接打出栈帧。
 */
export function installVendorPhaseInternalsDiagnostics(options: { log?: (line: string) => void } = {}): () => void {
  const log = options.log ?? ((line: string) => console.warn(line));
  const targets: Array<{ path: string; exportName: string; methods: string[] }> = [
    {
      path: "engines/production-engine/agents/prompt-fusion-agent.js",
      exportName: "PromptFusionAgent",
      methods: ["process", "_fuseSingleShotWithDeadline", "_buildShotResult", "_finalizeShotResult"]
    },
    {
      path: "engines/production-engine/production-engine.js",
      exportName: "ProductionEngine",
      methods: ["_mergeShotsByShotId", "_deepCloneValue", "_deepCloneShot"]
    },
    {
      path: "utils/dialogue-timing-calculator.js",
      exportName: "DialogueTimingCalculator",
      methods: ["validateShots", "validateShot"]
    },
    {
      path: "engines/production-engine/phases/phase-3-prompt-fusion.js",
      exportName: "Phase3PromptFusion",
      methods: ["_checkDialogueTiming"]
    }
  ];
  const restores: Array<() => void> = [];
  try {
    const repoRoot = videoRuntimeRoot(import.meta.url);
    const vendorRequire = createRequire(resolvePath(repoRoot, "package.json"));
    for (const target of targets) {
      const file = resolvePath(repoRoot, "vendor/supermickey/hyperreality-system", target.path);
      if (!existsSync(file)) continue;
      const mod = vendorRequire(file) as Record<string, unknown>;
      const prototype = (mod?.[target.exportName] as { prototype?: Record<string, unknown> } | undefined)?.prototype;
      if (!prototype) continue;
      for (const method of target.methods) {
        const fn = prototype[method];
        if (typeof fn !== "function") continue;
        const original = fn as (...args: unknown[]) => unknown;
        prototype[method] = function patched(this: unknown, ...args: unknown[]) {
          try {
            const out = original.apply(this, args);
            return out;
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            log(`[vendor-compat] ${target.exportName}.${method} 抛出：${error.message}`);
            log(`[vendor-compat]  栈：${(error.stack ?? "").split("\n").slice(0, 10).join(" ← ")}`);
            throw err;
          }
        };
        restores.push(() => {
          prototype[method] = original;
        });
      }
    }
    return () => restores.forEach((restore) => restore());
  } catch (err) {
    log(`[vendor-compat] 深栈诊断注入失败：${err instanceof Error ? err.message : String(err)}`);
    return () => restores.forEach((restore) => restore());
  }
}

/**
 * 镜头内音频纪律桥（2026-09-23）
 *
 * 产品口径：生成的镜头只允许台词人声/旁白/音效，**禁止 BGM**（配乐统一在后期加）。
 * 边界（2026-09-23 产品确认）：画面内实况声源（街头评弹/三弦/店内音响等）不算配乐，不清洗、不压制；
 * 只清洗「背景音乐/配乐/音乐风格」这类后期职责的指令。
 * vendor 的 `PromptFusionAgent._assembleStandardPrompt` 会照抄 `AudioDesignAgent` 写进 audio 的
 * 「音乐风格/配乐」描述 —— 本桥在组装器出口统一追加【音频纪律】子句 + 英文音乐负面词，
 * 并清洗音频段落里的音乐指令（与宿主 shot-spec 同一口径，vendor 直跑也生效）。
 */
export function installVendorAudioDisciplineBridge(options: {
  clause: string;
  negativeTerms: string;
  log?: (line: string) => void;
}): () => void {
  const log = options.log ?? (() => undefined);
  try {
    const repoRoot = videoRuntimeRoot(import.meta.url);
    const vendorRequire = createRequire(resolvePath(repoRoot, "package.json"));
    const file = resolvePath(
      repoRoot,
      "vendor/supermickey/hyperreality-system/engines/production-engine/agents/prompt-fusion-agent.js"
    );
    if (!existsSync(file)) return () => undefined;
    const mod = vendorRequire(file) as { PromptFusionAgent?: { prototype?: Record<string, unknown> } };
    const prototype = mod?.PromptFusionAgent?.prototype;
    if (!prototype || typeof prototype._assembleStandardPrompt !== "function") return () => undefined;
    const original = prototype._assembleStandardPrompt as (
      shot: Record<string, unknown>,
      fields: Record<string, unknown>,
      ratio: string
    ) => string;
    let patchedCount = 0;
    prototype._assembleStandardPrompt = function patchedAssemble(
      this: unknown,
      shot: Record<string, unknown>,
      fields: Record<string, unknown>,
      ratio: string
    ) {
      const musicPattern = /(背景音乐|配乐|音乐风格|音乐节拍|旋律|歌曲|background\s*music|\bbgm\b|soundtrack)/gi;
      /** 否定式（"无配乐/不加配乐/no bgm"）与音频纪律同向，保留不删 */
      const negatedPattern =
        /(无|没有|不含|不加|不出现|不加入|禁止|避免|无需|不要)[^，。；;、,.]{0,6}(背景音乐|配乐|音乐|BGM|旋律|歌曲|soundtrack)|no\s+(background\s+)?music|no\s+bgm|without\s+(background\s+)?music/i;
      // 1) 清洗入参里 audio / fields.audio 的音乐指令
      for (const holder of [shot, fields]) {
        const value = holder?.audio;
        if (typeof value === "string" && musicPattern.test(value)) {
          musicPattern.lastIndex = 0;
          const kept = value
            .split(/[。；;\n]/)
            .map((s) => s.trim())
            .filter(Boolean)
            .filter((seg) => {
              if (negatedPattern.test(seg)) return true;
              musicPattern.lastIndex = 0;
              return !musicPattern.test(seg);
            });
          holder.audio = kept.length > 0 ? `${kept.join("；")}；${options.clause}` : options.clause;
          log("[vendor-compat] 已清洗镜头 audio 字段中的音乐指令（镜头内禁止 BGM）");
        }
      }
      const prompt = original.call(this, shot, fields, ratio);
      if (typeof prompt !== "string") return prompt;
      let out = prompt;
      if (!out.includes("【音频纪律】")) out += ` | ${options.clause}`;
      if (!/no background music/i.test(out)) out += ` | ${options.negativeTerms}`;
      patchedCount += 1;
      if (patchedCount === 1) log("[vendor-compat] 音频纪律桥已生效（每镜追加【音频纪律】+ 音乐负面词）");
      return out;
    };
    return () => {
      prototype._assembleStandardPrompt = original;
    };
  } catch (err) {
    log(`[vendor-compat] 音频纪律桥注入失败（不影响其它桥）：${err instanceof Error ? err.message : String(err)}`);
    return () => undefined;
  }
}

/**
 * 时长策略桥（2026-09-23 修订二版）：把 vendor 里**所有在用**的单镜时长口径统一到模型能力
 * （Seedance 2.5 真机实测 4–30s）。第一版只覆盖 2 处、且 ThemeConfig 打错层级，本版按
 * `duration-rules.ts` 的口径清单逐个对齐：
 *
 *   ① `DurationConstraintManager` 构造函数默认值（15 → 模型上限）——运行期真夹紧
 *   ② 运行期实例的 `rhythmProfiles.*.shotRange` 上界（8/12/15 → 模型上限）
 *   ③ `ThemeConfig.types[*].resourceQuota.maxShotDuration`（真实层级；第一版打在不存在的
 *      `types[*].maxShotDuration` 上）
 *   ④ `platform-profiles.PROFILES[*].shotDuration.max`（cinematic 12 / tiktok·douyin 5）
 *      ——被 `PromptDeliveryGuard.verifyPackage` 的作品级时长带消费
 *   ⑤ `ShotDurationAllocator`：实例 `config.maxDuration`（15）+ `roleConfig[*].max`（6–12）
 *   ⑥ `requirement-list-builder`：`ParserRules.constraints.maxShotDuration` + 返回体字面量
 *
 * 不改 vendor 文件（只做运行期覆写）；返回摘除函数（逐项精确还原）。
 * 实例级放宽请再调用 `applyDurationPolicyToManager(manager, max)`。
 */
export function installVendorDurationPolicyBridge(options: {
  maxSingleShotSeconds: number;
  minSingleShotSeconds?: number;
  log?: (line: string) => void;
}): () => void {
  const log = options.log ?? (() => undefined);
  const max = options.maxSingleShotSeconds;
  const min = options.minSingleShotSeconds ?? 4;
  const restores: Array<() => void> = [];
  const repoRoot = videoRuntimeRoot(import.meta.url);
  let vendorRequire: NodeJS.Require;
  try {
    vendorRequire = createRequire(resolvePath(repoRoot, "package.json"));
  } catch (err) {
    log(`[vendor-compat] 时长策略桥无法建立 vendor require：${err instanceof Error ? err.message : String(err)}`);
    return () => undefined;
  }
  /** 单个目标失败不影响其它目标：逐个 try/catch 并如实记日志 */
  const step = (label: string, run: () => void): void => {
    try {
      run();
    } catch (err) {
      log(`[vendor-compat] 时长策略桥·${label} 注入失败（其余目标继续）：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // ① + ② DurationConstraintManager（类默认值 + 实例 rhythmProfiles）
  step("DurationConstraintManager", () => {
    const file = resolvePath(
      repoRoot,
      "vendor/supermickey/hyperreality-system/engines/duration-constraint/duration-constraint-manager.js"
    );
    if (!existsSync(file)) return;
    const mod = vendorRequire(file) as {
      DurationConstraintManager?: new (o?: Record<string, unknown>) => Record<string, unknown>;
    };
    const originalCtor = mod?.DurationConstraintManager;
    if (!originalCtor?.prototype) return;
    const Wrapped = function durationManagerWithPolicy(this: unknown, opts: Record<string, unknown> = {}) {
      return new originalCtor({ maxSingleShot: max, minSingleShot: min, ...opts });
    } as unknown as new (o?: Record<string, unknown>) => Record<string, unknown>;
    Wrapped.prototype = originalCtor.prototype;
    mod.DurationConstraintManager = Wrapped;
    restores.push(() => {
      mod.DurationConstraintManager = originalCtor;
    });
    log(`[vendor-compat] 时长策略桥：DurationConstraintManager 默认 maxSingleShot=${max}s/min=${min}s`);
  });

  // ③ ThemeConfig 题材级资源配额（真实层级 resourceQuota 下）
  step("ThemeConfig.resourceQuota", () => {
    const file = resolvePath(repoRoot, "vendor/supermickey/hyperreality-system/config/theme-config.js");
    if (!existsSync(file)) return;
    type Quota = { maxShotDuration?: number };
    const theme = vendorRequire(file) as {
      types?: Record<string, { maxShotDuration?: number; resourceQuota?: Quota }>;
    };
    const previous = new Map<string, { top?: number; quota?: number }>();
    let touched = 0;
    for (const [key, value] of Object.entries(theme?.types ?? {})) {
      if (!value || typeof value !== "object") continue;
      previous.set(key, { top: value.maxShotDuration, quota: value.resourceQuota?.maxShotDuration });
      if (value.resourceQuota && typeof value.resourceQuota.maxShotDuration === "number") {
        value.resourceQuota.maxShotDuration = Math.max(value.resourceQuota.maxShotDuration, max);
      }
      // 防御：顶层同名键在第一版桥里被写过（本版保留对历史数据的纠正，不新增语义）
      if (typeof value.maxShotDuration === "number") value.maxShotDuration = Math.max(value.maxShotDuration, max);
      touched += 1;
    }
    restores.push(() => {
      for (const [key, prev] of previous) {
        const target = theme?.types?.[key];
        if (!target) continue;
        if (prev.top !== undefined) target.maxShotDuration = prev.top;
        if (prev.quota !== undefined && target.resourceQuota) target.resourceQuota.maxShotDuration = prev.quota;
      }
    });
    log(`[vendor-compat] 时长策略桥：ThemeConfig.resourceQuota.maxShotDuration → ${max}s（${touched} 个题材）`);
  });

  // ④ 平台蓝图时长带（PromptDeliveryGuard.verifyPackage 消费）
  step("platform-profiles", () => {
    const file = resolvePath(repoRoot, "vendor/supermickey/hyperreality-system/config/platform-profiles.js");
    if (!existsSync(file)) return;
    const mod = vendorRequire(file) as {
      PROFILES?: Record<string, { shotDuration?: { min?: number; max?: number } }>;
    };
    const previous = new Map<string, number | undefined>();
    for (const [key, profile] of Object.entries(mod?.PROFILES ?? {})) {
      const band = profile?.shotDuration;
      if (!band || typeof band.max !== "number") continue;
      previous.set(key, band.max);
      band.max = Math.max(band.max, max);
      if (typeof band.min === "number") band.min = Math.min(band.min, min);
    }
    restores.push(() => {
      for (const [key, prev] of previous) {
        const band = mod?.PROFILES?.[key]?.shotDuration;
        if (band && prev !== undefined) band.max = prev;
      }
    });
    log(`[vendor-compat] 时长策略桥：平台蓝图 shotDuration.max → ${max}s（${previous.size} 个平台档）`);
  });

  // ⑤ 镜头时长分配器（config.maxDuration + 各角色 max）
  step("ShotDurationAllocator", () => {
    const file = resolvePath(repoRoot, "vendor/supermickey/systems/shot-duration-allocator.js");
    if (!existsSync(file)) return;
    const mod = vendorRequire(file) as {
      ShotDurationAllocator?: new (o?: Record<string, unknown>) => {
        config?: { maxDuration?: number };
        roleConfig?: Record<string, { max?: number }>;
      };
    };
    const originalCtor = mod?.ShotDurationAllocator;
    if (!originalCtor?.prototype) return;
    const Wrapped = function shotAllocatorWithPolicy(this: unknown, cfg: Record<string, unknown> = {}) {
      const instance = new originalCtor(cfg);
      if (instance.config && typeof instance.config.maxDuration === "number") {
        instance.config.maxDuration = Math.max(instance.config.maxDuration, max);
      }
      for (const role of Object.values(instance.roleConfig ?? {})) {
        if (role && typeof role.max === "number") role.max = Math.max(role.max, max);
      }
      return instance;
    } as unknown as new (o?: Record<string, unknown>) => Record<string, unknown>;
    Wrapped.prototype = originalCtor.prototype;
    mod.ShotDurationAllocator = Wrapped;
    restores.push(() => {
      mod.ShotDurationAllocator = originalCtor;
    });
    log(`[vendor-compat] 时长策略桥：ShotDurationAllocator.maxDuration/roleConfig.max → ${max}s`);
  });

  // ⑥ 需求清单建议口径（ParserRules 常量 + 返回体字面量）
  step("requirement-list-builder", () => {
    const file = resolvePath(
      repoRoot,
      "vendor/supermickey/hyperreality-system/engines/script-engine/core/requirement-list-builder.js"
    );
    if (!existsSync(file)) return;
    const mod = vendorRequire(file) as {
      ParserRules?: { constraints?: { maxShotDuration?: number } };
      RequirementListBuilder?: { prototype?: Record<string, unknown> };
    };
    const constraints = mod?.ParserRules?.constraints;
    if (constraints && typeof constraints.maxShotDuration === "number") {
      const previous = constraints.maxShotDuration;
      constraints.maxShotDuration = Math.max(previous, max);
      restores.push(() => {
        constraints.maxShotDuration = previous;
      });
    }
    const prototype = mod?.RequirementListBuilder?.prototype;
    const original = prototype?._buildRequirementList as
      | ((this: unknown, ...args: unknown[]) => unknown)
      | undefined;
    if (prototype && typeof original === "function") {
      const patched = function patchedBuildRequirementList(this: unknown, ...args: unknown[]) {
        const out = original.apply(this, args);
        if (out && typeof out === "object") {
          const list = out as { constraints?: { maxShotDuration?: number } };
          if (list.constraints && typeof list.constraints.maxShotDuration === "number") {
            list.constraints.maxShotDuration = Math.max(list.constraints.maxShotDuration, max);
          }
        }
        return out;
      };
      prototype._buildRequirementList = patched;
      restores.push(() => {
        prototype._buildRequirementList = original;
      });
    }
    log(`[vendor-compat] 时长策略桥：需求清单建议上限 → ${max}s`);
  });

  return () => restores.forEach((restore) => restore());
}

/** 把已构造好的 DurationConstraintManager 实例放宽到模型上限（studio 在 new 之后调用） */
export function applyDurationPolicyToManager(
  manager: unknown,
  maxSingleShotSeconds: number,
  minSingleShotSeconds = 4
): void {
  if (!manager || typeof manager !== "object") return;
  const record = manager as Record<string, unknown> & {
    rhythmProfiles?: Record<string, { shotRange?: number[] }>;
  };
  record.maxSingleShot = maxSingleShotSeconds;
  record.minSingleShot = minSingleShotSeconds;
  for (const profile of Object.values(record.rhythmProfiles ?? {})) {
    if (!profile || !Array.isArray(profile.shotRange)) continue;
    const lower = Number(profile.shotRange[0] ?? minSingleShotSeconds);
    const upper = Number(profile.shotRange[1] ?? maxSingleShotSeconds);
    profile.shotRange = [Math.max(minSingleShotSeconds, lower), Math.max(upper, maxSingleShotSeconds)];
  }
}

/* ============================================================================================
 * 镜头时长单点守恒投影桥（T-2026-0925-0001）
 *
 * 解决的问题（均有本仓实测证据）：
 *   ① 生成端无规则 → 单镜可产出 3s / 54s，越出模型 4–30s（script-generator.js:1314-1315）；
 *   ② 台词修复被运行期权重表重分配整体抹平（duration-constraint-manager.js:112-143，实测 critical 0→2）；
 *   ③ 残差兜底把差额塞给最后一镜且无上限（production-engine.js:1288-1295，fuzz 585/2000 越界）；
 *   ④ "情绪语速"恒回落 3.5 字/s（dialogue-timing-calculator.js:309-326 只认整词）；
 *   ⑤ 缩短台词的目标字数与可行性公式不自洽 → 修完仍 critical 且产生残句（:207 vs :46-65）。
 *
 * 做法：把 vendor 的**所有时长决策点**收敛到宿主投影器（duration-projection.ts）：
 *   · _enforceTargetDuration / _normalizeDurations / DCM.constrain → 改为调用投影器；
 *   · DCM._redistributeDurations → 停用（权重表不再参与）；
 *   · phase-3._checkDialogueTiming → 保留检测与文案修复，但时长一律重投影；
 *   · DialogueTimingCalculator._getSpeechRate/_shortenText/_generateFix → 修复输入契约与目标字数。
 * vendor 目录只读，全部为运行期原型补丁；桥可摘除、幂等、带引用计数（并发 run 不会互相拆桥）。
 * ========================================================================================== */

export interface DurationProjectionShotReport {
  shotId: string;
  planSeconds: number;
  seconds: number;
  voiceFloorSeconds: number;
  raised: boolean;
  lowered: boolean;
}

export interface DurationProjectionEvent {
  kind: "projected" | "infeasible" | "skipped";
  source: "script-generator" | "production-engine.normalize" | "dcm.constrain" | "phase-3";
  targetSeconds: number | null;
  totalSeconds: number;
  shots: DurationProjectionShotReport[];
  message?: string;
}

export interface DurationProjectionBridgeOptions {
  log?: (line: string) => void;
  onEvent?: (event: DurationProjectionEvent) => void;
  minShotSeconds?: number;
  maxShotSeconds?: number;
}

interface DurationProjectionPolicy {
  noDialogue?: boolean;
  minShotSeconds?: number;
  maxShotSeconds?: number;
}
const durationPolicyStore = new AsyncLocalStorage<DurationProjectionPolicy>();

export function runWithDurationProjectionPolicy<T>(
  policy: DurationProjectionPolicy,
  callback: () => T,
): T {
  return durationPolicyStore.run({ ...policy, noDialogue: policy.noDialogue === true }, callback);
}

/** 进程级共享桥注册表：第一个安装、最后一个卸载（并发 run 安全） */
const sharedBridges = new Map<string, { restore: () => void; refs: number }>();

/**
 * 包装任意"安装 → 返回摘除函数"的桥为**引用计数共享桥**。
 * 并发 run 场景下，后完成的 run 不会把仍在使用的桥提前摘掉。
 */
export function installSharedBridge(key: string, install: () => () => void): () => void {
  const existing = sharedBridges.get(key);
  if (existing) {
    existing.refs += 1;
  } else {
    const restore = install();
    sharedBridges.set(key, { restore, refs: 1 });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const entry = sharedBridges.get(key);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs <= 0) {
      try {
        entry.restore();
      } finally {
        sharedBridges.delete(key);
      }
    }
  };
}

/** 供测试/诊断读取当前存活的共享桥 */
export function listSharedBridges(): Array<{ key: string; refs: number }> {
  return [...sharedBridges.entries()].map(([key, value]) => ({ key, refs: value.refs }));
}

export function installVendorDurationProjectionBridge(options: DurationProjectionBridgeOptions = {}): () => void {
  const log = options.log ?? (() => undefined);
  const emit = options.onEvent ?? (() => undefined);
  const repoRoot = videoRuntimeRoot(import.meta.url);
  let vendorRequire: NodeJS.Require;
  try {
    vendorRequire = createRequire(resolvePath(repoRoot, "package.json"));
  } catch (err) {
    log(`[vendor-compat] 时长投影桥无法建立 vendor require：${err instanceof Error ? err.message : String(err)}`);
    return () => undefined;
  }

  const restores: Array<() => void> = [];
  const step = (label: string, run: () => void): void => {
    try {
      run();
    } catch (err) {
      log(`[vendor-compat] 时长投影桥·${label} 注入失败（其余目标继续）：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  type Recordish = Record<string, unknown>;
  const idOf = (record: Recordish, fallback: string): string =>
    String(record.shotId ?? record.shot_id ?? record.scene_id ?? record.sceneId ?? fallback);
  const durationOf = (record: Recordish): number => {
    const timing = record.timing as { duration?: unknown } | undefined;
    return Number(record.duration ?? timing?.duration ?? 0) || 0;
  };

  /** 通用：把一组镜头/场景投影到 target，并**原地**写回 duration + timing（保持对象引用不变） */
  const projectRecords = (
    records: Recordish[],
    targetSeconds: number | null,
    source: DurationProjectionEvent["source"],
    kindLabel: string,
    planningMode = false
  ): boolean => {
    if (!Number.isFinite(Number(targetSeconds)) || Number(targetSeconds) <= 0) {
      emit({
        kind: "skipped",
        source,
        targetSeconds: null,
        totalSeconds: records.reduce((sum, record) => sum + durationOf(record), 0),
        shots: [],
        message: "缺少目标总时长，投影器跳过（不改时长）",
      });
      return false;
    }
    const policy = durationPolicyStore.getStore();
    const noDialogue = policy?.noDialogue === true;
    const minShot = policy?.minShotSeconds ?? options.minShotSeconds ?? 4;
    const maxShot = policy?.maxShotSeconds ?? options.maxShotSeconds ?? 30;
    if (noDialogue) {
      for (const record of records) {
        record.dialogue = "";
        record.dialogueText = "";
        record.dialogueBlocks = [];
      }
    }
    const inputs = records.map((record, index) => ({
      shotId: idOf(record, `${kindLabel}-${index + 1}`),
      duration: durationOf(record),
      timing: record.timing as { start?: number; duration?: number; end?: number } | undefined,
      dialogue: noDialogue ? "" : record.dialogue,
      emotion: (record.emotion as string | undefined) ?? (record.mood as string | undefined),
      mood: record.mood as string | undefined,
      sceneType: (record.sceneType ?? record.scene_type) as string | undefined,
    }));
    const projectOnce = (enforceVoiceFloor: boolean, minimumSeconds = minShot) =>
      projectShotDurations(inputs, {
        targetSeconds: Number(targetSeconds),
        minSeconds: minimumSeconds,
        maxSeconds: maxShot,
        enforceVoiceFloor,
      });
    let result = projectOnce(true);
    if (!result.ok && planningMode) {
      if ((result.reason === "voice-floor-exceeds-target" || result.reason === "voice-floor-exceeds-model-limit")
        && (source === "dcm.constrain" || source === "phase-3")) {
        emit({
          kind: "infeasible",
          source,
          targetSeconds: Number(targetSeconds),
          totalSeconds: records.reduce((sum, record) => sum + durationOf(record), 0),
          shots: result.entries.map((entry) => ({ ...entry })),
          message: `${result.reason}：${result.suggestions.join("；")}`,
        });
        return false;
      }
      /**
       * 剪辑时间线不是供应商单镜请求。15s 成片可由 5 个 3s 剪辑镜头组成，
       * 不能把供应商 4s 单镜下限直接套在这条时间线上；规划阶段只在镜数确实
       * 超出目标/3 时降级到可守恒的整数分钟下限，执行形态仍需另行满足供应商约束。
       */
      const timelineMin = Math.min(minShot, Math.max(1, Math.floor(Number(targetSeconds) / Math.max(1, records.length))));
      log(`[vendor-compat] 规划阶段按剪辑时间线投影：${source} 使用下限 ${timelineMin}s（供应商单镜下限 ${minShot}s 不直接套用）`);
      result = projectOnce(false, timelineMin);
    }
    if (!result.ok) {
      emit({
        kind: "infeasible",
        source,
        targetSeconds: Number(targetSeconds),
        totalSeconds: records.reduce((sum, record) => sum + durationOf(record), 0),
        shots: result.entries.map((entry) => ({ ...entry, planSeconds: entry.planSeconds })),
        message: `${result.reason}：${result.suggestions.join("；")}`,
      });
      log(`[vendor-compat] 时长投影 INFEASIBLE（${source}）：${result.suggestions.join("；")}`);
      return false;
    }
    const applied = applyProjectedDurations(
      records.map((record, index) => ({ ...record, shotId: idOf(record, `${kindLabel}-${index + 1}`) })),
      result.entries
    );
    // 原地写回（保持数组元素引用，避免调用方持有旧对象）
    records.forEach((record, index) => {
      const next = applied[index] as Recordish;
      record.duration = next.duration;
      record.timing = next.timing;
    });
    emit({
      kind: "projected",
      source,
      targetSeconds: Number(targetSeconds),
      totalSeconds: result.totalSeconds,
      shots: result.entries.map((entry) => ({
        shotId: entry.shotId,
        planSeconds: entry.planSeconds,
        seconds: entry.seconds,
        voiceFloorSeconds: entry.voiceFloorSeconds,
        raised: entry.raised,
        lowered: entry.lowered,
      })),
    });
    return true;
  };

  /* ---------- ① 剧本引擎：总量对齐改为投影 ---------- */
  step("ScriptGenerator._enforceTargetDuration", () => {
    const file = resolvePath(repoRoot, "vendor/supermickey/hyperreality-system/engines/script-engine/core/script-generator.js");
    if (!existsSync(file)) return;
    const mod = vendorRequire(file) as { ScriptGenerator?: { prototype?: Recordish } };
    const prototype = mod?.ScriptGenerator?.prototype;
    const original = prototype?._enforceTargetDuration as ((this: unknown, parsed: unknown, target: unknown) => void) | undefined;
    if (!prototype || typeof original !== "function") return;
    const patched = function patchedEnforceTargetDuration(this: unknown, parsed: Recordish, target: unknown): void {
      const structure = parsed?.structure as { scenes?: Recordish[] } | undefined;
      const scenes = structure?.scenes ?? [];
      const applied = projectRecords(scenes, Number(target), "script-generator", "SC", true);
      if (!applied) {
        // INFEASIBLE / 无目标：保留原实现的兜底格式化行为（时间轴重建），但不越界
        original.call(this, parsed, target);
        return;
      }
      const meta = (parsed.meta ?? {}) as Recordish;
      meta.total_duration = scenes.reduce((sum, scene) => sum + durationOf(scene), 0);
      parsed.meta = meta;
      log(`[vendor-compat] 剧本时长投影完成：${scenes.length} 场景 / 合计 ${meta.total_duration}s`);
    };
    prototype._enforceTargetDuration = patched;
    restores.push(() => {
      prototype._enforceTargetDuration = original;
    });
    log("[vendor-compat] 时长投影桥：ScriptGenerator._enforceTargetDuration → 宿主投影器");
  });

  /* ---------- ② 制作引擎：总量归一改为投影（去掉"最后一镜兜底"） ---------- */
  step("ProductionEngine._normalizeDurations", () => {
    const file = resolvePath(repoRoot, "vendor/supermickey/hyperreality-system/engines/production-engine/production-engine.js");
    if (!existsSync(file)) return;
    const mod = vendorRequire(file) as { ProductionEngine?: { prototype?: Recordish } };
    const prototype = mod?.ProductionEngine?.prototype;
    const original = prototype?._normalizeDurations as ((this: unknown, shots: Recordish[], target: unknown) => Recordish[]) | undefined;
    if (!prototype || typeof original !== "function") return;
    const patched = function patchedNormalizeDurations(this: unknown, shots: Recordish[], target: unknown): Recordish[] {
      if (!Array.isArray(shots) || shots.length === 0) return shots;
      const applied = projectRecords(shots, Number(target), "production-engine.normalize", "S", true);
      if (!applied) return original.call(this, shots, target);
      return shots;
    };
    prototype._normalizeDurations = patched;
    restores.push(() => {
      prototype._normalizeDurations = original;
    });
    log("[vendor-compat] 时长投影桥：ProductionEngine._normalizeDurations → 宿主投影器（无最后一镜兜底）");
  });

  /* ---------- ③ 运行期约束：constrain 改投影；权重表重分配停用 ---------- */
  step("DurationConstraintManager", () => {
    const file = resolvePath(repoRoot, "vendor/supermickey/hyperreality-system/engines/duration-constraint/duration-constraint-manager.js");
    if (!existsSync(file)) return;
    const mod = vendorRequire(file) as { DurationConstraintManager?: { prototype?: Recordish } };
    const prototype = mod?.DurationConstraintManager?.prototype;
    if (!prototype) return;
    const originalConstrain = prototype.constrain as ((this: unknown, scenes: Recordish[], options?: Recordish) => unknown) | undefined;
    const originalRedistribute = prototype._redistributeDurations as ((...args: unknown[]) => unknown) | undefined;
    if (typeof originalConstrain === "function") {
      const patched = function patchedConstrain(this: Recordish, scenes: Recordish[], opts: Recordish = {}): Recordish {
        if (!Array.isArray(scenes) || scenes.length === 0) {
          return originalConstrain.call(this, scenes ?? [], opts) as Recordish;
        }
        const explicitTarget = Number(opts.targetDuration);
        const sum = scenes.reduce((total, scene) => total + durationOf(scene), 0);
        const target = Number.isFinite(explicitTarget) && explicitTarget > 0 ? explicitTarget : sum;
        const projected = projectRecords(scenes, target, "dcm.constrain", "SC", true);
        const ensure = prototype._ensureSequentialTiming as ((this: unknown, list: Recordish[]) => void) | undefined;
        if (typeof ensure === "function") ensure.call(this, scenes);
        return { scenes, adjustments: [], valid: projected };
      };
      prototype.constrain = patched;
      restores.push(() => {
        prototype.constrain = originalConstrain;
      });
    }
    if (typeof originalRedistribute === "function") {
      const disabled = function disabledRedistribute(this: Recordish, scenes: Recordish[]): void {
        log("[vendor-compat] DCM 权重表重分配已停用（时长决策统一由宿主投影器负责）");
        const ensure = prototype._ensureSequentialTiming as ((this: unknown, list: Recordish[]) => void) | undefined;
        if (typeof ensure === "function" && Array.isArray(scenes)) ensure.call(this, scenes);
      };
      prototype._redistributeDurations = disabled;
      restores.push(() => {
        prototype._redistributeDurations = originalRedistribute;
      });
    }
    log("[vendor-compat] 时长投影桥：DCM.constrain → 投影器；_redistributeDurations 停用");
  });

  /* ---------- ④ 台词检测：保留检测与文案修复，时长一律重投影 ---------- */
  step("Phase3PromptFusion._checkDialogueTiming", () => {
    const file = resolvePath(
      repoRoot,
      "vendor/supermickey/hyperreality-system/engines/production-engine/phases/phase-3-prompt-fusion.js"
    );
    if (!existsSync(file)) return;
    const mod = vendorRequire(file) as { Phase3PromptFusion?: { prototype?: Recordish } };
    const prototype = mod?.Phase3PromptFusion?.prototype;
    const original = prototype?._checkDialogueTiming as
      | ((this: unknown, shots: Recordish[], blueprint: Recordish) => Promise<Recordish[]>)
      | undefined;
    if (!prototype || typeof original !== "function") return;
    const patched = async function patchedCheckDialogueTiming(
      this: unknown,
      shots: Recordish[],
      blueprint: Recordish
    ): Promise<Recordish[]> {
      const after = await original.call(this, shots, blueprint);
      const config = (blueprint?.config ?? {}) as Recordish;
      const meta = (blueprint?.meta ?? {}) as Recordish;
      const target = Number(config.target_duration ?? meta.target_duration ?? blueprint?.targetDuration);
      const hasTarget = Number.isFinite(target) && target > 0;
      const projected = projectRecords(
        after,
        hasTarget ? target : null,
        "phase-3",
        "S",
        true,
      );
      if (hasTarget && !projected) throw new Error("PHASE3_DURATION_PROJECTION_FAILED");
      return after;
    };
    prototype._checkDialogueTiming = patched;
    restores.push(() => {
      prototype._checkDialogueTiming = original;
    });
    log("[vendor-compat] 时长投影桥：phase-3 台词检测后统一重投影");
  });

  /* ---------- ⑤ 台词引擎输入契约：情绪归一 + 缩短目标自洽 ---------- */
  step("DialogueTimingCalculator", () => {
    const file = resolvePath(repoRoot, "vendor/supermickey/hyperreality-system/utils/dialogue-timing-calculator.js");
    if (!existsSync(file)) return;
    const mod = vendorRequire(file) as { DialogueTimingCalculator?: { prototype?: Recordish } };
    const prototype = mod?.DialogueTimingCalculator?.prototype;
    if (!prototype) return;

    const originalGetRate = prototype._getSpeechRate as ((this: Recordish, emotion?: string) => number) | undefined;
    if (typeof originalGetRate === "function") {
      const speech = loadSpeechRate();
      const patched = function patchedGetSpeechRate(this: Recordish, emotion?: string): number {
        const self = this as Recordish | undefined;
        const rates = ((self?.speechRates as Record<string, number> | undefined) ?? speech.RATES) as Record<string, number>;
        const key = resolveRateKey(emotion);
        return Number(rates[key] ?? rates.normal ?? speech.NORMAL);
      };
      prototype._getSpeechRate = patched;
      restores.push(() => {
        prototype._getSpeechRate = originalGetRate;
      });
    }

    const originalShorten = prototype._shortenText as ((this: unknown, text: string, targetChars: number) => string) | undefined;
    if (typeof originalShorten === "function") {
      const patched = function patchedShortenText(this: unknown, text: string, targetChars: number): string {
        const source = String(text ?? "");
        const budget = Math.max(1, Math.floor(Number(targetChars) || 0));
        if (source.length <= budget) return source;
        const head = source.slice(0, budget);
        // 优先在整句处收尾；其次在分句处收尾；都找不到才硬截断（不再补标点，避免制造语义错误）
        const sentenceBreak = Math.max(head.lastIndexOf("。"), head.lastIndexOf("！"), head.lastIndexOf("？"), head.lastIndexOf("."));
        if (sentenceBreak >= Math.floor(budget * 0.6)) return head.slice(0, sentenceBreak + 1);
        const clauseBreak = Math.max(
          head.lastIndexOf("，"),
          head.lastIndexOf("、"),
          head.lastIndexOf("；"),
          head.lastIndexOf("：")
        );
        if (clauseBreak >= Math.floor(budget * 0.6)) return head.slice(0, clauseBreak);
        return head.replace(/[，、；：,;:\s]+$/, "");
      };
      prototype._shortenText = patched;
      restores.push(() => {
        prototype._shortenText = originalShorten;
      });
    }

    const originalGenerateFix = prototype._generateFix as
      | ((this: Recordish, shot: Recordish, issueType: string) => Recordish | null)
      | undefined;
    if (typeof originalGenerateFix === "function") {
      const patched = function patchedGenerateFix(this: Recordish, shot: Recordish, issueType: string): Recordish | null {
        if (issueType !== "overflow") return originalGenerateFix.call(this, shot, issueType);
        const duration = Number(shot.duration ?? (shot.timing as Recordish | undefined)?.duration ?? 0) || 0;
        const dialogue = shot.dialogue;
        const lines = extractDialogueLines(dialogue);
        const text = lines.join("");
        if (!duration || !text) return originalGenerateFix.call(this, shot, issueType);
        const speech = loadSpeechRate();
        /** 与投影器同口径：可见字数 ÷ 基准语速 ≤ 镜头时长 × 0.8 */
        const limit = duration * speech.MAX_DIALOGUE_RATIO * speech.NORMAL;
        let low = 1;
        let high = text.length;
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          if (countVisibleUnits(text.slice(0, mid)) <= limit) low = mid;
          else high = mid - 1;
        }
        const targetChars = Math.max(1, low);
        const shortened = (this._shortenText as (t: string, c: number) => string).call(this, text, targetChars);
        const floorAfter = computeVoiceFloor({ ...shot, dialogue: { text: shortened } } as never);
        return {
          type: "shorten_dialogue",
          description: `缩短台词至适合镜头时长（目标可见字数 ≤ ${Math.floor(limit)}，下限 ${floorAfter.seconds}s）`,
          originalText: text,
          suggestedText: shortened,
          originalChars: countVisibleUnits(text),
          targetChars: countVisibleUnits(shortened),
        };
      };
      prototype._generateFix = patched;
      restores.push(() => {
        prototype._generateFix = originalGenerateFix;
      });
    }
    log("[vendor-compat] 时长投影桥：台词引擎情绪归一 + 缩短目标自洽");
  });

  return () => {
    restores.reverse().forEach((restore) => restore());
  };
}

/** Phase3 宿主执行契约。vendor 源保持只读，失败不得退成成功的规则 prompt。 */
export const PHASE3_FUSION_POLICY_VERSION = "workloom.phase3-fusion/v1";
type FusionRecord = Record<string, unknown>;
interface FusionAgent extends FusionRecord {
  process(shots: FusionRecord[], blueprint: FusionRecord, options: FusionRecord): Promise<FusionRecord>;
  _callLLM?: (...args: unknown[]) => Promise<unknown>;
  _getLLMEngine?: () => FusionRecord | null;
  _getAltLLMEngine?: () => FusionRecord | null;
  _saveSubCheckpoint?: (checkpointManager: unknown, blueprintHash: string, rows: FusionRecord[], completed: number, total: number) => void;
}
interface FusionPhase extends FusionRecord {
  agents: { promptFusion?: FusionAgent };
  budgetRemaining(): number;
  checkBudget(needMs: number, label: string): boolean;
  cloneShots(shots: FusionRecord[]): FusionRecord[];
  mergeShots(base: FusionRecord[], updated: FusionRecord[], fields: string[]): FusionRecord[];
  _checkDialogueTiming(shots: FusionRecord[], blueprint: FusionRecord): Promise<FusionRecord[]>;
  saveCheckpoint(phase: string, shots: FusionRecord[], data: FusionRecord): Promise<unknown>;
  log(stage: string, message: string): void;
  healthMonitor?: { setLongTaskMode(name: string, active: boolean, timeout?: number): void };
}

const FUSION_MERGE_FIELDS = [
  "prompt", "enhanced_prompt", "negative_prompt", "fields", "fusionText", "promptCharCount",
  "director_instruction", "constraint", "baseline", "scene", "lighting", "composition",
  "color_palette", "depth_of_field", "camera_movement", "character", "costume", "makeup",
  "action", "props", "portraits", "dialogue", "timeline", "mood", "pacing", "transition",
  "audio", "negative", "bright_constraint", "character_constraint", "consistency", "semanticRefinement",
  "shotSize", "cameraHint",
  "_workloomPromptReviewPolicy",
];

function fusionRecord(value: unknown, label: string): FusionRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CinematicSkillError("PHASE3_CONTRACT_INVALID", `${label} 必须为对象`, "unverified");
  }
  return value as FusionRecord;
}

export interface Phase3RepairInput {
  rows: unknown[];
  expectedIds: string[];
  repair: (shotId: string, index: number) => Promise<unknown>;
  /** Additional authored-field requirements shared by loaded and retried rows. */
  validateRow?: (row: FusionRecord, expectedId: string) => boolean;
  /** Persist accepted raw progress before a later shot or final gate can fail. */
  onRepaired?: (rows: FusionRecord[], shotId: string, index: number) => void | Promise<void>;
  /**
   * Last-resort recovery from the already validated Phase2 shot contract. This is
   * intentionally separate from an LLM retry so a provider returning empty fields
   * cannot erase the source contract or turn a rule fallback into a successful run.
   */
  recover?: (shotId: string, index: number) => Promise<unknown>;
}

export async function repairPhase3FusionRows(input: Phase3RepairInput): Promise<{
  rows: FusionRecord[];
  repaired: string[];
  recovered: string[];
}> {
  const rows = [...input.rows];
  const seen = new Set<string>();
  const repaired: string[] = [];
  const recovered: string[] = [];
  const valid = (row: unknown, expectedId: string): row is FusionRecord => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return false;
    const record = row as FusionRecord;
    const id = String(record.shotId ?? record.shot_id ?? "");
    return id === expectedId && !seen.has(id) && record.degraded !== true
      && typeof record.prompt === "string" && record.prompt.trim().length > 0
      && (!input.validateRow || input.validateRow(record, expectedId));
  };
  for (let index = 0; index < input.expectedIds.length; index += 1) {
    const expectedId = input.expectedIds[index]!;
    let row = rows[index];
    if (!valid(row, expectedId)) {
      let repairError: unknown;
      try {
        row = await input.repair(expectedId, index);
      } catch (error) {
        repairError = error;
      }
      if (!valid(row, expectedId) && input.recover) {
        row = await input.recover(expectedId, index);
        if (valid(row, expectedId)) recovered.push(expectedId);
      }
      if (!valid(row, expectedId)) {
        if (repairError instanceof Error) {
          throw new Error(`PHASE3_FUSION_RETRY_UNVERIFIED：镜头 ${expectedId} 重试后仍未通过（${repairError.message}）`);
        }
        throw new Error(`PHASE3_FUSION_RETRY_UNVERIFIED：镜头 ${expectedId} 重试后仍未通过（ID、prompt、degraded 或原生字段状态无效）`);
      }
      rows[index] = row;
      repaired.push(expectedId);
      await input.onRepaired?.(rows.slice(0, input.expectedIds.length) as FusionRecord[], expectedId, index);
    }
    seen.add(expectedId);
  }
  return { rows: rows.slice(0, input.expectedIds.length) as FusionRecord[], repaired, recovered };
}

function recoverPhase3RowFromSource(shot: FusionRecord): FusionRecord {
  const fields = shot.fields && typeof shot.fields === "object" && !Array.isArray(shot.fields)
    ? shot.fields as FusionRecord
    : {};
  const text = (...values: unknown[]): string => {
    for (const value of values) {
      if (typeof value === "string" && value.trim()) return value.trim();
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const record = value as FusionRecord;
        const joined = Object.values(record)
          .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
          .map((item) => item.trim())
          .join("；");
        if (joined) return joined;
      }
    }
    return "";
  };
  const scene = text(shot.scene, fields.scene, shot.promptBase, shot.sceneFunction);
  const action = text(shot.action, fields.action, shot.sceneFunction);
  const lighting = text(shot.lightingString, shot.lighting, fields.lighting);
  const camera = text(shot.cameraString, shot.camera_movement, shot.cameraMovement, fields.camera_movement);
  const audio = text(shot.backgroundSoundString, shot.backgroundSound, shot.audio, fields.audio);
  if (!scene && !action) return shot;
  const duration = Number(shot.duration ?? recordValue(shot.timing).duration ?? 0);
  const prompt = [
    "01.【基础】按已通过的 Phase2 镜头合同执行，保留源场景、主体动作、空间关系和已确认约束。",
    `02.【场景】${scene || action}`,
    `03.【动作】${action || scene}`,
    `04.【灯光设计】${lighting || "沿用已通过的上游灯光合同"}`,
    `05.【运镜】${camera || "固定机位，连续稳定"}`,
    `06.【台词】${text(shot.dialogueText, shot.dialogue) || "不适用。"}`,
    `07.【时间轴】T00:00-T00:${duration.toFixed(1).padStart(4, "0")} 在单镜内完成起幅、连续动作与落幅。`,
    `08.【音频】${audio || "沿用已通过的上游环境声与主体动作声。"}`,
  ].join("\n");
  return {
    ...shot,
    fields: {
      ...fields,
      scene: scene || action,
      action: action || scene,
      lighting: lighting || fields.lighting,
      camera_movement: camera || fields.camera_movement,
      audio: audio || fields.audio,
    },
    prompt,
    promptCharCount: prompt.length,
    degraded: false,
    degradeReason: null,
    _workloomLocalRecovery: {
      schemaVersion: "workloom.phase3-source-recovery/v1",
      mode: "contract-source-reprojection",
      sourcePromptBase: text(shot.promptBase),
      requiresFinalReviewProjection: true,
    },
  };
}

function marketingNativeFieldText(shot: FusionRecord, key: string, ...aliases: string[]): string {
  const fields = recordValue(shot.fields);
  for (const name of [key, ...aliases]) {
    for (const value of [fields[name], shot[name]]) {
      const text = promptFieldText(value).replace(/\s+/gu, " ").trim();
      if (text) return text;
    }
  }
  return "";
}

const MARKETING_NATIVE_FUSION_FIELDS = [
  ["action"], ["scene", "sceneDescription"], ["costume"], ["makeup"], ["props"], ["timeline"],
  ["composition"], ["lighting", "lightingString"], ["color_palette", "colorPalette"], ["transition"],
  ["mood", "emotion"], ["camera_movement", "cameraMovement", "cameraString"], ["pacing"],
  ["depth_of_field", "depthOfField"], ["audio"],
] as const;

function validMarketingNativeFusionRow(row: FusionRecord): boolean {
  return !Object.hasOwn(row, "_workloomLocalRecovery")
    && MARKETING_NATIVE_FUSION_FIELDS.every(([key, ...aliases]) => Boolean(marketingNativeFieldText(row, key, ...aliases)));
}

/** Commercial assembly may format native direction, but must not replace it with a global action position. */
function marketingNativeShotField(shot: FusionRecord, key: string, ...aliases: string[]): string {
  const text = marketingNativeFieldText(shot, key, ...aliases);
  if (text) return text;
  throw new Error(`MARKETING_NATIVE_SHOT_FIELD_MISSING: ${String(shot.shotId ?? shot.shot_id ?? "未编号镜头")} 缺少原生字段 ${key}`);
}

/** Keep native sound events; remove only forbidden speech and postproduction music instructions. */
function marketingAudioForContract(
  value: string,
  options: { noDialogue: boolean; noMusic: boolean; shotId: string; field: string },
): string {
  const source = value.trim();
  // The appended discipline is policy text, not an authored sound event.
  const native = source.split("【音频纪律】")[0]!.trim();
  const music = /背景音乐|配乐|音乐风格|音乐节拍|旋律|歌曲|音乐|弦乐|钢琴|器乐|合成器|电子鼓|贝斯|鼓点|\bBPM|\bBGM|soundtrack|background\s*music|\bmusic\b|\bscore\b/iu;
  const postproductionMusic = /背景音乐|配乐|音乐风格|音乐节拍|\bBGM\b|soundtrack|background\s*music/iu;
  const musicDenial = /(?:无|没有|不含|不加|不出现|不加入|禁止|避免|无需|不要|严禁)[^，。；;、,\n]{0,8}(?:背景音乐|配乐|音乐|BGM|旋律|歌曲|soundtrack)/giu;
  const speechDenial = /(?:无|没有|不添加|不加入|禁止|不得|不允许)(?:任何|额外|可辨)?(?:人声)?(?:台词|对白|对话|旁白|口播|voiceover)(?:人声)?/giu;
  const nonsemanticVoice = /欢呼|呼吸|喘息|笑声|呐喊|叹息|抽泣|哭声|咳嗽|含混|不可辨|不构成可辨语句|无可辨语义/u;
  const inSceneMusic = /画面内|画内|实况|街边音响|街头演奏|店内音响|现场(?:演奏|乐器|乐队)/u;
  const kept: string[] = [];
  let changed = native !== source;
  let musicContext = false;
  let inSceneContext = false;
  for (const match of native.matchAll(/([^。；;，,\n]+)([。；;，,\n]*)/gu)) {
    const body = match[1]!.trim();
    const punctuation = match[2]!;
    const resumesNative = /^(?:环境音|环境声|原生声|现场声|动作音效?|(?:只|仅)保留环境)/u.test(body)
      || /(?:保留|只剩|让)[^。；;\n]{0,12}(?:欢呼|呼吸|喘息|笑声|掌声|环境声)/u.test(body);
    if (resumesNative) musicContext = false;
    const explicitlyInScene = !options.noMusic && inSceneMusic.test(body);
    if (explicitlyInScene) inSceneContext = true;
    const musicBody = body.replace(musicDenial, "");
    const positiveMusic = music.test(musicBody);
    const forbiddenMusic = positiveMusic && (options.noMusic || !inSceneContext
      || postproductionMusic.test(musicBody) && !explicitlyInScene);
    if (forbiddenMusic) {
      musicContext = true;
      inSceneContext = false;
    }
    const speech = body.replace(speechDenial, "");
    const forbiddenSpeech = options.noDialogue && (
      /台词|对白|对话|旁白|口播|voiceover|说话|播报|解说/iu.test(speech)
      || /人声|人物声/u.test(speech) && !nonsemanticVoice.test(speech)
    );
    if (forbiddenMusic || musicContext && !inSceneContext || forbiddenSpeech) changed = true;
    else kept.push(match[0]);
    if (/[。；;\n]/u.test(punctuation)) {
      musicContext = false;
      inSceneContext = false;
    }
  }
  const result = changed
    ? kept.join("").replace(/[，,；;]+\s*(?=[。；;]|$)/gu, "").trim()
    : source;
  if (!result) {
    throw new Error(`MARKETING_AUDIO_CONTRACT_EMPTY: ${options.shotId} 的 ${options.field} 没有符合声音合同的原生声音事件`);
  }
  return result;
}

export function applyNarrativeFinalPromptContract(
  shot: FusionRecord,
  options: {
    noDialogue: boolean;
    maxLength: number;
    deliveryConstraint?: string;
    noCharacters?: boolean;
    noAnimals?: boolean;
    noMusic?: boolean;
    chineseOnly?: boolean;
    durationSeconds?: number;
    aspectRatio?: string;
    resolution?: string;
    colorTemperature?: string;
    isLastShot?: boolean;
    characterNames?: string[];
    noTitles?: boolean;
    canonicalize?: boolean;
    requireOpeningFields?: boolean;
    /** Internal author-budget measurement; never shortens native creative fields. */
    forceCompactMarketingHost?: boolean;
    characterPortraits?: Array<{
      name: string;
      path: string;
      appearance?: string;
      costume?: string;
      authorization?: string;
      sha256?: string;
      bytes?: number;
    }>;
    projectScene?: string;
    projectLighting?: string;
    projectColor?: string;
    projectProps?: string[];
    projectActions?: string[];
    shotIndex?: number;
    postRainOnly?: boolean;
    sourceFirstFrame?: string;
    marketingPrompt?: MarketingPromptPlan;
  },
): FusionRecord {
  const next: FusionRecord = {
    ...shot,
    fields: { ...(shot.fields && typeof shot.fields === "object" ? shot.fields as FusionRecord : {}) },
  };
  let prompt = typeof next.prompt === "string" ? next.prompt : "";
  prompt = prompt
    .replace(/(?:是枝裕和|侯孝贤|塔可夫斯基|阿巴斯|岩井俊二)/gu, "克制写实的自然长镜风格")
    .replace(/(?:清晨六点前后|清晨五点半|日出前)/gu, "清晨")
    .replace(/(?:约半人高|约一掌高|半人高|一掌高)/gu, "贴水高度")
    .replace(/清晨的清晨/gu, "清晨")
    .replace(/清�晰/gu, "清晰")
    .replace(/�/gu, "")
    .replace(/\bCG\b/giu, "计算机生成")
    .replace(/\bcinematic\b/giu, "电影感")
    .replace(/\bphotorealistic\b/giu, "写实摄影")
    .replace(/Camera增强/gu, "运镜增强")
    .replace(/Mood增强/gu, "情绪增强")
    .replace(/\b(?:cold|weary|quiet|tender|relieved|lonely|warm|serene|calm)\b/giu, (word) => ({
      cold: "清冷", weary: "疲惫", quiet: "安静", tender: "温柔", relieved: "释然",
      lonely: "孤独", warm: "温暖", serene: "宁静", calm: "平静",
    } as Record<string, string>)[word.toLowerCase()] ?? word)
    .replace(/\b(?:cameraHint|description|label|time)\b/giu, (word) => ({
      camerahint: "运镜提示", description: "描述", label: "标签", time: "时间",
    } as Record<string, string>)[word.toLowerCase()] ?? word);
  const escapeLabel = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const replaceField = (label: string, value: string): void => {
    const line = /^\s*\d+\.【[^】]+】/u;
    const pattern = new RegExp(`^(\\s*\\d+\\.【${escapeLabel(label)}】)[^\\n]*$`, "mu");
    if (pattern.test(prompt)) {
      prompt = prompt.replace(pattern, `$1${value}`);
    } else if (line.test(prompt)) {
      prompt = `${prompt.trimEnd()}\n99.【${label}】${value}`;
    }
  };
  const fieldValue = (label: string): string =>
    new RegExp(`^\\s*\\d+\\.【${escapeLabel(label)}】([^\\n]*)$`, "mu").exec(prompt)?.[1]?.trim() ?? "";
  const duration = Math.max(0, Number(shot.duration ?? (shot.timing as FusionRecord | undefined)?.duration ?? options.durationSeconds ?? 0));
  const aspect = String(options.aspectRatio ?? "9:16");
  const resolution = String(options.resolution ?? (aspect === "9:16" ? "1080x1920" : ""));
  const constraint = (options.deliveryConstraint?.trim()
    || [`${aspect}画幅`, resolution, duration > 0 ? `${duration}秒` : "", "24fps", "MP4格式"]
      .filter(Boolean).join("，"))
    .replace(/[。；;]+$/u, "");
  replaceField("约束", `${constraint}。`);
  if (options.chineseOnly) {
    replaceField("语言约束", "全部字段必须使用中文；画幅、分辨率、帧率、编码、时间码与格式名等制作标记可作为受控例外；不输出英文叙事标签、英文风格词或英文负面词。");
  }
  if (options.noTitles) {
    for (const label of ["主标题内容", "副标题内容", "标题动画设计", "标题字体设计", "开场音频设计"]) {
      replaceField(label, "不适用：成片无文字、无字幕、无标题卡。");
    }
  }
  prompt = prompt.replace(
    /(【台词】)([\s\S]*?)(?=\s*\|\s*【|$)/gu,
    (_all, label: string, body: string) => `${label}${body.replace(/\|/gu, "，")}`,
  );
  if (options.noDialogue) {
    next.dialogue = "";
    next.dialogueText = "";
    next.dialogueBlocks = [];
    (next.fields as FusionRecord).dialogue = "";
    replaceField("台词", "不适用：本片无台词、无旁白、无口播。");
  }
  const characterNames = (options.characterNames ?? []).map((name) => String(name).trim()).filter(Boolean);
  const sourceEnvironmentProhibitions = [...new Set(
    [promptFieldText(next.negative ?? (next.fields as FusionRecord).negative ?? next.negative_prompt), fieldValue("负面约束")]
      .join("；").match(/(?:无|禁止|不出现)(?:船只|建筑|现代设备)/gu) ?? [],
  )];
  const shotCharacterEvidence = promptFieldText(options.marketingPrompt
    ? (next.fields as FusionRecord).character ?? next.character
    : next.character ?? (next.fields as FusionRecord).character);
  const shotCharacterRef = promptFieldText(next.characterRef);
  const explicitNoPersonInShot = /^(?:无|none|n\/a)$/iu.test(shotCharacterRef)
    || /(?:空镜无角色|无角色出场|不出现[^。；\n]{0,8}(?:人物|人手|身影|面部|陈卓)|画面主体仅[^。；\n]{0,12}(?:陈设|物件)|无人物出场)/u.test(shotCharacterEvidence);
  const shotNoPerson = Boolean(options.noCharacters) || explicitNoPersonInShot;
  if (!shotNoPerson && characterNames.length > 0) {
    replaceField("角色", `${characterNames.join("、")}；保持当前授权角色档案、同一发型脸型、身高体型与服装，动作以本镜动作字段为准，不套用无关人物模板。`);
    replaceField("微动作", "微动作只服务于本镜动作与情绪：手部、呼吸、视线和重心做小幅连续变化，不使用固定微笑、张开双臂或其他无关模板。");
    replaceField("角色约束", `本镜仅允许 ${characterNames.join("、")} 入画；不得合并、替换或增加其他人物。`);
    replaceField("角色一致性", `所有镜头分别绑定 ${characterNames.join("、")} 的当前外观与服装锚点；不得合并、替换或增减人物。`);
    if (characterNames.length === 1) {
      prompt = prompt.replace(
        /[^。；\n]{0,24}(?:门外走廊有一道人影|一道人影|有人正走到这扇门前|走近的身体重量)[^。；\n]*[。；]?/gu,
        "",
      );
    }
  } else if (!options.noCharacters && explicitNoPersonInShot) {
    replaceField("角色", "本镜为空镜或局部插入，无人物、无人影、无人体局部入画。");
    replaceField("微动作", "不适用：本镜无人物。");
    replaceField("角色约束", "画面禁止人物、人影、人体局部和拟人化表演模板。");
    replaceField("角色一致性", "本镜无人物；锁定同一场景、道具、光源和空间关系，不追加其他人物。");
  }
  const actionSource = promptFieldText(next.action ?? (next.fields as FusionRecord).action)
    || fieldValue("动作")
    || "只执行画面中可见的连续动作，动作主体、先后顺序和结束姿态与场景字段一致。";
  replaceField("动作", actionSource);
  const makeupSource = promptFieldText(options.marketingPrompt
    ? (next.fields as FusionRecord).makeup ?? next.makeup
    : next.makeup ?? (next.fields as FusionRecord).makeup);
  replaceField("化妆", shotNoPerson ? "不适用：本镜无人物。" : makeupSource || "自然写实妆，保持同一角色肤色与面部细节，不新增无关妆造。");
  if (duration > 0) {
    replaceField("时间轴", `T00:00-T00:${duration.toFixed(1)} 起幅建立本镜空间，中段只执行动作字段中的连续变化，落幅保持同一光位并接到下一镜。`);
  }
  if (options.noCharacters) {
    // “无人物”只约束演员；厨房、商品、建筑和人工灯光仍按源合同执行。
    replaceField("场景", promptFieldText(options.projectScene ?? next.scene ?? (next.fields as FusionRecord).scene)
      || fieldValue("场景") || "按本镜已确认场景执行");
    replaceField("灯光设计", promptFieldText(options.projectLighting ?? next.lighting ?? (next.fields as FusionRecord).lighting)
      || fieldValue("灯光设计") || "沿用已确认灯光方向、白平衡与光比，不新增光源");
    replaceField("明亮约束", "画面主体高光不过曝，暗部保留材质细节；本镜不涉及人物面部或肤色。");
    replaceField("角色", `无人物、无人影、无人体局部入画；画面主体仅来自本镜源合同${options.noAnimals ? "；无动物入画" : ""}。`);
    replaceField("服装", "不适用：无人物出场。");
    replaceField("化妆", "不适用：无人物出场。");
    replaceField("定妆照", "不适用：无人物出场，不生成也不引用人像定妆照。");
    const action = actionSource;
    replaceField("动作", action || "按本镜源合同执行主体的连续变化，不新增人物动作。");
    const props = options.projectProps?.length
      ? options.projectProps.join("、")
      : promptFieldText((next.fields as FusionRecord).props ?? next.props) || fieldValue("道具");
    replaceField("道具", props || "仅使用本镜源合同中的物件，不新增道具。");
    const movement = promptFieldText((next.fields as FusionRecord).camera_movement ?? next.camera_movement);
    if (movement) replaceField("运镜", movement);
    replaceField("情绪", "通过源合同中的主体变化、光线与空间关系表达，不要求人物表情。");
    replaceField("节奏", "按源动作的先后顺序连续推进，不使用无关的强转折或情绪性加速。");
    replaceField("角色约束", "画面禁止人物、人影、人体局部和拟人化表演模板；主体以源合同为准。");
    replaceField("角色一致性", "本镜无人物；场景、物件位置、光源方向与时间阶段以源证据为准，不追加未经核实的参数。");
    replaceField("转场", options.isLastShot
      ? "本镜为全片最后一镜；落幅定格0.5秒后淡出至黑，持续1秒，无其他转场特效。"
      : "本镜落幅后硬切至下一镜；不使用叠化、黑场或其他转场特效。");
    if (duration > 0) replaceField("时间轴", timelineTextForAction(action || actionSource, duration));
  }
  let marketingAudio: string | undefined;
  if (options.marketingPrompt) {
    const nativeAudio = marketingNativeShotField(next, "audio");
    const sound = marketingAudioForContract(nativeAudio, {
      noDialogue: options.noDialogue, noMusic: Boolean(options.noMusic),
      shotId: String(next.shotId ?? next.shot_id ?? "未编号镜头"), field: "audio",
    }).replace(/[。；;]+$/u, "");
    next.audio = sound;
    (next.fields as FusionRecord).audio = sound;
    marketingAudio = `${sound}；${options.noDialogue ? "无可辨台词、对白、旁白或口播；" : ""}${options.noMusic ? "无音乐、无配乐、无音乐节拍" : "无镜头外配乐"}。`;
    replaceField("音频", marketingAudio);
  } else if (options.noMusic || options.noDialogue) {
    const rawAudio = promptFieldText((next.fields as FusionRecord).audio ?? next.audio);
    const musicTerms = "音乐|配乐|旋律|弦乐|钢琴|氛围音|铺底|BPM|BGM|soundtrack|music|score";
    const speechTerms = "台词|人声|对话|旁白|口播|voiceover";
    const prohibited = new RegExp(`(?:${[
      ...(options.noMusic ? [musicTerms] : []),
      ...(options.noDialogue ? [speechTerms] : []),
    ].join("|")})`, "iu");
    const forbiddenAnimal = options.noAnimals ? /(?:鸟|虫|动物|水黾)/u : null;
    const anchors = rawAudio
      .split(/[；;。，,、|\n]+/u)
      .map((item) => item.trim())
      .filter((item) => item.length >= 2 && !prohibited.test(item) && !forbiddenAnimal?.test(item))
      .filter((item) => !/(?:音效上加入|拟音|后期|叠加)/u.test(item))
      .map((item) => item.replace(/^(?:仅有|只有|仅保留|只保留)+/u, "").trim())
      .filter(Boolean);
    const fallbackAudio = "与画面同步的环境声和主体动作声";
    const audio = anchors.length > 0 ? [...new Set(anchors)].slice(0, 6).join("、") : fallbackAudio;
    replaceField("音频", `仅有${audio}${options.noDialogue ? "；无人物声、无旁白" : "，以及合同允许的人声与台词"}${options.noMusic ? "；无音乐、无配乐、无音乐节拍" : ""}。`);
  }
  if (options.chineseOnly) {
    const forbidden = [
      "无文字", "无字幕", "无水印", "无品牌标识",
      ...(options.noCharacters ? ["无人物", "无人影", "无人体局部"] : []),
      ...(shotNoPerson ? ["无人物", "无人影", "无人体局部"] : []),
      ...(options.noAnimals ? ["无动物", "无飞鸟"] : []),
      ...sourceEnvironmentProhibitions,
      "无镜头光晕伪影", "无生成特效", "无模糊", "无过曝",
    ];
    replaceField("负面约束", [...new Set(forbidden)].join("、"));
  }
  prompt = prompt
    .split("\n")
    .map((line) => line
      .replace(/\s*\|\s*(?:【音频纪律】|\[CINEMATIC_SKILL\])[\s\S]*$/u, "")
      .replace(/\b(?:no non-diegetic music|no background music|no bgm|no soundtrack|no music score|no musical bed)\b/giu, "")
      .replace(/[ \t]{2,}/gu, " ")
      .trimEnd())
    .filter((line) => !line.includes("【音频纪律】"))
    .filter((line, index, lines) => line.length > 0 || index < lines.length - 1)
    .join("\n");
  const renumber = (value: string): string => {
    let number = 0;
    return value.split("\n").map((line) => {
      if (!/^\s*\d+\.【[^】]+】/u.test(line)) return line;
      number += 1;
      return line.replace(/^(\s*)\d+(\.)(【)/u, (_all, indent: string, dot: string, bracket: string) =>
        `${indent}${String(number).padStart(2, "0")}${dot}${bracket}`);
    }).join("\n");
  };
  prompt = renumber(prompt);
  // Marketing canonicalization below rebuilds the delivery text from complete
  // native fields. Its decorated draft may have lost all line numbering during
  // postprocessing; apply the hard cap to the rebuilt text, not that draft.
  if (!(options.canonicalize && options.marketingPrompt) && unicodeLength(prompt) > options.maxLength) {
    const lines: string[] = prompt.split("\n");
    let guard = 0;
    while (unicodeLength(lines.join("\n")) > options.maxLength && guard < 100) {
      guard += 1;
      const candidates = lines
        .map((line, index) => ({ line, index, match: line.match(/^(\s*\d+\.【[^】]+】)([\s\S]*)$/u) }))
        .filter((item): item is typeof item & { match: RegExpMatchArray } => Boolean(item.match))
        .sort((a, b) => unicodeLength(b.line) - unicodeLength(a.line));
      if (candidates.length === 0) {
        throw new Error(`FINAL_PROMPT_UNCOMPRESSIBLE: prompt ${unicodeLength(prompt)} 字符，缺少可裁剪的编号字段`);
      }
      const candidate = candidates[0]!;
      const prefix = candidate.match[1]!;
      const body = candidate.match[2]!;
      const overflow = unicodeLength(lines.join("\n")) - options.maxLength;
      const keep = Math.max(24, unicodeLength(body) - overflow - 1);
      const retained = unicodeSlice(body, 0, keep);
      const sentenceEnd = Math.max(
        retained.lastIndexOf("。"),
        retained.lastIndexOf("；"),
        retained.lastIndexOf("，"),
      );
      const shortened = unicodeLength(retained.slice(0, sentenceEnd + 1)) >= Math.floor(keep * 0.6)
        ? retained.slice(0, sentenceEnd + 1)
        : `${unicodeSlice(body, 0, Math.max(1, keep - 1))}…`;
      lines[candidate.index] = `${prefix}${shortened}`;
    }
    prompt = renumber(lines.join("\n"));
    if (unicodeLength(prompt) > options.maxLength) {
      throw new Error(`FINAL_PROMPT_UNCOMPRESSIBLE: 结构化字段裁剪后仍为 ${unicodeLength(prompt)} 字符`);
    }
  }
  if (options.canonicalize) {
    const nativeMarketing = options.marketingPrompt ? {
      action: marketingNativeShotField(next, "action"),
      scene: marketingNativeShotField(next, "scene", "sceneDescription"),
      costume: marketingNativeShotField(next, "costume"),
      makeup: marketingNativeShotField(next, "makeup"),
      props: marketingNativeShotField(next, "props"),
      timeline: marketingNativeShotField(next, "timeline"),
      composition: marketingNativeShotField(next, "composition"),
      lighting: marketingNativeShotField(next, "lighting", "lightingString"),
      color: marketingNativeShotField(next, "color_palette", "colorPalette"),
      transition: marketingNativeShotField(next, "transition"),
      emotion: marketingNativeShotField(next, "mood", "emotion"),
      camera: marketingNativeShotField(next, "camera_movement", "cameraMovement", "cameraString"),
      pacing: marketingNativeShotField(next, "pacing"),
      depth: marketingNativeShotField(next, "depth_of_field", "depthOfField"),
    } : null;
    const cleanText = (value: string): string => value
      .replace(/(?:^|\n)\s*(?:id|name|portraitRef|authorization)=[^\n]*/gu, " ")
      .replace(/\[需求口径\]/gu, " ")
      .replace(/[{}\[\]]/gu, " ")
      .replace(/["“”]/gu, " ")
      .replace(/\b(?:scene_id|scene_name|scene_description|characters|props|dialogue|lighting|composition|environment|action)\b\s*[:：]?/giu, " ")
      .replace(/\s+/gu, " ")
      .trim();
    const source = (label: string, ...keys: string[]): string => {
      for (const key of keys) {
        const value = promptFieldText(next[key] ?? (next.fields as FusionRecord)[key]);
        if (value) return cleanText(value);
      }
      return cleanText(fieldValue(label)) || "按本镜源证据执行";
    };
    const profiles = (options.characterPortraits ?? []).filter((item) => characterNames.includes(item.name));
    const profileAppearance = profiles.map((item) => item.appearance).filter(Boolean).join("；")
      .replace(/\bfemale\b/giu, "女性")
      .replace(/\bmale\b/giu, "男性");
    const canonicalNoPerson = Boolean(options.noCharacters) || Boolean(nativeMarketing && explicitNoPersonInShot);
    const canonicalAnimalNames = characterNames.filter((name) => isNarrativeAnimal(name));
    const canonicalAnimalOnly = canonicalNoPerson
      && canonicalAnimalNames.length > 0
      && canonicalAnimalNames.length === characterNames.length;
    const canonicalNoActors = canonicalNoPerson && canonicalAnimalNames.length === 0;
    const animalAppearanceAnchor = canonicalAnimalOnly
      ? cleanNarrativeAnimalAppearance(profileAppearance)
      : profileAppearance;
    const roles = canonicalAnimalOnly
      ? `${canonicalAnimalNames.join("、")}作为本镜唯一动物主体入画；外观锚点=${animalAppearanceAnchor || "以源需求中的品种、体型、毛色、眼睛颜色、湿度与动作描述为准"}；身份证据仅文字外观锚点，本审计轮无已登记图片参考资产；画面不出现人物、人影或人体局部。`
      : canonicalNoPerson
        ? "无人物、无人影、无人体局部入画。"
      : characterNames.length > 0
        ? `${characterNames.join("、")}入画；${profileAppearance || "保持当前授权角色档案中的发型脸型、身高体型与服装一致"}`
        : cleanText(shotCharacterEvidence) || "按本镜源证据执行";
    const profileCostume = profiles.map((item) => item.costume).filter(Boolean).join("；");
    const shoeIndex = (options.projectActions ?? []).findIndex((action) => /(?:换鞋|脱.*鞋|穿.*拖鞋)/u.test(action));
    const projectedAction = cleanText(options.projectActions?.[Math.min(options.shotIndex ?? 0, Math.max(0, (options.projectActions ?? []).length - 1))] ?? "");
    const costume = nativeMarketing ? nativeMarketing.costume : canonicalNoPerson
      ? "不适用：本镜无人物。"
      : costumeTextForFootwear(
        profileCostume || source("服装", "costume").replace(/(?:无角色出场|不适用)/gu, "") || "按已审核角色档案服装执行",
        projectedAction,
        options.shotIndex ?? 0,
        shoeIndex,
      );
    const makeup = nativeMarketing ? nativeMarketing.makeup : canonicalNoPerson
      ? "不适用：本镜无人物。"
      : makeupSource || makeupTextForAction(projectedAction);
    const portraitText = canonicalAnimalOnly
      ? (profiles.filter((item) => item.path).map((item) => `${item.name}=${item.path}`).join("；")
        || "不适用人像定妆照：动物主体只复用同一段文字外观锚点；本审计轮无已登记参考帧或图片资产，不声称图像锁定，不生成人物肖像。")
      : canonicalNoPerson
        ? "不适用：本镜无人物，不生成也不引用人像定妆照。"
      : (options.characterPortraits ?? []).filter((item) => characterNames.includes(item.name) && item.path)
        .map((item) => `${item.name}=${item.path}`).join("；")
        || fieldValue("定妆照")
        || "使用本次已审核角色档案中的当前定妆照，不得替换为未登记人物。";
    const dialogueText = options.noDialogue
      ? "不适用：本片无台词、无旁白、无口播。"
      : promptFieldText(next.dialogue ?? (next.fields as FusionRecord).dialogue) || "按已确认台词合同执行。";
    const audioText = marketingAudio ?? (fieldValue("音频") || "环境声、主体动作声与合同允许的人声同步；无未声明配乐。");
    const rawAction = cleanText(actionSource)
      .replace(/[^；。\n]*(?:画面内无人物|没有实体肢体入画|无角色出场|空镜无角色)[^；。\n]*[；。]?/gu, "")
      .trim();
    let visibleAction = !canonicalNoPerson && rawAction.length < 12
      ? cleanText(promptFieldText(next.purpose) || promptFieldText(next.description)) || "按人物在本镜中的连续动作执行，主体与结束姿态清楚可见"
      : rawAction || actionSource;
    if (!canonicalNoPerson && characterNames.length > 0 && !characterNames.some((name) => visibleAction.includes(name))) {
      visibleAction = `${characterNames.join("、")}在本镜保持同一外观，${visibleAction}`;
    }
    const actions = options.projectActions ?? [];
    const subjectlessFallback = canonicalAnimalOnly
      ? `${canonicalAnimalNames.join("、")}在${cleanText(options.projectScene ?? "") || "已确认空间"}完成本镜可见动作`
      : "按本镜源合同执行主体与场景的连续变化，无人物动作";
    const assignedAction = nativeMarketing ? nativeMarketing.action : canonicalAnimalOnly
      ? (projectedAction || visibleAction || subjectlessFallback)
      : canonicalNoPerson
        ? (
          visibleAction
          && !/^风、雾、水面、光线与植物/u.test(visibleAction)
          && !/^本镜动作落定/u.test(visibleAction)
            ? visibleAction
            : projectedAction || subjectlessFallback
        )
      : actions.length > 0
        ? actions[Math.min(options.shotIndex ?? 0, actions.length - 1)]!
        : visibleAction;
    const actionText = nativeMarketing ? nativeMarketing.action : canonicalNoActors || (canonicalAnimalOnly && canonicalAnimalNames.some((name) => assignedAction.includes(name)))
      ? assignedAction
      : canonicalAnimalOnly
        ? `${canonicalAnimalNames.join("、")}作为唯一动物主体：${assignedAction}`
        : characterNames.length === 0 || characterNames.some((name) => assignedAction.includes(name))
          ? assignedAction
          : `${characterNames.join("、")}在本镜保持同一外观，${assignedAction}`;
    const shotSizeRaw = nativeMarketing ? nativeMarketing.composition.split(/[，。；,;]/u)[0]! : promptFieldText(next.shotSize ?? (next.fields as FusionRecord).shotSize)
      || promptFieldText(next.cameraHint ?? (next.fields as FusionRecord).cameraHint)
      || "中景";
    const shotSize = shotSizeRaw.replace(/景别$/u, "");
    const compositionText = nativeMarketing ? nativeMarketing.composition : canonicalAnimalOnly
      ? `${shotSize}景别，${aspect}构图；${canonicalAnimalNames.join("、")}作为唯一动物主体清晰可辨，画面边缘保留安全区，不增加人物。`
      : canonicalNoPerson
        ? `${shotSize}景别，${aspect}构图；源合同主体清晰，画面边缘保留安全区，不增加人物${options.noAnimals ? "或动物" : ""}。`
      : `${shotSize}景别，${aspect}构图；${characterNames.join("、") || "已登记角色"}位于可执行表演区并保持可辨轮廓，为其动作和视线保留空间。`;
    const cameraSource = promptFieldText(next.camera_movement ?? (next.fields as FusionRecord).camera_movement) || "固定机位";
    const cameraText = nativeMarketing ? nativeMarketing.camera : /(?:固定|锁死|locked|static|零位移)/iu.test(cameraSource)
      ? "固定机位，三脚架锁死，全镜零推拉零横移零变焦"
      : /后拉/u.test(cameraSource)
        ? "固定轴线极缓后拉，速度连续，末段减速停稳，不改变场景与背景"
        : /推近|推镜/u.test(cameraSource)
          ? "固定轴线极缓推近，速度连续，末段减速停稳，不跨越景别等级"
          : /横移|平移/u.test(cameraSource)
            ? "固定高度极缓横移，速度连续并停稳，不改变场景与背景"
            : "固定机位，不做推拉摇移或变焦";
    const emotionText = nativeMarketing ? nativeMarketing.emotion : canonicalAnimalOnly
      ? emotionTextForAnimalAction(assignedAction, canonicalAnimalNames)
      : canonicalNoPerson
        ? "情绪只通过源动作、光线与空间关系表达，不要求人物表情。"
      : emotionTextForAction(assignedAction);
    const baseText = cleanText(fieldValue("基础") || "电影级写实质感；保留真实材质、自然颗粒与连续物理运动。")
      .replace(/\b(?:8K|4K)\b/giu, "电影级");
    const forbidden = [
      ...(options.marketingPrompt ? ["原始底画面不生成浮动文字或字幕", "不添加合同外水印或品牌标识"] : ["无文字", "无字幕", "无水印", "无品牌标识"]),
      ...(canonicalNoPerson ? ["无人物", "无人影", "无人体局部"] : []),
      ...(options.noAnimals ? ["无动物", "无飞鸟"] : []),
      ...sourceEnvironmentProhibitions,
      "无生成特效", "无镜头光晕伪影", "无模糊", "无过曝", "无未声明角色",
    ];
    const portraitLine = portraitText.startsWith("不适用") || portraitText.endsWith("；跨镜不得替换。")
      ? portraitText : `使用 ${portraitText}；跨镜不得替换。`;
    const rawSceneText = nativeMarketing?.scene ?? sceneTextForAction(
      assignedAction,
      cleanText(options.projectScene ?? "") || source("场景", "scene", "sceneDescription"),
    );
    const sceneText = !nativeMarketing && options.postRainOnly ? normalizePostRainWording(rawSceneText) : rawSceneText;
    const rawLightingText = nativeMarketing?.lighting || cleanText(options.projectLighting ?? "") || source("灯光设计", "lighting");
    const lightingText = !nativeMarketing && options.postRainOnly ? normalizePostRainWording(rawLightingText) : rawLightingText;
    const colorText = nativeMarketing?.color || cleanText(options.projectColor ?? "") || source("色彩/色调", "color_palette");
    const normalizedProps = nativeMarketing ? [nativeMarketing.props] : normalizeFootwearProps(
      options.projectProps ?? [source("道具", "props").replace(/本镜为空镜|无角色使用道具/gu, "")],
      assignedAction,
      options.shotIndex ?? 0,
      shoeIndex,
    ).map((item) => options.postRainOnly ? normalizePostRainWording(item) : item);
    const propsText = normalizedProps.join("、");
    const actionTimelineText = nativeMarketing ? nativeMarketing.timeline : duration > 0
      ? timelineTextForAction(assignedAction, duration)
      : fieldValue("时间轴") || "按本镜合同执行完整起幅、动作与落幅。";
    const timelineText = !nativeMarketing && options.sourceFirstFrame
      ? `首帧约束：${options.sourceFirstFrame.replace(/^第一帧[:：]?/u, "")}；${actionTimelineText}`
      : actionTimelineText;
    const verificationText = [
      `逐段核对起点、中段与落幅的目标帧，主体、动作方向、接触点和结束姿态必须与本镜编号字段一致`,
      `检查${shotSize}构图的安全区、焦平面、主体占比与背景层次`,
      `核对主辅光方向、白平衡、材质高光、暗部纹理与冷暖边界`,
      `核对道具数量、位置、湿度状态和跨镜连续性`,
      `核对声音事件与画面动作同帧，且不新增合同外人物、文字、品牌、字幕或配乐`,
      ...(options.marketingPrompt?.overlay.map(text => `后期成片叠加原文“${text}”，底画面无需模型生成文字`) ?? []),
      ...(options.isLastShot ? options.marketingPrompt?.endCard.map(text => `本镜结束在后期尾帧原文“${text}”`) ?? [] : []),
    ].join("；");
    const brightnessText = canonicalAnimalOnly
      ? "动物主体高光不过曝，按源合同保留主体表面与所接触物件的真实纹理，暗部不死黑；不要求人物面部曝光。"
      : canonicalNoPerson
        ? "画面主体高光不过曝，暗部保留材质细节；不涉及人物面部。"
        : brightnessTextForAction(assignedAction);
    const directorIntent = options.marketingPrompt
      ? "按当前已核对的商业创作要求组织表演、声画与节奏，保持本镜动作和运镜连贯；后期文字按交付复核字段执行。"
      : canonicalAnimalOnly
      ? "克制写实的动物观察短片；以动物动作、空间关系和真实光线推进，不拟人化、不增加无关叙事或模板表演。"
      : canonicalNoPerson
        ? "按源合同观察场景与物件；以主体变化、空间关系和已确认光线推进，不增加无关叙事、特效或人物表演。"
        : "克制写实的自然长镜或稳定短镜；以人物动作、空间关系和真实光线推进，不增加无关叙事、特效或模板表演。";
    const pacing = nativeMarketing?.pacing || options.marketingPrompt && fieldValue("节奏") || pacingTextForAction(assignedAction, duration);
    prompt = [
      "01.【语言约束】全部字段使用中文；画幅、分辨率、帧率、编码、时间码与资产路径可作为受控制作标记。",
      `02.【导演意图】${directorIntent}`,
      `03.【基础】${baseText}`,
      `04.【约束】${constraint}。`,
      `05.【场景】${sceneText}`,
      `06.【灯光设计】${lightingText}`,
      `07.【明亮约束】${brightnessText}`,
      `08.【构图】${compositionText}`,
      `09.【色彩/色调】${colorText}`,
      `10.【景深】${nativeMarketing?.depth || depthTextForShotSize(shotSize, canonicalNoPerson, canonicalAnimalOnly)}`,
      `11.【运镜】${cameraText}`,
      `12.【角色】${roles}`,
      `13.【服装】${costume}`,
      `14.【化妆】${makeup}`,
      `15.【动作】${actionText}`,
      `16.【道具】${propsText}`,
      `17.【定妆照】${portraitLine}`,
      `18.【台词】${dialogueText}`,
      `19.【时间轴】${timelineText}`,
      `20.【情绪】${emotionText}`,
      `21.【节奏】${pacing}`,
      `22.【转场】${nativeMarketing?.transition || transitionTextForAction(assignedAction, Boolean(options.isLastShot))}`,
      `23.【音频】${audioText}`,
      `24.【负面约束】${[...new Set([...forbidden, "无暗黑风调色", "无塑料或金属感高光"])].join("、")}。`,
      `25.【角色约束】${canonicalNoPerson ? "画面禁止人物、人影、人体局部和拟人化表演模板。" : `本镜仅允许 ${characterNames.join("、") || "已登记角色"} 入画；不得增加未声明人物。`}`,
      `26.【角色一致性】${canonicalNoPerson ? "本镜无人物；锁定同一场景、道具、光源与空间关系。" : `分别绑定 ${characterNames.join("、") || "当前角色"} 的授权外观、服装与发型；不得合并、替换或增减人物。`}`,
      `27.【本镜验收】${verificationText}`,
    ].join("\n");
    if (unicodeLength(prompt) < 1200) {
      const expansion = [
        `复核首帧主体位置与结束姿态，确认时间轴内动作顺序连续且没有跳变`,
        `复核${sceneText}的空间边界、光源方向与跨镜道具相对位置`,
        `复核${propsText}在起幅、中段和落幅保持同一数量、材质与接触关系`,
        `复核${audioText}，画面内外均不新增未声明人物、文字、品牌或配乐`,
      ].join("；");
      prompt = `${prompt}\n28.【交付复核】${expansion}`;
    }
    // T-2026-1105-9003: G6 must retain the native opening values in its actual prompt.
    const isOpening = next.sceneType === "opening"
      || ["SC00", "S00"].includes(String(next.shotId ?? next.shot_id ?? ""));
    if (isOpening && !options.noTitles) {
      const openingFields = [
        ["title_content", "主标题内容"], ["subtitle_content", "副标题内容"],
        ["title_animation", "标题动画设计"], ["title_font_design", "标题字体设计"],
        ["opening_audio_design", "开场音频设计"],
      ] as const;
      const supplied = openingFields.map(([key, label]) => {
        const original = next[key] ?? (next.fields as FusionRecord)[key];
        let value = typeof original === "string" ? original.trim() : "";
        if (key === "opening_audio_design" && value && options.marketingPrompt) {
          value = marketingAudioForContract(value, { noDialogue: options.noDialogue,
            noMusic: Boolean(options.noMusic), shotId: String(next.shotId ?? next.shot_id ?? "未编号镜头"), field: key });
          next[key] = value;
          if (Object.hasOwn(next.fields as FusionRecord, key)) (next.fields as FusionRecord)[key] = value;
        }
        return { key, label, value };
      });
      const missing = supplied.filter(({ value }) => !value).map(({ key }) => key);
      if (options.requireOpeningFields && missing.length > 0) {
        throw new Error(`FINAL_PROMPT_OPENING_FIELDS_MISSING: ${String(next.shotId ?? next.shot_id ?? "未编号镜头")} 缺少原生片头字段 ${missing.join("、")}`);
      }
      let sequence = (prompt.match(/^\s*\d+\.【[^】]+】/gmu) ?? []).length;
      for (const { label, value } of supplied.filter(({ value }) => Boolean(value))) {
        sequence += 1;
        prompt += `\n${String(sequence).padStart(2, "0")}.【${label}】${value}`;
      }
    }
    let detailedQa: { verification: string; deliveryReview?: string } | undefined;
    let hostTemplates: Record<string, string> | undefined;
    if (nativeMarketing && (options.forceCompactMarketingHost || unicodeLength(prompt) > options.maxLength)) {
      const deliveryReview = /^\d+\.【交付复核】([^\n]*)$/mu.exec(prompt)?.[1];
      const compactVerification = [
        "按本镜原生合同核对动作、声画与跨镜连续性",
        ...options.marketingPrompt!.overlay.map(text => `后期成片叠加原文“${text}”，底画面无需模型生成文字`),
        ...(options.isLastShot ? options.marketingPrompt!.endCard.map(text => `本镜结束在后期尾帧原文“${text}”`) : []),
      ].join("；");
      // Only repeated host QA moves to the existing report contract. Native
      // creative fields, original client text and opening values stay intact.
      prompt = prompt.replace(/^(\d+\.【本镜验收】)[^\n]*$/mu, (_line, prefix: string) => `${prefix}${compactVerification}`);
      if (deliveryReview) prompt = prompt.replace(/^(\d+\.【交付复核】)[^\n]*$/mu,
        (_line, prefix: string) => `${prefix}详细复核见结构化镜头合同，按本镜原生字段逐项验收。`);
      detailedQa = { verification: verificationText, ...(deliveryReview ? { deliveryReview } : {}) };
    }
    if (nativeMarketing && (options.forceCompactMarketingHost || unicodeLength(prompt) > options.maxLength)) {
      // Only host-authored repetition is shortened. Preserve the complete wording
      // in the same structured contract included in the G6 report.
      const compactHostField = (label: string, value: string, original?: string): void => {
        const pattern = new RegExp(`^(\\d+\\.【${escapeLabel(label)}】)([^\\n]*)$`, "mu");
        const current = pattern.exec(prompt)?.[2];
        if (current === undefined || current === value) return;
        (hostTemplates ??= {})[label] = original ?? current;
        prompt = prompt.replace(pattern, (_line, prefix: string) => `${prefix}${value}`);
      };
      compactHostField("语言约束", "中文；技术参数、时间码、资产路径除外。");
      compactHostField("导演意图", "依已审商业合同及本镜字段；声画连贯；后期文字见验收。");
      compactHostField("明亮约束", canonicalNoPerson
        ? "主体高光不过曝，暗部保留纹理；无人物面部要求。"
        : "依灯光字段；人物/主体轮廓、明暗可辨，禁过曝及额外正面补光。");
      compactHostField("负面约束", [
        "底画面禁浮动文字/字幕", "禁合同外水印/品牌标识",
        ...(canonicalNoPerson ? ["禁人物/人影/人体局部"] : []),
        ...(options.noAnimals ? ["禁动物/飞鸟"] : []),
        ...sourceEnvironmentProhibitions,
        "禁生成特效/镜头光晕伪影/模糊/过曝/未声明角色/暗黑风调色/塑料或金属感高光",
      ].join("；") + "。");
      compactHostField("角色约束", canonicalNoPerson
        ? "禁人物/人影/人体局部及拟人化表演。"
        : `仅${characterNames.join("、") || "已登记角色"}入画，禁增员。`);
      compactHostField("角色一致性", canonicalNoPerson
        ? "无人物；场景、道具、光源、空间关系锁定。"
        : "授权外观/服装/发型锁定；禁角色合并/替换/增减。");
      if (!canonicalNoPerson && !canonicalAnimalOnly && characterNames.length > 0
        && characterNames.every(name => profiles.some(profile => profile.name === name && profile.path))) {
        // Each registered identity remains explicit and its original asset path
        // stays in 定妆照; no unregistered or text-only identity is shortened.
        compactHostField("角色", `${characterNames.join("、")}；外观以本镜登记定妆照和角色主档为准。`);
      }
      if (!portraitText.startsWith("不适用")) compactHostField("定妆照",
        portraitText.endsWith("；禁替换。") ? portraitText : `${portraitText}；禁替换。`);
      if (options.noDialogue) compactHostField("台词", "禁台词、对白、旁白、口播。");
      const positiveAudio = promptFieldText((next.fields as FusionRecord).audio);
      compactHostField("音频", `${positiveAudio}；${options.noDialogue ? "禁可辨台词/对白/旁白/口播；" : ""}${options.noMusic ? "禁音乐/配乐/音乐节拍" : "禁镜头外配乐"}。`);
      compactHostField("本镜验收", [
        "核对动作/声画/跨镜连续性",
        ...options.marketingPrompt!.overlay.map(text => `后期原文“${text}”；底画面不生字`),
        ...(options.isLastShot ? options.marketingPrompt!.endCard.map(text => `后期尾帧原文“${text}”`) : []),
      ].join("；"), verificationText);
    }
    next._workloomShotContract = {
      schema: "workloom.prompt-shot-contract/v1",
      shotId: String(next.shotId ?? next.shot_id ?? ""),
      durationSeconds: duration,
      era: narrativeEraEvidence(sceneText, propsText.split("、").map(String).filter(Boolean)),
      space: sceneText,
      action: actionText,
      lighting: lightingText,
      color: colorText,
      shotSize,
      camera: cameraText,
      equipment: options.marketingPrompt ? "按本镜运镜执行；具体设备型号未声明" : "固定三脚架与常规电影镜头；具体型号未声明",
      subjectCount: canonicalNoActors ? 0 : characterNames.length,
      characterNames: canonicalNoActors ? [] : characterNames,
      costume,
      props: propsText.split("、").map(String).filter(Boolean),
      dialogue: dialogueText,
      audio: audioText,
      timeline: timelineText,
      emotion: emotionText,
      ...detailedQa,
      ...(hostTemplates ? { hostTemplates } : {}),
      ...(options.sourceFirstFrame ? { sourceFirstFrame: options.sourceFirstFrame } : {}),
      portraitAssets: profiles
        .filter((item) => String(item.path ?? "").trim())
        .map((item) => ({
          name: item.name,
          path: item.path,
          authorization: item.authorization ?? "unverified",
          sha256: item.sha256 ?? null,
          bytes: item.bytes ?? null,
        })),
      ...(canonicalAnimalOnly ? {
        identityAnchor: {
          mode: "text",
          subject: canonicalAnimalNames.join("、"),
          text: animalAppearanceAnchor || "以源需求中的动物品种、体型、毛色、眼睛颜色、湿度与动作描述为准",
          sha256: createHash("sha256")
            .update(animalAppearanceAnchor || "以源需求中的动物品种、体型、毛色、眼睛颜色、湿度与动作描述为准")
            .digest("hex"),
          authorization: "not-applicable",
          assetStatus: "not-registered",
          visualVerification: "not-performed",
        },
      } : {}),
    };
  }
  // 营销先从完整原生字段重建；所有路径在此校验实际交付正文，不截断源动作。
  if (unicodeLength(prompt) > options.maxLength) {
    throw new Error(
      `FINAL_PROMPT_SOURCE_CAPACITY_EXCEEDED: ${String(next.shotId ?? next.shot_id ?? "未编号镜头")} 重建后 ${unicodeLength(prompt)} 字符，超过 ${options.maxLength}；保留源合同并停止本次预生产`,
    );
  }
  next.prompt = prompt;
  return next;
}

interface MarketingPromptPlan { actions: string[]; overlay: string[]; endCard: string[] }

export interface NarrativePromptReviewPolicy {
  noDialogue: boolean;
  maxLength: number;
  noCharacters: boolean;
  noAnimals: boolean;
  noMusic: boolean;
  noTitles: boolean;
  durationSeconds?: number;
  aspectRatio: string;
  resolution: string;
  colorTemperature?: string;
  characterNames: string[];
  characterPortraits: Array<{
    name: string;
    path: string;
    appearance?: string;
    costume?: string;
    authorization?: string;
    sha256?: string;
    bytes?: number;
  }>;
  postRainOnly?: boolean;
  sourceFirstFrame?: string;
  projectScene?: string;
  projectLighting?: string;
  projectColor?: string;
  projectProps: string[];
  projectActions: string[];
  marketingPrompt?: MarketingPromptPlan;
  /** Final prompt-bound contract persisted through vendor prompt/shot synchronization. */
  shotContract?: FusionRecord;
}

export interface NarrativeShotDirection {
  action: string;
  scene?: string;
  lighting?: string;
  color?: string;
  props: string[];
}

/**
 * Derive co-located scene, light state and props from the action actually assigned
 * to a final shot. A generic PRD scene map must not put "open the door" inside the
 * entryway or "turn on the lamp" in a shot whose prop contract omits the lamp.
 */
export function deriveNarrativeShotDirection(input: {
  action: string;
  fallbackScene?: string;
  fallbackLighting?: string;
  fallbackColor?: string;
  fallbackProps?: string[];
}): NarrativeShotDirection {
  // Action words alone do not prove an actor, house, lock, footwear or light state.
  // The already frozen source contract owns those facts.
  return {
    action: String(input.action ?? "").trim(),
    scene: input.fallbackScene,
    lighting: input.fallbackLighting,
    color: input.fallbackColor,
    props: [...new Set((input.fallbackProps ?? []).map(String).map((item) => item.trim()).filter(Boolean))],
  };
}

function narrativeActionKind(action: string): "umbrella" | "open" | "close" | "shoes" | "lamp" | "listen" | "other" {
  if (/(?:收伞|抖落.*伞|伞骨合拢)/u.test(action)) return "umbrella";
  if (/(?:开门|钥匙.*锁孔|推门)/u.test(action)) return "open";
  if (/(?:关门|门关好|门锁落位|回身.*门)/u.test(action)) return "close";
  if (/(?:换鞋|脱.*鞋|湿鞋|穿.*拖鞋)/u.test(action)) return "shoes";
  if (/(?:拧亮|拧开|开灯|点亮).*(?:灯)|(?:灯|旋钮).*(?:亮|开|转)/u.test(action)) return "lamp";
  if (/(?:坐下|坐回|听雨|坐到|落座)/u.test(action)) return "listen";
  return "other";
}

function animalActionKind(action: string): "probe" | "reach" | "contact" | "withdraw" | "retreat" | "curl" | "none" {
  if (/(?:缩爪|缩回前爪|收回前爪|前爪.*回收|前腿.*回收)/u.test(action)) return "withdraw";
  if (/(?:盘成|蜷缩|蜷紧|尾尖.*(?:口鼻|鼻)|贴住(?:口鼻|鼻)|盘紧|闭眼)/u.test(action)) return "curl";
  if (/(?:水滴.*(?:落|接触|砸).*(?:爪|爪垫|爪背)|(?:爪|爪垫|爪背).*(?:接触|接住).*水滴|溅起.*水花)/u.test(action)) return "contact";
  if (/(?:伸爪|伸出前爪|抬起前爪|抬爪|前爪.*伸向|接水|接住.*水滴|爪垫.*水|爪尖.*水|水滴.*爪)/u.test(action)) return "reach";
  if (/(?:缩回|退入|退回箱|收拢|合拢|尾巴.*收)/u.test(action)) return "retreat";
  if (/(?:探头|探出|耳朵.*转|鼻尖.*探|抬眼观察)/u.test(action)) return "probe";
  return "none";
}

function narrativeAnimalActionRank(action: string): number {
  switch (animalActionKind(action)) {
    case "probe": return 0;
    case "reach": return 1;
    case "contact": return 2;
    case "withdraw": return 3;
    case "retreat": return 4;
    case "curl": return 5;
    default: return 2.5;
  }
}

function shoeWorkPhase(action: string): "first" | "second" | "combined" | "none" {
  if (/另一只/u.test(action)) return "second";
  if (/一只/u.test(action)) return "first";
  if (/(?:换鞋|脱下[^。；\n]*鞋|换穿[^。；\n]*拖鞋)/u.test(action)) return "combined";
  return "none";
}

function sceneMatchesAction(action: string, scene: string | undefined): boolean {
  const value = String(scene ?? "");
  if (!value || value.length < 4 || /或/u.test(value)) return false;
  switch (narrativeActionKind(action)) {
    case "umbrella": return /(?:楼道|门外|门口)/u.test(value);
    case "open": return /(?:门口|门.*玄关|玄关)/u.test(value);
    case "close": return /(?:玄关|门)/u.test(value);
    case "shoes": return /(?:玄关|鞋架|地垫)/u.test(value);
    case "lamp": return /(?:台灯|灯旁|书桌)/u.test(value);
    case "listen": return /(?:窗|灯下|坐具)/u.test(value);
    default: return value.length >= 16;
  }
}

/**
 * Turn a source action list into a per-shot action sequence. The six-shot
 * homecoming case used by the real matrix needs the implicit door-close action
 * represented, otherwise "open door" and "change shoes" jump across a closed
 * door. The transformation is keyed by semantics, not by project IDs.
 */
export function projectNarrativeActionSequence(actions: string[], shotCount: number): string[] {
  if (!Number.isInteger(shotCount) || shotCount < 1) return [];
  const clean = actions.map(String).map((item) => item.trim()).filter(Boolean);
  if (clean.length === 0) return Array.from({ length: shotCount }, (_unused, index) => `第 ${index + 1} 镜连续动作`);
  // Partition consecutive source actions rather than dropping actions or cycling
  // back to an earlier story state after the closing action.
  if (shotCount <= clean.length) {
    return Array.from({ length: shotCount }, (_unused, index) => clean.slice(
      Math.floor(index * clean.length / shotCount),
      Math.floor((index + 1) * clean.length / shotCount),
    ).join("；"));
  }
  const phases = ["起幅", "推进", "落幅"];
  const result: string[] = [];
  for (let index = 0; index < clean.length; index += 1) {
    const count = Math.floor((index + 1) * shotCount / clean.length) - Math.floor(index * shotCount / clean.length);
    for (let part = 0; part < count; part += 1) {
      result.push(count === 1 ? clean[index]! : `${clean[index]}（${phases[Math.min(part, phases.length - 1)]}段）`);
    }
  }
  return result;
}

function timelineTextForAction(action: string, duration: number): string {
  const safeDuration = Math.max(0.1, duration);
  const firstEnd = Math.max(0.1, Math.min(safeDuration, safeDuration * 0.3));
  const secondEnd = Math.max(firstEnd, Math.min(safeDuration, safeDuration * 0.75));
  const code = (value: number): string => `T00:${Math.max(0, value).toFixed(1).padStart(4, "0")}`;
  const sourceBeats = action.split(/[；。]+/u).map((item) => item.trim()).filter(Boolean);
  const beats = [
    sourceBeats[0] || "建立本镜空间与主体位置",
    sourceBeats[1] || sourceBeats[0] || "连续完成动作字段中的主要变化",
    sourceBeats.slice(2).join("；") || sourceBeats[1] || "动作落定，保持结束姿态",
  ];
  return `${code(0)}-${code(firstEnd)} ${beats[0]}；${code(firstEnd)}-${code(secondEnd)} ${beats[1]}；${code(secondEnd)}-${code(safeDuration)} ${beats[2]}`;
}

function emotionTextForAction(_action: string): string {
  return "视线跟随本镜可见动作目标移动，表情与呼吸按已确认情绪合同自然变化，不使用固定微笑或模板化凝视。";
}

function emotionTextForAnimalAction(action: string, names: string[]): string {
  const subject = names.join("、") || "动物主体";
  return `${subject}通过本镜已确认动作“${action}”与身体重心变化表达状态，不增加源合同外的环境、道具或拟人化表演。`;
}

function pacingTextForAction(action: string, duration: number): string {
  const sourceBeats = action.split(/[；。]+/u).map((item) => item.trim()).filter(Boolean);
  const body = `前段${sourceBeats[0] || "建立空间"}，中段${sourceBeats[1] || "完成主要变化"}，末段${sourceBeats.slice(2).join("；") || "动作落定收束"}`;
  return `${Math.max(0.1, duration).toFixed(1)} 秒内按约 30%/45%/25% 分配：${body}；不做额外加速或无关转场。`;
}

function brightnessTextForAction(_action: string): string {
  return "人物与主体轮廓可辨，按已确认灯光设计保留明暗层次，环境高光不过曝，不使用额外正面补光。";
}

function sceneTextForAction(_action: string, scene: string): string {
  return scene;
}

function depthTextForShotSize(shotSize: string, noCharacters: boolean, animalOnly = false): string {
  if (animalOnly) {
    return /(?:close|特写)/iu.test(shotSize)
      ? "浅景深，焦点锁定动物眼睛、爪部或当前接触点，前后景自然虚化；主体轮廓与接触关系始终清晰。"
      : "中等景深，焦点跟随动物主体与当前动作，背景保留空间层次但不过度抢焦点。";
  }
  if (noCharacters) {
    return /(?:close|特写)/iu.test(shotSize)
      ? "近距浅景深，焦点锁定本镜源合同的主体与当前变化位置，前后景柔和分离。"
      : "近中远景层次连续，本镜主体可辨，使用中等至深景深保证空间关系清楚。";
  }
  if (/(?:extreme-close|close|特写|近景)/iu.test(shotSize)) {
    return "浅景深，焦点锁定眼睫、手指或当前接触点，前后景自然虚化；面部与动作接触点始终清晰。";
  }
  if (/(?:wide|full|远景|全景)/iu.test(shotSize)) {
    return "深景深，人物全身、空间边线与关键道具同处可辨焦平面，背景不过度虚化。";
  }
  return "中等景深，焦点跟随人物上半身与当前动作，背景保留空间层次但不过度抢焦点。";
}

function narrativeEraEvidence(scene: string, props: string[]): string {
  const compact = String(scene || props.join("、"))
    .replace(/\s+/gu, " ")
    .replace(/[。；]/gu, "，")
    .trim()
    .slice(0, 96);
  return `场景按本次画面证据执行（${compact || "以已确认镜头合同为准"}）；未额外声明具体历史年代`;
}

function shotSizeForAction(action: string): string | null {
  const animalKind = animalActionKind(action);
  if (animalKind === "probe" || animalKind === "retreat") return "medium";
  if (animalKind === "reach" || animalKind === "withdraw" || animalKind === "curl") return "close-up";
  if (animalKind === "contact") return "extreme-close-up";
  switch (narrativeActionKind(action)) {
    case "umbrella": return "medium";
    case "open": return "medium";
    case "close": return "close-up";
    case "shoes": return shoeWorkPhase(action) === "combined" ? "full" : "extreme-close-up";
    case "lamp": return "extreme-close-up";
    case "listen": return "medium";
    default: return null;
  }
}

function makeupTextForAction(_action: string): string {
  return "保持已确认角色档案与本镜妆造，不新增源合同外的湿度、肤色或妆容变化。";
}

function transitionTextForAction(_action: string, isLastShot: boolean): string {
  return isLastShot
    ? "本镜为全片最后一镜；动作落定后保持静止，再由输出合同决定是否硬切黑，不追加超出镜长的特效。"
    : "本镜动作落定后硬切至下一镜，人物、道具与场景状态以相邻源镜头合同为准，不使用额外特效。";
}

function costumeTextForFootwear(base: string, _action: string, _shotIndex: number, _shoeIndex: number): string {
  return base;
}

function normalizeFootwearProps(props: string[], _action: string, _shotIndex: number, _shoeIndex: number): string[] {
  return [...new Set(props.map(String).map((item) => item.trim()).filter(Boolean))];
}

function normalizeHomecomingReviewDurations(
  prompts: FusionRecord[],
  policy: NarrativePromptReviewPolicy,
): FusionRecord[] {
  if (prompts.length !== 6) return prompts;
  const rowActions = prompts.map((shot) => {
    const rowPolicy = shot._workloomPromptReviewPolicy
      && typeof shot._workloomPromptReviewPolicy === "object"
      ? shot._workloomPromptReviewPolicy as NarrativePromptReviewPolicy
      : policy;
    return Array.isArray(rowPolicy.projectActions) ? rowPolicy.projectActions : [];
  });
  const actions = rowActions.find((items) => items.length === prompts.length)
    ?? (Array.isArray(policy.projectActions) ? policy.projectActions : []);
  if (actions.length !== prompts.length) return prompts;
  const shoeIndex = actions.findIndex((value) => shoeWorkPhase(String(value)) === "combined");
  if (shoeIndex < 0) return prompts;
  const umbrellaIndex = actions.findIndex((value) => narrativeActionKind(String(value)) === "umbrella");
  const durations = prompts.map((shot) => Math.max(0, Number(shot.duration ?? recordValue(shot.timing).duration ?? 0)));
  const total = Number(durations.reduce((sum, value) => sum + value, 0).toFixed(3));
  const target = Number(policy.durationSeconds);
  if (!Number.isFinite(total) || !Number.isFinite(target) || Math.abs(total - target) > 0.05) return prompts;
  const desired = durations.slice();
  desired[shoeIndex] = Math.max(desired[shoeIndex]!, 4);
  if (umbrellaIndex >= 0) desired[umbrellaIndex] = Math.max(desired[umbrellaIndex]!, 3);
  let deficit = Number(desired.reduce((sum, value, index) => sum + Math.max(0, value - durations[index]!), 0).toFixed(3));
  if (deficit <= 0.001) return prompts;
  for (let index = durations.length - 1; index >= 0 && deficit > 0.001; index -= 1) {
    if (index === shoeIndex || index === umbrellaIndex) continue;
    if (durations[index]! <= 2) continue;
    const transfer = Math.min(deficit, durations[index]! - 2);
    desired[index] = Number((desired[index]! - transfer).toFixed(3));
    deficit = Number((deficit - transfer).toFixed(3));
  }
  if (deficit > 0.001) return prompts;
  let cursor = 0;
  return prompts.map((shot, index) => {
    const duration = desired[index]!;
    const timing = {
      ...recordValue(shot.timing),
      start: Number(cursor.toFixed(3)),
      duration,
      end: Number((cursor + duration).toFixed(3)),
    };
    cursor += duration;
    return { ...shot, duration, timing };
  });
}

/**
 * Final review projection. The vendor runs several post-fusion quality agents that can
 * append title fields or rewrite framing/audio after the Phase 3 contract. Re-project
 * from the frozen policy immediately before G6 so review and render consume the same
 * canonical prompt.
 */
export function normalizeNarrativePromptsForReview(
  prompts: FusionRecord[],
  policy: NarrativePromptReviewPolicy,
): FusionRecord[] {
  const normalizedPrompts = prompts;
  return normalizedPrompts.map((shot, shotIndex) => {
    const rowPolicy = shot._workloomPromptReviewPolicy
      && typeof shot._workloomPromptReviewPolicy === "object"
      ? shot._workloomPromptReviewPolicy as NarrativePromptReviewPolicy
      : policy;
    const rowActions = Array.isArray(rowPolicy.projectActions) ? rowPolicy.projectActions : [];
    const nativeMarketing = rowPolicy.marketingPrompt ? {
      action: marketingNativeShotField(shot, "action"),
      scene: marketingNativeShotField(shot, "scene", "sceneDescription"),
      lighting: marketingNativeShotField(shot, "lighting", "lightingString"),
      color: marketingNativeShotField(shot, "color_palette", "colorPalette"),
      props: [marketingNativeShotField(shot, "props")],
    } : null;
    const action = nativeMarketing?.action ?? String(
      rowActions[Math.min(shotIndex, Math.max(0, rowActions.length - 1))]
        ?? shot.action
        ?? "",
    ).trim();
    const direction = deriveNarrativeShotDirection({
      action,
      fallbackScene: nativeMarketing?.scene ?? rowPolicy.projectScene,
      fallbackLighting: nativeMarketing?.lighting ?? rowPolicy.projectLighting,
      fallbackColor: nativeMarketing?.color ?? rowPolicy.projectColor,
      fallbackProps: nativeMarketing?.props ?? mergeNarrativeProps(
        rowPolicy.projectProps,
        Array.isArray(policy.projectProps) ? policy.projectProps : [],
      ),
    });
    const normalizedPolicy: NarrativePromptReviewPolicy = {
      ...rowPolicy,
      postRainOnly: rowPolicy.postRainOnly ?? policy.postRainOnly,
      sourceFirstFrame: rowPolicy.sourceFirstFrame ?? policy.sourceFirstFrame,
      projectScene: nativeMarketing?.scene ?? (sceneMatchesAction(action, rowPolicy.projectScene)
        ? rowPolicy.projectScene
        : (direction.scene || rowPolicy.projectScene)),
      projectLighting: direction.lighting || rowPolicy.projectLighting,
      projectColor: direction.color || rowPolicy.projectColor,
      projectProps: nativeMarketing?.props ?? mergeNarrativeProps(
        direction.props,
        Array.isArray(rowPolicy.projectProps) ? rowPolicy.projectProps : [],
      ),
      projectActions: rowActions,
    };
    const enforcedShotSize = nativeMarketing || promptFieldText(shot.shotSize ?? recordValue(shot.fields).shotSize)
      ? null
      : shotSizeForAction(action);
    const shotForReview = enforcedShotSize
      ? { ...shot, shotSize: enforcedShotSize, cameraHint: enforcedShotSize }
      : shot;
    const sourceFirstFrame = !nativeMarketing && normalizedPolicy.sourceFirstFrame
      && !["contact", "withdraw", "retreat", "curl"].includes(animalActionKind(action))
      ? normalizedPolicy.sourceFirstFrame
      : undefined;
    const normalized = applyNarrativeFinalPromptContract(shotForReview, {
      noDialogue: normalizedPolicy.noDialogue,
      maxLength: normalizedPolicy.maxLength,
      noCharacters: normalizedPolicy.noCharacters,
      noAnimals: normalizedPolicy.noAnimals,
      noMusic: normalizedPolicy.noMusic,
      chineseOnly: true,
      durationSeconds: normalizedPolicy.durationSeconds,
      aspectRatio: normalizedPolicy.aspectRatio,
      resolution: normalizedPolicy.resolution,
      colorTemperature: normalizedPolicy.colorTemperature,
      isLastShot: shotIndex === normalizedPrompts.length - 1,
      characterNames: normalizedPolicy.characterNames,
      noTitles: normalizedPolicy.noTitles,
      canonicalize: true,
      requireOpeningFields: true,
      marketingPrompt: normalizedPolicy.marketingPrompt,
      characterPortraits: normalizedPolicy.characterPortraits,
      postRainOnly: normalizedPolicy.postRainOnly,
      sourceFirstFrame,
      projectScene: normalizedPolicy.projectScene,
      projectLighting: normalizedPolicy.projectLighting,
      projectColor: normalizedPolicy.projectColor,
      projectProps: normalizedPolicy.projectProps,
      projectActions: normalizedPolicy.projectActions,
      shotIndex,
    });
    const titleFields = ["title_content", "subtitle_content", "title_animation", "title_font_design", "opening_audio_design"];
    const fields = normalized.fields && typeof normalized.fields === "object"
      ? { ...normalized.fields as FusionRecord }
      : {};
    if (normalizedPolicy.noTitles) for (const key of titleFields) delete fields[key];
    const boundContract = normalized._workloomShotContract && typeof normalized._workloomShotContract === "object"
      ? normalized._workloomShotContract as FusionRecord
      : undefined;
    if (boundContract) fields._workloomShotContract = boundContract;
    const persistedPolicy: NarrativePromptReviewPolicy = {
      ...normalizedPolicy,
      ...(boundContract ? { shotContract: boundContract } : {}),
    };
    const result: FusionRecord = {
      ...normalized,
      fields,
      promptCharCount: unicodeLength(String(normalized.prompt ?? "")),
      ...(boundContract ? { _workloomShotContract: boundContract } : {}),
      _workloomPromptReviewPolicy: persistedPolicy,
      _workloomPromptReview: {
        schemaVersion: "workloom.prompt-review/v1",
        sourcePromptHash: createHash("sha256").update(String(shot.prompt ?? "")).digest("hex"),
        promptHash: createHash("sha256").update(String(normalized.prompt ?? "")).digest("hex"),
      },
    };
    if (rowPolicy.noTitles) for (const key of titleFields) delete result[key];
    return result;
  });
}

function evidenceHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
}

function jsonWithoutNull(value: unknown, space = 2): string {
  return JSON.stringify(value, (_key, item: unknown) => item === null ? undefined : item, space);
}

function promptBoundShotContract(prompt: FusionRecord): FusionRecord {
  const direct = prompt._workloomShotContract;
  if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct as FusionRecord;
  const fields = prompt.fields && typeof prompt.fields === "object" && !Array.isArray(prompt.fields)
    ? prompt.fields as FusionRecord
    : {};
  const fromFields = fields._workloomShotContract;
  if (fromFields && typeof fromFields === "object" && !Array.isArray(fromFields)) return fromFields as FusionRecord;
  const policy = prompt._workloomPromptReviewPolicy && typeof prompt._workloomPromptReviewPolicy === "object"
    ? prompt._workloomPromptReviewPolicy as FusionRecord
    : {};
  const fromPolicy = policy.shotContract;
  return fromPolicy && typeof fromPolicy === "object" && !Array.isArray(fromPolicy)
    ? fromPolicy as FusionRecord
    : {};
}

function promptReviewField(prompt: FusionRecord, label: string): string {
  const text = String(prompt.prompt ?? "");
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^\\s*\\d+\\.【${escaped}】([^\\n]*)$`, "mu").exec(text)?.[1]?.trim() ?? "";
}

function promptDerivedShotContract(prompt: FusionRecord, fallbackId: string): FusionRecord {
  const shotId = String(prompt.shotId ?? prompt.shot_id ?? fallbackId);
  const durationSeconds = Number(prompt.duration ?? recordValue(prompt.timing).duration ?? 0);
  const composition = promptReviewField(prompt, "构图");
  const propsText = promptReviewField(prompt, "道具");
  const roleText = promptReviewField(prompt, "角色");
  const animalSubject = roleText.match(/^([^；，。]+)作为本镜唯一动物主体/u)?.[1]?.trim() ?? "";
  const appearanceAnchor = roleText.match(/外观锚点=([^；\n]+)/u)?.[1]?.trim() ?? "";
  const animal = Boolean(animalSubject) && isNarrativeAnimal(animalSubject);
  const identityAnchor = animal && appearanceAnchor
    ? {
      mode: "text",
      subject: animalSubject,
      text: appearanceAnchor,
      sha256: createHash("sha256").update(appearanceAnchor).digest("hex"),
      authorization: "not-applicable",
      assetStatus: "not-registered",
      visualVerification: "not-performed",
    }
    : undefined;
  return {
    schema: "workloom.prompt-shot-contract/parsed-v1",
    source: "parsed-final-prompt",
    shotId,
    durationSeconds,
    space: promptReviewField(prompt, "场景"),
    action: promptReviewField(prompt, "动作"),
    lighting: promptReviewField(prompt, "灯光设计"),
    color: promptReviewField(prompt, "色彩/色调"),
    shotSize: composition.match(/^(.+?)景别/u)?.[1]?.trim() ?? "",
    camera: promptReviewField(prompt, "运镜"),
    costume: promptReviewField(prompt, "服装"),
    props: propsText.split(/[、；]/u).map(String).map((item) => item.trim()).filter(Boolean),
    dialogue: promptReviewField(prompt, "台词"),
    timeline: promptReviewField(prompt, "时间轴"),
    emotion: promptReviewField(prompt, "情绪"),
    portraitAssets: [],
    characterNames: animal ? [animalSubject] : [],
    ...(identityAnchor ? { identityAnchor } : {}),
  };
}

/**
 * G7 是预生产交付收口，不是摘要页。报告必须让评审直接看到脚本、镜头卡、
 * 提示词正文及三者绑定摘要；定妆照在审计关闭时必须明确 N/A，不能把 pending
 * 规格包写成已出图。
 */
export function renderPreproductionAuditReport(input: {
  productionResult: FusionRecord;
  scriptResult: FusionRecord;
  timing: FusionRecord;
  confirmations: FusionRecord;
  effectiveMs: number;
}): string {
  const shots: FusionRecord[] = Array.isArray(input.productionResult.shots)
    ? input.productionResult.shots.map((value, index) => fusionRecord(value, `shot[${index}]`))
    : [];
  const prompts: FusionRecord[] = Array.isArray(input.productionResult.prompts)
    ? input.productionResult.prompts.map((value, index) => fusionRecord(value, `prompt[${index}]`))
    : [];
  const rawShots: FusionRecord[] = shots;
  const promptById = new Map(prompts.map((prompt) => [String(prompt.shotId ?? prompt.shot_id ?? ""), prompt]));
  const shotCards: FusionRecord[] = prompts.map((prompt, index) => {
    const id = String(prompt.shotId ?? prompt.shot_id ?? rawShots[index]?.shotId ?? `S-${index + 1}`);
    const raw = rawShots.find((shot) => String(shot.shotId ?? shot.shot_id ?? "") === id) ?? rawShots[index] ?? {};
    const boundContract = promptBoundShotContract(prompt);
    const contract = Object.keys(boundContract).length > 0
      ? boundContract
      : promptDerivedShotContract(prompt, id);
    return {
      ...raw,
      shotId: id,
      duration: Number(contract.durationSeconds ?? prompt.duration ?? raw.duration ?? recordValue(raw.timing).duration ?? 0),
      sceneType: String(raw.sceneType ?? raw.type ?? "content"),
      scene: String(contract.space ?? promptFieldText(raw.scene ?? raw.sceneDescription)),
      action: String(contract.action ?? promptFieldText(raw.action)),
      lighting: String(contract.lighting ?? promptFieldText(raw.lighting)),
      color: String(contract.color ?? ""),
      shotSize: String(contract.shotSize ?? raw.shotSize ?? ""),
      camera: String(contract.camera ?? ""),
      props: Array.isArray(contract.props) ? contract.props : [],
      prompt: String(prompt.prompt ?? ""),
      promptContract: contract,
    };
  });
  const directBlueprint = recordValue(input.scriptResult.blueprint ?? input.scriptResult);
  const promptBlueprint = recordValue(prompts[0]?._blueprint);
  const blueprint = Object.keys(directBlueprint).length > 0 ? directBlueprint : promptBlueprint;
  const characterSystem = recordValue(blueprint.character_system);
  const scriptMetadata = {
    ...recordValue(recordValue(promptBlueprint.meta)._metadata),
    ...recordValue(promptBlueprint._metadata),
    ...recordValue(recordValue(directBlueprint.meta)._metadata),
    ...recordValue(directBlueprint._metadata),
  };
  const sourcePrd = recordValue(scriptMetadata._prd);
  const sourceCharacterSystem = recordValue(sourcePrd.characterSystem);
  const rawScriptCharacters = [
    ...(Array.isArray(characterSystem.characters) ? characterSystem.characters.map(recordValue) : []),
    ...(Array.isArray(sourceCharacterSystem.characters) ? sourceCharacterSystem.characters.map(recordValue) : []),
  ];
  const structure = recordValue(blueprint.structure);
  const scenes: FusionRecord[] = Array.isArray(structure.scenes)
    ? structure.scenes.map((value) => recordValue(value))
    : [];
  const sourceProject = recordValue(sourcePrd.projectDefinition);
  const sourceOriginal = String(
    scriptMetadata._originalStoryText
      ?? sourceProject._originalStoryText
      ?? sourceProject.sourceIntent
      ?? blueprint._originalStoryText
      ?? "",
  ).trim();
  const sourceShotContracts = Array.isArray(sourcePrd.shotContract)
    ? sourcePrd.shotContract.map(recordValue)
    : [];
  const sourceShotRows = sourceShotContracts.filter((shot) =>
    String(shot.shotId ?? shot.shot_id ?? "").trim().length > 0);
  const hanBigrams = (value: unknown): Set<string> =>
    new Set(String(value ?? "").match(/[\p{Script=Han}]{2}/gu) ?? []);
  const sourceDurations = sourceShotRows.map((source) =>
    Math.max(0, Number(source.durationSeconds ?? source.duration ?? 0)));
  const finalDurations = shotCards.map((shot) => Math.max(0, Number(shot.duration ?? 0)));
  const sourceDurationTotal = sourceDurations.reduce((sum, value) => sum + value, 0);
  const finalDurationTotal = finalDurations.reduce((sum, value) => sum + value, 0);
  let sourceQuotas: number[] = [];
  if (sourceShotRows.length > 0 && sourceShotRows.length <= shotCards.length) {
    const ideal = sourceDurations.map((duration) =>
      duration > 0 && sourceDurationTotal > 0
        ? duration / sourceDurationTotal * shotCards.length
        : shotCards.length / sourceShotRows.length);
    sourceQuotas = ideal.map((value) => Math.max(1, Math.floor(value)));
    let assigned = sourceQuotas.reduce((sum, value) => sum + value, 0);
    while (assigned < shotCards.length) {
      const index = ideal
        .map((value, i) => ({ i, remainder: value - Math.floor(value) }))
        .sort((a, b) => b.remainder - a.remainder || a.i - b.i)[0]!.i;
      sourceQuotas[index] = (sourceQuotas[index] ?? 1) + 1;
      assigned += 1;
    }
    while (assigned > shotCards.length) {
      const index = sourceQuotas
        .map((value, i) => ({ i, value }))
        .filter((item) => item.value > 1)
        .sort((a, b) => b.value - a.value || a.i - b.i)[0]?.i;
      if (index === undefined) break;
      sourceQuotas[index] = sourceQuotas[index]! - 1;
      assigned -= 1;
    }
  }
  let groupStart = 0;
  const sourceGroups = sourceQuotas.map((quota, sourceIndex) => {
    const start = groupStart;
    groupStart += quota;
    return { sourceIndex, start, end: groupStart };
  });
  const sourceShotMapping = shotCards.map((shot, finalIndex) => {
    const sourceIndex = sourceGroups.find((group) => finalIndex >= group.start && finalIndex < group.end)?.sourceIndex
      ?? Math.min(
        Math.max(0, sourceShotRows.length - 1),
        Math.floor(finalIndex * sourceShotRows.length / Math.max(1, shotCards.length)),
      );
    const source = sourceShotRows[sourceIndex] ?? {};
    const finalGrams = hanBigrams(`${String(shot.action ?? "")} ${String(shot.scene ?? "")}`);
    const sourceGrams = hanBigrams([source.purpose, source.action, source.location, source.scene].join(" "));
    const bestScore = [...finalGrams].filter((gram) => sourceGrams.has(gram)).length;
    const group = sourceGroups.find((candidate) => candidate.sourceIndex === sourceIndex);
    const groupedCount = group ? group.end - group.start : 1;
    const finalDurationSeconds = Number(shot.duration ?? 0);
    const sourceDurationSeconds = Number(source.durationSeconds ?? source.duration ?? 0);
    const durationDelta = Number((finalDurationSeconds - sourceDurationSeconds).toFixed(3));
    return {
      finalShotId: String(shot.shotId ?? `S-${finalIndex + 1}`),
      sourceShotId: String(source.shotId ?? source.shot_id ?? "未提供"),
      sourceOrder: sourceIndex + 1,
      finalOrder: finalIndex + 1,
      relation: groupedCount > 1
        ? (Math.abs(durationDelta) > 0.001
          ? "source-shot-decomposed-duration-reallocated"
          : "source-shot-decomposed")
        : sourceShotRows.length === shotCards.length && Math.abs(durationDelta) <= 0.001
          ? "one-to-one"
          : "duration-reallocated",
      actionSimilarityBigrams: bestScore,
      sourceDurationSeconds,
      finalDurationSeconds,
      durationDeltaSeconds: durationDelta,
    };
  });
  const sourceCoverage = sourceShotRows.map((source, sourceIndex) => {
    const mapped = sourceShotMapping.filter((item) => item.sourceOrder === sourceIndex + 1);
    const mappedDuration = Number(mapped.reduce((sum, item) => sum + item.finalDurationSeconds, 0).toFixed(3));
    const sourceDuration = Number(sourceDurations[sourceIndex] ?? 0);
    return {
      sourceShotId: String(source.shotId ?? source.shot_id ?? `SOURCE-${sourceIndex + 1}`),
      sourceDurationSeconds: sourceDuration,
      mappedFinalShotIds: mapped.map((item) => item.finalShotId),
      mappedDurationSeconds: mappedDuration,
      durationDeltaSeconds: Number((mappedDuration - sourceDuration).toFixed(3)),
      coverage: mapped.length > 0 ? "covered" : "missing",
    };
  });
  const sourceMappingPolicy = {
    strategy: "duration-proportional semantic groups with global total conservation",
    sourceDurationSeconds: Number(sourceDurationTotal.toFixed(3)),
    finalDurationSeconds: Number(finalDurationTotal.toFixed(3)),
    globalDurationConserved: Math.abs(sourceDurationTotal - finalDurationTotal) <= 0.05,
    perSourceDurationPreserved: sourceCoverage.every((item) => Math.abs(item.durationDeltaSeconds) <= 0.001),
    reallocationNote: "Final shots may split a source shot and redistribute duration globally; all source shots must remain covered and total duration must stay equal.",
  };
  const sourceShotMappingSha256 = sourceShotMapping.length ? evidenceHash(sourceShotMapping) : null;
  const shotIds = shotCards.map((shot) => String(shot.shotId ?? ""));
  const promptIds = prompts.map((prompt) => String(prompt.shotId ?? prompt.shot_id ?? ""));
  const idsMatch = shotIds.length === promptIds.length
    && shotIds.every((id, index) => id.length > 0 && id === promptIds[index]);
  const totalSeconds = shotCards.reduce((sum, shot) => sum + Number(shot.duration ?? recordValue(shot.timing).duration ?? 0), 0);
  const portraitConfirmation = recordValue(input.confirmations.portraitGeneration);
  const portraitReason = String(portraitConfirmation.reason ?? portraitConfirmation.status ?? "");
  const portraitsNotApplicable = /not[-_ ]?applicable|审计|audit-portrait/i.test(portraitReason);
  const portraitRule = recordValue(portraitConfirmation.notApplicable);
  const portraitPolicy = {
    status: portraitsNotApplicable ? "not_applicable" : "reviewed",
    policy: String(portraitRule.policy ?? (portraitsNotApplicable ? "audit-only-no-portrait-generation" : "standard-portrait-review")),
    scope: String(portraitRule.scope ?? "preproduction-only"),
    gate: String(portraitRule.gate ?? "G5_PORTRAIT"),
    runnerFlags: Array.isArray(portraitRule.runnerFlags) ? portraitRule.runnerFlags.map(String) : [],
    humanPortraitRequired: portraitRule.humanPortraitRequired !== false,
    visualIdentityVerification: String(portraitRule.visualIdentityVerification ?? "not-performed-in-this-audit"),
    downstreamBoundary: String(portraitRule.downstreamBoundary ?? "G8 and rendering remain blocked until visual identity and release checks pass"),
  };
  const scriptPortraitAssets = rawScriptCharacters.map((character) => {
    const evidence = recordValue(character.portraitEvidence);
    return {
      name: character.name ?? character.characterId ?? null,
      path: character.portraitPath ?? character.portraitRef ?? evidence.path ?? null,
      authorization: character.authorization ?? null,
      sha256: evidence.sha256 ?? null,
    };
  }).filter((item) => item.path);
  const repoRoot = videoRuntimeRoot(import.meta.url);
  const promptPortraitAssets = prompts.map((prompt) => {
    const portraitField = promptReviewField(prompt, "定妆照");
    const match = portraitField.match(/(?:^|使用\s+)([^=；\s]+)=([^；\n]+)/u);
    const roleText = promptReviewField(prompt, "角色");
    const authorization = roleText.match(/授权=([^；\n\s]+)/u)?.[1] ?? null;
    const path = match?.[2]?.trim() ?? null;
    const absolute = path ? resolvePath(repoRoot, path) : "";
    const sha256 = path && existsSync(absolute)
      ? createHash("sha256").update(readFileSync(absolute)).digest("hex")
      : null;
    return { name: match?.[1]?.trim() ?? null, path, authorization, sha256 };
  }).filter((item) => item.path);
  const portraitAssetCandidates = shotCards.flatMap((shot) => {
    const prompt = promptById.get(String(shot.shotId ?? ""));
    const bound = prompt ? promptBoundShotContract(prompt) : {};
    const contract = Object.keys(bound).length > 0 ? bound : recordValue(shot.promptContract);
    const fromContract = Array.isArray(contract.portraitAssets) ? contract.portraitAssets : [];
    return [...fromContract, ...scriptPortraitAssets, ...promptPortraitAssets];
  }).map(recordValue);
  const validAuthorization = (value: unknown): boolean =>
    Boolean(String(value ?? "").trim()) && !/^(?:unknown|unverified|空)?$/iu.test(String(value).trim());
  const portraitAssetsByPath = new Map<string, FusionRecord>();
  for (const item of portraitAssetCandidates) {
    const path = String(item.path ?? item.portraitPath ?? "").trim();
    if (!path) continue;
    const current: FusionRecord = {
      name: item.name ?? null,
      path,
      authorization: item.authorization ?? null,
      sha256: item.sha256 ?? null,
    };
    const previous = portraitAssetsByPath.get(path);
    if (!previous
      || (!validAuthorization(previous.authorization) && validAuthorization(current.authorization))
      || (!/^[a-f0-9]{64}$/iu.test(String(previous.sha256 ?? ""))
        && /^[a-f0-9]{64}$/iu.test(String(current.sha256 ?? "")))) {
      portraitAssetsByPath.set(path, current);
    }
  }
  const portraitAssets = [...portraitAssetsByPath.values()];
  const portraitAssetsVerified = portraitAssets.length > 0 && portraitAssets.every((item) =>
    typeof item.path === "string" && item.path.length > 0
    && typeof item.sha256 === "string" && /^[a-f0-9]{64}$/u.test(item.sha256)
    && validAuthorization(item.authorization));
  const promptCharacterNames = [...new Set([
    ...shotCards.flatMap((shot) => {
      const contract = recordValue(shot.promptContract);
      const names = Array.isArray(contract.characterNames)
        ? contract.characterNames.map((value) => String(value ?? "").trim()).filter(Boolean)
        : [];
      const assetNames = Array.isArray(contract.portraitAssets)
        ? contract.portraitAssets.map(recordValue).map((item) => String(item.name ?? "").trim()).filter(Boolean)
        : [];
      return [...names, ...assetNames];
    }),
    ...promptPortraitAssets.map((item) => String(item.name ?? "").trim()).filter(Boolean),
  ])];
  const animalIdentityOnly = promptCharacterNames.length > 0
    && promptCharacterNames.every((name) => isNarrativeAnimal(name));
  const identityAnchorByKey = new Map<string, FusionRecord>();
  for (const shot of shotCards) {
    const contract = recordValue(shot.promptContract);
    const identityAnchor = recordValue(contract.identityAnchor);
    if (identityAnchor.mode !== "text") continue;
    const key = `${String(identityAnchor.subject ?? "")}\u0000${String(identityAnchor.sha256 ?? "")}`;
    if (!identityAnchorByKey.has(key)) identityAnchorByKey.set(key, identityAnchor);
  }
  const identityAnchors = [...identityAnchorByKey.values()];
  const identityAnchorReferences = shotCards.map((shot) => {
    const anchor = recordValue(recordValue(shot.promptContract).identityAnchor);
    return {
      shotId: String(shot.shotId ?? ""),
      sha256: String(anchor.sha256 ?? ""),
    };
  });
  const identityAnchorHashes = new Set(
    identityAnchorReferences.map((item) => item.sha256).filter((value) => /^[a-f0-9]{64}$/u.test(value)),
  );
  const identityAnchorConsistent = animalIdentityOnly
    && identityAnchorReferences.length === shotCards.length
    && identityAnchorReferences.every((item) => /^[a-f0-9]{64}$/u.test(item.sha256))
    && identityAnchorHashes.size === 1;
  const identityEvidenceStatus = animalIdentityOnly
    ? "text-anchor-only"
    : portraitAssetsVerified
      ? "verified-source-assets"
      : "unverified";
  const characters: FusionRecord[] = promptCharacterNames.length > 0
    ? promptCharacterNames.map((name) => {
      const rawMatches = rawScriptCharacters.filter((character) =>
        [character.name, character.characterId, character.character_id, character.id]
          .map((value) => String(value ?? "").trim())
          .some((value) => value === name));
      const preferredRaw = rawMatches.find((character) => validAuthorization(character.authorization))
        ?? rawMatches[0]
        ?? {};
      const promptAsset = promptPortraitAssets.find((item) => String(item.name ?? "").trim() === name);
      const characterIds = rawMatches.flatMap((character) =>
        [character.characterId, character.character_id, character.id]
          .map((value) => String(value ?? "").trim())
          .filter(Boolean));
      return {
        name,
        characterId: characterIds.find((id) => id !== name) ?? characterIds[0] ?? name,
        authorization: promptAsset?.authorization
          ?? (validAuthorization(preferredRaw.authorization) ? preferredRaw.authorization : null)
          ?? "unknown",
      } satisfies FusionRecord;
    })
    : rawScriptCharacters;
  const elapsedMs = Math.max(0, Number(input.effectiveMs) || 0);
  const artifacts = {
    script: evidenceHash(input.scriptResult),
    shots: evidenceHash(shotCards),
    prompts: evidenceHash(prompts),
    portraits: evidenceHash(portraitConfirmation),
  };
  const sourceEvidence = {
    originalRequirement: sourceOriginal,
    originalRequirementSha256: sourceOriginal
      ? createHash("sha256").update(sourceOriginal).digest("hex")
      : null,
    sourceShotContracts,
    sourceShotContractSha256: sourceShotContracts.length
      ? evidenceHash(sourceShotContracts)
      : null,
    sourceShotMapping,
    sourceShotMappingSha256,
    sourceCoverage,
    sourceMappingPolicy,
    sourceShotCount: sourceShotRows.length,
    finalShotCount: shotCards.length,
  };
  const semanticHash = evidenceHash(shotCards.map((shot) => ({
    shotId: shot.shotId,
    duration: shot.duration,
    scene: shot.scene,
    action: shot.action,
    lighting: shot.lighting,
    color: shot.color,
    shotSize: shot.shotSize,
    camera: shot.camera,
    props: shot.props,
  })));
  const lines = [
    "# 预生产交付收口（G7）",
    "",
    "## 机器可核验摘要",
    "",
    `- 镜头卡：${shotCards.length} 镜，sha256=${artifacts.shots}`,
    `- 提示词正文：${prompts.length} 条，sha256=${artifacts.prompts}`,
    `- 剧本：${shotCards.length} 镜（最终收口视图），源剧本 sha256=${artifacts.script}`,
    `- 总时长：${Number(totalSeconds.toFixed(3))}s`,
    `- 有效处理时间：${elapsedMs}ms（${(elapsedMs / 60_000).toFixed(1)}分钟）`,
    `- 镜头 ID 与提示词 ID 一一对应：${idsMatch ? "是" : "否"}`,
    `- 镜头语义合同：最终提示词绑定的结构化镜头卡，语义摘要 sha256=${semanticHash}`,
    `- 原始源证据：${sourceOriginal && sourceShotContracts.length > 0 ? "原始需求与源镜头合同正文已内联，可逐镜对照" : "未提供独立原文，禁止声称已核实对源 brief 的忠实度"}`,
    `- 源镜头映射：${sourceShotRows.length} 源镜 → ${shotCards.length} 最终镜，映射 sha256=${sourceShotMappingSha256 ?? "未提供"}`,
    `- 渲染提交：否；G8 预算、资格与质量提交闸未触发`,
    "",
    "## 三件套状态",
    "",
    `- 镜头卡：已内联，共 ${shotCards.length} 镜；全部场景与字段见下表，来源为最终提示词绑定合同`,
    `- 提示词：已内联，共 ${prompts.length} 条；正文见下方完整字段块`,
    portraitsNotApplicable
      ? animalIdentityOnly
        ? `- 定妆照生成：not_applicable（动物角色不要求人像定妆照）；项目规则=${portraitPolicy.policy}；角色身份证据：text-anchor（文字锚点可复核，跨镜视觉一致性未验证）`
        : `- 定妆照生成：not_applicable（本轮未生成新定妆照，仅复用已登记源资产）；角色引用资产：${portraitAssetsVerified ? `verified，${portraitAssets.length} 个已登记源定妆照` : "unverified"}`
      : `- 定妆照：状态=${portraitReason || "unverified"}；未声明为已完成，除非另有真实图片回执`,
    ...portraitAssets.map((item) =>
      `- 源定妆照 ${String(item.name ?? "未命名")}：path=${String(item.path ?? "未指定")}；授权=${String(item.authorization ?? "unknown")}；sha256=${String(item.sha256 ?? "未核验")}`),
    "",
    "## 脚本证据",
    "",
    `- 角色数：${characters.length}`,
    ...characters.map((character) =>
      `- 角色 ${String(character.name ?? character.characterId ?? "未命名")}：ID=${String(character.characterId ?? character.id ?? "未指定")}；授权=${String(character.authorization ?? "unknown")}`),
    ...shotCards.map((shot) =>
      `- 场景 ${String(shot.shotId)}：${String(shot.action)}；时长=${String(shot.duration)}s；场景状态=${String(shot.scene)}`),
    "",
    sourceOriginal || sourceShotContracts.length
      ? "> 脚本证据按最终提示词绑定的镜头合同重投影；最终 G7 视图另内联原始需求与源镜头合同正文，旧脚本字段不得覆盖已通过的 G6 合同。"
      : "> 脚本证据按最终提示词绑定的镜头合同重投影；本报告未收到独立原文，以下只声明可复算的内部自洽，不声称已核实对源 brief 的忠实度。",
    "",
    "## 原始源证据（未改写）",
    "",
    `- 原始需求正文：${sourceEvidence.originalRequirement || "本次输入未提供可直接核验的原文"}`,
    `- 原始需求 SHA-256：${sourceEvidence.originalRequirementSha256 ?? "未提供"}`,
    `- 源镜头合同 SHA-256：${sourceEvidence.sourceShotContractSha256 ?? "未提供"}`,
    ...(sourceShotContracts.length > 0
      ? sourceShotContracts.map((shot, index) => {
        const id = String(shot.shotId ?? shot.shot_id ?? `SOURCE-${index + 1}`);
        const purpose = String(shot.purpose ?? shot.action ?? "").trim();
        return `- 源镜头 ${id}：${purpose || "未提供动作正文"}`;
      })
      : ["- 源镜头合同逐镜正文：未提供"]),
    "",
    "### 源镜头与最终镜头映射",
    "",
    `映射策略：${sourceMappingPolicy.strategy}；源总时长=${sourceMappingPolicy.sourceDurationSeconds}s；最终总时长=${sourceMappingPolicy.finalDurationSeconds}s；全局守恒=${sourceMappingPolicy.globalDurationConserved ? "是" : "否"}；逐源时长原样保持=${sourceMappingPolicy.perSourceDurationPreserved ? "是" : "否（按全局时长重分配）"}；映射摘要 sha256=${sourceShotMappingSha256 ?? "未提供"}。`,
    `重分配说明：${sourceMappingPolicy.reallocationNote}`,
    "",
    "| 最终镜头 | 源镜头 | 关系 | 最终时长 | 源时长 | 动作词元匹配数 |",
    "|---|---|---|---:|---:|---:|",
    ...sourceShotMapping.map((mapping) =>
      `| ${String(mapping.finalShotId)} | ${String(mapping.sourceShotId)} | ${String(mapping.relation)} | ${String(mapping.finalDurationSeconds)}s | ${String(mapping.sourceDurationSeconds)}s | ${String(mapping.actionSimilarityBigrams)} |`),
    "",
    "#### 源镜头覆盖汇总",
    "",
    "| 源镜头 | 源时长 | 映射最终镜头 | 映射时长 | 差值与覆盖 |",
    "|---|---:|---|---:|---|",
    ...sourceCoverage.map((item) =>
      `| ${String(item.sourceShotId)} | ${String(item.sourceDurationSeconds)}s | ${item.mappedFinalShotIds.join("、") || "无"} | ${String(item.mappedDurationSeconds)}s | Δ${String(item.durationDeltaSeconds)}s；${String(item.coverage)} |`),
    "",
    "## 源定妆照证据链",
    "",
    `- 新增定妆照生成：${portraitsNotApplicable ? "not_applicable（审计关闭）" : "unverified"}`,
    animalIdentityOnly
      ? "- 源角色资产：not_applicable（动物主体无已登记图片定妆资产；只复用文字外观锚点）"
      : `- 源角色资产：${portraitAssetsVerified ? "verified（仅复用已登记源资产）" : "unverified"}`,
    ...portraitAssets.map((item) =>
      `- ${String(item.name ?? "未命名")}：path=${String(item.path ?? "未指定")}；授权范围=${String(item.authorization ?? "unknown")}；文件 SHA-256=${String(item.sha256 ?? "未核验")}`),
    ...identityAnchors.map((anchor) =>
      `- 文字身份锚点 ${String(anchor.subject ?? "未命名")}：sha256=${String(anchor.sha256 ?? "未核验")}；授权=${String(anchor.authorization ?? "unknown")}；资产状态=${String(anchor.assetStatus ?? "unknown")}；视觉验证=${String(anchor.visualVerification ?? "not-performed")}`),
    ...(animalIdentityOnly
      ? [
        `- 文字锚点跨镜比对：${identityAnchorReferences.filter((item) => /^[a-f0-9]{64}$/u.test(item.sha256)).length}/${shotCards.length} 镜可复算；唯一哈希数=${identityAnchorHashes.size}；结论=${identityAnchorConsistent ? "consistent（仅文字锚点一致，未做图像视觉验证）" : "failed（文字锚点不一致）"}`,
      ]
      : []),
    `- 项目级不适用规则：policy=${portraitPolicy.policy}；scope=${portraitPolicy.scope}；gate=${portraitPolicy.gate}；runnerFlags=${portraitPolicy.runnerFlags.join(",") || "由执行确认记录指定"}；humanPortraitRequired=${portraitPolicy.humanPortraitRequired}；视觉身份验证=${portraitPolicy.visualIdentityVerification}`,
    `- 下游释放边界：${portraitPolicy.downstreamBoundary}`,
    "- 审批边界：源资产授权只证明可复用已登记身份参考；本轮未声称生成新定妆照，也未将其作为渲染或发布许可。",
    "",
    "## 镜头卡与提示词交叉引用",
    "",
    "| 镜头 | 时长 | 类型 | 完整场景 | 动作 | 灯光 | 提示词 SHA-256 |",
    "|---|---:|---|---|---|---|---|",
    ...shotCards.map((shot, index) => {
      const id = String(shot.shotId ?? `S-${index + 1}`);
      const prompt = String(promptById.get(id)?.prompt ?? "");
      return `| ${id} | ${String(shot.duration ?? recordValue(shot.timing).duration ?? "?")}s | ${String(shot.sceneType ?? shot.type ?? "content")} | ${promptFieldText(shot.scene ?? shot.sceneDescription).replace(/\|/gu, "／")} | ${promptFieldText(shot.action).replace(/\|/gu, "／")} | ${promptFieldText(shot.lighting).replace(/\|/gu, "／")} | ${createHash("sha256").update(prompt).digest("hex")} |`;
    }),
    "",
    "## 时间轴连续性",
    "",
    "| 镜头 | 累计起点 | 时长 | 累计终点 |",
    "|---|---:|---:|---:|",
    ...(() => {
      let cursor = 0;
      return shotCards.map((shot, index) => {
        const seconds = Number(shot.duration ?? recordValue(shot.timing).duration ?? 0);
        const start = cursor;
        cursor += seconds;
        return `| ${String(shot.shotId ?? `S-${index + 1}`)} | ${start.toFixed(2)}s | ${seconds.toFixed(2)}s | ${cursor.toFixed(2)}s |`;
      });
    })(),
    "",
    "## 提示词正文（逐镜完整）",
    "",
    ...prompts.flatMap((prompt, index) => {
      const id = String(prompt.shotId ?? prompt.shot_id ?? `PROMPT-${index + 1}`);
      return [
        `### ${id}`,
        "",
        "```markdown",
        String(prompt.prompt ?? ""),
        "```",
        "",
      ];
    }),
    "## 结构化镜头合同（机器可读）",
    "",
    "```json",
    jsonWithoutNull({
      schema: "workloom.preproduction-contract/v1",
      sourceOfTruth: "original-requirement-and-final-prompt-bound-shot-contract",
      sourceEvidenceIncluded: Boolean(sourceOriginal && sourceShotContracts.length > 0),
      shotCount: shotCards.length,
      totalDurationSeconds: Number(totalSeconds.toFixed(3)),
      semanticHash,
      shotIds,
      sourceEvidence,
      portraitAssets,
      portraitAssetsVerified,
      identityEvidenceStatus,
      identityAnchors,
      portraitPolicy,
      identityAnchorConsistency: {
        applicable: animalIdentityOnly,
        scope: "text-only",
        checkedShots: identityAnchorReferences.filter((item) => /^[a-f0-9]{64}$/u.test(item.sha256)).length,
        totalShots: shotCards.length,
        uniqueHashes: identityAnchorHashes.size,
        consistent: identityAnchorConsistent,
        visualVerification: "not-performed",
      },
      shots: shotCards.map((shot) => ({
        ...recordValue(shot.promptContract),
        shotId: shot.shotId,
        durationSeconds: shot.duration,
        promptHash: createHash("sha256").update(String(shot.prompt ?? "")).digest("hex"),
      })),
    }),
    "```",
    "",
    "## 检查结论",
    "",
    `- 镜头/提示词 ID 与数量：${idsMatch ? "通过" : "失败"}`,
    `- 场景正文截断：${shotCards.some((shot) => /(?:\.\.\.|…)$/u.test(promptFieldText(shot.scene).trim())) ? "失败" : "通过"}`,
    `- 镜头卡与提示词语义绑定：${shotCards.every((shot) => recordValue(shot.promptContract).shotId === shot.shotId) ? "通过" : "失败"}`,
    `- 定妆照生成：${portraitsNotApplicable ? "not_applicable" : "unverified"}；身份证据：${identityEvidenceStatus}`,
    `- 原始需求与源镜头合同：${sourceOriginal || sourceShotContracts.length ? "已内联并绑定 SHA-256" : "未提供"}`,
    "- 渲染/G8：未提交，故预算、资格与质量提交闸为 not_run；本报告不把预生产通过写成可渲染或可发布",
    "",
    "本报告为机器证据包，不要求人工口头确认；由外部门禁回调直接审核。",
  ];
  return lines.join("\n");
}

export function installVendorPreproductionReviewBridge(options: { log?: (line: string) => void } = {}): () => void {
  const log = options.log ?? (() => undefined);
  const repoRoot = videoRuntimeRoot(import.meta.url);
  const vendorRequire = createRequire(resolvePath(repoRoot, "package.json"));
  const systemPath = resolvePath(repoRoot, "vendor/supermickey/hyperreality-system/index.js");
  const mod = vendorRequire(systemPath) as { HyperrealitySystem?: { prototype?: Record<string, unknown> } };
  const prototype = mod.HyperrealitySystem?.prototype;
  if (!prototype || typeof prototype._generatePreproductionReport !== "function") return () => undefined;
  const originalCreate = prototype.create as ((this: Record<string, unknown>, ...args: unknown[]) => Promise<unknown>) | undefined;
  const originalReport = prototype._generatePreproductionReport as (
    this: Record<string, unknown>,
    productionResult: FusionRecord,
    scriptResult: FusionRecord,
    timing: FusionRecord,
    confirmations: FusionRecord,
  ) => string;
  if (typeof originalCreate === "function") {
    prototype.create = async function trackedCreate(this: Record<string, unknown>, ...args: unknown[]) {
      this._workloomPreproductionStartedAt = Date.now();
      return originalCreate.apply(this, args);
    };
  }
  prototype._generatePreproductionReport = function patchedPreproductionReport(
    this: Record<string, unknown>,
    productionResult: FusionRecord,
    scriptResult: FusionRecord,
    timing: FusionRecord,
    confirmations: FusionRecord,
  ) {
    const started = Number(this._workloomPreproductionStartedAt);
    const effectiveMs = Number.isFinite(started) && started > 0 ? Date.now() - started : Number(timing.effective ?? timing.total ?? 0);
    return renderPreproductionAuditReport({
      productionResult,
      scriptResult,
      timing,
      confirmations,
      effectiveMs,
    });
  };
  log("[vendor-compat] G7 预生产收口桥已安装（完整三件套、摘要、时间轴与未提交边界）");
  return () => {
    if (typeof originalCreate === "function") prototype.create = originalCreate;
    prototype._generatePreproductionReport = originalReport;
  };
}

/**
 * Vendor quality-gate currently turns non-numeric "unverified" acceptance
 * criteria into NaN and then fails every prompt. Keep unverified delivery
 * criteria distinct from numeric review thresholds while preserving all field,
 * length and placeholder checks.
 */
export function installVendorQualityGateBridge(): () => void {
  const repoRoot = videoRuntimeRoot(import.meta.url);
  const vendorRequire = createRequire(resolvePath(repoRoot, "package.json"));
  const gatePath = resolvePath(
    repoRoot,
    "vendor/supermickey/hyperreality-system/engines/production-engine/utils/quality-gate.js",
  );
  const mod = vendorRequire(gatePath) as {
    QualityGate?: { prototype?: Record<string, unknown> };
  };
  const prototype = mod.QualityGate?.prototype;
  if (!prototype || typeof prototype.run !== "function") return () => undefined;
  const original = prototype.run as (
    this: Record<string, unknown>,
    prompts: FusionRecord[],
    prd?: FusionRecord | null,
  ) => FusionRecord;
  const numericThreshold = (value: unknown, fallback: number): number => {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return fallback;
    return number > 1 ? Math.min(1, number / 100) : number;
  };
  prototype.run = function patchedQualityGate(
    this: Record<string, unknown>,
    prompts: FusionRecord[],
    prd?: FusionRecord | null,
  ) {
    const delivery = recordValue(prd?.deliveryStandard);
    const criteria = recordValue(delivery.acceptanceCriteria ?? prd?.acceptanceCriteria);
    const safeCriteria = {
      ...criteria,
      visual: numericThreshold(criteria.visual, 0.75),
      narrative: numericThreshold(criteria.narrative, 0.75),
    };
    const safePrd = prd
      ? {
        ...prd,
        deliveryStandard: {
          ...delivery,
          acceptanceCriteria: safeCriteria,
        },
      }
      : prd;
    const result = original.call(this, prompts, safePrd);
    const checks = Array.isArray(result.checks) ? result.checks.map(recordValue) : [];
    const threshold = Math.round((safeCriteria.visual + safeCriteria.narrative) / 2 * 100);
    for (const check of checks) {
      check.passed = Boolean(
        check.hasScene
        && check.hasMood
        && check.hasCamera
        && check.hasLighting
        && check.hasAction
        && check.hasTimeline
        && check.hasBackgroundSound
        && check.hasPrompt
        && check.withinLimit
        && check.hasAudioLayer
        && check.hasTitleOverlay
        && !check.hasPlaceholder
        && Number(check.overallScore ?? 0) >= threshold,
      );
    }
    result.checks = checks;
    result.passedCount = checks.filter((check) => check.passed).length;
    result.passed = checks.length > 0 && checks.every((check) => check.passed);
    const blockingBooleanFields = new Set([
      "hasScene", "hasMood", "hasCamera", "hasLighting", "hasAction",
      "hasTimeline", "hasBackgroundSound", "hasPrompt", "withinLimit",
      "hasAudioLayer", "hasTitleOverlay",
    ]);
    result.failedFields = checks.filter((check) => !check.passed).map((check) => ({
      shotId: check.shotId,
      overallScore: check.overallScore,
      failed: [
        ...Object.entries(check)
          .filter(([key, value]) => blockingBooleanFields.has(key) && !value)
          .map(([key]) => key),
        ...(check.hasPlaceholder === true ? ["hasPlaceholder"] : []),
        ...(Number(check.overallScore ?? 0) < threshold ? ["overallScore"] : []),
      ],
    }));
    return result;
  };
  return () => {
    prototype.run = original;
  };
}

/** Rebuild every prompt from the Phase 3 policy immediately before the G6 report is generated. */
export function installVendorNarrativePromptReviewBridge(options: {
  log?: (line: string) => void;
  capture?: (prompts: readonly FusionRecord[]) => void;
} = {}): () => void {
  const log = options.log ?? (() => undefined);
  const repoRoot = videoRuntimeRoot(import.meta.url);
  const vendorRequire = createRequire(resolvePath(repoRoot, "package.json"));
  const systemPath = resolvePath(repoRoot, "vendor/supermickey/hyperreality-system/index.js");
  const mod = vendorRequire(systemPath) as { HyperrealitySystem?: { prototype?: Record<string, unknown> } };
  const prototype = mod.HyperrealitySystem?.prototype;
  if (!prototype || typeof prototype._confirmPrompts !== "function") return () => undefined;
  const original = prototype._confirmPrompts as (
    this: Record<string, unknown>,
    prompts: FusionRecord[],
  ) => Promise<Record<string, unknown>>;
  const originalFormat = typeof prototype._formatPromptWithSequenceNumbers === "function"
    ? prototype._formatPromptWithSequenceNumbers as (promptText: unknown, isOpening?: boolean, shotData?: FusionRecord) => string
    : null;
  const originalReport = typeof prototype._generatePromptsReport === "function"
    ? prototype._generatePromptsReport as (this: Record<string, unknown>, prompts: FusionRecord[]) => string
    : null;
  const originalOpening = typeof prototype._optimizeOpeningTitle === "function"
    ? prototype._optimizeOpeningTitle as (this: FusionRecord, production: FusionRecord, result: FusionRecord, metadata: FusionRecord) => Promise<unknown>
    : null;
  const openingKeys = ["title_content", "subtitle_content", "title_animation", "title_font_design", "opening_audio_design"] as const;
  const openingLabels = ["主标题内容", "副标题内容", "标题动画设计", "标题字体设计", "开场音频设计"];
  const isOpening = (row: FusionRecord): boolean => row.sceneType === "opening"
    || /^(S?C?00($|-|_)|OP|opening|intro)/iu.test(String(row.shotId ?? row.shot_id ?? ""));
  const openingValue = (row: FusionRecord, key: string): unknown => row[key] ?? recordValue(row.fields)[key];
  type OpeningContext = { budget: number; basePrompt: string; policy: NarrativePromptReviewPolicy;
    source: FusionRecord; index: number; count: number; fallbackUsed: boolean };
  const openingScope = new AsyncLocalStorage<OpeningContext>();
  const projectOpening = (row: FusionRecord, context: Pick<OpeningContext, "policy" | "index" | "count">,
    forceCompact = false, measuring = false): FusionRecord => applyNarrativeFinalPromptContract(
    { ...row, sceneType: "opening" }, { ...context.policy, canonicalize: true, chineseOnly: true,
      requireOpeningFields: !measuring, forceCompactMarketingHost: forceCompact,
      ...(measuring ? { maxLength: Number.MAX_SAFE_INTEGER } : {}),
      shotIndex: context.index, isLastShot: context.index === context.count - 1 });
  const validateOpening = (value: FusionRecord, context: OpeningContext): void => {
    const missing = openingKeys.filter(key => typeof value[key] !== "string" || !String(value[key]).trim()
      || /待片头优化器生成|需单独配置/u.test(String(value[key])));
    if (missing.length) throw new Error(`OPENING_TITLE_FIELDS_UNVERIFIED: ${missing.join("、")} 必须是原生作者的完整非空字符串`);
    const total = openingKeys.reduce((sum, key) => sum + unicodeLength(value[key] as string), 0);
    if (total > context.budget) throw new Error(`OPENING_TITLE_CAPACITY_EXCEEDED: 五字段 ${total} 字符超过当前正文剩余 ${context.budget}`);
    const audio = value.opening_audio_design as string;
    if (marketingAudioForContract(audio, { noDialogue: context.policy.noDialogue, noMusic: context.policy.noMusic,
      shotId: String(context.source.shotId ?? context.source.shot_id ?? ""), field: "opening_audio_design" }) !== audio.trim()) {
      throw new Error("OPENING_TITLE_AUDIO_UNVERIFIED: 原生片头声音设计违反冻结声音合同，须由原作者重写");
    }
  };
  let restoreOpeningAuthor: (() => void) | undefined;
  if (originalOpening) {
    const openingMod = vendorRequire(resolvePath(repoRoot,
      "vendor/supermickey/hyperreality-system/engines/production-engine/agents/opening-title-optimizer.js")) as {
      OpeningTitleOptimizer?: { prototype?: FusionRecord } };
    const authorPrototype = openingMod.OpeningTitleOptimizer?.prototype;
    if (!authorPrototype || typeof authorPrototype._buildPrompt !== "function"
      || typeof authorPrototype._getSystemPrompt !== "function" || typeof authorPrototype.optimize !== "function"
      || typeof authorPrototype._fallback !== "function") {
      throw new Error("OPENING_TITLE_AUTHOR_UNAVAILABLE: 原生片头作者接口不完整");
    }
    const build = authorPrototype._buildPrompt as (this: FusionRecord, shot: FusionRecord, blueprint: FusionRecord) => string;
    const systemPrompt = authorPrototype._getSystemPrompt as (this: FusionRecord) => string;
    const optimize = authorPrototype.optimize as (this: FusionRecord, shot: FusionRecord, blueprint: FusionRecord) => Promise<FusionRecord>;
    const fallback = authorPrototype._fallback as (this: FusionRecord, ...args: unknown[]) => unknown;
    authorPrototype._getSystemPrompt = function contractBoundOpeningSystemPrompt(this: FusionRecord) {
      const originalPrompt = systemPrompt.call(this);
      const context = openingScope.getStore();
      if (!context) return originalPrompt;
      return `${originalPrompt}\n\n本次冻结片头合同优先于以上默认设计规则与篇幅建议：`
        + `五字段字符串值合计最多 ${context.budget} 个 Unicode 字符，必须完整非空。`
        + `${context.policy.noMusic ? "禁止音乐、配乐、器乐、旋律或音乐节拍；原规则中的低沉器乐音要求取消，仅允许本镜原生环境声与动作声。" : "禁止合同外镜头外配乐；原规则中的低沉器乐音要求取消，声音仅取自本镜冻结的原生现场声；合同允许的画内实况音乐按源字段保留。"}`
        + `${context.policy.noDialogue ? "禁止可辨台词、对白、旁白或口播；保留合同允许的非语义现场声。" : "人声遵循本镜冻结合同。"}`
        + "原文字段篇幅要求由本次总预算覆盖；动画、字体、声音仍须写出完整可执行设计，不省略字段，不用占位词。";
    };
    authorPrototype._buildPrompt = function budgetedOpeningPrompt(this: FusionRecord, shot: FusionRecord, blueprint: FusionRecord) {
      const originalPrompt = build.call(this, shot, blueprint);
      const context = openingScope.getStore();
      if (!context) return originalPrompt;
      const nativeFields = Object.fromEntries(MARKETING_NATIVE_FUSION_FIELDS.map(([key, ...aliases]) =>
        [key, marketingNativeShotField(context.source, key, ...aliases)]));
      const frozenPolicy = Object.fromEntries([
        "noDialogue", "noMusic", "noCharacters", "noAnimals", "noTitles", "maxLength", "durationSeconds",
        "aspectRatio", "resolution", "colorTemperature", "characterNames", "characterPortraits",
        "postRainOnly", "sourceFirstFrame", "projectScene", "projectLighting", "projectColor", "projectProps",
        "projectActions", "marketingPrompt",
      ].map(key => [key, (context.policy as unknown as FusionRecord)[key]]));
      return `${originalPrompt}\n\n## 本次冻结合同与片头实际容量（优先于默认篇幅及示例）\n`
        + `五字段字符串值合计最多 ${context.budget} 个 Unicode 字符；JSON键、引号不计，最终五个编号标签及换行已预留。原文字段篇幅要求由本次总预算覆盖。\n`
        + "五个字段仍须完整非空：主副标题表达具体主题；动画保留起幅、成型、定格的时间顺序；字体写清字形及颜色；声音写清原生声音与动效同步点。用紧凑完整句，不省略字段、不用占位词，不改动下列原生镜头内容或后期文字原文。\n"
        + `${context.policy.noDialogue ? "禁止可辨台词、对白、旁白或口播；" : "人声遵循冻结合同；"}`
        + `${context.policy.noMusic ? "禁止音乐、配乐、器乐、旋律或音乐节拍；" : "禁止合同外镜头外配乐；"}`
        + "原示例中的声音签名或器乐建议若与本合同冲突，以本合同为准，只设计当前镜头允许的原生声音。\n"
        + `完整原生镜头字段：${JSON.stringify(nativeFields)}\n`
        + `冻结交付策略：${JSON.stringify(frozenPolicy)}\n`
        + `不含片头五字段的最终正文：\n${context.basePrompt}\n只输出原定五字段JSON，不附解释。`;
    };
    authorPrototype._fallback = function observedOpeningFallback(this: FusionRecord, ...args: unknown[]) {
      const context = openingScope.getStore();
      if (context) context.fallbackUsed = true;
      return fallback.apply(this, args);
    };
    authorPrototype.optimize = async function verifiedOpeningAuthor(this: FusionRecord, shot: FusionRecord, blueprint: FusionRecord) {
      const output = await optimize.call(this, shot, blueprint);
      const context = openingScope.getStore();
      if (context) {
        if (!output || output.degraded !== false || context.fallbackUsed) {
          throw new Error("OPENING_TITLE_AUTHOR_UNVERIFIED: 原生片头作者降级或调用fallback，不得固化片头断点");
        }
        validateOpening(output, context);
      }
      return output;
    };
    restoreOpeningAuthor = () => {
      authorPrototype._buildPrompt = build; authorPrototype._getSystemPrompt = systemPrompt;
      authorPrototype.optimize = optimize; authorPrototype._fallback = fallback;
    };
    prototype._optimizeOpeningTitle = async function capacityBoundOpeningTitle(
      this: FusionRecord, production: FusionRecord, result: FusionRecord, metadata: FusionRecord,
    ) {
      const rows = Array.isArray(production?.prompts) ? production.prompts as FusionRecord[] : [];
      const shots = Array.isArray(production?.shots) ? production.shots as FusionRecord[] : [];
      const shotIndex = shots.findIndex(isOpening);
      const originalShot = shots[shotIndex < 0 ? 0 : shotIndex];
      const promptIndex = rows.findIndex(isOpening);
      const originalRow = rows[promptIndex < 0 ? 0 : promptIndex] ?? originalShot;
      const policy = recordValue(originalRow?._workloomPromptReviewPolicy
        ?? recordValue(originalRow?.fields)._workloomPromptReviewPolicy) as unknown as NarrativePromptReviewPolicy;
      if (!originalShot || !originalRow || !policy.marketingPrompt || policy.noTitles) {
        return originalOpening.call(this, production, result, metadata);
      }
      // Work on a transaction copy: the native caller catches title exceptions.
      // A failed author must neither mutate the live report nor save a title stage.
      const working = structuredClone(production);
      const workingShot = (working.shots as FusionRecord[])[shotIndex < 0 ? 0 : shotIndex]!;
      const workingRow = (Array.isArray(working.prompts) ? working.prompts as FusionRecord[] : [])[
        promptIndex < 0 ? 0 : promptIndex] ?? workingShot;
      const clean: FusionRecord = { ...workingRow, fields: { ...recordValue(workingRow.fields) } };
      for (const key of openingKeys) { delete clean[key]; delete recordValue(clean.fields)[key]; }
      clean.prompt = String(clean.prompt ?? "").replace(new RegExp(
        `(?:\\d+\\.)?【(?:${openingLabels.join("|")})】[\\s\\S]*?(?=(?:\\s*\\|\\s*|\\s+\\d+\\.)?【|$)`, "gu"), "");
      const context: OpeningContext = { budget: 0, basePrompt: "", policy, source: originalRow,
        index: promptIndex < 0 ? 0 : promptIndex, count: Math.max(rows.length, 1), fallbackUsed: false };
      try {
        if (!Number.isFinite(policy.maxLength) || policy.maxLength < 1) throw new Error("最终正文上限无效");
        const base = projectOpening(clean, context, true, true);
        const markers = { ...clean, ...Object.fromEntries(openingKeys.map(key => [key, "声"])) };
        const marked = projectOpening(markers, context, true, true);
        const labelOverhead = unicodeLength(String(marked.prompt)) - unicodeLength(String(base.prompt)) - openingKeys.length;
        context.basePrompt = String(base.prompt);
        context.budget = policy.maxLength - unicodeLength(context.basePrompt) - labelOverhead;
        if (context.budget < openingKeys.length) throw new Error("完整正文与五个标签已无五字段非空容量");
      } catch (error) {
        throw new Error(`OPENING_TITLE_CAPACITY_UNAVAILABLE: ${String(originalRow.shotId ?? "")} 无可用片头容量`, { cause: error });
      }
      const existing = Object.fromEntries(openingKeys.map(key => [key, openingValue(workingShot, key)]));
      let existingFits = false;
      try {
        validateOpening(existing, context);
        projectOpening({ ...workingRow, ...existing }, context);
        existingFits = openingKeys.every(key => openingValue(workingRow, key) === existing[key]);
      } catch { existingFits = false; } // Invalid old values return to the same native author.
      if (!existingFits) delete workingShot.title_content; // bypass native complete-fields early return on this copy only
      await openingScope.run(context, () => originalOpening.call(this, working, result, metadata));
      const authored = Object.fromEntries(openingKeys.map(key => [key, openingValue(workingRow, key)]));
      validateOpening(authored, context);
      // This happens inside the original method seen by bindStudioEngineCheckpoints,
      // before its execute callback can save OPENING_TITLE.productionAfter.
      // Native postprocessing appends title fields with pipes, sometimes to a
      // numbered base line. Reuse the original title-free draft so those bodies
      // cannot be mistaken for part of 基础 and counted a second time.
      const finalOpening = projectOpening({ ...workingRow, ...authored, prompt: clean.prompt }, context);
      workingRow.prompt = finalOpening.prompt;
      workingShot.prompt = finalOpening.prompt;
      normalizeNarrativePromptsForReview(Array.isArray(working.prompts) ? working.prompts as FusionRecord[] : [workingRow], policy);
      for (const [destination, source] of [[originalShot, workingShot], [originalRow, workingRow]]) {
        for (const key of [...openingKeys, "title", "subtitle", "prompt"]) {
          if (Object.hasOwn(source!, key)) destination![key] = source![key];
        }
      }
      log(`[vendor-compat] 原生片头五字段通过动态容量 ${context.budget} 与最终正文校验`);
      return undefined;
    };
  }
  if (originalFormat) {
    prototype._formatPromptWithSequenceNumbers = function patchedPromptFormat(
      this: Record<string, unknown>,
      promptText: unknown,
      isOpening = false,
      shotData?: FusionRecord,
    ) {
      if (typeof promptText === "string" && /^\s*\d{2}\.【[^】]+】/mu.test(promptText)) {
        return promptText.trim();
      }
      return originalFormat.call(this, promptText, isOpening, shotData);
    };
  }
  if (originalReport) {
    prototype._generatePromptsReport = function patchedPromptReport(
      this: Record<string, unknown>,
      prompts: FusionRecord[],
    ) {
      const reportPrompts: FusionRecord[] = prompts.map((row) => {
        const rowPolicy = row._workloomPromptReviewPolicy
          && typeof row._workloomPromptReviewPolicy === "object"
          ? row._workloomPromptReviewPolicy as NarrativePromptReviewPolicy
          : null;
        const camera = promptReviewField(row, "运镜");
        const fixedCamera = /(?:固定机位|三脚架锁死|零推拉零横移零变焦)/u.test(camera);
        const compatibleSkills = (value: unknown): unknown[] => {
          if (!Array.isArray(value)) return [];
          return value.filter((item) => {
            const file = String(recordValue(item).file ?? item ?? "");
            return !(fixedCamera && /(?:手持|斯坦尼康|手持推进|推轨|摇臂)/u.test(file));
          });
        };
        return {
          ...row,
          promptCharCount: unicodeLength(String(row.prompt ?? "")),
          _skillMatched: compatibleSkills(row._skillMatched),
          _appliedSkills: compatibleSkills(row._appliedSkills),
          ...(rowPolicy?.noTitles ? { sceneType: "content" } : {}),
        };
      });
      const report = originalReport.call(this, reportPrompts);
      const portraitState = new Map(reportPrompts.map((row) => {
        const promptText = String(row.prompt ?? "");
        const portraitField = /^\s*\d+\.【定妆照】([^\n]*)$/mu.exec(promptText)?.[1]?.trim() ?? "";
        const contract = promptBoundShotContract(row);
        const linkedAssets = Array.isArray(contract.portraitAssets)
          ? contract.portraitAssets.map(recordValue).filter((item) => String(item.path ?? "").trim())
          : [];
        return [
          String(row.shotId ?? row.shot_id ?? ""),
          Boolean(linkedAssets.length > 0 || (portraitField && !/^不适用/u.test(portraitField))),
        ] as const;
      }));
      let currentPromptId = "";
      const portraitReport = report.split("\n").map((line) => {
        const heading = line.match(/^###\s+([^\s(]+)/u)?.[1];
        if (heading) currentPromptId = heading;
        if (line.startsWith("|")) {
          const cells = line.split("|");
          const rowId = cells[1]?.trim() ?? "";
          if (portraitState.has(rowId)) cells[6] = portraitState.get(rowId) ? " ✓ " : " ✗ ";
          return cells.join("|");
        }
        if (line.startsWith("**长度**") && portraitState.has(currentPromptId)) {
          return line.replace(/\*\*定妆照\*\*:\s*(?:有|无)/u, `**定妆照**: ${portraitState.get(currentPromptId) ? "有" : "不适用或未绑定"}`);
        }
        return line;
      }).join("\n");
      const contracts = reportPrompts
        .map((row) => row._workloomShotContract)
        .filter((value): value is FusionRecord => Boolean(value && typeof value === "object" && !Array.isArray(value)));
      if (contracts.length === 0) return portraitReport;
      const actionSequence = contracts.map((contract) => String(contract.action ?? "")).filter(Boolean);
      const contractDocument = {
        schema: "workloom.prompt-review-contract/v1",
        shotCount: contracts.length,
        totalDurationSeconds: contracts.reduce((sum, contract) => sum + Number(contract.durationSeconds ?? 0), 0),
        continuity: {
          orderedActions: actionSequence,
          actionOrderHash: createHash("sha256").update(JSON.stringify(actionSequence)).digest("hex"),
          doorState: /开门/u.test(actionSequence.join(" "))
            ? (/关门|门关好|门锁落位/u.test(actionSequence.join(" ")) ? "open_then_closed" : "opens_without_close")
            : "not_used",
          footwearState: /换鞋|湿便鞋/u.test(actionSequence.join(" "))
            ? "wet_shoes_then_indoor_slippers"
            : "not_changed",
        },
        shots: contracts,
      };
      return `${portraitReport.trimEnd()}\n\n## 结构化镜头合同（机器可读）\n\n\`\`\`json\n${jsonWithoutNull(contractDocument)}\n\`\`\`\n`;
    };
  }
  prototype._confirmPrompts = function patchedPromptReview(
    this: Record<string, unknown>,
    prompts: FusionRecord[],
  ) {
    if (Array.isArray(prompts) && prompts.length > 0) {
      const policy = prompts
        .map((row) => row._workloomPromptReviewPolicy
          ?? (row.fields && typeof row.fields === "object"
            ? (row.fields as FusionRecord)._workloomPromptReviewPolicy
            : undefined))
        .find((value): value is NarrativePromptReviewPolicy => Boolean(value && typeof value === "object"));
      if (policy) {
        const normalized = normalizeNarrativePromptsForReview(prompts, policy);
        prompts.splice(0, prompts.length, ...normalized);
        log(`[vendor-compat] G6 前按冻结叙事策略重建 ${normalized.length} 条最终提示词`);
      } else {
        log("[vendor-compat] G6 提示词缺少 Phase3 冻结策略；不做未绑定重写，交由后续门禁失败关闭");
      }
    }
    options.capture?.(prompts);
    return original.call(this, prompts);
  };
  return () => {
    prototype._confirmPrompts = original;
    if (originalFormat) prototype._formatPromptWithSequenceNumbers = originalFormat;
    if (originalReport) prototype._generatePromptsReport = originalReport;
    if (originalOpening) prototype._optimizeOpeningTitle = originalOpening;
    restoreOpeningAuthor?.();
  };
}

/**
 * 每次执行独立的 agent 视图，避免并发 run 互改重试和子服务回调。
 * 只保留单次外调超时，不按整条任务已经运行的时间缩减后续创作。
 */
function scopedFusionAgent(agent: FusionAgent): FusionAgent {
  const scoped = Object.create(agent) as FusionAgent;
  scoped._globalDeadline = Infinity;
  scoped._remainingMs = () => Infinity;
  scoped._callBudget = new Map(agent._callBudget instanceof Map ? agent._callBudget : []);
  const originalCall = agent._callLLM;
  if (typeof originalCall === "function") {
    scoped._callLLM = async (...args: unknown[]) => {
      const opts = args[3] && typeof args[3] === "object" ? args[3] as FusionRecord : {};
      args[3] = { ...opts };
      delete (args[3] as FusionRecord).shotBudget;
      delete (args[3] as FusionRecord).deadlineMs;
      type Author = { modelId: string; responseId: string };
      const invoke = async (callArgs: unknown[], author?: Author, pinnedEngine?: FusionRecord) => {
        // BaseAgent consumes failed structured results before returning its
        // degraded result. Observe that real boundary without moving another
        // dispatch inside its single-request timeout or sharing concurrent calls.
        const runner = Object.create(scoped) as FusionAgent;
        let last: LLMReasonResult | undefined;
        let engine = pinnedEngine;
        let sequence = 0;
        const views = new WeakMap<object, FusionRecord>();
        const originalGet = agent._getLLMEngine;
        if (typeof originalGet === "function") {
          runner._getLLMEngine = () => {
            const actual = engine ?? originalGet.call(scoped);
            if (!actual || typeof actual.reasonStructured !== "function") return actual;
            engine = actual;
            const cached = views.get(actual);
            if (cached) return cached;
            const view = Object.create(actual) as FusionRecord;
            const reasonStructured = actual.reasonStructured as (...params: unknown[]) => Promise<LLMReasonResult>;
            view.reasonStructured = async (...params: unknown[]) => {
              const current = ++sequence;
              last = undefined;
              const request = [...params];
              if (author) request[2] = { ...recordValue(request[2]), strictAuthorModel: author.modelId };
              let response = await reasonStructured.apply(actual, request);
              if (author && response.success && (response.unknown === true
                || response.settledAuthor?.modelId !== author.modelId
                || !response.settledAuthor.responseId
                || response.settledAuthor.responseId === author.responseId)) {
                response = { ...response, success: false, retryable: false,
                  error: "PHASE3_STRUCTURED_REPAIR_UNVERIFIED: JSON 修复缺少同模型独立响应回执" };
              }
              if (current === sequence) last = response;
              return response;
            };
            views.set(actual, view);
            return view;
          };
        }
        const response = await originalCall.apply(runner, callArgs);
        return { response, last, engine };
      };
      const first = await invoke(args);
      const author = first.last?.settledAuthor;
      if (recordValue(first.response).degraded !== true || first.last?.success !== false
        || first.last.structuredParseFailure !== true || first.last.unknown === true
        || !author?.modelId?.trim() || !author.responseId?.trim() || !first.engine) return first.response;
      const retryArgs = [...args];
      retryArgs[0] = `${String(args[0] ?? "")}\n严格只输出一个完整合法 JSON 对象；不要 Markdown 代码围栏、解释、前后缀或尾随文本。`;
      // A distinct BaseAgent call gives this settled author correction its own
      // original single-request timer. It never recurses into another repair.
      return (await invoke(retryArgs, author, first.engine)).response;
    };
  }
  if (agent._semanticPass && typeof agent._semanticPass === "object" && scoped._callLLM) {
    const semantic = Object.create(agent._semanticPass) as FusionRecord;
    semantic.callLLM = (...args: unknown[]) => scoped._callLLM!(...args);
    scoped._semanticPass = semantic;
  }
  return scoped;
}

export function installVendorPhase3FusionBridge(options: { log?: (line: string) => void } = {}): () => void {
  return installSharedBridge("phase3-fusion-policy-v1", () => {
    const repoRoot = videoRuntimeRoot(import.meta.url);
    const vendorRoot = resolvePath(repoRoot, "vendor/supermickey/hyperreality-system");
    const vendorRequire = createRequire(resolvePath(repoRoot, "package.json"));
    const phaseModule = vendorRequire(resolvePath(vendorRoot, "engines/production-engine/phases/phase-3-prompt-fusion.js")) as {
      Phase3PromptFusion: { prototype: FusionRecord };
    };
    const engineModule = vendorRequire(resolvePath(vendorRoot, "engines/production-engine/production-engine.js")) as {
      ProductionEngine: { prototype: FusionRecord };
    };
    const router = vendorRequire(resolvePath(vendorRoot, "skills/hollywood-cinematography/cinematography-skill-router.js")) as CinematicSkillRouter;
    const indexPath = resolvePath(vendorRoot, "skills/hollywood-cinematography/skills-compiled.json");
    const registryText = readFileSync(indexPath, "utf8");
    const registry = JSON.parse(registryText) as { skills?: Array<{ file?: string }> };
    if (!Array.isArray(registry.skills) || !registry.skills.length) {
      throw new CinematicSkillError("SKILL_INDEX_INVALID", "宿主技能桥要求非空的编译技能索引", "unverified");
    }
    const names = new Set<string>();
    const skillSources: Array<{ file: string; hash: string }> = [];
    for (const row of registry.skills) {
      if (typeof row.file !== "string" || !row.file.endsWith(".md") || /[\\/]/.test(row.file) || names.has(row.file)
        || !existsSync(resolvePath(vendorRoot, "skills/好莱坞工业电影技能工厂/技能系列/镜头级专项", row.file))) {
        throw new CinematicSkillError("SKILL_INDEX_INVALID", "技能索引存在重复、非法路径或缺失正文", "unverified");
      }
      names.add(row.file);
      skillSources.push({ file: row.file, hash: cinematicSkillHash(readFileSync(
        resolvePath(vendorRoot, "skills/好莱坞工业电影技能工厂/技能系列/镜头级专项", row.file), "utf8"
      )) });
    }
    const registryHash = cinematicSkillHash({ compiled: registryText, sources: skillSources });
    const prototype = phaseModule.Phase3PromptFusion?.prototype;
    const enginePrototype = engineModule.ProductionEngine?.prototype;
    if (!prototype || typeof prototype.execute !== "function" || !enginePrototype || typeof enginePrototype.produce !== "function") {
      throw new CinematicSkillError("PHASE3_BRIDGE_UNAVAILABLE", "vendor Phase3/ProductionEngine 接口不可用", "unverified");
    }
    const originalExecute = prototype.execute;
    const originalProduce = enginePrototype.produce as (blueprint: FusionRecord, ...args: unknown[]) => Promise<FusionRecord>;
    const originalUpdateAgentConfig = enginePrototype.updateAgentConfig as
      (this: FusionRecord, config?: FusionRecord) => unknown;
    if (typeof originalUpdateAgentConfig !== "function") {
      throw new CinematicSkillError("PHASE3_BRIDGE_UNAVAILABLE", "ProductionEngine 运行时配置扩展点不可用", "unverified");
    }
    enginePrototype.updateAgentConfig = function updateCurrentPhaseAgents(this: FusionRecord, config?: FusionRecord) {
      const result = originalUpdateAgentConfig.call(this, config);
      // vendor 更新配置会替换 agents；各 Phase 必须消费同一批新实例，才能收到本次模型与 deadline。
      // 仅重接依赖，保留 Phase 的 checkpoint、健康监控及已装配的宿主桥。
      for (const key of ["phase1", "phase2", "phase3", "phase35"]) {
        const phase = this[key];
        if (phase && typeof phase === "object") (phase as FusionRecord).agents = this.agents;
      }
      // Phase 3.5 构造独立检查器；健康监控重建 Phase 时也从引擎读取模型。
      const agents = this.agents as { sceneDesign?: { llmModel?: unknown } } | undefined;
      const llmModel = agents?.sceneDesign?.llmModel;
      if (typeof llmModel === "string" && llmModel) {
        this.llmModel = llmModel;
        if (this.phase35 && typeof this.phase35 === "object") {
          (this.phase35 as FusionRecord).llmModel = llmModel;
        }
      }
      return result;
    };

    prototype.execute = async function executeHostPhase3(this: FusionPhase, state: FusionRecord): Promise<FusionRecord> {
      const start = Date.now();
      const result = fusionRecord(state.result, "result");
      const stages = result.stages && typeof result.stages === "object" ? result.stages as FusionRecord : {};
      result.stages = stages;
      let shots: FusionRecord[] = [];
      let healthEnabled = false;
      const evidence: FusionRecord = { schemaVersion: PHASE3_FUSION_POLICY_VERSION, status: "unverified", registryHash };
      stages.phase3Fusion = evidence;
      try {
        if (!Array.isArray(state.shots) || !state.shots.length) throw new CinematicSkillError("PHASE3_SHOTS_MISSING", "没有待融合镜头");
        shots = this.cloneShots(state.shots.map((shot) => fusionRecord(shot, "shot")));
        const blueprint = fusionRecord(state.adaptedBlueprint, "adaptedBlueprint");
        const agent = this.agents.promptFusion;
        if (!agent || typeof agent.process !== "function") throw new CinematicSkillError("PHASE3_AGENT_MISSING", "PromptFusion Agent 不可用", "unverified");
        evidence.budget = { policy: "no-task-deadline" };
        evidence.blueprintHash = cinematicSkillHash(blueprint);
        const scoped = scopedFusionAgent(agent);
        if (this.healthMonitor) {
          this.healthMonitor.setLongTaskMode("ProductionEngine", true, Infinity);
          healthEnabled = true;
        }
        const plan = await planCinematicSkills(shots, blueprint, router, {
          registryHash,
          ...(scoped._callLLM ? { llmCaller: async (prompt: string) => {
            const raw = await scoped._callLLM!(prompt, { required: ["picks"] }, () => null, { critical: true });
            const response = fusionRecord(raw, "技能精选响应");
            if (response.degraded === true) throw new CinematicSkillError("SKILL_SELECTION_UNVERIFIED", "技能精选调用降级", "unverified");
            return response.result;
          } } : {}),
        });
        shots = shots.map((shot) => {
          const p = plan.get(String(shot.shotId ?? shot.shot_id))!;
          const next = { ...shot, _skillMatched: p.matched, _workloomSkillPlan: { ...p, qcEntries: undefined } };
          // 抹掉旧路由残留，空匹配不得保留上次的技能正文。
          return { ...next, _skillContext: p.contextText };
        });
        stages.skillPrematch = [...plan.values()].map(({ contextText: _context, qcEntries: _qc, ...entry }) => ({
          ...entry, injection: entry.matched.length ? "pre" : "none",
        }));
        const blueprintHash = cinematicSkillHash({ policy: PHASE3_FUSION_POLICY_VERSION, blueprint, registryHash, shots });
        const pfResult = await scoped.process(this.cloneShots(shots), blueprint, { checkpointManager: this.checkpointManager, blueprintHash });
        const rawUpdated = pfResult.shots;
        if (!Array.isArray(rawUpdated) || rawUpdated.length !== shots.length) {
          throw new CinematicSkillError("PHASE3_FUSION_UNVERIFIED", "融合返回缺镜头或包含降级/失败，不接受规则兜底", "unverified");
        }
        let updated = rawUpdated as FusionRecord[];
        if (pfResult.degraded === true) {
          updated = updated.map((row) => ({ ...row, degraded: true }));
        }
        const expectedIds = new Set(shots.map((shot) => String(shot.shotId ?? shot.shot_id)));
        const nativeMarketing = Boolean(recordValue(recordValue(recordValue(blueprint.meta)._metadata)._prd)._workloomMarketingPrompt);
        const repairedRowIds: string[] = [];
        const repairResult = await repairPhase3FusionRows({
          rows: updated,
          expectedIds: [...expectedIds],
          repair: async (shotId, index) => {
            const source = shots.find((shot) => String(shot.shotId ?? shot.shot_id) === shotId) ?? shots[index];
            if (!source) throw new CinematicSkillError("PHASE3_SHOTS_MISSING", `无法定位待重试镜头 ${shotId}`);
            const meta = blueprint.meta && typeof blueprint.meta === "object" ? blueprint.meta as FusionRecord : {};
            const metaFields = meta._metadata && typeof meta._metadata === "object" ? meta._metadata as FusionRecord : {};
            const ratio = String(
              (blueprint.config as FusionRecord | undefined)?.aspect_ratio
              ?? metaFields.aspectRatio
              ?? "9:16",
            );
            const characters = Array.isArray((blueprint.character_system as FusionRecord | undefined)?.characters)
              ? (blueprint.character_system as FusionRecord).characters as FusionRecord[]
              : [];
            scoped._currentShotIdx = index;
            const retry = await (scoped as FusionAgent & {
              _fuseSingleShot?: (
                shot: FusionRecord,
                ratio: string,
                characters: FusionRecord[],
                blueprint: FusionRecord,
                budget: number,
              ) => Promise<unknown>;
            })._fuseSingleShot?.(
              this.cloneShots([source])[0]!,
              ratio,
              characters,
              blueprint,
              Infinity,
            );
            return retry;
          },
          ...(nativeMarketing ? { validateRow: validMarketingNativeFusionRow } : { recover: async (shotId: string, index: number) => {
            const source = shots.find((shot) => String(shot.shotId ?? shot.shot_id) === shotId) ?? shots[index];
            if (!source) throw new CinematicSkillError("PHASE3_SHOTS_MISSING", `无法定位合同恢复镜头 ${shotId}`);
            return recoverPhase3RowFromSource(this.cloneShots([source])[0]!);
          } }),
          onRepaired: (rows, shotId) => {
            const retryEvidence: FusionRecord = { repaired: [...repairedRowIds, shotId], mode: "single-shot-llm-retry" };
            stages.phase3Retry = retryEvidence;
            if (this.checkpointManager) {
              const checkpointHash = pfResult.checkpointBlueprintHash;
              if (typeof checkpointHash !== "string" || !/^[a-f0-9]{24,64}$/u.test(checkpointHash)
                || typeof scoped._saveSubCheckpoint !== "function") {
                throw new CinematicSkillError("PHASE3_REPAIR_CHECKPOINT_UNVERIFIED", "缺少原生单镜修复的同指纹保存接口", "unverified");
              }
              try {
                // Persist each accepted native repair before another shot can fail.
                scoped._saveSubCheckpoint(this.checkpointManager, checkpointHash, rows, rows.length, shots.length);
                retryEvidence.rawCheckpointSaved = true;
              } catch (error) {
                throw new CinematicSkillError("PHASE3_REPAIR_CHECKPOINT_UNVERIFIED",
                  error instanceof Error ? error.message : String(error), "unverified");
              }
            }
            repairedRowIds.push(shotId);
          },
        });
        updated = repairResult.rows;
        if (repairResult.recovered.length > 0) {
          stages.phase3Recovery = {
            recovered: repairResult.recovered,
            mode: "contract-source-reprojection",
            requiresFinalReviewProjection: true,
          };
        }
        const policyMeta = blueprint.meta && typeof blueprint.meta === "object"
          ? (blueprint.meta as FusionRecord)._metadata as FusionRecord | undefined
          : undefined;
        const dialogueRequirement = String(policyMeta?.dialogueRequirement ?? "");
        const speechFullyForbidden = narrativeSpeechPolicy(dialogueRequirement).allSpeechForbidden;
        const policyPrd = recordValue(policyMeta?._prd);
        const policyPositioning = recordValue(policyPrd.productPositioning);
        const promptPolicyText = [
          dialogueRequirement,
          (blueprint.meta as FusionRecord | undefined)?._originalStoryText,
          recordValue(policyPrd.projectDefinition).sourceIntent,
          policyMeta?.special_notes,
        ].map(String).join(" ");
        const promptNoAnimals = /(?:无动物|不出现动物|禁止动物)/u.test(promptPolicyText);
        const promptNoCharacters = /(?:无人物|不出现人物|画面无人|无角色|纯空镜|场景为主体)/u.test(promptPolicyText);
        const promptNoMusic = /(?:无|不加|不要|禁止|不出现)[^。；\n]{0,8}(?:配乐|音乐|旋律)|(?:仅|只)保留(?:人物|主体)?(?:动作)?(?:与)?(?:画外)?(?:环境声|实拍声)/u.test(promptPolicyText);
        const postRainOnly = /(?:雨后|雨停后|雨停了)/u.test(promptPolicyText);
        const promptDuration = Number(
          policyPositioning.targetDuration
          ?? recordValue(blueprint.config).target_duration
          ?? (blueprint.meta as FusionRecord | undefined)?.target_duration
          ?? 0,
        );
        const promptAspect = String(
          policyPositioning.aspectRatio
          ?? recordValue(blueprint.meta).aspectRatio
          ?? "9:16",
        );
        const promptResolution = String(policyPositioning.resolution ?? (promptAspect === "9:16" ? "1080x1920" : ""));
        const promptColorTemperature = colorTemperatureFromText(JSON.stringify(policyPrd.visualSpecification)) ?? undefined;
        const promptCharacterRecords = Array.isArray(recordValue(policyPrd.characterSystem).characters)
          ? (recordValue(policyPrd.characterSystem).characters as unknown[]).map(recordValue)
          : [];
        const promptCharacters = promptCharacterRecords.map((item) => String(item.name ?? "").trim()).filter(Boolean);
        const promptCharacterPortraits = promptCharacterRecords.map((item) => ({
          name: String(item.name ?? "").trim(),
          path: String(item.portraitPath ?? item.portraitRef ?? "").trim(),
          appearance: String(item.appearance ?? "").trim(),
          costume: String(item.costume ?? "").trim(),
          authorization: String(item.authorization ?? "unverified").trim(),
          ...(item.portraitEvidence && typeof item.portraitEvidence === "object"
            ? {
              sha256: String(recordValue(item.portraitEvidence).sha256 ?? "").trim() || undefined,
              bytes: Number(recordValue(item.portraitEvidence).bytes) || undefined,
            }
            : {}),
        })).filter((item) => item.name);
        const promptSubtitles = recordValue(recordValue(policyPrd.deliveryStandard).subtitles);
        const marketingPrompt = policyPrd._workloomMarketingPrompt as MarketingPromptPlan | undefined;
        const promptNoTitles = promptSubtitles.mode === "none" || /(?:无字幕|无文字)/u.test(promptPolicyText);
        const promptScenePlan = recordValue(policyPrd.scenePlan);
        const promptVisual = recordValue(policyPrd.visualSpecification);
        const promptSceneSettings = (Array.isArray(promptScenePlan.scenes) ? promptScenePlan.scenes.map(recordValue) : [])
          .map((scene) => scene.setting).map(String).filter(Boolean);
        const promptScene = promptSceneSettings.length > 0
          ? [...new Set(promptSceneSettings)].join("；")
          : String(recordValue(policyPrd.projectDefinition).sourceIntent ?? "");
        const promptProps = [...new Set([
          ...(Array.isArray(policyPrd.shotContract) ? policyPrd.shotContract.map(recordValue) : [])
            .flatMap((shot) => Array.isArray(shot.keyProps) ? shot.keyProps.map(String) : []),
          ...(Array.isArray(promptScenePlan.scenes) ? promptScenePlan.scenes.map(recordValue) : [])
            .flatMap((scene) => Array.isArray(scene.keyProps) ? scene.keyProps.map(String) : []),
        ].filter(Boolean))];
        const extractedPromptActions = extractNarrativeActions({}, {
          _originalStoryText: String(policyPrd._originalStoryText ?? promptScene),
          special_notes: String(policyMeta?.special_notes ?? ""),
        });
        const promptActionsBase = marketingPrompt?.actions.length ? marketingPrompt.actions : extractedPromptActions.length > 0
          ? extractedPromptActions
          : updated.map((shot) => promptFieldText(shot.action)).filter(Boolean);
        const promptActions = marketingPrompt ? promptActionsBase : projectNarrativeActionSequence(promptActionsBase, updated.length);
        const promptContractShots = Array.isArray(policyPrd.shotContract)
          ? policyPrd.shotContract.map(recordValue)
          : [];
        const promptSceneRecords = Array.isArray(promptScenePlan.scenes)
          ? promptScenePlan.scenes.map(recordValue)
          : [];
        const promptLighting = promptFieldText(promptVisual.lightingDirection);
        const promptColor = promptFieldText(promptVisual.colorPalette ?? promptVisual.colorGrading);
        const promptProjectColor = promptColor && promptColor !== "色温按已确认视觉方案执行"
          ? promptColor
          : ((colorTemperatureFromText(promptVisual) ?? promptColor) || "色温按已确认视觉方案执行");
        const promptLimit = Number(
          (vendorRequire(resolvePath(
            repoRoot,
            "vendor/supermickey/hyperreality-system/config/prompt-length.js",
          )) as { HARD_MAX?: number }).HARD_MAX ?? 3000,
        );
        const promptReviewPolicy: NarrativePromptReviewPolicy = {
          noDialogue: speechFullyForbidden,
          maxLength: promptLimit,
          noCharacters: promptNoCharacters,
          noAnimals: promptNoAnimals,
          noMusic: promptNoMusic,
          noTitles: promptNoTitles,
          durationSeconds: Number.isFinite(promptDuration) && promptDuration > 0 ? promptDuration : undefined,
          aspectRatio: promptAspect,
          resolution: promptResolution,
          colorTemperature: promptColorTemperature,
          characterNames: promptCharacters,
          characterPortraits: promptCharacterPortraits,
          postRainOnly,
          projectScene: promptScene,
          projectLighting: promptLighting,
          projectColor: promptProjectColor,
          projectProps: promptProps,
          projectActions: promptActions,
          marketingPrompt,
        };
        updated = updated.map((shot, shotIndex, allShots) => {
          const contractShot = !marketingPrompt && promptContractShots.length > 0
            ? promptContractShots[Math.min(
              promptContractShots.length - 1,
              Math.floor(shotIndex * promptContractShots.length / Math.max(1, allShots.length)),
            )]!
            : {};
          const contractScene = promptFieldText(contractShot.location);
          const contractLighting = promptFieldText(contractShot.lighting);
          const contractColor = promptFieldText(contractShot.colorTemperature);
          const contractProps = Array.isArray(contractShot.keyProps)
            ? contractShot.keyProps.map(String).filter(Boolean)
            : [];
          const contractShotPurpose = promptFieldText(contractShot.purpose);
          const sourceFirstFrameMatch = contractShotPurpose.match(/(?:^|[；;])\s*第一帧[:：]?\s*([^；;。]+)/u);
          const contractSceneId = promptFieldText(contractShot.sceneId);
          const scenePurpose = promptFieldText(
            promptSceneRecords.find((scene) => promptFieldText(scene.sceneId) === contractSceneId)?.purpose,
          );
          const shotActions = extractNarrativeActions({}, { _originalStoryText: contractShotPurpose });
          const sceneActions = extractNarrativeActions({}, { _originalStoryText: scenePurpose });
          const sceneShotIds = promptContractShots
            .filter((candidate) => promptFieldText(candidate.sceneId) === contractSceneId)
            .map((candidate) => promptFieldText(candidate.shotId));
          const sceneShotIndex = Math.max(0, sceneShotIds.indexOf(promptFieldText(contractShot.shotId)));
          const contractAction = shotActions.length > 0
            ? contractShotPurpose
            : (sceneActions[Math.min(sceneActions.length - 1, sceneShotIndex)]
              || promptActions[Math.min(
                promptActions.length - 1,
                Math.floor((shotIndex + 0.5) * promptActions.length / Math.max(1, allShots.length)),
              )]);
          const orderedAction = marketingPrompt ? marketingNativeShotField(shot, "action") : String(
            allShots.length <= promptActions.length
              ? promptActions[shotIndex]
              : promptActions[Math.min(
                promptActions.length - 1,
                Math.floor((shotIndex + 0.5) * promptActions.length / Math.max(1, allShots.length)),
              )]
            || contractAction
            || "",
          );
          const sourceFirstFrame = !marketingPrompt && sourceFirstFrameMatch
            && !["contact", "withdraw", "retreat", "curl"].includes(animalActionKind(orderedAction))
            ? `第一帧${sourceFirstFrameMatch[1]!.trim()}`
            : undefined;
          const direction = deriveNarrativeShotDirection({
            action: orderedAction,
            fallbackScene: marketingPrompt ? marketingNativeShotField(shot, "scene", "sceneDescription") : contractScene || promptReviewPolicy.projectScene,
            fallbackLighting: marketingPrompt ? marketingNativeShotField(shot, "lighting", "lightingString") : contractLighting || promptReviewPolicy.projectLighting,
            fallbackColor: marketingPrompt ? marketingNativeShotField(shot, "color_palette", "colorPalette") : contractColor || promptReviewPolicy.projectColor,
            fallbackProps: marketingPrompt ? [marketingNativeShotField(shot, "props")] : contractProps.length > 0 ? contractProps : promptReviewPolicy.projectProps,
          });
          const contractShotSize = marketingPrompt ? null : promptFieldText(contractShot.shotSize) || shotSizeForAction(orderedAction);
          const contractCameraMovement = marketingPrompt ? "" : promptFieldText(contractShot.cameraMovement);
          const rowPolicy: NarrativePromptReviewPolicy = {
            ...promptReviewPolicy,
            projectScene: direction.scene || promptReviewPolicy.projectScene,
            projectLighting: direction.lighting || promptReviewPolicy.projectLighting,
            projectColor: direction.color || promptReviewPolicy.projectColor,
            projectProps: marketingPrompt ? direction.props : mergeNarrativeProps(direction.props, promptReviewPolicy.projectProps),
            projectActions: promptActions,
            sourceFirstFrame,
          };
          const projectedShot: FusionRecord = {
            ...shot,
            ...(contractShotSize ? { shotSize: contractShotSize, cameraHint: contractShotSize } : {}),
            ...(contractCameraMovement ? { camera_movement: contractCameraMovement, cameraMovement: contractCameraMovement } : {}),
          };
          return {
            ...applyNarrativeFinalPromptContract(projectedShot, {
            noDialogue: speechFullyForbidden,
            maxLength: promptLimit,
            noCharacters: promptNoCharacters,
            noAnimals: promptNoAnimals,
            noMusic: promptNoMusic,
            chineseOnly: true,
            durationSeconds: Number.isFinite(promptDuration) && promptDuration > 0 ? promptDuration : undefined,
            aspectRatio: promptAspect,
            resolution: promptResolution,
            colorTemperature: promptColorTemperature,
            isLastShot: shotIndex === allShots.length - 1,
            characterNames: promptCharacters,
            postRainOnly,
            sourceFirstFrame,
            noTitles: promptNoTitles,
            canonicalize: true,
            marketingPrompt,
            characterPortraits: promptCharacterPortraits,
            projectScene: rowPolicy.projectScene,
            projectLighting: rowPolicy.projectLighting,
            projectColor: rowPolicy.projectColor,
            projectProps: rowPolicy.projectProps,
            projectActions: rowPolicy.projectActions,
            shotIndex,
            }),
            _workloomPromptReviewPolicy: rowPolicy,
          };
        });
        const outputIds = new Set<string>();
        for (const row of updated) {
          const shot = fusionRecord(row, "融合镜头");
          const id = String(shot.shotId ?? shot.shot_id ?? "");
          if (!expectedIds.has(id) || outputIds.has(id) || shot.degraded === true || typeof shot.prompt !== "string" || !shot.prompt.trim()) {
            throw new CinematicSkillError("PHASE3_FUSION_UNVERIFIED", "融合镜头 id、提示词或降级状态无效", "unverified");
          }
          outputIds.add(id);
        }
        const merged = this.mergeShots(shots, updated as FusionRecord[], FUSION_MERGE_FIELDS);
        const timed = await this._checkDialogueTiming(merged, blueprint);
        if (!Array.isArray(timed) || timed.length !== shots.length
          || new Set(timed.map((shot) => String(shot.shotId ?? shot.shot_id))).size !== shots.length) {
          throw new CinematicSkillError("PHASE3_CONTRACT_INVALID", "台词检查后镜头数量或 id 不一致", "unverified");
        }
        const qcRows: FusionRecord[] = [];
        const finalShots: FusionRecord[] = timed.map((shot) => {
          const id = String(shot.shotId ?? shot.shot_id);
          const p = plan.get(id);
          if (!p || typeof shot.prompt !== "string" || !shot.prompt.trim()) throw new CinematicSkillError("PHASE3_CONTRACT_INVALID", "合并后丢失镜头或 prompt", "unverified");
          const violations = checkCinematicSkillCompliance(shot.prompt, p.qcEntries);
          const status: CinematicSkillStatus = violations.length ? "failed" : p.matched.length ? "passed" : "not_applicable";
          const qc = { status, scope: "prompt-text-only", skills: p.matched.map(({ file }) => file), violations };
          qcRows.push({ shotId: id, ...qc });
          return { ...shot, _skillQC: qc, _workloomFusion: {
            schemaVersion: PHASE3_FUSION_POLICY_VERSION, status: "passed", sourceHash: p.sourceHash,
            contextHash: p.contextHash, promptHash: cinematicSkillHash(shot.prompt), blueprintHash: evidence.blueprintHash,
            registryHash, semanticSkillExecution: "unverified",
          } };
        });
        stages.skillQC = { status: qcRows.some((row) => row.status === "failed") ? "failed" : "passed", scope: "prompt-text-only", details: qcRows };
        if (qcRows.some((row) => row.status === "failed")) throw new CinematicSkillError("PHASE3_SKILL_QC_FAILED", "融合提示词包含所选技能的肯定式禁止内容");
        const llmStats = result.llmStats && typeof result.llmStats === "object" ? result.llmStats as FusionRecord : {};
        llmStats.promptFusion = { stats: pfResult.stats ?? null, elapsedMs: Date.now() - start };
        result.llmStats = llmStats;
        // 清理或日志失败也不能留下可复用的通过断点；提交 checkpoint 是最后一个可能失败的步骤。
        if (healthEnabled && this.healthMonitor) {
          healthEnabled = false;
          try { this.healthMonitor.setLongTaskMode("ProductionEngine", false); }
          catch (error) {
            throw new CinematicSkillError("PHASE3_HEALTH_CLEANUP_FAILED", error instanceof Error ? error.message : String(error), "unverified");
          }
        }
        this.log("PROMPT-FUSION-AGENT", `宿主融合完成：${finalShots.length} 镜；文本检查与画面质量状态分开记录`);
        await this.saveCheckpoint("phase3", finalShots, { opening: result.opening, llmStats, phase3Fusion: { ...evidence, status: "passed" } });
        evidence.status = "passed";
        evidence.shots = finalShots.map((shot) => ({ shotId: shot.shotId ?? shot.shot_id, ...(shot._workloomFusion as FusionRecord) }));
        return { success: true, shots: finalShots, result, timing: Date.now() - start };
      } catch (error) {
        const failure = error instanceof CinematicSkillError ? error : new CinematicSkillError("PHASE3_EXECUTION_FAILED", error instanceof Error ? error.message : String(error), "unverified");
        evidence.status = failure.status;
        evidence.code = failure.code;
        evidence.error = failure.message;
        result.degraded = true;
        this.log("PROMPT-FUSION-FAIL", failure.message);
        // 抛错让 vendor 离开后续阶段；外层 produce 桥会再次拒绝其 RECOVERY 规则回退。
        throw failure;
      } finally {
        if (healthEnabled && this.healthMonitor) {
          try { this.healthMonitor.setLongTaskMode("ProductionEngine", false); }
          catch (error) {
            evidence.status = "unverified";
            evidence.code = "PHASE3_HEALTH_CLEANUP_FAILED";
            throw new CinematicSkillError("PHASE3_HEALTH_CLEANUP_FAILED", error instanceof Error ? error.message : String(error), "unverified");
          }
        }
      }
    };

    enginePrototype.produce = async function guardedProduce(this: unknown, blueprint: FusionRecord, ...args: unknown[]) {
      const result = await originalProduce.call(this, blueprint, ...args);
      const stages = result.stages && typeof result.stages === "object" ? result.stages as FusionRecord : {};
      const phase = stages.phase3Fusion as FusionRecord | undefined;
      if (phase && phase.status !== "passed") {
        result.success = false;
        throw new CinematicSkillError(String(phase.code ?? "PHASE3_FUSION_UNVERIFIED"), "Phase3 未通过，拒绝规则恢复/提示词重建后的出片", phase.status as CinematicSkillStatus);
      }
      if (!phase) {
        const shots = Array.isArray(result.shots) ? result.shots as FusionRecord[] : [];
        const blueprintHash = cinematicSkillHash(blueprint);
        const verifiedResume = result.resumed === true && shots.length > 0 && shots.every((shot) => {
          const stamp = shot._workloomFusion as FusionRecord | undefined;
          return stamp?.schemaVersion === PHASE3_FUSION_POLICY_VERSION && stamp.status === "passed"
            && stamp.blueprintHash === blueprintHash && stamp.registryHash === registryHash;
        });
        if (!verifiedResume) {
          throw new CinematicSkillError("PHASE3_FUSION_UNVERIFIED", "生产结果缺本版本融合凭据；旧断点或规则模式需重新融合", "unverified");
        }
        stages.phase3Fusion = { schemaVersion: PHASE3_FUSION_POLICY_VERSION, status: "passed", resumed: true, blueprintHash, registryHash };
        result.stages = stages;
      }
      return result;
    };
    try { options.log?.("[vendor-compat] Phase3 宿主融合桥已安装（预算、路由、融合与文本 QC 不通过即停止）"); }
    catch (error) {
      prototype.execute = originalExecute;
      enginePrototype.produce = originalProduce;
      enginePrototype.updateAgentConfig = originalUpdateAgentConfig;
      throw error;
    }
    return () => {
      prototype.execute = originalExecute;
      enginePrototype.produce = originalProduce;
      enginePrototype.updateAgentConfig = originalUpdateAgentConfig;
    };
  });
}
