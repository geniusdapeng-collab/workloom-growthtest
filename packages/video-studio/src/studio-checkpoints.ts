import { createHash } from "node:crypto";

export const STUDIO_ENGINE_CHECKPOINT_SCHEMA = "workloom.studio-engine-checkpoint/v1" as const;
export type StudioEngineCheckpointStage = "G2_THEME" | "G3_INSIGHT" | "G3_PROFILE" | "G4_PRD" | "SCRIPT" | "PRODUCTION" | "OPENING_TITLE";

/** Bump only the changed station's semantic contract; dependency hashes invalidate its descendants. */
const STUDIO_STAGE_POLICY_VERSION: Record<StudioEngineCheckpointStage, string> = {
  G2_THEME: "theme-input-and-brief/v1",
  G3_INSIGHT: "source-bound-discovery-and-assumptions/v2",
  G3_PROFILE: "native-source-aware-production-profile/v2",
  G4_PRD: "source-bound-prd-native-local-contract/v3",
  SCRIPT: "native-script-and-metadata/v1",
  PRODUCTION: "native-production-camera-repair-feedback/v13",
  OPENING_TITLE: "native-opening-title-fields/v2",
};

export interface StudioCheckpointRequest {
  schemaVersion: typeof STUDIO_ENGINE_CHECKPOINT_SCHEMA;
  stage: StudioEngineCheckpointStage;
  inputSha256: string;
  dependencySha256: string;
}

export interface StudioEngineCheckpoint extends StudioCheckpointRequest {
  output: unknown;
  outputSha256: string;
}

/** The host verifies scope, frozen intent, policy, source freshness and original approval before load. */
export interface StudioCheckpointAdapter {
  load(request: StudioCheckpointRequest): Promise<StudioEngineCheckpoint | null>;
  save(checkpoint: StudioEngineCheckpoint): Promise<void>;
}

export class StudioCheckpointError extends Error {
  constructor(readonly code: "STUDIO_CHECKPOINT_INVALID" | "STUDIO_CHECKPOINT_WRITE_UNVERIFIED", message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = "StudioCheckpointError";
  }
}

/** Clone first so vendor data classes cannot turn their checkpoint into a JSON string via toJSON(). */
export function studioCheckpointJson(value: unknown): string {
  const plain = structuredClone(value);
  const text = JSON.stringify(plain, (_key, item: unknown) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
        throw new StudioCheckpointError("STUDIO_CHECKPOINT_INVALID", "工位断点含不能完整回放的数据类型");
      }
      return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
    }
    if (typeof item === "number" && !Number.isFinite(item)) {
      throw new StudioCheckpointError("STUDIO_CHECKPOINT_INVALID", "工位断点含非有限数值");
    }
    return item;
  });
  if (text === undefined) throw new StudioCheckpointError("STUDIO_CHECKPOINT_INVALID", "工位断点没有可回放的 JSON 数据");
  return text;
}

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => Boolean(value && typeof value === "object" && !Array.isArray(value));

/**
 * Install outside the PRODUCTION checkpoint wrapper so its input hash includes
 * the private, host-verified diagnosis. Upstream metadata and seed stay intact.
 */
