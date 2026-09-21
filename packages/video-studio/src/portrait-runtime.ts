/**
 * portrait-runtime.ts —— 定妆照真实出图运行时（vendor PortraitStudio 的 api 后端实现）
 *
 * 背景（2026-09-21 真机）：vendor 的定妆照阶段默认跑 `mode=interactive` + `executor=spec`：
 * 只产出"生成规格包"，17 张定妆照全部 pending → 角色绑定清单为空 → 渲染门
 * `BINDING_MANIFEST_INVALID` 直接拒片。产品口径是「全自动预生产」，定妆照必须真出图。
 *
 * 本模块把 PortraitStudio 的 `runtime` 三件事补齐（vendor 只读，运行期注入）：
 *   - apiRender(task, baseImage?)  逐张真实出图（火山方舟 Seedream，同步返回 URL），
 *                                  落盘到 `<workDir>/characters/<projectId>/<key>/portraits/<key>-<angle>.png`
 *   - searchReferences(stage)      情报档案预填参考图（prefilled：免外部检索）
 *   - processImage(stage, images)  参考图标准化（本机为直通锚点：复制真实参考图作基准图，不做抠图）
 *
 * 命名口径与 vendor 渲染核心对齐（scripts/render-submitter-core.js 的 REQUIRED_ANGLES
 * `front / threeQuarter / closeup / side`）：角度 id 走 ANGLE_FILE_ALIASES 归一，
 * 使绑定清单能直接扫到 `<key>-front.png` 这类文件。
 *
 * 幂等：同一 (角色, 角度) 文件已存在且非空即复用，不重复烧额度（重跑安全）。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/** vendor → 渲染核心要求的四个角度文件名（REQUIRED_ANGLES 口径） */
const ANGLE_FILE_ALIASES: Record<string, string> = {
  front_full: "front",
  side_full: "side",
  three_quarter: "threeQuarter",
  face_closeup: "closeup",
  back_full: "back",
  action_pose: "actionPose",
  emotion_closeup: "emotionCloseup",
  hand_detail: "handDetail"
};

/** 渲染核心要求的四角度（缺一即 BINDING_MANIFEST_INVALID） */
export const REQUIRED_ANGLES = ["front", "threeQuarter", "closeup", "side"] as const;

/** vendor 传给 apiRender 的任务形状（角色与商品两个分支的并集） */
export interface PortraitTask {
  portraitId?: string;
  characterId?: string;
  characterName?: string;
  productId?: string;
  productName?: string;
  angle?: string;
  view?: string;
  prompt?: string;
  [key: string]: unknown;
}

export interface PortraitIndexEntry {
  kind: "character" | "product";
  id: string;
  name: string;
  dir: string;
  /** 角度/视角 → 落盘绝对路径 */
  files: Record<string, string>;
}

export interface PortraitIndex {
  schemaVersion: "workloom.portrait-index/v1";
  projectId: string;
  generatedAt: string;
  characters: Record<string, PortraitIndexEntry>;
  products: Record<string, PortraitIndexEntry>;
}

export interface PortraitRuntimeOptions {
  /** 运行产物根（与 vendor 的 charactersDir 同一口径），默认 .vm-work */
  workDir: string;
  projectId: string;
  /** 火山方舟密钥（ARK_API_KEY / VOLCENGINE_ARK_API_KEY） */
  apiKey: string;
  /** 默认 https://ark.cn-beijing.volces.com/api/v3 */
  baseUrl?: string;
  /** 图像模型 id，默认 doubao-seedream-5-0-pro-260628（媒体目录同款） */
  model: string;
  /** 出图尺寸口径（媒体目录登记 2K/4K；vendor 直传亦可） */
  size?: string;
  timeoutMs?: number;
  /** 商品（服务）参考图：真实实拍图绝对/相对路径，顺序即优先级 */
  referenceImages?: string[];
  /** 角色锚定参考图（例如实拍人物），缺省不锚定 */
  characterAnchorImages?: string[];
  /** 单次生成随附参考图上限（Seedance/Seedream 一致性口径 4 张） */
  maxReferenceImages?: number;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
  /** 失败重试次数（仅网络/限流/5xx 类，默认 2） */
  retries?: number;
}

