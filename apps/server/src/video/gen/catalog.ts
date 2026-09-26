/**
 * video/gen/catalog.ts —— 媒体模型目录（bundles/ai-video 资产）加载与运行时可用性
 *
 * 目录是"唯一事实源"：模型 id / 供应商映射 / 档位 / 报价 / 参数能力 / 保留期。
 * 运行时可用性 = 目录 availability=wired 且该供应商的密钥已配置（缺密钥一律不列出可选，
 * 而不是选中后失败——避免"看起来能用"的假能力）。
 */
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { MediaCatalog, MediaKind, MediaModel, MediaMode } from "./types.js";
import { whiteboardEngineReady } from "../whiteboard/engine.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** apps/server/src/video/gen → 仓库根（gen→video→src→server→apps→root） */
const REPO_ROOT = join(HERE, "../../../../..");

export function defaultCatalogPath(): string {
  return process.env.WORKLOOM_MEDIA_CATALOG?.trim()
    || join(REPO_ROOT, "bundles/ai-video/library/media-catalog/media-catalog.json");
}

/** 供应商 → 必需环境变量（全有才算 configured） */
export const PROVIDER_ENV: Record<string, readonly string[]> = {
  seedance: ["VOLCENGINE_ARK_API_KEY"],
  seedream: ["VOLCENGINE_ARK_API_KEY"],
  higgsfield: ["HF_API_KEY_ID", "HF_API_KEY_SECRET"],
  kling: ["KLING_API_KEY"],
  jimeng: ["JIMENG_API_KEY"],
  muapi: ["MUAPI_API_KEY"],
  /**
   * 本地白板渲染器（T-2026-0926-0020）没有密钥：可用性 = `WHITEBOARD_ENABLED=1`
   * **且** venv 解释器存在。这里登记环境变量名只是为了让 `validate()` 认可该供应商
   * （`availability=wired` 必须有登记）；真正的判定在 `providerConfigured` 的特判分支。
   */
  "whiteboard-local": ["WHITEBOARD_ENABLED"],
  /**
   * 本机 Remotion 渲染（talkcraft 引擎，T-2026-0926-0008）：同样是"开关型"供应商
   * （无密钥），就绪度由 provider.healthy() 复检（引擎安装完整 + 运行时冒烟 + 许可闸）。
   */
  "remotion-local": ["TALKCRAFT_ENABLED"],
};

export function providerConfigured(provider: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (provider === "whiteboard-local") {
    // 开关型配置："非空即配置"不成立——必须显式置 1 且引擎（venv）真的在
    return (env.WHITEBOARD_ENABLED ?? "0") === "1" && whiteboardEngineReady(env);
  }
  const keys = PROVIDER_ENV[provider];
  if (!keys) return false;
  return keys.every((k) => Boolean(env[k]?.trim()));
}

/** 供应商侧模型 id 的环境覆盖（部署方改了方舟模型/版本时无需改目录） */
const PROVIDER_MODEL_ENV: Record<string, readonly string[]> = {
  seedance: ["SEEDANCE_MODEL", "ARK_VIDEO_MODEL"],
  seedream: ["ARK_IMAGE_MODEL", "SEEDREAM_MODEL"],
};

export function resolveProviderModel(model: MediaModel, env: NodeJS.ProcessEnv = process.env): string {
  for (const key of PROVIDER_MODEL_ENV[model.provider] ?? []) {
    const v = env[key]?.trim();
    if (v) return v;
  }
  return model.providerModel;
}

let cache: { path: string; mtimeMs: number; catalog: MediaCatalog } | null = null;

function validate(catalog: unknown, path: string): MediaCatalog {
  const c = catalog as MediaCatalog;
  if (!c || typeof c !== "object") throw new Error(`媒体目录不可解析：${path}`);
  if (c.schemaVersion !== "workloom.media-catalog/v1") {
    throw new Error(`媒体目录 schemaVersion 不支持：${String(c.schemaVersion)}（期望 workloom.media-catalog/v1）`);
  }
  if (!Array.isArray(c.models) || c.models.length === 0) throw new Error(`媒体目录 models 为空：${path}`);
  const ids = new Set<string>();
  for (const m of c.models) {
    if (!m.id || !m.provider || !m.providerModel || !m.kind) {
      throw new Error(`媒体目录条目缺字段（id/provider/providerModel/kind）：${JSON.stringify(m).slice(0, 120)}`);
    }
    if (ids.has(m.id)) throw new Error(`媒体目录 id 重复：${m.id}`);
    ids.add(m.id);
    if (m.availability === "wired" && !PROVIDER_ENV[m.provider]) {
      throw new Error(`模型 ${m.id} 标记 wired 但供应商 ${m.provider} 无适配器环境变量登记（catalog.ts PROVIDER_ENV）`);
    }
    if (m.pricing && m.pricing.usd !== null && !(typeof m.pricing.usd === "number" && m.pricing.usd >= 0)) {
      throw new Error(`模型 ${m.id} 报价非法：${String(m.pricing.usd)}`);
    }
  }
  return c;
}