export function bindStudioProductionRepairFeedback(system: RecordValue, feedback: string): void {
  if (typeof feedback !== "string" || !feedback.trim()) {
    throw new StudioCheckpointError("STUDIO_CHECKPOINT_INVALID", "生产修复诊断必须是宿主核实的完整非空文本");
  }
  const production = system.productionEngine;
  if (!record(production) || typeof production.produce !== "function") {
    throw new StudioCheckpointError("STUDIO_CHECKPOINT_INVALID", "PRODUCTION 原生作者不可读取");
  }
  const original = production.produce as (...args: unknown[]) => Promise<unknown>;
  const clearPrivateContext = (value: unknown, seen = new WeakSet<object>()): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    delete (value as RecordValue)._workloomProductionRepairFeedback;
    for (const child of Object.values(value)) clearPrivateContext(child, seen);
  };
  production.produce = async function diagnosedNativeProduction(this: RecordValue, ...args: unknown[]) {
    const blueprint = args[0];
    if (!record(blueprint)) throw new StudioCheckpointError("STUDIO_CHECKPOINT_INVALID", "生产修复缺少原生蓝图");
    const field = "_workloomProductionRepairFeedback";
    const prior = Object.getOwnPropertyDescriptor(blueprint, field);
    Object.defineProperty(blueprint, field, { value: feedback, enumerable: true, writable: true, configurable: true });
    try {
      const output = await original.apply(this, args);
      // Replayed native rows can hold detached blueprint copies. Clear the
      // private context there too so downstream fingerprints match fresh work.
      clearPrivateContext(output);
      return output;
    }
    finally {
      if (prior) Object.defineProperty(blueprint, field, prior);
      else delete blueprint[field];
    }
  };
}

/** Preserve aliases held by the native run report, including its existing prompts array and shot rows. */
function replayInPlace(destination: RecordValue | unknown[], source: RecordValue | unknown[]): void {
  for (const key of Object.keys(destination)) {
    if (!Object.hasOwn(source, key)) delete (destination as RecordValue)[key];
  }
  for (const [key, value] of Object.entries(source)) {
    const current = (destination as RecordValue)[key];
    if (Array.isArray(current) && Array.isArray(value) || record(current) && record(value)) {
      replayInPlace(current as RecordValue | unknown[], value as RecordValue | unknown[]);
    } else {
      Object.defineProperty(destination, key, { value, writable: true, enumerable: true, configurable: true });
    }
  }
  if (Array.isArray(destination) && Array.isArray(source)) destination.length = source.length;
}

/** Only these runtime report fields are excluded. Actual content and asset paths remain fingerprinted. */
export function studioCheckpointInput(stage: StudioEngineCheckpointStage, args: readonly unknown[]): unknown {
  const values = plainCheckpointValue(args) as unknown[];
  if (stage === "SCRIPT" && record(values[1])) {
    const metadata = values[1];
    const dossier = record(metadata._dataDossier) ? metadata._dataDossier : null;
    if (dossier) {
      delete dossier.trace_id;
      delete dossier.saved;
      delete dossier.envelopes;
      delete dossier.chain;
      const cards = record(dossier.cards) ? dossier.cards : null;
      const manifest = cards && record(cards.portrait_manifest) ? cards.portrait_manifest : null;
      if (manifest && Array.isArray(manifest.reference_images)) {
        // Reassembly timestamps are runtime context; asset identity and permissions stay fingerprinted.
        for (const image of manifest.reference_images) if (record(image)) delete image.fetched_at;
      }
    }
  }
  if (stage === "PRODUCTION" && record(values[1])) {
    const configuration = values[1];
    delete configuration.totalDeadlineMs;
  }
  if (stage === "OPENING_TITLE") {
    const result = record(values[1]) ? values[1] : {};
    const stages = record(result.stages) ? result.stages : {};
    const metadata = record(values[2]) ? values[2] : {};
    // _optimizeOpeningTitle reads only these fields from the run report and metadata.
    // Approval wait times, current run IDs and stage timings are execution reports, not title input.
    values[1] = { title: result.title ?? null, adapter: stages.adapter ?? null };
    values[2] = { title: metadata.title ?? null, type: metadata.type ?? null,
      target_audience: metadata.target_audience ?? null, _creativeTheme: metadata._creativeTheme ?? null };
  }
  return values;
}

/**
 * Native engines stay in charge of generation and gate rendering. The host supplies authenticated storage.
 * Returning a checkpoint only replaces an engine call. It never approves a gate.
 */