export interface ReferenceSearchStageLike {
  productId?: string;
  prefilledFrom?: string;
  referenceImages?: Array<{ url?: string; localPath?: string | null }>;
  [key: string]: unknown;
}

export interface ProcessingStageLike {
  outputBaseImage?: string | null;
  [key: string]: unknown;
}

export interface PortraitRuntime {
  apiRender(task: PortraitTask, baseImage?: string | null): Promise<string>;
  searchReferences(stage: ReferenceSearchStageLike): Promise<string[]>;
  processImage(stage: ProcessingStageLike, images?: string[]): Promise<string>;
  /** 当前索引快照（角色/商品已出图清单，供渲染侧挑选参考图） */
  snapshot(): PortraitIndex;
  /** 索引落盘位置 */
  indexPath(): string;
}

const IMAGE_DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * 目录/文件名的安全化：**保留中文等非 ASCII 字符**。
 *
 * 真机教训（2026-09-21）：早先版本把所有非 ASCII 字符替换成 "-"，于是
 * `住客-three_quarter` 被压成 `three_quarter` → 三个角色的定妆照互相覆盖、还被归到商品桶。
 * 中文名在文件系统与绑定清单里都是合法标识，只清洗路径分隔符/保留字符即可。
 */
export function portraitKey(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.\s-]+|[.\s-]+$/g, "");
  return cleaned || "subject";
}

/** 从 vendor 的 portraitId（`<characterId>-<angleId>`）剥掉角度后缀，还原主体标识 */
function stripAngleSuffix(portraitId: string, angleRaw: string): string {
  if (!portraitId || !angleRaw) return portraitId;
  const escaped = angleRaw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return portraitId.replace(new RegExp(`[-_/\\s]+${escaped}$`), "");
}

/** 从 vendor 的定妆照提示词模板里取角色名：`【定妆照】<name> — <angleName>` */
function characterNameFromPrompt(prompt: unknown): string {
  if (typeof prompt !== "string") return "";
  const match = prompt.match(/【定妆照】\s*([^—\n]+?)\s*—/);
  return match?.[1]?.trim() ?? "";
}

function nonEmptyFile(file: string): boolean {
  try {
    return existsSync(file) && statSync(file).size > 1024;
  } catch {
    return false;
  }
}

function resolveLocal(image: string, workDir: string): string {
  return isAbsolute(image) ? image : resolve(workDir, image);
}

/**
 * 创建定妆照真实出图运行时。
 *
 * 失败策略：出图失败直接抛错（vendor 会把该张记为 failed 并继续下一张，不静默降级成假成功）。
 */