export function loadCatalog(path = defaultCatalogPath()): MediaCatalog {
  const st = statSync(path); // 不存在 → 抛错（目录缺失属于装配错误，不静默降级）
  if (cache && cache.path === path && cache.mtimeMs === st.mtimeMs) return cache.catalog;
  const catalog = validate(JSON.parse(readFileSync(path, "utf8")), path);
  cache = { path, mtimeMs: st.mtimeMs, catalog };
  return catalog;
}

export function getModel(modelId: string, path?: string): MediaModel | null {
  return loadCatalog(path).models.find((m) => m.id === modelId) ?? null;
}

/** 按供应商侧模型 id 反查目录条目（轮询回填时按提交留痕还原模型口径） */
export function findModelByProviderModel(
  provider: string,
  providerModel: string,
  env: NodeJS.ProcessEnv = process.env,
  path?: string,
): MediaModel | null {
  return loadCatalog(path).models.find(
    (m) => m.provider === provider && (m.providerModel === providerModel || resolveProviderModel(m, env) === providerModel),
  ) ?? null;
}

export interface ListFilter {
  kind?: MediaKind;
  mode?: MediaMode;
  /** 默认 true：只列运行时可用的模型（wired + 密钥就绪） */
  onlyAvailable?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface ListedModel extends MediaModel {
  /** 运行时解析后的供应商模型 id（环境覆盖后） */
  effectiveProviderModel: string;
  /** 运行时可提交 */
  available: boolean;
  /** 不可用原因（available=false 时） */
  unavailableReason?: string;
}

export function listModels(filter: ListFilter = {}, path?: string): ListedModel[] {
  const env = filter.env ?? process.env;
  const onlyAvailable = filter.onlyAvailable ?? true;
  return loadCatalog(path).models
    .filter((m) => (filter.kind ? m.kind === filter.kind : true))
    .filter((m) => (filter.mode ? m.modes.includes(filter.mode) : true))
    .map((m) => {
      const available = m.availability === "wired" && providerConfigured(m.provider, env);
      const reason = m.availability !== "wired"
        ? "目录登记模型（未接入适配器）"
        : available ? undefined
          /**
           * 不可用原因要**说人话**：白板引擎不是"缺密钥"，而是"开关没开"或"venv 没装"。
           * 真机踩过：错误提示写"未配置密钥 WHITEBOARD_ENABLED"会把人带去配密钥，
           * 而实际要做的是跑安装器 + 置 1。
           */
          : m.provider === "whiteboard-local"
            ? `本地白板引擎未就绪：需 WHITEBOARD_ENABLED=1 且 venv 已安装（pnpm exec tsx scripts/tools/whiteboard-env-install.mts）`
            : `供应商 ${m.provider} 未配置密钥（${(PROVIDER_ENV[m.provider] ?? []).join("+")}）`;
      return { ...m, effectiveProviderModel: resolveProviderModel(m, env), available, unavailableReason: reason };
    })
    .filter((m) => (onlyAvailable ? m.available : true));
}

/** 同档位备援模型（降级链）：同 kind、有模式交集、wired+configured、不同供应商，按档位顺序取 */
export function findFallbackModels(
  primary: MediaModel,
  limit = 2,
  env: NodeJS.ProcessEnv = process.env,
  path?: string,
): ListedModel[] {
  const tierOrder: Record<string, number> = { L1: 1, L2: 2, L3: 3 };
  const primaryTier = tierOrder[primary.tier] ?? 2;
  return listModels({ kind: primary.kind, onlyAvailable: true, env }, path)
    .filter((m) => m.id !== primary.id && m.provider !== primary.provider)
    .filter((m) => m.modes.some((mode) => primary.modes.includes(mode)))
    .filter((m) => (tierOrder[m.tier] ?? 2) <= primaryTier)
    .sort((a, b) => (tierOrder[b.tier] ?? 2) - (tierOrder[a.tier] ?? 2))
    .slice(0, limit);
}

/**
 * 默认视频模型：`WORKLOOM_VIDEO_DEFAULT_MODEL` 优先；否则取目录中首个可用视频模型
 * （按档位 L1→L2→L3 排序，默认走低成本档；显式选模型时不受此影响）。
 */
export function defaultVideoModelId(env: NodeJS.ProcessEnv = process.env, path?: string): string {
  const preferred = env.WORKLOOM_VIDEO_DEFAULT_MODEL?.trim();
  if (preferred) return preferred;
  const tierOrder: Record<string, number> = { L1: 1, L2: 2, L3: 3 };
  // 排除本机合成渲染档（render）：它没有"一句话生成"语义，不能被当成默认文生视频模型
  const list = listModels({ kind: "video", onlyAvailable: true, env }, path)
    .filter((m) => m.modes.some((mode) => mode !== "render"))
    .sort((a, b) => (tierOrder[a.tier] ?? 2) - (tierOrder[b.tier] ?? 2));
  const chosen = list[0];
  if (!chosen) {
    throw new Error("没有可用的视频生成模型：请配置供应商密钥（VOLCENGINE_ARK_API_KEY / HF_API_KEY_ID+HF_API_KEY_SECRET）");
  }
  return chosen.id;
}