export function bindStudioEngineCheckpoints(
  system: RecordValue,
  adapter: StudioCheckpointAdapter,
  seed: unknown,
  options: {
    assertActive(): void;
    onFailure(error: unknown): void;
    restoreDiscovery?: (output: RecordValue) => RecordValue;
  },
): void {
  const runner = createStudioCheckpointRunner(adapter, seed);
  const methods = [
    ["creativeThemeGenerator", "generate", "G2_THEME"],
    ["requirementDiscoveryEngine", "discover", "G3_INSIGHT"],
    [null, "_convertDiscoveryToRequirementList", "G3_PROFILE"],
    ["prdGenerator", "generate", "G4_PRD"],
    ["scriptEngine", "process", "SCRIPT"],
    ["productionEngine", "produce", "PRODUCTION"],
    [null, "_optimizeOpeningTitle", "OPENING_TITLE"],
  ] as const;
  for (const [property, method, stage] of methods) {
    const target = property === null ? system : system[property];
    if ((stage === "G3_PROFILE" || stage === "OPENING_TITLE") && (!record(target) || typeof target[method] !== "function")) continue;
    if (!record(target) || typeof target[method] !== "function") {
      throw new StudioCheckpointError("STUDIO_CHECKPOINT_INVALID", `${stage} 原生工位不可读取`);
    }
    const original = target[method] as (...args: unknown[]) => Promise<unknown>;
    target[method] = async function checkpointedNativeEngine(this: RecordValue, ...args: unknown[]) {
      try {
        options.assertActive();
        let reused = false;
        const output = await runner.run(stage, studioCheckpointInput(stage, args), async () => {
          const result = await original.apply(this, args);
          options.assertActive();
          if (stage === "OPENING_TITLE") return { productionAfter: plainCheckpointValue(args[0]) };
          if (!record(result) || result.success === false || result.degraded === true) {
            const stages = record(result) && record(result.stages) ? result.stages : null;
            const coherence = stages && record(stages.cameraCoherence) ? stages.cameraCoherence : null;
            const critical = coherence && Array.isArray(coherence.issues)
              ? coherence.issues.filter((issue): issue is RecordValue => record(issue) && issue.severity === "critical") : [];
            const diagnosis = critical.map(issue => JSON.stringify({ rule: issue.rule, shots: issue.shots,
              message: issue.message, rewrite_hint: issue.rewrite_hint })).join("；");
            throw new StudioCheckpointError("STUDIO_CHECKPOINT_INVALID",
              `${stage} 未完成有效原生产物${diagnosis ? `；运镜诊断：${diagnosis}` : ""}`);
          }
          if (stage === "G3_PROFILE") return { result, discoveryAfter: plainCheckpointValue(args[0]) };
          if (stage === "SCRIPT") return { result, metadataAfter: plainCheckpointValue(args[1]) };
          if (stage === "PRODUCTION") return { result, blueprintAfter: plainCheckpointValue(args[0]) };
          return result;
        }, value => {
          reused = true;
          if (!record(value)) throw new StudioCheckpointError("STUDIO_CHECKPOINT_INVALID", `${stage} 断点缺少工位产物`);
          return stage === "G3_INSIGHT" && options.restoreDiscovery ? options.restoreDiscovery(value) : value;
        });
        if (stage === "OPENING_TITLE") {
          const destination = args[0];
          if (!record(output) || !record(output.productionAfter) || !record(destination)) {
            throw new StudioCheckpointError("STUDIO_CHECKPOINT_INVALID", "OPENING_TITLE 缺少可回放的片头字段");
          }
          if (reused) {
            replayInPlace(destination, output.productionAfter);
          }
          return undefined;
        }
        if (stage === "G3_PROFILE" || stage === "SCRIPT" || stage === "PRODUCTION") {
          const field = stage === "G3_PROFILE" ? "discoveryAfter" : stage === "SCRIPT" ? "metadataAfter" : "blueprintAfter";
          const destination = args[stage === "SCRIPT" ? 1 : 0];
          if (!record(output) || !record(output.result) || !record(output[field]) || !record(destination)) {
            throw new StudioCheckpointError("STUDIO_CHECKPOINT_INVALID", `${stage} 缺少可回放的上下文变更`);
          }
          if (reused) {
            const restored = stage === "G3_PROFILE" && options.restoreDiscovery
              ? options.restoreDiscovery(output[field]) : output[field];
            for (const key of Object.keys(destination)) delete destination[key];
            Object.assign(destination, restored);
          }
          return output.result;
        }
        return output;
      } catch (error) {
        options.onFailure(error);
        throw error;
      }
    };
  }
  const discovery = system.requirementDiscoveryEngine;
  if (record(discovery) && typeof discovery.generateMarkdown === "function") {
    const original = discovery.generateMarkdown as (output: RecordValue) => string;
    discovery.generateMarkdown = function stableDiscoveryMarkdown(this: RecordValue, output: RecordValue) {
      try {
        options.assertActive();
        const timestamp = record(output.confirmationStatus) ? output.confirmationStatus.timestamp : null;
        if (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp))) {
          throw new StudioCheckpointError("STUDIO_CHECKPOINT_INVALID", "G3 缺少原生产物的生成时间");
        }
        // Keep the original complete gate document byte-stable when replaying the same discovery.
        return original.call(this, output).replace(/^(> 生成时间: )[^\r\n]*$/mu, (_line, prefix: string) => `${prefix}${timestamp}`);
      } catch (error) {
        options.onFailure(error);
        throw error;
      }
    };
  }
}

