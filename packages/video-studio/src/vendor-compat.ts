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
  if (!Number.isInteger(maxPerShot) || maxPerShot < 1) throw new Error("PORTRAIT_BINDING_INVALID: 每镜角色上限无效");
  type Engine = { config?: { charactersDir?: string } };
  type BoundEntry = { id: string; name: string; requiredAngles: readonly string[]; portraits: Record<string, string>; evidence: Record<string, unknown> };
  const boundSnapshots = new WeakMap<RenderPromptLike, string>();
  const inside = (root: string, file: string): boolean => { const rel = relative(root, file); return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
  function currentIndex(): PortraitIndex | null {
    const value = options.resolveIndex ? options.resolveIndex() : options.index ?? null;
    if (value && (value.schemaVersion !== "workloom.portrait-index/v1" || !isPlainObject(value.characters))) throw new Error("PORTRAIT_BINDING_INVALID: 角色索引无效");
    return value ? structuredClone(value) : null;
  }
  /** Read only the indexed files; directory order and historical filenames cannot select a version. */
  function exactEntry(engine: Engine, key: string, entry: PortraitIndexEntry): BoundEntry {
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

  function bindPrompt(engine: Engine, prompt: RenderPromptLike): BoundEntry[] {
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

    prototype.render = function patchedRender(this: Engine, prompts: unknown, opts?: unknown) {
      const list = Array.isArray(prompts) ? (prompts as RenderPromptLike[]) : [];
      let bound = 0;
      for (const prompt of list) {
        bindPrompt(this, prompt);
        if (prompt._workloomBoundCharacters?.length) bound += 1;
      }
      if (bound > 0) {
        log(`[vendor-compat] 定妆照绑定桥：${bound}/${list.length} 个镜头已绑定角色定妆照（每镜 ≤${maxPerShot} 角色）`);
      }
      return originalRender.call(this, prompts, opts);
    };

    prototype._generateBindingManifest = async function patchedManifest(this: Engine, prompts: RenderPromptLike[]) {
      const characters: Record<string, BoundEntry> = {}; const shots: Record<string, unknown>[] = [];
      const shotIds = new Set<string>();
      for (const prompt of prompts) {
        if (!prompt.shotId || shotIds.has(prompt.shotId)) throw new Error("PORTRAIT_BINDING_INVALID: 镜头ID缺失或重复");
        shotIds.add(prompt.shotId);
        const entries = bindPrompt(this, prompt);
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
      if (manifest.schemaVersion !== "workloom.portrait-binding/v2") throw new Error("PORTRAIT_BINDING_INVALID: 提交体必须使用本次精确文件清单");
      if (manifest.bindingHash !== cinematicSkillHash({ characters: manifest.characters, shots: manifest.shots })) throw new Error("PORTRAIT_BINDING_CHANGED: 清单内容被改写");
      const characters = manifest.characters as Record<string, BoundEntry>;
      const index = currentIndex(); const expected: Array<{ sha256: string; bytes: number }> = [];
      for (const key of this.extractCharactersFromShot(shot)) {
        const entry = index?.characters[key];
        if (!entry || !characters[key]) throw new Error("PORTRAIT_BINDING_INVALID: 提交角色缺少当前索引或清单");
        const current = exactEntry({ config: { charactersDir: this.charactersDir } }, key, entry);
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
        const boundKeys = Array.isArray(prompt?._workloomBoundCharacters) ? prompt._workloomBoundCharacters : [];
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
    const repoRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "../../..");
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
        return originalRunAll.call(this, (shots ?? []).map((shot) => normalizeShot(shot)));
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
    const repoRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "../../..");
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
    const repoRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "../../..");
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
    const repoRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "../../..");
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
    const repoRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "../../..");
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
    const repoRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "../../..");
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
  const repoRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "../../..");
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
  const minShot = options.minShotSeconds ?? 4;
  const maxShot = options.maxShotSeconds ?? 30;
  const repoRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "../../..");
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
    const inputs = records.map((record, index) => ({
      shotId: idOf(record, `${kindLabel}-${index + 1}`),
      duration: durationOf(record),
      timing: record.timing as { start?: number; duration?: number; end?: number } | undefined,
      dialogue: record.dialogue,
      emotion: (record.emotion as string | undefined) ?? (record.mood as string | undefined),
      mood: record.mood as string | undefined,
      sceneType: (record.sceneType ?? record.scene_type) as string | undefined,
    }));
    const projectOnce = (enforceVoiceFloor: boolean) =>
      projectShotDurations(inputs, {
        targetSeconds: Number(targetSeconds),
        minSeconds: minShot,
        maxSeconds: maxShot,
        enforceVoiceFloor,
      });
    let result = projectOnce(true);
    if (!result.ok && planningMode) {
      // 规划阶段：台词尚未精简，硬下限常不可满足——先保守恒与能力区间，交由执行阶段强制下限
      emit({
        kind: "infeasible",
        source,
        targetSeconds: Number(targetSeconds),
        totalSeconds: records.reduce((sum, record) => sum + durationOf(record), 0),
        shots: result.entries.map((entry) => ({ ...entry })),
        message: `规划阶段台词硬下限暂不可满足（${result.reason}）：${result.suggestions.join("；")}；已按能力区间投影，交由台词修复阶段强制`,
      });
      result = projectOnce(false);
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
        projectRecords(scenes, target, "dcm.constrain", "SC");
        const ensure = prototype._ensureSequentialTiming as ((this: unknown, list: Recordish[]) => void) | undefined;
        if (typeof ensure === "function") ensure.call(this, scenes);
        return { scenes, adjustments: [], valid: true };
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
      projectRecords(after, Number.isFinite(target) && target > 0 ? target : null, "phase-3", "S");
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
];

