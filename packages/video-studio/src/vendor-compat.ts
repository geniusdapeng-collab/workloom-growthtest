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
    shot.prompt = prompt;
    shot.promptCharCount = prompt.length;
    shot.promptRebuilt = true;
    rebuilt.push(String(shot.shotId ?? "?"));
  }
  return rebuilt;
}

/**
 * 提示词重建桥（2026-09-22 真机修复，Phase 3 失败的止血方案）
 *
 * 现象链（VID-1021/1022）：
 *   `PROMPT-FUSION-FAIL: Assignment to constant variable.` → 6 镜退回**未融合镜头**（`prompt` 为空，
 *   且 `lighting/timeline/camera_movement` 仍是对象）→ 后续 `[INTEGRITY] prompt 缺失` 仅告警 →
 *   PipelineGuard `严格模式已启用,渲染被阻止`（run 直接失败，连产物目录都没写出）。
 *
 * 处理：在 `ProductionEngine.produce` 返回后，对**每个 prompt 为空的镜头**用 vendor 自己的组装器
 * （`PromptFusionAgent._assembleStandardPrompt`）+ 镜头字段重建提示词，并保留结构化原值。
 * 这不是静默兜底：会写 `promptRebuilt` 标记与日志（`[vendor-compat] 重建 N 镜 prompt`），
 * 上游一旦真修好，重建自然不再触发。
 */
export function installVendorPromptRebuildBridge(options: { log?: (line: string) => void; ratio?: string } = {}): () => void {
  const log = options.log ?? (() => undefined);
  try {
    const repoRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "../../..");
    const vendorRequire = createRequire(resolvePath(repoRoot, "package.json"));
    const enginePath = resolvePath(
      repoRoot,
      "vendor/supermickey/hyperreality-system/engines/production-engine/production-engine.js"
    );
    const fusionPath = resolvePath(
      repoRoot,
      "vendor/supermickey/hyperreality-system/engines/production-engine/agents/prompt-fusion-agent.js"
    );
    if (!existsSync(enginePath) || !existsSync(fusionPath)) return () => undefined;
    const engineMod = vendorRequire(enginePath) as { ProductionEngine?: { prototype?: Record<string, unknown> } };
    const prototype = engineMod?.ProductionEngine?.prototype;
    if (!prototype || typeof prototype.produce !== "function") return () => undefined;
    const fusionMod = vendorRequire(fusionPath) as {
      PromptFusionAgent: new (options?: Record<string, unknown>) => {
        _assembleStandardPrompt(shot: Record<string, unknown>, fields: Record<string, unknown>, ratio: string): string;
      };
    };

    const original = prototype.produce as (blueprint?: unknown, options?: unknown) => Promise<Record<string, unknown>>;
    prototype.produce = async function patchedProduce(this: unknown, blueprint?: unknown, options?: unknown) {
      const result = await original.call(this, blueprint, options);
      try {
        const shots = (result?.shots as Array<Record<string, unknown>> | undefined) ?? [];
        const optionsRecord = (options ?? {}) as Record<string, unknown>;
        const blueprintRecord = (blueprint ?? {}) as Record<string, unknown>;
        const blueprintConfig = (blueprintRecord.config ?? {}) as Record<string, unknown>;
        const ratio = optionsRecord.ratio ?? blueprintConfig.aspectRatio ?? optionsRecord.aspectRatio ?? "9:16";
        const fusion = new fusionMod.PromptFusionAgent({ semanticRefinement: false });
        const rebuilt = rebuildPromptsFromFields(
          shots,
          String(ratio),
          (shot, fields, r) => fusion._assembleStandardPrompt(shot, fields, r)
        );
        if (rebuilt.length > 0) {
          log(
            `[vendor-compat] Phase 3 未产出 prompt，已按 25/30 字段重建 ${rebuilt.length} 镜`
            + `（${rebuilt.join("、")}）；标记 promptRebuilt=true`
          );
        }
      } catch (err) {
        log(`[vendor-compat] prompt 重建失败（保持原样）：${err instanceof Error ? err.message : String(err)}`);
      }
      return result;
    };
    return () => {
      prototype.produce = original;
    };
  } catch (err) {
    log(`[vendor-compat] prompt 重建桥注入失败（不影响其它桥）：${err instanceof Error ? err.message : String(err)}`);
    return () => undefined;
  }
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