export function studioCheckpointHash(value: unknown): string {
  return createHash("sha256").update(studioCheckpointJson(value)).digest("hex");
}

function plainCheckpointValue(value: unknown): unknown {
  const plain = structuredClone(value);
  // Canonical order belongs to fingerprints. Replay retains native insertion order because
  // native gate renderers and model prompts may stringify nested source objects verbatim.
  studioCheckpointJson(plain);
  return JSON.parse(JSON.stringify(plain)) as unknown;
}

export function createStudioCheckpointRunner(adapter: StudioCheckpointAdapter, seed: unknown) {
  let dependencySha256 = studioCheckpointHash(seed);
  return {
    async run<T>(
      stage: StudioEngineCheckpointStage,
      input: unknown,
      execute: () => Promise<T>,
      restore?: (output: T) => T,
    ): Promise<T> {
      const request: StudioCheckpointRequest = {
        schemaVersion: STUDIO_ENGINE_CHECKPOINT_SCHEMA,
        stage,
        inputSha256: studioCheckpointHash({ policyVersion: STUDIO_STAGE_POLICY_VERSION[stage], input }),
        dependencySha256,
      };
      const saved = await adapter.load(request);
      let output: T;
      let outputSha256: string;
      if (saved) {
        if (saved.schemaVersion !== request.schemaVersion || saved.stage !== stage
          || saved.inputSha256 !== request.inputSha256 || saved.dependencySha256 !== request.dependencySha256
          || !/^[a-f0-9]{64}$/u.test(saved.outputSha256) || studioCheckpointHash(saved.output) !== saved.outputSha256) {
          throw new StudioCheckpointError("STUDIO_CHECKPOINT_INVALID", `${stage} 的断点身份、依赖或产物摘要不一致`);
        }
        output = plainCheckpointValue(saved.output) as T;
        outputSha256 = saved.outputSha256;
        if (restore) output = restore(output);
      } else {
        output = await execute();
        const plainOutput = plainCheckpointValue(output);
        outputSha256 = studioCheckpointHash(plainOutput);
        try { await adapter.save({ ...request, output: plainOutput, outputSha256 }); }
        catch (error) {
          throw new StudioCheckpointError("STUDIO_CHECKPOINT_WRITE_UNVERIFIED",
            `${stage} 已执行但断点回执未完成，须核对原运行后再恢复`, { cause: error });
        }
      }
      dependencySha256 = studioCheckpointHash({ previous: dependencySha256, stage,
        inputSha256: request.inputSha256, outputSha256 });
      return output;
    },
  };
}