export function createPortraitRuntime(options: PortraitRuntimeOptions): PortraitRuntime {
  const {
    workDir,
    projectId,
    apiKey,
    model,
    baseUrl = "https://ark.cn-beijing.volces.com/api/v3",
    size,
    timeoutMs = 240_000,
    referenceImages = [],
    characterAnchorImages = [],
    maxReferenceImages = 4,
    retries = 2
  } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? (() => undefined);
  const base = baseUrl.replace(/\/$/, "");
  const charactersRoot = join(workDir, "characters", projectId);
  const indexFile = join(charactersRoot, "portrait-index.json");

  const index: PortraitIndex = {
    schemaVersion: "workloom.portrait-index/v1",
    projectId,
    generatedAt: new Date().toISOString(),
    characters: {},
    products: {}
  };

  /** 进程内外的索引都以磁盘为准（服务端重启后仍能复用已出图的幂等结果） */
  try {
    if (existsSync(indexFile)) {
      const loaded = JSON.parse(readFileSync(indexFile, "utf8")) as PortraitIndex;
      if (loaded?.schemaVersion === "workloom.portrait-index/v1") {
        index.characters = loaded.characters ?? {};
        index.products = loaded.products ?? {};
      }
    }
  } catch (err) {
    log(`[portrait] 索引读取失败（按空索引继续）：${err instanceof Error ? err.message : String(err)}`);
  }

  function persistIndex(): void {
    index.generatedAt = new Date().toISOString();
    mkdirSync(charactersRoot, { recursive: true });
    writeFileSync(indexFile, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  }

  function upsert(
    bucket: "characters" | "products",
    kind: "character" | "product",
    key: string,
    id: string,
    name: string,
    dir: string,
    angle: string,
    file: string
  ): void {
    const existing = index[bucket][key];
    if (existing) {
      existing.files[angle] = file;
      index[bucket][key] = existing;
      persistIndex();
      return;
    }
    index[bucket][key] = { kind, id, name, dir, files: { [angle]: file } };
    persistIndex();
  }

  function existingPortrait(key: string, angle: string): string | null {
    for (const bucket of ["characters", "products"] as const) {
      const hit = index[bucket][key]?.files?.[angle];
      if (hit && nonEmptyFile(hit)) return hit;
    }
    return null;
  }

  function anchorsFor(kind: "character" | "product", baseImage?: string | null): string[] {
    const configured = kind === "character" ? characterAnchorImages : referenceImages;
    const locals = configured
      .map((image) => resolveLocal(image, workDir))
      .filter((file) => nonEmptyFile(file));
    if (baseImage) {
      const base = resolveLocal(baseImage, workDir);
      if (nonEmptyFile(base) && !locals.includes(base)) locals.unshift(base);
    }
    return locals.slice(0, maxReferenceImages);
  }

  function buildPrompt(task: PortraitTask, kind: "character" | "product", angleRaw: string): string {
    const parts: string[] = [];
    if (typeof task.prompt === "string" && task.prompt.trim()) parts.push(task.prompt.trim());
    else {
      const name = String(task.characterName || task.characterId || task.productName || task.productId || "主体");
      parts.push(`【定妆照】${name} — ${angleRaw}`);
    }
    parts.push("规范：写实摄影质感，主体完整入画，无文字无水印无边框，无多余肢体");
    if (kind === "product") parts.push("以参考图中的真实场景/空间为准，保持建筑、家具与材质细节不漂移");
    return parts.join("\n");
  }

  async function toDataUrl(file: string): Promise<string> {
    const bytes = readFileSync(file);
    const ext = file.toLowerCase().endsWith(".png") ? "png" : "jpeg";
    return `data:image/${ext};base64,${bytes.toString("base64")}`;
  }

  async function generateImage(prompt: string, anchors: string[]): Promise<string> {
    const payload: Record<string, unknown> = {
      model,
      prompt,
      response_format: "url",
      watermark: false,
      ...(size ? { size } : {})
    };
    if (anchors.length > 0) {
      const dataUrls = await Promise.all(anchors.map((file) => toDataUrl(file)));
      payload.image = dataUrls.length === 1 ? dataUrls[0] : dataUrls;
    }

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const res = await fetchImpl(`${base}/images/generations`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeoutMs)
        });
        const text = await res.text();
        if (!res.ok) {
          const err = new Error(`定妆照出图失败：HTTP ${res.status} ${text.slice(0, 200)}`);
          if (res.status === 429 || res.status >= 500) {
            lastError = err;
            await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
            continue;
          }
          throw err;
        }
        const data = JSON.parse(text) as { data?: Array<{ url?: string; size?: string }> };
        const url = data?.data?.[0]?.url;
        if (!url) throw new Error(`定妆照出图响应缺少 url：${text.slice(0, 200)}`);
        log(`[portrait] 出图成功（${data.data?.[0]?.size ?? "?"}）`);
        return url;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt >= retries) break;
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
    throw lastError ?? new Error("定妆照出图失败：未知错误");
  }

  async function download(url: string): Promise<Buffer> {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`定妆照下载失败：HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength < 1024) throw new Error(`定妆照下载内容过小（${buf.byteLength} 字节）`);
    return buf;
  }

  async function apiRender(task: PortraitTask, baseImage?: string | null): Promise<string> {
    /**
     * vendor 的角色分支只把 `portraitId/angle/angleName/prompt` 传进来（角色 id/name 留在外层任务上），
     * 商品分支则带 `productId/view`。所以：
     *   · 用 `view`（商品视角）与 `angle`（角色角度）区分两条链路；
     *   · 角色标识从 `portraitId` 剥掉角度后缀还原（`char_001-front_full` → `char_001`），
     *     显示名从提示词模板 `【定妆照】<name> — ...` 里取回。
     */
    const angleRaw = String(task.angle || task.view || "view");
    const isProduct = Boolean(task.productId || task.productName || task.view);
    const kind: "character" | "product" = isProduct ? "product" : "character";
    const portraitId = String(task.portraitId ?? "");
    const explicitId = isProduct
      ? task.productId || task.productName
      : task.characterId || task.characterName;
    const id = String(explicitId || stripAngleSuffix(portraitId, angleRaw) || "subject");
    const name = String(
      (isProduct ? task.productName || task.productId : task.characterName || characterNameFromPrompt(task.prompt))
        || explicitId
        || id
    );
    const angle = ANGLE_FILE_ALIASES[angleRaw] ?? angleRaw;
    const key = portraitKey(id);
    const bucket = kind === "character" ? "characters" : "products";

    const cached = existingPortrait(key, angle);
    if (cached) {
      log(`[portrait] 复用已出图：${key}-${angle}（幂等，不重复烧额度）`);
      upsert(bucket, kind, key, id, name, join(charactersRoot, key), angle, cached);
      return cached;
    }

    const dir = join(charactersRoot, key, "portraits");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${key}-${angle}.png`);
    const anchors = anchorsFor(kind, baseImage);
    log(
      `[portrait] 出图：${name} / ${angleRaw} → ${angle}`
      + `${anchors.length ? `（锚定参考图 ${anchors.length} 张）` : "（无参考图）"}`
    );
    const url = await generateImage(buildPrompt(task, kind, angleRaw), anchors);
    const bytes = await download(url);
    writeFileSync(file, bytes);
    upsert(bucket, kind, key, id, name, join(charactersRoot, key), angle, file);
    return file;
  }

  /** 情报档案预填：直接返回真实实拍参考图（prefilled 分支，免外部检索） */
  async function searchReferences(_stage: ReferenceSearchStageLike): Promise<string[]> {
    const images = referenceImages
      .map((image) => resolveLocal(image, workDir))
      .filter((file) => nonEmptyFile(file));
    if (images.length === 0) {
      log("[portrait] 未配置参考图：商品/服务定妆照将无真实锚点（仅按文字规格生成）");
    } else {
      log(`[portrait] 参考图预填 ${images.length} 张（prefilled，免外部检索）`);
    }
    return images.slice(0, maxReferenceImages);
  }

  /**
   * 参考图标准化（本机直通口径）：
   * 不做抠图/白底（服务类分支本身也不要求白底），把首选参考图复制为基准图，
   * 作为后续 5 视角风格化的唯一真实锚点。
   */
  async function processImage(stage: ProcessingStageLike, images?: string[]): Promise<string> {
    const candidates = [...(images ?? []), ...referenceImages.map((image) => resolveLocal(image, workDir))]
      .map((image) => resolveLocal(String(image), workDir))
      .filter((file) => nonEmptyFile(file));
    const source = stage.outputBaseImage && nonEmptyFile(resolveLocal(stage.outputBaseImage, workDir))
      ? resolveLocal(stage.outputBaseImage, workDir)
      : candidates[0];
    if (!source) throw new Error("参考图标准化失败：没有可用的真实参考图（禁止无参考生成）");
    const dir = join(charactersRoot, "_product-base");
    mkdirSync(dir, { recursive: true });
    const ext = source.toLowerCase().endsWith(".png") ? "png" : "jpg";
    const out = join(dir, `base.${ext}`);
    if (!nonEmptyFile(out)) writeFileSync(out, readFileSync(source));
    log(`[portrait] 基准图就位（直通锚点）：${out}`);
    return out;
  }

  return {
    apiRender,
    searchReferences,
    processImage,
    snapshot: () => index,
    indexPath: () => indexFile
  };
}