function fusionRecord(value: unknown, label: string): FusionRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CinematicSkillError("PHASE3_CONTRACT_INVALID", `${label} 必须为对象`, "unverified");
  }
  return value as FusionRecord;
}

/**
 * 每次执行独立的 agent 视图，避免并发 run 互改 deadline/retries/子服务回调。
 * 在真正 reasonStructured 调用前再检查预算，封住 BaseAgent 剩余时间保底 10s 的漏洞。
 */
function scopedFusionAgent(agent: FusionAgent, remaining: () => number, deadline: number): FusionAgent {
  const scoped = Object.create(agent) as FusionAgent;
  scoped._globalDeadline = deadline;
  scoped._remainingMs = remaining;
  scoped._callBudget = new Map(agent._callBudget instanceof Map ? agent._callBudget : []);
  const guardEngine = (engine: FusionRecord | null): FusionRecord | null => {
    if (!engine || typeof engine.reasonStructured !== "function") return engine;
    const guarded = Object.create(engine) as FusionRecord;
    guarded.reasonStructured = async (prompt: unknown, schema: unknown, options: FusionRecord = {}) => {
      const budget = remaining();
      if (budget < 5000) throw new CinematicSkillError("PHASE3_BUDGET_EXHAUSTED", "提供商调用前剩余预算不足 5 秒");
      const timeout = Number(options.timeoutMs ?? budget);
      return (engine.reasonStructured as (...args: unknown[]) => Promise<unknown>).call(engine, prompt, schema, {
        ...options, timeoutMs: Math.min(Number.isFinite(timeout) && timeout > 0 ? timeout : budget, budget),
        deadlineMs: deadline,
      });
    };
    return guarded;
  };
  const originalCall = agent._callLLM;
  if (typeof originalCall === "function") {
    scoped._callLLM = async (...args: unknown[]) => {
      const budget = remaining();
      if (budget < 5000) throw new CinematicSkillError("PHASE3_BUDGET_EXHAUSTED", "LLM 调用前剩余预算不足 5 秒");
      const opts = args[3] && typeof args[3] === "object" ? args[3] as FusionRecord : {};
      const requested = Number(opts.timeoutMs ?? scoped.llmTimeout ?? budget);
      args[3] = {
        ...opts, timeoutMs: Math.min(Number.isFinite(requested) && requested > 0 ? requested : budget, budget), shotBudget: budget,
        ...(opts.altModel && typeof opts.altModel === "object" ? { altModel: guardEngine(opts.altModel as FusionRecord) } : {}),
      };
      const response = await originalCall.apply(scoped, args);
      if (remaining() <= 0) throw new CinematicSkillError("PHASE3_BUDGET_EXHAUSTED", "LLM 返回时阶段预算已耗尽");
      return response;
    };
  }
  for (const getter of ["_getLLMEngine", "_getAltLLMEngine"] as const) {
    const originalEngine = agent[getter];
    if (typeof originalEngine === "function") scoped[getter] = () => guardEngine(originalEngine.call(scoped));
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
    const repoRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "../../..");
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
        const initialBudget = this.budgetRemaining();
        if (!Number.isFinite(initialBudget) || initialBudget <= 0) throw new CinematicSkillError("PHASE3_BUDGET_UNVERIFIED", "缺少有限且有效的阶段剩余预算", "unverified");
        // 入场保留每镜一次最小可用 LLM 时间；实际每次外调再按剩余额度硬裁剪，不虚构重试预算。
        const minimumNeedMs = shots.length * 5000 + 1000;
        if (initialBudget < minimumNeedMs || !this.checkBudget(minimumNeedMs, "Phase 3")) {
          throw new CinematicSkillError("PHASE3_BUDGET_EXHAUSTED", `剩余 ${initialBudget}ms 不能承担最低 ${minimumNeedMs}ms`);
        }
        const agentDeadline = Number(agent._globalDeadline);
        const deadline = Math.min(start + initialBudget, Number.isFinite(agentDeadline) && agentDeadline > 0 ? agentDeadline : Infinity);
        const remaining = (): number => {
          const currentBudget = this.budgetRemaining();
          if (!Number.isFinite(currentBudget)) {
            throw new CinematicSkillError("PHASE3_BUDGET_UNVERIFIED", "阶段剩余预算在运行中变为未知，停止外部调用", "unverified");
          }
          return Math.max(0, Math.min(deadline - Date.now(), currentBudget));
        };
        const requireBudget = () => {
          if (remaining() < 5000) throw new CinematicSkillError("PHASE3_BUDGET_EXHAUSTED", "阶段剩余预算不足，停止新外部调用");
        };
        requireBudget();
        evidence.budget = { initialMs: initialBudget, minimumNeedMs, deadline };
        evidence.blueprintHash = cinematicSkillHash(blueprint);
        const scoped = scopedFusionAgent(agent, remaining, deadline);
        if (this.healthMonitor) {
          this.healthMonitor.setLongTaskMode("ProductionEngine", true, remaining());
          healthEnabled = true;
        }
        const plan = await planCinematicSkills(shots, blueprint, router, {
          registryHash, beforeExternalCall: requireBudget,
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
        requireBudget();
        const blueprintHash = cinematicSkillHash({ policy: PHASE3_FUSION_POLICY_VERSION, blueprint, registryHash, shots });
        const pfResult = await scoped.process(this.cloneShots(shots), blueprint, { checkpointManager: this.checkpointManager, blueprintHash });
        if (remaining() <= 0) throw new CinematicSkillError("PHASE3_BUDGET_EXHAUSTED", "融合返回时阶段预算已耗尽");
        const updated = pfResult.shots;
        if (!Array.isArray(updated) || updated.length !== shots.length || pfResult.degraded === true || Number((pfResult.stats as FusionRecord | undefined)?.failed ?? 0) > 0) {
          throw new CinematicSkillError("PHASE3_FUSION_UNVERIFIED", "融合返回缺镜头或包含降级/失败，不接受规则兜底", "unverified");
        }
        const expectedIds = new Set(shots.map((shot) => String(shot.shotId ?? shot.shot_id)));
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
        if (remaining() <= 0) throw new CinematicSkillError("PHASE3_BUDGET_EXHAUSTED", "台词检查后阶段预算已耗尽");
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
      throw error;
    }
    return () => {
      prototype.execute = originalExecute;
      enginePrototype.produce = originalProduce;
    };
  });
}
